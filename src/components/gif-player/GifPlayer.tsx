// 通用 WebGL 动图播放组件。
//
// 用 gifuct-js 在前端解码 GIF，把每一帧合成成"全画布 RGBA"后上传到 WebGL 纹理
// 缓存在 GPU；播放时一个 RAF 循环按 GIF 自身的 delay 切换 active texture，避免
// 浏览器内置 <img> GIF 解码器的反复解码 / 卡顿问题。
//
// 设计目标（按用户要求）：
//   1. 尽量贴近 <img> 的使用方式：src + className + draggable + alt 即可用。
//   2. DOM 影响最小：渲染时只是一个 <canvas>（fallback 失败时退化到 <img>）。
//   3. 与 framer-motion 兼容：forwardRef 到 underlying canvas/img，外层用
//      motion.create(GifPlayer) 即可像 motion.img 一样用 initial/animate/exit。
//   4. 同一组件内 src 切换不重建 GL context，只换纹理；多 GIF 解码结果进程内 LRU。
//
// 不解决（暂不在范围）：
//   - 多组件共享同一 GPU 纹理（每个 canvas 一个 GL context，纹理无法跨 context）。
//   - APNG / WebP 动图（gifuct-js 仅处理 GIF；非 .gif 走 <img> fallback）。
//   - 控制播放速度 / 暂停（接口预留 onDecoded，后续可扩展）。

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CanvasHTMLAttributes,
} from "react";
import { decompressFrames, parseGIF, type ParsedFrame } from "gifuct-js";

/// 解码后的整段动图：所有帧已按 disposalType 合成为完整画布大小的 RGBA buffer。
interface DecodedGif {
  width: number;
  height: number;
  frames: Array<{
    pixels: Uint8ClampedArray;
    delayMs: number;
  }>;
}

/// CPU 端解码缓存：同一 src 复用解码结果。
///
/// 容量：LRU 上限 24 张 GIF —— 桌宠场景常见 6 类 × 多张，再算上戳戳互动池，24
/// 足够覆盖一次会话内反复切换。超过后按访问顺序淘汰最旧。
///
/// 失败不缓存（catch 里 delete 掉 promise），避免一次网络抖动卡死后续重试。
const GIF_CACHE_MAX = 24;
const gifCache = new Map<string, Promise<DecodedGif>>();

function touchCache(key: string, value: Promise<DecodedGif>): void {
  if (gifCache.has(key)) gifCache.delete(key);
  gifCache.set(key, value);
  if (gifCache.size > GIF_CACHE_MAX) {
    const oldest = gifCache.keys().next().value;
    if (oldest !== undefined) gifCache.delete(oldest);
  }
}

async function decodeGifOnce(src: string): Promise<DecodedGif> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`gif fetch failed: ${res.status} ${src}`);
  const buf = await res.arrayBuffer();
  const gif = parseGIF(buf);
  const rawFrames: ParsedFrame[] = decompressFrames(gif, true);
  const { width, height } = gif.lsd;

  // 用 OffscreenCanvas（浏览器都已支持）按 disposalType 把 patch 合成成全画布。
  // 浏览器 GIF 帧通常是相对前一帧的 patch + dispose 规则；直接上 GPU 时一帧一
  // 张 full-frame 纹理最省事——decode 期一次性 CPU 算完，运行时零分支。
  const offscreen =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : (() => {
          const c = document.createElement("canvas");
          c.width = width;
          c.height = height;
          return c;
        })();
  const ctx = (offscreen as OffscreenCanvas).getContext(
    "2d",
  ) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("offscreen 2d context unavailable");

  const composed: DecodedGif["frames"] = [];
  let prevSnapshot: ImageData | null = null;

  for (const frame of rawFrames) {
    const { dims, patch, delay, disposalType } = frame;
    // disposal=3：本帧绘制前先快照，绘制完后还原 —— 让"下一帧基于上上一帧"成立。
    if (disposalType === 3) {
      prevSnapshot = ctx.getImageData(0, 0, width, height);
    }
    const patchImage = new ImageData(
      new Uint8ClampedArray(patch),
      dims.width,
      dims.height,
    );
    ctx.putImageData(patchImage, dims.left, dims.top);

    const full = ctx.getImageData(0, 0, width, height);
    composed.push({
      pixels: new Uint8ClampedArray(full.data),
      // GIF 里 delay 单位是 1/100 秒；某些写制工具会写 0 或极小值 —— 钳到 20ms
      // 防止 RAF 空转造成跑分上 100% GPU。
      delayMs: Math.max(20, (delay || 10) * 10),
    });

    if (disposalType === 2) {
      ctx.clearRect(dims.left, dims.top, dims.width, dims.height);
    } else if (disposalType === 3 && prevSnapshot) {
      ctx.putImageData(prevSnapshot, 0, 0);
      prevSnapshot = null;
    }
  }

  return { width, height, frames: composed };
}

