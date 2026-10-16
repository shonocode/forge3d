/**
 * The tools that rebuild a render buffer carry its weld list, polygons, creases and seams (compat-backlog C125). Edit
 * Mode welds only what the weld list says (C123), so until 2026-10-17 a box tore at its corners again after Flip Normals
 * (the rewound buffer no longer matched the list's signature), Shade (new numbering, no list) or dyntopo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { buildEditMesh, carryKeyedLists, POLY_METADATA_KEY, readRenderTopology, WELD_METADATA_KEY, writeSurfaceWeld } from "./edit-mode/build";
import { writeEdgeAttrMetadata } from "./edit-mode/commit";
import { edgeEnd, edgeOrigin, faceVerts, forEachEdge, seamKey, type EditMesh } from "./edit-mode/half-edge";
import { applyShading, flipNormals, restoreVertexData, snapshotVertexData, weldVertices } from "./mesh-utils";
import { refineWithinRadii, remapAttribute, remapWeld, remapWeldBySources } from "./dyntopo";
import { captureGeometry, restoreGeometry } from "./sculpt";

let engine: NullEngine;
let scene: Scene;
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
});
afterEach(() => {
  scene.dispose();
  engine.dispose();
});

/** A box as forge3d's Add ▸ Box makes it: Babylon's 24-vertex box with its weld list written. */
const box = (): Mesh => {
  const m = MeshBuilder.CreateBox("b", { size: 2, updatable: true }, scene);
  writeSurfaceWeld(m);
  return m;
};
/** Give a box its 6 quads (`forge3dPolys`) — Babylon fans each side as (a, b, c), (a, c, d). */
const withQuads = (m: Mesh): Mesh => {
  const I = m.getIndices()!;
  const polys: number[][] = [];
  for (let t = 0; t < I.length; t += 6) {
    expect(I[t + 3]).toBe(I[t]);
    expect(I[t + 4]).toBe(I[t + 2]);
    polys.push([I[t]!, I[t + 1]!, I[t + 2]!, I[t + 5]!]);
  }
  (m.metadata as Record<string, unknown>)[POLY_METADATA_KEY] = polys;
  expect(readRenderTopology(m)!.polys).toHaveLength(6);
  return m;
};
const boundary = (em: EditMesh): number => {
  let n = 0;
  forEachEdge(em, (he) => {
    if (em.halfEdges[he]!.twin < 0) n++;
  });
  return n;
};
/** Crease the edge of `em` between the corners nearest (1,1,1) and (1,1,-1), and write it to the buffer. */
const creaseTopEdge = (m: Mesh): string => {
  const em = buildEditMesh(m)!;
  const at = (x: number, y: number, z: number): number => {
    for (let v = 0; v < em.vertices.length; v++)
      if (Math.hypot(em.positions[v * 3]! - x, em.positions[v * 3 + 1]! - y, em.positions[v * 3 + 2]! - z) < 1e-6) return v;
    throw new Error("no corner");
  };
  const k = seamKey(at(1, 1, 1), at(1, 1, -1));
  em.creases.set(k, 0.7);
  writeEdgeAttrMetadata(em);
  return k;
};
/** The creases Edit Mode reads, by their ends' positions. */
const creasesByPosition = (em: EditMesh): string[] => {
  const out: string[] = [];
  forEachEdge(em, (he) => {
    const k = seamKey(edgeOrigin(em, he), edgeEnd(em, he));
    const c = em.creases.get(k);
    if (c === undefined) return;
    const p = (v: number): string => [0, 1, 2].map((i) => Math.round(em.positions[v * 3 + i]!)).join(",");
    out.push([p(edgeOrigin(em, he)), p(edgeEnd(em, he))].sort().join("|") + `=${c}`);
  });
  return [...new Set(out)];
};
/** Each face's normal points away from the centre (true) or towards it (false). */
const facing = (em: EditMesh): boolean[] =>
  em.faces.map((_, f) => {
    const vs = faceVerts(em, f);
    const P = (v: number, i: number): number => em.positions[v * 3 + i]!;
    const c = [0, 1, 2].map((i) => vs.reduce((s, v) => s + P(v, i), 0) / vs.length);
    const a = vs[0]!, b = vs[1]!, d = vs[2]!;
    const u = [0, 1, 2].map((i) => P(b, i) - P(a, i)), w = [0, 1, 2].map((i) => P(d, i) - P(a, i));
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    return n[0]! * c[0]! + n[1]! * c[1]! + n[2]! * c[2]! > 0;
  });

