use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, MutexGuard,
};
use tauri::ipc::Channel;

pub const PET_PROTOCOL_VERSION: u8 = 1;
pub const PET_SCALE_MIN: f64 = 0.6;
pub const PET_SCALE_MAX: f64 = 1.8;
const PET_TASK_ID_MAX_LENGTH: usize = 128;
const PET_SPEECH_MAX_LENGTH: usize = 160;
const PET_STREAM_ID_MAX_LENGTH: usize = 64;
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PET_STATUS_SPEECH: [&str; 6] = [
    "正在启动任务",
    "正在思考",
    "正在处理任务",
    "有任务正在等待你的批准",
    "任务完成啦",
    "任务遇到错误了",
];

fn is_canonical_scale(scale: f64) -> bool {
    scale.is_finite()
        && (PET_SCALE_MIN..=PET_SCALE_MAX).contains(&scale)
        && scale == (scale * 100.0).round() / 100.0
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PetModelId {
    #[default]
    Haruhi,
    Mikuru,
    Yuki,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PetVisualState {
    #[default]
    Idle,
    Starting,
    Thinking,
    Working,
    Waiting,
    Complete,
    Error,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetSettings {
    pub enabled: bool,
    pub model_id: PetModelId,
    pub show_on_startup: bool,
    pub always_on_top: bool,
    pub click_through: bool,
    pub scale: f64,
    pub reduced_motion: bool,
    pub mirror: bool,
}

impl Default for DesktopPetSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            model_id: PetModelId::Haruhi,
            show_on_startup: true,
            always_on_top: true,
            click_through: false,
            scale: 1.0,
            reduced_motion: false,
            mirror: false,
        }
    }
}

