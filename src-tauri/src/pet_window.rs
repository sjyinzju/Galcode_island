use crate::pet_global_input::PetGlobalInputMonitor;
use crate::pet_state::{
    DesktopPetSettings, PetAction, PetBridgeEvent, PetBridgeInput, PetBridgeInputSource,
    PetInputEvent, PetModelId, PetRuntimeState, PetSettingsSnapshot, PetSnapshot,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{ErrorKind, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{
    ipc::Channel, AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

pub const PET_WINDOW_LABEL: &str = "pet";
const PET_PAGE: &str = "pet.html";
const PET_ACTION_EVENT: &str = "pet://action";
const PET_PLACEMENT_FILE: &str = "pet-window.json";
const PET_PLACEMENT_VERSION: u8 = 1;
const PET_BASE_WIDTH: f64 = 420.0;
const PET_BASE_HEIGHT: f64 = 560.0;
const PET_MARGIN: f64 = 24.0;
const PET_SAVE_DEBOUNCE_MS: u64 = 300;
const PET_VISIBILITY_GUARD_SECS: u64 = 5;
static PLACEMENT_SAVE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetPlacement {
    version: u8,
    monitor_name: Option<String>,
    offset_x: f64,
    offset_y: f64,
    scale: f64,
}

impl PetPlacement {
    fn is_valid(&self) -> bool {
        self.version == PET_PLACEMENT_VERSION
            && self.offset_x.is_finite()
            && self.offset_y.is_finite()
            && self.offset_x.abs() <= 1_000_000.0
            && self.offset_y.abs() <= 1_000_000.0
            && self.scale.is_finite()
            && (0.6..=1.8).contains(&self.scale)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn monitor_work_area(monitor: &Monitor) -> WorkArea {
    let area = monitor.work_area();
    WorkArea {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    }
}

fn scaled_window_size(scale: f64, monitor_scale: f64) -> PhysicalSize<u32> {
    PhysicalSize::new(
        (PET_BASE_WIDTH * scale * monitor_scale).round().max(1.0) as u32,
        (PET_BASE_HEIGHT * scale * monitor_scale).round().max(1.0) as u32,
    )
}

fn clamp_position(
    area: WorkArea,
    size: PhysicalSize<u32>,
    requested: PhysicalPosition<i32>,
) -> PhysicalPosition<i32> {
    let min_x = i64::from(area.x);
    let min_y = i64::from(area.y);
    let max_x = (min_x + i64::from(area.width) - i64::from(size.width)).max(min_x);
    let max_y = (min_y + i64::from(area.height) - i64::from(size.height)).max(min_y);
    PhysicalPosition::new(
        i64::from(requested.x).clamp(min_x, max_x) as i32,
        i64::from(requested.y).clamp(min_y, max_y) as i32,
    )
}

fn default_position(
    area: WorkArea,
    size: PhysicalSize<u32>,
    monitor_scale: f64,
) -> PhysicalPosition<i32> {
    let margin = (PET_MARGIN * monitor_scale).round() as i64;
    let requested = PhysicalPosition::new(
        (i64::from(area.x) + i64::from(area.width) - i64::from(size.width) - margin) as i32,
        (i64::from(area.y) + i64::from(area.height) - i64::from(size.height) - margin) as i32,
    );
    clamp_position(area, size, requested)
}

fn restored_position(
    area: WorkArea,
    size: PhysicalSize<u32>,
    monitor_scale: f64,
    placement: &PetPlacement,
) -> PhysicalPosition<i32> {
    let requested = PhysicalPosition::new(
        (f64::from(area.x) + placement.offset_x * monitor_scale).round() as i32,
        (f64::from(area.y) + placement.offset_y * monitor_scale).round() as i32,
    );
    clamp_position(area, size, requested)
}

fn require_caller(window: &WebviewWindow, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&window.label()) {
        Ok(())
    } else {
        Err("desktop pet command is not allowed from this window".into())
    }
}

fn placement_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(PET_PLACEMENT_FILE))
        .map_err(|error| format!("failed to resolve pet placement path: {error}"))
}

fn load_placement(app: &AppHandle) -> Option<PetPlacement> {
    let path = match placement_path(app) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("[pet] {error}");
            return None;
        }
    };
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return None,
        Err(error) => {
            log::warn!("[pet] failed to read placement: {error}");
            return None;
        }
    };
    match serde_json::from_slice::<PetPlacement>(&bytes) {
        Ok(placement) if placement.is_valid() => Some(placement),
        Ok(_) => {
            log::warn!("[pet] ignored invalid placement data");
            None
        }
        Err(error) => {
            log::warn!("[pet] ignored malformed placement data: {error}");
            None
        }
    }
}

