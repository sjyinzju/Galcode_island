use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const CODEX_SOURCE: &str = "codex";
const CLAUDE_SOURCE: &str = "claude-code";
const STORE_VERSION: u8 = 2;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionRef {
    pub source: String,
    pub native_session_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionPreview {
    pub source: String,
    pub native_session_id: String,
    pub title: String,
    pub project_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ImportedTranscriptPart {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    Image {
        #[serde(rename = "dataUrl")]
        data_url: String,
        alt: Option<String>,
    },
    ToolCall {
        #[serde(rename = "toolCallId")]
        tool_call_id: Option<String>,
        name: String,
        input: Value,
    },
    ToolResult {
        #[serde(rename = "toolCallId")]
        tool_call_id: Option<String>,
        output: Value,
        #[serde(rename = "isError")]
        is_error: bool,
    },
    Event {
        kind: String,
        data: Value,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTranscriptMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub parts: Vec<ImportedTranscriptPart>,
    pub timestamp: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedConversation {
    pub id: String,
    pub source: String,
    pub native_session_id: String,
    pub title: String,
    pub project_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub imported_at: i64,
    pub messages: Vec<ImportedTranscriptMessage>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedConversationSummary {
    pub id: String,
    pub source: String,
    pub native_session_id: String,
    pub title: String,
    pub project_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub imported_at: i64,
    pub message_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportExternalSessionsResult {
    pub imported: Vec<ImportedConversationSummary>,
    pub skipped: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct ImportedConversationsFile {
    version: u8,
    conversations: Vec<ImportedConversation>,
}

#[derive(Clone)]
struct ParsedMessage {
    role: String,
    content: String,
    parts: Vec<ImportedTranscriptPart>,
    timestamp: i64,
    source_path: String,
    line_number: usize,
}

struct ParsedConversation {
    native_session_id: String,
    title: String,
    project_path: Option<String>,
    created_at: i64,
    updated_at: i64,
    message_count: usize,
    messages: Vec<ImportedTranscriptMessage>,
}

struct CodexPiece {
    native_session_id: String,
    rollout_id: Option<String>,
    project_path: Option<String>,
    created_at: i64,
    updated_at: i64,
    messages: Vec<ParsedMessage>,
}

struct CodexAccumulator {
    project_path: Option<String>,
    created_at: i64,
    updated_at: i64,
    title_hint: Option<(String, i64)>,
    first_user_text: Option<String>,
    message_count: usize,
    messages: Vec<ParsedMessage>,
    seen_messages: HashSet<String>,
}

struct ClaudePiece {
    native_session_id: String,
    project_path: Option<String>,
    created_at: i64,
    updated_at: i64,
    custom_title: Option<(String, i64)>,
    ai_title: Option<(String, i64)>,
    last_prompt: Option<(String, i64)>,
    first_user_text: Option<(String, i64)>,
    messages: Vec<ParsedMessage>,
}

struct ClaudeAccumulator {
    project_path: Option<String>,
    created_at: i64,
    updated_at: i64,
    custom_title: Option<(String, i64)>,
    ai_title: Option<(String, i64)>,
    last_prompt: Option<(String, i64)>,
    first_user_text: Option<(String, i64)>,
    message_count: usize,
    messages: Vec<ParsedMessage>,
    seen_messages: HashSet<String>,
}

pub fn scan_external_sessions() -> Result<Vec<ExternalSessionPreview>, String> {
    let mut previews = Vec::new();
    for (source, conversation) in scan_source(CODEX_SOURCE, false)? {
        previews.push(to_preview(&source, &conversation));
    }
    for (source, conversation) in scan_source(CLAUDE_SOURCE, false)? {
        previews.push(to_preview(&source, &conversation));
    }
    previews.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.title.cmp(&b.title))
    });
    Ok(previews)
}

pub fn import_external_sessions(
    app: &AppHandle,
    selections: Vec<ExternalSessionRef>,
) -> Result<ImportExternalSessionsResult, String> {
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for selection in selections {
        let source = selection.source.trim().to_string();
        let native_session_id = selection.native_session_id.trim().to_string();
        if source.is_empty() || native_session_id.is_empty() {
            continue;
        }
        let key = format!("{source}\n{native_session_id}");
        if seen.insert(key) {
            unique.push(ExternalSessionRef {
                source,
                native_session_id,
            });
        }
    }

    let mut requested_by_source: HashMap<String, HashSet<String>> = HashMap::new();
    for selection in &unique {
        requested_by_source
            .entry(selection.source.clone())
            .or_default()
            .insert(selection.native_session_id.clone());
    }

    let mut available: HashMap<String, HashMap<String, ParsedConversation>> = HashMap::new();
    for source in [CODEX_SOURCE, CLAUDE_SOURCE] {
        if !requested_by_source.contains_key(source) {
            continue;
        }
        let mut by_id = HashMap::new();
        for (_, conversation) in scan_source(source, true)? {
            by_id.insert(conversation.native_session_id.clone(), conversation);
        }
        available.insert(source.to_string(), by_id);
    }

    let now = now_millis();
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    for selection in unique {
        let Some(by_id) = available.get_mut(&selection.source) else {
            skipped.push(format!(
                "{}: unsupported source",
                selection.native_session_id
            ));
            continue;
        };
        let Some(conversation) = by_id.remove(&selection.native_session_id) else {
            skipped.push(format!(
                "{}: session was not found",
                selection.native_session_id
            ));
            continue;
        };
        imported.push(to_imported_conversation(
            &selection.source,
            conversation,
            now,
        ));
    }

    if imported.is_empty() {
        return Ok(ImportExternalSessionsResult {
            imported: Vec::new(),
            skipped,
            warnings: Vec::new(),
        });
    }

    let mut stored = load_imported_file(app)?;
    for conversation in &imported {
        if let Some(index) = stored
            .conversations
            .iter()
            .position(|item| item.id == conversation.id)
        {
            stored.conversations[index] = conversation.clone();
        } else {
            stored.conversations.push(conversation.clone());
        }
    }
    stored.version = STORE_VERSION;
    save_imported_file(app, &stored)?;

    let mut summaries = imported.iter().map(to_summary).collect::<Vec<_>>();
    sort_summaries(&mut summaries);
    Ok(ImportExternalSessionsResult {
        imported: summaries,
        skipped,
        warnings: Vec::new(),
    })
}

pub fn list_imported_conversations(
    app: &AppHandle,
) -> Result<Vec<ImportedConversationSummary>, String> {
    let stored = load_imported_file(app)?;
    let mut summaries = stored
        .conversations
        .iter()
        .map(to_summary)
        .collect::<Vec<_>>();
    sort_summaries(&mut summaries);
    Ok(summaries)
}

pub fn load_imported_conversation(
    app: &AppHandle,
    id: &str,
) -> Result<ImportedConversation, String> {
    let stored = load_imported_file(app)?;
    stored
        .conversations
        .into_iter()
        .find(|conversation| conversation.id == id)
        .ok_or_else(|| "Imported conversation was not found".to_string())
}

pub fn remove_imported_conversation(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut stored = load_imported_file(app)?;
    let before = stored.conversations.len();
    stored
        .conversations
        .retain(|conversation| conversation.id != id);
    if stored.conversations.len() != before {
        save_imported_file(app, &stored)?;
    }
    Ok(())
}

fn scan_source(
    source: &str,
    include_messages: bool,
) -> Result<Vec<(String, ParsedConversation)>, String> {
    match source {
        CODEX_SOURCE => Ok(scan_codex(include_messages)
            .into_iter()
            .map(|conversation| (CODEX_SOURCE.to_string(), conversation))
            .collect()),
        CLAUDE_SOURCE => Ok(scan_claude(include_messages)
            .into_iter()
            .map(|conversation| (CLAUDE_SOURCE.to_string(), conversation))
            .collect()),
        _ => Err(format!("Unsupported external history source: {source}")),
    }
}

fn scan_codex(include_messages: bool) -> Vec<ParsedConversation> {
    let Some(home) = user_home_dir() else {
        return Vec::new();
    };
    let codex_root = home.join(".codex");
    if !codex_root.exists() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_jsonl_files(&codex_root.join("sessions"), &mut files);
    collect_jsonl_files(&codex_root.join("archived_sessions"), &mut files);
    files.sort();

    let mut pieces = Vec::new();
    for path in files {
        let fallback_id = fallback_session_id(&path);
        if let Some(piece) = parse_codex_file(&path, fallback_id) {
            pieces.push(piece);
        }
    }

    let index = read_codex_index(&codex_root.join("session_index.jsonl"));
    assemble_codex_conversations(pieces, &index, include_messages)
}

fn assemble_codex_conversations(
    pieces: Vec<CodexPiece>,
    index: &HashMap<String, (String, i64)>,
    include_messages: bool,
) -> Vec<ParsedConversation> {
    let mut grouped: HashMap<String, CodexAccumulator> = HashMap::new();
    for piece in pieces {
        let index_entry = index
            .get(&piece.native_session_id)
            .or_else(|| piece.rollout_id.as_ref().and_then(|id| index.get(id)))
            .cloned();
        let entry = grouped
            .entry(piece.native_session_id.clone())
            .or_insert_with(|| CodexAccumulator {
                project_path: piece.project_path.clone(),
                created_at: piece.created_at,
                updated_at: piece.updated_at,
                title_hint: index_entry.clone(),
                first_user_text: None,
                message_count: 0,
                messages: Vec::new(),
                seen_messages: HashSet::new(),
            });
        if entry.project_path.is_none() {
            entry.project_path = piece.project_path.clone();
        }
        entry.created_at = min_non_zero(entry.created_at, piece.created_at);
        entry.updated_at = entry.updated_at.max(piece.updated_at);
        if let Some((title, hint_updated_at)) = index_entry {
            let should_replace = entry
                .title_hint
                .as_ref()
                .map(|(_, current_updated_at)| hint_updated_at >= *current_updated_at)
                .unwrap_or(true);
            if should_replace {
                entry.title_hint = Some((title, hint_updated_at));
            }
        }
        for message in piece.messages {
            let dedupe_key = message_dedupe_key(&message);
            if !entry.seen_messages.insert(dedupe_key) {
                continue;
            }
            if entry.first_user_text.is_none() && message.role == "user" {
                if let Some(text) =
                    first_text_part(&message.parts).filter(|text| !is_context_only_prompt(text))
                {
                    entry.first_user_text = Some(text.to_string());
                }
            }
            entry.message_count += 1;
            if include_messages {
                entry.messages.push(message);
            }
        }
    }

    let mut conversations = grouped
        .into_iter()
        .map(|(native_session_id, mut entry)| {
            if let Some((_, updated_at)) = entry.title_hint.as_ref() {
                entry.updated_at = entry.updated_at.max(*updated_at);
            }
            let title = entry
                .title_hint
                .as_ref()
                .map(|(title, _)| title.clone())
                .filter(|title| !title.trim().is_empty())
                .or_else(|| entry.first_user_text.map(|text| compact_title(&text)))
                .unwrap_or_else(|| "Untitled conversation".to_string());
            ParsedConversation {
                native_session_id: native_session_id.clone(),
                title,
                project_path: entry.project_path,
                created_at: entry.created_at,
                updated_at: entry.updated_at,
                message_count: entry.message_count,
                messages: if include_messages {
                    finalize_messages(native_session_id.as_str(), entry.messages)
                } else {
                    Vec::new()
                },
            }
        })
        .collect::<Vec<_>>();
    conversations.retain(|conversation| conversation.message_count > 0);
    conversations.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    conversations
}

fn scan_claude(include_messages: bool) -> Vec<ParsedConversation> {
    let Some(home) = user_home_dir() else {
        return Vec::new();
    };
    let projects_root = home.join(".claude").join("projects");
    let mut files = Vec::new();
    collect_jsonl_files(&projects_root, &mut files);
    files.sort();

    let mut pieces = Vec::new();
    for path in files {
        pieces.extend(parse_claude_file(&path));
    }
    assemble_claude_conversations(pieces, include_messages)
}

fn assemble_claude_conversations(
    pieces: Vec<ClaudePiece>,
    include_messages: bool,
) -> Vec<ParsedConversation> {
    let mut grouped: HashMap<String, ClaudeAccumulator> = HashMap::new();
    for piece in pieces {
        let entry = grouped
            .entry(piece.native_session_id.clone())
            .or_insert_with(|| ClaudeAccumulator {
                project_path: piece.project_path.clone(),
                created_at: piece.created_at,
                updated_at: piece.updated_at,
                custom_title: None,
                ai_title: None,
                last_prompt: None,
                first_user_text: None,
                message_count: 0,
                messages: Vec::new(),
                seen_messages: HashSet::new(),
            });
        if entry.project_path.is_none() {
            entry.project_path = piece.project_path.clone();
        }
        entry.created_at = min_non_zero(entry.created_at, piece.created_at);
        entry.updated_at = entry.updated_at.max(piece.updated_at);
        replace_with_latest(&mut entry.custom_title, piece.custom_title);
        replace_with_latest(&mut entry.ai_title, piece.ai_title);
        replace_with_latest(&mut entry.last_prompt, piece.last_prompt);
        replace_with_earliest(&mut entry.first_user_text, piece.first_user_text);
        for message in piece.messages {
            let dedupe_key = message_dedupe_key(&message);
            if !entry.seen_messages.insert(dedupe_key) {
                continue;
            }
            entry.message_count += 1;
            if include_messages {
                entry.messages.push(message);
            }
        }
    }

    let mut conversations = grouped
        .into_iter()
        .map(|(native_session_id, entry)| {
            let title = entry
                .custom_title
                .map(|(title, _)| title)
                .or_else(|| entry.ai_title.map(|(title, _)| title))
                .or_else(|| entry.first_user_text.map(|(text, _)| compact_title(&text)))
                .or_else(|| entry.last_prompt.map(|(text, _)| compact_title(&text)))
                .unwrap_or_else(|| "Untitled conversation".to_string());
            ParsedConversation {
                native_session_id: native_session_id.clone(),
                title,
                project_path: entry.project_path,
                created_at: entry.created_at,
                updated_at: entry.updated_at,
                message_count: entry.message_count,
                messages: if include_messages {
                    finalize_messages(native_session_id.as_str(), entry.messages)
                } else {
                    Vec::new()
                },
            }
        })
        .filter(|conversation| conversation.message_count > 0)
        .collect::<Vec<_>>();
    conversations.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    conversations
}

fn parse_codex_file(path: &Path, fallback_id: String) -> Option<CodexPiece> {
    let Ok(file) = File::open(path) else {
        return None;
    };
    let fallback_time = file_modified_millis(path).unwrap_or(0);
    let mut native_session_id = fallback_id;
    let mut rollout_id = None;
    let mut project_path = None;
    let mut created_at = None;
    let mut updated_at = None;
    let mut messages = Vec::new();
    let source_path = path.to_string_lossy().into_owned();
    let mut found_session_meta = false;

    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else { continue };
        let Ok(record) = serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}')) else {
            continue;
        };

        if record.get("type").and_then(Value::as_str) == Some("session_meta") {
            if found_session_meta {
                continue;
            }
            let payload = record.get("payload").unwrap_or(&Value::Null);
            let is_subagent = payload
                .get("thread_source")
                .and_then(Value::as_str)
                .is_some_and(|source| source != "user")
                || payload
                    .get("source")
                    .and_then(Value::as_object)
                    .is_some_and(|source| source.contains_key("subagent"));
            if is_subagent {
                continue;
            }
            found_session_meta = true;
            rollout_id = payload
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(ToString::to_string);
            if let Some(id) = payload
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
            {
                native_session_id = id.to_string();
            } else if let Some(id) = rollout_id.as_deref() {
                native_session_id = id.to_string();
            }
            if project_path.is_none() {
                project_path = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
            }
            observe_time(
                &mut created_at,
                &mut updated_at,
                timestamp_from_value(record.get("timestamp")),
            );
            observe_time(
                &mut created_at,
                &mut updated_at,
                timestamp_from_value(payload.get("timestamp")),
            );
            continue;
        }

        if !found_session_meta {
            continue;
        }

        let record_time = timestamp_from_value(record.get("timestamp"));
        observe_time(&mut created_at, &mut updated_at, record_time);
        if record.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let payload = record.get("payload").unwrap_or(&Value::Null);
        let Some((role, content, parts)) = extract_codex_message(payload) else {
            continue;
        };
        if role == "user" && contains_only_text(&parts) && is_context_only_prompt(&content) {
            continue;
        }
        let timestamp = record_time.unwrap_or(0);
        messages.push(ParsedMessage {
            role,
            content,
            parts,
            timestamp,
            source_path: source_path.clone(),
            line_number: line_index,
        });
    }

    (!messages.is_empty()).then_some(CodexPiece {
        native_session_id,
        rollout_id,
        project_path,
        created_at: created_at.unwrap_or(fallback_time),
        updated_at: updated_at.unwrap_or(fallback_time),
        messages,
    })
}

fn parse_claude_file(path: &Path) -> Vec<ClaudePiece> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let file_session_id = fallback_session_id(path);
    let mut records = Vec::new();
    for (line_number, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else { continue };
        let Ok(record) = serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}')) else {
            continue;
        };
        records.push((line_number, record));
    }

    let source_path = path.to_string_lossy().into_owned();
    let mut pieces: HashMap<String, ClaudePiece> = HashMap::new();

    for (line_index, record) in records {
        if record
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || record
                .get("isMeta")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            continue;
        }
        let native_session_id = record
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|session_id| !session_id.trim().is_empty())
            .unwrap_or(file_session_id.as_str())
            .to_string();

        let record_time = timestamp_from_value(record.get("timestamp"));
        let fallback_time = file_modified_millis(path).unwrap_or(0);
        let initial_time = record_time.unwrap_or(fallback_time);
        let entry = pieces
            .entry(native_session_id.clone())
            .or_insert_with(|| ClaudePiece {
                native_session_id,
                project_path: None,
                created_at: initial_time,
                updated_at: initial_time,
                custom_title: None,
                ai_title: None,
                last_prompt: None,
                first_user_text: None,
                messages: Vec::new(),
            });
        entry.created_at = min_non_zero(entry.created_at, initial_time);
        entry.updated_at = entry.updated_at.max(initial_time);
        if entry.project_path.is_none() {
            entry.project_path = record
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToString::to_string);
        }
        let title_time = record_time.unwrap_or(fallback_time);

        match record.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                replace_with_latest(
                    &mut entry.custom_title,
                    record
                        .get("customTitle")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .filter(|title| !title.trim().is_empty())
                        .map(|title| (title, title_time)),
                );
            }
            Some("ai-title") => {
                replace_with_latest(
                    &mut entry.ai_title,
                    record
                        .get("aiTitle")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .filter(|title| !title.trim().is_empty())
                        .map(|title| (title, title_time)),
                );
            }
            Some("last-prompt") => {
                replace_with_latest(
                    &mut entry.last_prompt,
                    record
                        .get("lastPrompt")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .filter(|prompt| !prompt.trim().is_empty())
                        .map(|prompt| (prompt, title_time)),
                );
            }
            Some("user") | Some("assistant") => {
                let role = record
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let message = record.get("message").unwrap_or(&Value::Null);
                let Some((content, parts)) = extract_claude_message(message, role) else {
                    continue;
                };
                if role == "user" {
                    if let Some(text) =
                        first_text_part(&parts).filter(|text| !is_context_only_prompt(text))
                    {
                        replace_with_earliest(
                            &mut entry.first_user_text,
                            Some((text.to_string(), title_time)),
                        );
                    }
                }
                entry.messages.push(ParsedMessage {
                    role: role.to_string(),
                    content,
                    parts,
                    timestamp: record_time.unwrap_or(0),
                    source_path: source_path.clone(),
                    line_number: line_index,
                });
            }
            Some("system") => {
                let kind = record
                    .get("subtype")
                    .and_then(Value::as_str)
                    .unwrap_or("system")
                    .to_string();
                let parts = vec![ImportedTranscriptPart::Event {
                    kind,
                    data: record.clone(),
                }];
                let Some(content) = parts_to_legacy_content(&parts) else {
                    continue;
                };
                entry.messages.push(ParsedMessage {
                    role: "system".to_string(),
                    content,
                    parts,
                    timestamp: record_time.unwrap_or(0),
                    source_path: source_path.clone(),
                    line_number: line_index,
                });
            }
            _ => {}
        }
    }
    pieces.into_values().collect()
}

