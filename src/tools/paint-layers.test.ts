import { describe, expect, it } from "vitest";
import {
  blendToCompositeOp,
  canRemoveLayer,
  makeBaseMeta,
  makeLayerMeta,
  nextActiveAfterRemove,
} from "./paint-layers";

describe("blendToCompositeOp", () => {
  it("maps each blend mode to its canvas composite op", () => {
    expect(blendToCompositeOp("normal")).toBe("source-over");
    expect(blendToCompositeOp("multiply")).toBe("multiply");
    expect(blendToCompositeOp("screen")).toBe("screen");
    expect(blendToCompositeOp("overlay")).toBe("overlay");
  });
});

describe("layer stack rules", () => {
  it("the base layer can never be removed", () => {
    const metas = [makeBaseMeta(), makeLayerMeta(1)];
    expect(canRemoveLayer(metas, 0)).toBe(false);
    expect(canRemoveLayer(metas, 1)).toBe(true);
    expect(canRemoveLayer(metas, 5)).toBe(false); // out of range
  });

  it("new overlay metas default to visible normal @ full opacity", () => {
    const m = makeLayerMeta(2);
    expect(m).toMatchObject({ name: "Layer 2", visible: true, opacity: 1, blend: "normal", isBase: false });
  });

  it("nextActiveAfterRemove keeps pointing at the same layer", () => {
    // Removing below the active layer shifts it down.
    expect(nextActiveAfterRemove(2, 1)).toBe(1);
    // Removing above leaves it alone.
    expect(nextActiveAfterRemove(1, 2)).toBe(1);
    // Removing the active layer activates the one below.
    expect(nextActiveAfterRemove(2, 2)).toBe(1);
    // Never below 0.
    expect(nextActiveAfterRemove(0, 0)).toBe(0);
  });
});
