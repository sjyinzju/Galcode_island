import { useEffect } from "react";
import { buildPetSnapshot, COMPLETE_HOLD_MS } from "../lib/petPresentation";
import { invoke, isTauri, listen, type UnlistenFn } from "../lib/bridge";
import { normalizeDesktopPetSettings, parsePetAction } from "../pet/protocol";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTabsStore } from "../stores/useTabsStore";
import type { DesktopPetSettings, PetAction, PetSnapshot } from "../types/pet";

type SnapshotContent = Omit<PetSnapshot, "seq">;

const PET_STREAM_ID = (() => {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `main_${suffix}`.slice(0, 64);
})();

let snapshotSequence = 0;

function settingsKey(settings: DesktopPetSettings, show: boolean): string {
  return JSON.stringify({ settings, show });
}

function snapshotKey(snapshot: SnapshotContent): string {
  return JSON.stringify(snapshot);
}

export function useDesktopPetCoordinator(): void {
  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;
    let configured = false;
    let desiredConfigKey: string | null = null;
    let appliedConfigKey: string | null = null;
    let showIntent = false;
    let previousEnabled = false;
    let pendingConfig: { settings: DesktopPetSettings; show: boolean; key: string } | null = null;
    let configureWorker: Promise<void> | null = null;
    let pendingSnapshot: SnapshotContent | null = null;
    let sentSnapshotKey: string | null = null;
    let snapshotWorker: Promise<void> | null = null;
    let snapshotMicrotaskQueued = false;
    let snapshotRetryTimer: number | null = null;
    let configureRetryTimer: number | null = null;
    let completeTimer: number | null = null;
    let actionUnlisten: UnlistenFn | null = null;
    let tabsUnlisten: (() => void) | null = null;
    let settingsUnlisten: (() => void) | null = null;
    const hydrationUnlisteners: Array<() => void> = [];

    const clearCompleteTimer = () => {
      if (completeTimer !== null) {
        window.clearTimeout(completeTimer);
        completeTimer = null;
      }
    };

    const clearSnapshotRetryTimer = () => {
      if (snapshotRetryTimer !== null) {
        window.clearTimeout(snapshotRetryTimer);
        snapshotRetryTimer = null;
      }
    };

    const clearConfigureRetryTimer = () => {
      if (configureRetryTimer !== null) {
        window.clearTimeout(configureRetryTimer);
        configureRetryTimer = null;
      }
    };

    const clearSnapshotQueue = () => {
      pendingSnapshot = null;
      sentSnapshotKey = null;
      clearCompleteTimer();
      clearSnapshotRetryTimer();
    };

    const snapshotsEnabled = () => useSettingsStore.getState().desktopPet.enabled;

    const scheduleCompleteExpiry = (now: number) => {
      clearCompleteTimer();
      let nextExpiry = Number.POSITIVE_INFINITY;
      for (const tab of Object.values(useTabsStore.getState().tabs)) {
        if (tab.agentStatus !== "completed") continue;
        const expiry = tab.lastActiveAt + COMPLETE_HOLD_MS;
        if (expiry > now) nextExpiry = Math.min(nextExpiry, expiry);
      }
      if (Number.isFinite(nextExpiry)) {
        completeTimer = window.setTimeout(() => {
          completeTimer = null;
          queueSnapshot();
        }, Math.max(1, nextExpiry - now + 1));
      }
    };

    const buildSnapshotContent = (): SnapshotContent => {
      const settings = useSettingsStore.getState().desktopPet;
      const now = Date.now();
      const { seq: _seq, ...content } = buildPetSnapshot({
        seq: 1,
        modelId: settings.modelId,
        reducedMotion: settings.reducedMotion,
        tabs: useTabsStore.getState().tabs,
        now,
      });
      scheduleCompleteExpiry(now);
      return content;
    };

    const waitForConfigureIdle = async (): Promise<void> => {
      while (!cancelled && configureWorker) {
        const current = configureWorker;
        await current;
        if (current === configureWorker) break;
      }
    };

    const runSnapshotWorker = () => {
      if (snapshotWorker || cancelled) return;
      snapshotWorker = (async () => {
        while (!cancelled && pendingSnapshot) {
          if (!snapshotsEnabled()) {
            clearSnapshotQueue();
            return;
          }
          await waitForConfigureIdle();
          if (
            cancelled
            || !snapshotsEnabled()
            || !configured
            || !desiredConfigKey
            || appliedConfigKey !== desiredConfigKey
          ) {
            if (!snapshotsEnabled()) clearSnapshotQueue();
            return;
          }
          const snapshot = pendingSnapshot;
          const key = snapshotKey(snapshot);
          if (key === sentSnapshotKey) {
            if (pendingSnapshot && snapshotKey(pendingSnapshot) === key) pendingSnapshot = null;
            continue;
          }
          if (snapshotSequence >= Number.MAX_SAFE_INTEGER) {
            console.error("[pet] snapshot sequence exhausted");
            return;
          }
          const seq = ++snapshotSequence;
          try {
            const accepted = await invoke<boolean>("pet_update_snapshot", {
              streamId: PET_STREAM_ID,
              snapshot: { ...snapshot, seq },
            });
            if (!snapshotsEnabled()) {
              clearSnapshotQueue();
              return;
            }
            if (!accepted) {
              configured = false;
              appliedConfigKey = null;
              queueConfigure(useSettingsStore.getState().desktopPet, showIntent);
              return;
            }
          } catch (error) {
            console.error("[pet] failed to update snapshot", error);
            if (!snapshotsEnabled()) {
              clearSnapshotQueue();
              return;
            }
            if (snapshotRetryTimer === null) {
              snapshotRetryTimer = window.setTimeout(() => {
                snapshotRetryTimer = null;
                runSnapshotWorker();
              }, 500);
            }
            return;
          }
          clearSnapshotRetryTimer();
          sentSnapshotKey = key;
          if (pendingSnapshot && snapshotKey(pendingSnapshot) === key) pendingSnapshot = null;
        }
      })().finally(() => {
        snapshotWorker = null;
      });
    };

    const queueSnapshot = () => {
      if (cancelled) return;
      if (!snapshotsEnabled()) {
        clearSnapshotQueue();
        return;
      }
      pendingSnapshot = buildSnapshotContent();
      if (snapshotMicrotaskQueued) return;
      snapshotMicrotaskQueued = true;
      queueMicrotask(() => {
        snapshotMicrotaskQueued = false;
        runSnapshotWorker();
      });
    };

    const runConfigureWorker = () => {
      if (configureWorker || cancelled) return;
      configureWorker = (async () => {
        while (!cancelled && pendingConfig) {
          const job = pendingConfig;
          pendingConfig = null;
          if (job.key === appliedConfigKey) continue;
          try {
            await invoke("pet_configure", {
              settings: job.settings,
              show: job.show,
              streamId: PET_STREAM_ID,
            });
          } catch (error) {
            console.error("[pet] failed to configure desktop pet", error);
            if (!pendingConfig) pendingConfig = job;
            return;
          }
          configured = true;
          appliedConfigKey = job.key;
          if (job.settings.enabled) queueSnapshot();
          else clearSnapshotQueue();
        }
      })().finally(() => {
        configureWorker = null;
        if (!cancelled && pendingConfig && pendingConfig.key !== appliedConfigKey) {
          clearConfigureRetryTimer();
          configureRetryTimer = window.setTimeout(() => {
            configureRetryTimer = null;
            runConfigureWorker();
          }, 500);
        }
      });
    };

    const queueConfigure = (settings: DesktopPetSettings, show: boolean) => {
      const normalized = normalizeDesktopPetSettings(settings);
      if (!normalized.enabled) clearSnapshotQueue();
      const key = settingsKey(normalized, show);
      desiredConfigKey = key;
      clearConfigureRetryTimer();
      if (key === appliedConfigKey && !pendingConfig) {
        queueSnapshot();
        return;
      }
      pendingConfig = { settings: normalized, show, key };
      runConfigureWorker();
    };

    let applyingNativeAction = false;

    const applyActionSettings = (patch: Partial<DesktopPetSettings>) => {
      applyingNativeAction = true;
      try {
        useSettingsStore.getState().setDesktopPetSettings(patch);
      } finally {
        applyingNativeAction = false;
      }
      queueSnapshot();
    };

    const handleAction = (rawAction: unknown) => {
      const action = parsePetAction(rawAction);
      if (!action) {
        console.warn("[pet] ignored invalid action", rawAction);
        return;
      }
      switch (action.type) {
        case "open-task":
          if (action.taskId && useTabsStore.getState().tabs[action.taskId]) {
            useTabsStore.getState().setActiveTab(action.taskId);
          }
          break;
        case "hide":
          showIntent = false;
          break;
        case "set-enabled":
          showIntent = action.enabled;
          applyActionSettings({ enabled: action.enabled });
          break;
        case "set-model":
          applyActionSettings({ modelId: action.modelId });
          break;
        case "set-scale":
          applyActionSettings({ scale: action.scale });
          break;
        case "set-click-through":
          applyActionSettings({ clickThrough: action.enabled });
          break;
        case "set-always-on-top":
          applyActionSettings({ alwaysOnTop: action.enabled });
          break;
        case "set-mirror":
          applyActionSettings({ mirror: action.enabled });
          break;
        default:
          break;
      }
    };

    const waitForHydration = (
      persist: {
        hasHydrated: () => boolean;
        onFinishHydration: (callback: () => void) => () => void;
      },
    ): Promise<void> => {
      if (persist.hasHydrated()) return Promise.resolve();
      return new Promise((resolve) => {
        const unlisten = persist.onFinishHydration(() => {
          unlisten();
          resolve();
        });
        hydrationUnlisteners.push(unlisten);
      });
    };

    const start = async () => {
      const unlisten = await listen<PetAction>("pet://action", (event) => {
        handleAction(event.payload);
      });
      if (cancelled) {
        unlisten();
        return;
      }
      actionUnlisten = unlisten;

      await Promise.all([
        waitForHydration(useSettingsStore.persist),
        waitForHydration(useTabsStore.persist),
      ]);
      if (cancelled) return;

      const initialSettings = useSettingsStore.getState().desktopPet;
      let observedSettingsKey = JSON.stringify(initialSettings);
      previousEnabled = initialSettings.enabled;
      showIntent = initialSettings.enabled && initialSettings.showOnStartup;

      settingsUnlisten = useSettingsStore.subscribe((state) => {
        const settings = state.desktopPet;
        const nextSettingsKey = JSON.stringify(settings);
        if (nextSettingsKey === observedSettingsKey) return;
        observedSettingsKey = nextSettingsKey;
        if (!previousEnabled && settings.enabled) showIntent = true;
        if (!settings.enabled) showIntent = false;
        previousEnabled = settings.enabled;
        if (applyingNativeAction) {
          queueSnapshot();
          return;
        }
        queueConfigure(settings, showIntent);
        queueSnapshot();
      });
      tabsUnlisten = useTabsStore.subscribe(() => queueSnapshot());

      queueConfigure(initialSettings, showIntent);
    };

    void start().catch((error) => console.error("[pet] coordinator startup failed", error));

    return () => {
      cancelled = true;
      clearSnapshotQueue();
      clearConfigureRetryTimer();
      actionUnlisten?.();
      tabsUnlisten?.();
      settingsUnlisten?.();
      hydrationUnlisteners.forEach((unlisten) => unlisten());
      pendingConfig = null;
    };
  }, []);
}
