import { ShaderSystem } from "@pixi/core";

const CSP_ADAPTER_FLAG = Symbol.for("galcode.pixi-csp-adapter");

type UniformScalar = number | boolean;
type UniformLocation = WebGLUniformLocation | null;

interface UniformMetadata {
  type: string;
  size: number;
  isArray: boolean;
}

interface CachedUniform {
  location: UniformLocation;
  value: unknown;
}

interface SyncData {
  textureCount: number;
  uboCount: number;
}

interface UniformGl {
  uniform1f(location: UniformLocation, x: number): void;
  uniform2f(location: UniformLocation, x: number, y: number): void;
  uniform3f(location: UniformLocation, x: number, y: number, z: number): void;
  uniform4f(location: UniformLocation, x: number, y: number, z: number, w: number): void;
  uniform1i(location: UniformLocation, x: number): void;
  uniform2i(location: UniformLocation, x: number, y: number): void;
  uniform3i(location: UniformLocation, x: number, y: number, z: number): void;
  uniform4i(location: UniformLocation, x: number, y: number, z: number, w: number): void;
  uniform1ui(location: UniformLocation, x: number): void;
  uniform2ui(location: UniformLocation, x: number, y: number): void;
  uniform3ui(location: UniformLocation, x: number, y: number, z: number): void;
  uniform4ui(location: UniformLocation, x: number, y: number, z: number, w: number): void;
  uniformMatrix2fv(location: UniformLocation, transpose: boolean, value: unknown): void;
  uniformMatrix3fv(location: UniformLocation, transpose: boolean, value: unknown): void;
  uniformMatrix4fv(location: UniformLocation, transpose: boolean, value: unknown): void;
  uniform1fv(location: UniformLocation, value: unknown): void;
  uniform2fv(location: UniformLocation, value: unknown): void;
  uniform3fv(location: UniformLocation, value: unknown): void;
  uniform4fv(location: UniformLocation, value: unknown): void;
  uniform1iv(location: UniformLocation, value: unknown): void;
  uniform2iv(location: UniformLocation, value: unknown): void;
  uniform3iv(location: UniformLocation, value: unknown): void;
  uniform4iv(location: UniformLocation, value: unknown): void;
  uniform1uiv(location: UniformLocation, value: unknown): void;
  uniform2uiv(location: UniformLocation, value: unknown): void;
  uniform3uiv(location: UniformLocation, value: unknown): void;
  uniform4uiv(location: UniformLocation, value: unknown): void;
}

interface RendererRuntime {
  gl: UniformGl;
  texture: {
    bind(texture: unknown, unit: number): void;
  };
  shader: {
    syncUniformGroup(group: unknown, syncData: SyncData): void;
    syncUniformBufferGroup(group: unknown, name: string): void;
  };
}

interface ShaderSystemRuntime {
  renderer: RendererRuntime;
  shader: {
    program: {
      uniformData: Record<string, UniformMetadata>;
    };
  };
}

interface UniformGroupRuntime {
  uniforms: Record<string, unknown>;
}

interface GlProgramRuntime {
  uniformData: Record<string, CachedUniform>;
}

type MutableNumericCache = { [index: number]: number };
type UniformValueArray = { readonly [index: number]: UniformScalar };

function recordValue(value: unknown): Record<string, unknown> | null {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return null;
  }
  return value as Record<string, unknown>;
}

function numberValue(value: unknown): number {
  return Number(value);
}

function valueAsStored(cache: MutableNumericCache, value: number): number {
  if (cache instanceof Float32Array) return Math.fround(value);
  if (cache instanceof Int32Array) return value | 0;
  if (cache instanceof Uint32Array) return value >>> 0;
  return value;
}

function updateCached2(
  cache: MutableNumericCache,
  x: unknown,
  y: unknown,
  upload: (x: number, y: number) => void,
): void {
  const nextX = numberValue(x);
  const nextY = numberValue(y);
  if (
    cache[0] === valueAsStored(cache, nextX)
    && cache[1] === valueAsStored(cache, nextY)
  ) return;
  cache[0] = nextX;
  cache[1] = nextY;
  upload(nextX, nextY);
}

function updateCached3(
  cache: MutableNumericCache,
  x: unknown,
  y: unknown,
  z: unknown,
  upload: (x: number, y: number, z: number) => void,
): void {
  const nextX = numberValue(x);
  const nextY = numberValue(y);
  const nextZ = numberValue(z);
  if (
    cache[0] === valueAsStored(cache, nextX)
    && cache[1] === valueAsStored(cache, nextY)
    && cache[2] === valueAsStored(cache, nextZ)
  ) return;
  cache[0] = nextX;
  cache[1] = nextY;
  cache[2] = nextZ;
  upload(nextX, nextY, nextZ);
}

