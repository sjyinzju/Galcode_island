#[cfg(target_os = "windows")]
mod platform {
    use crate::pet_state::{
        PetBridgeEvent, PetBridgeInput, PetBridgeInputSource, PetInputEvent, PetInputKey,
        PetMouseButton, PetRuntimeState,
    };
    use std::{
        cell::RefCell,
        collections::HashMap,
        panic::{catch_unwind, AssertUnwindSafe},
        sync::{
            atomic::{AtomicBool, AtomicI64, Ordering},
            mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError},
            Arc, Mutex,
        },
        thread::{self, JoinHandle},
        time::Duration,
    };
    use windows::Win32::{
        Foundation::{HINSTANCE, LPARAM, LRESULT, POINT, WPARAM},
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::WindowsAndMessaging::{
            CallNextHookEx, DispatchMessageW, GetCursorPos, GetMessageW, PeekMessageW,
            PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
            HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_EXTENDED, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE,
            WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP,
            WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP,
            WM_SYSKEYDOWN, WM_SYSKEYUP,
        },
    };

    const DISCRETE_QUEUE_CAPACITY: usize = 256;
    const POINTER_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
    const INSTALL_TIMEOUT: Duration = Duration::from_secs(2);
    const STOP_TIMEOUT: Duration = Duration::from_millis(500);

    #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
    struct PhysicalKey {
        scan_code: u32,
        extended: bool,
    }

    #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
    enum PhysicalMouseButton {
        Left,
        Middle,
        Right,
    }

    #[derive(Default)]
    struct NativeInputTracker {
        physical_keys: HashMap<PhysicalKey, PetInputKey>,
        logical_key_counts: HashMap<PetInputKey, usize>,
        physical_mouse: HashMap<PhysicalMouseButton, PetMouseButton>,
        logical_mouse_counts: HashMap<PetMouseButton, usize>,
    }

    impl NativeInputTracker {
        fn keyboard(
            &mut self,
            scan_code: u32,
            extended: bool,
            down: bool,
        ) -> Option<PetInputEvent> {
            let physical = PhysicalKey {
                scan_code,
                extended,
            };
            if down {
                if self.physical_keys.contains_key(&physical) {
                    return None;
                }
                let key = map_scan_code(scan_code)?;
                self.physical_keys.insert(physical, key);
                let count = self.logical_key_counts.entry(key).or_default();
                *count += 1;
                return (*count == 1).then_some(PetInputEvent::KeyDown { key });
            }

            let key = self.physical_keys.remove(&physical)?;
            let count = self.logical_key_counts.get_mut(&key)?;
            if *count > 1 {
                *count -= 1;
                return None;
            }
            self.logical_key_counts.remove(&key);
            Some(PetInputEvent::KeyUp { key })
        }

        fn mouse(&mut self, physical: PhysicalMouseButton, down: bool) -> Option<PetInputEvent> {
            if down {
                if self.physical_mouse.contains_key(&physical) {
                    return None;
                }
                let button = match physical {
                    PhysicalMouseButton::Left | PhysicalMouseButton::Middle => {
                        PetMouseButton::Primary
                    }
                    PhysicalMouseButton::Right => PetMouseButton::Secondary,
                };
                self.physical_mouse.insert(physical, button);
                let count = self.logical_mouse_counts.entry(button).or_default();
                *count += 1;
                return (*count == 1).then_some(PetInputEvent::MouseDown { button });
            }

            let button = self.physical_mouse.remove(&physical)?;
            let count = self.logical_mouse_counts.get_mut(&button)?;
            if *count > 1 {
                *count -= 1;
                return None;
            }
            self.logical_mouse_counts.remove(&button);
            Some(PetInputEvent::MouseUp { button })
        }
    }

    fn map_scan_code(scan_code: u32) -> Option<PetInputKey> {
        match scan_code {
            0x02 => Some(PetInputKey::Digit1),
            0x03 => Some(PetInputKey::Digit2),
            0x04 => Some(PetInputKey::Digit3),
            0x05 => Some(PetInputKey::Digit4),
            0x06 => Some(PetInputKey::Digit5),
            0x10 => Some(PetInputKey::Q),
            0x11 => Some(PetInputKey::W),
            0x12 => Some(PetInputKey::E),
            0x13 => Some(PetInputKey::R),
            0x14 => Some(PetInputKey::T),
            0x1e => Some(PetInputKey::A),
            0x1f => Some(PetInputKey::S),
            0x20 => Some(PetInputKey::D),
            0x21 => Some(PetInputKey::F),
            0x2c => Some(PetInputKey::Z),
            0x2d => Some(PetInputKey::X),
            0x2e => Some(PetInputKey::C),
            0x2f => Some(PetInputKey::V),
            0x0f => Some(PetInputKey::Tab),
            0x2a | 0x36 => Some(PetInputKey::Shift),
            0x1d => Some(PetInputKey::Ctrl),
            0x1c => Some(PetInputKey::Enter),
            0x39 => Some(PetInputKey::Space),
            _ => None,
        }
    }

    enum DispatcherMessage {
        Input(PetInputEvent),
        Stop,
    }

    enum HookStatus {
        ThreadReady(u32),
        Installed(Result<(), String>),
    }

    struct HookShared {
        active: Arc<AtomicBool>,
        dispatcher: SyncSender<DispatcherMessage>,
        delta_x: AtomicI64,
        delta_y: AtomicI64,
        overflowed: AtomicBool,
    }

    impl HookShared {
        fn emit(&self, event: PetInputEvent) {
            if !self.active.load(Ordering::Acquire) || self.overflowed.load(Ordering::Acquire) {
                return;
            }
            match self.dispatcher.try_send(DispatcherMessage::Input(event)) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                    self.overflowed.store(true, Ordering::Release);
                }
            }
        }

        fn add_pointer_delta(&self, delta_x: i64, delta_y: i64) {
            if !self.active.load(Ordering::Acquire) || self.overflowed.load(Ordering::Acquire) {
                return;
            }
            add_saturating(&self.delta_x, delta_x);
            add_saturating(&self.delta_y, delta_y);
        }

        fn clear_pointer_delta(&self) {
            self.delta_x.store(0, Ordering::Release);
            self.delta_y.store(0, Ordering::Release);
        }
    }

    fn add_saturating(value: &AtomicI64, delta: i64) {
        let _ = value.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            Some(current.saturating_add(delta))
        });
    }

    struct HookContext {
        shared: Arc<HookShared>,
        tracker: NativeInputTracker,
        last_pointer: Option<(i32, i32)>,
    }

    impl HookContext {
        fn keyboard(&mut self, message: u32, data: &KBDLLHOOKSTRUCT) {
            let down = matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN);
            let up = matches!(message, WM_KEYUP | WM_SYSKEYUP);
            if !down && !up {
                return;
            }
            let extended = data.flags.contains(LLKHF_EXTENDED);
            if let Some(event) = self.tracker.keyboard(data.scanCode, extended, down) {
                self.shared.emit(event);
            }
        }

        fn mouse(&mut self, message: u32, data: &MSLLHOOKSTRUCT) {
            if message == WM_MOUSEMOVE {
                let current = (data.pt.x, data.pt.y);
                if let Some(previous) = self.last_pointer.replace(current) {
                    self.shared.add_pointer_delta(
                        i64::from(current.0) - i64::from(previous.0),
                        i64::from(current.1) - i64::from(previous.1),
                    );
                }
                return;
            }

            let mapped = match message {
                WM_LBUTTONDOWN => Some((PhysicalMouseButton::Left, true)),
                WM_LBUTTONUP => Some((PhysicalMouseButton::Left, false)),
                WM_MBUTTONDOWN => Some((PhysicalMouseButton::Middle, true)),
                WM_MBUTTONUP => Some((PhysicalMouseButton::Middle, false)),
                WM_RBUTTONDOWN => Some((PhysicalMouseButton::Right, true)),
                WM_RBUTTONUP => Some((PhysicalMouseButton::Right, false)),
                _ => None,
            };
            if let Some((button, down)) = mapped {
                if let Some(event) = self.tracker.mouse(button, down) {
                    self.shared.emit(event);
                }
            }
        }
    }

    thread_local! {
        static HOOK_CONTEXT: RefCell<Option<HookContext>> = const { RefCell::new(None) };
    }

    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let _ = catch_unwind(AssertUnwindSafe(|| {
                let data = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
                HOOK_CONTEXT.with(|context| {
                    if let Ok(mut context) = context.try_borrow_mut() {
                        if let Some(context) = context.as_mut() {
                            context.keyboard(wparam.0 as u32, data);
                        }
                    }
                });
            }));
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let _ = catch_unwind(AssertUnwindSafe(|| {
                let data = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
                HOOK_CONTEXT.with(|context| {
                    if let Ok(mut context) = context.try_borrow_mut() {
                        if let Some(context) = context.as_mut() {
                            context.mouse(wparam.0 as u32, data);
                        }
                    }
                });
            }));
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    struct RunningMonitor {
        active: Arc<AtomicBool>,
        hook_thread_id: u32,
        dispatcher: SyncSender<DispatcherMessage>,
        hook_thread: JoinHandle<()>,
        dispatcher_thread: JoinHandle<()>,
        state: Arc<PetRuntimeState>,
    }

    impl RunningMonitor {
        fn is_healthy(&self) -> bool {
            self.active.load(Ordering::Acquire)
                && !self.hook_thread.is_finished()
                && !self.dispatcher_thread.is_finished()
        }
    }

    pub struct PetGlobalInputMonitor {
        running: Mutex<Option<RunningMonitor>>,
    }

    impl Default for PetGlobalInputMonitor {
        fn default() -> Self {
            Self {
                running: Mutex::new(None),
            }
        }
    }

    impl PetGlobalInputMonitor {
        pub fn start(&self, state: Arc<PetRuntimeState>) -> Result<bool, String> {
            let stale = {
                let running = self
                    .running
                    .lock()
                    .map_err(|_| "global input monitor state is poisoned".to_string())?;
                if running.as_ref().is_some_and(RunningMonitor::is_healthy) {
                    return Ok(false);
                }
                running.is_some()
            };
            if stale {
                self.stop()?;
            }

            let mut running = self
                .running
                .lock()
                .map_err(|_| "global input monitor state is poisoned".to_string())?;
            if running.is_some() {
                return Ok(false);
            }

            let active = Arc::new(AtomicBool::new(true));
            let (dispatcher_tx, dispatcher_rx) =
                mpsc::sync_channel::<DispatcherMessage>(DISCRETE_QUEUE_CAPACITY);
            let shared = Arc::new(HookShared {
                active: Arc::clone(&active),
                dispatcher: dispatcher_tx.clone(),
                delta_x: AtomicI64::new(0),
                delta_y: AtomicI64::new(0),
                overflowed: AtomicBool::new(false),
            });

            let dispatcher_state = Arc::clone(&state);
            let dispatcher_shared = Arc::clone(&shared);
            let dispatcher_thread = thread::Builder::new()
                .name("pet-input-dispatch".into())
                .spawn(move || run_dispatcher(dispatcher_state, dispatcher_shared, dispatcher_rx))
                .map_err(|error| format!("failed to start global input dispatcher: {error}"))?;

            let (ready_tx, ready_rx) = mpsc::sync_channel::<HookStatus>(2);
            let hook_shared = Arc::clone(&shared);
            let hook_thread = match thread::Builder::new()
                .name("pet-input-hooks".into())
                .spawn(move || run_hook_thread(hook_shared, ready_tx))
            {
                Ok(thread) => thread,
                Err(error) => {
                    active.store(false, Ordering::Release);
                    let _ = dispatcher_tx.send(DispatcherMessage::Stop);
                    let _ = dispatcher_thread.join();
                    return Err(format!("failed to start global input hook thread: {error}"));
                }
            };

            let hook_thread_id = match ready_rx.recv_timeout(INSTALL_TIMEOUT) {
                Ok(HookStatus::ThreadReady(thread_id)) => thread_id,
                Ok(HookStatus::Installed(_)) => {
                    active.store(false, Ordering::Release);
                    drop(ready_rx);
                    settle_unconfirmed_hook_thread(hook_thread, None);
                    let _ = dispatcher_tx.send(DispatcherMessage::Stop);
                    let _ = dispatcher_thread.join();
                    return Err("global input hook handshake was out of order".into());
                }
                Err(error) => {
                    active.store(false, Ordering::Release);
                    drop(ready_rx);
                    settle_unconfirmed_hook_thread(hook_thread, None);
                    let _ = dispatcher_tx.send(DispatcherMessage::Stop);
                    let _ = dispatcher_thread.join();
                    return Err(format!(
                        "global input hook thread did not become ready: {error}"
                    ));
                }
            };
            match ready_rx.recv_timeout(INSTALL_TIMEOUT) {
                Ok(HookStatus::Installed(Ok(()))) => {}
                Ok(HookStatus::Installed(Err(error))) => {
                    active.store(false, Ordering::Release);
                    let _ = hook_thread.join();
                    let _ = dispatcher_tx.send(DispatcherMessage::Stop);
                    let _ = dispatcher_thread.join();
                    return Err(error);
                }
                Ok(HookStatus::ThreadReady(_)) => {
                    active.store(false, Ordering::Release);
                    drop(ready_rx);
                    settle_unconfirmed_hook_thread(hook_thread, Some(hook_thread_id));
                    let _ = dispatcher_tx.send(DispatcherMessage::Stop);
                    let _ = dispatcher_thread.join();
                    return Err("global input hook handshake repeated thread readiness".into());
                }
                Err(error) => {
                    active.store(false, Ordering::Release);
                    drop(ready_rx);
                    settle_unconfirmed_hook_thread(hook_thread, Some(hook_thread_id));
                    let _ = dispatcher_tx.send(DispatcherMessage::Stop);
                    let _ = dispatcher_thread.join();
                    return Err(format!("global input hook installation timed out: {error}"));
                }
            }

            *running = Some(RunningMonitor {
                active,
                hook_thread_id,
                dispatcher: dispatcher_tx,
                hook_thread,
                dispatcher_thread,
                state,
            });
            log::info!("[pet-input] global keyboard and mouse monitor installed");
            Ok(true)
        }

        pub fn stop(&self) -> Result<bool, String> {
            let mut running_slot = self
                .running
                .lock()
                .map_err(|_| "global input monitor state is poisoned".to_string())?;
            let Some(running) = running_slot.take() else {
                return Ok(false);
            };

            running.active.store(false, Ordering::Release);
            if !running.hook_thread.is_finished() {
                if let Err(error) = unsafe {
                    PostThreadMessageW(running.hook_thread_id, WM_QUIT, WPARAM(0), LPARAM(0))
                } {
                    if !running.hook_thread.is_finished() {
                        *running_slot = Some(running);
                        return Err(format!("failed to stop global input hook thread: {error}"));
                    }
                }
            }
            if !wait_for_thread_stop(&running.hook_thread, STOP_TIMEOUT) {
                *running_slot = Some(running);
                return Err("global input hook thread did not stop in time".into());
            }
            let mut errors: Vec<String> = Vec::new();
            if running.hook_thread.join().is_err() {
                errors.push("global input hook thread panicked".into());
            }
            if running.dispatcher.send(DispatcherMessage::Stop).is_err()
                && !running.dispatcher_thread.is_finished()
            {
                errors.push("failed to stop global input dispatcher".into());
            }
            if running.dispatcher_thread.join().is_err() {
                errors.push("global input dispatcher panicked".into());
            }
            let _ = running
                .state
                .send_bridge(PetBridgeEvent::Input(PetBridgeInput {
                    source: PetBridgeInputSource::Global,
                    event: PetInputEvent::Reset,
                }));
            drop(running_slot);
            log::info!("[pet-input] global keyboard and mouse monitor stopped");

            if errors.is_empty() {
                Ok(true)
            } else {
                Err(errors.join("; "))
            }
        }
    }

    fn wait_for_thread_stop(thread: &JoinHandle<()>, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while !thread.is_finished() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        thread.is_finished()
    }

    impl Drop for PetGlobalInputMonitor {
        fn drop(&mut self) {
            let _ = self.stop();
        }
    }

    fn settle_unconfirmed_hook_thread(thread: JoinHandle<()>, thread_id: Option<u32>) {
        if let Some(thread_id) = thread_id {
            let _ = unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        }
        for _ in 0..20 {
            if thread.is_finished() {
                let _ = thread.join();
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn send_global_input(
        state: &PetRuntimeState,
        active: &AtomicBool,
        event: PetInputEvent,
    ) -> bool {
        if !active.load(Ordering::Acquire) {
            return true;
        }
        match state.send_bridge(PetBridgeEvent::Input(PetBridgeInput {
            source: PetBridgeInputSource::Global,
            event,
        })) {
            Ok(true) => true,
            Ok(false) => {
                state.set_ready(false);
                active.store(false, Ordering::Release);
                false
            }
            Err(error) => {
                log::warn!("[pet-input] bridge delivery failed: {error}");
                state.set_ready(false);
                active.store(false, Ordering::Release);
                false
            }
        }
    }

    fn flush_pointer(state: &PetRuntimeState, shared: &HookShared) -> bool {
        if !shared.active.load(Ordering::Acquire) {
            shared.clear_pointer_delta();
            return true;
        }
        let delta_x = shared.delta_x.swap(0, Ordering::AcqRel);
        let delta_y = shared.delta_y.swap(0, Ordering::AcqRel);
        if delta_x == 0 && delta_y == 0 {
            return true;
        }
        send_global_input(
            state,
            &shared.active,
            PetInputEvent::MouseMove {
                delta_x: clamp_i64_to_i32(delta_x),
                delta_y: clamp_i64_to_i32(delta_y),
            },
        )
    }

    fn clamp_i64_to_i32(value: i64) -> i32 {
        value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
    }

    fn run_dispatcher(
        state: Arc<PetRuntimeState>,
        shared: Arc<HookShared>,
        receiver: Receiver<DispatcherMessage>,
    ) {
        loop {
            if shared.overflowed.load(Ordering::Acquire) {
                shared.clear_pointer_delta();
                loop {
                    match receiver.try_recv() {
                        Ok(DispatcherMessage::Input(_)) => {}
                        Ok(DispatcherMessage::Stop) | Err(TryRecvError::Disconnected) => return,
                        Err(TryRecvError::Empty) => break,
                    }
                }
                if !send_global_input(&state, &shared.active, PetInputEvent::Reset) {
                    return;
                }
                shared.overflowed.store(false, Ordering::Release);
                continue;
            }
            match receiver.recv_timeout(POINTER_FLUSH_INTERVAL) {
                Ok(DispatcherMessage::Input(event)) => {
                    if !flush_pointer(&state, &shared)
                        || !send_global_input(&state, &shared.active, event)
                    {
                        return;
                    }
                }
                Ok(DispatcherMessage::Stop) => {
                    shared.clear_pointer_delta();
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !flush_pointer(&state, &shared) {
                        return;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn run_hook_thread(shared: Arc<HookShared>, ready: SyncSender<HookStatus>) {
        let result = unsafe { install_and_run_hooks(Arc::clone(&shared), &ready) };
        shared.active.store(false, Ordering::Release);
        if let Err(error) = result {
            let _ = ready.try_send(HookStatus::Installed(Err(error)));
        }
    }

    unsafe fn install_and_run_hooks(
        shared: Arc<HookShared>,
        ready: &SyncSender<HookStatus>,
    ) -> Result<(), String> {
        let thread_id = unsafe { GetCurrentThreadId() };
        let mut message = MSG::default();
        unsafe {
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        }
        if ready.send(HookStatus::ThreadReady(thread_id)).is_err() {
            return Ok(());
        }

        let mut pointer = POINT::default();
        let last_pointer = unsafe { GetCursorPos(&mut pointer) }
            .ok()
            .map(|_| (pointer.x, pointer.y));
        HOOK_CONTEXT.with(|context| {
            *context.borrow_mut() = Some(HookContext {
                shared,
                tracker: NativeInputTracker::default(),
                last_pointer,
            });
        });

        let module = unsafe { GetModuleHandleW(None) }
            .map_err(|error| format!("failed to resolve executable module: {error}"))?;
        let keyboard = match unsafe {
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), HINSTANCE(module.0), 0)
        } {
            Ok(hook) => hook,
            Err(error) => {
                HOOK_CONTEXT.with(|context| *context.borrow_mut() = None);
                return Err(format!("failed to install global keyboard hook: {error}"));
            }
        };
        let mouse = match unsafe {
            SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), HINSTANCE(module.0), 0)
        } {
            Ok(hook) => hook,
            Err(error) => {
                let _ = unsafe { UnhookWindowsHookEx(keyboard) };
                HOOK_CONTEXT.with(|context| *context.borrow_mut() = None);
                return Err(format!("failed to install global mouse hook: {error}"));
            }
        };

        if ready.send(HookStatus::Installed(Ok(()))).is_err() {
            let _ = unsafe { UnhookWindowsHookEx(mouse) };
            let _ = unsafe { UnhookWindowsHookEx(keyboard) };
            HOOK_CONTEXT.with(|context| *context.borrow_mut() = None);
            return Ok(());
        }

        loop {
            let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
            if result.0 == -1 {
                break;
            }
            if result.0 == 0 {
                break;
            }
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }

        let mouse_result = unsafe { UnhookWindowsHookEx(mouse) };
        let keyboard_result = unsafe { UnhookWindowsHookEx(keyboard) };
        HOOK_CONTEXT.with(|context| *context.borrow_mut() = None);
        mouse_result.map_err(|error| format!("failed to uninstall global mouse hook: {error}"))?;
        keyboard_result
            .map_err(|error| format!("failed to uninstall global keyboard hook: {error}"))?;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn scan_code_map_is_narrow_and_physical() {
            assert_eq!(map_scan_code(0x02), Some(PetInputKey::Digit1));
            assert_eq!(map_scan_code(0x10), Some(PetInputKey::Q));
            assert_eq!(map_scan_code(0x39), Some(PetInputKey::Space));
            assert_eq!(map_scan_code(0x01), None);
            assert_eq!(map_scan_code(0x3b), None);
        }

        #[test]
        fn keyboard_tracker_suppresses_repeat_and_counts_modifiers() {
            let mut tracker = NativeInputTracker::default();
            assert_eq!(
                tracker.keyboard(0x2a, false, true),
                Some(PetInputEvent::KeyDown {
                    key: PetInputKey::Shift
                })
            );
            assert_eq!(tracker.keyboard(0x2a, false, true), None);
            assert_eq!(tracker.keyboard(0x36, false, true), None);
            assert_eq!(tracker.keyboard(0x2a, false, false), None);
            assert_eq!(
                tracker.keyboard(0x36, false, false),
                Some(PetInputEvent::KeyUp {
                    key: PetInputKey::Shift
                })
            );
            assert_eq!(tracker.keyboard(0x36, false, false), None);
        }

        #[test]
        fn keyboard_tracker_distinguishes_extended_physical_keys() {
            let mut tracker = NativeInputTracker::default();
            assert!(matches!(
                tracker.keyboard(0x1d, false, true),
                Some(PetInputEvent::KeyDown {
                    key: PetInputKey::Ctrl
                })
            ));
            assert_eq!(tracker.keyboard(0x1d, true, true), None);
            assert_eq!(tracker.keyboard(0x1d, false, false), None);
            assert!(matches!(
                tracker.keyboard(0x1d, true, false),
                Some(PetInputEvent::KeyUp {
                    key: PetInputKey::Ctrl
                })
            ));
        }

        #[test]
        fn mouse_tracker_maps_middle_to_primary_with_reference_counts() {
            let mut tracker = NativeInputTracker::default();
            assert_eq!(
                tracker.mouse(PhysicalMouseButton::Left, true),
                Some(PetInputEvent::MouseDown {
                    button: PetMouseButton::Primary
                })
            );
            assert_eq!(tracker.mouse(PhysicalMouseButton::Middle, true), None);
            assert_eq!(tracker.mouse(PhysicalMouseButton::Left, false), None);
            assert_eq!(
                tracker.mouse(PhysicalMouseButton::Middle, false),
                Some(PetInputEvent::MouseUp {
                    button: PetMouseButton::Primary
                })
            );
            assert!(matches!(
                tracker.mouse(PhysicalMouseButton::Right, true),
                Some(PetInputEvent::MouseDown {
                    button: PetMouseButton::Secondary
                })
            ));
        }

        #[test]
        fn pointer_delta_clamps_to_the_typed_bridge_range() {
            assert_eq!(clamp_i64_to_i32(i64::from(i32::MAX) + 1), i32::MAX);
            assert_eq!(clamp_i64_to_i32(i64::from(i32::MIN) - 1), i32::MIN);
            assert_eq!(clamp_i64_to_i32(-42), -42);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use crate::pet_state::PetRuntimeState;
    use std::sync::Arc;

    #[derive(Default)]
    pub struct PetGlobalInputMonitor;

    impl PetGlobalInputMonitor {
        pub fn start(&self, _state: Arc<PetRuntimeState>) -> Result<bool, String> {
            Ok(false)
        }

        pub fn stop(&self) -> Result<bool, String> {
            Ok(false)
        }
    }
}

pub use platform::PetGlobalInputMonitor;