fn extract_codex_message(payload: &Value) -> Option<(String, String, Vec<ImportedTranscriptPart>)> {
    let payload_type = payload.get("type").and_then(Value::as_str)?;
    let (role, parts) = match payload_type {
        "message" => {
            let role = payload.get("role").and_then(Value::as_str)?;
            let parts = extract_content_parts(payload.get("content")?);
            (role.to_string(), parts)
        }
        "reasoning" => {
            let mut parts = payload
                .get("summary")
                .map(extract_thinking_parts)
                .unwrap_or_default();
            if parts.is_empty() {
                parts.push(ImportedTranscriptPart::Event {
                    kind: "reasoning".to_string(),
                    data: payload.clone(),
                });
            }
            ("assistant".to_string(), parts)
        }
        "function_call" | "custom_tool_call" | "tool_search_call" | "web_search_call" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(payload_type)
                .to_string();
            let input = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .or_else(|| payload.get("action"))
                .map(parse_json_string)
                .unwrap_or(Value::Null);
            let part = ImportedTranscriptPart::ToolCall {
                tool_call_id: codex_call_id(payload),
                name,
                input,
            };
            ("assistant".to_string(), vec![part])
        }
        "function_call_output" | "custom_tool_call_output" | "tool_search_output" => {
            let output = payload
                .get("output")
                .cloned()
                .unwrap_or_else(|| payload.clone());
            let part = ImportedTranscriptPart::ToolResult {
                tool_call_id: codex_call_id(payload),
                output: parse_json_string(&output),
                is_error: payload.get("status").and_then(Value::as_str) == Some("failed"),
            };
            ("tool".to_string(), vec![part])
        }
        "image_generation_call" => {
            let data = payload.get("result").and_then(Value::as_str)?.trim();
            if data.is_empty() {
                return None;
            }
            let alt = payload
                .get("revised_prompt")
                .and_then(Value::as_str)
                .and_then(normalized_message_text);
            let call = ImportedTranscriptPart::ToolCall {
                tool_call_id: codex_call_id(payload),
                name: "image_generation".to_string(),
                input: payload
                    .get("revised_prompt")
                    .cloned()
                    .unwrap_or(Value::Null),
            };
            let image = ImportedTranscriptPart::Image {
                data_url: format!("data:image/png;base64,{data}"),
                alt,
            };
            ("assistant".to_string(), vec![call, image])
        }
        "agent_message" => {
            let text = payload.get("message").and_then(Value::as_str)?;
            let text = normalized_message_text(text)?;
            (
                "assistant".to_string(),
                vec![ImportedTranscriptPart::Text { text }],
            )
        }
        _ => (
            "assistant".to_string(),
            vec![ImportedTranscriptPart::Event {
                kind: payload_type.to_string(),
                data: payload.clone(),
            }],
        ),
    };
    let content = parts_to_legacy_content(&parts)?;
    Some((role, content, parts))
}

