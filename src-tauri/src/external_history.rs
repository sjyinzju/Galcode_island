use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const CODEX_SOURCE: &str = "codex";
const CLAUDE_SOURCE: &str = "claude-code";
const MAX_ATTACHMENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_ASSET_FILE_BYTES: usize = ((MAX_ATTACHMENT_BYTES + 2) / 3) * 4 + 1024;
const MAX_IMPORT_WARNINGS: usize = 100;

#[derive(Clone, Copy)]
struct HistoryScanLimits {
    max_file_bytes: u64,
    max_total_bytes: u64,
    max_import_bytes: u64,
    max_files: usize,
    max_entries: usize,
    max_records: usize,
    max_line_bytes: usize,
    max_directory_depth: usize,
}

const HISTORY_SCAN_LIMITS: HistoryScanLimits = HistoryScanLimits {
    // Existing real-world histories can exceed 160 MiB and a single encoded
    // 64 MiB attachment needs roughly 86 MiB before JSON overhead.
    max_file_bytes: 512 * 1024 * 1024,
    max_total_bytes: 1024 * 1024 * 1024,
    max_import_bytes: 512 * 1024 * 1024,
    max_files: 20_000,
    max_entries: 100_000,
    max_records: 5_000_000,
    max_line_bytes: 96 * 1024 * 1024,
    max_directory_depth: 32,
};

struct HistoryScanBudget {
    limits: HistoryScanLimits,
    discovered_files: usize,
    visited_entries: usize,
    opened_files: usize,
    total_bytes: u64,
    import_bytes: u64,
    records: usize,
    file_limit_warned: bool,
    entry_limit_warned: bool,
    total_limit_warned: bool,
    record_limit_warned: bool,
    depth_limit_warned: bool,
    import_limit_exceeded: bool,
    incomplete: bool,
}

impl HistoryScanBudget {
    fn new(limits: HistoryScanLimits) -> Self {
        Self {
            limits,
            discovered_files: 0,
            visited_entries: 0,
            opened_files: 0,
            total_bytes: 0,
            import_bytes: 0,
            records: 0,
            file_limit_warned: false,
            entry_limit_warned: false,
            total_limit_warned: false,
            record_limit_warned: false,
            depth_limit_warned: false,
            import_limit_exceeded: false,
            incomplete: false,
        }
    }

    fn discover_file(&mut self, warnings: &mut Vec<String>) -> bool {
        if self.discovered_files >= self.limits.max_files {
            self.incomplete = true;
            if !self.file_limit_warned {
                self.file_limit_warned = true;
                push_warning(
                    warnings,
                    format!(
                        "History scan stopped after {} JSONL files",
                        self.limits.max_files
                    ),
                );
            }
            return false;
        }
        self.discovered_files += 1;
        true
    }

    fn visit_entry(&mut self, warnings: &mut Vec<String>) -> bool {
        if self.visited_entries >= self.limits.max_entries {
            self.incomplete = true;
            if !self.entry_limit_warned {
                self.entry_limit_warned = true;
                push_warning(
                    warnings,
                    format!(
                        "History scan stopped after {} filesystem entries",
                        self.limits.max_entries
                    ),
                );
            }
            return false;
        }
        self.visited_entries += 1;
        true
    }

    fn open_file(&mut self, bytes: u64, warnings: &mut Vec<String>) -> bool {
        if self.opened_files >= self.limits.max_files {
            self.incomplete = true;
            if !self.file_limit_warned {
                self.file_limit_warned = true;
                push_warning(
                    warnings,
                    format!(
                        "History scan stopped after {} JSONL files",
                        self.limits.max_files
                    ),
                );
            }
            return false;
        }
        let Some(total_bytes) = self.total_bytes.checked_add(bytes) else {
            self.incomplete = true;
            if !self.total_limit_warned {
                self.total_limit_warned = true;
                push_warning(warnings, "History scan byte limit was exceeded".to_string());
            }
            return false;
        };
        if total_bytes > self.limits.max_total_bytes {
            self.incomplete = true;
            if !self.total_limit_warned {
                self.total_limit_warned = true;
                push_warning(
                    warnings,
                    format!(
                        "History scan stopped after {} bytes of JSONL data",
                        self.limits.max_total_bytes
                    ),
                );
            }
            return false;
        }
        self.opened_files += 1;
        self.total_bytes = total_bytes;
        true
    }

