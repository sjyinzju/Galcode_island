use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const CODEX_SOURCE: &str = "codex";
const CLAUDE_SOURCE: &str = "claude-code";
const STORE_VERSION: u8 = 4;
const LEGACY_STORE_FILE: &str = "imported-conversations.json";
const STORE_DIRECTORY: &str = "imported-conversations";
const STORE_INDEX_FILE: &str = "index.json";
const STORE_ITEMS_DIRECTORY: &str = "items";
const STORE_ASSETS_DIRECTORY: &str = "assets";
const STORE_STAGING_DIRECTORY: &str = "imported-conversations.v4.tmp";
const STORE_BACKUP_DIRECTORY: &str = "imported-conversations.v3.bak";
const MAX_ATTACHMENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_ASSET_FILE_BYTES: usize = ((MAX_ATTACHMENT_BYTES + 2) / 3) * 4 + 1024;
const MAX_IMPORT_WARNINGS: usize = 100;

static IMPORTED_STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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
        #[serde(default, rename = "dataUrl")]
        data_url: Option<String>,
        #[serde(default, rename = "assetId")]
        asset_id: Option<String>,
        alt: Option<String>,
    },
    Attachment {
        name: Option<String>,
        #[serde(rename = "mediaType")]
        media_type: Option<String>,
        #[serde(rename = "dataUrl")]
        data_url: Option<String>,
        #[serde(default, rename = "assetId")]
        asset_id: Option<String>,
        url: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_user_prompt: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_turn_id: Option<String>,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
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

#[derive(Serialize, Deserialize)]
struct ImportedConversationsIndex {
    version: u8,
    conversations: Vec<ImportedConversationSummary>,
    #[serde(default)]
    asset_references: HashMap<String, Vec<String>>,
}

#[derive(Clone)]
struct ParsedMessage {
    source_kind: &'static str,
    role: String,
    is_user_prompt: bool,
    source_turn_id: Option<String>,
    content: String,
    parts: Vec<ImportedTranscriptPart>,
    timestamp: i64,
    source_message_id: Option<String>,
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

#[derive(Clone)]
struct PreviewMessage {
    dedupe_key: String,
    user_text: Option<String>,
}

struct PendingCodexPreviewUser {
    timestamp: i64,
    raw_record: String,
    user_text: Option<String>,
    is_context: bool,
}

struct CodexPiece {
    native_session_id: String,
    rollout_id: Option<String>,
    project_path: Option<String>,
    created_at: i64,
    updated_at: i64,
    messages: Vec<ParsedMessage>,
    preview_messages: Vec<PreviewMessage>,
}

struct PendingCodexPiece {
    native_session_id: String,
    rollout_id: Option<String>,
    project_path: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    messages: Vec<ParsedMessage>,
}

impl PendingCodexPiece {
    fn observe_time(&mut self, timestamp: Option<i64>) {
        observe_time(&mut self.created_at, &mut self.updated_at, timestamp);
    }

    fn finish(self, fallback_time: i64) -> Option<CodexPiece> {
        (!self.messages.is_empty()).then_some(CodexPiece {
            native_session_id: self.native_session_id,
            rollout_id: self.rollout_id,
            project_path: self.project_path,
            created_at: self.created_at.unwrap_or(fallback_time),
            updated_at: self.updated_at.unwrap_or(fallback_time),
            messages: self.messages,
            preview_messages: Vec::new(),
        })
    }
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
    preview_messages: Vec<PreviewMessage>,
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

struct ScanOutput {
    conversations: Vec<(String, ParsedConversation)>,
    warnings: Vec<String>,
}

pub fn scan_external_sessions() -> Result<Vec<ExternalSessionPreview>, String> {
    let mut previews = Vec::new();
    for (source, conversation) in scan_source(CODEX_SOURCE, false, None)?.conversations {
        previews.push(to_preview(&source, &conversation));
    }
    for (source, conversation) in scan_source(CLAUDE_SOURCE, false, None)?.conversations {
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
    let mut warnings = Vec::new();
    for source in [CODEX_SOURCE, CLAUDE_SOURCE] {
        let Some(requested) = requested_by_source.get(source) else {
            continue;
        };
        let mut by_id = HashMap::new();
        let scan = scan_source(source, true, Some(requested))?;
        for (_, conversation) in scan.conversations {
            by_id.insert(conversation.native_session_id.clone(), conversation);
        }
        for warning in scan.warnings {
            push_warning(&mut warnings, warning);
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
            warnings,
        });
    }

    let summaries = with_imported_store(app, |config_dir| {
        upsert_imported_conversations_at(config_dir, &imported)
    })?;
    Ok(ImportExternalSessionsResult {
        imported: summaries,
        skipped,
        warnings,
    })
}

pub fn list_imported_conversations(
    app: &AppHandle,
) -> Result<Vec<ImportedConversationSummary>, String> {
    with_imported_store(app, list_imported_conversations_at)
}

pub fn load_imported_conversation(
    app: &AppHandle,
    id: &str,
) -> Result<ImportedConversation, String> {
    with_imported_store(app, |config_dir| {
        load_imported_conversation_at(config_dir, id)
    })
}

pub fn remove_imported_conversation(app: &AppHandle, id: &str) -> Result<(), String> {
    with_imported_store(app, |config_dir| {
        remove_imported_conversation_at(config_dir, id)
    })
}

pub fn load_imported_asset(app: &AppHandle, asset_id: &str) -> Result<String, String> {
    with_imported_store(app, |config_dir| {
        load_imported_asset_at(config_dir, asset_id)
    })
}

fn scan_source(
    source: &str,
    include_messages: bool,
    selected_ids: Option<&HashSet<String>>,
) -> Result<ScanOutput, String> {
    let mut warnings = Vec::new();
    match source {
        CODEX_SOURCE => Ok(ScanOutput {
            conversations: scan_codex(include_messages, selected_ids, &mut warnings)
                .into_iter()
                .map(|conversation| (CODEX_SOURCE.to_string(), conversation))
                .collect(),
            warnings,
        }),
        CLAUDE_SOURCE => Ok(ScanOutput {
            conversations: scan_claude(include_messages, selected_ids, &mut warnings)
                .into_iter()
                .map(|conversation| (CLAUDE_SOURCE.to_string(), conversation))
                .collect(),
            warnings,
        }),
        _ => Err(format!("Unsupported external history source: {source}")),
    }
}

fn scan_codex(
    include_messages: bool,
    selected_ids: Option<&HashSet<String>>,
    warnings: &mut Vec<String>,
) -> Vec<ParsedConversation> {
    let Some(home) = user_home_dir() else {
        return Vec::new();
    };
    let codex_root = home.join(".codex");
    if !codex_root.exists() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_jsonl_files(&codex_root.join("sessions"), &mut files, warnings);
    collect_jsonl_files(&codex_root.join("archived_sessions"), &mut files, warnings);
    files.sort();

    let mut pieces = Vec::new();
    for path in files {
        let fallback_id = fallback_session_id(&path);
        if include_messages {
            pieces.extend(parse_codex_file_with_options(
                &path,
                fallback_id,
                selected_ids,
                warnings,
            ));
        } else if let Some(piece) = parse_codex_preview_file(&path, fallback_id, warnings) {
            pieces.push(piece);
        }
    }

    let index = read_codex_index(&codex_root.join("session_index.jsonl"), warnings);
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
        if include_messages {
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
                entry.messages.push(message);
            }
        } else {
            for message in piece.preview_messages {
                if !entry.seen_messages.insert(message.dedupe_key) {
                    continue;
                }
                if entry.first_user_text.is_none() {
                    entry.first_user_text = message.user_text;
                }
                entry.message_count += 1;
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

fn scan_claude(
    include_messages: bool,
    selected_ids: Option<&HashSet<String>>,
    warnings: &mut Vec<String>,
) -> Vec<ParsedConversation> {
    let Some(home) = user_home_dir() else {
        return Vec::new();
    };
    let projects_root = home.join(".claude").join("projects");
    let mut files = Vec::new();
    collect_jsonl_files(&projects_root, &mut files, warnings);
    files.sort();

    let mut pieces = Vec::new();
    for path in files {
        if include_messages {
            pieces.extend(parse_claude_file_with_options(
                &path,
                true,
                selected_ids,
                warnings,
            ));
        } else {
            pieces.extend(parse_claude_preview_file(&path, warnings));
        }
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
        if include_messages {
            for message in piece.messages {
                let dedupe_key = message_dedupe_key(&message);
                if !entry.seen_messages.insert(dedupe_key) {
                    continue;
                }
                entry.message_count += 1;
                entry.messages.push(message);
            }
        } else {
            for message in piece.preview_messages {
                if entry.seen_messages.insert(message.dedupe_key) {
                    entry.message_count += 1;
                }
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

#[derive(Deserialize)]
struct PreviewContentItem {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
    thinking: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PreviewContent {
    Text(String),
    Items(Vec<PreviewContentItem>),
    Other(serde::de::IgnoredAny),
}

#[derive(Deserialize)]
struct PreviewCodexRecord {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<Value>,
    payload: Option<PreviewCodexPayload>,
}

#[derive(Deserialize)]
struct PreviewCodexPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    role: Option<String>,
    content: Option<PreviewContent>,
    session_id: Option<String>,
    id: Option<String>,
    cwd: Option<String>,
    thread_source: Option<String>,
    source: Option<Value>,
    timestamp: Option<Value>,
}

#[derive(Deserialize)]
struct PreviewClaudeMessage {
    content: Option<PreviewContent>,
}

#[derive(Deserialize)]
struct PreviewClaudeAttachment {
    #[serde(rename = "type")]
    kind: Option<String>,
    prompt: Option<String>,
}

#[derive(Deserialize)]
struct PreviewClaudeRecord {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    timestamp: Option<Value>,
    cwd: Option<String>,
    #[serde(rename = "isSidechain", default)]
    is_sidechain: bool,
    #[serde(rename = "isMeta", default)]
    is_meta: bool,
    #[serde(rename = "customTitle")]
    custom_title: Option<String>,
    #[serde(rename = "aiTitle")]
    ai_title: Option<String>,
    #[serde(rename = "lastPrompt")]
    last_prompt: Option<String>,
    message: Option<PreviewClaudeMessage>,
    attachment: Option<PreviewClaudeAttachment>,
}

fn preview_first_text(content: Option<&PreviewContent>) -> Option<String> {
    match content? {
        PreviewContent::Text(text) => normalized_message_text(text),
        PreviewContent::Items(items) => items.iter().find_map(|item| {
            if matches!(
                item.kind.as_deref(),
                Some("text" | "input_text" | "output_text")
            ) {
                item.text.as_deref().and_then(normalized_message_text)
            } else if matches!(
                item.kind.as_deref(),
                Some("thinking" | "reasoning" | "summary_text")
            ) {
                item.thinking
                    .as_deref()
                    .or(item.text.as_deref())
                    .and_then(normalized_message_text)
            } else {
                None
            }
        }),
        PreviewContent::Other(_) => None,
    }
}

fn preview_content_has_message(content: Option<&PreviewContent>) -> bool {
    match content {
        Some(PreviewContent::Text(text)) => normalized_message_text(text).is_some(),
        Some(PreviewContent::Items(items)) => !items.is_empty(),
        Some(PreviewContent::Other(_)) | None => false,
    }
}

fn preview_content_is_text_only(content: Option<&PreviewContent>) -> bool {
    match content {
        Some(PreviewContent::Text(_)) => true,
        Some(PreviewContent::Items(items)) => {
            !items.is_empty()
                && items.iter().all(|item| {
                    matches!(
                        item.kind.as_deref(),
                        Some("text" | "input_text" | "output_text")
                    )
                })
        }
        Some(PreviewContent::Other(_)) | None => false,
    }
}

fn preview_dedupe_key(role: &str, timestamp: i64, raw_record: &str) -> String {
    let mut hasher = DefaultHasher::new();
    role.hash(&mut hasher);
    timestamp.hash(&mut hasher);
    raw_record.hash(&mut hasher);
    format!("preview:{:016x}", hasher.finish())
}

fn push_pending_codex_preview(
    messages: &mut Vec<PreviewMessage>,
    pending: PendingCodexPreviewUser,
    confirmed_user: bool,
) {
    let is_user = confirmed_user || !pending.is_context;
    messages.push(PreviewMessage {
        dedupe_key: preview_dedupe_key(
            if is_user { "user" } else { "system" },
            pending.timestamp,
            &pending.raw_record,
        ),
        user_text: is_user.then_some(pending.user_text).flatten(),
    });
}

fn parse_codex_preview_file(
    path: &Path,
    fallback_id: String,
    warnings: &mut Vec<String>,
) -> Option<CodexPiece> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            push_warning(
                warnings,
                format!(
                    "Could not read Codex history file {}: {error}",
                    path.display()
                ),
            );
            return None;
        }
    };
    let fallback_time = file_modified_millis(path).unwrap_or(0);
    let mut native_session_id = fallback_id;
    let mut rollout_id = None;
    let mut project_path = None;
    let mut created_at = None;
    let mut updated_at = None;
    let mut preview_messages = Vec::new();
    let mut pending_user_message = None;
    let mut found_session_meta = false;

    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                push_warning(
                    warnings,
                    format!(
                        "Could not read Codex history line {}:{}: {error}",
                        path.display(),
                        line_index + 1
                    ),
                );
                continue;
            }
        };
        let record =
            match serde_json::from_str::<PreviewCodexRecord>(line.trim_start_matches('\u{feff}')) {
                Ok(record) => record,
                Err(error) => {
                    push_warning(
                        warnings,
                        format!(
                            "Codex history contains invalid JSON at {}:{}: {error}",
                            path.display(),
                            line_index + 1
                        ),
                    );
                    continue;
                }
            };
        let record_time = timestamp_from_value(record.timestamp.as_ref());
        let is_user_message_marker = found_session_meta
            && record.kind.as_deref() == Some("event_msg")
            && record
                .payload
                .as_ref()
                .and_then(|payload| payload.kind.as_deref())
                == Some("user_message");
        if is_user_message_marker {
            observe_time(&mut created_at, &mut updated_at, record_time);
            if let Some(pending) = pending_user_message.take() {
                push_pending_codex_preview(&mut preview_messages, pending, true);
            }
            continue;
        }
        if let Some(pending) = pending_user_message.take() {
            push_pending_codex_preview(&mut preview_messages, pending, false);
        }
        if record.kind.as_deref() == Some("session_meta") {
            if found_session_meta {
                continue;
            }
            let Some(payload) = record.payload.as_ref() else {
                continue;
            };
            let is_subagent = payload
                .thread_source
                .as_deref()
                .is_some_and(|source| source != "user")
                || payload
                    .source
                    .as_ref()
                    .and_then(Value::as_object)
                    .is_some_and(|source| source.contains_key("subagent"));
            if is_subagent {
                continue;
            }
            found_session_meta = true;
            rollout_id = payload
                .id
                .as_deref()
                .filter(|id| !id.trim().is_empty())
                .map(ToString::to_string);
            if let Some(id) = payload
                .session_id
                .as_deref()
                .filter(|id| !id.trim().is_empty())
                .or(rollout_id.as_deref())
            {
                native_session_id = id.to_string();
            }
            project_path = payload.cwd.clone();
            observe_time(&mut created_at, &mut updated_at, record_time);
            observe_time(
                &mut created_at,
                &mut updated_at,
                timestamp_from_value(payload.timestamp.as_ref()),
            );
            continue;
        }
        if !found_session_meta || record.kind.as_deref() != Some("response_item") {
            continue;
        }
        observe_time(&mut created_at, &mut updated_at, record_time);
        let Some(payload) = record.payload.as_ref() else {
            continue;
        };
        let Some(payload_type) = payload.kind.as_deref() else {
            continue;
        };
        let role = if payload_type == "message" {
            payload.role.as_deref().unwrap_or("assistant")
        } else if payload_type.ends_with("_output") {
            "tool"
        } else {
            "assistant"
        };
        let first_text = (role == "user")
            .then(|| preview_first_text(payload.content.as_ref()))
            .flatten();
        let is_context = role == "user"
            && preview_content_is_text_only(payload.content.as_ref())
            && first_text.as_deref().is_some_and(is_context_only_prompt);
        if payload_type == "message" && !preview_content_has_message(payload.content.as_ref()) {
            continue;
        }
        if role == "user" {
            pending_user_message = Some(PendingCodexPreviewUser {
                timestamp: record_time.unwrap_or(0),
                raw_record: line,
                user_text: first_text,
                is_context,
            });
            continue;
        }
        preview_messages.push(PreviewMessage {
            dedupe_key: preview_dedupe_key(role, record_time.unwrap_or(0), &line),
            user_text: None,
        });
    }
    if let Some(pending) = pending_user_message {
        push_pending_codex_preview(&mut preview_messages, pending, false);
    }

    (!preview_messages.is_empty()).then_some(CodexPiece {
        native_session_id,
        rollout_id,
        project_path,
        created_at: created_at.unwrap_or(fallback_time),
        updated_at: updated_at.unwrap_or(fallback_time),
        messages: Vec::new(),
        preview_messages,
    })
}

fn parse_claude_preview_file(path: &Path, warnings: &mut Vec<String>) -> Vec<ClaudePiece> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            push_warning(
                warnings,
                format!(
                    "Could not read Claude history file {}: {error}",
                    path.display()
                ),
            );
            return Vec::new();
        }
    };
    let fallback_time = file_modified_millis(path).unwrap_or(0);
    let file_session_id = fallback_session_id(path);
    let mut pieces: HashMap<String, ClaudePiece> = HashMap::new();

    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                push_warning(
                    warnings,
                    format!(
                        "Could not read Claude history line {}:{}: {error}",
                        path.display(),
                        line_index + 1
                    ),
                );
                continue;
            }
        };
        let record = match serde_json::from_str::<PreviewClaudeRecord>(
            line.trim_start_matches('\u{feff}'),
        ) {
            Ok(record) => record,
            Err(error) => {
                push_warning(
                    warnings,
                    format!(
                        "Claude history contains invalid JSON at {}:{}: {error}",
                        path.display(),
                        line_index + 1
                    ),
                );
                continue;
            }
        };
        let native_session_id = record
            .session_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or(file_session_id.as_str())
            .to_string();
        let record_time = timestamp_from_value(record.timestamp.as_ref());
        let initial_time = record_time.unwrap_or(fallback_time);
        let entry = pieces
            .entry(native_session_id.clone())
            .or_insert_with(|| ClaudePiece {
                native_session_id,
                project_path: record.cwd.clone(),
                created_at: initial_time,
                updated_at: initial_time,
                custom_title: None,
                ai_title: None,
                last_prompt: None,
                first_user_text: None,
                messages: Vec::new(),
                preview_messages: Vec::new(),
            });
        entry.created_at = min_non_zero(entry.created_at, initial_time);
        entry.updated_at = entry.updated_at.max(initial_time);
        if entry.project_path.is_none() {
            entry.project_path = record.cwd.clone();
        }
        match record.kind.as_deref() {
            Some("custom-title") => replace_with_latest(
                &mut entry.custom_title,
                record
                    .custom_title
                    .filter(|title| !title.trim().is_empty())
                    .map(|title| (title, initial_time)),
            ),
            Some("ai-title") => replace_with_latest(
                &mut entry.ai_title,
                record
                    .ai_title
                    .filter(|title| !title.trim().is_empty())
                    .map(|title| (title, initial_time)),
            ),
            Some("last-prompt") => replace_with_latest(
                &mut entry.last_prompt,
                record
                    .last_prompt
                    .filter(|prompt| !prompt.trim().is_empty())
                    .map(|prompt| (prompt, initial_time)),
            ),
            Some(role @ ("user" | "assistant")) => {
                let content = record
                    .message
                    .as_ref()
                    .and_then(|message| message.content.as_ref());
                if !preview_content_has_message(content) {
                    continue;
                }
                let is_context = record.is_sidechain
                    || record.is_meta
                    || (role == "user"
                        && preview_content_is_text_only(content)
                        && preview_first_text(content)
                            .as_deref()
                            .is_some_and(is_context_only_prompt));
                let semantic_role = if is_context { "system" } else { role };
                let user_text = (semantic_role == "user")
                    .then(|| preview_first_text(content))
                    .flatten()
                    .filter(|text| !is_context_only_prompt(text));
                if let Some(text) = user_text.as_ref() {
                    replace_with_earliest(
                        &mut entry.first_user_text,
                        Some((text.clone(), initial_time)),
                    );
                }
                entry.preview_messages.push(PreviewMessage {
                    dedupe_key: preview_dedupe_key(semantic_role, record_time.unwrap_or(0), &line),
                    user_text,
                });
            }
            Some("attachment") => {
                let queued_prompt = record
                    .attachment
                    .as_ref()
                    .filter(|attachment| attachment.kind.as_deref() == Some("queued_command"))
                    .and_then(|attachment| attachment.prompt.as_deref())
                    .and_then(normalized_message_text);
                let role = if queued_prompt.is_some() {
                    "user"
                } else {
                    "system"
                };
                entry.preview_messages.push(PreviewMessage {
                    dedupe_key: preview_dedupe_key(role, record_time.unwrap_or(0), &line),
                    user_text: queued_prompt,
                });
            }
            Some("system") => entry.preview_messages.push(PreviewMessage {
                dedupe_key: preview_dedupe_key("system", record_time.unwrap_or(0), &line),
                user_text: None,
            }),
            _ => {}
        }
    }
    pieces.into_values().collect()
}

