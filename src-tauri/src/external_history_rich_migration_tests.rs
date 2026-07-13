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
                    "id": format!("rollout-{case:03}"),
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
        ImportedTranscriptPart::Image { data_url, .. } if data_url == &image_url
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
        ImportedTranscriptPart::Image { data_url, .. } if data_url == &image_url
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

macro_rules! codex_rich_cases {
    ($(($name:ident, $case:expr)),+ $(,)?) => {
        $(
            #[test]
            fn $name() {
                assert_codex_rich_migration($case);
            }
        )+
        const CODEX_RICH_MIGRATION_CASE_COUNT: usize = [$(stringify!($name)),+].len();
    };
}

macro_rules! claude_rich_cases {
    ($(($name:ident, $case:expr)),+ $(,)?) => {
        $(
            #[test]
            fn $name() {
                assert_claude_rich_migration($case);
            }
        )+
        const CLAUDE_RICH_MIGRATION_CASE_COUNT: usize = [$(stringify!($name)),+].len();
    };
}

codex_rich_cases!(
    (codex_rich_migration_001, 1),
    (codex_rich_migration_002, 2),
    (codex_rich_migration_003, 3),
    (codex_rich_migration_004, 4),
    (codex_rich_migration_005, 5),
    (codex_rich_migration_006, 6),
    (codex_rich_migration_007, 7),
    (codex_rich_migration_008, 8),
    (codex_rich_migration_009, 9),
    (codex_rich_migration_010, 10),
    (codex_rich_migration_011, 11),
    (codex_rich_migration_012, 12),
    (codex_rich_migration_013, 13),
    (codex_rich_migration_014, 14),
    (codex_rich_migration_015, 15),
    (codex_rich_migration_016, 16),
    (codex_rich_migration_017, 17),
    (codex_rich_migration_018, 18),
    (codex_rich_migration_019, 19),
    (codex_rich_migration_020, 20),
    (codex_rich_migration_021, 21),
    (codex_rich_migration_022, 22),
    (codex_rich_migration_023, 23),
    (codex_rich_migration_024, 24),
    (codex_rich_migration_025, 25),
    (codex_rich_migration_026, 26),
    (codex_rich_migration_027, 27),
    (codex_rich_migration_028, 28),
    (codex_rich_migration_029, 29),
    (codex_rich_migration_030, 30),
    (codex_rich_migration_031, 31),
    (codex_rich_migration_032, 32),
    (codex_rich_migration_033, 33),
    (codex_rich_migration_034, 34),
    (codex_rich_migration_035, 35),
    (codex_rich_migration_036, 36),
    (codex_rich_migration_037, 37),
    (codex_rich_migration_038, 38),
    (codex_rich_migration_039, 39),
    (codex_rich_migration_040, 40),
    (codex_rich_migration_041, 41),
    (codex_rich_migration_042, 42),
    (codex_rich_migration_043, 43),
    (codex_rich_migration_044, 44),
    (codex_rich_migration_045, 45),
    (codex_rich_migration_046, 46),
    (codex_rich_migration_047, 47),
    (codex_rich_migration_048, 48),
    (codex_rich_migration_049, 49),
    (codex_rich_migration_050, 50),
);

claude_rich_cases!(
    (claude_rich_migration_051, 51),
    (claude_rich_migration_052, 52),
    (claude_rich_migration_053, 53),
    (claude_rich_migration_054, 54),
    (claude_rich_migration_055, 55),
    (claude_rich_migration_056, 56),
    (claude_rich_migration_057, 57),
    (claude_rich_migration_058, 58),
    (claude_rich_migration_059, 59),
    (claude_rich_migration_060, 60),
    (claude_rich_migration_061, 61),
    (claude_rich_migration_062, 62),
    (claude_rich_migration_063, 63),
    (claude_rich_migration_064, 64),
    (claude_rich_migration_065, 65),
    (claude_rich_migration_066, 66),
    (claude_rich_migration_067, 67),
    (claude_rich_migration_068, 68),
    (claude_rich_migration_069, 69),
    (claude_rich_migration_070, 70),
    (claude_rich_migration_071, 71),
    (claude_rich_migration_072, 72),
    (claude_rich_migration_073, 73),
    (claude_rich_migration_074, 74),
    (claude_rich_migration_075, 75),
    (claude_rich_migration_076, 76),
    (claude_rich_migration_077, 77),
    (claude_rich_migration_078, 78),
    (claude_rich_migration_079, 79),
    (claude_rich_migration_080, 80),
    (claude_rich_migration_081, 81),
    (claude_rich_migration_082, 82),
    (claude_rich_migration_083, 83),
    (claude_rich_migration_084, 84),
    (claude_rich_migration_085, 85),
    (claude_rich_migration_086, 86),
    (claude_rich_migration_087, 87),
    (claude_rich_migration_088, 88),
    (claude_rich_migration_089, 89),
    (claude_rich_migration_090, 90),
    (claude_rich_migration_091, 91),
    (claude_rich_migration_092, 92),
    (claude_rich_migration_093, 93),
    (claude_rich_migration_094, 94),
    (claude_rich_migration_095, 95),
    (claude_rich_migration_096, 96),
    (claude_rich_migration_097, 97),
    (claude_rich_migration_098, 98),
    (claude_rich_migration_099, 99),
    (claude_rich_migration_100, 100),
);

const _: [(); 100] = [(); CODEX_RICH_MIGRATION_CASE_COUNT + CLAUDE_RICH_MIGRATION_CASE_COUNT];