function updateCached4(
  cache: MutableNumericCache,
  x: unknown,
  y: unknown,
  z: unknown,
  w: unknown,
  upload: (x: number, y: number, z: number, w: number) => void,
): void {
  const nextX = numberValue(x);
  const nextY = numberValue(y);
  const nextZ = numberValue(z);
  const nextW = numberValue(w);
  if (
    cache[0] === valueAsStored(cache, nextX)
    && cache[1] === valueAsStored(cache, nextY)
    && cache[2] === valueAsStored(cache, nextZ)
    && cache[3] === valueAsStored(cache, nextW)
  ) return;
  cache[0] = nextX;
  cache[1] = nextY;
  cache[2] = nextZ;
  cache[3] = nextW;
  upload(nextX, nextY, nextZ, nextW);
}

function updateCachedScalar(
  cached: CachedUniform,
  value: UniformScalar,
  upload: (value: number) => void,
): void {
  if (cached.value === value) return;
  cached.value = value;
  upload(numberValue(value));
}

function uploadUniformArray(
  gl: UniformGl,
  metadata: UniformMetadata,
  location: UniformLocation,
  value: unknown,
): void {
  switch (metadata.type) {
    case "float": gl.uniform1fv(location, value); return;
    case "vec2": gl.uniform2fv(location, value); return;
    case "vec3": gl.uniform3fv(location, value); return;
    case "vec4": gl.uniform4fv(location, value); return;
    case "mat2": gl.uniformMatrix2fv(location, false, value); return;
    case "mat3": gl.uniformMatrix3fv(location, false, value); return;
    case "mat4": gl.uniformMatrix4fv(location, false, value); return;
    case "int":
    case "bool":
    case "sampler2D":
    case "samplerCube":
    case "sampler2DArray":
      gl.uniform1iv(location, value);
      return;
    case "ivec2":
    case "bvec2": gl.uniform2iv(location, value); return;
    case "ivec3":
    case "bvec3": gl.uniform3iv(location, value); return;
    case "ivec4":
    case "bvec4": gl.uniform4iv(location, value); return;
    case "uint": gl.uniform1uiv(location, value); return;
    case "uvec2": gl.uniform2uiv(location, value); return;
    case "uvec3": gl.uniform3uiv(location, value); return;
    case "uvec4": gl.uniform4uiv(location, value); return;
    default: throw new Error(`Unsupported Pixi uniform type: ${metadata.type}`);
  }
}

function uploadSingleUniform(
  gl: UniformGl,
  metadata: UniformMetadata,
  cached: CachedUniform,
  value: unknown,
): void {
  const location = cached.location;
  const values = value as UniformValueArray;
  const cache = cached.value as MutableNumericCache;

  switch (metadata.type) {
    case "float":
      updateCachedScalar(cached, value as UniformScalar, (next) => gl.uniform1f(location, next));
      return;
    case "vec2":
      updateCached2(cache, values[0], values[1], (x, y) => gl.uniform2f(location, x, y));
      return;
    case "vec3":
      updateCached3(cache, values[0], values[1], values[2], (x, y, z) => {
        gl.uniform3f(location, x, y, z);
      });
      return;
    case "vec4":
      updateCached4(cache, values[0], values[1], values[2], values[3], (x, y, z, w) => {
        gl.uniform4f(location, x, y, z, w);
      });
      return;
    case "int":
    case "bool":
    case "sampler2D":
    case "samplerCube":
    case "sampler2DArray":
      updateCachedScalar(cached, value as UniformScalar, (next) => gl.uniform1i(location, next));
      return;
    case "ivec2":
    case "bvec2":
      updateCached2(cache, values[0], values[1], (x, y) => gl.uniform2i(location, x, y));
      return;
    case "ivec3":
    case "bvec3":
      updateCached3(cache, values[0], values[1], values[2], (x, y, z) => {
        gl.uniform3i(location, x, y, z);
      });
      return;
    case "ivec4":
    case "bvec4":
      updateCached4(cache, values[0], values[1], values[2], values[3], (x, y, z, w) => {
        gl.uniform4i(location, x, y, z, w);
      });
      return;
    case "uint":
      updateCachedScalar(cached, value as UniformScalar, (next) => gl.uniform1ui(location, next));
      return;
    case "uvec2":
      updateCached2(cache, values[0], values[1], (x, y) => gl.uniform2ui(location, x, y));
      return;
    case "uvec3":
      updateCached3(cache, values[0], values[1], values[2], (x, y, z) => {
        gl.uniform3ui(location, x, y, z);
      });
      return;
    case "uvec4":
      updateCached4(cache, values[0], values[1], values[2], values[3], (x, y, z, w) => {
        gl.uniform4ui(location, x, y, z, w);
      });
      return;
    case "mat2": gl.uniformMatrix2fv(location, false, value); return;
    case "mat3": gl.uniformMatrix3fv(location, false, value); return;
    case "mat4": gl.uniformMatrix4fv(location, false, value); return;
    default: throw new Error(`Unsupported Pixi uniform type: ${metadata.type}`);
  }
}

