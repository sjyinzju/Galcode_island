interface CubismCoreDrawables {
  count?: unknown;
  renderOrders?: unknown;
}

interface CubismCoreOffscreens {
  count?: unknown;
}

interface CubismCoreModel {
  drawables?: CubismCoreDrawables;
  offscreens?: CubismCoreOffscreens;
  getRenderOrders?: () => unknown;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid Cubism Core ${label} count`);
  }
  return value as number;
}

export function applyCubismCoreCompatibility(rawModel: unknown): void {
  if (!rawModel || typeof rawModel !== "object") {
    throw new Error("Cubism Core model is unavailable");
  }

  const model = rawModel as CubismCoreModel;
  const drawables = model.drawables;
  if (!drawables || typeof drawables !== "object") {
    throw new Error("Cubism Core drawables are unavailable");
  }

  const existingRenderOrders = drawables.renderOrders;
  if (
    existingRenderOrders !== undefined
    && !(existingRenderOrders instanceof Int32Array)
  ) {
    throw new Error("Invalid Cubism Core render-order type");
  }

  const drawableCount = nonNegativeSafeInteger(
    drawables.count,
    "drawable",
  );

  const hasR5Layout =
    model.offscreens !== undefined || model.getRenderOrders !== undefined;
  if (!hasR5Layout) {
    if (!(existingRenderOrders instanceof Int32Array)) {
      throw new Error("Cubism Core render orders are unavailable");
    }
    if (existingRenderOrders.length !== drawableCount) {
      throw new Error(
        `Invalid legacy Cubism Core render-order layout: expected ${drawableCount} drawable orders, got ${existingRenderOrders.length}`,
      );
    }
    return;
  }

  const offscreenCount = nonNegativeSafeInteger(
    model.offscreens?.count,
    "offscreen",
  );
  if (typeof model.getRenderOrders !== "function") {
    throw new Error("Cubism Core render orders are unavailable");
  }

  const renderOrders = model.getRenderOrders();
  if (!(renderOrders instanceof Int32Array)) {
    throw new Error("Invalid Cubism Core render-order type");
  }

  const expectedOrderCount = drawableCount + offscreenCount;
  if (!Number.isSafeInteger(expectedOrderCount)) {
    throw new Error("Invalid Cubism Core render-order count");
  }
  if (renderOrders.length !== expectedOrderCount) {
    throw new Error(
      `Invalid Cubism Core render-order layout: expected ${expectedOrderCount} combined orders, got ${renderOrders.length}`,
    );
  }
  if (offscreenCount !== 0) {
    throw new Error(
      "Unsupported Cubism Core render-order layout: offscreen objects require a matching Cubism Framework",
    );
  }

  if (existingRenderOrders !== undefined) {
    if (existingRenderOrders !== renderOrders) {
      throw new Error(
        "Invalid Cubism Core render-order alias: expected the live combined order array",
      );
    }
    return;
  }

  drawables.renderOrders = renderOrders;
}
