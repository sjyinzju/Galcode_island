import { ShaderSystem } from "@pixi/core";
import { describe, expect, it, vi } from "vitest";
import {
  installPixiCspAdapter,
  syncPixiUniformsForCsp,
} from "./pixiCspAdapter";

function createGl() {
  return {
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform4f: vi.fn(),
    uniform1i: vi.fn(),
    uniform2i: vi.fn(),
    uniform3i: vi.fn(),
    uniform4i: vi.fn(),
    uniform1ui: vi.fn(),
    uniform2ui: vi.fn(),
    uniform3ui: vi.fn(),
    uniform4ui: vi.fn(),
    uniformMatrix2fv: vi.fn(),
    uniformMatrix3fv: vi.fn(),
    uniformMatrix4fv: vi.fn(),
    uniform1fv: vi.fn(),
    uniform2fv: vi.fn(),
    uniform3fv: vi.fn(),
    uniform4fv: vi.fn(),
    uniform1iv: vi.fn(),
    uniform2iv: vi.fn(),
    uniform3iv: vi.fn(),
    uniform4iv: vi.fn(),
    uniform1uiv: vi.fn(),
    uniform2uiv: vi.fn(),
    uniform3uiv: vi.fn(),
    uniform4uiv: vi.fn(),
  };
}

function createRuntime(uniformData: Record<string, unknown>) {
  const gl = createGl();
  const renderer = {
    gl,
    texture: { bind: vi.fn() },
    shader: {
      syncUniformGroup: vi.fn(),
      syncUniformBufferGroup: vi.fn(),
    },
  };
  const system = {
    renderer,
    shader: { program: { uniformData } },
  };
  return { gl, renderer, system };
}

