/**
 * Edit Mode on the welded surface (compat-backlog C123): a Babylon mesh's render buffer splits a vertex wherever a UV or
 * the shading parts — a flat box is 24 render vertices for 8 corners. Until 2026-10-16 Edit Mode took the render
 * vertices as its own, so a box's corner tore when dragged and its seams were boundaries.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { buildEditMesh, CREASE_METADATA_KEY, refreshLoopUVs, WELD_METADATA_KEY, writeSurfaceWeld } from "./build";
import { commitPositions, commitTopology, restoreRender, snapshotRender, writeEdgeAttrMetadata } from "./commit";
import { meshToData } from "../../lib/mesh";
import { smartUVProject } from "./uv-unwrap";
import { forEachEdge, edgeOrigin, edgeEnd, faceVerts, seamKey } from "./half-edge";
import { extrudeRegion } from "./face-transform";

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
const renderPos = (m: Mesh): Float32Array => m.getVerticesData(VertexBuffer.PositionKind) as Float32Array;

describe("Edit Mode on the surface", () => {
  it("a box's 24 render vertices are its 8 corners; every face is whole, no edge a boundary", () => {
    const m = box();
    expect(m.getTotalVertices()).toBe(24);
    const em = buildEditMesh(m)!;
    expect(em.vertices).toHaveLength(8);
    let boundary = 0;
    forEachEdge(em, (he) => {
      if (em.halfEdges[he]!.twin < 0) boundary++;
    });
    expect(boundary).toBe(0);
    // Every render triangle names the face it is part of.
    expect(em.triToFace).toHaveLength(m.getIndices()!.length / 3);
    expect(em.triToFace.every((f) => f >= 0)).toBe(true);
  });

  it("moving a corner moves all its render copies — no tear", () => {
    const m = box();
    const em = buildEditMesh(m)!;
    em.positions[0] += 0.5;
    commitPositions(em);
    const P = renderPos(m);
    const copies = em.renderWeld!.flatMap((v, r) => (v === 0 ? [r] : []));
    expect(copies.length).toBe(3);
    for (const r of copies) expect(P[r * 3]).toBeCloseTo(em.positions[0]!, 6);
  });

  it("a topology commit splits it back: flat faces stay flat, the UVs stay on their corners, the list is written", () => {
    const m = box();
    const uvBefore = new Map<string, string>();
    {
      const P = renderPos(m);
      const U = m.getVerticesData(VertexBuffer.UVKind)!;
      const N = m.getVerticesData(VertexBuffer.NormalKind)!;
      for (let r = 0; r < m.getTotalVertices(); r++)
        uvBefore.set(`${P[r * 3]},${P[r * 3 + 1]},${P[r * 3 + 2]}|${N[r * 3]},${N[r * 3 + 1]},${N[r * 3 + 2]}`, `${U[r * 2]},${U[r * 2 + 1]}`);
    }
    const em = buildEditMesh(m)!;
    commitTopology(em);
    expect(m.getTotalVertices()).toBe(24);
    const P = renderPos(m);
    const U = m.getVerticesData(VertexBuffer.UVKind)!;
    const N = m.getVerticesData(VertexBuffer.NormalKind)!;
    for (let r = 0; r < 24; r++) {
      // Each corner keeps the UV it had on the same face (the face named by its normal).
      const k = `${P[r * 3]},${P[r * 3 + 1]},${P[r * 3 + 2]}|${Math.round(N[r * 3]!)},${Math.round(N[r * 3 + 1]!)},${Math.round(N[r * 3 + 2]!)}`;
      expect(uvBefore.has(k)).toBe(true);
      expect(`${U[r * 2]},${U[r * 2 + 1]}`).toBe(uvBefore.get(k));
    }
    const weld = (m.metadata as Record<string, unknown>)[WELD_METADATA_KEY] as number[];
    expect(new Set(weld).size).toBe(8);
  });

  it("an extrude carries the UVs and the box stays closed", () => {
    const m = box();
    const em = buildEditMesh(m)!;
    // Extrude the two triangles of one face (+y): the faces whose every corner is at y = 1.
    const top = new Set(em.faces.map((_, f) => f).filter((f) => faceVerts(em, f).every((v) => em.positions[v * 3 + 1] === 1)));
    expect(top.size).toBeGreaterThan(0);
    extrudeRegion(em, top);
    commitTopology(em);
    const again = buildEditMesh(m)!;
    let boundary = 0;
    forEachEdge(again, (he) => {
      if (again.halfEdges[he]!.twin < 0) boundary++;
    });
    expect(boundary).toBe(0);
    expect(m.getVerticesData(VertexBuffer.UVKind)).not.toBeNull();
  });

  it("a crease marked on an edge is written on every render copy of it", () => {
    const m = box();
    const em = buildEditMesh(m)!;
    let edge = "";
    forEachEdge(em, (he) => {
      if (!edge) edge = seamKey(edgeOrigin(em, he), edgeEnd(em, he));
    });
    em.creases.set(edge, 1);
    writeEdgeAttrMetadata(em);
    const keys = ((m.metadata as Record<string, unknown>)[CREASE_METADATA_KEY] as Array<[string, number]>).map(([k]) => k);
    // A box edge is drawn twice — once per face beside it.
    expect(keys.length).toBe(2);
    for (const k of keys) {
      const [a, b] = k.split("_").map(Number) as [number, number];
      expect(seamKey(em.renderWeld![a]!, em.renderWeld![b]!)).toBe(edge);
    }
    // Built again: the one surface edge, creased.
    const again = buildEditMesh(m)!;
    expect([...again.creases]).toEqual([[edge, 1]]);
  });
});

describe("normals in Babylon's left-handed convention", () => {
  /** Vertices of a box centred on the origin whose normal points away from the centre. */
  const outward = (m: Mesh): number => {
    const P = renderPos(m);
    const N = m.getVerticesData(VertexBuffer.NormalKind)!;
    let n = 0;
    for (let r = 0; r < m.getTotalVertices(); r++) if (P[r * 3]! * N[r * 3]! + P[r * 3 + 1]! * N[r * 3 + 1]! + P[r * 3 + 2]! * N[r * 3 + 2]! > 0) n++;
    return n;
  };

  it("Edit Mode's commit writes outward normals (Babylon's own were, and stay)", () => {
    const m = box();
    expect(outward(m)).toBe(24);
    commitTopology(buildEditMesh(m)!);
    expect(outward(m)).toBe(24);
  });

  it("so does the modifier stack — until 2026-10-16 it lit every mesh with a modifier from inside", async () => {
    const { addModifier } = await import("../modifiers");
    const m = box();
    addModifier(m, "smooth");
    expect(outward(m)).toBe(m.getTotalVertices());
  });
});

