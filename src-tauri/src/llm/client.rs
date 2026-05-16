use super::prompt;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct GlobalLlmSettings {
    pub base_url: String,
    pub api_key: String,
    pub nickname: String,
    pub system_prompt: String,
    /// "openai" / "deepseek" / "moonshot" / "qwen" / "zhipu" / "custom" 等。
    /// 仅用作前端 UI hint，后端 chat_completion 用的是 OpenAI 兼容格式，
    /// 真正决定行为的是 base_url + model + thinking。
    pub provider: String,
    /// 模型 ID，如 "deepseek-chat" / "deepseek-reasoner" / "gpt-4o-mini"。
    pub model: String,
    /// 思考模式（reasoning / chain-of-thought），默认关。
    /// 启用时 chat body 里加 `enable_thinking: true` 字段——DeepSeek 等服务商
    /// 识别它启用 reasoning_content；OpenAI 等忽略未知字段，无害。
    pub thinking: bool,
    /// "转换为英文输入"开关，默认关。
    /// 关：直接把用户中文 prompt 喂给 agent；agent 输出预期也是中文，跳过
    ///     translate_en_to_zh，summary 仍然跑（凉宫春日风格化总结）。
    /// 开：translate_zh_to_en 把 prompt 翻成英文喂给 agent；agent 英文输出
    ///     再 translate_en_to_zh 翻回中文 + summary。整套流程下能让 agent
    ///     更稳定（一些模型在英文上表现更好），但代价是多两次翻译延迟。
    pub translate_input: bool,
}

static GLOBAL_LLM_SETTINGS: OnceLock<Mutex<GlobalLlmSettings>> = OnceLock::new();

fn get_global_settings() -> &'static Mutex<GlobalLlmSettings> {
    GLOBAL_LLM_SETTINGS.get_or_init(|| Mutex::new(GlobalLlmSettings::default()))
}

#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub thinking: bool,
    /// 是否启用"转换为英文输入"流程；调用方读这个决定要不要跑两次翻译
    pub translate_input: bool,
}

#[allow(clippy::too_many_arguments)]
pub fn update_global_settings(
    base_url: String,
    api_key: String,
    nickname: String,
    system_prompt: String,
    provider: String,
    model: String,
    thinking: bool,
    translate_input: bool,
) {
    if let Ok(mut settings) = get_global_settings().lock() {
        if !base_url.is_empty() {
            settings.base_url = base_url;
        }
        if !api_key.is_empty() {
            settings.api_key = api_key;
        }
        settings.nickname = nickname;
        settings.system_prompt = system_prompt;
        settings.provider = provider;
        if !model.is_empty() {
            settings.model = model;
        }
        settings.thinking = thinking;
        settings.translate_input = translate_input;
    }
}

pub fn load_llm_config() -> Option<LlmConfig> {
    let mut api_key = String::new();
    let mut base_url = String::new();
    let mut model = String::new();
    let mut thinking = false;
    let mut translate_input = false;

    if let Ok(settings) = get_global_settings().lock() {
        api_key = settings.api_key.clone();
        base_url = settings.base_url.clone();
        model = settings.model.clone();
        thinking = settings.thinking;
        translate_input = settings.translate_input;
    }

    if api_key.is_empty() {
        api_key = std::env::var("LLM_API_KEY").ok()?.trim().to_string();
    }
    if api_key.is_empty() {
        return None;
    }

    if base_url.is_empty() {
        base_url = std::env::var("LLM_BASE_URL")
            .unwrap_or_else(|_| "https://api.openai.com/v1".to_string())
            .trim_end_matches('/')
            .to_string();
    }
    if model.is_empty() {
        model = std::env::var("LLM_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string());
    }
    Some(LlmConfig {
        base_url,
        api_key,
        model,
        thinking,
        translate_input,
    })
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    temperature: f32,
    /// DeepSeek 等服务商识别此字段开启 reasoning；OpenAI 兼容服务忽略未知字段。
    /// 只在用户开启思考模式时序列化（false 时跳过避免改变 default 行为）。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    enable_thinking: bool,
}

#[derive(Serialize)]
struct Message<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: RespMessage,
}

