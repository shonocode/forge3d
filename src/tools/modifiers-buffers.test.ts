/**
 * The GUI's modifier stack on a Babylon mesh whose vertex count it changes (compat-backlog C95): no vertex buffer may be
 * left at the old length. `applyGeometry` writes positions / normals / UVs / indices; before C95 a colour or skin buffer
 * the mesh already had stayed as it was, shaped for the old vertices.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { addModifier, removeModifier, updateModifierParam, applyModifier } from "./modifiers";
import { state } from "../state";
import { store } from "../store";

let engine: NullEngine;
let scene: Scene;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
});
afterEach(() => {
  scene.dispose();
  engine.dispose();
  state.modifierMap.clear();
  state.originalGeometryMap.clear();
  state.history.clear();
});

/** Every vertex buffer's element count, which must be the position count. */
function staleKinds(mesh: Mesh): string[] {
  const n = mesh.getTotalVertices();
  const out: string[] = [];
  for (const kind of mesh.getVerticesDataKinds()) {
    const size = mesh.getVertexBuffer(kind)!.getSize();
    let data: ArrayLike<number> | null = null;
    try {
      data = mesh.getVerticesData(kind);
    } catch {
      // Babylon reads `count × size` floats and throws when the buffer is shorter — the stale case itself.
    }
    if (!data || data.length !== n * size) out.push(`${kind} ${data?.length}/${n * size}`);
  }
  return out;
}

function boxWith(kinds: string[]): Mesh {
  const box = MeshBuilder.CreateBox("b", { size: 1 }, scene);
  const n = box.getTotalVertices();
  if (kinds.includes(VertexBuffer.ColorKind)) box.setVerticesData(VertexBuffer.ColorKind, new Float32Array(n * 4).fill(0.5));
  if (kinds.includes(VertexBuffer.MatricesIndicesKind)) box.setVerticesData(VertexBuffer.MatricesIndicesKind, new Float32Array(n * 4));
  if (kinds.includes(VertexBuffer.MatricesWeightsKind))
    box.setVerticesData(VertexBuffer.MatricesWeightsKind, new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)));
  return box;
}

describe("modifier stack and the mesh's other vertex buffers (C95)", () => {
  it("a Subdivision leaves no buffer at the old vertex count (colour)", () => {
    const box = boxWith([VertexBuffer.ColorKind]);
    const before = box.getTotalVertices();
    addModifier(box, "subdivision");
    expect(box.getTotalVertices()).not.toBe(before);
    expect(staleKinds(box)).toEqual([]);
  });

  it("a Subdivision leaves no buffer at the old vertex count (skin weights)", () => {
    const box = boxWith([VertexBuffer.MatricesIndicesKind, VertexBuffer.MatricesWeightsKind]);
    addModifier(box, "subdivision");
    expect(staleKinds(box)).toEqual([]);
  });

  it("removing the last modifier gives the colours back", () => {
    const box = boxWith([VertexBuffer.ColorKind]);
    const colors = Array.from(box.getVerticesData(VertexBuffer.ColorKind)!);
    const mod = addModifier(box, "subdivision")!;
    removeModifier(box, mod.id);
    expect(staleKinds(box)).toEqual([]);
    expect(Array.from(box.getVerticesData(VertexBuffer.ColorKind) ?? [])).toEqual(colors);
  });

  it("a modifier that takes vertices away drops the longer buffer too (Decimate)", () => {
    const sphere = MeshBuilder.CreateSphere("s", { segments: 8 }, scene);
    const n = sphere.getTotalVertices();
    sphere.setVerticesData(VertexBuffer.ColorKind, new Float32Array(n * 4).fill(0.5));
    addModifier(sphere, "decimate");
    expect(sphere.getTotalVertices()).toBeLessThan(n);
    // `getVerticesData` would cut a longer buffer to the new count; the raw data is what is stale.
    expect(sphere.getVertexBuffer(VertexBuffer.ColorKind)).toBeFalsy();
  });

  it("says what it dropped in the user's words, and that it comes back", () => {
    const box = boxWith([VertexBuffer.ColorKind, VertexBuffer.MatricesIndicesKind, VertexBuffer.MatricesWeightsKind]);
    addModifier(box, "subdivision");
    expect(store.status?.text).toBe("⚠ モディファイアは頂点カラー・スキンウェイトを運ばないので外した（モディファイアを全部外すと戻る）");
  });

  // The review's cases: a snapshot compared on every evaluation reverted later edits, and one restored by count alone
  // wrote buffers onto vertices a count-keeping modifier had reordered.
  it("a buffer written after the first modifier is not reverted by the next evaluation", () => {
    const box = boxWith([VertexBuffer.ColorKind]);
    const mod = addModifier(box, "triangulate")!;
    const n = box.getTotalVertices();
    box.setVerticesData(VertexBuffer.ColorKind, new Float32Array(n * 4).fill(0.9));
    updateModifierParam(box, mod.id, { quadMethod: "beauty" });
    expect(box.getTotalVertices()).toBe(n);
    expect(Array.from(box.getVerticesData(VertexBuffer.ColorKind)!).every((x) => Math.abs(x - 0.9) < 1e-6)).toBe(true);
  });

  it("the colours come back through Apply and its undo", () => {
    const box = boxWith([VertexBuffer.ColorKind]);
    const colors = Array.from(box.getVerticesData(VertexBuffer.ColorKind)!);
    const mod = addModifier(box, "subdivision")!;
    applyModifier(box, mod.id);
    expect(box.getVerticesData(VertexBuffer.ColorKind)).toBeNull();
    addModifier(box, "triangulate");
    state.history.undo(); // the triangulate
    state.history.undo(); // the apply
    state.history.undo(); // the subdivision
    expect(staleKinds(box)).toEqual([]);
    expect(Array.from(box.getVerticesData(VertexBuffer.ColorKind) ?? [])).toEqual(colors);
  });
});
