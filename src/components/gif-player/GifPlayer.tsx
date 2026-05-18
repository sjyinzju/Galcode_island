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

/// CPU 端解码缓存：同一 src 复用解码结果（GIF / 静态图都进同一个池）。
///
/// 容量：LRU 上限 24 张 —— 桌宠场景常见 6 类 × 多张，再算上戳戳互动池，24
/// 足够覆盖一次会话内反复切换。超过后按访问顺序淘汰最旧。
///
/// 失败不缓存（catch 里 delete 掉 promise），避免一次网络抖动卡死后续重试。
const DECODE_CACHE_MAX = 24;
const decodeCache = new Map<string, Promise<DecodedGif>>();

function touchCache(key: string, value: Promise<DecodedGif>): void {
  if (decodeCache.has(key)) decodeCache.delete(key);
  decodeCache.set(key, value);
  if (decodeCache.size > DECODE_CACHE_MAX) {
    const oldest = decodeCache.keys().next().value;
    if (oldest !== undefined) decodeCache.delete(oldest);
  }
}

/// 解码失败时抛 sentinel error，让组件区分"真错误"（应当 onError 报给业务层）
/// 和"已知不走 WebGL 路径"（如 APNG / 动态 WebP，应当静默 fallback 到 <img>，
/// 由浏览器原生解码器播放动画）。
class UnsupportedAnimatedFormatError extends Error {
  constructor(kind: string) {
    super(`unsupported animated format for WebGL path: ${kind}`);
    this.name = "UnsupportedAnimatedFormatError";
  }
}

type ImageKind = "gif" | "apng" | "webp-animated" | "static";

/// 按魔数嗅探，不信任 caller 提供的 mime —— blob URL 上的 mime 经常不准。
function sniffImageKind(buf: ArrayBuffer): ImageKind {
  const u8 = new Uint8Array(buf);
  // GIF: "GIF87a" / "GIF89a"
  if (
    u8.length >= 6 &&
    u8[0] === 0x47 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x38 &&
    (u8[4] === 0x37 || u8[4] === 0x39) &&
    u8[5] === 0x61
  ) {
    return "gif";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A；APNG 在 IDAT 之前有 acTL chunk
  if (
    u8.length >= 8 &&
    u8[0] === 0x89 &&
    u8[1] === 0x50 &&
    u8[2] === 0x4e &&
    u8[3] === 0x47 &&
    u8[4] === 0x0d &&
    u8[5] === 0x0a &&
    u8[6] === 0x1a &&
    u8[7] === 0x0a
  ) {
    return pngHasActlBeforeIdat(u8) ? "apng" : "static";
  }
  // WebP: "RIFF" ???? "WEBP"；动态 WebP 在 VP8X 之后有 ANIM chunk
  if (
    u8.length >= 12 &&
    u8[0] === 0x52 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x46 &&
    u8[8] === 0x57 &&
    u8[9] === 0x45 &&
    u8[10] === 0x42 &&
    u8[11] === 0x50
  ) {
    return webpHasAnimChunk(u8) ? "webp-animated" : "static";
  }
  // JPEG / 其它已知静态 → 让 createImageBitmap 试
  return "static";
}

/// 按 PNG chunk 结构扫描：8 字节签名后，每个 chunk = 4B length + 4B type + data + 4B CRC。
/// 在 IDAT 出现前发现 acTL → APNG。
function pngHasActlBeforeIdat(u8: Uint8Array): boolean {
  let off = 8;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  while (off + 8 <= u8.length) {
    const len = view.getUint32(off, false);
    const type = String.fromCharCode(u8[off + 4]!, u8[off + 5]!, u8[off + 6]!, u8[off + 7]!);
    if (type === "acTL") return true;
    if (type === "IDAT") return false;
    off += 8 + len + 4;
    if (!Number.isFinite(len) || len < 0) return false;
  }
  return false;
}

/// RIFF 容器：8 字节头（"RIFF" + size）后跟 4 字节 form type（"WEBP"），之后
/// 每个 chunk = 4B FourCC + 4B size + payload（按 2 对齐）。
function webpHasAnimChunk(u8: Uint8Array): boolean {
  let off = 12;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  while (off + 8 <= u8.length) {
    const cc = String.fromCharCode(u8[off]!, u8[off + 1]!, u8[off + 2]!, u8[off + 3]!);
    const size = view.getUint32(off + 4, true);
    if (cc === "ANIM" || cc === "ANMF") return true;
    off += 8 + size + (size & 1);
  }
  return false;
}

function makeOffscreen(
  width: number,
  height: number,
): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D } {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = (canvas as OffscreenCanvas).getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("offscreen 2d context unavailable");
  return { canvas, ctx };
}

