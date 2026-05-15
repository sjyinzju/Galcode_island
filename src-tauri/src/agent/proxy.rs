// 代理环境变量处理 + 终端命令拼接 + 系统终端打开。
//
// 关键踩坑：
//   - HTTP_PROXY 大小写并存 → apply_proxy_env 一次性覆盖 8 个变量
//   - SOCKS5 代理 → http/all_proxy 用不同 scheme 才能让不同 CLI 都能识别
//   - Windows cmd /K 与 Unix osascript 终端拉起方式完全不同 → cfg 分发

use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ---------------------------------------------------------------------------
// 代理环境变量
// ---------------------------------------------------------------------------

pub fn merge_no_proxy() -> String {
    let existing_no_proxy = std::env::var("NO_PROXY").unwrap_or_default();
    let base_no_proxy = "127.0.0.1,localhost";
    if existing_no_proxy.trim().is_empty() {
        base_no_proxy.to_string()
    } else if existing_no_proxy.contains("127.0.0.1") || existing_no_proxy.contains("localhost") {
        existing_no_proxy
    } else {
        format!("{base_no_proxy},{}", existing_no_proxy)
    }
}

pub fn resolve_proxy_value(proxy: Option<&str>) -> Option<String> {
    proxy
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub fn replace_proxy_scheme(proxy_url: &str, scheme: &str) -> String {
    if let Some((_current_scheme, rest)) = proxy_url.split_once("://") {
        format!("{scheme}://{rest}")
    } else {
        format!("{scheme}://{proxy_url}")
    }
}

pub fn resolve_proxy_urls(proxy: Option<&str>) -> Option<(String, String)> {
    let proxy_url = resolve_proxy_value(proxy)?;
    let lower = proxy_url.to_ascii_lowercase();

    let (http_proxy_url, socks_proxy_url) = if lower.starts_with("socks5://")
        || lower.starts_with("socks5h://")
        || lower.starts_with("socks://")
    {
        (
            replace_proxy_scheme(&proxy_url, "http"),
            replace_proxy_scheme(&proxy_url, "socks5"),
        )
    } else if lower.starts_with("http://") || lower.starts_with("https://") {
        (proxy_url.clone(), replace_proxy_scheme(&proxy_url, "socks5"))
    } else {
        (
            format!("http://{proxy_url}"),
            format!("socks5://{proxy_url}"),
        )
    };

    Some((http_proxy_url, socks_proxy_url))
}

pub fn clear_proxy_env(command: &mut Command) {
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        command.env_remove(key);
    }
}

pub fn apply_proxy_env(command: &mut Command, proxy: Option<&str>) {
    clear_proxy_env(command);
    if let Some((http_proxy_url, socks_proxy_url)) = resolve_proxy_urls(proxy) {
        let no_proxy = merge_no_proxy();
        command.env("HTTP_PROXY", &http_proxy_url);
        command.env("HTTPS_PROXY", &http_proxy_url);
        command.env("ALL_PROXY", &socks_proxy_url);
        command.env("http_proxy", &http_proxy_url);
        command.env("https_proxy", &http_proxy_url);
        command.env("all_proxy", &socks_proxy_url);
        command.env("NO_PROXY", &no_proxy);
        command.env("no_proxy", &no_proxy);
    }
}

// ---------------------------------------------------------------------------
// 终端命令拼接（用于 open_terminal_command）
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
pub fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// 剥掉 Windows 扩展长度路径前缀 (`\\?\`)，返回 cmd.exe 能解析的常规路径。
///
/// Tauri 在 Windows 上 `resource_dir()` 返回的路径常常带 `\\?\` 前缀（CreateFile
/// 长路径绕过 MAX_PATH 限制），但 cmd.exe 的命令行解析器不认这种前缀，把
/// `"\\?\E:\...\claude.exe"` 当 /K 的可执行参数传过去会报"不是内部或外部命令"。
///
/// Rust 自身 `Command::new(path)` 走 CreateProcessW 能吃下这种前缀，所以只在
/// **通过 cmd.exe 中转**的终端启动路径上需要剥前缀。
///
/// 处理两种形态：
/// - `\\?\C:\foo\bar` → `C:\foo\bar`
/// - `\\?\UNC\server\share\foo` → `\\server\share\foo`
#[cfg(target_os = "windows")]
pub fn simplify_windows_path(value: &str) -> std::borrow::Cow<'_, str> {
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return std::borrow::Cow::Owned(format!(r"\\{rest}"));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return std::borrow::Cow::Borrowed(rest);
    }
    std::borrow::Cow::Borrowed(value)
}

#[cfg(target_os = "windows")]
pub fn terminal_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(not(target_os = "windows"))]
pub fn terminal_quote(value: &str) -> String {
    shell_single_quote(value)
}

#[cfg(target_os = "windows")]
pub fn terminal_env_assignment(key: &str, value: &str) -> String {
    format!(
        "set \"{key}={}\"",
        value.replace('%', "%%").replace('"', "\"\"")
    )
}

