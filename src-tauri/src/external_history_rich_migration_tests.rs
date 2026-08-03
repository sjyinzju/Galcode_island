use super::*;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

const PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
static FIXTURE_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn write_fixture(source: &str, case: usize, records: Vec<Value>) -> PathBuf {
    let counter = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "galcode-{source}-rich-migration-{}-{case}-{counter}.jsonl",
        std::process::id()
    ));
    let contents = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&path, contents).expect("rich migration fixture should be written");
    path
}

fn round_trip_import(
    source: &str,
    conversation: ParsedConversation,
    case: usize,
) -> ImportedConversation {
    let imported = to_imported_conversation(source, conversation, case as i64);
    let bytes = serde_json::to_vec(&imported).expect("imported conversation should serialize");
    serde_json::from_slice(&bytes).expect("imported conversation should deserialize")
}

fn assert_codex_rich_migration(case: usize) {
    let session_id = format!("codex-rich-{case:03}");
    let call_id = format!("codex-call-{case:03}");
    let user_text = format!("Codex migration text {case:03}");
    let assistant_text = format!("Codex migration answer {case:03}");
    let image_url = format!("data:image/png;base64,{PNG_BASE64}");
    let tool_name = if case % 2 == 0 {
        "shell_command"
    } else {
        "apply_patch"
    };
    let input = json!({
        "case": case,
        "command": format!("verify-codex-{case:03}")
    });
    let output = format!("codex tool result {case:03}");
    let (output_type, call_payload) = if case % 2 == 0 {
        (
            "function_call_output",
            json!({
                "type": "function_call",
                "name": tool_name,
                "arguments": input.to_string(),
                "call_id": call_id
            }),
        )
    } else {
        (
            "custom_tool_call_output",
            json!({
                "type": "custom_tool_call",
                "name": tool_name,
                "input": input.to_string(),
                "call_id": call_id
            }),
        )
    };
    let path = write_fixture(
        "codex",
        case,
        vec![
            json!({
                "timestamp": case as i64 * 10,
                "type": "session_meta",
                "payload": {
                    "session_id": session_id,
                    "id": session_id,
                    "thread_source": "user",
                    "cwd": format!("C:/codex/{case:03}")
                }
            }),
            json!({
                "timestamp": case as i64 * 10 + 1,
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": user_text},
                        {"type": "input_image", "image_url": image_url}
                    ]
                }
            }),
            json!({
                "timestamp": case as i64 * 10 + 2,
                "type": "response_item",
                "payload": call_payload
            }),
            json!({
                "timestamp": case as i64 * 10 + 3,
                "type": "response_item",
                "payload": {
                    "type": output_type,
                    "call_id": call_id,
                    "output": output
                }
            }),
            json!({
                "timestamp": case as i64 * 10 + 4,
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": assistant_text}]
                }
            }),
        ],
    );

    let piece = parse_codex_file(&path, format!("fallback-{case:03}"))
        .expect("Codex rich fixture should parse");
    assert_eq!(piece.native_session_id, session_id);
    let mut conversations = assemble_codex_conversations(vec![piece], &HashMap::new(), true);
    assert_eq!(conversations.len(), 1);
    let imported = round_trip_import(CODEX_SOURCE, conversations.remove(0), case);

    assert_eq!(imported.messages.len(), 4);
    assert_eq!(imported.messages[0].role, "user");
    assert_eq!(
        imported.messages[0].content,
        format!("{user_text}\n\n[Image]")
    );
    assert!(matches!(
        &imported.messages[0].parts[0],
        ImportedTranscriptPart::Text { text } if text == &user_text
    ));
    assert!(matches!(
        &imported.messages[0].parts[1],
        ImportedTranscriptPart::Image { data_url, .. } if data_url.as_deref() == Some(image_url.as_str())
    ));
    assert!(matches!(
        &imported.messages[1].parts[0],
        ImportedTranscriptPart::ToolCall {
            tool_call_id,
            name,
            input: migrated_input,
        } if tool_call_id.as_deref() == Some(call_id.as_str())
            && name == tool_name
            && migrated_input == &input
    ));
    assert_eq!(imported.messages[2].role, "tool");
    assert!(matches!(
        &imported.messages[2].parts[0],
        ImportedTranscriptPart::ToolResult {
            tool_call_id,
            output: migrated_output,
            is_error: false,
        } if tool_call_id.as_deref() == Some(call_id.as_str())
            && migrated_output == &Value::String(output)
    ));
    assert!(matches!(
        &imported.messages[3].parts[0],
        ImportedTranscriptPart::Text { text } if text == &assistant_text
    ));
    fs::remove_file(path).ok();
}