    fn take_record(&mut self, warnings: &mut Vec<String>) -> bool {
        if self.records >= self.limits.max_records {
            self.incomplete = true;
            if !self.record_limit_warned {
                self.record_limit_warned = true;
                push_warning(
                    warnings,
                    format!(
                        "History scan stopped after {} JSONL records",
                        self.limits.max_records
                    ),
                );
            }
            return false;
        }
        self.records += 1;
        true
    }

    fn take_import_bytes(&mut self, bytes: usize, warnings: &mut Vec<String>) -> bool {
        if self.import_limit_exceeded {
            return false;
        }
        let Some(total_bytes) = self.import_bytes.checked_add(bytes as u64) else {
            self.import_limit_exceeded = true;
            self.incomplete = true;
            push_warning(
                warnings,
                "Selected history exceeds the complete import byte limit".to_string(),
            );
            return false;
        };
        if total_bytes > self.limits.max_import_bytes {
            self.import_limit_exceeded = true;
            self.incomplete = true;
            push_warning(
                warnings,
                format!(
                    "Selected history exceeds the {} byte complete import limit; no partial conversations were imported",
                    self.limits.max_import_bytes
                ),
            );
            return false;
        }
        self.import_bytes = total_bytes;
        true
    }
}

enum BoundedJsonlLine {
    Text { number: usize, text: String },
    TooLong { number: usize },
    InvalidUtf8 { number: usize },
}

struct BoundedJsonlReader {
    reader: BufReader<std::io::Take<File>>,
    max_line_bytes: usize,
    line_number: usize,
}

impl BoundedJsonlReader {
    fn new(file: File, file_bytes: u64, max_line_bytes: usize) -> Self {
        Self {
            reader: BufReader::new(file.take(file_bytes)),
            max_line_bytes,
            line_number: 0,
        }
    }

    fn next_line(&mut self) -> std::io::Result<Option<BoundedJsonlLine>> {
        let Some((mut bytes, too_long)) =
            read_bounded_physical_line(&mut self.reader, self.max_line_bytes)?
        else {
            return Ok(None);
        };
        self.line_number += 1;
        if too_long {
            return Ok(Some(BoundedJsonlLine::TooLong {
                number: self.line_number,
            }));
        }
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        Ok(Some(match String::from_utf8(bytes) {
            Ok(text) => BoundedJsonlLine::Text {
                number: self.line_number,
                text,
            },
            Err(_) => BoundedJsonlLine::InvalidUtf8 {
                number: self.line_number,
            },
        }))
    }
}

fn read_bounded_physical_line(
    reader: &mut impl BufRead,
    max_line_bytes: usize,
) -> std::io::Result<Option<(Vec<u8>, bool)>> {
    let mut line = Vec::new();
    let mut saw_bytes = false;
    let mut too_long = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if saw_bytes {
                Ok(Some((line, too_long)))
            } else {
                Ok(None)
            };
        }
        saw_bytes = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content = newline.map_or(available, |index| &available[..index]);
        if !too_long {
            let remaining = max_line_bytes.saturating_sub(line.len());
            if content.len() <= remaining {
                line.extend_from_slice(content);
            } else {
                line.extend_from_slice(&content[..remaining]);
                too_long = true;
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(Some((line, too_long)));
        }
    }
}

fn open_bounded_jsonl_reader(
    path: &Path,
    label: &str,
    warnings: &mut Vec<String>,
    budget: &mut HistoryScanBudget,
) -> Option<BoundedJsonlReader> {
    let path_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            budget.incomplete = true;
            push_warning(
                warnings,
                format!("Could not inspect {label} {}: {error}", path.display()),
            );
            return None;
        }
    };
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        budget.incomplete = true;
        push_warning(
            warnings,
            format!("Skipped non-regular {label} {}", path.display()),
        );
        return None;
    }
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            budget.incomplete = true;
            push_warning(
                warnings,
                format!("Could not read {label} {}: {error}", path.display()),
            );
            return None;
        }
    };
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => {
            budget.incomplete = true;
            push_warning(
                warnings,
                format!(
                    "Could not inspect opened {label} {}: {error}",
                    path.display()
                ),
            );
            return None;
        }
    };
    if !metadata.is_file() {
        budget.incomplete = true;
        push_warning(
            warnings,
            format!("Skipped non-regular {label} {}", path.display()),
        );
        return None;
    }
    if metadata.len() > budget.limits.max_file_bytes {
        budget.incomplete = true;
        push_warning(
            warnings,
            format!(
                "Skipped {label} {} because it exceeds the {} byte file limit",
                path.display(),
                budget.limits.max_file_bytes
            ),
        );
        return None;
    }
    if !budget.open_file(metadata.len(), warnings) {
        return None;
    }
    Some(BoundedJsonlReader::new(
        file,
        metadata.len(),
        budget.limits.max_line_bytes,
    ))
}