fn parse_codex_file(path: &Path, fallback_id: String) -> Option<CodexPiece> {
    let mut warnings = Vec::new();
    parse_codex_file_with_options(path, fallback_id, None, &mut warnings)
        .into_iter()
        .next()
}

fn parse_codex_file_with_options(
    path: &Path,
    fallback_id: String,
    selected_ids: Option<&HashSet<String>>,
    warnings: &mut Vec<String>,
) -> Vec<CodexPiece> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            push_warning(
                warnings,
                format!(
                    "Could not read Codex history file {}: {error}",
                    path.display()
                ),
            );
            return Vec::new();
        }
    };
    let fallback_time = file_modified_millis(path).unwrap_or(0);
    let mut pieces = Vec::new();
    let mut current: Option<PendingCodexPiece> = None;
    let mut pending_user_message: Option<ParsedMessage> = None;
    let source_path = path.to_string_lossy().into_owned();

    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                push_warning(
                    warnings,
                    format!(
                        "Could not read Codex history line {}:{}: {error}",
                        path.display(),
                        line_index + 1
                    ),
                );
                continue;
            }
        };
        let raw_record = line.trim_start_matches('\u{feff}');
        let record = match serde_json::from_str::<Value>(raw_record) {
            Ok(record) => record,
            Err(error) => {
                push_warning(
                    warnings,
                    format!(
                        "Codex history contains invalid JSON at {}:{}: {error}",
                        path.display(),
                        line_index + 1
                    ),
                );
                continue;
            }
        };

        let record_time = timestamp_from_value(record.get("timestamp"));
        let is_user_message_marker = current.is_some()
            && record.get("type").and_then(Value::as_str) == Some("event_msg")
            && record.pointer("/payload/type").and_then(Value::as_str) == Some("user_message");
        if is_user_message_marker {
            if let Some(current) = current.as_mut() {
                current.observe_time(record_time);
                if let Some(mut pending) = pending_user_message.take() {
                    pending.role = "user".to_string();
                    pending.is_user_prompt = true;
                    current.messages.push(pending);
                }
            }
            continue;
        }
        if let Some(pending) = pending_user_message.take() {
            if let Some(current) = current.as_mut() {
                current.messages.push(pending);
            }
        }

        if record.get("type").and_then(Value::as_str) == Some("session_meta") {
            if let Some(piece) = current.take().and_then(|piece| piece.finish(fallback_time)) {
                pieces.push(piece);
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
            let rollout_id = payload
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(ToString::to_string);
            let native_session_id = payload
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .or(rollout_id.as_deref())
                .unwrap_or(fallback_id.as_str())
                .to_string();
            if selected_ids.is_some_and(|ids| !ids.contains(&native_session_id)) {
                continue;
            }
            let mut piece = PendingCodexPiece {
                native_session_id,
                rollout_id,
                project_path: payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                created_at: None,
                updated_at: None,
                messages: Vec::new(),
            };
            piece.observe_time(record_time);
            piece.observe_time(timestamp_from_value(payload.get("timestamp")));
            current = Some(piece);
            continue;
        }

        let Some(current) = current.as_mut() else {
            continue;
        };

        current.observe_time(record_time);
        if record.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let payload = record.get("payload").unwrap_or(&Value::Null);
        let context = format!("{}:{}", path.display(), line_index + 1);
        let Some((mut role, content, parts)) =
            extract_codex_message_with_warnings(payload, warnings, &context)
        else {
            continue;
        };
        let is_source_user = role == "user";
        let is_context =
            is_source_user && contains_only_text(&parts) && is_context_only_prompt(&content);
        if is_context {
            role = "system".to_string();
        }
        let timestamp = record_time.unwrap_or(0);
        let source_message_id = payload
            .get("id")
            .or_else(|| payload.get("call_id"))
            .or_else(|| record.get("id"))
            .or_else(|| record.get("uuid"))
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(ToString::to_string);
        let source_turn_id = payload
            .pointer("/internal_chat_message_metadata_passthrough/turn_id")
            .or_else(|| payload.pointer("/metadata/turn_id"))
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(ToString::to_string)
            .or_else(|| is_source_user.then(|| source_message_id.clone()).flatten());
        let parsed = ParsedMessage {
            source_kind: CODEX_SOURCE,
            role,
            is_user_prompt: is_source_user && !is_context,
            source_turn_id,
            content,
            parts,
            timestamp,
            source_message_id,
            source_path: source_path.clone(),
            line_number: line_index,
        };
        if is_source_user {
            pending_user_message = Some(parsed);
        } else {
            current.messages.push(parsed);
        }
    }
    if let Some(pending) = pending_user_message {
        if let Some(current) = current.as_mut() {
            current.messages.push(pending);
        }
    }
    if let Some(piece) = current.and_then(|piece| piece.finish(fallback_time)) {
        pieces.push(piece);
    }
    pieces
}

fn parse_claude_file(path: &Path) -> Vec<ClaudePiece> {
    let mut warnings = Vec::new();
    parse_claude_file_with_options(path, true, None, &mut warnings)
}

fn parse_claude_file_with_options(
    path: &Path,
    include_messages: bool,
    selected_ids: Option<&HashSet<String>>,
    warnings: &mut Vec<String>,
) -> Vec<ClaudePiece> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            push_warning(
                warnings,
                format!(
                    "Could not read Claude history file {}: {error}",
                    path.display()
                ),
            );
            return Vec::new();
        }
    };
    let file_session_id = fallback_session_id(path);
    let source_path = path.to_string_lossy().into_owned();
    let mut pieces: HashMap<String, ClaudePiece> = HashMap::new();
    let fallback_time = file_modified_millis(path).unwrap_or(0);

    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                push_warning(
                    warnings,
                    format!(
                        "Could not read Claude history line {}:{}: {error}",
                        path.display(),
                        line_index + 1
                    ),
                );
                continue;
            }
        };
        let raw_record = line.trim_start_matches('\u{feff}');
        if let Some(selected_ids) = selected_ids {
            let preview = match serde_json::from_str::<PreviewClaudeRecord>(raw_record) {
                Ok(preview) => preview,
                Err(error) => {
                    push_warning(
                        warnings,
                        format!(
                            "Claude history contains invalid JSON at {}:{}: {error}",
                            path.display(),
                            line_index + 1
                        ),
                    );
                    continue;
                }
            };
            let native_session_id = preview
                .session_id
                .as_deref()
                .filter(|session_id| !session_id.trim().is_empty())
                .unwrap_or(file_session_id.as_str());
            if !selected_ids.contains(native_session_id) {
                continue;
            }
        }
        let record = match serde_json::from_str::<Value>(raw_record) {
            Ok(record) => record,
            Err(error) => {
                push_warning(
                    warnings,
                    format!(
                        "Claude history contains invalid JSON at {}:{}: {error}",
                        path.display(),
                        line_index + 1
                    ),
                );
                continue;
            }
        };
        let is_sidechain = record
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let is_meta = record
            .get("isMeta")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let native_session_id = record
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|session_id| !session_id.trim().is_empty())
            .unwrap_or(file_session_id.as_str())
            .to_string();
        let record_time = timestamp_from_value(record.get("timestamp"));
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
                preview_messages: Vec::new(),
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
                let context = format!("{}:{}", path.display(), line_index + 1);
                let Some((content, parts)) =
                    extract_claude_message_with_warnings(message, role, warnings, &context)
                else {
                    continue;
                };
                let is_task_notification = record.pointer("/origin/kind").and_then(Value::as_str)
                    == Some("task-notification")
                    || content.trim_start().starts_with("<task-notification>");
                let is_internal_context = role == "user"
                    && contains_only_text(&parts)
                    && is_context_only_prompt(&content);
                let semantic_role = if is_sidechain
                    || is_meta
                    || (role == "user" && is_task_notification)
                    || is_internal_context
                {
                    "system"
                } else {
                    semantic_claude_role(role, &parts)
                };
                if semantic_role == "user" {
                    if let Some(text) =
                        first_text_part(&parts).filter(|text| !is_context_only_prompt(text))
                    {
                        replace_with_earliest(
                            &mut entry.first_user_text,
                            Some((text.to_string(), title_time)),
                        );
                    }
                }
                if include_messages {
                    let source_message_id = message
                        .get("id")
                        .or_else(|| message.get("uuid"))
                        .or_else(|| record.get("uuid"))
                        .or_else(|| record.get("id"))
                        .and_then(Value::as_str)
                        .filter(|id| !id.trim().is_empty())
                        .map(ToString::to_string);
                    entry.messages.push(ParsedMessage {
                        source_kind: CLAUDE_SOURCE,
                        role: semantic_role.to_string(),
                        is_user_prompt: semantic_role == "user",
                        source_turn_id: (semantic_role == "user")
                            .then(|| source_message_id.clone())
                            .flatten(),
                        content,
                        parts,
                        timestamp: record_time.unwrap_or(0),
                        source_message_id,
                        source_path: source_path.clone(),
                        line_number: line_index,
                    });
                } else {
                    entry.preview_messages.push(PreviewMessage {
                        dedupe_key: preview_dedupe_key(
                            semantic_role,
                            record_time.unwrap_or(0),
                            line.trim_start_matches('\u{feff}'),
                        ),
                        user_text: None,
                    });
                }
            }
            Some("attachment") => {
                let context = format!("{}:{}", path.display(), line_index + 1);
                let Some((role, content, parts)) =
                    extract_claude_top_level_attachment(&record, warnings, &context)
                else {
                    continue;
                };
                if role == "user" {
                    if let Some(text) = first_text_part(&parts) {
                        replace_with_earliest(
                            &mut entry.first_user_text,
                            Some((text.to_string(), title_time)),
                        );
                    }
                }
                if include_messages {
                    let source_message_id = record
                        .get("uuid")
                        .or_else(|| record.get("id"))
                        .and_then(Value::as_str)
                        .filter(|id| !id.trim().is_empty())
                        .map(ToString::to_string);
                    entry.messages.push(ParsedMessage {
                        source_kind: CLAUDE_SOURCE,
                        role: role.to_string(),
                        is_user_prompt: role == "user",
                        source_turn_id: (role == "user")
                            .then(|| source_message_id.clone())
                            .flatten(),
                        content,
                        parts,
                        timestamp: record_time.unwrap_or(0),
                        source_message_id,
                        source_path: source_path.clone(),
                        line_number: line_index,
                    });
                } else {
                    entry.preview_messages.push(PreviewMessage {
                        dedupe_key: preview_dedupe_key(
                            role,
                            record_time.unwrap_or(0),
                            line.trim_start_matches('\u{feff}'),
                        ),
                        user_text: (role == "user")
                            .then(|| first_text_part(&parts).map(ToString::to_string))
                            .flatten(),
                    });
                }
            }
            Some("system") => {
                let kind = record
                    .get("subtype")
                    .and_then(Value::as_str)
                    .unwrap_or("system")
                    .to_string();
                let mut data = record.clone();
                let mut media = Vec::new();
                let context = format!("{}:{}", path.display(), line_index + 1);
                sanitize_embedded_media(&mut data, &mut media, warnings, &context);
                let mut parts = vec![ImportedTranscriptPart::Event { kind, data }];
                parts.extend(media);
                let Some(content) = parts_to_legacy_content(&parts) else {
                    continue;
                };
                if include_messages {
                    let source_message_id = record
                        .get("uuid")
                        .or_else(|| record.get("id"))
                        .and_then(Value::as_str)
                        .filter(|id| !id.trim().is_empty())
                        .map(ToString::to_string);
                    entry.messages.push(ParsedMessage {
                        source_kind: CLAUDE_SOURCE,
                        role: "system".to_string(),
                        is_user_prompt: false,
                        source_turn_id: None,
                        content,
                        parts,
                        timestamp: record_time.unwrap_or(0),
                        source_message_id,
                        source_path: source_path.clone(),
                        line_number: line_index,
                    });
                } else {
                    entry.preview_messages.push(PreviewMessage {
                        dedupe_key: preview_dedupe_key(
                            "system",
                            record_time.unwrap_or(0),
                            line.trim_start_matches('\u{feff}'),
                        ),
                        user_text: None,
                    });
                }
            }
            Some(kind) => push_warning(
                warnings,
                format!(
                    "{}:{}: unknown Claude record type `{kind}` was skipped",
                    path.display(),
                    line_index + 1
                ),
            ),
            None => push_warning(
                warnings,
                format!(
                    "{}:{}: Claude record without a type was skipped",
                    path.display(),
                    line_index + 1
                ),
            ),
        }
    }
    pieces.into_values().collect()
}