describe("Pixi strict-CSP adapter", () => {
  it("uploads and caches scalar, object-vector, color and matrix uniforms", () => {
    const matrixArray = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const matrix = { a: 1, toArray: vi.fn(() => matrixArray) };
    const { gl, system } = createRuntime({
      alpha: { type: "float", size: 1, isArray: false },
      point: { type: "vec2", size: 1, isArray: false },
      rectangle: { type: "vec4", size: 1, isArray: false },
      color: { type: "vec3", size: 1, isArray: false },
      matrix: { type: "mat3", size: 1, isArray: false },
    });
    const group = {
      uniforms: {
        alpha: 0.5,
        point: { x: 10, y: 20 },
        rectangle: { x: 1, y: 2, width: 3, height: 4 },
        color: { red: 0.1, green: 0.2, blue: 0.3 },
        matrix,
      },
    };
    const glProgram = {
      uniformData: {
        alpha: { location: "alpha", value: 0 },
        point: { location: "point", value: new Float32Array(2) },
        rectangle: { location: "rectangle", value: new Float32Array(4) },
        color: { location: "color", value: new Float32Array(3) },
        matrix: { location: "matrix", value: new Float32Array(9) },
      },
    };

    syncPixiUniformsForCsp.call(system, group, glProgram, { textureCount: 0, uboCount: 0 });
    syncPixiUniformsForCsp.call(system, group, glProgram, { textureCount: 0, uboCount: 0 });

    expect(gl.uniform1f).toHaveBeenCalledTimes(1);
    expect(gl.uniform1f).toHaveBeenCalledWith("alpha", 0.5);
    expect(gl.uniform2f).toHaveBeenCalledTimes(1);
    expect(gl.uniform2f).toHaveBeenCalledWith("point", 10, 20);
    expect(gl.uniform4f).toHaveBeenCalledTimes(1);
    expect(gl.uniform4f).toHaveBeenCalledWith("rectangle", 1, 2, 3, 4);
    expect(gl.uniform3f).toHaveBeenCalledTimes(1);
    expect(gl.uniform3f).toHaveBeenCalledWith("color", 0.1, 0.2, 0.3);
    expect(matrix.toArray).toHaveBeenCalledTimes(2);
    expect(gl.uniformMatrix3fv).toHaveBeenCalledTimes(2);
    expect(gl.uniformMatrix3fv).toHaveBeenCalledWith("matrix", false, matrixArray);
  });

  it("binds texture uniforms and delegates nested uniform groups", () => {
    const texture = { castToBaseTexture: vi.fn() };
    const nested = { group: true, ubo: false };
    const ubo = { group: true, ubo: true };
    const { gl, renderer, system } = createRuntime({
      texture: { type: "sampler2D", size: 1, isArray: false },
    });
    const group = { uniforms: { texture, nested, ubo } };
    const glProgram = {
      uniformData: {
        texture: { location: "texture", value: -1 },
      },
    };
    const syncData = { textureCount: 3, uboCount: 0 };

    syncPixiUniformsForCsp.call(system, group, glProgram, syncData);

    expect(renderer.texture.bind).toHaveBeenCalledWith(texture, 3);
    expect(gl.uniform1i).toHaveBeenCalledWith("texture", 3);
    expect(syncData.textureCount).toBe(4);
    expect(renderer.shader.syncUniformGroup).toHaveBeenCalledWith(nested, syncData);
    expect(renderer.shader.syncUniformBufferGroup).toHaveBeenCalledWith(ubo, "ubo");
  });

  it("supports generic arrays, signed values, unsigned values and matrices", () => {
    const weights = new Float32Array([0.25, 0.75]);
    const samplerUnits = new Int32Array([0, 1]);
    const transform = new Float32Array(16);
    const { gl, system } = createRuntime({
      weights: { type: "float", size: 2, isArray: true },
      flags: { type: "bvec3", size: 1, isArray: false },
      index: { type: "uint", size: 1, isArray: false },
      offset: { type: "uvec2", size: 1, isArray: false },
      transform: { type: "mat4", size: 1, isArray: false },
      samplerUnits: { type: "sampler2D", size: 2, isArray: true },
    });
    const group = {
      uniforms: {
        weights,
        flags: [true, false, true],
        index: 7,
        offset: [8, 9],
        transform,
        samplerUnits,
      },
    };
    const glProgram = {
      uniformData: {
        weights: { location: "weights", value: new Float32Array(2) },
        flags: { location: "flags", value: new Int32Array(3) },
        index: { location: "index", value: 0 },
        offset: { location: "offset", value: new Uint32Array(2) },
        transform: { location: "transform", value: new Float32Array(16) },
        samplerUnits: { location: "samplerUnits", value: new Int32Array(2) },
      },
    };

    syncPixiUniformsForCsp.call(system, group, glProgram);
    syncPixiUniformsForCsp.call(system, group, glProgram);

    expect(gl.uniform1fv).toHaveBeenCalledTimes(2);
    expect(gl.uniform1fv).toHaveBeenCalledWith("weights", weights);
    expect(gl.uniform3i).toHaveBeenCalledTimes(1);
    expect(gl.uniform3i).toHaveBeenCalledWith("flags", 1, 0, 1);
    expect(gl.uniform1ui).toHaveBeenCalledTimes(1);
    expect(gl.uniform1ui).toHaveBeenCalledWith("index", 7);
    expect(gl.uniform2ui).toHaveBeenCalledTimes(1);
    expect(gl.uniform2ui).toHaveBeenCalledWith("offset", 8, 9);
    expect(gl.uniformMatrix4fv).toHaveBeenCalledTimes(2);
    expect(gl.uniformMatrix4fv).toHaveBeenCalledWith("transform", false, transform);
    expect(gl.uniform1iv).toHaveBeenCalledTimes(2);
    expect(gl.uniform1iv).toHaveBeenCalledWith("samplerUnits", samplerUnits);
  });

  it("fails explicitly for an unsupported uniform type", () => {
    const { system } = createRuntime({
      unsupported: { type: "image3D", size: 1, isArray: false },
    });

    expect(() => syncPixiUniformsForCsp.call(
      system,
      { uniforms: { unsupported: 1 } },
      { uniformData: { unsupported: { location: "unsupported", value: 0 } } },
    )).toThrow("Unsupported Pixi uniform type: image3D");
  });

  it("patches both ShaderSystem extension points once", () => {
    const flag = Symbol.for("galcode.pixi-csp-adapter");
    const prototype = ShaderSystem.prototype as unknown as Record<PropertyKey, unknown>;
    const originalSystemCheck = Object.getOwnPropertyDescriptor(prototype, "systemCheck");
    const originalSyncUniforms = Object.getOwnPropertyDescriptor(prototype, "syncUniforms");
    const originalFlag = Object.getOwnPropertyDescriptor(prototype, flag);

    try {
      installPixiCspAdapter();
      const installedSync = prototype.syncUniforms;
      expect(() => (prototype.systemCheck as () => void)()).not.toThrow();
      expect(installedSync).toBe(syncPixiUniformsForCsp);

      installPixiCspAdapter();
      expect(prototype.syncUniforms).toBe(installedSync);
    } finally {
      if (originalSystemCheck) Object.defineProperty(prototype, "systemCheck", originalSystemCheck);
      else delete prototype.systemCheck;
      if (originalSyncUniforms) Object.defineProperty(prototype, "syncUniforms", originalSyncUniforms);
      else delete prototype.syncUniforms;
      if (originalFlag) Object.defineProperty(prototype, flag, originalFlag);
      else delete prototype[flag];
    }
  });
});