function getDecoded(src: string): Promise<DecodedGif> {
  const existing = gifCache.get(src);
  if (existing) {
    // 访问刷新 LRU 顺序
    gifCache.delete(src);
    gifCache.set(src, existing);
    return existing;
  }
  const p = decodeGifOnce(src);
  touchCache(src, p);
  p.catch(() => {
    if (gifCache.get(src) === p) gifCache.delete(src);
  });
  return p;
}

// --- WebGL renderer ---
//
// 一个 canvas 持有一个 GL context + program + 顶点 buffer + 当前 GIF 的全部 frame
// 纹理。src 切换时复用 program / buffer，只换纹理。

const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = a_uv;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}
`;

interface GLContext {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  posBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
  uTexLoc: WebGLUniformLocation | null;
  /// 当前已上传的纹理集（一帧一张）。src 切换时整体替换。
  textures: WebGLTexture[];
  frames: Array<{ delayMs: number }>;
  rafId: number | null;
  currentFrame: number;
  lastSwitchMs: number;
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader returned null");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function initGLContext(canvas: HTMLCanvasElement): GLContext | null {
  const gl = canvas.getContext("webgl", {
    premultipliedAlpha: false,
    alpha: true,
    antialias: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  let vs: WebGLShader | null = null;
  let fs: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  try {
    vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram();
    if (!program) throw new Error("createProgram returned null");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      throw new Error(`program link failed: ${log}`);
    }
  } catch (err) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (program) gl.deleteProgram(program);
    throw err;
  }
  gl.useProgram(program);

  const posBuf = gl.createBuffer();
  const uvBuf = gl.createBuffer();
  if (!posBuf || !uvBuf) {
    gl.deleteProgram(program);
    return null;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  // GIF 是上→下行 / canvas pixel origin 也是左上；clip-space y 向上 → 翻转 V
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]),
    gl.STATIC_DRAW,
  );
  const aUv = gl.getAttribLocation(program, "a_uv");
  gl.enableVertexAttribArray(aUv);
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

  const uTexLoc = gl.getUniformLocation(program, "u_tex");
  gl.uniform1i(uTexLoc, 0);

  gl.clearColor(0, 0, 0, 0);
  // 启用 alpha blending：让透明 GIF 的背景正常透过去
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  // GIF 帧数据是 non-premultiplied —— 上传时让浏览器帮我们 premultiply，避免边缘
  // 出现颜色"光晕"
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  return {
    canvas,
    gl,
    program,
    posBuf,
    uvBuf,
    uTexLoc,
    textures: [],
    frames: [],
    rafId: null,
    currentFrame: 0,
    lastSwitchMs: 0,
  };
}

function clearTextures(ctx: GLContext): void {
  for (const t of ctx.textures) ctx.gl.deleteTexture(t);
  ctx.textures = [];
  ctx.frames = [];
}

function stopPlayback(ctx: GLContext): void {
  if (ctx.rafId !== null) {
    cancelAnimationFrame(ctx.rafId);
    ctx.rafId = null;
  }
}

function disposeContext(ctx: GLContext): void {
  stopPlayback(ctx);
  clearTextures(ctx);
  const { gl, program, posBuf, uvBuf } = ctx;
  gl.deleteBuffer(posBuf);
  gl.deleteBuffer(uvBuf);
  gl.deleteProgram(program);
  // 主动释放 GL context，让浏览器尽快回收 GPU 资源（macOS WKWebView 在大量
  // 短命 context 时容易内存涨）。
  gl.getExtension("WEBGL_lose_context")?.loseContext();
}

function uploadFrames(ctx: GLContext, decoded: DecodedGif): void {
  clearTextures(ctx);
  const { gl } = ctx;
  ctx.canvas.width = decoded.width;
  ctx.canvas.height = decoded.height;
  gl.viewport(0, 0, decoded.width, decoded.height);

  for (const frame of decoded.frames) {
    const tex = gl.createTexture();
    if (!tex) continue;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      decoded.width,
      decoded.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      frame.pixels,
    );
    ctx.textures.push(tex);
  }
  ctx.frames = decoded.frames.map((f) => ({ delayMs: f.delayMs }));
  ctx.currentFrame = 0;
  ctx.lastSwitchMs = 0;
}

function drawCurrentFrame(ctx: GLContext): void {
  const { gl, textures, currentFrame } = ctx;
  const tex = textures[currentFrame];
  if (!tex) return;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function startPlayback(ctx: GLContext): void {
  if (ctx.frames.length === 0) return;
  stopPlayback(ctx);

  const tick = (nowMs: number): void => {
    ctx.rafId = requestAnimationFrame(tick);
    if (ctx.lastSwitchMs === 0) {
      ctx.lastSwitchMs = nowMs;
      drawCurrentFrame(ctx);
      return;
    }
    if (ctx.frames.length <= 1) return; // 静态/单帧 GIF：画一次就够
    const elapsed = nowMs - ctx.lastSwitchMs;
    const delay = ctx.frames[ctx.currentFrame]!.delayMs;
    if (elapsed >= delay) {
      ctx.currentFrame = (ctx.currentFrame + 1) % ctx.frames.length;
      ctx.lastSwitchMs = nowMs;
      drawCurrentFrame(ctx);
    }
  };
  ctx.rafId = requestAnimationFrame(tick);
}

// --- React API ---

export interface GifPlayerProps
  extends Omit<
    CanvasHTMLAttributes<HTMLCanvasElement>,
    "children" | "ref" | "onError"
  > {
  src: string;
  /// 用于无障碍：转成 canvas 的 aria-label / img fallback 的 alt。
  alt?: string;
  /// 解码 + 上传完成时触发（首帧已可见）。
  onDecoded?: () => void;
  /// 解码失败、WebGL 不可用等任何错误。组件会自动退化到 <img>。
  onError?: (err: Error) => void;
}

/// 通用动图播放组件：
///   <GifPlayer src="/pet/foo.gif" className="..." draggable={false} alt="桌宠" />
///
/// 用 motion.create(GifPlayer) 包装后可直接当 motion.img 用：
///   const MotionGifPlayer = motion.create(GifPlayer);
///   <MotionGifPlayer src={...} initial={{opacity:0}} animate={{opacity:1}} />
///
/// fallback：WebGL 不可用 / 解码失败时，自动退化到 <img>，保证图像可见。
export const GifPlayer = forwardRef<HTMLElement, GifPlayerProps>(
  function GifPlayer(
    { src, alt, draggable, className, style, onDecoded, onError, ...rest },
    forwardedRef,
  ): JSX.Element {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const glCtxRef = useRef<GLContext | null>(null);
    const [fallback, setFallback] = useState(false);

    // forwardedRef → 当前激活的 element（fallback 切换后也保持有效）。
    // 不用 useImperativeHandle 的话，框架（如 framer-motion）拿到的 ref 会在 fallback
    // 切换时悬空。
    useImperativeHandle(
      forwardedRef,
      () => (fallback ? imgRef.current : canvasRef.current) as HTMLElement,
      [fallback],
    );

    // GL context 生命周期：canvas mount 时建一次，unmount 时销毁。
    // src 切换不动 context，只走第二个 effect 换纹理。
    useEffect(() => {
      if (fallback) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      let ctx: GLContext | null = null;
      try {
        ctx = initGLContext(canvas);
      } catch (err) {
        onError?.(err as Error);
        setFallback(true);
        return;
      }
      if (!ctx) {
        onError?.(new Error("webgl unavailable"));
        setFallback(true);
        return;
      }
      glCtxRef.current = ctx;
      return () => {
        if (glCtxRef.current) {
          disposeContext(glCtxRef.current);
          glCtxRef.current = null;
        }
      };
      // 只在 fallback 切换或卸载时跑；onError 故意不进依赖（不希望父级回调引用
      // 变化触发 GL context 重建）。
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fallback]);

    // src 变更：异步解码 → 上传纹理 → 启动播放。AbortController 拦截过期 src。
    useEffect(() => {
      if (fallback) return;
      const ctx = glCtxRef.current;
      if (!ctx || !src) return;
      const abort = new AbortController();
      getDecoded(src)
        .then((decoded) => {
          if (abort.signal.aborted) return;
          // 在解码异步等待期间组件可能已 unmount / 切换到 fallback
          if (!glCtxRef.current || glCtxRef.current !== ctx) return;
          uploadFrames(ctx, decoded);
          startPlayback(ctx);
          onDecoded?.();
        })
        .catch((err: Error) => {
          if (abort.signal.aborted) return;
          onError?.(err);
          setFallback(true);
        });
      return () => {
        abort.abort();
        // 不立刻停 playback / 清纹理 —— 因为后一次 src effect 会接管。但如果是
        // 真 unmount，前面的 context dispose effect 会把整个 ctx 收掉。
      };
      // 同上：onDecoded / onError 不进依赖。
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, fallback]);

    if (fallback) {
      return (
        <img
          ref={imgRef}
          src={src}
          alt={alt ?? ""}
          className={className}
          style={style}
          draggable={draggable}
        />
      );
    }
    return (
      <canvas
        ref={canvasRef}
        role={alt ? "img" : undefined}
        aria-label={alt}
        className={className}
        style={style}
        draggable={draggable}
        {...rest}
      />
    );
  },
);