fn extract_codex_message(payload: &Value) -> Option<(String, String, Vec<ImportedTranscriptPart>)> {
    let mut warnings = Vec::new();
    extract_codex_message_with_warnings(payload, &mut warnings, "Codex record")
}

fn extract_codex_message_with_warnings(
    payload: &Value,
    warnings: &mut Vec<String>,
    context: &str,
) -> Option<(String, String, Vec<ImportedTranscriptPart>)> {
    let payload_type = payload.get("type").and_then(Value::as_str)?;
    let (role, parts) = match payload_type {
        "message" => {
            let role = payload.get("role").and_then(Value::as_str)?;
            let parts =
                extract_content_parts_with_warnings(payload.get("content")?, warnings, context);
            (role.to_string(), parts)
        }
        "reasoning" => {
            let mut parts = payload
                .get("summary")
                .map(|content| extract_thinking_parts(content, warnings, context))
                .unwrap_or_default();
            if parts.is_empty() {
                parts.push(ImportedTranscriptPart::Event {
                    kind: "reasoning".to_string(),
                    data: Value::Null,
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
            let mut input = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .or_else(|| payload.get("action"))
                .map(parse_json_string)
                .unwrap_or(Value::Null);
            let mut media = Vec::new();
            sanitize_embedded_media(&mut input, &mut media, warnings, context);
            let part = ImportedTranscriptPart::ToolCall {
                tool_call_id: codex_call_id(payload),
                name,
                input,
            };
            let mut parts = vec![part];
            parts.extend(media);
            ("assistant".to_string(), parts)
        }
        "function_call_output" | "custom_tool_call_output" | "tool_search_output" => {
            let mut output = payload
                .get("output")
                .cloned()
                .map(|value| parse_json_string(&value))
                .unwrap_or_else(|| payload.clone());
            let mut media = Vec::new();
            sanitize_embedded_media(&mut output, &mut media, warnings, context);
            let part = ImportedTranscriptPart::ToolResult {
                tool_call_id: codex_call_id(payload),
                output,
                is_error: payload.get("status").and_then(Value::as_str) == Some("failed"),
            };
            let mut parts = vec![part];
            parts.extend(media);
            ("tool".to_string(), parts)
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
            let mut parts = vec![call];
            if validate_base64_payload(data).is_ok() {
                parts.push(ImportedTranscriptPart::Image {
                    data_url: Some(format!("data:image/png;base64,{data}")),
                    asset_id: None,
                    alt,
                });
            } else {
                push_warning(
                    warnings,
                    format!("{context}: invalid base64 image generation output"),
                );
            }
            ("assistant".to_string(), parts)
        }
        "agent_message" => {
            let text = payload.get("message").and_then(Value::as_str)?;
            let mut value = Value::String(normalized_message_text(text)?);
            let mut media = Vec::new();
            sanitize_embedded_media(&mut value, &mut media, warnings, context);
            let mut parts = value
                .as_str()
                .and_then(normalized_message_text)
                .map(|text| vec![ImportedTranscriptPart::Text { text }])
                .unwrap_or_default();
            parts.extend(media);
            ("assistant".to_string(), parts)
        }
        _ => {
            push_warning(
                warnings,
                format!("{context}: unknown Codex response item type `{payload_type}`"),
            );
            let mut data = payload.clone();
            let mut media = Vec::new();
            sanitize_embedded_media(&mut data, &mut media, warnings, context);
            let mut parts = vec![ImportedTranscriptPart::Event {
                kind: payload_type.to_string(),
                data,
            }];
            parts.extend(media);
            ("assistant".to_string(), parts)
        }
    };
    let content = parts_to_legacy_content(&parts)?;
    Some((role, content, parts))
}

fn extract_claude_top_level_attachment<'a>(
    record: &'a Value,
    warnings: &mut Vec<String>,
    context: &str,
) -> Option<(&'static str, String, Vec<ImportedTranscriptPart>)> {
    let attachment = record.get("attachment")?;
    let kind = attachment
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("attachment");
    let (role, parts) = match kind {
        "queued_command" => {
            if let Some(text) = attachment
                .get("prompt")
                .and_then(Value::as_str)
                .and_then(normalized_message_text)
            {
                ("user", vec![ImportedTranscriptPart::Text { text }])
            } else {
                push_warning(
                    warnings,
                    format!("{context}: queued command without a prompt was preserved as context"),
                );
                (
                    "system",
                    vec![ImportedTranscriptPart::Event {
                        kind: kind.to_string(),
                        data: attachment.clone(),
                    }],
                )
            }
        }
        "file" => (
            "system",
            vec![claude_file_attachment_part(attachment, warnings, context)],
        ),
        _ => {
            let mut data = attachment.clone();
            let mut media = Vec::new();
            sanitize_embedded_media(&mut data, &mut media, warnings, context);
            let mut parts = vec![ImportedTranscriptPart::Event {
                kind: kind.to_string(),
                data,
            }];
            parts.extend(media);
            ("system", parts)
        }
    };
    let content = parts_to_legacy_content(&parts)?;
    Some((role, content, parts))
}

fn claude_file_attachment_part(
    attachment: &Value,
    warnings: &mut Vec<String>,
    context: &str,
) -> ImportedTranscriptPart {
    let display_path = attachment
        .get("displayPath")
        .or_else(|| attachment.get("display_path"))
        .and_then(Value::as_str)
        .and_then(normalized_message_text);
    let name = attachment_name(attachment).or_else(|| {
        display_path.as_deref().and_then(|path| {
            path.rsplit(['/', '\\'])
                .find(|component| !component.is_empty())
                .map(ToString::to_string)
        })
    });
    let content = attachment.get("content").unwrap_or(&Value::Null);
    let content_kind = content.get("type").and_then(Value::as_str);
    let file = content.get("file").unwrap_or(content);
    let explicit_media_type = attachment
        .get("mediaType")
        .or_else(|| attachment.get("media_type"))
        .or_else(|| attachment.get("mimeType"))
        .or_else(|| attachment.get("mime_type"))
        .or_else(|| content.get("mediaType"))
        .or_else(|| content.get("media_type"))
        .and_then(Value::as_str);
    let inferred_media_type = match content_kind {
        Some("pdf") => "application/pdf",
        Some("text") => "text/plain",
        _ => "application/octet-stream",
    };
    let media_type = explicit_media_type
        .unwrap_or(inferred_media_type)
        .to_string();

    let data_url = match content_kind {
        Some("text") => file
            .get("content")
            .and_then(Value::as_str)
            .and_then(|text| text_attachment_data_url(text, warnings, context)),
        Some("pdf") => file
            .get("base64")
            .and_then(Value::as_str)
            .and_then(|payload| {
                raw_base64_attachment_data_url(payload, &media_type, warnings, context)
            }),
        _ => content.as_str().and_then(|value| {
            if value.starts_with("data:") {
                validate_asset_data_url(value)
                    .map(|_| value.to_string())
                    .map_err(|error| {
                        push_warning(
                            warnings,
                            format!("{context}: invalid file data URL ({error})"),
                        );
                    })
                    .ok()
            } else {
                text_attachment_data_url(value, warnings, context)
            }
        }),
    };
    if data_url.is_none() && !content.is_null() {
        push_warning(
            warnings,
            format!("{context}: unsupported file attachment content was preserved as metadata"),
        );
    }

    ImportedTranscriptPart::Attachment {
        name,
        media_type: Some(media_type),
        data_url,
        asset_id: None,
        url: display_path,
    }
}

fn text_attachment_data_url(
    text: &str,
    warnings: &mut Vec<String>,
    context: &str,
) -> Option<String> {
    if text.len() > MAX_ATTACHMENT_BYTES {
        push_warning(
            warnings,
            format!("{context}: text attachment exceeds the import size limit"),
        );
        return None;
    }
    Some(format!(
        "data:text/plain;base64,{}",
        encode_base64(text.as_bytes())
    ))
}

fn raw_base64_attachment_data_url(
    payload: &str,
    media_type: &str,
    warnings: &mut Vec<String>,
    context: &str,
) -> Option<String> {
    if let Err(reason) = validate_base64_payload(payload) {
        push_warning(
            warnings,
            format!("{context}: invalid base64 file attachment ({reason})"),
        );
        return None;
    }
    Some(format!("data:{media_type};base64,{payload}"))
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        encoded.push(TABLE[(first >> 2) as usize] as char);
        encoded.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            encoded.push(TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char);
        } else {
            encoded.push('=');
        }
        if chunk.len() > 2 {
            encoded.push(TABLE[(third & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
    }
    encoded
}

fn extract_claude_message(
    message: &Value,
    role: &str,
) -> Option<(String, Vec<ImportedTranscriptPart>)> {
    let mut warnings = Vec::new();
    extract_claude_message_with_warnings(message, role, &mut warnings, "Claude record")
}

fn extract_claude_message_with_warnings(
    message: &Value,
    role: &str,
    warnings: &mut Vec<String>,
    context: &str,
) -> Option<(String, Vec<ImportedTranscriptPart>)> {
    if !matches!(role, "user" | "assistant") {
        return None;
    }
    let parts = extract_content_parts_with_warnings(message.get("content")?, warnings, context);
    let content = parts_to_legacy_content(&parts)?;
    Some((content, parts))
}

fn semantic_claude_role<'a>(role: &'a str, parts: &[ImportedTranscriptPart]) -> &'a str {
    let is_tool_result = role == "user"
        && parts
            .iter()
            .any(|part| matches!(part, ImportedTranscriptPart::ToolResult { .. }))
        && !parts
            .iter()
            .any(|part| matches!(part, ImportedTranscriptPart::Text { .. }));
    if is_tool_result {
        "tool"
    } else {
        role
    }
}

fn extract_content_parts(content: &Value) -> Vec<ImportedTranscriptPart> {
    let mut warnings = Vec::new();
    extract_content_parts_with_warnings(content, &mut warnings, "message content")
}

fn extract_content_parts_with_warnings(
    content: &Value,
    warnings: &mut Vec<String>,
    context: &str,
) -> Vec<ImportedTranscriptPart> {
    if let Some(text) = content.as_str().and_then(normalized_message_text) {
        let mut value = Value::String(text);
        let mut media = Vec::new();
        sanitize_embedded_media(&mut value, &mut media, warnings, context);
        let mut parts = value
            .as_str()
            .and_then(normalized_message_text)
            .map(|text| vec![ImportedTranscriptPart::Text { text }])
            .unwrap_or_default();
        parts.extend(media);
        return parts;
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
                    let mut value = Value::String(text);
                    let mut media = Vec::new();
                    sanitize_embedded_media(&mut value, &mut media, warnings, context);
                    if let Some(text) = value.as_str().and_then(normalized_message_text) {
                        parts.push(ImportedTranscriptPart::Text { text });
                    }
                    parts.extend(media);
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
                        data: Value::Null,
                    });
                }
            }
            Some("image" | "input_image") => {
                parts.push(attachment_part_from_item(item, true, warnings, context));
            }
            Some(
                "attachment" | "document" | "file" | "input_file" | "audio" | "input_audio"
                | "video" | "input_video",
            ) => {
                parts.push(attachment_part_from_item(item, false, warnings, context));
            }
            Some("tool_use") => {
                let mut input = item.get("input").cloned().unwrap_or(Value::Null);
                let mut media = Vec::new();
                sanitize_embedded_media(&mut input, &mut media, warnings, context);
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
                    input,
                });
                parts.extend(media);
            }
            Some("tool_result") => {
                let mut output = item.get("content").cloned().unwrap_or(Value::Null);
                let mut media = Vec::new();
                sanitize_embedded_media(&mut output, &mut media, warnings, context);
                parts.push(ImportedTranscriptPart::ToolResult {
                    tool_call_id: item
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    output,
                    is_error: item
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                });
                parts.extend(media);
            }
            Some(kind) if looks_like_attachment_kind(kind) => {
                parts.push(attachment_part_from_item(item, false, warnings, context));
            }
            Some(kind) => {
                push_warning(
                    warnings,
                    format!("{context}: unknown content item type `{kind}` was preserved"),
                );
                let mut data = item.clone();
                let mut media = Vec::new();
                sanitize_embedded_media(&mut data, &mut media, warnings, context);
                parts.push(ImportedTranscriptPart::Event {
                    kind: kind.to_string(),
                    data,
                });
                parts.extend(media);
            }
            None => {
                if looks_like_attachment(item) {
                    parts.push(attachment_part_from_item(item, false, warnings, context));
                    continue;
                }
                push_warning(
                    warnings,
                    format!("{context}: unknown content item without a type was preserved"),
                );
                let mut data = item.clone();
                let mut media = Vec::new();
                sanitize_embedded_media(&mut data, &mut media, warnings, context);
                parts.push(ImportedTranscriptPart::Event {
                    kind: "unknown".to_string(),
                    data,
                });
                parts.extend(media);
            }
        }
    }
    parts
}

fn extract_thinking_parts(
    content: &Value,
    warnings: &mut Vec<String>,
    context: &str,
) -> Vec<ImportedTranscriptPart> {
    extract_content_parts_with_warnings(content, warnings, context)
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

fn sanitize_embedded_media(
    value: &mut Value,
    media: &mut Vec<ImportedTranscriptPart>,
    warnings: &mut Vec<String>,
    context: &str,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                sanitize_embedded_media(item, media, warnings, context);
            }
        }
        Value::Object(object) => {
            let is_base64 = object.get("type").and_then(Value::as_str) == Some("base64");
            if is_base64 {
                let media_type = object
                    .get("media_type")
                    .or_else(|| object.get("mediaType"))
                    .and_then(Value::as_str)
                    .unwrap_or("application/octet-stream");
                let name = attachment_name(&Value::Object(object.clone()));
                if let Some(data) = object.get("data").and_then(Value::as_str) {
                    let data_url = format!("data:{media_type};base64,{data}");
                    if let Some(part) =
                        media_part_from_data_url(&data_url, name, None, warnings, context)
                    {
                        push_media_part_unique(media, part);
                    }
                    if let Some(data) = object.get_mut("data") {
                        *data = Value::String("[Attachment data omitted]".to_string());
                    }
                }
            }
            for (key, nested) in object.iter_mut() {
                if !(is_base64 && key == "data") {
                    sanitize_embedded_media(nested, media, warnings, context);
                }
            }
        }
        Value::String(text) => {
            *text = sanitize_embedded_data_urls(text, media, warnings, context);
        }
        _ => {}
    }
}