describe("Flip Normals", () => {
  it("keeps the weld, the quads and a crease — Edit Mode still edits 8 corners, 6 quads, now facing in", () => {
    const m = withQuads(box());
    creaseTopEdge(m);
    const before = buildEditMesh(m)!;
    expect(before.vertices).toHaveLength(8);
    expect(before.faces.every((_, f) => faceVerts(before, f).length === 4)).toBe(true);
    const outward = facing(before);

    expect(flipNormals(m)).toBe(true);
    const em = buildEditMesh(m)!;
    expect(em.vertices).toHaveLength(8);
    expect(em.faces).toHaveLength(6);
    expect(em.faces.every((_, f) => faceVerts(em, f).length === 4)).toBe(true);
    expect(boundary(em)).toBe(0);
    expect(facing(em)).toEqual(outward.map((o) => !o));
    expect(creasesByPosition(em)).toEqual(creasesByPosition(before));
  });

  it("a buffer without polygons is rewound triangle by triangle and keeps its weld", () => {
    const m = box();
    flipNormals(m);
    const em = buildEditMesh(m)!;
    expect(em.vertices).toHaveLength(8);
    expect(boundary(em)).toBe(0);
  });

  it("undo puts the lists back with the buffer", () => {
    const m = box();
    const snap = snapshotVertexData(m)!;
    const meta = structuredClone(m.metadata);
    flipNormals(m);
    expect(m.metadata).not.toEqual(meta);
    restoreVertexData(m, snap);
    expect(m.metadata).toEqual(meta);
    expect(buildEditMesh(m)!.vertices).toHaveLength(8);
  });
});

describe("Shade", () => {
  it("Shade Flat on a sphere splits the render vertices but Edit Mode keeps the same closed surface", () => {
    const m = MeshBuilder.CreateSphere("s", { segments: 6, updatable: true }, scene);
    writeSurfaceWeld(m);
    const before = buildEditMesh(m)!;
    const renderBefore = m.getTotalVertices();
    expect(applyShading(m, 0.02)).toBe(true);
    expect(m.getTotalVertices()).toBeGreaterThan(renderBefore);
    const em = buildEditMesh(m)!;
    expect(em.vertices).toHaveLength(before.vertices.length);
    expect(em.faces).toHaveLength(before.faces.length);
    expect(boundary(em)).toBe(boundary(before));
  });

  it("keeps the quads and a crease of a box", () => {
    const m = withQuads(box());
    creaseTopEdge(m);
    const before = buildEditMesh(m)!;
    applyShading(m, Math.PI);
    const em = buildEditMesh(m)!;
    expect(em.vertices).toHaveLength(8);
    expect(em.faces.every((_, f) => faceVerts(em, f).length === 4)).toBe(true);
    expect(creasesByPosition(em)).toEqual(creasesByPosition(before));
  });

  it("a buffer with no weld list gets one that joins only what Shade split — what was apart stays apart", () => {
    // An 8-vertex cube sharing its corners, and a triangle touching one corner by position only: two parts, no list.
    const m = MeshBuilder.CreateBox("b", { size: 2, updatable: true }, scene);
    const P: number[] = [];
    for (let i = 0; i < 8; i++) P.push(i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1);
    P.push(1, 1, 1, 2, 1, 1, 1, 2, 1);
    const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    const vd = new VertexData();
    vd.positions = P;
    vd.indices = [...quads.flatMap((q) => [q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!]), 8, 9, 10];
    vd.normals = new Float32Array(P.length);
    VertexData.ComputeNormals(vd.positions, vd.indices, vd.normals);
    m.removeVerticesData(VertexBuffer.UVKind);
    vd.applyToMesh(m, true);
    m.metadata = null;
    expect(buildEditMesh(m)!.vertices).toHaveLength(11);
    applyShading(m, 0.02);
    expect(m.getTotalVertices()).toBe(24 + 3);
    const weld = (m.metadata as Record<string, unknown>)[WELD_METADATA_KEY] as number[];
    expect(weld).toHaveLength(27);
    const em = buildEditMesh(m)!;
    expect(em.vertices).toHaveLength(11);
    expect(boundary(em)).toBe(3); // the cube closed; only the lone triangle's edges are open
  });

  it("a quad that Shade Flat splits stays as its two triangles; the flat quad beside it stays a quad", () => {
    const m = MeshBuilder.CreateBox("b", { size: 2, updatable: true }, scene);
    const vd = new VertexData();
    vd.positions = [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0.5, 1];
    const polys = [[0, 1, 4, 3], [1, 2, 5, 4]];
    vd.indices = polys.flatMap((q) => [q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!]);
    vd.normals = new Float32Array(18);
    VertexData.ComputeNormals(vd.positions, vd.indices, vd.normals);
    m.removeVerticesData(VertexBuffer.UVKind);
    vd.applyToMesh(m, true);
    m.metadata = { [POLY_METADATA_KEY]: polys };
    writeSurfaceWeld(m);
    applyShading(m, 0.02);
    const em = buildEditMesh(m)!;
    expect(em.vertices).toHaveLength(6);
    expect(em.faces.map((_, f) => faceVerts(em, f).length).sort()).toEqual([3, 3, 4]);
  });

  it("undo after Shade puts the lists back", () => {
    const m = withQuads(box());
    const snap = snapshotVertexData(m)!;
    const meta = structuredClone(m.metadata);
    applyShading(m, 0.02);
    restoreVertexData(m, snap);
    expect(m.metadata).toEqual(meta);
  });
});

