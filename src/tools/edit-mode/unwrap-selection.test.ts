// @vitest-environment jsdom
/**
 * Unwrap reads the selection (compat-backlog C128): Blender's Unwrap and Smart UV Project unwrap the selected faces and
 * leave every other face's UVs as they were. Until 2026-10-19 the U key unwrapped the whole mesh whatever was selected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { state } from "../../state";
import { writeSurfaceWeld } from "./build";
import { enterEditMode, exitEditMode, setComponentMode, unwrapMesh } from "./index";
import { faceVerts } from "./half-edge";
import { smartUVProject } from "./uv-unwrap";
import { meshFromData } from "../../lib/mesh";

let engine: NullEngine;
let scene: Scene;
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  state.scene = scene;
  state.history.clear();
});
afterEach(() => {
  exitEditMode();
  state.history.clear();
  scene.dispose();
  engine.dispose();
});

describe("Unwrap and the selection", () => {
  it("smartUVProject with faces unwraps those faces only", () => {
    const em = meshFromData({
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0]),
      polys: [[0, 1, 2, 3], [1, 4, 5, 2]],
    });
    const r = smartUVProject(em, { faces: new Set([1]) });
    expect([...new Set(r.faces)]).toEqual([1]);
  });

  it("the U key leaves the faces not selected as they were", () => {
    const m = MeshBuilder.CreateBox("b", { size: 2, updatable: true }, scene);
    writeSurfaceWeld(m);
    enterEditMode(m);
    const em = state.editMesh!;
    const before = structuredClone(em.loopUVs!);
    setComponentMode("face");
    state.editSelection.indices.add(0);
    unwrapMesh();
    const after = state.editMesh!.loopUVs!;
    for (let f = 1; f < before.length; f++) expect(after[f]).toEqual(before[f]);
    expect(after[0]).not.toEqual(before[0]);
  });

  it("with nothing selected it does nothing", () => {
    const m = MeshBuilder.CreateBox("b", { size: 2, updatable: true }, scene);
    writeSurfaceWeld(m);
    enterEditMode(m);
    unwrapMesh();
    expect(state.history.undoCount()).toBe(0);
  });

  it("keeps the selection, picks faces by vertices in vertex mode, and undoes", () => {
    const m = MeshBuilder.CreateBox("b", { size: 2, updatable: true }, scene);
    writeSurfaceWeld(m);
    const uvBuffer = Array.from(m.getVerticesData(VertexBuffer.UVKind)!);
    enterEditMode(m);
    const em = state.editMesh!;
    const before = structuredClone(em.loopUVs!);
    // vertex mode: the corners of face 0 select face 0 only
    setComponentMode("vertex");
    for (const v of faceVerts(em, 0)) state.editSelection.indices.add(v);
    const picked = [...state.editSelection.indices].sort();
    unwrapMesh();
    expect([...state.editSelection.indices].sort()).toEqual(picked);
    const after = state.editMesh!.loopUVs!;
    expect(after[0]).not.toEqual(before[0]);
    for (let f = 1; f < before.length; f++) expect(after[f]).toEqual(before[f]);
    state.history.undo();
    expect(Array.from(m.getVerticesData(VertexBuffer.UVKind)!)).toEqual(uvBuffer);
  });

  it("with no UV map the faces left alone get Blender's new-map value, not zeros", () => {
    const m = MeshBuilder.CreateBox("b", { size: 2, updatable: true }, scene);
    m.removeVerticesData(VertexBuffer.UVKind);
    writeSurfaceWeld(m);
    enterEditMode(m);
    setComponentMode("face");
    state.editSelection.indices.add(0);
    unwrapMesh();
    const em = state.editMesh!;
    const f = 1;
    expect(em.loopUVs![f]).toEqual(faceVerts(em, f).length === 4 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [1, 0], [1, 1]]);
  });
});