fn attachment_part_from_item(
    item: &Value,
    image_hint: bool,
    warnings: &mut Vec<String>,
    context: &str,
) -> ImportedTranscriptPart {
    let name = attachment_name(item);
    let alt = item
        .get("alt")
        .and_then(Value::as_str)
        .and_then(normalized_message_text);
    let source = item.get("source").unwrap_or(item);
    let media_type = source
        .get("media_type")
        .or_else(|| source.get("mediaType"))
        .or_else(|| item.get("media_type"))
        .or_else(|| item.get("mediaType"))
        .or_else(|| item.get("mime_type"))
        .or_else(|| item.get("mimeType"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| image_hint.then(|| "image/*".to_string()));

    let source_type = source.get("type").and_then(Value::as_str);
    let direct_value = item
        .get("image_url")
        .or_else(|| item.get("file_url"))
        .or_else(|| item.get("fileUrl"))
        .or_else(|| item.get("file_data"))
        .or_else(|| item.get("fileData"))
        .or_else(|| item.get("audio_url"))
        .or_else(|| item.get("audioUrl"))
        .or_else(|| item.get("video_url"))
        .or_else(|| item.get("videoUrl"))
        .or_else(|| item.get("data_url"))
        .or_else(|| item.get("dataUrl"))
        .or_else(|| item.get("url"))
        .or_else(|| source.get("url"));

    if source_type == Some("base64") {
        if let Some(data) = source.get("data").and_then(Value::as_str) {
            let mime = media_type.as_deref().unwrap_or(if image_hint {
                "image/png"
            } else {
                "application/octet-stream"
            });
            let data_url = format!("data:{mime};base64,{data}");
            if let Some(part) =
                media_part_from_data_url(&data_url, name.clone(), alt, warnings, context)
            {
                return part;
            }
        } else {
            push_warning(
                warnings,
                format!("{context}: base64 attachment is missing data"),
            );
        }
    } else if let Some(data) = source
        .get("data")
        .and_then(Value::as_str)
        .filter(|_| media_type.is_some())
    {
        let mime = media_type.as_deref().unwrap_or("application/octet-stream");
        let data_url = format!("data:{mime};base64,{data}");
        if let Some(part) =
            media_part_from_data_url(&data_url, name.clone(), alt, warnings, context)
        {
            return part;
        }
    } else if let Some(value) = direct_value.and_then(Value::as_str) {
        let value = value.trim();
        if value.starts_with("data:") {
            if let Some(part) =
                media_part_from_data_url(value, name.clone(), alt, warnings, context)
            {
                return part;
            }
        } else if is_remote_url(value) {
            return ImportedTranscriptPart::Attachment {
                name,
                media_type,
                data_url: None,
                asset_id: None,
                url: Some(value.to_string()),
            };
        } else if !value.is_empty() {
            push_warning(
                warnings,
                format!("{context}: attachment URL is not an HTTP(S) URL"),
            );
        }
    } else if source_type.is_some() && source_type != Some("url") {
        push_warning(
            warnings,
            format!(
                "{context}: unsupported attachment source type `{}`",
                source_type.unwrap_or_default()
            ),
        );
    } else {
        push_warning(
            warnings,
            format!("{context}: attachment has no supported data or URL"),
        );
    }

    ImportedTranscriptPart::Attachment {
        name,
        media_type,
        data_url: None,
        asset_id: None,
        url: None,
    }
}

fn attachment_name(item: &Value) -> Option<String> {
    item.get("name")
        .or_else(|| item.get("file_name"))
        .or_else(|| item.get("fileName"))
        .or_else(|| item.get("filename"))
        .or_else(|| item.get("title"))
        .and_then(Value::as_str)
        .and_then(normalized_message_text)
}

fn looks_like_attachment_kind(kind: &str) -> bool {
    let kind = kind.to_ascii_lowercase();
    kind.contains("attachment")
        || kind.contains("document")
        || kind.contains("file")
        || kind.contains("audio")
        || kind.contains("video")
}

fn looks_like_attachment(item: &Value) -> bool {
    item.get("source").is_some()
        && (attachment_name(item).is_some()
            || item.get("media_type").is_some()
            || item.get("mediaType").is_some()
            || item.get("mime_type").is_some()
            || item.get("mimeType").is_some())
}

fn media_part_from_data_url(
    data_url: &str,
    name: Option<String>,
    alt: Option<String>,
    warnings: &mut Vec<String>,
    context: &str,
) -> Option<ImportedTranscriptPart> {
    let Some((media_type, payload)) = parse_base64_data_url(data_url) else {
        push_warning(
            warnings,
            format!("{context}: attachment data URL is invalid or is not base64"),
        );
        return None;
    };
    if let Err(reason) = validate_base64_payload(payload) {
        push_warning(
            warnings,
            format!("{context}: invalid base64 attachment data ({reason})"),
        );
        return None;
    }
    if media_type.to_ascii_lowercase().starts_with("image/") {
        Some(ImportedTranscriptPart::Image {
            data_url: Some(data_url.to_string()),
            asset_id: None,
            alt: alt.or(name),
        })
    } else {
        Some(ImportedTranscriptPart::Attachment {
            name,
            media_type: Some(media_type.to_string()),
            data_url: Some(data_url.to_string()),
            asset_id: None,
            url: None,
        })
    }
}

fn parse_base64_data_url(value: &str) -> Option<(&str, &str)> {
    let value = value.strip_prefix("data:")?;
    let (header, payload) = value.split_once(',')?;
    let (media_type, parameters) = header.split_once(';')?;
    if !is_valid_media_type(media_type)
        || !parameters
            .split(';')
            .any(|parameter| parameter.eq_ignore_ascii_case("base64"))
    {
        return None;
    }
    Some((media_type, payload))
}

fn validate_base64_payload(payload: &str) -> Result<usize, &'static str> {
    validate_base64_payload_with_limit(payload, MAX_ATTACHMENT_BYTES)
}

fn validate_base64_payload_with_limit(
    payload: &str,
    max_bytes: usize,
) -> Result<usize, &'static str> {
    if payload.is_empty() {
        return Err("empty payload");
    }
    if !payload.is_ascii() {
        return Err("non-ASCII payload");
    }
    let bytes = payload.as_bytes();
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    if padding > 2
        || bytes[..bytes.len().saturating_sub(padding)]
            .iter()
            .any(|byte| !byte.is_ascii_alphanumeric() && *byte != b'+' && *byte != b'/')
        || bytes[..bytes.len().saturating_sub(padding)].contains(&b'=')
    {
        return Err("invalid alphabet or padding");
    }
    if padding > 0 && bytes.len() % 4 != 0 {
        return Err("invalid padded length");
    }
    let remainder = bytes.len().saturating_sub(padding) % 4;
    if remainder == 1 {
        return Err("invalid length");
    }
    let decoded_size = bytes.len().saturating_sub(padding) / 4 * 3
        + match remainder {
            2 => 1,
            3 => 2,
            _ => 0,
        };
    if decoded_size > max_bytes {
        return Err("payload exceeds size limit");
    }
    Ok(decoded_size)
}

fn is_valid_media_type(media_type: &str) -> bool {
    let Some((category, subtype)) = media_type.split_once('/') else {
        return false;
    };
    !category.is_empty()
        && !subtype.is_empty()
        && category.bytes().chain(subtype.bytes()).all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                )
        })
}

fn sanitize_embedded_data_urls(
    text: &str,
    media: &mut Vec<ImportedTranscriptPart>,
    warnings: &mut Vec<String>,
    context: &str,
) -> String {
    let mut result = String::with_capacity(text.len());
    let mut offset = 0;
    while let Some(relative_start) = text[offset..].find("data:") {
        let start = offset + relative_start;
        result.push_str(&text[offset..start]);
        let Some(relative_comma) = text[start..].find(',') else {
            result.push_str(&text[start..]);
            return result;
        };
        let comma = start + relative_comma;
        let header = &text[start..=comma];
        if !header.to_ascii_lowercase().contains(";base64,") {
            result.push_str("data:");
            offset = start + "data:".len();
            continue;
        }
        let payload_start = comma + 1;
        let payload_len = text[payload_start..]
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
            .count();
        let end = payload_start + payload_len;
        let candidate = &text[start..end];
        if let Some(part) = media_part_from_data_url(candidate, None, None, warnings, context) {
            let placeholder = if matches!(part, ImportedTranscriptPart::Image { .. }) {
                "[Image data omitted]"
            } else {
                "[Attachment data omitted]"
            };
            push_media_part_unique(media, part);
            result.push_str(placeholder);
        } else {
            result.push_str("[Invalid attachment data omitted]");
        }
        offset = end.max(payload_start);
    }
    result.push_str(&text[offset..]);
    result
}

fn push_media_part_unique(media: &mut Vec<ImportedTranscriptPart>, part: ImportedTranscriptPart) {
    let duplicate = media.iter().any(|existing| match (existing, &part) {
        (
            ImportedTranscriptPart::Image {
                data_url: first, ..
            },
            ImportedTranscriptPart::Image {
                data_url: second, ..
            },
        ) => first == second,
        (
            ImportedTranscriptPart::Attachment {
                data_url: first_data,
                url: first_url,
                ..
            },
            ImportedTranscriptPart::Attachment {
                data_url: second_data,
                url: second_url,
                ..
            },
        ) => first_data == second_data && first_url == second_url,
        _ => false,
    });
    if !duplicate {
        media.push(part);
    }
}

fn is_remote_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

fn push_warning(warnings: &mut Vec<String>, warning: String) {
    if warnings.contains(&warning) {
        return;
    }
    if warnings.len() + 1 < MAX_IMPORT_WARNINGS {
        warnings.push(warning);
    } else if warnings.len() + 1 == MAX_IMPORT_WARNINGS {
        warnings.push("Additional import warnings were omitted".to_string());
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
            ImportedTranscriptPart::Attachment { name, .. } => values.push(
                name.as_ref()
                    .map(|name| format!("[Attachment: {name}]"))
                    .unwrap_or_else(|| "[Attachment]".to_string()),
            ),
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
    message
        .source_message_id
        .as_deref()
        .map(|source_id| {
            source_message_fingerprint(
                message.source_kind,
                source_id,
                &message.role,
                message_part_kind(&message.parts),
            )
        })
        .unwrap_or_else(|| {
            message_fingerprint(
                message.source_kind,
                &message.role,
                message.timestamp,
                &message.content,
                &message.parts,
            )
        })
}

fn message_part_kind(parts: &[ImportedTranscriptPart]) -> &'static str {
    if parts
        .iter()
        .any(|part| matches!(part, ImportedTranscriptPart::ToolCall { .. }))
    {
        "tool-call"
    } else if parts
        .iter()
        .any(|part| matches!(part, ImportedTranscriptPart::ToolResult { .. }))
    {
        "tool-result"
    } else if parts
        .iter()
        .any(|part| matches!(part, ImportedTranscriptPart::Event { .. }))
    {
        "event"
    } else {
        "message"
    }
}

fn source_message_fingerprint(
    source_kind: &str,
    source_id: &str,
    role: &str,
    part_kind: &str,
) -> String {
    let mut hasher = Sha256::new();
    update_fingerprint_field(&mut hasher, b"source-kind", source_kind.as_bytes());
    update_fingerprint_field(&mut hasher, b"source-id", source_id.as_bytes());
    update_fingerprint_field(&mut hasher, b"role", role.as_bytes());
    update_fingerprint_field(&mut hasher, b"part-kind", part_kind.as_bytes());
    hex::encode(hasher.finalize())
}

fn update_fingerprint_field(hasher: &mut Sha256, tag: &[u8], value: &[u8]) {
    hasher.update((tag.len() as u64).to_le_bytes());
    hasher.update(tag);
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn update_optional_fingerprint(hasher: &mut Sha256, tag: &[u8], value: Option<&str>) {
    match value {
        Some(value) => update_fingerprint_field(hasher, tag, value.as_bytes()),
        None => update_fingerprint_field(hasher, tag, b""),
    }
}

fn update_json_fingerprint(hasher: &mut Sha256, value: &Value) {
    match value {
        Value::Null => update_fingerprint_field(hasher, b"json", b"null"),
        Value::Bool(value) => {
            update_fingerprint_field(hasher, b"bool", if *value { b"1" } else { b"0" })
        }
        Value::Number(value) => {
            update_fingerprint_field(hasher, b"number", value.to_string().as_bytes())
        }
        Value::String(value) => update_fingerprint_field(hasher, b"string", value.as_bytes()),
        Value::Array(items) => {
            update_fingerprint_field(hasher, b"array-len", &(items.len() as u64).to_le_bytes());
            for item in items {
                update_json_fingerprint(hasher, item);
            }
        }
        Value::Object(object) => {
            update_fingerprint_field(hasher, b"object-len", &(object.len() as u64).to_le_bytes());
            for (key, value) in object {
                update_fingerprint_field(hasher, b"key", key.as_bytes());
                update_json_fingerprint(hasher, value);
            }
        }
    }
}

fn media_fingerprint_id(data_url: Option<&str>, asset_id: Option<&str>) -> Option<String> {
    asset_id
        .map(ToString::to_string)
        .or_else(|| data_url.map(asset_id_for_data_url))
}

fn update_parts_fingerprint(hasher: &mut Sha256, parts: &[ImportedTranscriptPart]) {
    update_fingerprint_field(hasher, b"parts-len", &(parts.len() as u64).to_le_bytes());
    for part in parts {
        match part {
            ImportedTranscriptPart::Text { text } => {
                update_fingerprint_field(hasher, b"text", text.as_bytes())
            }
            ImportedTranscriptPart::Thinking { text } => {
                update_fingerprint_field(hasher, b"thinking", text.as_bytes())
            }
            ImportedTranscriptPart::Image {
                data_url,
                asset_id,
                alt,
            } => {
                update_optional_fingerprint(
                    hasher,
                    b"image-asset",
                    media_fingerprint_id(data_url.as_deref(), asset_id.as_deref()).as_deref(),
                );
                update_optional_fingerprint(hasher, b"image-alt", alt.as_deref());
            }
            ImportedTranscriptPart::Attachment {
                name,
                media_type,
                data_url,
                asset_id,
                url,
            } => {
                update_optional_fingerprint(hasher, b"attachment-name", name.as_deref());
                update_optional_fingerprint(hasher, b"attachment-mime", media_type.as_deref());
                update_optional_fingerprint(
                    hasher,
                    b"attachment-asset",
                    media_fingerprint_id(data_url.as_deref(), asset_id.as_deref()).as_deref(),
                );
                update_optional_fingerprint(hasher, b"attachment-url", url.as_deref());
            }
            ImportedTranscriptPart::ToolCall {
                tool_call_id,
                name,
                input,
            } => {
                update_optional_fingerprint(hasher, b"tool-call-id", tool_call_id.as_deref());
                update_fingerprint_field(hasher, b"tool-name", name.as_bytes());
                update_json_fingerprint(hasher, input);
            }
            ImportedTranscriptPart::ToolResult {
                tool_call_id,
                output,
                is_error,
            } => {
                update_optional_fingerprint(hasher, b"tool-result-id", tool_call_id.as_deref());
                update_fingerprint_field(
                    hasher,
                    b"tool-result-error",
                    if *is_error { b"1" } else { b"0" },
                );
                update_json_fingerprint(hasher, output);
            }
            ImportedTranscriptPart::Event { kind, data } => {
                update_fingerprint_field(hasher, b"event-kind", kind.as_bytes());
                update_json_fingerprint(hasher, data);
            }
        }
    }
}

fn message_fingerprint(
    source_kind: &str,
    role: &str,
    timestamp: i64,
    content: &str,
    parts: &[ImportedTranscriptPart],
) -> String {
    let mut hasher = Sha256::new();
    update_fingerprint_field(&mut hasher, b"source-kind", source_kind.as_bytes());
    update_fingerprint_field(&mut hasher, b"role", role.as_bytes());
    update_fingerprint_field(&mut hasher, b"timestamp", &timestamp.to_le_bytes());
    if parts.is_empty() {
        update_fingerprint_field(&mut hasher, b"content", content.as_bytes());
    }
    update_parts_fingerprint(&mut hasher, parts);
    hex::encode(hasher.finalize())
}

fn imported_message_fingerprint(source_kind: &str, message: &ImportedTranscriptMessage) -> String {
    message_fingerprint(
        source_kind,
        &message.role,
        message.timestamp,
        &message.content,
        &message.parts,
    )
}

fn align_imported_message_ids(
    existing: &ImportedConversation,
    incoming: &mut ImportedConversation,
) {
    let mut existing_ids: HashMap<String, Vec<String>> = HashMap::new();
    for message in &existing.messages {
        existing_ids
            .entry(imported_message_fingerprint(&existing.source, message))
            .or_default()
            .push(message.id.clone());
    }
    let mut consumed: HashMap<String, usize> = HashMap::new();
    for message in &mut incoming.messages {
        let fingerprint = imported_message_fingerprint(&incoming.source, message);
        let index = consumed.entry(fingerprint.clone()).or_default();
        if let Some(existing_id) = existing_ids
            .get(&fingerprint)
            .and_then(|ids| ids.get(*index))
        {
            message.id = existing_id.clone();
            *index += 1;
        }
    }
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
    let mut occurrences: HashMap<String, usize> = HashMap::new();
    let mut active_turn_id: Option<String> = None;
    messages
        .into_iter()
        .map(|mut message| {
            if message.is_user_prompt {
                let turn_id = message
                    .source_turn_id
                    .clone()
                    .or_else(|| message.source_message_id.clone())
                    .unwrap_or_else(|| message_dedupe_key(&message));
                message.source_turn_id = Some(turn_id.clone());
                active_turn_id = Some(turn_id);
            } else if message.source_turn_id.is_none() {
                message.source_turn_id = active_turn_id.clone();
            }
            let fingerprint = message_dedupe_key(&message);
            let occurrence = occurrences.entry(fingerprint.clone()).or_default();
            let id = if *occurrence == 0 {
                format!("{native_session_id}:{fingerprint}")
            } else {
                format!("{native_session_id}:{fingerprint}:{occurrence}")
            };
            *occurrence += 1;
            ImportedTranscriptMessage {
                id,
                role: message.role,
                is_user_prompt: Some(message.is_user_prompt),
                source_turn_id: message.source_turn_id,
                content: message.content,
                parts: message.parts,
                timestamp: message.timestamp,
            }
        })
        .collect()
}

fn read_codex_index(path: &Path, warnings: &mut Vec<String>) -> HashMap<String, (String, i64)> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return HashMap::new(),
        Err(error) => {
            push_warning(
                warnings,
                format!(
                    "Could not read Codex session index {}: {error}",
                    path.display()
                ),
            );
            return HashMap::new();
        }
    };
    let mut index = HashMap::new();
    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                push_warning(
                    warnings,
                    format!(
                        "Could not read Codex session index line {}:{}: {error}",
                        path.display(),
                        line_index + 1
                    ),
                );
                continue;
            }
        };
        let record = match serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}')) {
            Ok(record) => record,
            Err(error) => {
                push_warning(
                    warnings,
                    format!(
                        "Codex session index contains invalid JSON at {}:{}: {error}",
                        path.display(),
                        line_index + 1
                    ),
                );
                continue;
            }
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