impl DesktopPetSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !is_canonical_scale(self.scale) {
            return Err(format!(
                "pet scale must be a two-decimal value between {PET_SCALE_MIN} and {PET_SCALE_MAX}"
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSettingsSnapshot {
    pub version: u8,
    pub revision: u64,
    pub enabled: bool,
    pub model_id: PetModelId,
    pub show_on_startup: bool,
    pub always_on_top: bool,
    pub click_through: bool,
    pub scale: f64,
    pub reduced_motion: bool,
    pub mirror: bool,
}

impl PetSettingsSnapshot {
    fn from_settings(settings: &DesktopPetSettings, revision: u64) -> Self {
        Self {
            version: PET_PROTOCOL_VERSION,
            revision,
            enabled: settings.enabled,
            model_id: settings.model_id,
            show_on_startup: settings.show_on_startup,
            always_on_top: settings.always_on_top,
            click_through: settings.click_through,
            scale: settings.scale,
            reduced_motion: settings.reduced_motion,
            mirror: settings.mirror,
        }
    }

    pub fn as_settings(&self) -> DesktopPetSettings {
        DesktopPetSettings {
            enabled: self.enabled,
            model_id: self.model_id,
            show_on_startup: self.show_on_startup,
            always_on_top: self.always_on_top,
            click_through: self.click_through,
            scale: self.scale,
            reduced_motion: self.reduced_motion,
            mirror: self.mirror,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PetSnapshot {
    pub version: u8,
    pub seq: u64,
    pub model_id: PetModelId,
    pub visual_state: PetVisualState,
    pub active_task_id: Option<String>,
    pub active_task_title: Option<String>,
    pub running_count: u16,
    pub speech: Option<String>,
    pub reduced_motion: bool,
}

impl PetSnapshot {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != PET_PROTOCOL_VERSION {
            return Err("unsupported pet protocol version".into());
        }
        if self.seq == 0 || self.seq > JS_MAX_SAFE_INTEGER {
            return Err("pet snapshot seq must be a positive JavaScript-safe integer".into());
        }
        if self.running_count > 999 {
            return Err("pet running count is out of range".into());
        }
        if let Some(task_id) = &self.active_task_id {
            if !is_valid_task_id(task_id) {
                return Err("invalid pet task id".into());
            }
        }
        if self.active_task_title.is_some() {
            return Err("pet task titles must not cross the pet bridge".into());
        }
        if self
            .speech
            .as_ref()
            .is_some_and(|value| value.encode_utf16().count() > PET_SPEECH_MAX_LENGTH)
        {
            return Err("pet speech is too long".into());
        }
        if self
            .speech
            .as_deref()
            .is_some_and(|value| !PET_STATUS_SPEECH.contains(&value))
        {
            return Err("pet speech must be an approved status phrase".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PetAction {
    Ready,
    Poke,
    OpenTask {
        #[serde(rename = "taskId")]
        task_id: Option<String>,
    },
    DragEnded,
    ShowMain,
    Hide,
    ResetPosition,
    SetEnabled {
        enabled: bool,
    },
    SetModel {
        #[serde(rename = "modelId")]
        model_id: PetModelId,
    },
    SetScale {
        scale: f64,
    },
    SetAlwaysOnTop {
        enabled: bool,
    },
    SetClickThrough {
        enabled: bool,
    },
    SetMirror {
        enabled: bool,
    },
}

impl PetAction {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::OpenTask {
                task_id: Some(task_id),
            } if !is_valid_task_id(task_id) => Err("invalid pet task id".into()),
            Self::SetScale { scale } if !is_canonical_scale(*scale) => {
                Err("invalid pet scale".into())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum PetInputKey {
    #[serde(rename = "1")]
    Digit1,
    #[serde(rename = "2")]
    Digit2,
    #[serde(rename = "3")]
    Digit3,
    #[serde(rename = "4")]
    Digit4,
    #[serde(rename = "5")]
    Digit5,
    #[serde(rename = "Q")]
    Q,
    #[serde(rename = "W")]
    W,
    #[serde(rename = "E")]
    E,
    #[serde(rename = "R")]
    R,
    #[serde(rename = "T")]
    T,
    #[serde(rename = "A")]
    A,
    #[serde(rename = "S")]
    S,
    #[serde(rename = "D")]
    D,
    #[serde(rename = "F")]
    F,
    #[serde(rename = "Z")]
    Z,
    #[serde(rename = "X")]
    X,
    #[serde(rename = "C")]
    C,
    #[serde(rename = "V")]
    V,
    #[serde(rename = "Tab")]
    Tab,
    #[serde(rename = "Shift")]
    Shift,
    #[serde(rename = "Ctrl")]
    Ctrl,
    #[serde(rename = "Enter")]
    Enter,
    #[serde(rename = "Space")]
    Space,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Deserialize, Serialize)]
#[serde(try_from = "u8", into = "u8")]
pub enum PetMouseButton {
    Primary,
    Secondary,
}

impl TryFrom<u8> for PetMouseButton {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Primary),
            2 => Ok(Self::Secondary),
            _ => Err("invalid pet mouse button".into()),
        }
    }
}

impl From<PetMouseButton> for u8 {
    fn from(value: PetMouseButton) -> Self {
        match value {
            PetMouseButton::Primary => 0,
            PetMouseButton::Secondary => 2,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PetInputEvent {
    KeyDown {
        key: PetInputKey,
    },
    KeyUp {
        key: PetInputKey,
    },
    MouseDown {
        button: PetMouseButton,
    },
    MouseUp {
        button: PetMouseButton,
    },
    MouseMove {
        #[serde(rename = "deltaX")]
        delta_x: i32,
        #[serde(rename = "deltaY")]
        delta_y: i32,
    },
    Reset,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PetBridgeInputSource {
    Main,
    Global,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PetBridgeInput {
    pub source: PetBridgeInputSource,
    pub event: PetInputEvent,
}

fn is_valid_task_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= PET_TASK_ID_MAX_LENGTH
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn is_valid_stream_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= PET_STREAM_ID_MAX_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "kebab-case")]
pub enum PetBridgeEvent {
    Reset,
    Settings(PetSettingsSnapshot),
    Snapshot(PetSnapshot),
    Visibility(bool),
    Input(PetBridgeInput),
}

#[derive(Default)]
struct PetSnapshotStream {
    id: Option<String>,
    latest: Option<PetSnapshot>,
}

pub struct PetRuntimeState {
    snapshot_stream: Mutex<PetSnapshotStream>,
    settings: Mutex<PetSettingsSnapshot>,
    bridge: Mutex<Option<Channel<PetBridgeEvent>>>,
    window_creation: Mutex<()>,
    ready: AtomicBool,
    desired_visible: AtomicBool,
}

impl Default for PetRuntimeState {
    fn default() -> Self {
        let settings = DesktopPetSettings::default();
        Self {
            snapshot_stream: Mutex::new(PetSnapshotStream::default()),
            settings: Mutex::new(PetSettingsSnapshot::from_settings(&settings, 1)),
            bridge: Mutex::new(None),
            window_creation: Mutex::new(()),
            ready: AtomicBool::new(false),
            desired_visible: AtomicBool::new(false),
        }
    }
}

impl PetRuntimeState {
    pub fn begin_snapshot_stream(&self, stream_id: &str) -> Result<bool, String> {
        self.begin_snapshot_stream_with(stream_id, || {})
    }

    pub fn begin_snapshot_stream_with<F>(
        &self,
        stream_id: &str,
        on_changed: F,
    ) -> Result<bool, String>
    where
        F: FnOnce(),
    {
        if !is_valid_stream_id(stream_id) {
            return Err("invalid pet snapshot stream id".into());
        }
        let mut stream = self
            .snapshot_stream
            .lock()
            .map_err(|_| "pet snapshot state is poisoned".to_string())?;
        if stream.id.as_deref() == Some(stream_id) {
            return Ok(false);
        }
        stream.id = Some(stream_id.to_string());
        stream.latest = None;
        on_changed();
        Ok(true)
    }

    pub fn invalidate_snapshot_stream(&self) -> Result<(), String> {
        self.invalidate_snapshot_stream_with(|| {})
    }

    pub fn invalidate_snapshot_stream_with<F>(&self, on_invalidated: F) -> Result<(), String>
    where
        F: FnOnce(),
    {
        let mut stream = self
            .snapshot_stream
            .lock()
            .map_err(|_| "pet snapshot state is poisoned".to_string())?;
        stream.id = None;
        stream.latest = None;
        on_invalidated();
        Ok(())
    }

    pub fn accept_snapshot(&self, stream_id: &str, snapshot: PetSnapshot) -> Result<bool, String> {
        self.accept_snapshot_with(stream_id, snapshot, |_| {})
    }

    pub fn accept_snapshot_with<F>(
        &self,
        stream_id: &str,
        snapshot: PetSnapshot,
        on_accepted: F,
    ) -> Result<bool, String>
    where
        F: FnOnce(PetSnapshot),
    {
        snapshot.validate()?;
        if !is_valid_stream_id(stream_id) {
            return Err("invalid pet snapshot stream id".into());
        }
        let mut stream = self
            .snapshot_stream
            .lock()
            .map_err(|_| "pet snapshot state is poisoned".to_string())?;
        if stream.id.as_deref() != Some(stream_id) {
            return Ok(false);
        }
        if stream
            .latest
            .as_ref()
            .is_some_and(|current| current.seq >= snapshot.seq)
        {
            return Ok(false);
        }
        stream.latest = Some(snapshot.clone());
        on_accepted(snapshot);
        Ok(true)
    }

    pub fn latest_snapshot(&self) -> Result<Option<PetSnapshot>, String> {
        self.snapshot_stream
            .lock()
            .map(|stream| stream.latest.clone())
            .map_err(|_| "pet snapshot state is poisoned".to_string())
    }

    pub fn replay_snapshot_with<F>(&self, enabled: bool, on_replay: F) -> Result<bool, String>
    where
        F: FnOnce(PetSnapshot),
    {
        if !enabled {
            return Ok(false);
        }
        let stream = self
            .snapshot_stream
            .lock()
            .map_err(|_| "pet snapshot state is poisoned".to_string())?;
        let Some(snapshot) = stream.latest.clone() else {
            return Ok(false);
        };
        on_replay(snapshot);
        Ok(true)
    }

    pub fn update_settings(
        &self,
        settings: DesktopPetSettings,
    ) -> Result<PetSettingsSnapshot, String> {
        settings.validate()?;
        let mut current = self
            .settings
            .lock()
            .map_err(|_| "pet settings state is poisoned".to_string())?;
        if current.revision >= JS_MAX_SAFE_INTEGER {
            return Err("pet settings revision exhausted JavaScript-safe integers".into());
        }
        let revision = current.revision + 1;
        let snapshot = PetSettingsSnapshot::from_settings(&settings, revision);
        *current = snapshot.clone();
        Ok(snapshot)
    }

    pub fn settings(&self) -> Result<PetSettingsSnapshot, String> {
        self.settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| "pet settings state is poisoned".to_string())
    }

    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub fn set_desired_visible(&self, visible: bool) {
        self.desired_visible.store(visible, Ordering::SeqCst);
    }

    pub fn desired_visible(&self) -> bool {
        self.desired_visible.load(Ordering::SeqCst)
    }

    pub fn attach_bridge(&self, bridge: Channel<PetBridgeEvent>) -> Result<(), String> {
        *self
            .bridge
            .lock()
            .map_err(|_| "pet bridge state is poisoned".to_string())? = Some(bridge);
        Ok(())
    }

    pub fn clear_bridge(&self) {
        if let Ok(mut bridge) = self.bridge.lock() {
            *bridge = None;
        }
    }

    pub fn send_bridge(&self, event: PetBridgeEvent) -> Result<bool, String> {
        let mut bridge = self
            .bridge
            .lock()
            .map_err(|_| "pet bridge state is poisoned".to_string())?;
        let Some(channel) = bridge.as_ref() else {
            return Ok(false);
        };
        if let Err(error) = channel.send(event) {
            *bridge = None;
            return Err(format!("pet bridge send failed: {error}"));
        }
        Ok(true)
    }

    pub fn lock_window_creation(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.window_creation
            .lock()
            .map_err(|_| "pet window creation state is poisoned".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(seq: u64) -> PetSnapshot {
        PetSnapshot {
            version: PET_PROTOCOL_VERSION,
            seq,
            model_id: PetModelId::Haruhi,
            visual_state: PetVisualState::Working,
            active_task_id: Some("task-1".into()),
            active_task_title: None,
            running_count: 1,
            speech: Some("正在处理任务".into()),
            reduced_motion: false,
        }
    }

    #[test]
    fn snapshot_sequence_is_monotonic_and_replayable() {
        let state = PetRuntimeState::default();
        assert!(state.begin_snapshot_stream("stream-a").unwrap());
        assert!(state.accept_snapshot("stream-a", snapshot(2)).unwrap());
        assert!(!state.accept_snapshot("stream-a", snapshot(2)).unwrap());
        assert!(!state.accept_snapshot("stream-a", snapshot(1)).unwrap());
        assert!(state.accept_snapshot("stream-a", snapshot(3)).unwrap());
        assert_eq!(state.latest_snapshot().unwrap().unwrap().seq, 3);
    }

    #[test]
    fn rejects_invalid_snapshot_fields() {
        let mut invalid = snapshot(1);
        invalid.active_task_id = Some("../secret".into());
        assert!(invalid.validate().is_err());
        invalid.active_task_id = Some("task-1".into());
        invalid.active_task_title = Some("Secret task title".into());
        assert!(invalid.validate().is_err());
        invalid.active_task_title = None;
        invalid.speech = Some("raw tool output".into());
        assert!(invalid.validate().is_err());
        invalid.speech = Some("x".repeat(PET_SPEECH_MAX_LENGTH + 1));
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn rejects_unknown_model_ids_during_deserialization() {
        let value = serde_json::json!({
            "version": 1,
            "seq": 1,
            "modelId": "remote",
            "visualState": "idle",
            "activeTaskId": null,
            "activeTaskTitle": null,
            "runningCount": 0,
            "speech": null,
            "reducedMotion": false
        });
        assert!(serde_json::from_value::<PetSnapshot>(value).is_err());
    }

    #[test]
    fn rejects_unknown_snapshot_fields_during_deserialization() {
        let value = serde_json::json!({
            "version": 1,
            "seq": 1,
            "modelId": "haruhi",
            "visualState": "idle",
            "activeTaskId": null,
            "activeTaskTitle": null,
            "runningCount": 0,
            "speech": null,
            "reducedMotion": false,
            "toolOutput": "secret"
        });
        assert!(serde_json::from_value::<PetSnapshot>(value).is_err());
    }

    #[test]
    fn visibility_bridge_event_has_a_boolean_payload() {
        assert_eq!(
            serde_json::to_value(PetBridgeEvent::Visibility(false)).unwrap(),
            serde_json::json!({ "type": "visibility", "payload": false })
        );
    }

    #[test]
    fn input_bridge_event_has_a_narrow_tagged_payload() {
        assert_eq!(
            serde_json::to_value(PetBridgeEvent::Input(PetBridgeInput {
                source: PetBridgeInputSource::Global,
                event: PetInputEvent::KeyDown {
                    key: PetInputKey::W,
                },
            }))
            .unwrap(),
            serde_json::json!({
                "type": "input",
                "payload": {
                    "source": "global",
                    "event": { "type": "key-down", "key": "W" }
                }
            })
        );
        assert_eq!(
            serde_json::to_value(PetInputEvent::MouseMove {
                delta_x: -12,
                delta_y: 7,
            })
            .unwrap(),
            serde_json::json!({ "type": "mouse-move", "deltaX": -12, "deltaY": 7 })
        );
        assert_eq!(
            serde_json::to_value(PetInputEvent::Reset).unwrap(),
            serde_json::json!({ "type": "reset" })
        );
    }

    #[test]
    fn input_deserialization_rejects_unknown_values_and_fields() {
        assert!(serde_json::from_value::<PetInputEvent>(serde_json::json!({
            "type": "key-down",
            "key": "Q"
        }))
        .is_ok());
        assert!(serde_json::from_value::<PetInputEvent>(serde_json::json!({
            "type": "key-down",
            "key": "Escape"
        }))
        .is_err());
        assert!(serde_json::from_value::<PetInputEvent>(serde_json::json!({
            "type": "mouse-down",
            "button": 1
        }))
        .is_err());
        assert!(serde_json::from_value::<PetInputEvent>(serde_json::json!({
            "type": "mouse-move",
            "deltaX": -12,
            "deltaY": 7
        }))
        .is_ok());
        assert!(serde_json::from_value::<PetInputEvent>(serde_json::json!({
            "type": "mouse-move",
            "deltaX": 1.5,
            "deltaY": 7
        }))
        .is_err());
        assert!(serde_json::from_value::<PetInputEvent>(serde_json::json!({
            "type": "key-up",
            "key": "A",
            "text": "secret"
        }))
        .is_err());
    }

    #[test]
    fn settings_revision_increases() {
        let state = PetRuntimeState::default();
        let first = state
            .update_settings(DesktopPetSettings::default())
            .unwrap();
        let second = state
            .update_settings(DesktopPetSettings::default())
            .unwrap();
        assert!(second.revision > first.revision);
    }

    #[test]
    fn scale_validation_matches_frontend_canonical_values() {
        let mut settings = DesktopPetSettings::default();
        settings.scale = 1.23;
        assert!(settings.validate().is_ok());
        settings.scale = 1.234;
        assert!(settings.validate().is_err());
    }

    #[test]
    fn new_stream_resets_sequence_and_rejects_late_old_stream_updates() {
        let state = PetRuntimeState::default();
        assert!(state.begin_snapshot_stream("stream-old").unwrap());
        assert!(state.accept_snapshot("stream-old", snapshot(10)).unwrap());
        assert!(state.begin_snapshot_stream("stream-new").unwrap());
        assert!(!state.accept_snapshot("stream-old", snapshot(11)).unwrap());
        assert!(state.accept_snapshot("stream-new", snapshot(1)).unwrap());
    }

    #[test]
    fn invalidated_stream_clears_cache_and_rejects_in_flight_updates() {
        let state = PetRuntimeState::default();
        assert!(state.begin_snapshot_stream("stream-a").unwrap());
        assert!(state.accept_snapshot("stream-a", snapshot(10)).unwrap());

        state.invalidate_snapshot_stream().unwrap();
        assert!(state.latest_snapshot().unwrap().is_none());
        assert!(!state.accept_snapshot("stream-a", snapshot(11)).unwrap());

        assert!(state.begin_snapshot_stream("stream-a").unwrap());
        assert!(state.accept_snapshot("stream-a", snapshot(1)).unwrap());
    }

    #[test]
    fn snapshot_delivery_and_reset_callbacks_run_under_the_stream_lock() {
        let state = PetRuntimeState::default();
        assert!(state.begin_snapshot_stream("stream-a").unwrap());

        let mut delivery_was_ordered = false;
        assert!(state
            .accept_snapshot_with("stream-a", snapshot(1), |_| {
                delivery_was_ordered = state.snapshot_stream.try_lock().is_err();
            })
            .unwrap());
        assert!(delivery_was_ordered);

        let mut reset_was_ordered = false;
        state
            .invalidate_snapshot_stream_with(|| {
                reset_was_ordered = state.snapshot_stream.try_lock().is_err();
            })
            .unwrap();
        assert!(reset_was_ordered);

        let mut stream_reset_was_ordered = false;
        assert!(state
            .begin_snapshot_stream_with("stream-b", || {
                stream_reset_was_ordered = state.snapshot_stream.try_lock().is_err();
            })
            .unwrap());
        assert!(stream_reset_was_ordered);

        assert!(state.accept_snapshot("stream-b", snapshot(1)).unwrap());
        let mut replay_was_ordered = false;
        assert!(state
            .replay_snapshot_with(true, |_| {
                replay_was_ordered = state.snapshot_stream.try_lock().is_err();
            })
            .unwrap());
        assert!(replay_was_ordered);
        assert!(!state
            .replay_snapshot_with(false, |_| unreachable!())
            .unwrap());
    }
}
