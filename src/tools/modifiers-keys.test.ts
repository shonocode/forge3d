/**
 * What the GUI's modifier stack knows of the surface beyond the render buffer (compat-backlog C112, C113): which render
 * vertices are one vertex, and the creases and seams Edit Mode keys by render vertex. Before these, the stack welded every
 * coincident render vertex (two touching parts became one), ignored the creases, and left the old keys on the new vertices.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { addModifier, applyModifier, removeModifier } from "./modifiers";
import { buildEditMesh } from "./edit-mode/build";
import { commitPositions, commitTopology } from "./edit-mode/commit";
import { DEFAULT_SMOOTH_ANGLE, evaluateStack, renderToSurface, surfaceToRender } from "./modifier-core";
import { subsurfModifier } from "./subsurf-modifier";
import { CREASE_METADATA_KEY, POLY_METADATA_KEY, SEAM_METADATA_KEY, WELD_METADATA_KEY } from "./edit-mode/build";
import { state } from "../state";
import type { MeshData } from "../lib/mesh";
import type { Modifier } from "../state";

const SUBDIV: Modifier = { id: "s", type: "subdivision", enabled: true, level: 1, mode: "catmull-clark" };

/** A unit box at `x0`, its own eight vertices. */
function boxAt(x0: number, o: number): { positions: number[]; polys: number[][] } {
  const positions: number[] = [];
  for (const [x, y, z] of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] as const)
    positions.push(x0 + x, y, z);
  const polys = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]].map((p) => p.map((v) => v + o));
  return { positions, polys };
}

/** Two boxes face to face, sharing no vertex. */
function touchingBoxes(): MeshData {
  const a = boxAt(0, 0);
  const b = boxAt(1, 8);
  return { positions: Float32Array.from([...a.positions, ...b.positions]), polys: [...a.polys, ...b.polys] };
}

/** An edge key named by where its ends are, so two numberings can be compared. */
function byPosition(P: ArrayLike<number>, key: string): string {
  const at = (v: number): string => [0, 1, 2].map((k) => P[v * 3 + k]!.toFixed(5)).join(",");
  const [a, b] = key.split("_").map(Number) as [number, number];
  return [at(a), at(b)].sort().join("|");
}

function edgesOf(polys: number[][]): Set<string> {
  const out = new Set<string>();
  for (const p of polys)
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!, b = p[(i + 1) % p.length]!;
      out.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    }
  return out;
}

describe("the surface vertex of each render vertex (C113)", () => {
  it("two boxes that touch stay two through the render buffer", () => {
    const render = surfaceToRender(touchingBoxes(), DEFAULT_SMOOTH_ANGLE);
    expect(render.positions.length / 3).toBe(48); // 30°: every corner split three ways
    expect(new Set(render.weld).size).toBe(16);
    expect(renderToSurface(render).surface.positions.length / 3).toBe(16);
  });

  it("without the list (or with one that no longer fits) the weld is by position, as before", () => {
    const render = surfaceToRender(touchingBoxes(), DEFAULT_SMOOTH_ANGLE);
    const { weld: _w, ...bare } = render;
    void _w;
    expect(renderToSurface(bare).surface.positions.length / 3).toBe(12);
    expect(renderToSurface({ ...render, weld: render.weld.slice(1) }).surface.positions.length / 3).toBe(12);
  });

  it("the list keeps apart, never joins: one surface vertex moved off its twin stays where it is", () => {
    const render = surfaceToRender(touchingBoxes(), DEFAULT_SMOOTH_ANGLE);
    const moved = Float32Array.from(render.positions);
    moved[0] += 0.5;
    const { surface } = renderToSurface({ ...render, positions: moved });
    expect(surface.positions.length / 3).toBe(17);
  });

  it("Subdivision sees the two boxes as two (the stack's answer is the modifier's on the parts)", () => {
    const out = evaluateStack(surfaceToRender(touchingBoxes(), DEFAULT_SMOOTH_ANGLE), [SUBDIV]);
    const direct = subsurfModifier(touchingBoxes(), { levels: 1 });
    const back = renderToSurface(out).surface;
    expect(back.polys.length).toBe(direct.polys.length);
    const sorted = (p: ArrayLike<number>): string[] => {
      const r: string[] = [];
      for (let i = 0; i < p.length; i += 3) r.push([p[i]!, p[i + 1]!, p[i + 2]!].map((c) => c.toFixed(5)).join(","));
      return r.sort();
    };
    expect(sorted(back.positions)).toEqual(sorted(direct.positions));
  });
});