describe("Weld Vertices", () => {
  it("merges a box to 8 vertices; the quads and a crease follow", () => {
    const m = withQuads(box());
    creaseTopEdge(m);
    const before = buildEditMesh(m)!;
    expect(weldVertices(m)).toBe(true);
    expect(m.getTotalVertices()).toBe(8);
    const em = buildEditMesh(m)!;
    expect(em.vertices).toHaveLength(8);
    expect(em.faces.every((_, f) => faceVerts(em, f).length === 4)).toBe(true);
    expect(creasesByPosition(em)).toEqual(creasesByPosition(before));
  });
});

describe("dyntopo", () => {
  it("a collapse survivor keeps its own weld number", () => {
    expect(remapWeldBySources([5, 6, 7, 5], [[0, 1], [2, 2], [3, 3]])).toEqual([5, 7, 5]);
  });

  it("the sculpt stroke's undo puts the lists back with the buffer", () => {
    const m = withQuads(box());
    const snap = captureGeometry(m)!;
    const meta = structuredClone(m.metadata);
    weldVertices(m);
    restoreGeometry(m, snap);
    expect(m.metadata).toEqual(meta);
    expect(m.getTotalVertices()).toBe(24);
  });

  it("splitting the render copies of a seam edge makes copies of one new vertex — no tear", () => {
    const m = box();
    const P = m.getVerticesData(VertexBuffer.PositionKind)!;
    const res = refineWithinRadii(P, m.getIndices()!, [[0, 0, 0]], 10, 0.5);
    expect(res.changed).toBe(true);
    const weld = remapWeld(readRenderTopology(m)!.weld!, res.parents);
    const vd = new VertexData();
    vd.positions = res.positions;
    vd.indices = Array.from(res.indices);
    vd.normals = new Float32Array(res.positions.length);
    VertexData.ComputeNormals(vd.positions, vd.indices, vd.normals);
    vd.uvs = remapAttribute(m.getVerticesData(VertexBuffer.UVKind)!, res.parents, 2);
    vd.applyToMesh(m, true);
    carryKeyedLists(m, { weld, creases: new Map(), seams: new Set(), polys: null }, Array.from({ length: weld.length }, (_, v) => v));
    const em = buildEditMesh(m)!;
    expect(em.vertices.length).toBeLessThan(m.getTotalVertices());
    expect(boundary(em)).toBe(0);
  });
});