fn write_placement(app: &AppHandle, placement: &PetPlacement) -> Result<(), String> {
    let path = placement_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "pet placement path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create pet config directory: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(placement)
        .map_err(|error| format!("failed to serialize pet placement: {error}"))?;
    let mut file = File::create(&temporary)
        .map_err(|error| format!("failed to create temporary pet placement: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("failed to flush pet placement: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("failed to replace pet placement: {error}"))?;
    Ok(())
}

fn current_or_primary_monitor(window: &WebviewWindow) -> Result<Monitor, String> {
    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| format!("failed to get current pet monitor: {error}"))?
    {
        return Ok(monitor);
    }
    window
        .primary_monitor()
        .map_err(|error| format!("failed to get primary monitor: {error}"))?
        .ok_or_else(|| "no monitor is available for the desktop pet".to_string())
}

fn restore_monitor(
    window: &WebviewWindow,
    placement: Option<&PetPlacement>,
) -> Result<Monitor, String> {
    let monitors = window
        .available_monitors()
        .map_err(|error| format!("failed to list monitors: {error}"))?;
    if let Some(name) = placement.and_then(|value| value.monitor_name.as_ref()) {
        if let Some(monitor) = monitors
            .iter()
            .find(|monitor| monitor.name().is_some_and(|value| value == name))
        {
            return Ok(monitor.clone());
        }
    }
    if let Some(primary) = window
        .primary_monitor()
        .map_err(|error| format!("failed to get primary monitor: {error}"))?
    {
        return Ok(primary);
    }
    monitors
        .into_iter()
        .next()
        .ok_or_else(|| "no monitor is available for the desktop pet".to_string())
}

fn restore_window(window: &WebviewWindow, settings: &DesktopPetSettings) -> Result<(), String> {
    let placement = load_placement(window.app_handle());
    let monitor = restore_monitor(window, placement.as_ref())?;
    let area = monitor_work_area(&monitor);
    let size = scaled_window_size(settings.scale, monitor.scale_factor());
    let position = placement
        .as_ref()
        .map(|saved| restored_position(area, size, monitor.scale_factor(), saved))
        .unwrap_or_else(|| default_position(area, size, monitor.scale_factor()));
    window
        .set_size(size)
        .map_err(|error| format!("failed to size pet window: {error}"))?;
    window
        .set_position(position)
        .map_err(|error| format!("failed to position pet window: {error}"))?;
    Ok(())
}

fn resize_and_clamp(window: &WebviewWindow, settings: &DesktopPetSettings) -> Result<(), String> {
    let monitor = current_or_primary_monitor(window)?;
    let area = monitor_work_area(&monitor);
    let size = scaled_window_size(settings.scale, monitor.scale_factor());
    let current = window
        .outer_position()
        .map_err(|error| format!("failed to get pet position: {error}"))?;
    let position = clamp_position(area, size, current);
    window
        .set_size(size)
        .map_err(|error| format!("failed to resize pet window: {error}"))?;
    if position != current {
        window
            .set_position(position)
            .map_err(|error| format!("failed to clamp pet window: {error}"))?;
    }
    Ok(())
}

fn ensure_on_screen(window: &WebviewWindow) -> Result<(), String> {
    let monitor = current_or_primary_monitor(window)?;
    let area = monitor_work_area(&monitor);
    let size = window
        .outer_size()
        .map_err(|error| format!("failed to get pet size: {error}"))?;
    let current = window
        .outer_position()
        .map_err(|error| format!("failed to get pet position: {error}"))?;
    let position = clamp_position(area, size, current);
    if position != current {
        window
            .set_position(position)
            .map_err(|error| format!("failed to recover pet window position: {error}"))?;
    }
    Ok(())
}

