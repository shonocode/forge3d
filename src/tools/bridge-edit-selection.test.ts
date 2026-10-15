import { describe, it, expect } from "vitest";
import { meshFromData, meshToData, type MeshData } from "../lib/mesh";
import { bridgeEditSelection } from "./bridge-selection";
import { canonicalEdge, edgeEnd, edgeOrigin, forEachEdge, type EditMesh } from "./edit-mode/half-edge";
import { bridgeEdgeLoops } from "./edit-mode/operators";

// The editor's Bridge Edge Loops (compat-backlog C116). Rows `bridge-gui` / `bridge-gui-faces` hold it to Blender 5.1.1.

/** The edges no second face shares, as the editor's edge ids. */
function boundaryEdges(em: EditMesh): Set<number> {
  const out = new Set<number>();
  forEachEdge(em, (he) => {
    if (em.halfEdges[he]!.twin < 0) out.add(canonicalEdge(em, he));
  });
  return out;
}

/** A fan disc of `n` rim vertices round a centre, at height z, wound to face +z or −z. */
function disc(n: number, z: number, r: number, up: boolean, o: number): { positions: number[]; polys: number[][] } {
  const positions = [0, 0, z];
  for (let i = 0; i < n; i++) positions.push(r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z);
  const polys: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = [o, o + 1 + i, o + 1 + ((i + 1) % n)];
    polys.push(up ? t : [...t].reverse());
  }
  return { positions, polys };
}

/** The total length of the edges that join the two heights — the band the bridge lays. */
function bandLength(m: MeshData, z0: number, z1: number): number {
  const seen = new Set<string>();
  let sum = 0;
  for (const p of m.polys)
    p.forEach((a, i) => {
      const b = p[(i + 1) % p.length]!;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(k)) return;
      seen.add(k);
      const za = m.positions[a * 3 + 2]!, zb = m.positions[b * 3 + 2]!;
      if (Math.abs(za - zb) < 1e-9 || Math.min(za, zb) !== z0 || Math.max(za, zb) !== z1) return;
      sum += Math.hypot(m.positions[a * 3]! - m.positions[b * 3]!, m.positions[a * 3 + 1]! - m.positions[b * 3 + 1]!, za - zb);
    });
  return sum;
}

/** A unit cube whose top is split into four quads round a centre vertex: 13 vertices (the C116 review's probe). */
function splitTopCube(): MeshData {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0.5, 0, 1, 1, 0.5, 1, 0.5, 1, 1, 0, 0.5, 1, 0.5, 0.5, 1];
  return {
    positions: new Float32Array(positions),
    polys: [
      [0, 3, 2, 1], [0, 1, 5, 8, 4], [1, 2, 6, 9, 5], [2, 3, 7, 10, 6], [3, 0, 4, 11, 7],
      [4, 8, 12, 11], [8, 5, 9, 12], [12, 9, 6, 10], [11, 12, 10, 7],
    ],
  };
}