describe("the C123 review's cases", () => {
  const sphere = (): Mesh => {
    const m = MeshBuilder.CreateSphere("s", { diameter: 2, segments: 6, updatable: true }, scene);
    writeSurfaceWeld(m);
    return m;
  };
  const normalsPerPosition = (m: Mesh): number => {
    const P = renderPos(m);
    const N = m.getVerticesData(VertexBuffer.NormalKind)!;
    const at = new Map<string, Set<string>>();
    for (let r = 0; r < m.getTotalVertices(); r++) {
      const k = `${P[r * 3]!.toFixed(4)},${P[r * 3 + 1]!.toFixed(4)},${P[r * 3 + 2]!.toFixed(4)}`;
      (at.get(k) ?? at.set(k, new Set()).get(k)!).add(`${N[r * 3]!.toFixed(3)},${N[r * 3 + 1]!.toFixed(3)},${N[r * 3 + 2]!.toFixed(3)}`);
    }
    let sum = 0;
    for (const s2 of at.values()) sum += s2.size;
    return sum / at.size;
  };

  it("without a weld list nothing is welded — a plane's two sides and touching parts stay apart", () => {
    const m = MeshBuilder.CreateBox("raw", { size: 2, updatable: true }, scene);
    expect(buildEditMesh(m)!.vertices).toHaveLength(24);
  });

  it("an unwrapped face takes its own UVs: the result names each poly's face, whatever the island order", () => {
    const em = buildEditMesh(sphere())!;
    const result = smartUVProject(em, {});
    result.polys.forEach((p, k) => {
      const want = new Set(em.faces.length ? [...faceVerts(em, result.faces[k]!)] : []);
      expect(new Set(p.map((v) => result.sourceVerts[v]))).toEqual(want);
    });
  });

  it("a mesh whose normals go with its winding (a glTF import) keeps them outward through a commit", () => {
    // Babylon's box with every triangle wound the other way and its normals as they were: a right-handed buffer.
    const m = box();
    const idx = Array.from(m.getIndices()!);
    for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2]!, idx[t + 1]!];
    m.setIndices(idx);
    writeSurfaceWeld(m);
    const em = buildEditMesh(m)!;
    expect(em.normalSign).toBe(1);
    commitTopology(em);
    const P = renderPos(m);
    const N = m.getVerticesData(VertexBuffer.NormalKind)!;
    for (let r = 0; r < m.getTotalVertices(); r++) expect(P[r * 3]! * N[r * 3]! + P[r * 3 + 1]! * N[r * 3 + 1]! + P[r * 3 + 2]! * N[r * 3 + 2]!).toBeGreaterThan(0);
  });

  it("a box drawn flat reads as flat, not 45° (a 45° bevel would have been smoothed)", () => {
    expect(buildEditMesh(box())!.smoothAngle).toBeLessThan(0.05);
  });

  it("a drag keeps a smooth sphere smooth: built again, the angle is as before", () => {
    const m = sphere();
    const em = buildEditMesh(m)!;
    const before = em.smoothAngle!;
    const smooth = normalsPerPosition(m);
    commitPositions(em);
    expect(buildEditMesh(m)!.smoothAngle).toBeCloseTo(before, 6);
    commitTopology(buildEditMesh(m)!);
    expect(normalsPerPosition(m)).toBeCloseTo(smooth, 6);
  });

  it("an undo puts the render buffer back exactly — the same vertices in the same order", () => {
    const m = sphere();
    const em = buildEditMesh(m)!;
    const snap = snapshotRender(em);
    const data = meshToData(em);
    const before = Array.from(renderPos(m));
    const idxBefore = Array.from(m.getIndices()!);
    commitTopology(em);
    restoreRender(em, snap);
    expect(Array.from(renderPos(m))).toEqual(before);
    expect(Array.from(m.getIndices()!)).toEqual(idxBefore);
    expect(meshToData(em).polys).toEqual(data.polys);
  });

  it("UVs rewritten in the buffer are read back onto the corners in place", () => {
    const m = box();
    const em = buildEditMesh(m)!;
    const uv = new Float32Array(m.getVerticesData(VertexBuffer.UVKind)!).map((x) => x * 0.5 + 0.25);
    m.updateVerticesData(VertexBuffer.UVKind, uv);
    refreshLoopUVs(em);
    commitTopology(em);
    const after = m.getVerticesData(VertexBuffer.UVKind)!;
    for (const x of after) expect(x).toBeGreaterThanOrEqual(0.25 - 1e-6);
  });

  it("a colour buffer follows its vertices through the renumbering", () => {
    const m = sphere();
    const P0 = renderPos(m);
    const col = new Float32Array(m.getTotalVertices() * 4);
    for (let r = 0; r < m.getTotalVertices(); r++) col.set([P0[r * 3]! * 0.5 + 0.5, P0[r * 3 + 1]! * 0.5 + 0.5, P0[r * 3 + 2]! * 0.5 + 0.5, 1], r * 4);
    m.setVerticesData(VertexBuffer.ColorKind, col, true, 4);
    commitTopology(buildEditMesh(m)!);
    const P = renderPos(m);
    const C = m.getVerticesData(VertexBuffer.ColorKind)!;
    for (let r = 0; r < m.getTotalVertices(); r++) expect(C[r * 4]!).toBeCloseTo(P[r * 3]! * 0.5 + 0.5, 4);
  });
});