fn save_placement(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) else {
        return Ok(());
    };
    let state = app.state::<Arc<PetRuntimeState>>();
    let settings = state.settings()?;
    let monitor = current_or_primary_monitor(&window)?;
    let area = monitor_work_area(&monitor);
    let position = window
        .outer_position()
        .map_err(|error| format!("failed to read pet position: {error}"))?;
    let monitor_scale = monitor.scale_factor();
    let placement = PetPlacement {
        version: PET_PLACEMENT_VERSION,
        monitor_name: monitor.name().cloned(),
        offset_x: f64::from(position.x - area.x) / monitor_scale,
        offset_y: f64::from(position.y - area.y) / monitor_scale,
        scale: settings.scale,
    };
    write_placement(app, &placement)
}

pub fn schedule_placement_save(app: AppHandle) {
    let generation = PLACEMENT_SAVE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(PET_SAVE_DEBOUNCE_MS)).await;
        if PLACEMENT_SAVE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Err(error) = save_placement(&app) {
            log::warn!("[pet] {error}");
        }
    });
}

fn reset_position(app: &AppHandle) -> Result<(), String> {
    let path = placement_path(app)?;
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != ErrorKind::NotFound {
            return Err(format!("failed to remove pet placement: {error}"));
        }
    }
    let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) else {
        return Ok(());
    };
    let state = app.state::<Arc<PetRuntimeState>>();
    let settings = state.settings()?.as_settings();
    let monitor = match window
        .primary_monitor()
        .map_err(|error| format!("failed to get primary monitor: {error}"))?
    {
        Some(monitor) => monitor,
        None => current_or_primary_monitor(&window)?,
    };
    let area = monitor_work_area(&monitor);
    let size = scaled_window_size(settings.scale, monitor.scale_factor());
    window
        .set_size(size)
        .map_err(|error| format!("failed to reset pet size: {error}"))?;
    window
        .set_position(default_position(area, size, monitor.scale_factor()))
        .map_err(|error| format!("failed to reset pet position: {error}"))?;
    schedule_placement_save(app.clone());
    Ok(())
}

fn apply_native_settings(
    window: &WebviewWindow,
    settings: &DesktopPetSettings,
) -> Result<(), String> {
    window
        .set_always_on_top(settings.always_on_top)
        .map_err(|error| format!("failed to update pet always-on-top: {error}"))?;
    window
        .set_ignore_cursor_events(settings.click_through)
        .map_err(|error| format!("failed to update pet click-through: {error}"))?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| format!("failed to keep pet out of taskbar: {error}"))?;
    window
        .set_shadow(false)
        .map_err(|error| format!("failed to disable pet shadow: {error}"))?;
    resize_and_clamp(window, settings)
}

fn ensure_pet_window(app: &AppHandle, state: &PetRuntimeState) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        return Ok(window);
    }
    let _creation_guard = state.lock_window_creation()?;
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        return Ok(window);
    }
    let settings = state.settings()?.as_settings();
    state.set_ready(false);
    state.clear_bridge();
    let window = WebviewWindowBuilder::new(app, PET_WINDOW_LABEL, WebviewUrl::App(PET_PAGE.into()))
        .title("Galcode 桌宠")
        .inner_size(
            PET_BASE_WIDTH * settings.scale,
            PET_BASE_HEIGHT * settings.scale,
        )
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(settings.always_on_top)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|error| format!("failed to create pet window: {error}"))?;
    restore_window(&window, &settings)?;
    apply_native_settings(&window, &settings)?;
    Ok(window)
}

fn send_bridge(state: &PetRuntimeState, event: PetBridgeEvent) {
    if let Err(error) = state.send_bridge(event) {
        state.set_ready(false);
        log::warn!("[pet] {error}");
    }
}

fn stop_global_input_monitor(app: &AppHandle) {
    let monitor = app.state::<Arc<PetGlobalInputMonitor>>();
    if let Err(error) = monitor.stop() {
        log::warn!("[pet-input] failed to stop global monitor: {error}");
    }
}