fn extract_claude_message(
    message: &Value,
    role: &str,
) -> Option<(String, Vec<ImportedTranscriptPart>)> {
    if !matches!(role, "user" | "assistant") {
        return None;
    }
    let parts = extract_content_parts(message.get("content")?);
    let content = parts_to_legacy_content(&parts)?;
    Some((content, parts))
}

fn extract_content_parts(content: &Value) -> Vec<ImportedTranscriptPart> {
    if let Some(text) = content.as_str().and_then(normalized_message_text) {
        return vec![ImportedTranscriptPart::Text { text }];
    }
    let items: Vec<&Value> = match content {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![content],
        _ => Vec::new(),
    };
    let mut parts = Vec::new();
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("text" | "input_text" | "output_text") => {
                if let Some(text) = item
                    .get("text")
                    .and_then(Value::as_str)
                    .and_then(normalized_message_text)
                {
                    parts.push(ImportedTranscriptPart::Text { text });
                }
            }
            Some("thinking" | "reasoning" | "summary_text") => {
                if let Some(text) = item
                    .get("thinking")
                    .or_else(|| item.get("text"))
                    .and_then(Value::as_str)
                    .and_then(normalized_message_text)
                {
                    parts.push(ImportedTranscriptPart::Thinking { text });
                } else {
                    parts.push(ImportedTranscriptPart::Event {
                        kind: item
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("thinking")
                            .to_string(),
                        data: item.clone(),
                    });
                }
            }
            Some("image" | "input_image") => {
                let data_url = item
                    .get("image_url")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .or_else(|| image_source_data_url(item.get("source")?));
                if let Some(data_url) = data_url.filter(|value| !value.trim().is_empty()) {
                    parts.push(ImportedTranscriptPart::Image {
                        data_url,
                        alt: item
                            .get("alt")
                            .and_then(Value::as_str)
                            .and_then(normalized_message_text),
                    });
                }
            }
            Some("tool_use") => {
                parts.push(ImportedTranscriptPart::ToolCall {
                    tool_call_id: item
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string(),
                    input: item.get("input").cloned().unwrap_or(Value::Null),
                });
            }
            Some("tool_result") => {
                parts.push(ImportedTranscriptPart::ToolResult {
                    tool_call_id: item
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    output: item.get("content").cloned().unwrap_or(Value::Null),
                    is_error: item
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                });
                if let Some(result_content) = item.get("content") {
                    parts.extend(
                        extract_content_parts(result_content)
                            .into_iter()
                            .filter(|part| matches!(part, ImportedTranscriptPart::Image { .. })),
                    );
                }
            }
            Some(kind) => parts.push(ImportedTranscriptPart::Event {
                kind: kind.to_string(),
                data: item.clone(),
            }),
            None => {}
        }
    }
    parts
}

