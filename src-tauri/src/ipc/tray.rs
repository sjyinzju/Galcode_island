use crate::{pet_state::PetModelId, pet_window};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_i = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let pet_toggle_i = MenuItem::with_id(app, "pet-toggle", "显示/隐藏桌宠", true, None::<&str>)?;
    let pet_click_i = MenuItem::with_id(app, "pet-click", "切换桌宠穿透", true, None::<&str>)?;
    let pet_top_i = MenuItem::with_id(app, "pet-top", "切换桌宠置顶", true, None::<&str>)?;
    let pet_haruhi_i = MenuItem::with_id(app, "pet-haruhi", "桌宠：凉宫春日", true, None::<&str>)?;
    let pet_mikuru_i =
        MenuItem::with_id(app, "pet-mikuru", "桌宠：朝比奈实玖瑠", true, None::<&str>)?;
    let pet_yuki_i = MenuItem::with_id(app, "pet-yuki", "桌宠：长门有希", true, None::<&str>)?;
    let pet_reset_i = MenuItem::with_id(app, "pet-reset", "重置桌宠位置", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_i,
            &pet_toggle_i,
            &pet_click_i,
            &pet_top_i,
            &pet_haruhi_i,
            &pet_mikuru_i,
            &pet_yuki_i,
            &pet_reset_i,
            &quit_i,
        ],
    )?;

    let icon = app
        .default_window_icon()
        .ok_or("missing default window icon")?
        .clone();

    let _tray = TrayIconBuilder::with_id("galcode-tray")
        .icon(icon)
        .tooltip("Galcode Island")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app: &AppHandle, event| {
            let id = event.id.as_ref().to_string();
            if id == "quit" {
                app.exit(0);
                return;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = match id.as_str() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            window
                                .show()
                                .and_then(|_| window.set_focus())
                                .map_err(|error| error.to_string())
                        } else {
                            Ok(())
                        }
                    }
                    "pet-toggle" => pet_window::tray_toggle_visibility(&app),
                    "pet-click" => pet_window::tray_toggle_click_through(&app),
                    "pet-top" => pet_window::tray_toggle_always_on_top(&app),
                    "pet-haruhi" => pet_window::tray_set_model(&app, PetModelId::Haruhi),
                    "pet-mikuru" => pet_window::tray_set_model(&app, PetModelId::Mikuru),
                    "pet-yuki" => pet_window::tray_set_model(&app, PetModelId::Yuki),
                    "pet-reset" => pet_window::tray_reset_position(&app),
                    _ => Ok(()),
                };
                if let Err(error) = result {
                    log::warn!("[tray] desktop pet action failed: {error}");
                }
            });
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