fn sync_global_input_monitor(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<PetRuntimeState>>().inner().clone();
    let visible = app
        .get_webview_window(PET_WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let should_run =
        visible && state.is_ready() && state.desired_visible() && state.settings()?.enabled;
    let monitor = app.state::<Arc<PetGlobalInputMonitor>>();
    if should_run {
        monitor.start(state)?;
    } else {
        monitor.stop()?;
    }
    Ok(())
}

pub fn stop_global_input(app: &AppHandle) {
    stop_global_input_monitor(app);
}

fn replay_snapshot_if_enabled(
    state: &PetRuntimeState,
    settings: &PetSettingsSnapshot,
) -> Result<bool, String> {
    state.replay_snapshot_with(settings.enabled, |snapshot| {
        send_bridge(state, PetBridgeEvent::Snapshot(snapshot));
    })
}

fn replay_state(state: &PetRuntimeState) -> Result<(), String> {
    let settings = state.settings()?;
    send_bridge(state, PetBridgeEvent::Settings(settings.clone()));
    replay_snapshot_if_enabled(state, &settings)?;
    Ok(())
}

fn show_if_ready(window: &WebviewWindow, state: &PetRuntimeState) -> Result<(), String> {
    if state.is_ready() && state.desired_visible() && state.settings()?.enabled {
        ensure_on_screen(window)?;
        window
            .show()
            .map_err(|error| format!("failed to show pet window: {error}"))?;
        send_bridge(state, PetBridgeEvent::Visibility(true));
        sync_global_input_monitor(window.app_handle())?;
    } else {
        send_bridge(state, PetBridgeEvent::Visibility(false));
        stop_global_input_monitor(window.app_handle());
    }
    Ok(())
}

fn emit_action_to_main(app: &AppHandle, action: &PetAction) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.emit(PET_ACTION_EVENT, action)
            .map_err(|error| format!("failed to forward pet action: {error}"))?;
    }
    Ok(())
}

fn apply_settings_update(
    app: &AppHandle,
    state: &PetRuntimeState,
    settings: DesktopPetSettings,
    action: &PetAction,
) -> Result<PetSettingsSnapshot, String> {
    let snapshot = state.update_settings(settings)?;
    if !snapshot.enabled {
        stop_global_input_monitor(app);
        state.invalidate_snapshot_stream_with(|| send_bridge(state, PetBridgeEvent::Reset))?;
    }
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        apply_native_settings(&window, &snapshot.as_settings())?;
    }
    send_bridge(state, PetBridgeEvent::Settings(snapshot.clone()));
    emit_action_to_main(app, action)?;
    schedule_placement_save(app.clone());
    Ok(snapshot)
}

#[tauri::command]
pub async fn pet_configure(
    caller: WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<PetRuntimeState>>,
    settings: DesktopPetSettings,
    show: bool,
    stream_id: String,
) -> Result<PetSettingsSnapshot, String> {
    require_caller(&caller, &["main"])?;
    let state = state.inner().as_ref();
    settings.validate()?;
    let requested_enabled = settings.enabled;
    let _ = if requested_enabled {
        state.begin_snapshot_stream_with(&stream_id, || {
            send_bridge(state, PetBridgeEvent::Reset);
        })?
    } else {
        state.begin_snapshot_stream(&stream_id)?
    };
    let settings_snapshot = state.update_settings(settings)?;
    let disabled = !settings_snapshot.enabled;
    if disabled {
        state.invalidate_snapshot_stream_with(|| send_bridge(state, PetBridgeEvent::Reset))?;
    }
    let desired_visible = settings_snapshot.enabled && show;
    state.set_desired_visible(desired_visible);

    if !desired_visible {
        stop_global_input_monitor(&app);
        if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
            apply_native_settings(&window, &settings_snapshot.as_settings())?;
            send_bridge(state, PetBridgeEvent::Settings(settings_snapshot.clone()));
            window
                .hide()
                .map_err(|error| format!("failed to hide pet window: {error}"))?;
            send_bridge(state, PetBridgeEvent::Visibility(false));
        }
        return Ok(settings_snapshot);
    }

    let window = ensure_pet_window(&app, state)?;
    apply_native_settings(&window, &settings_snapshot.as_settings())?;
    send_bridge(state, PetBridgeEvent::Settings(settings_snapshot.clone()));
    state.replay_snapshot_with(settings_snapshot.enabled, |snapshot| {
        send_bridge(state, PetBridgeEvent::Snapshot(snapshot));
    })?;
    show_if_ready(&window, state)?;
    Ok(settings_snapshot)
}