export function syncPixiUniformsForCsp(
  this: unknown,
  groupValue: unknown,
  glProgramValue: unknown,
  syncDataValue?: unknown,
): void {
  const system = this as ShaderSystemRuntime;
  const group = groupValue as UniformGroupRuntime;
  const glProgram = glProgramValue as GlProgramRuntime;
  const renderer = system.renderer;
  const gl = renderer.gl;
  const metadataByName = system.shader.program.uniformData;
  const syncData = (recordValue(syncDataValue) ?? {}) as unknown as SyncData;
  if (!Number.isFinite(syncData.textureCount)) syncData.textureCount = 0;
  if (!Number.isFinite(syncData.uboCount)) syncData.uboCount = 0;

  for (const [name, value] of Object.entries(group.uniforms)) {
    const metadata = metadataByName[name];
    if (!metadata) {
      const nestedGroup = recordValue(value);
      if (nestedGroup?.group === true) {
        if (nestedGroup.ubo === true) renderer.shader.syncUniformBufferGroup(value, name);
        else renderer.shader.syncUniformGroup(value, syncData);
      }
      continue;
    }

    const cached = glProgram.uniformData[name];
    if (!cached) throw new Error(`Missing Pixi uniform location: ${name}`);
    const objectValue = recordValue(value);
    const isSingle = metadata.size === 1 && !metadata.isArray;

    if (
      isSingle
      && (metadata.type === "sampler2D"
        || metadata.type === "samplerCube"
        || metadata.type === "sampler2DArray")
      && (value == null || objectValue?.castToBaseTexture !== undefined)
    ) {
      const textureUnit = syncData.textureCount++;
      renderer.texture.bind(value, textureUnit);
      if (cached.value !== textureUnit) {
        cached.value = textureUnit;
        gl.uniform1i(cached.location, textureUnit);
      }
      continue;
    }

    if (
      isSingle
      && metadata.type === "mat3"
      && objectValue?.a !== undefined
      && typeof objectValue.toArray === "function"
    ) {
      const matrix = objectValue.toArray.call(value, true);
      gl.uniformMatrix3fv(cached.location, false, matrix);
      continue;
    }

    if (isSingle && metadata.type === "vec2" && objectValue?.x !== undefined) {
      updateCached2(
        cached.value as MutableNumericCache,
        objectValue.x,
        objectValue.y,
        (x, y) => gl.uniform2f(cached.location, x, y),
      );
      continue;
    }

    if (isSingle && metadata.type === "vec4" && objectValue?.width !== undefined) {
      updateCached4(
        cached.value as MutableNumericCache,
        objectValue.x,
        objectValue.y,
        objectValue.width,
        objectValue.height,
        (x, y, width, height) => gl.uniform4f(cached.location, x, y, width, height),
      );
      continue;
    }

    if (isSingle && metadata.type === "vec4" && objectValue?.red !== undefined) {
      updateCached4(
        cached.value as MutableNumericCache,
        objectValue.red,
        objectValue.green,
        objectValue.blue,
        objectValue.alpha,
        (red, green, blue, alpha) => {
          gl.uniform4f(cached.location, red, green, blue, alpha);
        },
      );
      continue;
    }

    if (isSingle && metadata.type === "vec3" && objectValue?.red !== undefined) {
      updateCached3(
        cached.value as MutableNumericCache,
        objectValue.red,
        objectValue.green,
        objectValue.blue,
        (red, green, blue) => gl.uniform3f(cached.location, red, green, blue),
      );
      continue;
    }

    if (isSingle) uploadSingleUniform(gl, metadata, cached, value);
    else uploadUniformArray(gl, metadata, cached.location, value);
  }
}

export function installPixiCspAdapter(): void {
  const prototype = ShaderSystem.prototype as unknown as Record<PropertyKey, unknown>;
  if (prototype[CSP_ADAPTER_FLAG] === true) return;

  Object.defineProperty(prototype, "systemCheck", {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  Object.defineProperty(prototype, "syncUniforms", {
    configurable: true,
    writable: true,
    value: syncPixiUniformsForCsp,
  });
  Object.defineProperty(prototype, CSP_ADAPTER_FLAG, {
    configurable: true,
    value: true,
  });
}
