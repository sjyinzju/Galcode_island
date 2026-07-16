pub const APP_COMMANDS: &[&str] = &[
    "select_project_folder",
    "list_directory",
    "validate_directory",
    "list_project_slash_commands",
    "start_agent",
    "stop_agent",
    "respond_permission",
    "respond_permission_decision",
    "get_session_logs",
    "list_sessions",
    "scan_external_sessions",
    "import_external_sessions",
    "list_imported_conversations",
    "load_imported_conversation",
    "load_imported_asset",
    "remove_imported_conversation",
    "finalize_pending",
    "translate_only",
    "generate_welcome_speech",
    "generate_poke_speech",
    "set_click_through",
    "update_llm_settings",
    "update_backend_preferences",
    "list_llm_models",
    "claude_status",
    "claude_models",
    "claude_verify",
    "claude_login_open",
    "claude_run_in_terminal",
    "claude_send_prompt",
    "codex_status",
    "codex_models",
    "codex_verify",
    "codex_login_open",
    "codex_send_prompt",
    "opencode_status",
    "opencode_start",
    "opencode_stop",
    "opencode_create_session",
    "opencode_send_prompt",
    "opencode_set_auth",
    "opencode_login_open",
    "opencode_list_providers",
    "lan_get_state",
    "lan_set_password",
    "lan_clear_password",
    "lan_set_port",
    "lan_set_enabled",
    "lan_revoke_all_devices",
    "lan_sync_projects",
    "lan_list_storage",
    "lan_get_storage",
    "lan_set_storage",
    "lan_remove_storage",
    "git_status",
    "git_diff",
    "git_stage",
    "git_unstage",
    "git_commit",
    "git_push",
    "git_pull",
    "git_discard",
    "git_log",
    "git_show_commit_files",
    "git_show_file_diff",
    "git_generate_commit_message",
    "git_list_branches",
    "git_checkout_branch",
    "git_remote_url",
    "git_pushed_commits",
    "pet_configure",
    "pet_update_snapshot",
    "pet_input",
    "pet_ready",
    "pet_action",
    "set_pet_click_through",
];

#[cfg(test)]
mod tests {
    use super::APP_COMMANDS;
    use std::collections::BTreeSet;

    fn string_permissions(source: &str) -> BTreeSet<String> {
        let value: serde_json::Value = serde_json::from_str(source).expect("valid capability JSON");
        value["permissions"]
            .as_array()
            .expect("permissions array")
            .iter()
            .filter_map(|permission| permission.as_str().map(str::to_string))
            .collect()
    }

    #[test]
    fn acl_command_names_match_invoke_handler() {
        let source = include_str!("lib.rs");
        let body = source
            .split("tauri::generate_handler![")
            .nth(1)
            .and_then(|rest| rest.split("])").next())
            .expect("generate_handler body");
        let handler_names: BTreeSet<&str> = body
            .lines()
            .map(str::trim)
            .filter(|line| line.ends_with(',') && !line.starts_with("//"))
            .map(|line| line.trim_end_matches(',').trim())
            .collect();
        let acl_names: BTreeSet<&str> = APP_COMMANDS.iter().copied().collect();
        assert_eq!(
            handler_names.len(),
            body.lines()
                .filter(|line| {
                    let line = line.trim();
                    line.ends_with(',') && !line.starts_with("//")
                })
                .count(),
            "invoke_handler must not contain duplicate commands"
        );
        assert_eq!(
            acl_names.len(),
            APP_COMMANDS.len(),
            "ACL command list must not contain duplicates"
        );
        assert_eq!(handler_names, acl_names);
    }

    #[test]
    fn capabilities_grant_the_exact_application_command_matrix() {
        let default_source = include_str!("../capabilities/default.json");
        let pet_source = include_str!("../capabilities/pet.json");
        let default_value: serde_json::Value =
            serde_json::from_str(default_source).expect("valid default capability");
        let pet_value: serde_json::Value =
            serde_json::from_str(pet_source).expect("valid pet capability");
        assert_eq!(default_value["windows"], serde_json::json!(["main"]));
        assert_eq!(pet_value["windows"], serde_json::json!(["pet"]));

        let expected_main: BTreeSet<String> = APP_COMMANDS
            .iter()
            .copied()
            .filter(|command| !matches!(*command, "pet_ready" | "pet_action"))
            .map(|command| format!("allow-{}", command.replace('_', "-")))
            .collect();
        let actual_main: BTreeSet<String> = string_permissions(default_source)
            .into_iter()
            .filter(|permission| permission.starts_with("allow-"))
            .collect();
        assert_eq!(actual_main, expected_main);

        let expected_pet: BTreeSet<String> = [
            "core:window:allow-start-dragging",
            "allow-pet-ready",
            "allow-pet-action",
            "allow-set-pet-click-through",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        assert_eq!(string_permissions(pet_source), expected_pet);
    }
}