fn imported_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create app data directory: {error}"))?;
    Ok(dir)
}

fn lock_imported_store() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    IMPORTED_STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|error| format!("Imported conversations store lock failed: {error}"))
}

fn with_imported_store<T>(
    app: &AppHandle,
    action: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let config_dir = imported_config_dir(app)?;
    let _guard = lock_imported_store()?;
    action(&config_dir)
}

fn legacy_store_path(config_dir: &Path) -> PathBuf {
    config_dir.join(LEGACY_STORE_FILE)
}

fn v3_store_path(config_dir: &Path) -> PathBuf {
    config_dir.join(STORE_DIRECTORY)
}

fn v3_index_path(config_dir: &Path) -> PathBuf {
    v3_store_path(config_dir).join(STORE_INDEX_FILE)
}

fn item_path_in_store(store_dir: &Path, id: &str) -> PathBuf {
    let file_name = format!("{}.json", hex::encode(Sha256::digest(id.as_bytes())));
    store_dir.join(STORE_ITEMS_DIRECTORY).join(file_name)
}

fn v3_item_path(config_dir: &Path, id: &str) -> PathBuf {
    item_path_in_store(&v3_store_path(config_dir), id)
}

fn asset_path_in_store(store_dir: &Path, asset_id: &str) -> PathBuf {
    store_dir
        .join(STORE_ASSETS_DIRECTORY)
        .join(format!("{asset_id}.txt"))
}

fn normalize_asset_id(asset_id: &str) -> Result<String, String> {
    if asset_id.len() != 64 || !asset_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Imported asset id must be exactly 64 hexadecimal characters".to_string());
    }
    Ok(asset_id.to_ascii_lowercase())
}

fn asset_id_for_data_url(data_url: &str) -> String {
    hex::encode(Sha256::digest(data_url.as_bytes()))
}

fn validate_asset_data_url(data_url: &str) -> Result<(), String> {
    if data_url.len() > MAX_ASSET_FILE_BYTES {
        return Err("Imported asset exceeds the maximum file size".to_string());
    }
    let (_, payload) = parse_base64_data_url(data_url)
        .ok_or_else(|| "Imported asset is not a valid base64 data URL".to_string())?;
    validate_base64_payload(payload)
        .map_err(|reason| format!("Imported asset base64 data is invalid: {reason}"))?;
    Ok(())
}

fn write_asset_to_store(store_dir: &Path, data_url: &str) -> Result<String, String> {
    validate_asset_data_url(data_url)?;
    let asset_id = asset_id_for_data_url(data_url);
    let path = asset_path_in_store(store_dir, &asset_id);
    if path.is_file() {
        let existing = load_asset_from_store(store_dir, &asset_id)?;
        if existing != data_url {
            return Err("Imported asset hash collision was detected".to_string());
        }
        return Ok(asset_id);
    }
    fs::create_dir_all(store_dir.join(STORE_ASSETS_DIRECTORY))
        .map_err(|error| format!("Could not create imported asset directory: {error}"))?;
    let temporary = path.with_extension("txt.tmp");
    fs::write(&temporary, data_url.as_bytes())
        .map_err(|error| format!("Could not save imported asset: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not finalize imported asset: {error}"))?;
    Ok(asset_id)
}

fn load_asset_from_store(store_dir: &Path, asset_id: &str) -> Result<String, String> {
    let asset_id = normalize_asset_id(asset_id)?;
    let path = asset_path_in_store(store_dir, &asset_id);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Could not read imported asset metadata: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Imported asset path is not a regular file".to_string());
    }
    if metadata.len() > MAX_ASSET_FILE_BYTES as u64 {
        return Err("Imported asset exceeds the maximum file size".to_string());
    }
    let data_url = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read imported asset: {error}"))?;
    validate_asset_data_url(&data_url)?;
    if asset_id_for_data_url(&data_url) != asset_id {
        return Err("Imported asset content does not match its id".to_string());
    }
    Ok(data_url)
}

fn load_imported_asset_at(config_dir: &Path, asset_id: &str) -> Result<String, String> {
    let asset_id = normalize_asset_id(asset_id)?;
    let index = load_v3_index_at(config_dir)?;
    if !index
        .asset_references
        .values()
        .flatten()
        .any(|referenced| referenced.eq_ignore_ascii_case(&asset_id))
    {
        return Err("Imported asset is not referenced by any conversation".to_string());
    }
    load_asset_from_store(&v3_store_path(config_dir), &asset_id)
}

fn load_legacy_file_at(config_dir: &Path) -> Result<ImportedConversationsFile, String> {
    let path = legacy_store_path(config_dir);
    if !path.exists() {
        return Ok(ImportedConversationsFile::default());
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Could not read imported conversations: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Imported conversations file is invalid: {error}"))
}

fn normalize_conversation_embedded_media(conversation: &mut ImportedConversation) {
    for message in &mut conversation.messages {
        let mut normalized = Vec::with_capacity(message.parts.len());
        for part in std::mem::take(&mut message.parts) {
            let mut media = Vec::new();
            let part = match part {
                ImportedTranscriptPart::Text { text } => {
                    let mut value = Value::String(text);
                    let mut warnings = Vec::new();
                    sanitize_embedded_media(&mut value, &mut media, &mut warnings, "stored text");
                    ImportedTranscriptPart::Text {
                        text: value.as_str().unwrap_or_default().to_string(),
                    }
                }
                ImportedTranscriptPart::Thinking { text } => {
                    let mut value = Value::String(text);
                    let mut warnings = Vec::new();
                    sanitize_embedded_media(
                        &mut value,
                        &mut media,
                        &mut warnings,
                        "stored thinking",
                    );
                    ImportedTranscriptPart::Thinking {
                        text: value.as_str().unwrap_or_default().to_string(),
                    }
                }
                ImportedTranscriptPart::ToolCall {
                    tool_call_id,
                    name,
                    mut input,
                } => {
                    let mut warnings = Vec::new();
                    sanitize_embedded_media(
                        &mut input,
                        &mut media,
                        &mut warnings,
                        "stored tool call",
                    );
                    ImportedTranscriptPart::ToolCall {
                        tool_call_id,
                        name,
                        input,
                    }
                }
                ImportedTranscriptPart::ToolResult {
                    tool_call_id,
                    mut output,
                    is_error,
                } => {
                    let mut warnings = Vec::new();
                    sanitize_embedded_media(
                        &mut output,
                        &mut media,
                        &mut warnings,
                        "stored tool result",
                    );
                    ImportedTranscriptPart::ToolResult {
                        tool_call_id,
                        output,
                        is_error,
                    }
                }
                ImportedTranscriptPart::Event { kind, mut data } => {
                    let mut warnings = Vec::new();
                    sanitize_embedded_media(&mut data, &mut media, &mut warnings, "stored event");
                    ImportedTranscriptPart::Event { kind, data }
                }
                other => other,
            };
            normalized.push(part);
            normalized.extend(media);
        }
        message.parts = normalized;
        if let Some(content) = parts_to_legacy_content(&message.parts) {
            message.content = content;
        }
    }
}

fn prepare_conversation_for_store(
    target_store: &Path,
    source_store: Option<&Path>,
    conversation: &ImportedConversation,
) -> Result<ImportedConversation, String> {
    let mut stored = conversation.clone();
    normalize_conversation_embedded_media(&mut stored);
    for message in &mut stored.messages {
        for part in &mut message.parts {
            match part {
                ImportedTranscriptPart::Image {
                    data_url, asset_id, ..
                }
                | ImportedTranscriptPart::Attachment {
                    data_url, asset_id, ..
                } => {
                    let resolved = if let Some(data_url) = data_url.take() {
                        write_asset_to_store(target_store, &data_url)?
                    } else if let Some(existing_id) = asset_id.as_deref() {
                        let data_url = load_asset_from_store(
                            source_store.unwrap_or(target_store),
                            existing_id,
                        )?;
                        write_asset_to_store(target_store, &data_url)?
                    } else {
                        continue;
                    };
                    *asset_id = Some(resolved);
                }
                _ => {}
            }
        }
    }
    Ok(stored)
}

fn referenced_asset_ids(conversation: &ImportedConversation) -> Result<HashSet<String>, String> {
    let mut referenced = HashSet::new();
    for message in &conversation.messages {
        for part in &message.parts {
            let asset_id = match part {
                ImportedTranscriptPart::Image { asset_id, .. }
                | ImportedTranscriptPart::Attachment { asset_id, .. } => asset_id.as_deref(),
                _ => None,
            };
            if let Some(asset_id) = asset_id {
                referenced.insert(normalize_asset_id(asset_id)?);
            }
        }
    }
    Ok(referenced)
}

fn asset_reference_list(conversation: &ImportedConversation) -> Result<Vec<String>, String> {
    let mut assets = referenced_asset_ids(conversation)?
        .into_iter()
        .collect::<Vec<_>>();
    assets.sort();
    Ok(assets)
}

fn install_v3_store_at(
    config_dir: &Path,
    conversations: &[ImportedConversation],
) -> Result<(), String> {
    fs::create_dir_all(config_dir)
        .map_err(|error| format!("Could not create app data directory: {error}"))?;
    let store_dir = v3_store_path(config_dir);
    if store_dir.exists() {
        return Err("Imported conversations v3 store already exists without an index".to_string());
    }

    let staging_dir = config_dir.join(STORE_STAGING_DIRECTORY);
    if staging_dir.exists() {
        if staging_dir.is_dir() {
            fs::remove_dir_all(&staging_dir).map_err(|error| {
                format!("Could not clear imported conversations staging directory: {error}")
            })?;
        } else {
            fs::remove_file(&staging_dir).map_err(|error| {
                format!("Could not clear imported conversations staging file: {error}")
            })?;
        }
    }
    fs::create_dir_all(staging_dir.join(STORE_ITEMS_DIRECTORY))
        .map_err(|error| format!("Could not create imported conversations store: {error}"))?;
    fs::create_dir_all(staging_dir.join(STORE_ASSETS_DIRECTORY))
        .map_err(|error| format!("Could not create imported asset store: {error}"))?;

    let mut summaries = Vec::with_capacity(conversations.len());
    let mut asset_references = HashMap::new();
    for conversation in conversations {
        let stored = prepare_conversation_for_store(&staging_dir, None, conversation)?;
        let bytes = serde_json::to_vec(&stored)
            .map_err(|error| format!("Could not serialize imported conversation: {error}"))?;
        fs::write(item_path_in_store(&staging_dir, &conversation.id), bytes)
            .map_err(|error| format!("Could not save imported conversation: {error}"))?;
        summaries.push(to_summary(&stored));
        asset_references.insert(stored.id.clone(), asset_reference_list(&stored)?);
    }
    sort_summaries(&mut summaries);
    let index = ImportedConversationsIndex {
        version: STORE_VERSION,
        conversations: summaries,
        asset_references,
    };
    let index_bytes = serde_json::to_vec(&index)
        .map_err(|error| format!("Could not serialize imported conversations index: {error}"))?;
    fs::write(staging_dir.join(STORE_INDEX_FILE), index_bytes)
        .map_err(|error| format!("Could not save imported conversations index: {error}"))?;

    fs::rename(&staging_dir, &store_dir)
        .map_err(|error| format!("Could not install imported conversations store: {error}"))?;
    Ok(())
}

fn read_index_from_store(store_dir: &Path) -> Result<ImportedConversationsIndex, String> {
    let bytes = fs::read(store_dir.join(STORE_INDEX_FILE))
        .map_err(|error| format!("Could not read imported conversations index: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Imported conversations index is invalid: {error}"))
}

fn validate_v4_store_at(store_dir: &Path) -> Result<ImportedConversationsIndex, String> {
    let index = read_index_from_store(store_dir)?;
    if index.version != STORE_VERSION {
        return Err(format!(
            "Unsupported imported conversations index version: {}",
            index.version
        ));
    }
    for summary in &index.conversations {
        let bytes = fs::read(item_path_in_store(store_dir, &summary.id))
            .map_err(|error| format!("Could not read imported conversation: {error}"))?;
        let conversation: ImportedConversation = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Imported conversation is invalid: {error}"))?;
        if conversation.id != summary.id {
            return Err("Imported conversation id does not match its index entry".to_string());
        }
        for message in &conversation.messages {
            for part in &message.parts {
                match part {
                    ImportedTranscriptPart::Image {
                        data_url, asset_id, ..
                    }
                    | ImportedTranscriptPart::Attachment {
                        data_url, asset_id, ..
                    } => {
                        if data_url.is_some() {
                            return Err(
                                "Imported v4 conversation still contains inline asset data"
                                    .to_string(),
                            );
                        }
                        if let Some(asset_id) = asset_id {
                            load_asset_from_store(store_dir, asset_id)?;
                        }
                    }
                    _ => {}
                }
            }
        }
        if index.asset_references.get(&conversation.id)
            != Some(&asset_reference_list(&conversation)?)
        {
            return Err(
                "Imported asset reference index does not match its conversation".to_string(),
            );
        }
    }
    Ok(index)
}

fn migrate_v3_store_to_v4_at(config_dir: &Path) -> Result<(), String> {
    let store_dir = v3_store_path(config_dir);
    let v3_index = read_index_from_store(&store_dir)?;
    if v3_index.version != 3 {
        return Err(format!(
            "Cannot migrate imported conversations version {} as v3",
            v3_index.version
        ));
    }
    let staging_dir = config_dir.join(STORE_STAGING_DIRECTORY);
    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir).map_err(|error| {
            format!("Could not clear imported conversations staging directory: {error}")
        })?;
    }
    fs::create_dir_all(staging_dir.join(STORE_ITEMS_DIRECTORY))
        .map_err(|error| format!("Could not create imported conversations store: {error}"))?;
    fs::create_dir_all(staging_dir.join(STORE_ASSETS_DIRECTORY))
        .map_err(|error| format!("Could not create imported asset store: {error}"))?;

    let migration_result = (|| {
        let mut summaries = Vec::with_capacity(v3_index.conversations.len());
        let mut asset_references = HashMap::new();
        for summary in &v3_index.conversations {
            let bytes = fs::read(item_path_in_store(&store_dir, &summary.id))
                .map_err(|error| format!("Could not read v3 imported conversation: {error}"))?;
            let conversation: ImportedConversation = serde_json::from_slice(&bytes)
                .map_err(|error| format!("Imported v3 conversation is invalid: {error}"))?;
            if conversation.id != summary.id {
                return Err(
                    "Imported v3 conversation id does not match its index entry".to_string()
                );
            }
            let stored =
                prepare_conversation_for_store(&staging_dir, Some(&store_dir), &conversation)?;
            fs::write(
                item_path_in_store(&staging_dir, &stored.id),
                serde_json::to_vec(&stored)
                    .map_err(|error| format!("Could not serialize v4 conversation: {error}"))?,
            )
            .map_err(|error| format!("Could not save v4 conversation: {error}"))?;
            summaries.push(to_summary(&stored));
            asset_references.insert(stored.id.clone(), asset_reference_list(&stored)?);
        }
        sort_summaries(&mut summaries);
        let index = ImportedConversationsIndex {
            version: STORE_VERSION,
            conversations: summaries,
            asset_references,
        };
        fs::write(
            staging_dir.join(STORE_INDEX_FILE),
            serde_json::to_vec(&index)
                .map_err(|error| format!("Could not serialize v4 index: {error}"))?,
        )
        .map_err(|error| format!("Could not save v4 index: {error}"))?;
        validate_v4_store_at(&staging_dir)?;
        Ok(())
    })();
    if let Err(error) = migration_result {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }

    let backup_dir = config_dir.join(STORE_BACKUP_DIRECTORY);
    if backup_dir.exists() {
        fs::remove_dir_all(&backup_dir)
            .map_err(|error| format!("Could not clear imported store backup: {error}"))?;
    }
    fs::rename(&store_dir, &backup_dir)
        .map_err(|error| format!("Could not back up v3 imported store: {error}"))?;
    if let Err(error) = fs::rename(&staging_dir, &store_dir) {
        let _ = fs::rename(&backup_dir, &store_dir);
        return Err(format!("Could not install v4 imported store: {error}"));
    }
    if let Err(error) = validate_v4_store_at(&store_dir) {
        let _ = fs::remove_dir_all(&store_dir);
        let rollback = fs::rename(&backup_dir, &store_dir);
        return match rollback {
            Ok(()) => Err(format!("{error}; v3 store was restored")),
            Err(rollback_error) => Err(format!(
                "{error}; v3 store could not be restored: {rollback_error}"
            )),
        };
    }
    let _ = fs::remove_dir_all(backup_dir);
    Ok(())
}

