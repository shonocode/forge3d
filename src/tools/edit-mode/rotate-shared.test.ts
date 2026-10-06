import { describe, it, expect } from "vitest";
import { meshFromData, meshToData } from "../../lib/mesh";
import { canonicalEdge, edgeEnd, edgeOrigin, forEachEdge, toPolygons } from "./half-edge";
import { rotateEdges } from "./operators";

/** Parity rows rotate-edges-shared-pair / -ring / -all (compat-backlog C47); the grid is the one the rows use (4 x 4 quads). */
function grid() {
  const n = 4;
  const positions: number[] = [];
  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) positions.push(c * 0.1 - 0.2, 0, r * 0.1 - 0.2);
  const polys: number[][] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) polys.push([r * 5 + c, (r + 1) * 5 + c, (r + 1) * 5 + c + 1, r * 5 + c + 1]);
  return meshFromData({ positions: Float32Array.from(positions), polys });
}

const has = (em: ReturnType<typeof grid>, a: number, b: number): boolean =>
  toPolygons(em).some((p) => p.some((v, i) => (v === a && p[(i + 1) % p.length] === b) || (v === b && p[(i + 1) % p.length] === a)));

function pick(em: ReturnType<typeof grid>, pairs: number[][]): Set<number> {
  const out = new Set<number>();
  forEachEdge(em, (he) => {
    const c = canonicalEdge(em, he);
    const [a, b] = [edgeOrigin(em, c), edgeEnd(em, c)];
    if (pairs.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) out.add(c);
  });
  return out;
}

describe("rotateEdges on edges that share faces", () => {
  it("turns both edges of one quad, each into the diagonal of the two quads it joined", () => {
    const em = grid();
    expect(has(em, 6, 7) && has(em, 7, 12)).toBe(true);
    rotateEdges(em, pick(em, [[6, 7], [7, 12]]));
    expect(toPolygons(em)).toHaveLength(16);
    expect(has(em, 6, 7)).toBe(false);
    expect(has(em, 7, 12)).toBe(false);
  });

  it("keeps the mesh a closed set of faces when every interior edge is selected (ties are the heap's)", () => {
    const em = grid();
    const interior: number[][] = [];
    for (let r = 1; r <= 3; r++) for (let c = 0; c < 4; c++) interior.push([r * 5 + c, r * 5 + c + 1]);
    for (let r = 0; r < 4; r++) for (let c = 1; c <= 3; c++) interior.push([r * 5 + c, (r + 1) * 5 + c]);
    const turned = rotateEdges(em, pick(em, interior));
    expect(turned.size).toBeGreaterThan(0);
    expect(meshToData(em).polys).toHaveLength(16);
  });
});