describe("creases and seams through the stack (C112)", () => {
  function creasedCube(): MeshData {
    const a = boxAt(0, 0);
    return {
      positions: Float32Array.from(a.positions),
      polys: a.polys,
      creases: new Map([["0_1", 1], ["1_2", 0.5], ["4_5", 0.2]]),
      seams: new Set(["0_3", "2_6"]),
    };
  }

  it("go in on the render vertices, reach Subdivision, and come out on the render edges of their surface edges", () => {
    const cube = creasedCube();
    const render = surfaceToRender(cube, DEFAULT_SMOOTH_ANGLE);
    // On the render buffer each surface edge is two render edges (its ends split by the 30° shading): both carry it.
    expect(render.creases).toHaveLength(6);
    expect(render.seams).toHaveLength(4);
    const out = evaluateStack(render, [SUBDIV]);
    const direct = subsurfModifier(cube, { levels: 1 });
    // The shape is the modifier's with the creases (`use_creases` on) — not the uncreased one.
    const uncreased = subsurfModifier({ positions: cube.positions, polys: cube.polys }, { levels: 1 });
    const back = renderToSurface(out).surface;
    const sorted = (p: ArrayLike<number>): string[] => {
      const r: string[] = [];
      for (let i = 0; i < p.length; i += 3) r.push([p[i]!, p[i + 1]!, p[i + 2]!].map((c) => c.toFixed(5)).join(","));
      return r.sort();
    };
    expect(sorted(back.positions)).toEqual(sorted(direct.positions));
    expect(sorted(back.positions)).not.toEqual(sorted(uncreased.positions));
    // Every key names a real edge of the new buffer, and the creases are the modifier's, edge for edge.
    const edges = edgesOf(out.polys);
    for (const [k] of out.creases!) expect(edges.has(k)).toBe(true);
    for (const k of out.seams!) expect(edges.has(k)).toBe(true);
    const named = (P: ArrayLike<number>, m: Iterable<[string, number]>): string[] => [...m].map(([k, c]) => `${byPosition(P, k)}=${c}`).sort();
    expect(named(back.positions, back.creases!)).toEqual(named(direct.positions, direct.creases!));
    expect([...back.seams!].map((k) => byPosition(back.positions, k)).sort()).toEqual(
      [...direct.seams!].map((k) => byPosition(direct.positions, k)).sort(),
    );
  });

  it("where two render copies of one edge differ, the edge takes the larger, in either order", () => {
    const render = surfaceToRender(creasedCube(), DEFAULT_SMOOTH_ANGLE);
    const copies = render.creases!.filter(([, c]) => c === 1);
    expect(copies).toHaveLength(2);
    const rest = render.creases!.filter(([, c]) => c !== 1);
    for (const order of [[[copies[0]![0], 0.3], copies[1]!], [copies[1]!, [copies[0]![0], 0.3]]] as Array<Array<[string, number]>>) {
      const { surface } = renderToSurface({ ...render, creases: [...rest, ...order] });
      expect([...surface.creases!.values()].sort()).toEqual([0.2, 0.5, 1]);
    }
  });

  it("a key out of range or with a zero crease is left out", () => {
    const render = surfaceToRender(creasedCube(), DEFAULT_SMOOTH_ANGLE);
    const { surface } = renderToSurface({ ...render, creases: [...render.creases!, ["0_999", 1], ["0_0", 1], ["x_1", 1]] });
    expect([...surface.creases!.values()].sort()).toEqual([0.2, 0.5, 1]);
    // A zero on one render copy of an edge: dropped, so the other copy's value is the edge's.
    const [k0, c0] = render.creases![0]!;
    const zeroed = renderToSurface({ ...render, creases: [...render.creases!.filter(([k]) => k !== k0), [k0, 0]] }).surface;
    expect([...zeroed.creases!.values()].sort()).toEqual([0.2, 0.5, 1]);
    expect(c0).toBeGreaterThan(0);
  });
});

