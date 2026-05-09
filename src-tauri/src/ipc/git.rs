// Git 面板用的 IPC 命令集合：直接调系统 git CLI（不引入 git2 crate，
// 避免链接 libgit2 + 依赖体积膨胀；用户机器有 git 是开发软件的合理假设）。
//
// 命令统一约定：
//   - 入参 `cwd` 为绝对路径（前端 active tab 的 projectPath）
//   - 失败时把 stderr 作为 Err 返回；成功时返回结构化 JSON
//
// 不做 hooks 解析、不做 tag/rebase 等高级流程；当前面板需求是
//   状态、diff、stage/unstage、commit、push、pull —— 够用即可。

use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// 跑 `git <args...>`，cwd 切到工作目录；返回 (exit_ok, stdout, stderr)。
fn run_git(cwd: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let path = Path::new(cwd);
    if !path.exists() {
        return Err(format!("目录不存在: {cwd}"));
    }
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .map_err(|e| format!("启动 git 失败: {e}（请确认系统已安装 git）"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((output.status.success(), stdout, stderr))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    /// 相对仓库根的路径
    pub path: String,
    /// 索引区状态字符（M / A / D / R / ? / 空格 等）
    pub index_status: String,
    /// 工作区状态字符
    pub work_status: String,
    /// 是否未跟踪（?? 行）
    pub untracked: bool,
    /// 是否已 staged（index_status 不是空格也不是 ?）
    pub staged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// 是否是 git 仓库（不是的话 files 为空，其他字段尽量给默认）
    pub is_repo: bool,
    /// 当前分支（detached 时为提交哈希前 7 位 + " (detached)"）
    pub branch: String,
    /// 上游分支（origin/main 等），没有就 None
    pub upstream: Option<String>,
    /// 领先 / 落后上游多少 commit
    pub ahead: u32,
    pub behind: u32,
    /// 文件变更列表（含未 stage / 已 stage / 未跟踪）
    pub files: Vec<GitFileEntry>,
}

/// 解析 `git status --porcelain=v2 --branch` 的输出。
fn parse_porcelain_v2(text: &str) -> (String, Option<String>, u32, u32, Vec<GitFileEntry>) {
    let mut branch = String::from("(unknown)");
    let mut upstream: Option<String> = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut files: Vec<GitFileEntry> = Vec::new();

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            // (detached) 时 head 是哈希
            branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            upstream = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // 形如 "+1 -2"
            for tok in rest.split_whitespace() {
                if let Some(stripped) = tok.strip_prefix('+') {
                    ahead = stripped.parse().unwrap_or(0);
                } else if let Some(stripped) = tok.strip_prefix('-') {
                    behind = stripped.parse().unwrap_or(0);
                }
            }
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // 普通改动：`1 XY <sub> <mH> <mI> <mW> <hH> <hI> <path>`
            let mut parts = rest.splitn(8, ' ');
            let xy = parts.next().unwrap_or("..");
            let path = parts.nth(6).unwrap_or("").to_string();
            let chars: Vec<char> = xy.chars().collect();
            let index_status = chars.first().copied().unwrap_or(' ').to_string();
            let work_status = chars.get(1).copied().unwrap_or(' ').to_string();
            let staged = index_status != " " && index_status != "." && index_status != "?";
            files.push(GitFileEntry {
                path,
                index_status,
                work_status,
                untracked: false,
                staged,
            });
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // 重命名 / 复制：`2 XY <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>`
            let mut parts = rest.splitn(9, ' ');
            let xy = parts.next().unwrap_or("..");
            let last = parts.nth(7).unwrap_or("");
            // last 形如 "<path>\t<origPath>"
            let path = last.split('\t').next().unwrap_or("").to_string();
            let chars: Vec<char> = xy.chars().collect();
            let index_status = chars.first().copied().unwrap_or(' ').to_string();
            let work_status = chars.get(1).copied().unwrap_or(' ').to_string();
            let staged = index_status != " " && index_status != "." && index_status != "?";
            files.push(GitFileEntry {
                path,
                index_status,
                work_status,
                untracked: false,
                staged,
            });
        } else if let Some(rest) = line.strip_prefix("? ") {
            // 未跟踪文件
            files.push(GitFileEntry {
                path: rest.trim().to_string(),
                index_status: "?".to_string(),
                work_status: "?".to_string(),
                untracked: true,
                staged: false,
            });
        }
    }

    (branch, upstream, ahead, behind, files)
}