fn extract_thinking_parts(content: &Value) -> Vec<ImportedTranscriptPart> {
    extract_content_parts(content)
        .into_iter()
        .filter_map(|part| match part {
            ImportedTranscriptPart::Text { text } => {
                Some(ImportedTranscriptPart::Thinking { text })
            }
            ImportedTranscriptPart::Thinking { .. } => Some(part),
            _ => None,
        })
        .collect()
}

fn image_source_data_url(source: &Value) -> Option<String> {
    let source_type = source.get("type").and_then(Value::as_str)?;
    match source_type {
        "base64" => {
            let media_type = source
                .get("media_type")
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            let data = source.get("data").and_then(Value::as_str)?;
            Some(format!("data:{media_type};base64,{data}"))
        }
        "url" => source
            .get("url")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        _ => None,
    }
}

fn codex_call_id(payload: &Value) -> Option<String> {
    payload
        .get("call_id")
        .or_else(|| payload.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn parse_json_string(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_else(|| value.clone())
}

fn parts_to_legacy_content(parts: &[ImportedTranscriptPart]) -> Option<String> {
    let mut values = Vec::new();
    for part in parts {
        match part {
            ImportedTranscriptPart::Text { text } | ImportedTranscriptPart::Thinking { text } => {
                values.push(text.clone())
            }
            ImportedTranscriptPart::Image { .. } => values.push("[Image]".to_string()),
            ImportedTranscriptPart::ToolCall { name, .. } => {
                values.push(format!("[Tool call: {name}]"));
            }
            ImportedTranscriptPart::ToolResult { .. } => {
                values.push("[Tool result]".to_string());
            }
            ImportedTranscriptPart::Event { kind, .. } => values.push(format!("[{kind}]")),
        }
    }
    normalized_message_text(&values.join("\n\n"))
}

fn contains_only_text(parts: &[ImportedTranscriptPart]) -> bool {
    parts
        .iter()
        .all(|part| matches!(part, ImportedTranscriptPart::Text { .. }))
}

fn first_text_part(parts: &[ImportedTranscriptPart]) -> Option<&str> {
    parts.iter().find_map(|part| match part {
        ImportedTranscriptPart::Text { text } => Some(text.as_str()),
        _ => None,
    })
}

fn message_dedupe_key(message: &ParsedMessage) -> String {
    let mut hasher = DefaultHasher::new();
    message.role.hash(&mut hasher);
    message.timestamp.hash(&mut hasher);
    message.content.hash(&mut hasher);
    serde_json::to_vec(&message.parts)
        .unwrap_or_default()
        .hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn normalized_message_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn finalize_messages(
    native_session_id: &str,
    mut messages: Vec<ParsedMessage>,
) -> Vec<ImportedTranscriptMessage> {
    messages.sort_by(|a, b| {
        a.timestamp
            .cmp(&b.timestamp)
            .then_with(|| a.source_path.cmp(&b.source_path))
            .then_with(|| a.line_number.cmp(&b.line_number))
    });
    messages
        .into_iter()
        .enumerate()
        .map(|(index, message)| ImportedTranscriptMessage {
            id: format!("{native_session_id}:{index}"),
            role: message.role,
            content: message.content,
            parts: message.parts,
            timestamp: message.timestamp,
        })
        .collect()
}

fn read_codex_index(path: &Path) -> HashMap<String, (String, i64)> {
    let Ok(file) = File::open(path) else {
        return HashMap::new();
    };
    let mut index = HashMap::new();
    for line in BufReader::new(file).lines().flatten() {
        let Ok(record) = serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}')) else {
            continue;
        };
        let Some(id) = record.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(title) = record.get("thread_name").and_then(Value::as_str) else {
            continue;
        };
        let title = title.trim();
        if title.is_empty() {
            continue;
        }
        let updated_at = timestamp_from_value(record.get("updated_at")).unwrap_or(0);
        index.insert(id.to_string(), (title.to_string(), updated_at));
    }
    index
}

fn to_preview(source: &str, conversation: &ParsedConversation) -> ExternalSessionPreview {
    ExternalSessionPreview {
        source: source.to_string(),
        native_session_id: conversation.native_session_id.clone(),
        title: conversation.title.clone(),
        project_path: conversation.project_path.clone(),
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        message_count: conversation.message_count,
    }
}

fn to_imported_conversation(
    source: &str,
    conversation: ParsedConversation,
    imported_at: i64,
) -> ImportedConversation {
    ImportedConversation {
        id: format!("external:{source}:{}", conversation.native_session_id),
        source: source.to_string(),
        native_session_id: conversation.native_session_id,
        title: conversation.title,
        project_path: conversation.project_path,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        imported_at,
        messages: conversation.messages,
    }
}

fn to_summary(conversation: &ImportedConversation) -> ImportedConversationSummary {
    ImportedConversationSummary {
        id: conversation.id.clone(),
        source: conversation.source.clone(),
        native_session_id: conversation.native_session_id.clone(),
        title: conversation.title.clone(),
        project_path: conversation.project_path.clone(),
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        imported_at: conversation.imported_at,
        message_count: conversation.messages.len(),
    }
}

fn sort_summaries(items: &mut [ImportedConversationSummary]) {
    items.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.title.cmp(&b.title))
    });
}