#[derive(Deserialize)]
struct RespMessage {
    content: String,
}

fn chat_completion(
    cfg: &LlmConfig,
    base_system: &str,
    user: &str,
    thinking_override: Option<bool>,
) -> Result<String, String> {
    let effective_thinking = thinking_override.unwrap_or(cfg.thinking);
    let client = http_client()?;
    let url = format!("{}/chat/completions", cfg.base_url);

    let mut custom_system = String::new();
    if let Ok(settings) = get_global_settings().lock() {
        let nickname = if settings.nickname.is_empty() {
            "部员"
        } else {
            &settings.nickname
        };
        if !settings.system_prompt.is_empty() {
            custom_system = format!(
                "用户称呼：{}\n用户设定的悄悄话(系统提示词)：{}\n\n---\n",
                nickname, settings.system_prompt
            );
        } else {
            custom_system = format!("用户称呼：{}\n\n---\n", nickname);
        }
    }
    let final_system = format!("{}{}", custom_system, base_system);

    let body = ChatRequest {
        model: &cfg.model,
        messages: vec![
            Message {
                role: "system",
                content: &final_system,
            },
            Message {
                role: "user",
                content: user,
            },
        ],
        temperature: 0.3,
        enable_thinking: effective_thinking,
    };
    eprintln!(
        "[llm] POST {} model={} thinking={} prompt_chars={}",
        url,
        cfg.model,
        effective_thinking,
        user.chars().count()
    );
    let started = std::time::Instant::now();
    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| {
            eprintln!("[llm] send error: {}", e);
            e.to_string()
        })?;
    let status = res.status();
    let txt = res.text().map_err(|e| e.to_string())?;
    eprintln!(
        "[llm] response {} in {}ms (body_len={})",
        status,
        started.elapsed().as_millis(),
        txt.len()
    );
    if !status.is_success() {
        return Err(format!("LLM HTTP {}: {}", status, txt));
    }
    let parsed: ChatResponse = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Empty LLM response".to_string())
}

pub fn translate_zh_to_en(cfg: &LlmConfig, text: &str) -> Result<String, String> {
    // 翻译是机械任务，强制关思考——否则 DeepSeek 等会把简单翻译当 reasoning 跑
    // 几十秒，整个 launch 卡住没反馈。
    chat_completion(cfg, prompt::translate_zh_to_en_system(), text, Some(false))
}

/// 生成进入软件时的欢迎语。
/// persona 非空时整段替换凉宫人设；空时用默认凉宫风。
/// nickname 是给 LLM 的"用户称呼"，可空（则不提及具体称呼）。
/// 调用方负责 LLM 配置存在性检查；本函数失败时返回 Err，前端回退到默认 GREETINGS。
pub fn generate_welcome_speech(
    cfg: &LlmConfig,
    persona: Option<&str>,
    nickname: Option<&str>,
) -> Result<String, String> {
    let system = prompt::welcome_speech_system_prompt(persona);
    let user_msg = match nickname.map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => format!("用户称呼：{}\n请给我生成一句开场欢迎语。", n),
        None => "请给我生成一句开场欢迎语。".to_string(),
    };
    // 欢迎语是机械生成，强制关思考避免 reasoning model 跑几十秒
    let text = chat_completion(cfg, &system, &user_msg, Some(false))?;
    // 兜底清理：去引号 / 代码围栏；超长截断到 40 字防 LLM 不听话
    let cleaned = text
        .trim()
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim_matches(|c: char| c == '"' || c == '\u{201c}' || c == '\u{201d}' || c == '\u{2018}' || c == '\u{2019}')
        .trim()
        .to_string();
    if cleaned.is_empty() {
        return Err("LLM 返回空欢迎语".to_string());
    }
    let chars: Vec<char> = cleaned.chars().collect();
    if chars.len() > 40 {
        let truncated: String = chars.iter().take(40).collect::<String>() + "…";
        return Ok(truncated);
    }
    Ok(cleaned)
}

