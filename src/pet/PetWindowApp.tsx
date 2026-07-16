import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  DEFAULT_DESKTOP_PET_SETTINGS,
  PET_MODEL_IDS,
  type PetAction,
  type PetModelId,
  type PetSemanticAction,
  type PetVisualState,
} from "../types/pet";
import {
  PokeRequestGate,
  nextPetScale,
  shouldStartPetDrag,
} from "./interactionPolicy";
import { Live2DPetRenderer } from "./Live2DPetRenderer";
import { PET_MODEL_DEFINITIONS } from "./modelDefinitions";
import { PetSpeechBubble } from "./PetSpeechBubble";
import {
  listenForWindowPetInput,
  publishPetInput,
} from "./petInput";
import { usePetBridge } from "./usePetBridge";

const DOUBLE_CLICK_DELAY_MS = 260;
const POKE_DISPLAY_MS = 1_200;
const MENU_WIDTH = 216;
const MENU_HEIGHT = 390;

const POKE_LINES: Record<PetModelId, readonly string[]> = {
  haruhi: ["喂！我正在监督这个任务。", "不许偷懒。", "要我帮你打开任务吗？"],
  mikuru: ["我就在这里。", "请、请温柔一点。", "任务还在关注中。"],
  yuki: ["已确认输入。", "状态仍可观察。", "等待下一个事件。"],
};

interface PointerSession {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

interface ContextMenuPosition {
  x: number;
  y: number;
}

function semanticActionForState(state: PetVisualState): PetSemanticAction {
  switch (state) {
    case "starting":
      return "hello";
    case "thinking":
      return "thinking";
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "complete":
      return "complete";
    case "error":
      return "error";
    case "idle":
    default:
      return "idle";
  }
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest("button, input, select, [role='menu'], [data-pet-interactive]"));
}