fn imported_storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create app data directory: {error}"))?;
    Ok(dir.join("imported-conversations.json"))
}

fn load_imported_file(app: &AppHandle) -> Result<ImportedConversationsFile, String> {
    let path = imported_storage_path(app)?;
    if !path.exists() {
        return Ok(ImportedConversationsFile::default());
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Could not read imported conversations: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Imported conversations file is invalid: {error}"))
}

fn save_imported_file(app: &AppHandle, contents: &ImportedConversationsFile) -> Result<(), String> {
    let path = imported_storage_path(app)?;
    let bytes = serde_json::to_vec_pretty(contents)
        .map_err(|error| format!("Could not serialize imported conversations: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not save imported conversations: {error}"))?;
    replace_file(&temporary, &path)?;
    Ok(())
}

fn replace_file(temporary: &Path, path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    if path.exists() {
        let backup = path.with_extension("json.bak");
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| {
                format!("Could not clear imported conversations backup: {error}")
            })?;
        }
        fs::rename(path, &backup)
            .map_err(|error| format!("Could not back up imported conversations: {error}"))?;
        return match fs::rename(temporary, path) {
            Ok(()) => {
                let _ = fs::remove_file(backup);
                Ok(())
            }
            Err(error) => {
                let _ = fs::rename(&backup, path);
                Err(format!(
                    "Could not finalize imported conversations: {error}"
                ))
            }
        };
    }
    fs::rename(temporary, path)
        .map_err(|error| format!("Could not finalize imported conversations: {error}"))
}