pub fn translate_en_to_zh(cfg: &LlmConfig, text: &str) -> Result<String, String> {
    chat_completion(cfg, prompt::translate_en_to_zh_system(), text, Some(false))
}

/// 给 LLM 用的 diff 字符长度上限。大 diff（几千行）一股脑塞 LLM 会触发服务商
/// max tokens 限制 / 响应慢 / 费钱；把超长部分中间截掉，保留头尾让 LLM 拿主旨。
const COMMIT_MSG_DIFF_LIMIT: usize = 8000;

/// 用于 LLM commit message 生成的 diff 预处理：
///   - 短于 limit → 原样返回
///   - 长于 limit → 保留 头 2/3 + "（中间省略 N 字符）" + 尾 1/3，确保 LLM 能看到
///     diff 的开头（典型 hunk header + import 变化）和结尾（典型函数体改动）
///
/// 用 char 而不是 byte 计数，避免在多字节 UTF-8 字符中间切断造成乱码。
pub fn truncate_diff_for_llm(diff: &str, max_chars: usize) -> String {
    let total: Vec<char> = diff.chars().collect();
    if total.len() <= max_chars {
        return diff.to_string();
    }
    // 保留头部 2/3 + 尾部 1/3；中间用占位提示总省略了多少字符
    let head_size = (max_chars * 2) / 3;
    let tail_size = max_chars - head_size;
    let omitted = total.len() - head_size - tail_size;
    let head: String = total[..head_size].iter().collect();
    let tail: String = total[total.len() - tail_size..].iter().collect();
    format!(
        "{}\n\n... (省略中间 {} 字符) ...\n\n{}",
        head, omitted, tail
    )
}

#[cfg(test)]
mod truncate_tests {
    use super::truncate_diff_for_llm;

    #[test]
    fn short_diff_is_unchanged() {
        let short = "abcdef";
        assert_eq!(truncate_diff_for_llm(short, 100), short);
    }

    #[test]
    fn diff_at_exact_limit_is_unchanged() {
        let s: String = "x".repeat(100);
        assert_eq!(truncate_diff_for_llm(&s, 100), s);
    }

    #[test]
    fn diff_longer_than_limit_is_truncated_with_omission_marker() {
        let s: String = "y".repeat(500);
        let out = truncate_diff_for_llm(&s, 100);
        assert!(out.contains("省略中间"));
        // 头 + 尾保留共 max_chars 个字符；占位文本"... (省略中间 N 字符) ..."另算
        assert!(out.len() > 100);
        // 头部应该是 'y'（66 个）开头，尾部也是 'y'（34 个）结尾
        assert!(out.starts_with("yyyy"));
        assert!(out.ends_with("yyyy"));
    }

    #[test]
    fn truncation_omitted_count_is_correct() {
        let s: String = "z".repeat(1000);
        let out = truncate_diff_for_llm(&s, 100);
        // 1000 - 100 = 900 被省略
        assert!(out.contains("省略中间 900"));
    }

    #[test]
    fn multibyte_chars_not_split_in_middle() {
        // 用中文（每字符 3 字节）确保 char 边界而不是 byte 边界切断
        let chinese: String = "中".repeat(500);
        let out = truncate_diff_for_llm(&chinese, 60);
        // 输出能正常作为 UTF-8 字符串使用 = 没切到字符中间
        assert!(out.contains("中"));
        assert!(out.contains("省略中间"));
        // 字节计算来自 char 数：60 个"中"被保留 → ≥180 bytes（不算占位）
        let chars_count = out.chars().count();
        assert!(chars_count > 60); // 含占位文本
    }

    #[test]
    fn head_tail_split_is_two_thirds_one_third() {
        let s: String = "a".repeat(300);
        let out = truncate_diff_for_llm(&s, 90);
        // max=90 → head=60, tail=30；查 omitted 数：300-90 = 210
        assert!(out.contains("省略中间 210"));
    }
}

