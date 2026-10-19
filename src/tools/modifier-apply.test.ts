/**
 * Apply as Blender's (compat-backlog C130): the modifier alone over the base, evaluated even when switched off; only it
 * leaves the stack. Until 2026-10-19 Apply baked the stack up to it — the modifiers below went into the base and off the
 * stack — and a switched-off modifier left the stack doing nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { addModifier, applyModifier, toggleModifier, updateModifierParam } from "./modifiers";
import { state } from "../state";

let engine: NullEngine;
let scene: Scene;
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  state.scene = scene;
  state.history.clear();
});
afterEach(() => {
  state.history.clear();
  scene.dispose();
  engine.dispose();
});

/** A box off the mirror plane, so Mirror doubles it. */
function box(): Mesh {
  const m = MeshBuilder.CreateBox("b", { size: 1, updatable: true }, scene);
  m.bakeTransformIntoVertices(Matrix.Translation(2, 0, 0));
  return m;
}
const baseCount = (m: Mesh): number => state.originalGeometryMap.get(m.uniqueId)!.positions.length / 3;
const stackTypes = (m: Mesh): string[] => (state.modifierMap.get(m.uniqueId) ?? []).map((x) => `${x.type}${x.enabled ? "" : "(off)"}`);

describe("Apply Modifier (C130)", () => {
  it("[Mirror, Subsurf]: applying Subsurf bakes Subsurf alone and leaves Mirror on the stack", () => {
    const m = box();
    addModifier(m, "mirror");
    const subsurf = addModifier(m, "subdivision")!;
    const shown = m.getTotalVertices();
    applyModifier(m, subsurf.id);
    expect(stackTypes(m)).toEqual(["mirror"]);
    // The base is one subdivided box: half of what the mirrored stack shows (before, the base was both halves).
    expect(baseCount(m) * 2).toBe(shown);
  });

  it("a switched-off modifier is applied all the same", () => {
    const m = box();
    const verts = m.getTotalVertices();
    const subsurf = addModifier(m, "subdivision")!;
    addModifier(m, "mirror");
    toggleModifier(m, subsurf.id);
    applyModifier(m, subsurf.id);
    expect(stackTypes(m)).toEqual(["mirror"]);
    expect(baseCount(m)).toBeGreaterThan(verts);
  });

  it("applying one modifier leaves a switched-off one above it", () => {
    const m = box();
    const subsurf = addModifier(m, "subdivision")!;
    const mirror = addModifier(m, "mirror")!;
    toggleModifier(m, subsurf.id);
    applyModifier(m, mirror.id);
    expect(stackTypes(m)).toEqual(["subdivision(off)"]);
  });

  it("undo puts the stack and the base back", () => {
    const m = box();
    addModifier(m, "mirror");
    const subsurf = addModifier(m, "subdivision")!;
    const base = baseCount(m);
    applyModifier(m, subsurf.id);
    state.history.undo();
    expect(stackTypes(m)).toEqual(["mirror", "subdivision"]);
    expect(baseCount(m)).toBe(base);
  });

  it("a Smooth with factor 0 is not applied and stays, as Blender's is_disabled", () => {
    const m = box();
    const smooth = addModifier(m, "smooth")!;
    updateModifierParam(m, smooth.id, { factor: 0 });
    applyModifier(m, smooth.id);
    expect(stackTypes(m)).toEqual(["smooth"]);
  });

  it("redo applies again", () => {
    const m = box();
    addModifier(m, "mirror");
    const subsurf = addModifier(m, "subdivision")!;
    applyModifier(m, subsurf.id);
    const applied = baseCount(m);
    state.history.undo();
    state.history.redo();
    expect(stackTypes(m)).toEqual(["mirror"]);
    expect(baseCount(m)).toBe(applied);
  });
});
