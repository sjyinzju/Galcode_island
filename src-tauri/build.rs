mod app_command_names {
    include!("src/app_command_names.rs");
}

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(app_command_names::APP_COMMANDS),
        ),
    )
    .expect("failed to build Tauri application metadata");
}