#[tauri::command]
pub fn pet_update_snapshot(
    caller: WebviewWindow,
    state: State<'_, Arc<PetRuntimeState>>,
    stream_id: String,
    snapshot: PetSnapshot,
) -> Result<bool, String> {
    require_caller(&caller, &["main"])?;
    let state = state.inner().as_ref();
    if !state.accept_snapshot_with(&stream_id, snapshot, |snapshot| {
        send_bridge(state, PetBridgeEvent::Snapshot(snapshot));
    })? {
        return Ok(false);
    }
    Ok(true)
}

#[tauri::command]
pub fn pet_input(
    caller: WebviewWindow,
    state: State<'_, Arc<PetRuntimeState>>,
    event: PetInputEvent,
) -> Result<bool, String> {
    require_caller(&caller, &["main"])?;
    let state = state.inner().as_ref();
    if !matches!(&event, PetInputEvent::Reset) && !state.settings()?.enabled {
        return Ok(false);
    }
    let result = state.send_bridge(PetBridgeEvent::Input(PetBridgeInput {
        source: PetBridgeInputSource::Main,
        event,
    }));
    if result.is_err() {
        state.set_ready(false);
    }
    result
}

#[tauri::command]
pub fn pet_ready(
    caller: WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<PetRuntimeState>>,
    on_event: Channel<PetBridgeEvent>,
) -> Result<(), String> {
    require_caller(&caller, &[PET_WINDOW_LABEL])?;
    let state = state.inner().as_ref();
    state.attach_bridge(on_event)?;
    state.set_ready(true);
    replay_state(state)?;
    show_if_ready(&caller, state)?;
    emit_action_to_main(&app, &PetAction::Ready)
}

#[tauri::command]
pub fn pet_action(
    caller: WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<PetRuntimeState>>,
    action: PetAction,
) -> Result<(), String> {
    require_caller(&caller, &[PET_WINDOW_LABEL])?;
    action.validate()?;
    let state = state.inner().as_ref();
    match action.clone() {
        PetAction::Ready => {
            state.set_ready(true);
            replay_state(state)?;
            show_if_ready(&caller, state)?;
            emit_action_to_main(&app, &action)
        }
        PetAction::Poke => emit_action_to_main(&app, &action),
        PetAction::OpenTask { .. } | PetAction::ShowMain => {
            if let Some(main) = app.get_webview_window("main") {
                main.show()
                    .map_err(|error| format!("failed to show main window: {error}"))?;
                main.set_focus()
                    .map_err(|error| format!("failed to focus main window: {error}"))?;
            }
            emit_action_to_main(&app, &action)
        }
        PetAction::DragEnded => {
            schedule_placement_save(app.clone());
            emit_action_to_main(&app, &action)
        }
        PetAction::Hide => {
            state.set_desired_visible(false);
            stop_global_input_monitor(&app);
            caller
                .hide()
                .map_err(|error| format!("failed to hide pet window: {error}"))?;
            send_bridge(state, PetBridgeEvent::Visibility(false));
            emit_action_to_main(&app, &action)
        }
        PetAction::ResetPosition => {
            reset_position(&app)?;
            emit_action_to_main(&app, &action)
        }
        PetAction::SetEnabled { enabled } => {
            let mut settings = state.settings()?.as_settings();
            settings.enabled = enabled;
            if !enabled {
                state.set_desired_visible(false);
                stop_global_input_monitor(&app);
                caller
                    .hide()
                    .map_err(|error| format!("failed to hide disabled pet window: {error}"))?;
                send_bridge(state, PetBridgeEvent::Visibility(false));
            }
            apply_settings_update(&app, state, settings, &action).map(|_| ())
        }
        PetAction::SetModel { model_id } => {
            let mut settings = state.settings()?.as_settings();
            settings.model_id = model_id;
            apply_settings_update(&app, state, settings, &action).map(|_| ())
        }
        PetAction::SetScale { scale } => {
            let mut settings = state.settings()?.as_settings();
            settings.scale = scale;
            apply_settings_update(&app, state, settings, &action).map(|_| ())
        }
        PetAction::SetAlwaysOnTop { enabled } => {
            let mut settings = state.settings()?.as_settings();
            settings.always_on_top = enabled;
            apply_settings_update(&app, state, settings, &action).map(|_| ())
        }
        PetAction::SetClickThrough { enabled } => {
            let mut settings = state.settings()?.as_settings();
            settings.click_through = enabled;
            apply_settings_update(&app, state, settings, &action).map(|_| ())
        }
        PetAction::SetMirror { enabled } => {
            let mut settings = state.settings()?.as_settings();
            settings.mirror = enabled;
            apply_settings_update(&app, state, settings, &action).map(|_| ())
        }
    }
}