export function PetWindowApp(): JSX.Element {
  const {
    settings: settingsSnapshot,
    snapshot,
    nativeVisible,
    error: bridgeError,
    retry,
    sendAction,
    setClickThrough,
  } = usePetBridge();
  const settings = settingsSnapshot ?? DEFAULT_DESKTOP_PET_SETTINGS;
  const pointerRef = useRef<PointerSession | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const pokeTimerRef = useRef<number | null>(null);
  const pokeGateRef = useRef(new PokeRequestGate());
  const wheelScaleRef = useRef(settings.scale);
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null);
  const [pokeToken, setPokeToken] = useState<number | null>(null);
  const [localSpeech, setLocalSpeech] = useState<string | null>(null);

  useEffect(() => {
    wheelScaleRef.current = settings.scale;
  }, [settings.scale]);

  useEffect(() => listenForWindowPetInput((event) => {
    publishPetInput("pet", event);
  }), []);

  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    if (pokeTimerRef.current !== null) window.clearTimeout(pokeTimerRef.current);
    pokeGateRef.current.invalidate();
  }, []);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("blur", closeMenu);
    return () => window.removeEventListener("blur", closeMenu);
  }, []);

  const dispatchAction = useCallback((action: PetAction) => {
    void sendAction(action).catch(() => undefined);
  }, [sendAction]);

  const openCurrentTask = useCallback(() => {
    setContextMenu(null);
    if (snapshot?.activeTaskId) {
      dispatchAction({ type: "open-task", taskId: snapshot.activeTaskId });
    } else {
      dispatchAction({ type: "show-main" });
    }
  }, [dispatchAction, snapshot?.activeTaskId]);

  const poke = useCallback(() => {
    const token = pokeGateRef.current.begin(Date.now());
    if (token === null) return;

    const lines = POKE_LINES[settings.modelId];
    const line = lines[(token - 1) % lines.length] ?? lines[0] ?? "你好。";
    setPokeToken(token);
    setLocalSpeech(line);
    dispatchAction({ type: "poke" });

    if (pokeTimerRef.current !== null) window.clearTimeout(pokeTimerRef.current);
    pokeTimerRef.current = window.setTimeout(() => {
      if (!pokeGateRef.current.isCurrent(token)) return;
      setPokeToken(null);
      setLocalSpeech(null);
      pokeTimerRef.current = null;
    }, POKE_DISPLAY_MS);
  }, [dispatchAction, settings.modelId]);

  const handleClickCandidate = useCallback(() => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      openCurrentTask();
      return;
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      poke();
    }, DOUBLE_CLICK_DELAY_MS);
  }, [openCurrentTask, poke]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return;
    setContextMenu(null);
    pointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = pointerRef.current;
    if (!session || session.pointerId !== event.pointerId || session.dragging) return;
    if (!shouldStartPetDrag(
      { x: session.startX, y: session.startY },
      { x: event.clientX, y: event.clientY },
    )) return;

    session.dragging = true;
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    void getCurrentWindow().startDragging()
      .then(() => dispatchAction({ type: "drag-ended" }))
      .catch(() => undefined)
      .finally(() => {
        pointerRef.current = null;
        publishPetInput("pet", { type: "reset" });
      });
  }, [dispatchAction]);

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = pointerRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    pointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!session.dragging) handleClickCandidate();
  }, [handleClickCandidate]);

  const cancelPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerRef.current?.pointerId === event.pointerId) pointerRef.current = null;
  }, []);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0 || isInteractiveTarget(event.target)) return;
    event.preventDefault();
    const nextScale = nextPetScale(wheelScaleRef.current, event.deltaY);
    if (nextScale === wheelScaleRef.current) return;
    wheelScaleRef.current = nextScale;
    dispatchAction({ type: "set-scale", scale: nextScale });
  }, [dispatchAction]);

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    pointerRef.current = null;
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - 8)),
    });
  }, []);

  const semanticAction = pokeToken === null
    ? semanticActionForState(snapshot?.visualState ?? "idle")
    : "poke";
  const actionToken = pokeToken ?? snapshot?.seq ?? 0;
  const speech = localSpeech ?? snapshot?.speech ?? null;
  const modelOptions = useMemo(
    () => PET_MODEL_IDS.map((modelId) => PET_MODEL_DEFINITIONS[modelId]),
    [],
  );

  return (
    <div
      className="pet-window"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={cancelPointer}
      onWheel={handleWheel}
      onContextMenu={handleContextMenu}
    >
      <PetSpeechBubble
        speech={speech}
        taskTitle={snapshot?.activeTaskTitle ?? null}
        runningCount={snapshot?.runningCount ?? 0}
        onOpenTask={snapshot?.activeTaskId ? openCurrentTask : null}
      />

      <Live2DPetRenderer
        modelId={settings.modelId}
        semanticAction={semanticAction}
        actionToken={actionToken}
        reducedMotion={settings.reducedMotion}
        mirrored={settings.mirror}
        nativeVisible={nativeVisible}
      />

      {!settingsSnapshot && !bridgeError && (
        <div className="pet-window__connecting" role="status">正在连接…</div>
      )}
      {bridgeError && (
        <button
          type="button"
          className="pet-window__bridge-error"
          onClick={() => void retry()}
          title={bridgeError}
        >
          连接异常，点击重试
        </button>
      )}

      {contextMenu && (
        <div
          className="pet-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={openCurrentTask}>
            {snapshot?.activeTaskId ? "打开当前任务" : "显示 Galcode"}
          </button>
          <div className="pet-menu__separator" />
          <div className="pet-menu__label">角色</div>
          {modelOptions.map((model) => (
            <button
              key={model.id}
              type="button"
              role="menuitemradio"
              aria-checked={settings.modelId === model.id}
              onClick={() => {
                setContextMenu(null);
                dispatchAction({ type: "set-model", modelId: model.id });
              }}
            >
              <span>{model.displayName}</span>
              {settings.modelId === model.id && <span aria-hidden="true">✓</span>}
            </button>
          ))}
          <div className="pet-menu__separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={settings.alwaysOnTop}
            onClick={() => {
              setContextMenu(null);
              dispatchAction({ type: "set-always-on-top", enabled: !settings.alwaysOnTop });
            }}
          >
            <span>始终置顶</span><span>{settings.alwaysOnTop ? "开" : "关"}</span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={settings.mirror}
            onClick={() => {
              setContextMenu(null);
              dispatchAction({ type: "set-mirror", enabled: !settings.mirror });
            }}
          >
            <span>镜像模型</span><span>{settings.mirror ? "开" : "关"}</span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={settings.clickThrough}
            onClick={() => {
              setContextMenu(null);
              void setClickThrough(!settings.clickThrough).catch(() => undefined);
            }}
          >
            <span>鼠标穿透</span><span>{settings.clickThrough ? "开" : "关"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              dispatchAction({ type: "reset-position" });
            }}
          >
            重置位置
          </button>
          <button
            type="button"
            role="menuitem"
            className="pet-menu__danger"
            onClick={() => {
              setContextMenu(null);
              dispatchAction({ type: "hide" });
            }}
          >
            隐藏桌宠
          </button>
        </div>
      )}
    </div>
  );
}