fn assert_claude_rich_migration(case: usize) {
    let session_id = format!("claude-rich-{case:03}");
    let call_id = format!("claude-call-{case:03}");
    let user_text = format!("Claude migration text {case:03}");
    let assistant_text = format!("Claude migration answer {case:03}");
    let input = json!({
        "case": case,
        "file_path": format!("C:/claude/{case:03}.txt")
    });
    let output = format!("claude tool result {case:03}");
    let path = write_fixture(
        "claude",
        case,
        vec![
            json!({
                "timestamp": case as i64 * 10,
                "type": "user",
                "sessionId": session_id,
                "cwd": format!("C:/claude/{case:03}"),
                "message": {
                    "content": [
                        {"type": "text", "text": user_text},
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": PNG_BASE64
                            }
                        }
                    ]
                }
            }),
            json!({
                "timestamp": case as i64 * 10 + 1,
                "type": "assistant",
                "sessionId": session_id,
                "cwd": format!("C:/claude/{case:03}"),
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": call_id,
                            "name": "Write",
                            "input": input
                        },
                        {"type": "text", "text": assistant_text}
                    ]
                }
            }),
            json!({
                "timestamp": case as i64 * 10 + 2,
                "type": "user",
                "sessionId": session_id,
                "cwd": format!("C:/claude/{case:03}"),
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": call_id,
                        "content": output,
                        "is_error": false
                    }]
                }
            }),
        ],
    );

    let pieces = parse_claude_file(&path);
    assert_eq!(pieces.len(), 1);
    let mut conversations = assemble_claude_conversations(pieces, true);
    assert_eq!(conversations.len(), 1);
    let imported = round_trip_import(CLAUDE_SOURCE, conversations.remove(0), case);
    let image_url = format!("data:image/png;base64,{PNG_BASE64}");

    assert_eq!(imported.messages.len(), 3);
    assert_eq!(imported.messages[0].role, "user");
    assert_eq!(
        imported.messages[0].content,
        format!("{user_text}\n\n[Image]")
    );
    assert!(matches!(
        &imported.messages[0].parts[0],
        ImportedTranscriptPart::Text { text } if text == &user_text
    ));
    assert!(matches!(
        &imported.messages[0].parts[1],
        ImportedTranscriptPart::Image { data_url, .. } if data_url.as_deref() == Some(image_url.as_str())
    ));
    assert!(matches!(
        &imported.messages[1].parts[0],
        ImportedTranscriptPart::ToolCall {
            tool_call_id,
            name,
            input: migrated_input,
        } if tool_call_id.as_deref() == Some(call_id.as_str())
            && name == "Write"
            && migrated_input == &input
    ));
    assert!(matches!(
        &imported.messages[1].parts[1],
        ImportedTranscriptPart::Text { text } if text == &assistant_text
    ));
    assert!(matches!(
        &imported.messages[2].parts[0],
        ImportedTranscriptPart::ToolResult {
            tool_call_id,
            output: migrated_output,
            is_error: false,
        } if tool_call_id.as_deref() == Some(call_id.as_str())
            && migrated_output == &Value::String(output)
    ));
    fs::remove_file(path).ok();
}

#[test]
fn migrates_representative_codex_rich_transcripts() {
    assert_codex_rich_migration(1);
    assert_codex_rich_migration(2);
}

#[test]
fn migrates_representative_claude_rich_transcript() {
    assert_claude_rich_migration(3);
}

#[test]
fn ignores_empty_message_content() {
    let codex = json!({
        "type": "message",
        "role": "user",
        "content": []
    });
    let claude = json!({ "content": "   " });

    assert!(extract_codex_message(&codex).is_none());
    assert!(extract_claude_message(&claude, "user").is_none());
}

#[test]
fn keeps_messages_without_timestamps() {
    let path = write_fixture(
        "codex-missing-time",
        4,
        vec![
            json!({
                "type": "session_meta",
                "payload": {
                    "session_id": "missing-time",
                    "thread_source": "user"
                }
            }),
            json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "still present" }]
                }
            }),
        ],
    );

    let piece = parse_codex_file(&path, "fallback".to_string())
        .expect("message without timestamp should parse");
    assert_eq!(piece.messages.len(), 1);
    assert_eq!(piece.messages[0].content, "still present");
    assert_eq!(piece.messages[0].timestamp, 0);
    fs::remove_file(path).ok();
}

#[test]
fn compact_title_respects_the_96_character_boundary() {
    let exact = "a".repeat(96);
    let over = format!("{exact}b");

    assert_eq!(compact_title(&exact), exact);
    assert_eq!(compact_title(&over), format!("{}...", "a".repeat(96)));
}

#[test]
fn earliest_and_latest_replacements_resolve_out_of_order_candidates() {
    let mut latest = Some(("middle", 20));
    replace_with_latest(&mut latest, Some(("older", 10)));
    replace_with_latest(&mut latest, Some(("newest", 30)));
    replace_with_latest(&mut latest, Some(("same-time-last", 30)));
    assert_eq!(latest, Some(("same-time-last", 30)));

    let mut earliest = Some(("middle", 20));
    replace_with_earliest(&mut earliest, Some(("newer", 30)));
    replace_with_earliest(&mut earliest, Some(("oldest", 10)));
    replace_with_earliest(&mut earliest, Some(("same-time-ignored", 10)));
    assert_eq!(earliest, Some(("oldest", 10)));
}