#[tauri::command]
pub fn set_pet_click_through(
    caller: WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<PetRuntimeState>>,
    enabled: bool,
) -> Result<PetSettingsSnapshot, String> {
    require_caller(&caller, &["main", PET_WINDOW_LABEL])?;
    let state = state.inner().as_ref();
    let mut settings = state.settings()?.as_settings();
    settings.click_through = enabled;
    apply_settings_update(
        &app,
        state,
        settings,
        &PetAction::SetClickThrough { enabled },
    )
}

pub fn tray_toggle_visibility(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<PetRuntimeState>>();
    let state = state.inner().as_ref();
    let mut settings = state.settings()?.as_settings();
    if state.desired_visible() {
        state.set_desired_visible(false);
        stop_global_input_monitor(app);
        if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
            window
                .hide()
                .map_err(|error| format!("failed to hide pet window: {error}"))?;
            send_bridge(state, PetBridgeEvent::Visibility(false));
        }
        return emit_action_to_main(app, &PetAction::Hide);
    }
    let was_enabled = settings.enabled;
    if !was_enabled {
        settings.enabled = true;
        apply_settings_update(
            app,
            state,
            settings,
            &PetAction::SetEnabled { enabled: true },
        )?;
    }
    state.set_desired_visible(true);
    let window = ensure_pet_window(app, state)?;
    show_if_ready(&window, state)?;
    if was_enabled {
        emit_action_to_main(app, &PetAction::SetEnabled { enabled: true })?;
    }
    Ok(())
}

pub fn tray_toggle_click_through(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<PetRuntimeState>>();
    let state = state.inner().as_ref();
    let mut settings = state.settings()?.as_settings();
    settings.click_through = !settings.click_through;
    let action = PetAction::SetClickThrough {
        enabled: settings.click_through,
    };
    apply_settings_update(app, state, settings, &action).map(|_| ())
}

pub fn tray_toggle_always_on_top(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<PetRuntimeState>>();
    let state = state.inner().as_ref();
    let mut settings = state.settings()?.as_settings();
    settings.always_on_top = !settings.always_on_top;
    let action = PetAction::SetAlwaysOnTop {
        enabled: settings.always_on_top,
    };
    apply_settings_update(app, state, settings, &action).map(|_| ())
}

pub fn tray_set_model(app: &AppHandle, model_id: PetModelId) -> Result<(), String> {
    let state = app.state::<Arc<PetRuntimeState>>();
    let state = state.inner().as_ref();
    let mut settings = state.settings()?.as_settings();
    settings.model_id = model_id;
    let action = PetAction::SetModel { model_id };
    apply_settings_update(app, state, settings, &action).map(|_| ())
}

pub fn tray_reset_position(app: &AppHandle) -> Result<(), String> {
    reset_position(app)?;
    emit_action_to_main(app, &PetAction::ResetPosition)
}