fn next_bounded_jsonl_line(
    reader: &mut BoundedJsonlReader,
    path: &Path,
    label: &str,
    warnings: &mut Vec<String>,
    budget: &mut HistoryScanBudget,
) -> Option<(usize, String)> {
    loop {
        if !budget.take_record(warnings) {
            return None;
        }
        match reader.next_line() {
            Ok(Some(BoundedJsonlLine::Text { number, text })) => return Some((number, text)),
            Ok(Some(BoundedJsonlLine::TooLong { number })) => {
                budget.incomplete = true;
                push_warning(
                    warnings,
                    format!(
                        "Skipped overlong {label} line {}:{} (limit: {} bytes)",
                        path.display(),
                        number,
                        budget.limits.max_line_bytes
                    ),
                );
            }
            Ok(Some(BoundedJsonlLine::InvalidUtf8 { number })) => {
                budget.incomplete = true;
                push_warning(
                    warnings,
                    format!(
                        "Skipped non-UTF-8 {label} line {}:{}",
                        path.display(),
                        number
                    ),
                );
            }
            Ok(None) => {
                // The record budget is claimed before the read so an absent
                // trailing record must not consume it.
                budget.records = budget.records.saturating_sub(1);
                return None;
            }
            Err(error) => {
                budget.incomplete = true;
                push_warning(
                    warnings,
                    format!("Could not read {label} {}: {error}", path.display()),
                );
                return None;
            }
        }
    }
}


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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    let Some(codex_root) = crate::agent::binary::codex_home_dir() else {
        return Vec::new();
    };
    if !codex_root.exists() {
        return Vec::new();
    }

    let mut budget = HistoryScanBudget::new(HISTORY_SCAN_LIMITS);
    let mut files = Vec::new();
    collect_jsonl_files(
        &codex_root.join("sessions"),
        &mut files,
        warnings,
        &mut budget,
        0,
    );
    collect_jsonl_files(
        &codex_root.join("archived_sessions"),
        &mut files,
        warnings,
        &mut budget,
        0,
    );
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
                &mut budget,
            ));
        } else if let Some(piece) =
            parse_codex_preview_file(&path, fallback_id, warnings, &mut budget)
        {
            pieces.push(piece);
        }
    }

    if include_messages && budget.incomplete {
        return Vec::new();
    }
    let index = read_codex_index(
        &codex_root.join("session_index.jsonl"),
        warnings,
        &mut budget,
    );
    if include_messages && budget.incomplete {
        Vec::new()
    } else {
        assemble_codex_conversations(pieces, &index, include_messages)
    }
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
    let Some(config_dir) = crate::agent::claude::claude_config_dir() else {
        return Vec::new();
    };
    let projects_root = config_dir.join("projects");
    let mut budget = HistoryScanBudget::new(HISTORY_SCAN_LIMITS);
    let mut files = Vec::new();
    collect_jsonl_files(&projects_root, &mut files, warnings, &mut budget, 0);
    files.sort();

    let mut pieces = Vec::new();
    for path in files {
        if include_messages {
            pieces.extend(parse_claude_file_with_options(
                &path,
                true,
                selected_ids,
                warnings,
                &mut budget,
            ));
        } else {
            pieces.extend(parse_claude_preview_file(&path, warnings, &mut budget));
        }
    }
    if include_messages && budget.incomplete {
        return Vec::new();
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
    budget: &mut HistoryScanBudget,
) -> Option<CodexPiece> {
    let mut reader = open_bounded_jsonl_reader(path, "Codex history file", warnings, budget)?;
    let fallback_time = file_modified_millis(path).unwrap_or(0);
    let mut native_session_id = fallback_id;
    let mut rollout_id = None;
    let mut project_path = None;
    let mut created_at = None;
    let mut updated_at = None;
    let mut preview_messages = Vec::new();
    let mut pending_user_message = None;
    let mut found_session_meta = false;

    while let Some((line_number, line)) =
        next_bounded_jsonl_line(&mut reader, path, "Codex history", warnings, budget)
    {
        let line_index = line_number - 1;
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

fn parse_claude_preview_file(
    path: &Path,
    warnings: &mut Vec<String>,
    budget: &mut HistoryScanBudget,
) -> Vec<ClaudePiece> {
    let Some(mut reader) = open_bounded_jsonl_reader(path, "Claude history file", warnings, budget)
    else {
        return Vec::new();
    };
    let fallback_time = file_modified_millis(path).unwrap_or(0);
    let file_session_id = fallback_session_id(path);
    let mut pieces: HashMap<String, ClaudePiece> = HashMap::new();

    while let Some((line_number, line)) =
        next_bounded_jsonl_line(&mut reader, path, "Claude history", warnings, budget)
    {
        let line_index = line_number - 1;
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
    let mut budget = HistoryScanBudget::new(HISTORY_SCAN_LIMITS);
    parse_codex_file_with_options(path, fallback_id, None, &mut warnings, &mut budget)
        .into_iter()
        .next()
}

fn parse_codex_file_with_options(
    path: &Path,
    fallback_id: String,
    selected_ids: Option<&HashSet<String>>,
    warnings: &mut Vec<String>,
    budget: &mut HistoryScanBudget,
) -> Vec<CodexPiece> {
    let Some(mut reader) = open_bounded_jsonl_reader(path, "Codex history file", warnings, budget)
    else {
        return Vec::new();
    };
    let fallback_time = file_modified_millis(path).unwrap_or(0);
    let mut pieces = Vec::new();
    let mut current: Option<PendingCodexPiece> = None;
    let mut pending_user_message: Option<ParsedMessage> = None;
    let source_path = path.to_string_lossy().into_owned();

    while let Some((line_number, line)) =
        next_bounded_jsonl_line(&mut reader, path, "Codex history", warnings, budget)
    {
        let line_index = line_number - 1;
        let counted_for_import = current.is_some();
        if counted_for_import && !budget.take_import_bytes(line.len(), warnings) {
            break;
        }
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
            if !counted_for_import && !budget.take_import_bytes(line.len(), warnings) {
                break;
            }
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
    if budget.incomplete {
        Vec::new()
    } else {
        pieces
    }
}

fn parse_claude_file(path: &Path) -> Vec<ClaudePiece> {
    let mut warnings = Vec::new();
    let mut budget = HistoryScanBudget::new(HISTORY_SCAN_LIMITS);
    parse_claude_file_with_options(path, true, None, &mut warnings, &mut budget)
}

fn parse_claude_file_with_options(
    path: &Path,
    include_messages: bool,
    selected_ids: Option<&HashSet<String>>,
    warnings: &mut Vec<String>,
    budget: &mut HistoryScanBudget,
) -> Vec<ClaudePiece> {
    let Some(mut reader) = open_bounded_jsonl_reader(path, "Claude history file", warnings, budget)
    else {
        return Vec::new();
    };
    let file_session_id = fallback_session_id(path);
    let source_path = path.to_string_lossy().into_owned();
    let mut pieces: HashMap<String, ClaudePiece> = HashMap::new();
    let fallback_time = file_modified_millis(path).unwrap_or(0);

    while let Some((line_number, line)) =
        next_bounded_jsonl_line(&mut reader, path, "Claude history", warnings, budget)
    {
        let line_index = line_number - 1;
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
        if include_messages && !budget.take_import_bytes(line.len(), warnings) {
            break;
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
    if include_messages && budget.incomplete {
        Vec::new()
    } else {
        pieces.into_values().collect()
    }
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

fn read_codex_index(
    path: &Path,
    warnings: &mut Vec<String>,
    budget: &mut HistoryScanBudget,
) -> HashMap<String, (String, i64)> {
    let Some(mut reader) = open_bounded_jsonl_reader(path, "Codex session index", warnings, budget)
    else {
        return HashMap::new();
    };
    let mut index = HashMap::new();
    while let Some((line_number, line)) =
        next_bounded_jsonl_line(&mut reader, path, "Codex session index", warnings, budget)
    {
        let line_index = line_number - 1;
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

fn collect_jsonl_files(
    root: &Path,
    output: &mut Vec<PathBuf>,
    warnings: &mut Vec<String>,
    budget: &mut HistoryScanBudget,
    depth: usize,
) {
    if depth > budget.limits.max_directory_depth {
        budget.incomplete = true;
        if !budget.depth_limit_warned {
            budget.depth_limit_warned = true;
            push_warning(
                warnings,
                format!(
                    "History scan skipped directories deeper than {} levels",
                    budget.limits.max_directory_depth
                ),
            );
        }
        return;
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            budget.incomplete = true;
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
        if !budget.visit_entry(warnings) {
            return;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                budget.incomplete = true;
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
                budget.incomplete = true;
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
            collect_jsonl_files(&path, output, warnings, budget, depth + 1);
        } else if file_type.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
        {
            if budget.discover_file(warnings) {
                output.push(path);
            } else {
                return;
            }
        }
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