describe("bridgeEditSelection (the editor's Bridge)", () => {
  it("pairs two squares by the least total distance, where the old GUI bridge took the nearest first pair", () => {
    // `squaresTurn`: the second square turned 30° and moved 0.5 along x. Blender's joining edges total 4.685 (row
    // `bridge-gui`); the old `bridgeEdgeLoops`, nearest first pair, gave 5.235 — a twisted band.
    const r = Math.PI / 6;
    const B = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => [
      0.5 + (x! - 0.5) * Math.cos(r) - (y! - 0.5) * Math.sin(r) + 0.5,
      (x! - 0.5) * Math.sin(r) + (y! - 0.5) * Math.cos(r) + 0.5,
      1,
    ]);
    const squares: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, ...B.flat()]),
      polys: [[0, 3, 2, 1], [4, 5, 6, 7]],
    };
    const em = meshFromData(squares);
    expect(bridgeEditSelection(em, { edges: boundaryEdges(em) })).not.toBeNull();
    expect(bandLength(meshToData(em), 0, 1)).toBeCloseTo(4.685, 3);

    const old = meshFromData(squares);
    bridgeEdgeLoops(old, boundaryEdges(old));
    expect(bandLength(meshToData(old), 0, 1)).toBeCloseTo(5.235, 3);
  });

  it("bridges loops of different lengths, which the old GUI bridge refused", () => {
    const a = disc(8, 0, 1, false, 0);
    const b = disc(6, 1, 1, true, 9);
    const data: MeshData = { positions: new Float32Array([...a.positions, ...b.positions]), polys: [...a.polys, ...b.polys] };
    const old = meshFromData(data);
    expect(bridgeEdgeLoops(old, boundaryEdges(old)).size).toBe(0);
    const em = meshFromData(data);
    const made = bridgeEditSelection(em, { edges: boundaryEdges(em) })!;
    expect(made.size).toBeGreaterThan(0);
    // Every new face joins the two rims.
    const out = meshToData(em);
    for (const f of made) {
      const zs = new Set(out.polys[f]!.map((v) => out.positions[v * 3 + 2]));
      expect(zs).toEqual(new Set([0, 1]));
    }
  });

  it("takes a vertex selection as Blender flushes it: the same as the edges it encloses", () => {
    const a = disc(8, 0, 1, false, 0);
    const b = disc(6, 1, 1, true, 9);
    const data: MeshData = { positions: new Float32Array([...a.positions, ...b.positions]), polys: [...a.polys, ...b.polys] };
    const byEdges = meshFromData(data);
    bridgeEditSelection(byEdges, { edges: boundaryEdges(byEdges) });
    const byVerts = meshFromData(data);
    const rim = new Set<number>();
    for (const he of boundaryEdges(byVerts)) {
      rim.add(edgeOrigin(byVerts, he));
      rim.add(edgeEnd(byVerts, he));
    }
    bridgeEditSelection(byVerts, { verts: rim });
    expect(meshToData(byVerts).polys).toEqual(meshToData(byEdges).polys);
  });

  it("returns null and leaves the mesh as it was when there is nothing to bridge", () => {
    const one = disc(6, 0, 1, true, 0);
    const em = meshFromData({ positions: new Float32Array(one.positions), polys: one.polys });
    const before = meshToData(em).polys;
    expect(bridgeEditSelection(em, { edges: boundaryEdges(em) })).toBeNull();
    expect(meshToData(em).polys).toEqual(before);
  });

  it("an open tube's two rims: nothing changes, and the faces found in place are selected, as Blender selects faces.out", () => {
    const positions: number[] = [];
    for (const y of [0, 1]) for (let i = 0; i < 6; i++) positions.push(Math.cos((Math.PI * i) / 3), y, Math.sin((Math.PI * i) / 3));
    const polys = Array.from({ length: 6 }, (_, i) => [i, 6 + i, 6 + ((i + 1) % 6), (i + 1) % 6]);
    const em = meshFromData({ positions: new Float32Array(positions), polys });
    expect(bridgeEditSelection(em, { edges: boundaryEdges(em) })?.size).toBe(6);
    expect(meshToData(em).polys).toHaveLength(6);
  });

  it("flushes edges up to the faces they enclose: the same as passing those faces", () => {
    // A cube split on top into four quads; selecting every edge of the top and bottom faces selects those faces.
    const data = splitTopCube();
    const em = meshFromData(data);
    const sel = new Set<number>();
    forEachEdge(em, (he) => {
      const a = edgeOrigin(em, he), b = edgeEnd(em, he);
      if (data.positions[a * 3 + 2] === data.positions[b * 3 + 2] && [0, 1].includes(data.positions[a * 3 + 2]!)) sel.add(canonicalEdge(em, he));
    });
    bridgeEditSelection(em, { edges: sel });
    const byFaces = meshFromData(data);
    const zOf = (f: number): number[] => data.polys[f]!.map((v) => data.positions[v * 3 + 2]!);
    const flat = new Set(data.polys.flatMap((_, f) => (new Set(zOf(f)).size === 1 ? [f] : [])));
    bridgeEditSelection(byFaces, { faces: flat });
    expect(meshToData(em).polys).toEqual(meshToData(byFaces).polys);
  });

  it("keeps the vertex creases on the vertices they were on through the face form's renumbering", () => {
    const data = splitTopCube();
    // A crease on every vertex, its value its height + x: anything misplaced shows.
    data.vertexCreases = new Map(Array.from({ length: data.positions.length / 3 }, (_, v) => [v, 0.1 + data.positions[v * 3 + 2]! * 0.5 + data.positions[v * 3]! * 0.2]));
    const em = meshFromData(data);
    const flat = new Set(data.polys.flatMap((p, f) => (new Set(p.map((v) => data.positions[v * 3 + 2])).size === 1 ? [f] : [])));
    expect(bridgeEditSelection(em, { faces: flat })).not.toBeNull();
    const out = meshToData(em);
    expect(out.positions.length).toBeLessThan(data.positions.length); // renumbered: the top's centre went
    for (const [v, c] of out.vertexCreases!) {
      expect(v).toBeLessThan(out.positions.length / 3);
      expect(c).toBeCloseTo(0.1 + out.positions[v * 3 + 2]! * 0.5 + out.positions[v * 3]! * 0.2, 6);
    }
  });
});