pub fn spawn_visibility_guard(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(PET_VISIBILITY_GUARD_SECS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let state = app.state::<Arc<PetRuntimeState>>();
            let state = state.inner().as_ref();
            let settings = match state.settings() {
                Ok(settings) => settings,
                Err(error) => {
                    log::warn!("[pet] {error}");
                    continue;
                }
            };
            if !settings.enabled || !state.desired_visible() {
                stop_global_input_monitor(&app);
                if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                        send_bridge(state, PetBridgeEvent::Visibility(false));
                    }
                }
                continue;
            }
            let window = match ensure_pet_window(&app, state) {
                Ok(window) => window,
                Err(error) => {
                    log::warn!("[pet] visibility guard failed: {error}");
                    continue;
                }
            };
            if state.is_ready() {
                if let Err(error) = ensure_on_screen(&window) {
                    log::warn!("[pet] {error}");
                }
                if !window.is_visible().unwrap_or(false) {
                    if let Err(error) = window.show() {
                        log::warn!("[pet] visibility guard could not show window: {error}");
                    } else {
                        send_bridge(state, PetBridgeEvent::Visibility(true));
                    }
                }
                if let Err(error) = sync_global_input_monitor(&app) {
                    log::warn!("[pet-input] visibility sync failed: {error}");
                }
            } else {
                stop_global_input_monitor(&app);
            }
        }
    });
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != PET_WINDOW_LABEL {
        return;
    }
    let app = window.app_handle().clone();
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let state = app.state::<Arc<PetRuntimeState>>();
            state.set_desired_visible(false);
            stop_global_input_monitor(&app);
            let _ = window.hide();
            send_bridge(state.inner().as_ref(), PetBridgeEvent::Visibility(false));
            let _ = emit_action_to_main(&app, &PetAction::Hide);
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => schedule_placement_save(app),
        WindowEvent::ScaleFactorChanged { .. } => {
            if let Some(pet) = app.get_webview_window(PET_WINDOW_LABEL) {
                let state = app.state::<Arc<PetRuntimeState>>();
                if let Ok(settings) = state.settings() {
                    if let Err(error) = resize_and_clamp(&pet, &settings.as_settings()) {
                        log::warn!("[pet] DPI update failed: {error}");
                    }
                }
            }
            schedule_placement_save(app);
        }
        WindowEvent::Destroyed => {
            stop_global_input_monitor(&app);
            let state = app.state::<Arc<PetRuntimeState>>();
            state.set_ready(false);
            state.clear_bridge();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(seq: u64) -> PetSnapshot {
        PetSnapshot {
            version: crate::pet_state::PET_PROTOCOL_VERSION,
            seq,
            model_id: PetModelId::Haruhi,
            visual_state: crate::pet_state::PetVisualState::Working,
            active_task_id: Some("task-1".into()),
            active_task_title: None,
            running_count: 1,
            speech: Some("正在处理任务".into()),
            reduced_motion: false,
        }
    }

    #[test]
    fn clamps_to_negative_origin_monitor_work_area() {
        let area = WorkArea {
            x: -1920,
            y: 40,
            width: 1920,
            height: 1040,
        };
        let size = PhysicalSize::new(420, 560);
        assert_eq!(
            clamp_position(area, size, PhysicalPosition::new(-5000, 5000)),
            PhysicalPosition::new(-1920, 520)
        );
    }

    #[test]
    fn oversized_window_stays_anchored_to_work_area_origin() {
        let area = WorkArea {
            x: 100,
            y: 200,
            width: 300,
            height: 400,
        };
        assert_eq!(
            clamp_position(
                area,
                PhysicalSize::new(500, 600),
                PhysicalPosition::new(900, 900)
            ),
            PhysicalPosition::new(100, 200)
        );
    }

    #[test]
    fn restores_logical_offset_at_new_dpi_and_clamps_it() {
        let placement = PetPlacement {
            version: PET_PLACEMENT_VERSION,
            monitor_name: Some("Display".into()),
            offset_x: 100.0,
            offset_y: 120.0,
            scale: 1.0,
        };
        let area = WorkArea {
            x: 1920,
            y: 0,
            width: 2560,
            height: 1400,
        };
        assert_eq!(
            restored_position(area, PhysicalSize::new(840, 1120), 2.0, &placement),
            PhysicalPosition::new(2120, 240)
        );
    }

    #[test]
    fn replay_snapshot_is_gated_by_enabled_not_window_visibility() {
        let state = PetRuntimeState::default();
        assert!(state.begin_snapshot_stream("stream-a").unwrap());
        assert!(state.accept_snapshot("stream-a", snapshot(1)).unwrap());

        let disabled = state.settings().unwrap();
        assert!(!disabled.enabled);
        assert!(!replay_snapshot_if_enabled(&state, &disabled).unwrap());

        let mut enabled = disabled.as_settings();
        enabled.enabled = true;
        let enabled = state.update_settings(enabled).unwrap();
        assert!(replay_snapshot_if_enabled(&state, &enabled).unwrap());
    }
}
