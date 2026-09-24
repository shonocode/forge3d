import { describe, it, expect } from "vitest";
import type { MeshData } from "../lib/mesh";
import { bridgeLoops } from "./bridge-loops";

/**
 * `bridgeLoops` — `bmesh.ops.bridge_loops`. The agreement with Blender is
 * `probe-bridge-multi.py` and the `bridge-loops` / `-three` / `-unequal` rows
 * (faces to the vertex set, and winding); the counts here are Blender's.
 */

/** Rounded to the six places an OBJ carries, as the probe's inputs are. */
const r6 = (x: number): number => Number(x.toFixed(6));

/** An 8-gon under a 5-gon — `discs85` (tilt 0) and `discs85tilt` (0.6). */
function discs(tilt: number): MeshData {
  const p: number[] = [];
  const polys: number[][] = [];
  const ring = (n: number, rad: number, y: number, down: boolean, phase: number): void => {
    const base = p.length / 3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + phase;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      p.push(r6(x), r6(y + tilt * x + 0.07 * tilt * z * z), r6(z));
    }
    const face = [...Array(n).keys()].map((k) => base + k);
    polys.push(down ? face : face.reverse());
  };
  ring(8, 0.3, 0, true, 0.1);
  ring(5, 0.2, 0.5, false, 0.4);
  return { positions: Float32Array.from(p), polys };
}

/** A 6×6 sheet with two square holes — the parity case `twoHoles`. */
function twoHoles(): MeshData {
  const at = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3];
  const p: number[] = [];
  for (let r = 0; r <= 6; r++) for (let c = 0; c <= 6; c++) p.push(at[c]!, 0, at[r]!);
  const polys: number[][] = [];
  for (let r = 0; r < 6; r++)
    for (let c = 0; c < 6; c++) {
      if ((r === 2 && c === 1) || (r === 2 && c === 4)) continue;
      polys.push([r * 7 + c, r * 7 + c + 1, (r + 1) * 7 + c + 1, (r + 1) * 7 + c]);
    }
  return { positions: Float32Array.from(p), polys };
}

function boundaryEdges(m: MeshData): [number, number][] {
  const count = new Map<string, number>();
  for (const p of m.polys)
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!, b = p[(i + 1) % p.length]!;
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  return [...count].filter(([, n]) => n === 1).map(([k]) => k.split(",").map(Number) as [number, number]);
}

/** Every edge used by two faces runs opposite ways in them. */
function consistentWinding(m: MeshData): boolean {
  const seen = new Set<string>();
  for (const p of m.polys)
    for (let i = 0; i < p.length; i++) {
      const k = `${p[i]},${p[(i + 1) % p.length]}`;
      if (seen.has(k)) return false;
      seen.add(k);
    }
  return true;
}

describe("bridgeLoops", () => {
  it("bridges loops of different lengths, as Blender does", () => {
    // 8 against 5: the 5-gon's vertices are repeated to 8, the band is quads
    // and fans, then triangulated. 2 caps + 13 = Blender's 15.
    for (const tilt of [0, 0.6]) {
      const m = discs(tilt);
      const out = bridgeLoops(m, boundaryEdges(m));
      expect(out.polys, `tilt ${tilt}`).toHaveLength(15);
      expect(out.positions.length / 3).toBe(13);
      expect(consistentWinding(out)).toBe(true);
    }
  });

  it("chains three loops in Blender's order", () => {
    // A hole, the outer rim, the other hole: 34 faces become Blender's 88.
    const m = twoHoles();
    const out = bridgeLoops(m, boundaryEdges(m));
    expect(out.polys).toHaveLength(88);
    expect(out.positions.length / 3).toBe(49);
  });

  it("refuses fewer than two loops, and an odd count in pairs", () => {
    const m = discs(0);
    const one = boundaryEdges(m).filter(([a, b]) => a < 8 && b < 8);
    expect(() => bridgeLoops(m, one)).toThrow(/two edge loops/);
    const h = twoHoles();
    expect(() => bridgeLoops(h, boundaryEdges(h), { usePairs: true })).toThrow(/even number/);
  });
});