fn collect_jsonl_files(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_jsonl_files(&path, output);
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
            output.push(path);
        }
    }
}

fn user_home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = std::env::var_os("USERPROFILE") {
            return Some(PathBuf::from(path));
        }
        let drive = std::env::var_os("HOMEDRIVE")?;
        let path = std::env::var_os("HOMEPATH")?;
        return Some(PathBuf::from(drive).join(path));
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn fallback_session_id(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| "unknown-session".to_string())
}

fn timestamp_from_value(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(value) = value.as_i64() {
        return Some(value);
    }
    let value = value.as_str()?;
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn observe_time(
    created_at: &mut Option<i64>,
    updated_at: &mut Option<i64>,
    timestamp: Option<i64>,
) {
    let Some(timestamp) = timestamp else {
        return;
    };
    *created_at = Some(created_at.map_or(timestamp, |current| current.min(timestamp)));
    *updated_at = Some(updated_at.map_or(timestamp, |current| current.max(timestamp)));
}

fn min_non_zero(first: i64, second: i64) -> i64 {
    match (first, second) {
        (0, value) => value,
        (value, 0) => value,
        (first, second) => first.min(second),
    }
}

fn replace_with_latest<T>(target: &mut Option<(T, i64)>, candidate: Option<(T, i64)>) {
    let Some(candidate) = candidate else {
        return;
    };
    if target
        .as_ref()
        .map(|(_, timestamp)| candidate.1 >= *timestamp)
        .unwrap_or(true)
    {
        *target = Some(candidate);
    }
}

fn replace_with_earliest<T>(target: &mut Option<(T, i64)>, candidate: Option<(T, i64)>) {
    let Some(candidate) = candidate else {
        return;
    };
    if target
        .as_ref()
        .map(|(_, timestamp)| candidate.1 < *timestamp)
        .unwrap_or(true)
    {
        *target = Some(candidate);
    }
}

fn file_modified_millis(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let elapsed = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(elapsed.as_millis()).ok()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

fn compact_title(text: &str) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title = compact.chars().take(96).collect::<String>();
    if compact.chars().count() > title.chars().count() {
        title.push_str("...");
    }
    if title.is_empty() {
        "Untitled conversation".to_string()
    } else {
        title
    }
}

fn is_context_only_prompt(text: &str) -> bool {
    let normalized = text.trim_start();
    normalized.starts_with("# AGENTS.md")
        || normalized.starts_with("# CLAUDE.md")
        || normalized.starts_with("<recommended_plugins>")
        || normalized.starts_with("<codex_internal_context>")
        || normalized.starts_with("<turn_aborted>")
        || normalized.starts_with("<subagent_notification>")
        || normalized.starts_with("<environment_context>")
        || normalized.starts_with("<permissions instructions>")
}

#[cfg(test)]
#[path = "external_history_rich_migration_tests.rs"]
mod rich_migration_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_FILE_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn write_test_jsonl(records: Vec<Value>) -> PathBuf {
        let counter = TEST_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "galcode-external-history-{}-{}-{}.jsonl",
            std::process::id(),
            now_millis(),
            counter
        ));
        let contents = records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, contents).expect("test JSONL should be written");
        path
    }

    #[test]
    fn extracts_codex_text_and_images() {
        let user = json!({
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "  explain this file  "},
                {"type": "input_image", "image_url": "data:image/png;base64,abc"}
            ]
        });
        let assistant = json!({
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "output_text", "text": "Here is the answer."}
            ]
        });
        let reasoning = json!({
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "considering options"}]
        });
        let encrypted_reasoning = json!({
            "type": "reasoning",
            "summary": [],
            "encrypted_content": "opaque"
        });

        let (role, content, parts) = extract_codex_message(&user).expect("user message");
        assert_eq!(role, "user");
        assert_eq!(content, "explain this file\n\n[Image]");
        assert_eq!(parts.len(), 2);
        assert!(matches!(parts[1], ImportedTranscriptPart::Image { .. }));

        let (role, content, parts) = extract_codex_message(&assistant).expect("assistant message");
        assert_eq!(role, "assistant");
        assert_eq!(content, "Here is the answer.");
        assert_eq!(parts.len(), 1);

        let (_, content, parts) = extract_codex_message(&reasoning).expect("reasoning message");
        assert_eq!(content, "considering options");
        assert!(matches!(parts[0], ImportedTranscriptPart::Thinking { .. }));

        let (_, content, parts) =
            extract_codex_message(&encrypted_reasoning).expect("encrypted reasoning");
        assert_eq!(content, "[reasoning]");
        assert!(matches!(parts[0], ImportedTranscriptPart::Event { .. }));
    }

    #[test]
    fn extracts_claude_text_thinking_and_tools() {
        let user = json!({"content": "Write a test"});
        let assistant = json!({
            "content": [
                {"type": "thinking", "thinking": "considering edge cases"},
                {"type": "thinking", "thinking": "", "signature": "opaque"},
                {"type": "text", "text": "Test added."},
                {"type": "tool_use", "id": "call-1", "name": "Write", "input": {"file_path": "a.rs"}}
            ]
        });

        assert_eq!(
            extract_claude_message(&user, "user").map(|message| message.0),
            Some("Write a test".to_string())
        );
        let (content, parts) =
            extract_claude_message(&assistant, "assistant").expect("assistant message");
        assert_eq!(
            content,
            "considering edge cases\n\n[thinking]\n\nTest added.\n\n[Tool call: Write]"
        );
        assert_eq!(parts.len(), 4);
        assert!(matches!(parts[0], ImportedTranscriptPart::Thinking { .. }));
        assert!(matches!(parts[1], ImportedTranscriptPart::Event { .. }));
        assert!(matches!(parts[3], ImportedTranscriptPart::ToolCall { .. }));
    }

    #[test]
    fn extracts_claude_images_and_tool_results() {
        let message = json!({
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "call-1",
                    "content": "written",
                    "is_error": false
                },
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "abc"
                    }
                }
            ]
        });

        let (_, parts) = extract_claude_message(&message, "user").expect("user result");
        assert!(matches!(
            &parts[0],
            ImportedTranscriptPart::ToolResult { tool_call_id, .. }
                if tool_call_id.as_deref() == Some("call-1")
        ));
        assert!(matches!(
            &parts[1],
            ImportedTranscriptPart::Image { data_url, .. }
                if data_url == "data:image/png;base64,abc"
        ));
    }

    #[test]
    fn reads_version_one_messages_without_structured_parts() {
        let message: ImportedTranscriptMessage = serde_json::from_value(json!({
            "id": "old:0",
            "role": "assistant",
            "content": "old message",
            "timestamp": 1
        }))
        .expect("version one message should remain readable");

        assert_eq!(message.content, "old message");
        assert!(message.parts.is_empty());
    }

    #[test]
    fn orders_imported_messages_by_timestamp_then_source_position() {
        let messages = vec![
            ParsedMessage {
                role: "assistant".to_string(),
                content: "second".to_string(),
                parts: vec![ImportedTranscriptPart::Text {
                    text: "second".to_string(),
                }],
                timestamp: 20,
                source_path: "b.jsonl".to_string(),
                line_number: 1,
            },
            ParsedMessage {
                role: "user".to_string(),
                content: "first".to_string(),
                parts: vec![ImportedTranscriptPart::Text {
                    text: "first".to_string(),
                }],
                timestamp: 10,
                source_path: "a.jsonl".to_string(),
                line_number: 2,
            },
        ];

        let result = finalize_messages("session", messages);
        assert_eq!(result[0].content, "first");
        assert_eq!(result[1].content, "second");
    }

    #[test]
    fn separates_codex_messages_when_session_metadata_changes() {
        let path = write_test_jsonl(vec![
            json!({
                "timestamp": "2026-07-13T00:00:00Z",
                "type": "session_meta",
                "payload": { "session_id": "first", "id": "first-rollout", "cwd": "C:/one" }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:01Z",
                "type": "response_item",
                "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "first request" }] }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:02Z",
                "type": "session_meta",
                "payload": { "session_id": "second", "id": "second-rollout", "cwd": "C:/two" }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:03Z",
                "type": "response_item",
                "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "second answer" }] }
            }),
        ]);

        let piece = parse_codex_file(&path, "fallback".to_string())
            .expect("top-level Codex file should be parsed");
        assert_eq!(piece.native_session_id, "first");
        assert_eq!(piece.messages[0].content, "first request");
        assert_eq!(piece.messages[1].content, "second answer");
        fs::remove_file(path).ok();
    }

    #[test]
    fn skips_codex_subagent_files_and_internal_prompt_injections() {
        let subagent_path = write_test_jsonl(vec![json!({
            "timestamp": "2026-07-13T00:00:00Z",
            "type": "session_meta",
            "payload": { "session_id": "child", "source": { "subagent": { "other": "test" } } }
        })]);
        assert!(parse_codex_file(&subagent_path, "fallback".to_string()).is_none());
        fs::remove_file(subagent_path).ok();

        let top_level_path = write_test_jsonl(vec![
            json!({
                "timestamp": "2026-07-13T00:00:00Z",
                "type": "session_meta",
                "payload": { "session_id": "parent", "thread_source": "user" }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:01Z",
                "type": "response_item",
                "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "<codex_internal_context> ignore this" }] }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:02Z",
                "type": "response_item",
                "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "real request" }] }
            }),
        ]);
        let piece = parse_codex_file(&top_level_path, "fallback".to_string())
            .expect("top-level Codex file should be parsed");
        assert_eq!(piece.messages.len(), 1);
        assert_eq!(piece.messages[0].content, "real request");
        fs::remove_file(top_level_path).ok();
    }

    #[test]
    fn skips_subagent_metadata_without_discarding_later_user_session() {
        let path = write_test_jsonl(vec![
            json!({
                "timestamp": "2026-07-13T00:00:00Z",
                "type": "session_meta",
                "payload": { "session_id": "child", "source": { "subagent": { "other": "test" } } }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:01Z",
                "type": "response_item",
                "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "child output" }] }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:02Z",
                "type": "session_meta",
                "payload": { "session_id": "parent", "thread_source": "user" }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:03Z",
                "type": "response_item",
                "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "real request" }] }
            }),
        ]);

        let piece = parse_codex_file(&path, "fallback".to_string())
            .expect("later user session should be parsed");
        assert_eq!(piece.native_session_id, "parent");
        assert_eq!(piece.messages.len(), 1);
        assert_eq!(piece.messages[0].content, "real request");
        fs::remove_file(path).ok();
    }

    #[test]
    fn extracts_codex_tool_call_and_result() {
        let call = json!({
            "type": "function_call",
            "name": "shell_command",
            "arguments": "{\"command\":\"git status\"}",
            "call_id": "call-1"
        });
        let result = json!({
            "type": "function_call_output",
            "call_id": "call-1",
            "output": "clean"
        });

        let (_, _, call_parts) = extract_codex_message(&call).expect("tool call");
        let (role, _, result_parts) = extract_codex_message(&result).expect("tool result");
        assert!(matches!(
            &call_parts[0],
            ImportedTranscriptPart::ToolCall { tool_call_id, name, .. }
                if tool_call_id.as_deref() == Some("call-1") && name == "shell_command"
        ));
        assert_eq!(role, "tool");
        assert!(matches!(
            &result_parts[0],
            ImportedTranscriptPart::ToolResult { tool_call_id, .. }
                if tool_call_id.as_deref() == Some("call-1")
        ));
    }

    #[test]
    fn replaces_existing_storage_file() {
        let counter = TEST_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "galcode-external-history-replace-{}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("test directory");
        let path = directory.join("imported-conversations.json");
        let temporary = directory.join("imported-conversations.json.tmp");
        fs::write(&path, "old").expect("old file");
        fs::write(&temporary, "new").expect("temporary file");

        replace_file(&temporary, &path).expect("replacement should succeed");
        assert_eq!(fs::read_to_string(&path).expect("new file"), "new");
        assert!(!temporary.exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn preserves_each_claude_session_and_merges_files_by_native_id() {
        let first_path = write_test_jsonl(vec![
            json!({
                "timestamp": "2026-07-13T00:00:00Z",
                "type": "user",
                "sessionId": "first",
                "cwd": "C:/one",
                "message": { "content": "first request" }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:01Z",
                "type": "assistant",
                "sessionId": "second",
                "cwd": "C:/two",
                "message": { "content": [{ "type": "text", "text": "second answer" }] }
            }),
        ]);
        let second_path = write_test_jsonl(vec![json!({
            "timestamp": "2026-07-13T00:00:02Z",
            "type": "assistant",
            "sessionId": "first",
            "cwd": "C:/one",
            "message": { "content": [{ "type": "text", "text": "first answer" }] }
        })]);

        let mut pieces = parse_claude_file(&first_path);
        pieces.extend(parse_claude_file(&second_path));
        let conversations = assemble_claude_conversations(pieces, true);
        let by_id = conversations
            .into_iter()
            .map(|conversation| (conversation.native_session_id.clone(), conversation))
            .collect::<HashMap<_, _>>();

        assert_eq!(by_id["first"].messages.len(), 2);
        assert_eq!(by_id["first"].messages[1].content, "first answer");
        assert_eq!(by_id["second"].messages[0].content, "second answer");
        fs::remove_file(first_path).ok();
        fs::remove_file(second_path).ok();
    }
}
