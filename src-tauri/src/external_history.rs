use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const CODEX_SOURCE: &str = "codex";
const CLAUDE_SOURCE: &str = "claude-code";
const STORE_VERSION: u8 = 1;

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTranscriptMessage {
    pub id: String,
    pub role: String,
    pub content: String,
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
            let dedupe_key = format!(
                "{}\u{0}{}\u{0}{}",
                message.role, message.timestamp, message.content
            );
            if !entry.seen_messages.insert(dedupe_key) {
                continue;
            }
            if entry.first_user_text.is_none()
                && message.role == "user"
                && !is_context_only_prompt(&message.content)
            {
                entry.first_user_text = Some(message.content.clone());
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
            let dedupe_key = format!(
                "{}\u{0}{}\u{0}{}",
                message.role, message.timestamp, message.content
            );
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
            found_session_meta = true;
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
                return None;
            }
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
        let Some((role, content)) = extract_codex_message(payload) else {
            continue;
        };
        if role == "user" && is_context_only_prompt(&content) {
            continue;
        }
        let timestamp = record_time.unwrap_or(0);
        messages.push(ParsedMessage {
            role,
            content,
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
                replace_with_latest(&mut entry.custom_title, record
                    .get("customTitle")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .filter(|title| !title.trim().is_empty())
                    .map(|title| (title, title_time)));
            }
            Some("ai-title") => {
                replace_with_latest(&mut entry.ai_title, record
                    .get("aiTitle")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .filter(|title| !title.trim().is_empty())
                    .map(|title| (title, title_time)));
            }
            Some("last-prompt") => {
                replace_with_latest(&mut entry.last_prompt, record
                    .get("lastPrompt")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .filter(|prompt| !prompt.trim().is_empty())
                    .map(|prompt| (prompt, title_time)));
            }
            Some("user") | Some("assistant") => {
                let role = record
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let message = record.get("message").unwrap_or(&Value::Null);
                let Some(content) = extract_claude_message(message, role) else {
                    continue;
                };
                if role == "user" && !is_context_only_prompt(&content) {
                    replace_with_earliest(
                        &mut entry.first_user_text,
                        Some((content.clone(), title_time)),
                    );
                }
                entry.messages.push(ParsedMessage {
                    role: role.to_string(),
                    content,
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

fn extract_codex_message(payload: &Value) -> Option<(String, String)> {
    if payload.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let role = payload.get("role").and_then(Value::as_str)?;
    let accepted_types: &[&str] = match role {
        "user" => &["input_text", "text"],
        "assistant" => &["output_text", "text"],
        _ => return None,
    };
    let content = extract_content_text(payload.get("content")?, accepted_types)?;
    Some((role.to_string(), content))
}

fn extract_claude_message(message: &Value, role: &str) -> Option<String> {
    let accepted_types: &[&str] = match role {
        "user" | "assistant" => &["text"],
        _ => return None,
    };
    extract_content_text(message.get("content")?, accepted_types)
}

fn extract_content_text(content: &Value, accepted_types: &[&str]) -> Option<String> {
    if let Some(text) = content.as_str() {
        return normalized_message_text(text);
    }
    let mut parts = Vec::new();
    let items: Vec<&Value> = match content {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![content],
        _ => Vec::new(),
    };
    for item in items {
        let item_type = item.get("type").and_then(Value::as_str);
        if !item_type.is_some_and(|item_type| accepted_types.contains(&item_type)) {
            continue;
        }
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() {
                parts.push(text.to_string());
            }
        }
    }
    normalized_message_text(&parts.join("\n\n"))
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
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not finalize imported conversations: {error}"))?;
    Ok(())
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
    fn extracts_only_plain_codex_user_and_assistant_text() {
        let user = json!({
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "  explain this file  "},
                {"type": "input_image", "image_url": "ignored"}
            ]
        });
        let assistant = json!({
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "output_text", "text": "Here is the answer."},
                {"type": "reasoning", "text": "ignored"}
            ]
        });

        assert_eq!(
            extract_codex_message(&user),
            Some(("user".to_string(), "explain this file".to_string()))
        );
        assert_eq!(
            extract_codex_message(&assistant),
            Some(("assistant".to_string(), "Here is the answer.".to_string()))
        );
    }

    #[test]
    fn extracts_text_from_claude_string_and_content_array() {
        let user = json!({"content": "Write a test"});
        let assistant = json!({
            "content": [
                {"type": "thinking", "thinking": "ignored"},
                {"type": "text", "text": "Test added."},
                {"type": "tool_use", "name": "Write"}
            ]
        });

        assert_eq!(
            extract_claude_message(&user, "user"),
            Some("Write a test".to_string())
        );
        assert_eq!(
            extract_claude_message(&assistant, "assistant"),
            Some("Test added.".to_string())
        );
    }

    #[test]
    fn orders_imported_messages_by_timestamp_then_source_position() {
        let messages = vec![
            ParsedMessage {
                role: "assistant".to_string(),
                content: "second".to_string(),
                timestamp: 20,
                source_path: "b.jsonl".to_string(),
                line_number: 1,
            },
            ParsedMessage {
                role: "user".to_string(),
                content: "first".to_string(),
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
