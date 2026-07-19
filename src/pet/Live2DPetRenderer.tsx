import { Application } from "pixi.js";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Live2DModel } from "pixi-live2d-display/cubism4";
import type { PetModelId, PetSemanticAction } from "../types/pet";
import { PET_MODEL_DEFINITIONS } from "./modelDefinitions";
import {
  PET_STEADY_MAX_FPS,
  resolvePetMotion,
  resolvePetMotionSteps,
  resolvePetTickerPolicy,
  type PetTickerPhase,
  type ResolvedPetMotion,
} from "./motionAdapter";
import { applyCubismCoreCompatibility } from "./cubismCoreCompatibility";
import { installPixiCspAdapter } from "./pixiCspAdapter";
import { subscribePetInput } from "./petInput";
import { PetInputParameterController } from "./petInputParameterController";
import { PetPointerFocusController } from "./petPointerFocusController";

const MAX_DEVICE_PIXEL_RATIO = 1.5;
const ACCENT_DURATION_MS = 240;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type Cubism4Module = typeof import("pixi-live2d-display/cubism4");
type RendererLoadState = "loading" | "ready" | "error";
type MotionPlaybackResult = "finished" | "not-started" | "aborted";
type MotionStartResult = "started" | "not-started" | "aborted";

interface MotionStartOutcome {
  result: MotionStartResult;
  error?: string;
}

interface MotionManagerRuntime {
  on(event: "motionFinish", listener: () => void): unknown;
  off(event: "motionFinish", listener: () => void): unknown;
  stopAllMotions(): void;
}

export interface Live2DPetRendererProps {
  modelId: PetModelId;
  semanticAction: PetSemanticAction;
  actionToken: number;
  reducedMotion: boolean;
  mirrored: boolean;
  nativeVisible: boolean;
  onReady?: () => void;
  onError?: (message: string) => void;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  if (message && /[\u3400-\u9fff]/u.test(message)) return message;
  console.error("[pet] Live2D renderer error", error);
  if (message) return "请查看应用日志了解详情";
  return "未知的 Live2D 渲染错误";
}

function currentDevicePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const ratio = window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

function currentRendererResolution(): number {
  return Math.min(
    MAX_DEVICE_PIXEL_RATIO,
    Math.max(1, currentDevicePixelRatio()),
  );
}

function motionManager(model: Live2DModel): MotionManagerRuntime {
  return model.internalModel.motionManager as unknown as MotionManagerRuntime;
}

function stopModelMotions(model: Live2DModel | null): void {
  if (!model) return;
  try {
    motionManager(model).stopAllMotions();
  } catch {
    // A model may already be partially destroyed while an async motion is settling.
  }
}

class MotionStartCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly model: Live2DModel,
    private readonly runtime: Cubism4Module,
  ) {}

  start(group: string, signal: AbortSignal): Promise<MotionStartOutcome> {
    const run = this.tail.then(async (): Promise<MotionStartOutcome> => {
      if (this.disposed || signal.aborted) return { result: "aborted" };

      try {
        const started = await this.model.motion(
          group,
          undefined,
          this.runtime.MotionPriority.FORCE,
        );

        if (this.disposed || signal.aborted) {
          stopModelMotions(this.model);
          return { result: "aborted" };
        }
        if (!started) {
          stopModelMotions(this.model);
          return { result: "not-started" };
        }
        return { result: "started" };
      } catch (error) {
        stopModelMotions(this.model);
        if (this.disposed || signal.aborted) return { result: "aborted" };
        return {
          result: "not-started",
          error: "Live2D 动作播放失败：" + errorMessage(error),
        };
      }
    });

    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function destroyModel(model: Live2DModel | null): void {
  if (!model) return;
  try {
    model.destroy({ children: true, texture: true, baseTexture: true });
  } catch {
    // A partially initialized model can fail while releasing its internal Core model.
  }
}

function fitModel(
  app: Application,
  model: Live2DModel,
  mirrored: boolean,
): void {
  const naturalWidth = Math.max(1, model.internalModel.width);
  const naturalHeight = Math.max(1, model.internalModel.height);
  const fittedScale = Math.min(
    (app.screen.width * 0.94) / naturalWidth,
    (app.screen.height * 0.94) / naturalHeight,
  );

  model.anchor.set(0.5, 0.55);
  model.position.set(app.screen.width / 2, app.screen.height * 0.62);
  model.scale.set(mirrored ? -fittedScale : fittedScale, fittedScale);
}

function waitForMotionFinish(
  manager: MotionManagerRuntime,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;

    const settle = (finished: boolean) => {
      if (settled) return;
      settled = true;
      manager.off("motionFinish", onFinish);
      signal.removeEventListener("abort", onAbort);
      resolve(finished);
    };
    const onFinish = () => settle(true);
    const onAbort = () => settle(false);

    manager.on("motionFinish", onFinish);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function playMotionGroupAndWait(
  model: Live2DModel,
  coordinator: MotionStartCoordinator,
  group: string,
  signal: AbortSignal,
  reportError: (message: string) => void,
  onStarted: () => void,
): Promise<MotionPlaybackResult> {
  if (signal.aborted) return "aborted";

  const manager = motionManager(model);
  const outcome = await coordinator.start(group, signal);
  if (signal.aborted || outcome.result === "aborted") return "aborted";
  if (outcome.error) reportError(outcome.error);
  if (outcome.result !== "started") return "not-started";

  onStarted();
  if (signal.aborted) return "aborted";

  return await waitForMotionFinish(manager, signal)
    ? "finished"
    : "aborted";
}

export function Live2DPetRenderer({
  modelId,
  semanticAction,
  actionToken,
  reducedMotion,
  mirrored,
  nativeVisible,
  onReady,
  onError,
}: Live2DPetRendererProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const modelRef = useRef<Live2DModel | null>(null);
  const runtimeRef = useRef<Cubism4Module | null>(null);
  const motionStartCoordinatorRef = useRef<MotionStartCoordinator | null>(null);
  const inputControllerRef = useRef<PetInputParameterController | null>(null);
  const pointerFocusControllerRef = useRef<PetPointerFocusController | null>(null);
  const inputUnsubscribeRef = useRef<(() => void) | null>(null);
  const loadGenerationRef = useRef(0);
  const motionAbortRef = useRef<AbortController | null>(null);
  const activeMotionRef = useRef<ResolvedPetMotion | null>(null);
  const accentFrameRef = useRef<number | null>(null);
  const tickerPhaseRef = useRef<PetTickerPhase>("steady");
  const mirroredRef = useRef(mirrored);
  const effectiveReducedMotionRef = useRef(reducedMotion);
  const nativeVisibleRef = useRef(nativeVisible);
  const pageVisibleRef = useRef(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const applicationFailedRef = useRef(false);
  const syncTickerRef = useRef<(() => void) | null>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);

  const [applicationRevision, setApplicationRevision] = useState(0);
  const [applicationRetryRevision, setApplicationRetryRevision] = useState(0);
  const [modelRevision, setModelRevision] = useState(0);
  const [modelRetryRevision, setModelRetryRevision] = useState(0);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [loadState, setLoadState] = useState<RendererLoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [hasRenderedFrame, setHasRenderedFrame] = useState(false);

  const effectiveReducedMotion = reducedMotion || systemReducedMotion;

  const disposeInputController = useCallback(() => {
    inputUnsubscribeRef.current?.();
    inputUnsubscribeRef.current = null;
    inputControllerRef.current?.dispose();
    inputControllerRef.current = null;
    pointerFocusControllerRef.current = null;
  }, []);

  mirroredRef.current = mirrored;
  effectiveReducedMotionRef.current = effectiveReducedMotion;
  nativeVisibleRef.current = nativeVisible;
  pageVisibleRef.current = pageVisible;
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  const stopAccentAnimation = useCallback(() => {
    if (accentFrameRef.current !== null) {
      cancelAnimationFrame(accentFrameRef.current);
      accentFrameRef.current = null;
    }
    const model = modelRef.current;
    if (model) model.rotation = 0;
  }, []);

  const stopMotionTimeline = useCallback((clearActiveMotion = false) => {
    const controller = motionAbortRef.current;
    motionAbortRef.current = null;
    controller?.abort();
    stopAccentAnimation();
    stopModelMotions(modelRef.current);
    if (clearActiveMotion) activeMotionRef.current = null;
  }, [stopAccentAnimation]);

  const reportApplicationFailure = useCallback((message: string) => {
    applicationFailedRef.current = true;
    stopMotionTimeline(true);
    disposeInputController();
    try {
      appRef.current?.stop();
    } catch {
      // The renderer may already have lost its graphics context.
    }
    setHasRenderedFrame(false);
    setLoadState("error");
    setLoadError(message);
    onErrorRef.current?.(message);
  }, [disposeInputController, stopMotionTimeline]);

  const renderStaticFrame = useCallback((): boolean => {
    const app = appRef.current;
    if (
      !app
      || !modelRef.current
      || applicationFailedRef.current
    ) return false;

    try {
      app.render();
      setHasRenderedFrame(true);
      return true;
    } catch (error) {
      reportApplicationFailure(
        "Live2D 渲染失败：" + errorMessage(error),
      );
      return false;
    }
  }, [reportApplicationFailure]);

  const setTickerPhase = useCallback((phase: PetTickerPhase) => {
    tickerPhaseRef.current = phase;
    syncTickerRef.current?.();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setSystemReducedMotion(query.matches);
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }

    query.addListener(update);
    return () => query.removeListener(update);
  }, []);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    const onPageHide = () => setPageVisible(false);
    const onPageShow = () => update();

    document.addEventListener("visibilitychange", update);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    update();

    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let app: Application | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resize: (() => void) | null = null;
    let removeResolutionQueryListener: (() => void) | null = null;
    let syncTicker: (() => void) | null = null;
    let onContextLost: ((event: Event) => void) | null = null;
    let disposed = false;

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      loadGenerationRef.current += 1;
      stopMotionTimeline(true);
      disposeInputController();
      motionStartCoordinatorRef.current?.dispose();
      motionStartCoordinatorRef.current = null;
      resizeObserver?.disconnect();
      if (resize) window.removeEventListener("resize", resize);
      removeResolutionQueryListener?.();
      removeResolutionQueryListener = null;
      if (canvas && onContextLost) {
        canvas.removeEventListener("webglcontextlost", onContextLost);
      }
      if (syncTicker && syncTickerRef.current === syncTicker) {
        syncTickerRef.current = null;
      }

      const model = modelRef.current;
      modelRef.current = null;
      runtimeRef.current = null;
      if (app && model?.parent === app.stage) app.stage.removeChild(model);
      destroyModel(model);

      if (app) {
        try {
          app.stop();
          app.destroy(true, { children: true, texture: true, baseTexture: true });
        } catch {
          // A failed graphics context can also fail during renderer disposal.
        }
      }
      if (canvas?.parentNode === host) host.removeChild(canvas);
      if (appRef.current === app) appRef.current = null;
    };

    try {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      installPixiCspAdapter();
      app = new Application({
        width,
        height,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: currentRendererResolution(),
        autoStart: false,
        sharedTicker: false,
      });
      app.ticker.maxFPS = PET_STEADY_MAX_FPS;
      canvas = app.view as HTMLCanvasElement;
      appRef.current = app;
      applicationFailedRef.current = false;
      host.appendChild(canvas);

      syncTicker = () => {
        if (!app || disposed) return;
        const policy = resolvePetTickerPolicy({
          nativeVisible: nativeVisibleRef.current,
          pageVisible: pageVisibleRef.current,
          hasModel: modelRef.current !== null && !applicationFailedRef.current,
          reducedMotion: effectiveReducedMotionRef.current,
          phase: tickerPhaseRef.current,
        });
        app.ticker.maxFPS = policy.maxFPS;
        if (policy.running) app.start();
        else app.stop();
      };
      syncTickerRef.current = syncTicker;

      resize = () => {
        if (!app || disposed || applicationFailedRef.current) return;
        try {
          const nextWidth = Math.max(1, host.clientWidth);
          const nextHeight = Math.max(1, host.clientHeight);
          app.renderer.resolution = currentRendererResolution();
          app.renderer.resize(nextWidth, nextHeight);
          if (modelRef.current) {
            fitModel(app, modelRef.current, mirroredRef.current);
            renderStaticFrame();
          }
        } catch (error) {
          reportApplicationFailure(
            "Live2D 渲染器调整尺寸失败：" + errorMessage(error),
          );
        }
      };

      const watchDevicePixelRatio = () => {
        removeResolutionQueryListener?.();
        removeResolutionQueryListener = null;
        if (disposed || typeof window.matchMedia !== "function") return;

        const query = window.matchMedia(
          `(resolution: ${currentDevicePixelRatio()}dppx)`,
        );
        const onResolutionChange = () => {
          watchDevicePixelRatio();
          resize?.();
        };

        if (typeof query.addEventListener === "function") {
          query.addEventListener("change", onResolutionChange);
          removeResolutionQueryListener = () => {
            query.removeEventListener("change", onResolutionChange);
          };
        } else {
          query.addListener(onResolutionChange);
          removeResolutionQueryListener = () => {
            query.removeListener(onResolutionChange);
          };
        }
      };

      resizeObserver = typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(resize);
      resizeObserver?.observe(host);
      window.addEventListener("resize", resize);
      watchDevicePixelRatio();

      onContextLost = (event: Event) => {
        event.preventDefault();
        reportApplicationFailure("Live2D WebGL 上下文已丢失");
      };
      canvas.addEventListener("webglcontextlost", onContextLost);

      syncTicker();
      setHasRenderedFrame(false);
      setLoadState("loading");
      setLoadError("");
      setApplicationRevision((revision) => revision + 1);
    } catch (error) {
      cleanup();
      reportApplicationFailure(
        "Live2D 渲染失败：" + errorMessage(error),
      );
      return;
    }

    return cleanup;
  }, [
    applicationRetryRevision,
    disposeInputController,
    renderStaticFrame,
    reportApplicationFailure,
    stopMotionTimeline,
  ]);

  useEffect(() => {
    if (!nativeVisible || !pageVisible || effectiveReducedMotion) {
      stopMotionTimeline(true);
    }
    syncTickerRef.current?.();
    if (effectiveReducedMotion) {
      pointerFocusControllerRef.current?.applyCurrent(mirroredRef.current);
      renderStaticFrame();
    }
  }, [
    effectiveReducedMotion,
    nativeVisible,
    pageVisible,
    renderStaticFrame,
    stopMotionTimeline,
  ]);

  useEffect(() => {
    const app = appRef.current;
    if (!app || applicationRevision === 0 || applicationFailedRef.current) return;

    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    stopMotionTimeline(true);

    const previousModel = modelRef.current;
    disposeInputController();
    motionStartCoordinatorRef.current?.dispose();
    motionStartCoordinatorRef.current = null;
    modelRef.current = null;
    runtimeRef.current = null;
    if (previousModel?.parent === app.stage) app.stage.removeChild(previousModel);
    destroyModel(previousModel);
    setTickerPhase("steady");

    setHasRenderedFrame(false);
    setLoadState("loading");
    setLoadError("");
    const definition = PET_MODEL_DEFINITIONS[modelId];
    let candidate: Live2DModel | null = null;
    let candidateCoordinator: MotionStartCoordinator | null = null;
    let candidateInputController: PetInputParameterController | null = null;
    let candidatePointerFocusController: PetPointerFocusController | null = null;
    let candidateInputUnsubscribe: (() => void) | null = null;

    void (async () => {
      try {
        const runtime = await import("pixi-live2d-display/cubism4");
        if (
          generation !== loadGenerationRef.current
          || app !== appRef.current
          || applicationFailedRef.current
        ) return;
        runtimeRef.current = runtime;

        candidate = await runtime.Live2DModel.from(definition.modelUrl, {
          ticker: app.ticker,
          autoUpdate: true,
          autoHitTest: false,
          autoFocus: false,
          motionPreload: runtime.MotionPreloadStrategy.NONE,
        });

        if (
          generation !== loadGenerationRef.current
          || app !== appRef.current
          || applicationFailedRef.current
        ) {
          destroyModel(candidate);
          candidate = null;
          return;
        }

        const frameworkCoreModel = candidate.internalModel.coreModel as {
          getModel?: unknown;
          setParameterValueById?: unknown;
        } | null;
        if (
          !frameworkCoreModel
          || typeof frameworkCoreModel !== "object"
          || typeof frameworkCoreModel.getModel !== "function"
          || typeof frameworkCoreModel.setParameterValueById !== "function"
        ) {
          throw new Error("Cubism Framework 核心模型不可用");
        }
        applyCubismCoreCompatibility(frameworkCoreModel.getModel());

        const inputModel = candidate;
        const inputInternalModel = candidate.internalModel as typeof candidate.internalModel & {
          on(event: "afterMotionUpdate", listener: () => void): unknown;
          off(event: "afterMotionUpdate", listener: () => void): unknown;
        };
        const requestInputFrame = () => {
          if (
            inputModel !== modelRef.current
            || app !== appRef.current
            || applicationFailedRef.current
          ) return;
          inputModel.update(1);
          renderStaticFrame();
        };
        candidateInputController = new PetInputParameterController(
          modelId,
          frameworkCoreModel as {
            setParameterValueById(parameterId: string, value: number): void;
          },
          requestInputFrame,
        );
        const focusController = candidate.internalModel.focusController as {
          focus(x: number, y: number, instant?: boolean): void;
        };
        candidatePointerFocusController = new PetPointerFocusController(
          modelId,
          (x, y) => {
            if (
              inputModel !== modelRef.current
              || app !== appRef.current
              || applicationFailedRef.current
            ) return;
            const instant = effectiveReducedMotionRef.current;
            focusController.focus(x, y, instant);
            requestInputFrame();
          },
        );
        const flushInputParameters = () => candidateInputController?.flush();
        inputInternalModel.on("afterMotionUpdate", flushInputParameters);
        const unsubscribeInputBus = subscribePetInput((message) => {
          candidateInputController?.handle(message.source, message.event);
          if (message.source !== "global") return;
          if (message.event.type === "mouse-move") {
            candidatePointerFocusController?.handle(message.event, mirroredRef.current);
          } else if (message.event.type === "reset") {
            candidatePointerFocusController?.reset(mirroredRef.current);
          }
        });
        candidateInputUnsubscribe = () => {
          unsubscribeInputBus();
          inputInternalModel.off("afterMotionUpdate", flushInputParameters);
        };
        inputControllerRef.current = candidateInputController;
        pointerFocusControllerRef.current = candidatePointerFocusController;
        inputUnsubscribeRef.current = candidateInputUnsubscribe;

        fitModel(app, candidate, mirroredRef.current);
        app.stage.addChild(candidate);
        candidateCoordinator = new MotionStartCoordinator(candidate, runtime);
        modelRef.current = candidate;
        motionStartCoordinatorRef.current = candidateCoordinator;
        activeMotionRef.current = null;
        const renderedFirstFrame = renderStaticFrame();
        if (!renderedFirstFrame || applicationFailedRef.current) return;
        setLoadState("ready");
        setModelRevision((revision) => revision + 1);
        syncTickerRef.current?.();
        onReadyRef.current?.();
      } catch (error) {
        if (generation !== loadGenerationRef.current) {
          destroyModel(candidate);
          return;
        }
        if (candidate?.parent === app.stage) app.stage.removeChild(candidate);
        if (modelRef.current === candidate) modelRef.current = null;
        if (inputControllerRef.current === candidateInputController) {
          disposeInputController();
        } else {
          candidateInputUnsubscribe?.();
          candidateInputController?.dispose();
        }
        candidateCoordinator?.dispose();
        if (motionStartCoordinatorRef.current === candidateCoordinator) {
          motionStartCoordinatorRef.current = null;
        }
        destroyModel(candidate);
        candidate = null;
        activeMotionRef.current = null;
        setTickerPhase("steady");
        syncTickerRef.current?.();
        setHasRenderedFrame(false);

        const message = "Live2D 模型加载失败：" + errorMessage(error);
        setLoadState("error");
        setLoadError(message);
        onErrorRef.current?.(message);
      }
    })();

    return () => {
      if (loadGenerationRef.current === generation) {
        loadGenerationRef.current += 1;
      }
    };
  }, [
    applicationRevision,
    disposeInputController,
    modelId,
    modelRetryRevision,
    renderStaticFrame,
    setTickerPhase,
    stopMotionTimeline,
  ]);

  useEffect(() => {
    const app = appRef.current;
    const model = modelRef.current;
    if (!app || !model || modelRevision === 0) return;

    try {
      fitModel(app, model, mirrored);
      pointerFocusControllerRef.current?.applyCurrent(mirrored);
      renderStaticFrame();
    } catch (error) {
      reportApplicationFailure(
        "Live2D 渲染布局失败：" + errorMessage(error),
      );
    }
  }, [mirrored, modelRevision, renderStaticFrame, reportApplicationFailure]);

  const playAccentAnimation = useCallback((
    model: Live2DModel,
    signal: AbortSignal,
  ): Promise<boolean> => {
    stopAccentAnimation();
    if (
      signal.aborted
      || effectiveReducedMotionRef.current
      || !nativeVisibleRef.current
      || !pageVisibleRef.current
    ) return Promise.resolve(false);

    return new Promise((resolve) => {
      const startedAt = performance.now();
      let settled = false;
      let frameId: number | null = null;

      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        if (frameId !== null) cancelAnimationFrame(frameId);
        if (accentFrameRef.current === frameId) accentFrameRef.current = null;
        signal.removeEventListener("abort", onAbort);
        if (model === modelRef.current) model.rotation = 0;
        resolve(completed);
      };
      const onAbort = () => finish(false);
      const frame = (now: number) => {
        if (
          signal.aborted
          || model !== modelRef.current
          || effectiveReducedMotionRef.current
          || !nativeVisibleRef.current
          || !pageVisibleRef.current
        ) {
          finish(false);
          return;
        }

        const progress = Math.min(1, (now - startedAt) / ACCENT_DURATION_MS);
        model.rotation = Math.sin(progress * Math.PI * 2) * 0.025;
        if (progress >= 1) {
          finish(true);
          return;
        }
        frameId = requestAnimationFrame(frame);
        accentFrameRef.current = frameId;
      };

      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      frameId = requestAnimationFrame(frame);
      accentFrameRef.current = frameId;
    });
  }, [stopAccentAnimation]);

  useEffect(() => {
    const app = appRef.current;
    const model = modelRef.current;
    const runtime = runtimeRef.current;
    const coordinator = motionStartCoordinatorRef.current;
    const canAnimate = Boolean(
      app
      && model
      && runtime
      && coordinator
      && modelRevision > 0
      && !applicationFailedRef.current
      && nativeVisible
      && pageVisible
      && !effectiveReducedMotion,
    );

    if (!app || !model || !runtime || !coordinator || !canAnimate) {
      stopMotionTimeline(true);
      setTickerPhase("steady");
      syncTickerRef.current?.();
      if (effectiveReducedMotion) renderStaticFrame();
      return;
    }

    const previousMotion = activeMotionRef.current;
    stopMotionTimeline(false);

    const definition = PET_MODEL_DEFINITIONS[modelId];
    const sample = Math.abs(actionToken % 997) / 997;
    const currentMotion = resolvePetMotion(definition, semanticAction, sample);

    const controller = new AbortController();
    motionAbortRef.current = controller;
    const { signal } = controller;

    const isCurrent = () => (
      !signal.aborted
      && motionAbortRef.current === controller
      && appRef.current === app
      && modelRef.current === model
      && runtimeRef.current === runtime
      && motionStartCoordinatorRef.current === coordinator
      && nativeVisibleRef.current
      && pageVisibleRef.current
      && !effectiveReducedMotionRef.current
      && !applicationFailedRef.current
    );

    const reportMotionError = (message: string) => {
      if (!signal.aborted) onErrorRef.current?.(message);
    };

    const playFallback = async () => {
      if (!isCurrent()) return;
      stopModelMotions(model);
      if (currentMotion.fallback === "accent") {
        setTickerPhase("action");
        await playAccentAnimation(model, signal);
      }
      if (isCurrent()) setTickerPhase("steady");
    };

    void (async () => {
      let entered = false;
      const steps = resolvePetMotionSteps(previousMotion, currentMotion);

      for (const step of steps) {
        if (!isCurrent()) return;

        const markStarted = () => {
          if (!isCurrent()) return;
          if (step.phase === "exit") {
            if (activeMotionRef.current === previousMotion) {
              activeMotionRef.current = null;
            }
          } else {
            activeMotionRef.current = currentMotion;
          }
        };

        if (step.phase === "loop") {
          setTickerPhase("steady");
          while (isCurrent()) {
            const result = await playMotionGroupAndWait(
              model,
              coordinator,
              step.group,
              signal,
              reportMotionError,
              markStarted,
            );
            if (result === "aborted" || !isCurrent()) return;
            if (result !== "finished") {
              await playFallback();
              return;
            }
          }
          return;
        }

        setTickerPhase("action");
        const result = await playMotionGroupAndWait(
          model,
          coordinator,
          step.group,
          signal,
          reportMotionError,
          markStarted,
        );
        if (result === "aborted" || !isCurrent()) return;
        if (step.phase === "enter") entered = result === "finished";
      }

      if (entered) {
        setTickerPhase("steady");
        return;
      }
      await playFallback();
    })()
      .catch((error) => {
        if (!signal.aborted) {
          onErrorRef.current?.(
            "Live2D 动作序列失败：" + errorMessage(error),
          );
        }
      })
      .finally(() => {
        if (motionAbortRef.current === controller) {
          motionAbortRef.current = null;
          setTickerPhase("steady");
        }
      });

    return () => {
      if (motionAbortRef.current === controller) {
        stopMotionTimeline(false);
      }
    };
  }, [
    actionToken,
    effectiveReducedMotion,
    modelId,
    modelRevision,
    nativeVisible,
    pageVisible,
    playAccentAnimation,
    renderStaticFrame,
    semanticAction,
    setTickerPhase,
    stopMotionTimeline,
  ]);

  const definition = PET_MODEL_DEFINITIONS[modelId];

  const retry = () => {
    setHasRenderedFrame(false);
    setLoadState("loading");
    setLoadError("");
    if (applicationFailedRef.current || !appRef.current) {
      setApplicationRetryRevision((revision) => revision + 1);
    } else {
      setModelRetryRevision((revision) => revision + 1);
    }
  };

  return (
    <div className="live2d-pet-renderer" data-state={loadState}>
      <img
        className="live2d-pet-renderer__fallback"
        src={definition.fallbackImageUrl}
        alt=""
        aria-hidden="true"
        hidden={loadState === "ready" && hasRenderedFrame}
      />
      <div ref={hostRef} className="live2d-pet-renderer__canvas" />
      {loadState === "error" && (
        <div className="live2d-pet-renderer__error" role="status">
          <span>{loadError}</span>
          <button
            className="live2d-pet-renderer__retry"
            type="button"
            onClick={retry}
          >
            重试 Live2D
          </button>
        </div>
      )}
    </div>
  );
}