async function decodeAsGif(buf: ArrayBuffer): Promise<DecodedGif> {
  const gif = parseGIF(buf);
  const rawFrames: ParsedFrame[] = decompressFrames(gif, true);
  const { width, height } = gif.lsd;
  const { ctx } = makeOffscreen(width, height);

  // 按 disposalType 把 patch 合成成全画布 —— decode 期一次性算完，运行时零分支。
  const composed: DecodedGif["frames"] = [];
  let prevSnapshot: ImageData | null = null;
  for (const frame of rawFrames) {
    const { dims, patch, delay, disposalType } = frame;
    if (disposalType === 3) {
      prevSnapshot = ctx.getImageData(0, 0, width, height);
    }
    const patchImage = new ImageData(new Uint8ClampedArray(patch), dims.width, dims.height);
    ctx.putImageData(patchImage, dims.left, dims.top);
    const full = ctx.getImageData(0, 0, width, height);
    composed.push({
      pixels: new Uint8ClampedArray(full.data),
      // ParsedFrame.delay 已经是毫秒（gifuct-js 内部按 raw * 10 转换过）；某些
      // 写制工具会写 0 或极小值 → 钳到 20ms 防 RAF 空转烧 GPU。
      delayMs: Math.max(20, delay || 100),
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

/// 静态图（PNG / JPEG / 静态 WebP / BMP / etc.）→ 一帧 DecodedGif：
/// 走 createImageBitmap → 画到 offscreen → 拿 ImageData → 上 GPU。
/// 这样静态图也能享受 WebGL 路径（与 GIF 走同一渲染管线），DOM 里看到的也是 <canvas>。
async function decodeAsStatic(buf: ArrayBuffer): Promise<DecodedGif> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap unavailable");
  }
  const blob = new Blob([buf]);
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const { ctx } = makeOffscreen(width, height);
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0);
  const data = ctx.getImageData(0, 0, width, height);
  bitmap.close();
  return {
    width,
    height,
    // 单帧 + 任意 delay（>1 帧才会走切换逻辑，所以 delay 不影响行为）
    frames: [{ pixels: new Uint8ClampedArray(data.data), delayMs: 1_000 }],
  };
}

async function decodeOnce(src: string): Promise<DecodedGif> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${src}`);
  const buf = await res.arrayBuffer();
  const kind = sniffImageKind(buf);
  if (kind === "gif") return decodeAsGif(buf);
  if (kind === "static") return decodeAsStatic(buf);
  // APNG / 动态 WebP：浏览器 <img> 才会原生播放动画；我们的 WebGL 静态路径会
  // 只展示首帧 → 动画丢失。明确退回 <img>，由 GifPlayer 接住 sentinel 不报错。
  throw new UnsupportedAnimatedFormatError(kind);
}

function getDecoded(src: string): Promise<DecodedGif> {
  const existing = decodeCache.get(src);
  if (existing) {
    // 访问刷新 LRU 顺序
    decodeCache.delete(src);
    decodeCache.set(src, existing);
    return existing;
  }
  const p = decodeOnce(src);
  touchCache(src, p);
  p.catch(() => {
    if (decodeCache.get(src) === p) decodeCache.delete(src);
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
    // 与下面的 UNPACK_PREMULTIPLY_ALPHA_WEBGL=true + blendFunc(ONE,
    // ONE_MINUS_SRC_ALPHA) 保持一致：整条管线都走预乘 alpha。设成 false 时浏览器
    // 合成阶段会再乘一次 alpha → 颜色偏暗、半透明边缘 alpha 失真 → CSS
    // filter:drop-shadow 拿不到正确 alpha 形状 → 外发光投影消失。
    premultipliedAlpha: true,
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
  // 注意：故意不调用 WEBGL_lose_context.loseContext()。
  //
  // 在 React 18 dev + StrictMode 下，effect 会 mount → cleanup → re-mount 连跑两轮。
  // 如果 cleanup 里把 context 弄丢（loseContext），re-mount 阶段 canvas.getContext
  // 在 WKWebView 上往往返回的还是同一个已 lost 的 context（要等异步的 contextrestored
  // 事件才能新建），导致 effect 看见 ctx 不为 null 但 useProgram/draw 都 no-op，
  // 表现就是"刷新页面有概率桌宠那块白屏"。
  //
  // 只删除我们自己持有的 program / buffer / texture 引用即可；剩下的 GL 资源等
  // canvas 节点被 GC 时浏览器会自动回收，对单个长期常驻的桌宠来说零成本。
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

  // 每个 RAF tick 都重绘当前帧（即便帧没变）。原因：
  //   WebGL 默认 preserveDrawingBuffer=false —— 浏览器在每次合成后会清空 drawing
  //   buffer。如果只在帧切换时画一次，下一次合成之前不重画，canvas 就会变透明。
  //   贴一个 fullscreen 三角形 quad 的成本对 GPU 微不足道（亚毫秒级），所以"每
  //   tick 都画"反而是最干净的策略。
  const tick = (nowMs: number): void => {
    ctx.rafId = requestAnimationFrame(tick);
    if (ctx.lastSwitchMs === 0) {
      ctx.lastSwitchMs = nowMs;
    } else if (ctx.frames.length > 1) {
      const elapsed = nowMs - ctx.lastSwitchMs;
      const delay = ctx.frames[ctx.currentFrame]!.delayMs;
      if (elapsed >= delay) {
        ctx.currentFrame = (ctx.currentFrame + 1) % ctx.frames.length;
        ctx.lastSwitchMs = nowMs;
      }
    }
    drawCurrentFrame(ctx);
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
    // 用"已知不能走 WebGL 的 src"集合而非单一布尔 —— 避免一旦遇到一张 APNG /
    // 动态 WebP，后续切回 GIF 也卡在 <img> 路径。
    const [unsupportedSrcs, setUnsupportedSrcs] = useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const fallback = unsupportedSrcs.has(src);
    const markFallback = (badSrc: string): void => {
      setUnsupportedSrcs((prev) => {
        if (prev.has(badSrc)) return prev;
        const next = new Set(prev);
        next.add(badSrc);
        return next;
      });
    };

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
        markFallback(src);
        return;
      }
      if (!ctx) {
        onError?.(new Error("webgl unavailable"));
        markFallback(src);
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
          // sentinel：APNG / 动态 WebP —— WebGL 静态路径只能显首帧丢动画，明确
          // 退回 <img> 让浏览器原生解码器接管，不算"错误"，不上报 onError。
          if (err?.name === "UnsupportedAnimatedFormatError") {
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console
              console.info(
                "[GifPlayer] WebGL 路径不支持的动图格式，退回 <img>：",
                src,
                err.message,
              );
            }
          } else {
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console
              console.warn("[GifPlayer] 解码失败，退回 <img>：", src, err);
            }
            onError?.(err);
          }
          markFallback(src);
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