fn ensure_v3_store_at(config_dir: &Path) -> Result<bool, String> {
    let store_dir = v3_store_path(config_dir);
    let backup_dir = config_dir.join(STORE_BACKUP_DIRECTORY);
    if !store_dir.exists() && backup_dir.exists() {
        fs::rename(&backup_dir, &store_dir)
            .map_err(|error| format!("Could not restore imported store backup: {error}"))?;
    }
    let index_path = v3_index_path(config_dir);
    if index_path.is_file() {
        let index = read_index_from_store(&store_dir)?;
        return match index.version {
            STORE_VERSION => Ok(false),
            3 => {
                migrate_v3_store_to_v4_at(config_dir)?;
                Ok(false)
            }
            version => Err(format!(
                "Unsupported imported conversations index version: {version}"
            )),
        };
    }
    if store_dir.exists() {
        return Err("Imported conversations v3 store is incomplete".to_string());
    }
    let legacy = load_legacy_file_at(config_dir)?;
    install_v3_store_at(config_dir, &legacy.conversations)?;
    Ok(true)
}

fn load_v3_index_at(config_dir: &Path) -> Result<ImportedConversationsIndex, String> {
    let migrated = ensure_v3_store_at(config_dir)?;
    let index_result = (|| {
        let bytes = fs::read(v3_index_path(config_dir))
            .map_err(|error| format!("Could not read imported conversations index: {error}"))?;
        let index: ImportedConversationsIndex = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Imported conversations index is invalid: {error}"))?;
        if index.version != STORE_VERSION {
            return Err(format!(
                "Unsupported imported conversations index version: {}",
                index.version
            ));
        }
        Ok(index)
    })();
    let index = match index_result {
        Ok(index) => index,
        Err(error) if migrated => {
            let rollback = fs::remove_dir_all(v3_store_path(config_dir));
            return match rollback {
                Ok(()) => Err(format!("{error}; v3 migration was rolled back")),
                Err(rollback_error) => Err(format!(
                    "{error}; the failed v3 migration could not be rolled back: {rollback_error}"
                )),
            };
        }
        Err(error) => return Err(error),
    };

    let legacy_path = legacy_store_path(config_dir);
    if legacy_path.exists() {
        if let Err(error) = fs::remove_file(&legacy_path) {
            if migrated {
                let rollback = fs::remove_dir_all(v3_store_path(config_dir));
                return match rollback {
                    Ok(()) => Err(format!(
                        "Could not remove the migrated legacy conversations file; v3 migration was rolled back: {error}"
                    )),
                    Err(rollback_error) => Err(format!(
                        "Could not remove the migrated legacy conversations file ({error}) or roll back the v3 store ({rollback_error})"
                    )),
                };
            }
            return Err(format!(
                "The v3 conversations store is valid, but the legacy copy could not be removed: {error}"
            ));
        }
    }
    let backup_dir = config_dir.join(STORE_BACKUP_DIRECTORY);
    if backup_dir.exists() {
        validate_v4_store_at(&v3_store_path(config_dir))?;
        fs::remove_dir_all(&backup_dir)
            .map_err(|error| format!("Could not remove imported store backup: {error}"))?;
    }
    Ok(index)
}

fn save_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("Could not serialize imported conversation data: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not save imported conversation data: {error}"))?;
    replace_file(&temporary, path)
}

fn upsert_imported_conversations_at(
    config_dir: &Path,
    conversations: &[ImportedConversation],
) -> Result<Vec<ImportedConversationSummary>, String> {
    let mut index = load_v3_index_at(config_dir)?;
    let mut imported = Vec::with_capacity(conversations.len());
    for conversation in conversations {
        let store_dir = v3_store_path(config_dir);
        let mut incoming = conversation.clone();
        if index
            .conversations
            .iter()
            .any(|summary| summary.id == conversation.id)
        {
            let bytes = fs::read(v3_item_path(config_dir, &conversation.id))
                .map_err(|error| format!("Could not read imported conversation: {error}"))?;
            let existing: ImportedConversation = serde_json::from_slice(&bytes)
                .map_err(|error| format!("Imported conversation is invalid: {error}"))?;
            align_imported_message_ids(&existing, &mut incoming);
        }
        let stored = prepare_conversation_for_store(&store_dir, Some(&store_dir), &incoming)?;
        save_json_atomically(&v3_item_path(config_dir, &stored.id), &stored)?;
        index
            .asset_references
            .insert(stored.id.clone(), asset_reference_list(&stored)?);
        imported.push(to_summary(&stored));
    }
    let imported_ids: HashSet<&str> = imported.iter().map(|item| item.id.as_str()).collect();
    index
        .conversations
        .retain(|item| !imported_ids.contains(item.id.as_str()));
    index.conversations.extend(imported.iter().cloned());
    sort_summaries(&mut index.conversations);
    save_json_atomically(&v3_index_path(config_dir), &index)?;
    cleanup_orphan_assets_at(config_dir, &index)?;
    sort_summaries(&mut imported);
    Ok(imported)
}

fn list_imported_conversations_at(
    config_dir: &Path,
) -> Result<Vec<ImportedConversationSummary>, String> {
    let index = load_v3_index_at(config_dir)?;
    cleanup_orphan_assets_at(config_dir, &index)?;
    Ok(index.conversations)
}

fn load_imported_conversation_at(
    config_dir: &Path,
    id: &str,
) -> Result<ImportedConversation, String> {
    let index = load_v3_index_at(config_dir)?;
    if !index
        .conversations
        .iter()
        .any(|conversation| conversation.id == id)
    {
        return Err("Imported conversation was not found".to_string());
    }
    let path = v3_item_path(config_dir, id);
    let bytes = fs::read(&path)
        .map_err(|error| format!("Could not read imported conversation: {error}"))?;
    let conversation: ImportedConversation = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Imported conversation is invalid: {error}"))?;
    if conversation.id != id {
        return Err("Imported conversation id does not match its index entry".to_string());
    }
    Ok(conversation)
}

fn cleanup_orphan_assets_at(
    config_dir: &Path,
    index: &ImportedConversationsIndex,
) -> Result<(), String> {
    let store_dir = v3_store_path(config_dir);
    let assets_dir = store_dir.join(STORE_ASSETS_DIRECTORY);
    fs::create_dir_all(&assets_dir)
        .map_err(|error| format!("Could not create imported asset directory: {error}"))?;
    if index.asset_references.len() != index.conversations.len()
        || index
            .conversations
            .iter()
            .any(|summary| !index.asset_references.contains_key(&summary.id))
    {
        return Ok(());
    }
    let referenced = index
        .asset_references
        .values()
        .flatten()
        .map(|asset_id| normalize_asset_id(asset_id))
        .collect::<Result<HashSet<_>, _>>()?;
    let entries = fs::read_dir(&assets_dir)
        .map_err(|error| format!("Could not scan imported asset directory: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not inspect imported asset: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect imported asset type: {error}"))?;
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let asset_id = file_name.strip_suffix(".txt");
        let keep = asset_id
            .and_then(|asset_id| normalize_asset_id(asset_id).ok())
            .is_some_and(|asset_id| referenced.contains(&asset_id));
        if !keep {
            fs::remove_file(entry.path())
                .map_err(|error| format!("Could not remove orphan imported asset: {error}"))?;
        }
    }
    Ok(())
}