describe("the mesh's metadata (C112, C113)", () => {
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

  /** A Babylon box (24 render vertices) with a crease and a seam on its first triangle's first edge, as Edit Mode writes them. */
  function creasedBox(): { box: Mesh; key: string } {
    const box = MeshBuilder.CreateBox("b", { size: 1, updatable: true }, scene);
    const idx = box.getIndices()!;
    const a = idx[0]!, b = idx[1]!;
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    box.metadata = { [CREASE_METADATA_KEY]: [[key, 1]], [SEAM_METADATA_KEY]: [key] };
    return { box, key };
  }

  const meta = (m: Mesh): Record<string, unknown> => m.metadata as Record<string, unknown>;

  it("a Subdivision moves the keys onto its own vertices, and taking it off puts the box's back", () => {
    const { box, key } = creasedBox();
    addModifier(box, "subdivision");
    const polys = meta(box)[POLY_METADATA_KEY] as number[][];
    const edges = edgesOf(polys);
    const creases = meta(box)[CREASE_METADATA_KEY] as Array<[string, number]>;
    const seams = meta(box)[SEAM_METADATA_KEY] as string[];
    // One box edge is two edges after one level, and each is as many render edges as its ends were split into.
    expect(creases.length).toBeGreaterThanOrEqual(2);
    for (const [k, c] of creases) {
      expect(edges.has(k)).toBe(true);
      expect(c).toBe(1);
    }
    expect(seams.length).toBe(creases.length);
    for (const k of seams) expect(edges.has(k)).toBe(true);
    expect((meta(box)[WELD_METADATA_KEY] as number[]).length).toBe(box.getTotalVertices());

    removeModifier(box, state.modifierMap.get(box.uniqueId)![0]!.id);
    expect(meta(box)[CREASE_METADATA_KEY]).toEqual([[key, 1]]);
    expect(meta(box)[SEAM_METADATA_KEY]).toEqual([key]);
    expect(meta(box)[WELD_METADATA_KEY]).toBeUndefined();
  });

  it("lists written for another buffer are not read: a tool rebuilt it with the same vertex count", () => {
    const { box } = creasedBox();
    applyModifier(box, addModifier(box, "subdivision")!.id);
    // As Shade or Weld Vertices would: the same vertices, numbered another way (the triangles listed backwards).
    const idx = Array.from(box.getIndices()!);
    const back: number[] = [];
    for (let t = idx.length - 3; t >= 0; t -= 3) back.push(idx[t + 2]!, idx[t + 1]!, idx[t]!);
    box.setIndices(back);
    addModifier(box, "smooth");
    const base = state.originalGeometryMap.get(box.uniqueId)!;
    expect(base.weld).toBeUndefined();
    expect(base.creases).toBeUndefined();
    expect(base.seams).toBeUndefined();
  });

  it("Add Modifier gives Blender's defaults (compat-backlog C122)", () => {
    const box = MeshBuilder.CreateBox("d", { size: 1, updatable: true }, scene);
    expect(addModifier(box, "array")).toMatchObject({ count: 2, useRelative: true, relX: 1, relY: 0, relZ: 0, useConstant: false });
    expect(addModifier(box, "solidify")).toMatchObject({ thickness: 0.01 });
    expect(addModifier(box, "decimate")).toMatchObject({ ratio: 1 });
  });

  it("Edit Mode keeps the list over a move and drops it over a topology change", () => {
    const { box } = creasedBox();
    applyModifier(box, addModifier(box, "subdivision")!.id);
    const weld = meta(box)[WELD_METADATA_KEY];
    expect(Array.isArray(weld)).toBe(true);
    const em = buildEditMesh(box)!;
    commitPositions(em);
    expect(meta(box)[WELD_METADATA_KEY]).toBe(weld);
    commitTopology(em);
    expect(meta(box)[WELD_METADATA_KEY]).toBeUndefined();
  });

  it("Apply keeps them on the applied buffer, and its undo gives the box's back", () => {
    const { box, key } = creasedBox();
    const mod = addModifier(box, "subdivision")!;
    const after = meta(box)[CREASE_METADATA_KEY];
    applyModifier(box, mod.id);
    expect(meta(box)[CREASE_METADATA_KEY]).toEqual(after);
    state.history.undo();
    // Undo of Apply restores the stack (evaluated again), then undo of Add puts the box back.
    state.history.undo();
    expect(meta(box)[CREASE_METADATA_KEY]).toEqual([[key, 1]]);
  });
});