#[tauri::command]
pub fn git_status(cwd: String) -> Result<GitStatus, String> {
    // 先判断是否是仓库
    let (ok, stdout, _stderr) = run_git(&cwd, &["rev-parse", "--is-inside-work-tree"])?;
    if !ok || stdout.trim() != "true" {
        return Ok(GitStatus {
            is_repo: false,
            branch: String::new(),
            upstream: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
        });
    }
    let (ok2, stdout2, stderr2) =
        run_git(&cwd, &["status", "--porcelain=v2", "--branch", "--untracked-files=all"])?;
    if !ok2 {
        return Err(stderr2.trim().to_string());
    }
    let (branch, upstream, ahead, behind, files) = parse_porcelain_v2(&stdout2);
    Ok(GitStatus {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        files,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    /// 完整 diff 文本（unified format）；新文件 / 删除文件也包含
    pub diff: String,
    /// staged 与 unstaged 是否都没内容（前端用来显示"无更改"）
    pub empty: bool,
}

/// 取单个文件的 diff。
/// `staged`=true 时取 `git diff --cached`，否则取工作区 diff。
/// 未跟踪文件单独走 `--no-index /dev/null <file>` 拿到完整新增内容。
#[tauri::command]
pub fn git_diff(cwd: String, path: String, staged: bool, untracked: bool) -> Result<GitDiff, String> {
    if untracked {
        // /dev/null 在 Windows 上是 NUL —— 但 git for windows 也把 /dev/null 翻译过去
        let null_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
        let (_ok, stdout, _stderr) = run_git(
            &cwd,
            &["diff", "--no-index", "--", null_path, &path],
        )?;
        // --no-index 有差异时 exit code = 1，是预期行为，不当 Err
        let empty = stdout.trim().is_empty();
        return Ok(GitDiff { diff: stdout, empty });
    }
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(&path);
    let (ok, stdout, stderr) = run_git(&cwd, &args)?;
    if !ok && !stdout.is_empty() {
        // diff 命令有时返回非零但 stdout 有内容（如二进制提示），不视为错
    } else if !ok && stdout.is_empty() && !stderr.is_empty() {
        return Err(stderr.trim().to_string());
    }
    let empty = stdout.trim().is_empty();
    Ok(GitDiff { diff: stdout, empty })
}

/// `git add -- <paths...>`。空 paths 等价于全 stage（git add -A）。
#[tauri::command]
pub fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let cmd_args: Vec<String> = if paths.is_empty() {
        vec!["add".into(), "-A".into()]
    } else {
        let mut v = vec!["add".to_string(), "--".to_string()];
        v.extend(paths.into_iter());
        v
    };
    let refs: Vec<&str> = cmd_args.iter().map(|s| s.as_str()).collect();
    let (ok, _stdout, stderr) = run_git(&cwd, &refs)?;
    if !ok {
        return Err(stderr.trim().to_string());
    }
    Ok(())
}

/// `git restore --staged -- <paths...>`。空 paths 撤销全部 staged。
#[tauri::command]
pub fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut cmd_args: Vec<String> = vec!["restore".into(), "--staged".into()];
    if paths.is_empty() {
        cmd_args.push(".".into());
    } else {
        cmd_args.push("--".into());
        cmd_args.extend(paths.into_iter());
    }
    let refs: Vec<&str> = cmd_args.iter().map(|s| s.as_str()).collect();
    let (ok, _stdout, stderr) = run_git(&cwd, &refs)?;
    if !ok {
        return Err(stderr.trim().to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub commit_hash: String,
    pub summary: String,
}

/// `git commit -m <message>`。`stage_all=true` 时先 `git add -A`。
#[tauri::command]
pub fn git_commit(
    cwd: String,
    message: String,
    stage_all: Option<bool>,
) -> Result<GitCommitResult, String> {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    if stage_all.unwrap_or(false) {
        let (ok, _o, e) = run_git(&cwd, &["add", "-A"])?;
        if !ok {
            return Err(e.trim().to_string());
        }
    }
    let (ok, stdout, stderr) = run_git(&cwd, &["commit", "-m", message.as_str()])?;
    if !ok {
        let msg = if !stderr.trim().is_empty() {
            stderr
        } else {
            stdout
        };
        return Err(msg.trim().to_string());
    }
    let (_ok2, hash, _e2) = run_git(&cwd, &["rev-parse", "HEAD"])?;
    let (_ok3, subject, _e3) = run_git(&cwd, &["log", "-1", "--pretty=%s"])?;
    Ok(GitCommitResult {
        commit_hash: hash.trim().to_string(),
        summary: subject.trim().to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    pub stdout: String,
    pub stderr: String,
}

/// `git push`。push 失败常见因网络 / 权限 / 上游缺失，把 stderr 透出去给前端展示。
#[tauri::command]
pub fn git_push(cwd: String) -> Result<GitPushResult, String> {
    let (ok, stdout, stderr) = run_git(&cwd, &["push"])?;
    if !ok {
        // stderr 即使在成功时 git 也会写一些 "Everything up-to-date" 之类的提示，
        // 这里只在失败时把 stderr 当错误返回
        let msg = if !stderr.trim().is_empty() {
            stderr
        } else {
            stdout
        };
        return Err(msg.trim().to_string());
    }
    Ok(GitPushResult { stdout, stderr })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPullResult {
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub fn git_pull(cwd: String) -> Result<GitPullResult, String> {
    let (ok, stdout, stderr) = run_git(&cwd, &["pull", "--ff-only"])?;
    if !ok {
        let msg = if !stderr.trim().is_empty() {
            stderr
        } else {
            stdout
        };
        return Err(msg.trim().to_string());
    }
    Ok(GitPullResult { stdout, stderr })
}

/// 丢弃工作区某个文件的改动（`git checkout -- <path>`，未跟踪文件改用删除）。
#[tauri::command]
pub fn git_discard(cwd: String, path: String, untracked: Option<bool>) -> Result<(), String> {
    if untracked.unwrap_or(false) {
        // 未跟踪文件不能用 checkout 还原 —— 直接删
        let full = std::path::Path::new(&cwd).join(&path);
        if full.exists() {
            std::fs::remove_file(&full).map_err(|e| format!("删除 {} 失败: {e}", path))?;
        }
        return Ok(());
    }
    let (ok, _stdout, stderr) = run_git(&cwd, &["checkout", "--", path.as_str()])?;
    if !ok {
        return Err(stderr.trim().to_string());
    }
    Ok(())
}