fn remove_imported_conversation_at(config_dir: &Path, id: &str) -> Result<(), String> {
    let mut index = load_v3_index_at(config_dir)?;
    let before = index.conversations.len();
    index
        .conversations
        .retain(|conversation| conversation.id != id);
    if index.conversations.len() == before {
        return Ok(());
    }
    index.asset_references.remove(id);

    // Publish the small index first. If deleting the item fails, it is only an
    // unreachable orphan and the removed conversation cannot reappear in lists.
    save_json_atomically(&v3_index_path(config_dir), &index)?;
    match fs::remove_file(v3_item_path(config_dir, id)) {
        Ok(()) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(format!(
            "Imported conversation was removed from the index, but its item file could not be deleted: {error}"
        )),
    }
    cleanup_orphan_assets_at(config_dir, &index)
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

fn collect_jsonl_files(root: &Path, output: &mut Vec<PathBuf>, warnings: &mut Vec<String>) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            push_warning(
                warnings,
                format!(
                    "Could not read history directory {}: {error}",
                    root.display()
                ),
            );
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                push_warning(
                    warnings,
                    format!("Could not read an entry in {}: {error}", root.display()),
                );
                continue;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                push_warning(
                    warnings,
                    format!("Could not inspect history path {}: {error}", path.display()),
                );
                continue;
            }
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_jsonl_files(&path, output, warnings);
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
        || normalized.starts_with("<codex_internal_context")
        || normalized.starts_with("<turn_aborted>")
        || normalized.starts_with("<subagent_notification>")
        || normalized.starts_with("<environment_context>")
        || normalized.starts_with("<permissions instructions>")
        || normalized.starts_with("<local-command-caveat")
        || normalized.starts_with("<local-command-name")
        || normalized.starts_with("<local-command-stdout")
        || normalized.starts_with("<task-notification>")
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

    fn test_store_directory(label: &str) -> PathBuf {
        let counter = TEST_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "galcode-imported-store-{label}-{}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("test store directory");
        directory
    }

    fn test_conversation(id: &str, title: &str, updated_at: i64) -> ImportedConversation {
        ImportedConversation {
            id: id.to_string(),
            source: CODEX_SOURCE.to_string(),
            native_session_id: id.trim_start_matches("external:codex:").to_string(),
            title: title.to_string(),
            project_path: Some("C:/project".to_string()),
            created_at: updated_at - 100,
            updated_at,
            imported_at: updated_at + 100,
            messages: vec![ImportedTranscriptMessage {
                id: format!("{id}:0"),
                role: "user".to_string(),
                is_user_prompt: None,
                source_turn_id: None,
                content: "inspect this image".to_string(),
                parts: vec![
                    ImportedTranscriptPart::Text {
                        text: "inspect this image".to_string(),
                    },
                    ImportedTranscriptPart::Image {
                        data_url: Some("data:image/png;base64,abc".to_string()),
                        asset_id: None,
                        alt: Some("screenshot".to_string()),
                    },
                ],
                timestamp: updated_at,
            }],
        }
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
        assert!(matches!(
            &parts[1],
            ImportedTranscriptPart::Event { data, .. } if data.is_null()
        ));
        assert!(matches!(parts[3], ImportedTranscriptPart::ToolCall { .. }));
    }

    #[test]
    fn preserves_codex_context_only_messages_as_system_context() {
        let path = write_test_jsonl(vec![
            json!({
                "timestamp": "2026-07-13T00:00:00Z",
                "type": "session_meta",
                "payload": { "session_id": "context-session", "id": "context-rollout", "cwd": "C:/work" }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:01Z",
                "type": "response_item",
                "payload": {
                    "id": "context-message",
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "<environment_context>\n  <cwd>C:/work</cwd>\n</environment_context>" }]
                }
            }),
        ]);

        let piece = parse_codex_file(&path, "fallback".to_string()).expect("Codex context");
        assert_eq!(piece.messages.len(), 1);
        assert_eq!(piece.messages[0].role, "system");
        assert!(!piece.messages[0].is_user_prompt);
        assert_eq!(
            piece.messages[0].source_message_id.as_deref(),
            Some("context-message")
        );
        assert!(piece.messages[0].content.contains("<environment_context>"));
        fs::remove_file(path).ok();
    }

    #[test]
    fn codex_user_marker_sets_prompt_origin_and_propagates_turn_id() {
        let path = write_test_jsonl(vec![
            json!({
                "timestamp": "2026-07-13T00:00:00Z",
                "type": "session_meta",
                "payload": { "session_id": "turn-session", "id": "turn-rollout", "cwd": "C:/work" }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:01Z",
                "type": "response_item",
                "payload": {
                    "id": "user-message-id",
                    "type": "message",
                    "role": "user",
                    "internal_chat_message_metadata_passthrough": { "turn_id": "turn-42" },
                    "content": [{ "type": "input_text", "text": "real user prompt" }]
                }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:01.100Z",
                "type": "event_msg",
                "payload": { "type": "user_message", "message": "real user prompt" }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:02Z",
                "type": "response_item",
                "payload": {
                    "id": "assistant-message-id",
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "answer" }]
                }
            }),
        ]);

        let piece = parse_codex_file(&path, "fallback".to_string()).expect("Codex turn");
        assert_eq!(piece.messages.len(), 2);
        assert!(piece.messages[0].is_user_prompt);
        assert_eq!(piece.messages[0].source_turn_id.as_deref(), Some("turn-42"));
        assert!(!piece.messages[1].is_user_prompt);
        let messages = finalize_messages("turn-session", piece.messages);
        assert_eq!(messages[0].is_user_prompt, Some(true));
        assert_eq!(messages[1].is_user_prompt, Some(false));
        assert_eq!(messages[0].source_turn_id.as_deref(), Some("turn-42"));
        assert_eq!(messages[1].source_turn_id.as_deref(), Some("turn-42"));
        fs::remove_file(path).ok();
    }

    #[test]
    fn preserves_claude_top_level_attachments_with_semantic_roles() {
        let path = write_test_jsonl(vec![
            json!({
                "timestamp": "2026-07-13T00:00:00Z",
                "type": "attachment",
                "uuid": "file-uuid",
                "sessionId": "attachment-session",
                "attachment": {
                    "type": "file",
                    "filename": "notes.txt",
                    "displayPath": "C:/work/notes.txt",
                    "content": {
                        "type": "text",
                        "file": {
                            "content": "hello",
                            "filePath": "C:/work/notes.txt",
                            "numLines": 1,
                            "startLine": 1,
                            "totalLines": 1
                        }
                    }
                }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:00.500Z",
                "type": "attachment",
                "uuid": "pdf-uuid",
                "sessionId": "attachment-session",
                "attachment": {
                    "type": "file",
                    "filename": "guide.pdf",
                    "displayPath": "C:/work/guide.pdf",
                    "content": {
                        "type": "pdf",
                        "file": {
                            "base64": "aGVsbG8=",
                            "filePath": "C:/work/guide.pdf",
                            "originalSize": 5
                        }
                    }
                }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:01Z",
                "type": "attachment",
                "uuid": "reminder-uuid",
                "sessionId": "attachment-session",
                "attachment": {
                    "type": "task_reminder",
                    "message": "keep working"
                }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:02Z",
                "type": "attachment",
                "uuid": "queued-uuid",
                "sessionId": "attachment-session",
                "attachment": {
                    "type": "queued_command",
                    "prompt": "sent while the tool was running",
                    "commandMode": "task-notification"
                }
            }),
        ]);

        let pieces = parse_claude_file(&path);
        assert_eq!(pieces.len(), 1);
        assert_eq!(pieces[0].messages.len(), 4);
        assert_eq!(pieces[0].messages[0].role, "system");
        assert_eq!(
            pieces[0].messages[0].source_message_id.as_deref(),
            Some("file-uuid")
        );
        assert!(matches!(
            &pieces[0].messages[0].parts[0],
            ImportedTranscriptPart::Attachment { name, data_url, .. }
                if name.as_deref() == Some("notes.txt")
                    && data_url.as_deref() == Some("data:text/plain;base64,aGVsbG8=")
        ));
        assert_eq!(pieces[0].messages[1].role, "system");
        assert!(matches!(
            &pieces[0].messages[1].parts[0],
            ImportedTranscriptPart::Attachment { name, media_type, data_url, .. }
                if name.as_deref() == Some("guide.pdf")
                    && media_type.as_deref() == Some("application/pdf")
                    && data_url.as_deref() == Some("data:application/pdf;base64,aGVsbG8=")
        ));
        assert_eq!(pieces[0].messages[2].role, "system");
        assert!(!pieces[0].messages[2].is_user_prompt);
        assert!(matches!(
            &pieces[0].messages[2].parts[0],
            ImportedTranscriptPart::Event { kind, .. } if kind == "task_reminder"
        ));
        assert_eq!(pieces[0].messages[3].role, "user");
        assert!(pieces[0].messages[3].is_user_prompt);
        assert_eq!(
            pieces[0].messages[3].source_turn_id.as_deref(),
            Some("queued-uuid")
        );
        assert_eq!(
            pieces[0].messages[3].source_message_id.as_deref(),
            Some("queued-uuid")
        );
        assert!(matches!(
            &pieces[0].messages[3].parts[0],
            ImportedTranscriptPart::Text { text } if text == "sent while the tool was running"
        ));

        let directory = test_store_directory("claude-top-level-attachments");
        let parsed = assemble_claude_conversations(pieces, true)
            .into_iter()
            .next()
            .expect("assembled Claude conversation");
        let imported = to_imported_conversation(CLAUDE_SOURCE, parsed, 10);
        upsert_imported_conversations_at(&directory, &[imported.clone()])
            .expect("store Claude attachment import");
        let loaded = load_imported_conversation_at(&directory, &imported.id)
            .expect("load Claude attachment import");
        let asset_id = match &loaded.messages[0].parts[0] {
            ImportedTranscriptPart::Attachment {
                data_url, asset_id, ..
            } => {
                assert!(data_url.is_none());
                asset_id.as_deref().expect("text attachment asset")
            }
            other => panic!("unexpected stored attachment: {other:?}"),
        };
        assert_eq!(
            load_imported_asset_at(&directory, asset_id).expect("text attachment data"),
            "data:text/plain;base64,aGVsbG8="
        );
        fs::remove_dir_all(directory).ok();
        fs::remove_file(path).ok();
    }

    #[test]
    fn preserves_claude_meta_and_sidechain_messages_as_system_context() {
        let path = write_test_jsonl(vec![
            json!({
                "timestamp": "2026-07-13T00:00:00Z",
                "type": "user",
                "uuid": "meta-uuid",
                "sessionId": "meta-session",
                "isMeta": true,
                "message": { "content": "<task-notification>metadata</task-notification>" }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:01Z",
                "type": "assistant",
                "uuid": "sidechain-uuid",
                "sessionId": "meta-session",
                "isSidechain": true,
                "message": { "content": "sidechain context" }
            }),
        ]);

        let pieces = parse_claude_file(&path);
        assert_eq!(pieces.len(), 1);
        assert_eq!(pieces[0].messages.len(), 2);
        assert!(pieces[0]
            .messages
            .iter()
            .all(|message| message.role == "system"));
        fs::remove_file(path).ok();
    }

    #[test]
    fn extracts_embedded_images_from_codex_tool_details_without_duplicate_base64() {
        let result = json!({
            "type": "function_call_output",
            "call_id": "call-1",
            "output": "{\"first\":\"data:image/png;base64,aGVsbG8=\",\"nested\":{\"second\":\"data:image/webp;base64,d29ybGQ=\"}}"
        });

        let (_, _, parts) = extract_codex_message(&result).expect("tool result");
        assert_eq!(parts.len(), 3);
        assert!(matches!(
            &parts[0],
            ImportedTranscriptPart::ToolResult { output, .. }
                if output["first"] == "[Image data omitted]"
                    && output["nested"]["second"] == "[Image data omitted]"
        ));
        assert!(matches!(
            &parts[1],
            ImportedTranscriptPart::Image { data_url, .. }
                if data_url.as_deref() == Some("data:image/png;base64,aGVsbG8=")
        ));
        assert!(matches!(
            &parts[2],
            ImportedTranscriptPart::Image { data_url, .. }
                if data_url.as_deref() == Some("data:image/webp;base64,d29ybGQ=")
        ));
    }

    #[test]
    fn extracts_embedded_images_from_text_and_tool_input() {
        let message = json!({
            "type": "message",
            "role": "user",
            "content": [{
                "type": "input_text",
                "text": "before data:image/png;base64,aGVsbG8= after"
            }]
        });
        let call = json!({
            "type": "function_call",
            "name": "inspect",
            "arguments": "{\"image\":\"data:image/jpeg;base64,d29ybGQ=\"}",
            "call_id": "call-2"
        });

        let (_, _, message_parts) = extract_codex_message(&message).expect("message");
        assert!(matches!(
            &message_parts[0],
            ImportedTranscriptPart::Text { text }
                if text == "before [Image data omitted] after"
        ));
        assert!(matches!(
            message_parts[1],
            ImportedTranscriptPart::Image { .. }
        ));

        let (_, _, call_parts) = extract_codex_message(&call).expect("tool call");
        assert!(matches!(
            &call_parts[0],
            ImportedTranscriptPart::ToolCall { input, .. }
                if input["image"] == "[Image data omitted]"
        ));
        assert!(matches!(
            call_parts[1],
            ImportedTranscriptPart::Image { .. }
        ));
    }

    #[test]
    fn preserves_non_image_attachments_and_remote_urls_as_metadata() {
        let content = json!([
            {
                "type": "document",
                "name": "report.pdf",
                "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": "aGVsbG8="
                }
            },
            {
                "type": "audio",
                "name": "voice.mp3",
                "source": {
                    "type": "url",
                    "media_type": "audio/mpeg",
                    "url": "https://example.invalid/voice.mp3"
                }
            }
        ]);

        let parts = extract_content_parts(&content);
        assert!(matches!(
            &parts[0],
            ImportedTranscriptPart::Attachment {
                name,
                media_type,
                data_url,
                url,
                ..
            } if name.as_deref() == Some("report.pdf")
                && media_type.as_deref() == Some("application/pdf")
                && data_url.as_deref() == Some("data:application/pdf;base64,aGVsbG8=")
                && url.is_none()
        ));
        assert!(matches!(
            &parts[1],
            ImportedTranscriptPart::Attachment {
                name,
                media_type,
                data_url,
                url,
                ..
            } if name.as_deref() == Some("voice.mp3")
                && media_type.as_deref() == Some("audio/mpeg")
                && data_url.is_none()
                && url.as_deref() == Some("https://example.invalid/voice.mp3")
        ));
    }

    #[test]
    fn serializes_attachment_part_with_frontend_camel_case_contract() {
        let value = serde_json::to_value(ImportedTranscriptPart::Attachment {
            name: Some("report.pdf".to_string()),
            media_type: Some("application/pdf".to_string()),
            data_url: Some("data:application/pdf;base64,aGVsbG8=".to_string()),
            asset_id: None,
            url: None,
        })
        .expect("attachment serialization");

        assert_eq!(value["type"], "attachment");
        assert_eq!(value["name"], "report.pdf");
        assert_eq!(value["mediaType"], "application/pdf");
        assert_eq!(value["dataUrl"], "data:application/pdf;base64,aGVsbG8=");
        assert!(value["url"].is_null());
    }

    #[test]
    fn reports_invalid_and_unknown_attachment_content_without_silent_loss() {
        let content = json!([
            {
                "type": "file",
                "name": "broken.bin",
                "source": {
                    "type": "base64",
                    "media_type": "application/octet-stream",
                    "data": "%%%"
                }
            },
            {"futureAttachment": {"name": "later.bin"}}
        ]);
        let mut warnings = Vec::new();

        let parts = extract_content_parts_with_warnings(&content, &mut warnings, "test record");
        assert!(matches!(
            parts[0],
            ImportedTranscriptPart::Attachment { .. }
        ));
        assert!(matches!(
            &parts[1],
            ImportedTranscriptPart::Event { kind, .. } if kind == "unknown"
        ));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("invalid base64")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("unknown content item")));
    }

    #[test]
    fn validates_attachment_mime_base64_and_size_limit() {
        assert!(parse_base64_data_url("data:image/png;base64,aGVsbG8=").is_some());
        assert!(parse_base64_data_url("data:not a mime;base64,aGVsbG8=").is_none());
        assert!(validate_base64_payload("aGVsbG8=").is_ok());
        assert!(validate_base64_payload("abc%def").is_err());
        assert!(validate_base64_payload_with_limit("aGVsbG8=", 4).is_err());
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
        assert_eq!(semantic_claude_role("user", &parts), "tool");
        assert!(matches!(
            &parts[0],
            ImportedTranscriptPart::ToolResult { tool_call_id, .. }
                if tool_call_id.as_deref() == Some("call-1")
        ));
        assert!(matches!(
            &parts[1],
            ImportedTranscriptPart::Image { data_url, .. }
                if data_url.as_deref() == Some("data:image/png;base64,abc")
        ));
    }

    #[test]
    fn recognizes_attributed_codex_internal_context() {
        assert!(is_context_only_prompt(
            "<codex_internal_context source=\"goal\">hidden</codex_internal_context>"
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
        assert_eq!(message.is_user_prompt, None);
        assert_eq!(message.source_turn_id, None);
    }

    #[test]
    fn orders_imported_messages_by_timestamp_then_source_position() {
        let messages = vec![
            ParsedMessage {
                source_kind: CLAUDE_SOURCE,
                role: "assistant".to_string(),
                is_user_prompt: false,
                source_turn_id: None,
                content: "second".to_string(),
                parts: vec![ImportedTranscriptPart::Text {
                    text: "second".to_string(),
                }],
                timestamp: 20,
                source_message_id: None,
                source_path: "b.jsonl".to_string(),
                line_number: 1,
            },
            ParsedMessage {
                source_kind: CLAUDE_SOURCE,
                role: "user".to_string(),
                is_user_prompt: true,
                source_turn_id: Some("first-turn".to_string()),
                content: "first".to_string(),
                parts: vec![ImportedTranscriptPart::Text {
                    text: "first".to_string(),
                }],
                timestamp: 10,
                source_message_id: None,
                source_path: "a.jsonl".to_string(),
                line_number: 2,
            },
        ];

        let result = finalize_messages("session", messages);
        assert_eq!(result[0].content, "first");
        assert_eq!(result[1].content, "second");
    }

    #[test]
    fn stable_message_ids_do_not_shift_after_middle_insertion() {
        let parsed = |content: &str, timestamp: i64| ParsedMessage {
            source_kind: CODEX_SOURCE,
            role: "assistant".to_string(),
            is_user_prompt: false,
            source_turn_id: None,
            content: content.to_string(),
            parts: vec![ImportedTranscriptPart::Text {
                text: content.to_string(),
            }],
            timestamp,
            source_message_id: None,
            source_path: "history.jsonl".to_string(),
            line_number: timestamp as usize,
        };
        let original = finalize_messages("session", vec![parsed("first", 10), parsed("last", 30)]);
        let with_middle = finalize_messages(
            "session",
            vec![
                parsed("first", 10),
                parsed("middle", 20),
                parsed("last", 30),
            ],
        );

        assert_eq!(original[0].id, with_middle[0].id);
        assert_eq!(original[1].id, with_middle[2].id);
    }

    #[test]
    fn reimport_reuses_existing_legacy_message_ids_by_intrinsic_fingerprint() {
        let directory = test_store_directory("legacy-id-reuse");
        let mut existing = test_conversation("external:codex:stable", "Stable", 3000);
        existing.messages[0].id = "legacy-index-id".to_string();
        let store = v3_store_path(&directory);
        fs::create_dir_all(store.join(STORE_ITEMS_DIRECTORY)).expect("v3 items");
        fs::write(
            item_path_in_store(&store, &existing.id),
            serde_json::to_vec(&existing).expect("v3 item"),
        )
        .expect("v3 item write");
        fs::write(
            store.join(STORE_INDEX_FILE),
            serde_json::to_vec(&ImportedConversationsIndex {
                version: 3,
                conversations: vec![to_summary(&existing)],
                asset_references: HashMap::new(),
            })
            .expect("v3 index"),
        )
        .expect("v3 index write");

        let mut reimported = existing.clone();
        reimported.messages[0].id = "new-generated-id".to_string();
        reimported.imported_at += 100;
        upsert_imported_conversations_at(&directory, &[reimported]).expect("reimport");
        let loaded = load_imported_conversation_at(&directory, &existing.id)
            .expect("reimported conversation");
        assert_eq!(loaded.messages[0].id, "legacy-index-id");
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn message_fingerprint_matches_inline_and_externalized_assets() {
        let inline = test_conversation("external:codex:inline", "Inline", 3000)
            .messages
            .remove(0);
        let mut externalized = inline.clone();
        if let ImportedTranscriptPart::Image {
            data_url, asset_id, ..
        } = &mut externalized.parts[1]
        {
            let value = data_url.take().expect("inline data");
            *asset_id = Some(asset_id_for_data_url(&value));
        }

        assert_eq!(
            imported_message_fingerprint(CODEX_SOURCE, &inline),
            imported_message_fingerprint(CODEX_SOURCE, &externalized)
        );
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

        let pieces =
            parse_codex_file_with_options(&path, "fallback".to_string(), None, &mut Vec::new());
        assert_eq!(pieces.len(), 2);
        assert_eq!(pieces[0].native_session_id, "first");
        assert_eq!(pieces[0].messages.len(), 1);
        assert_eq!(pieces[0].messages[0].content, "first request");
        assert_eq!(pieces[1].native_session_id, "second");
        assert_eq!(pieces[1].messages.len(), 1);
        assert_eq!(pieces[1].messages[0].content, "second answer");
        fs::remove_file(path).ok();
    }

    #[test]
    fn skips_codex_subagent_files_and_preserves_internal_context() {
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
        assert_eq!(piece.messages.len(), 2);
        assert_eq!(piece.messages[0].role, "system");
        assert!(!piece.messages[0].is_user_prompt);
        assert!(piece.messages[0]
            .content
            .contains("<codex_internal_context>"));
        assert_eq!(piece.messages[1].content, "real request");
        assert!(piece.messages[1].is_user_prompt);
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
    fn preview_parser_keeps_only_lightweight_codex_message_metadata() {
        let path = write_test_jsonl(vec![
            json!({
                "timestamp": "2026-07-13T00:00:00Z",
                "type": "session_meta",
                "payload": { "session_id": "preview", "cwd": "C:/one" }
            }),
            json!({
                "timestamp": "2026-07-13T00:00:01Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "inspect this"},
                        {"type": "input_image", "image_url": "data:image/png;base64,aGVsbG8="}
                    ]
                }
            }),
        ]);
        let mut warnings = Vec::new();

        let piece = parse_codex_preview_file(&path, "fallback".to_string(), &mut warnings)
            .expect("preview piece");
        assert!(piece.messages.is_empty());
        assert_eq!(piece.preview_messages.len(), 1);
        assert_eq!(
            piece.preview_messages[0].user_text.as_deref(),
            Some("inspect this")
        );
        assert!(warnings.is_empty());
        fs::remove_file(path).ok();
    }

    #[test]
    fn selected_claude_import_skips_other_sessions_and_reports_bad_json() {
        let counter = TEST_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "galcode-external-history-selected-{}-{counter}.jsonl",
            std::process::id()
        ));
        let records = [
            "not-json".to_string(),
            json!({
                "timestamp": "2026-07-13T00:00:00Z",
                "type": "user",
                "sessionId": "selected",
                "message": {"content": "keep"}
            })
            .to_string(),
            json!({
                "timestamp": "2026-07-13T00:00:01Z",
                "type": "user",
                "sessionId": "other",
                "message": {"content": [{
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/png", "data": "aGVsbG8="}
                }]}
            })
            .to_string(),
        ];
        fs::write(&path, records.join("\n")).expect("selected JSONL");
        let selected = HashSet::from(["selected".to_string()]);
        let mut warnings = Vec::new();

        let pieces = parse_claude_file_with_options(&path, true, Some(&selected), &mut warnings);
        assert_eq!(pieces.len(), 1);
        assert_eq!(pieces[0].native_session_id, "selected");
        assert_eq!(pieces[0].messages.len(), 1);
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("invalid JSON")));
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
    fn migrates_v1_single_file_store_to_v4() {
        let directory = test_store_directory("v1-migration");
        let conversation_id = "external:codex:v1";
        let legacy = json!({
            "version": 1,
            "conversations": [{
                "id": conversation_id,
                "source": CODEX_SOURCE,
                "nativeSessionId": "v1",
                "title": "V1 conversation",
                "projectPath": "C:/legacy",
                "createdAt": 1000,
                "updatedAt": 2000,
                "importedAt": 3000,
                "messages": [{
                    "id": "v1-message",
                    "role": "user",
                    "content": "legacy prompt",
                    "timestamp": 1000
                }]
            }]
        });
        fs::write(
            legacy_store_path(&directory),
            serde_json::to_vec(&legacy).expect("v1 serialization"),
        )
        .expect("v1 store");

        let summaries = list_imported_conversations_at(&directory).expect("migrate v1 store");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, conversation_id);
        assert!(!legacy_store_path(&directory).exists());

        let index: ImportedConversationsIndex =
            serde_json::from_slice(&fs::read(v3_index_path(&directory)).expect("v4 index"))
                .expect("v4 index parse");
        assert_eq!(index.version, STORE_VERSION);

        let loaded = load_imported_conversation_at(&directory, conversation_id)
            .expect("migrated v1 conversation");
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0].content, "legacy prompt");
        assert!(loaded.messages[0].parts.is_empty());
        assert_eq!(loaded.messages[0].is_user_prompt, None);
        assert_eq!(loaded.messages[0].source_turn_id, None);
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn migrates_legacy_store_to_v4_and_removes_legacy_copy() {
        let directory = test_store_directory("migration");
        let conversation = test_conversation("external:codex:legacy", "Legacy", 2000);
        let legacy = ImportedConversationsFile {
            version: 2,
            conversations: vec![conversation.clone()],
        };
        fs::write(
            legacy_store_path(&directory),
            serde_json::to_vec(&legacy).expect("legacy serialization"),
        )
        .expect("legacy store");
        let stale_staging = directory.join(STORE_STAGING_DIRECTORY);
        fs::create_dir_all(&stale_staging).expect("stale staging directory");
        fs::write(stale_staging.join("partial"), "partial").expect("stale staging file");

        let summaries = list_imported_conversations_at(&directory).expect("migrated list");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, conversation.id);
        assert!(!legacy_store_path(&directory).exists());
        assert!(v3_index_path(&directory).is_file());
        assert!(v3_item_path(&directory, &conversation.id).is_file());
        assert!(!stale_staging.exists());

        let loaded = load_imported_conversation_at(&directory, &conversation.id)
            .expect("migrated conversation");
        assert_eq!(loaded.title, "Legacy");
        let migrated_asset = match &loaded.messages[0].parts[1] {
            ImportedTranscriptPart::Image {
                data_url,
                asset_id,
                alt,
            } => {
                assert!(data_url.is_none());
                assert_eq!(alt.as_deref(), Some("screenshot"));
                asset_id.as_deref().expect("legacy image asset")
            }
            other => panic!("unexpected migrated part: {other:?}"),
        };
        assert_eq!(
            load_imported_asset_at(&directory, migrated_asset).expect("legacy image data"),
            "data:image/png;base64,abc"
        );

        let index_before = fs::read(v3_index_path(&directory)).expect("index before second list");
        let item_before =
            fs::read(v3_item_path(&directory, &conversation.id)).expect("item before second list");
        list_imported_conversations_at(&directory).expect("idempotent second list");
        assert_eq!(
            fs::read(v3_index_path(&directory)).expect("index after second list"),
            index_before
        );
        assert_eq!(
            fs::read(v3_item_path(&directory, &conversation.id)).expect("item after second list"),
            item_before
        );
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn failed_v3_migration_keeps_legacy_store_for_rollback() {
        let directory = test_store_directory("migration-rollback");
        let conversation = test_conversation("external:codex:legacy", "Legacy", 2000);
        let legacy = ImportedConversationsFile {
            version: 2,
            conversations: vec![conversation],
        };
        fs::write(
            legacy_store_path(&directory),
            serde_json::to_vec(&legacy).expect("legacy serialization"),
        )
        .expect("legacy store");
        fs::write(v3_store_path(&directory), "blocks migration").expect("invalid v3 path");

        assert!(list_imported_conversations_at(&directory).is_err());
        assert!(legacy_store_path(&directory).is_file());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn v4_upsert_externalizes_and_deduplicates_assets() {
        let directory = test_store_directory("v4-assets");
        let first = test_conversation("external:codex:first", "First", 3000);
        let second = test_conversation("external:codex:second", "Second", 4000);

        upsert_imported_conversations_at(&directory, &[first.clone(), second.clone()])
            .expect("v4 upsert");
        let loaded =
            load_imported_conversation_at(&directory, &first.id).expect("externalized item");
        let asset_id = match &loaded.messages[0].parts[1] {
            ImportedTranscriptPart::Image {
                data_url, asset_id, ..
            } => {
                assert!(data_url.is_none());
                asset_id.clone().expect("image asset id")
            }
            other => panic!("unexpected part: {other:?}"),
        };
        assert_eq!(asset_id.len(), 64);
        assert_eq!(
            load_imported_asset_at(&directory, &asset_id).expect("asset data"),
            "data:image/png;base64,abc"
        );
        let raw_item = fs::read_to_string(v3_item_path(&directory, &first.id)).expect("raw item");
        assert!(!raw_item.contains("data:image/png;base64,abc"));
        assert_eq!(
            fs::read_dir(v3_store_path(&directory).join(STORE_ASSETS_DIRECTORY))
                .expect("assets directory")
                .count(),
            1
        );
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn load_asset_rejects_invalid_ids_and_oversized_files() {
        let directory = test_store_directory("asset-validation");
        list_imported_conversations_at(&directory).expect("initialize v4 store");
        assert!(load_imported_asset_at(&directory, "../index.json").is_err());
        assert!(load_imported_asset_at(&directory, &"g".repeat(64)).is_err());

        let asset_id = "a".repeat(64);
        let path = asset_path_in_store(&v3_store_path(&directory), &asset_id);
        let file = File::create(&path).expect("oversized asset");
        file.set_len((MAX_ASSET_FILE_BYTES + 1) as u64)
            .expect("oversized length");
        assert!(load_asset_from_store(&v3_store_path(&directory), &asset_id).is_err());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn migrates_v3_items_to_v4_without_losing_images() {
        let directory = test_store_directory("v3-to-v4");
        let mut conversation = test_conversation("external:codex:legacy-v3", "Legacy v3", 3000);
        conversation.messages[0]
            .parts
            .push(ImportedTranscriptPart::ToolResult {
                tool_call_id: Some("legacy-tool".to_string()),
                output: json!({
                    "image": "data:image/webp;base64,d29ybGQ="
                }),
                is_error: false,
            });
        conversation.messages[0]
            .parts
            .push(ImportedTranscriptPart::Attachment {
                name: Some("legacy.txt".to_string()),
                media_type: Some("text/plain".to_string()),
                data_url: Some("data:text/plain;base64,aGVsbG8=".to_string()),
                asset_id: None,
                url: None,
            });
        let store = v3_store_path(&directory);
        fs::create_dir_all(store.join(STORE_ITEMS_DIRECTORY)).expect("v3 items");
        fs::write(
            item_path_in_store(&store, &conversation.id),
            serde_json::to_vec(&conversation).expect("v3 item serialization"),
        )
        .expect("v3 item");
        let v3_index = ImportedConversationsIndex {
            version: 3,
            conversations: vec![to_summary(&conversation)],
            asset_references: HashMap::new(),
        };
        fs::write(
            store.join(STORE_INDEX_FILE),
            serde_json::to_vec(&v3_index).expect("v3 index serialization"),
        )
        .expect("v3 index");

        assert_eq!(
            list_imported_conversations_at(&directory)
                .expect("migrated v4 list")
                .len(),
            1
        );
        let migrated_index: ImportedConversationsIndex =
            serde_json::from_slice(&fs::read(v3_index_path(&directory)).expect("v4 index"))
                .expect("v4 index parse");
        assert_eq!(migrated_index.version, 4);
        let loaded = load_imported_conversation_at(&directory, &conversation.id)
            .expect("migrated conversation");
        assert_eq!(loaded.messages[0].is_user_prompt, None);
        assert_eq!(loaded.messages[0].source_turn_id, None);
        let asset_id = match &loaded.messages[0].parts[1] {
            ImportedTranscriptPart::Image {
                data_url, asset_id, ..
            } => {
                assert!(data_url.is_none());
                asset_id.as_deref().expect("migrated asset id")
            }
            other => panic!("unexpected part: {other:?}"),
        };
        assert_eq!(
            load_imported_asset_at(&directory, asset_id).expect("migrated image"),
            "data:image/png;base64,abc"
        );
        assert!(matches!(
            &loaded.messages[0].parts[2],
            ImportedTranscriptPart::ToolResult { output, .. }
                if output["image"] == "[Image data omitted]"
        ));
        let embedded_asset = match &loaded.messages[0].parts[3] {
            ImportedTranscriptPart::Image { asset_id, .. } => {
                asset_id.as_deref().expect("embedded tool result asset")
            }
            other => panic!("unexpected embedded part: {other:?}"),
        };
        assert_eq!(
            load_imported_asset_at(&directory, embedded_asset).expect("embedded migrated image"),
            "data:image/webp;base64,d29ybGQ="
        );
        let attachment_asset = match &loaded.messages[0].parts[4] {
            ImportedTranscriptPart::Attachment {
                data_url, asset_id, ..
            } => {
                assert!(data_url.is_none());
                asset_id.as_deref().expect("migrated attachment asset")
            }
            other => panic!("unexpected migrated attachment: {other:?}"),
        };
        assert_eq!(
            load_imported_asset_at(&directory, attachment_asset).expect("migrated attachment data"),
            "data:text/plain;base64,aGVsbG8="
        );
        assert!(!directory.join(STORE_BACKUP_DIRECTORY).exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn failed_v3_to_v4_migration_leaves_v3_store_untouched() {
        let directory = test_store_directory("v3-to-v4-rollback");
        let conversation = test_conversation("external:codex:broken-v3", "Broken v3", 3000);
        let store = v3_store_path(&directory);
        fs::create_dir_all(store.join(STORE_ITEMS_DIRECTORY)).expect("v3 items");
        fs::write(item_path_in_store(&store, &conversation.id), "not-json")
            .expect("broken v3 item");
        let v3_index = ImportedConversationsIndex {
            version: 3,
            conversations: vec![to_summary(&conversation)],
            asset_references: HashMap::new(),
        };
        let original_index = serde_json::to_vec(&v3_index).expect("v3 index serialization");
        fs::write(store.join(STORE_INDEX_FILE), &original_index).expect("v3 index");

        assert!(list_imported_conversations_at(&directory).is_err());
        assert_eq!(
            fs::read(store.join(STORE_INDEX_FILE)).expect("unchanged v3 index"),
            original_index
        );
        assert_eq!(
            fs::read_to_string(item_path_in_store(&store, &conversation.id))
                .expect("unchanged broken item"),
            "not-json"
        );
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn removing_conversations_cleans_only_unreferenced_assets() {
        let directory = test_store_directory("asset-cleanup");
        let first = test_conversation("external:codex:first", "First", 3000);
        let mut second = test_conversation("external:codex:second", "Second", 4000);
        second.messages[0]
            .parts
            .push(ImportedTranscriptPart::Attachment {
                name: Some("report.pdf".to_string()),
                media_type: Some("application/pdf".to_string()),
                data_url: Some("data:application/pdf;base64,aGVsbG8=".to_string()),
                asset_id: None,
                url: None,
            });
        upsert_imported_conversations_at(&directory, &[first.clone(), second.clone()])
            .expect("asset conversations");
        let loaded_second =
            load_imported_conversation_at(&directory, &second.id).expect("second conversation");
        let shared_asset = match &loaded_second.messages[0].parts[1] {
            ImportedTranscriptPart::Image { asset_id, .. } => {
                asset_id.clone().expect("shared asset")
            }
            other => panic!("unexpected part: {other:?}"),
        };
        let unique_asset = match &loaded_second.messages[0].parts[2] {
            ImportedTranscriptPart::Attachment { asset_id, .. } => {
                asset_id.clone().expect("unique asset")
            }
            other => panic!("unexpected part: {other:?}"),
        };

        remove_imported_conversation_at(&directory, &first.id).expect("remove first");
        assert!(asset_path_in_store(&v3_store_path(&directory), &shared_asset).is_file());
        assert!(asset_path_in_store(&v3_store_path(&directory), &unique_asset).is_file());
        remove_imported_conversation_at(&directory, &second.id).expect("remove second");
        assert!(!asset_path_in_store(&v3_store_path(&directory), &shared_asset).exists());
        assert!(!asset_path_in_store(&v3_store_path(&directory), &unique_asset).exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn listing_v4_store_removes_orphan_asset_files() {
        let directory = test_store_directory("orphan-cleanup");
        let conversation = test_conversation("external:codex:kept", "Kept", 3000);
        upsert_imported_conversations_at(&directory, &[conversation]).expect("v4 store");
        let orphan_id = "f".repeat(64);
        let orphan = asset_path_in_store(&v3_store_path(&directory), &orphan_id);
        fs::write(&orphan, "data:image/png;base64,abc").expect("orphan asset");

        list_imported_conversations_at(&directory).expect("startup cleanup");
        assert!(!orphan.exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn replacing_conversation_updates_asset_reference_index() {
        let directory = test_store_directory("asset-reference-update");
        let mut conversation = test_conversation("external:codex:update", "Update", 3000);
        upsert_imported_conversations_at(&directory, &[conversation.clone()])
            .expect("initial asset");
        let initial = load_imported_conversation_at(&directory, &conversation.id)
            .expect("initial conversation");
        let initial_asset = match &initial.messages[0].parts[1] {
            ImportedTranscriptPart::Image { asset_id, .. } => {
                asset_id.clone().expect("initial asset id")
            }
            other => panic!("unexpected initial part: {other:?}"),
        };

        if let ImportedTranscriptPart::Image {
            data_url, asset_id, ..
        } = &mut conversation.messages[0].parts[1]
        {
            *data_url = Some("data:image/png;base64,d29ybGQ=".to_string());
            *asset_id = None;
        }
        upsert_imported_conversations_at(&directory, &[conversation.clone()])
            .expect("replacement asset");
        let replacement = load_imported_conversation_at(&directory, &conversation.id)
            .expect("replacement conversation");
        let replacement_asset = match &replacement.messages[0].parts[1] {
            ImportedTranscriptPart::Image { asset_id, .. } => {
                asset_id.clone().expect("replacement asset id")
            }
            other => panic!("unexpected replacement part: {other:?}"),
        };

        assert_ne!(initial_asset, replacement_asset);
        assert!(!asset_path_in_store(&v3_store_path(&directory), &initial_asset).exists());
        assert!(asset_path_in_store(&v3_store_path(&directory), &replacement_asset).is_file());
        let index = load_v3_index_at(&directory).expect("updated index");
        assert_eq!(
            index.asset_references[&conversation.id],
            vec![replacement_asset]
        );
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn removes_legacy_copy_left_behind_by_an_existing_valid_v3_store() {
        let directory = test_store_directory("legacy-cleanup");
        let conversation = test_conversation("external:codex:current", "Current", 3000);
        upsert_imported_conversations_at(&directory, &[conversation.clone()])
            .expect("valid v3 store");
        let legacy = ImportedConversationsFile {
            version: 2,
            conversations: vec![conversation],
        };
        fs::write(
            legacy_store_path(&directory),
            serde_json::to_vec(&legacy).expect("legacy serialization"),
        )
        .expect("leftover legacy store");

        assert_eq!(
            list_imported_conversations_at(&directory)
                .expect("valid v3 list")
                .len(),
            1
        );
        assert!(!legacy_store_path(&directory).exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn list_reads_only_index_and_load_reads_only_requested_item() {
        let directory = test_store_directory("isolated-load");
        let first = test_conversation("external:codex:first", "First", 3000);
        let second = test_conversation("external:codex:second", "Second", 4000);
        upsert_imported_conversations_at(&directory, &[first.clone(), second.clone()])
            .expect("initial v3 store");
        fs::write(v3_item_path(&directory, &second.id), "not-json")
            .expect("corrupt unrelated item");

        let summaries = list_imported_conversations_at(&directory).expect("index-only list");
        assert_eq!(summaries.len(), 2);
        let loaded =
            load_imported_conversation_at(&directory, &first.id).expect("load unaffected item");
        assert_eq!(loaded.title, "First");
        assert!(load_imported_conversation_at(&directory, &second.id).is_err());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn upsert_and_remove_do_not_rewrite_unrelated_items() {
        let directory = test_store_directory("targeted-write");
        let mut first = test_conversation("external:codex:first", "First", 3000);
        let second = test_conversation("external:codex:second", "Second", 4000);
        upsert_imported_conversations_at(&directory, &[first.clone(), second.clone()])
            .expect("initial v3 store");
        let second_path = v3_item_path(&directory, &second.id);
        let second_before = fs::read(&second_path).expect("unrelated item before update");

        first.title = "First updated".to_string();
        first.updated_at = 5000;
        upsert_imported_conversations_at(&directory, &[first.clone()]).expect("targeted update");
        assert_eq!(
            fs::read(&second_path).expect("unrelated item after update"),
            second_before
        );

        remove_imported_conversation_at(&directory, &first.id).expect("targeted removal");
        assert!(!v3_item_path(&directory, &first.id).exists());
        assert!(second_path.exists());
        let summaries = list_imported_conversations_at(&directory).expect("list after removal");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, second.id);
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