pub fn shell_command_text(
    binary: &Path,
    leading_args: &[String],
    trailing_args: &[String],
) -> String {
    let mut parts = Vec::with_capacity(2 + leading_args.len() + trailing_args.len());

    #[cfg(target_os = "windows")]
    {
        let needs_call = binary
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
        if needs_call {
            parts.push("call".to_string());
        }
    }

    // cmd.exe 不认 `\\?\` 扩展长度路径前缀，必须剥掉再传过去。
    // 非 Windows 平台 simplify_windows_path 不存在；不过路径本来也不会带这种前缀。
    let binary_display = binary.display().to_string();
    #[cfg(target_os = "windows")]
    let binary_display = simplify_windows_path(&binary_display).into_owned();

    parts.push(terminal_quote(&binary_display));
    parts.extend(leading_args.iter().map(|value| terminal_quote(value)));
    parts.extend(trailing_args.iter().map(|value| terminal_quote(value)));
    parts.join(" ")
}

pub fn proxy_env_prefix(proxy: Option<&str>) -> String {
    #[cfg(target_os = "windows")]
    {
        return resolve_proxy_value(proxy)
            .map(|proxy_url| {
                let no_proxy = merge_no_proxy();
                [
                    terminal_env_assignment("HTTP_PROXY", &proxy_url),
                    terminal_env_assignment("HTTPS_PROXY", &proxy_url),
                    terminal_env_assignment("ALL_PROXY", &proxy_url),
                    terminal_env_assignment("http_proxy", &proxy_url),
                    terminal_env_assignment("https_proxy", &proxy_url),
                    terminal_env_assignment("all_proxy", &proxy_url),
                    terminal_env_assignment("NO_PROXY", &no_proxy),
                    terminal_env_assignment("no_proxy", &no_proxy),
                ]
                .join(" && ")
                    + " && "
            })
            .unwrap_or_default();
    }

    #[cfg(not(target_os = "windows"))]
    resolve_proxy_urls(proxy)
        .map(|(http_proxy_url, socks_proxy_url)| {
            let no_proxy = merge_no_proxy();
            format!(
                "HTTP_PROXY={} HTTPS_PROXY={} ALL_PROXY={} http_proxy={} https_proxy={} all_proxy={} NO_PROXY={} no_proxy={} ",
                shell_single_quote(&http_proxy_url),
                shell_single_quote(&http_proxy_url),
                shell_single_quote(&socks_proxy_url),
                shell_single_quote(&http_proxy_url),
                shell_single_quote(&http_proxy_url),
                shell_single_quote(&socks_proxy_url),
                shell_single_quote(&no_proxy),
                shell_single_quote(&no_proxy)
            )
        })
        .unwrap_or_default()
}

pub fn open_terminal_command(command_text: &str, success_message: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "tell application \"Terminal\" to do script {}",
                serde_json::to_string(command_text)
                    .map_err(|error| format!("Failed to encode terminal command: {error}"))?
            ))
            .arg("-e")
            .arg("tell application \"Terminal\" to activate")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Failed to open terminal: {error}"))?;

        return Ok(success_message.to_string());
    }

    #[cfg(target_os = "windows")]
    {
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let mut command = Command::new("cmd.exe");
        command.creation_flags(CREATE_NEW_CONSOLE);
        command
            .args(["/D", "/K", command_text])
            .spawn()
            .map_err(|error| format!("Failed to open terminal: {error}"))?;
        return Ok(success_message.to_string());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("x-terminal-emulator")
            .arg("-e")
            .arg(command_text)
            .spawn()
            .map_err(|error| format!("Failed to open terminal: {error}"))?;
        return Ok(success_message.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[cfg(target_os = "windows")]
    #[test]
    fn simplify_strips_dos_device_prefix() {
        assert_eq!(
            simplify_windows_path(r"\\?\E:\app\claude.exe"),
            r"E:\app\claude.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn simplify_strips_unc_prefix() {
        assert_eq!(
            simplify_windows_path(r"\\?\UNC\server\share\bin\claude.exe"),
            r"\\server\share\bin\claude.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn simplify_leaves_normal_path() {
        assert_eq!(
            simplify_windows_path(r"C:\Program Files\claude\claude.exe"),
            r"C:\Program Files\claude\claude.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn shell_command_text_drops_extended_prefix() {
        let path = PathBuf::from(r"\\?\E:\app\claude.exe");
        let text = shell_command_text(
            &path,
            &[],
            &["auth".to_string(), "login".to_string()],
        );
        assert!(!text.contains(r"\\?\"), "extended prefix should be stripped: {text}");
        assert!(text.contains(r"E:\app\claude.exe"));
        assert!(text.ends_with(r#" "auth" "login""#));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn shell_command_text_keeps_call_prefix_for_cmd() {
        let path = PathBuf::from(r"\\?\C:\bin\claude.cmd");
        let text = shell_command_text(&path, &[], &[]);
        assert!(text.starts_with("call "), "got: {text}");
        assert!(!text.contains(r"\\?\"));
    }
}