/// 基于 staged diff 让 LLM 生成中文 conventional commit message。
/// 调用方负责先验证 diff 非空 + 已加载 LlmConfig。
pub fn generate_commit_message(cfg: &LlmConfig, diff: &str) -> Result<String, String> {
    if diff.trim().is_empty() {
        return Err("diff 为空，不能生成 commit message".to_string());
    }
    let truncated = truncate_diff_for_llm(diff, COMMIT_MSG_DIFF_LIMIT);
    let system = "你是 git commit 助手。根据用户给的 staged diff 生成一条简洁的中文 \
conventional commit message。要求：\n\
- 第一行格式：<type>: <subject>，subject 中文，30 字以内\n\
- type 必须从这些里选：feat / fix / refactor / docs / test / style / chore / perf\n\
- 若改动复杂可在第三行起加正文，每行不超过 80 字，正文也用中文\n\
- 不要 markdown 代码块包裹（不要 ```），直接输出 commit 内容\n\
- 不要解释、不要前后多余的话、不要在前面写 \"好的\" \"以下是\" 之类\n\
- 不要输出任何评论 / 思考过程，只输出最终 commit 文本";
    let user = format!("以下是 staged diff：\n\n{}", truncated);
    // commit message 生成是机械任务，强制关思考模式——避免某些 reasoning model 把
    // 一行 commit 当 reasoning 跑几十秒
    let raw = chat_completion(cfg, system, &user, Some(false))?;
    // 兜底清理：万一 LLM 没听话裹了 ```，剥掉
    let cleaned = raw
        .trim()
        .trim_start_matches("```text")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .to_string();
    if cleaned.is_empty() {
        return Err("LLM 返回空消息".to_string());
    }
    Ok(cleaned)
}

/// LLM 输出契约用 snake_case（见 prompt 模板里要求的 JSON 结构），
/// 这里直接默认 snake_case，不要加 rename_all。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSummaryResult {
    pub mode: String,
    pub emotion_speech: String,
    pub summary_translation: String,
    pub next_options: Vec<String>,
}

/// 生成凉宫春日风格（或社区图自定义人设）的任务总结。
///
/// `prompt_override`：可选；非空时会**整段替换凉宫春日人设**，输出契约保留。
/// 当用户启用社区桌宠图且该图带 `prompt` 时，前端把 prompt 通过 IPC 透传到此。
pub fn generate_agent_summary(
    cfg: &LlmConfig,
    user_zh: &str,
    agent_output_zh: &str,
    prompt_override: Option<&str>,
) -> Result<AgentSummaryResult, String> {
    let user = format!(
        "【用户原始需求】\n{}\n\n【Agent 输出】\n{}",
        user_zh, agent_output_zh
    );
    let system = prompt::compose_system_prompt(prompt_override);
    let text = chat_completion(cfg, &system, &user, None)?;
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: AgentSummaryResult = serde_json::from_str(cleaned)
        .map_err(|e| format!("JSON Parse Error: {}, Raw: {}", e, cleaned))?;

    Ok(parsed)
}

// ---------------------------------------------------------------------------
// 模型列表拉取（OpenAI 兼容 /v1/models 端点）
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ModelListResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

/// 从给定 `base_url + api_key` 拉取 `GET /v1/models` 列表。
/// DeepSeek / OpenAI / Moonshot / 通义 / 智谱 等都遵循 OpenAI 兼容格式。
/// 返回模型 id 列表（按字典序排序）；服务商如果返回不规范，前端按需 fallback 到手输。
pub fn list_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    if api_key.trim().is_empty() {
        return Err("API Key 为空".into());
    }
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .send()
        .map_err(|e| format!("拉取模型列表失败: {e}"))?;
    let status = res.status();
    let txt = res.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, txt));
    }
    let parsed: ModelListResponse = serde_json::from_str(&txt)
        .map_err(|e| format!("解析模型列表失败: {} / Raw: {}", e, txt.chars().take(200).collect::<String>()))?;
    let mut ids: Vec<String> = parsed.data.into_iter().map(|m| m.id).collect();
    ids.sort();
    Ok(ids)
}
