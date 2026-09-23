import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { edgenetPrepare } from "./edgenet-prepare";

/**
 * `edgenetPrepare`, against Blender.
 *
 * Every case is Blender 5.1.1, printed by
 * `tools/modeling/parity/probe-edgenet-prepare.py`. **The closed loop is the
 * negative control and is deliberately not the only case** — it is the shape
 * that made this operator look inert for three sessions.
 */

const wires = (points: number[][], edges: number[][]): MeshData => ({
  positions: Float32Array.from(points.flat()),
  polys: [],
  edges: edges.map((e) => [...e]),
});

/** The edges that appeared, as sorted pairs. */
function added(before: MeshData, after: MeshData): number[][] {
  const was = new Set(
    (before.edges ?? []).map(([a, b]) => (a! < b! ? `${a}_${b}` : `${b}_${a}`)),
  );
  return (after.edges ?? [])
    .map(([a, b]) => [Math.min(a!, b!), Math.max(a!, b!)])
    .filter(([a, b]) => !was.has(`${a}_${b}`))
    .sort((p, q) => p[0]! - q[0]! || p[1]! - q[1]!);
}

describe("edgenetPrepare", () => {
  it("closes an open chain into a loop", () => {
    // Measured: a chain of 3 gains (0,3), of 2 gains (0,2), of 5 gains (0,5).
    const three = wires(
      [
        [0, 0, 0],
        [0.2, 0, 0],
        [0.2, 0, 0.2],
        [0, 0, 0.2],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );
    expect(added(three, edgenetPrepare(three))).toEqual([[0, 3]]);

    const two = wires(
      [
        [0, 0, 0],
        [0.2, 0, 0],
        [0.2, 0, 0.2],
      ],
      [
        [0, 1],
        [1, 2],
      ],
    );
    expect(added(two, edgenetPrepare(two))).toEqual([[0, 2]]);

    const five = wires(
      [
        [0, 0, 0],
        [0.2, 0, 0],
        [0.3, 0, 0.15],
        [0.2, 0, 0.3],
        [0, 0, 0.3],
        [-0.1, 0, 0.15],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
      ],
    );
    expect(added(five, edgenetPrepare(five))).toEqual([[0, 5]]);
  });

  it("leaves a single edge alone — there is no loop to close", () => {
    const one = wires(
      [
        [0, 0, 0],
        [0.2, 0, 0],
      ],
      [[0, 1]],
    );
    expect(added(one, edgenetPrepare(one))).toEqual([]);
  });

  it("leaves a closed loop alone — the shape that hid this operator", () => {
    const quad = wires(
      [
        [0, 0, 0],
        [0.2, 0, 0],
        [0.2, 0, 0.2],
        [0, 0, 0.2],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
    );
    const out = edgenetPrepare(quad);
    expect(added(quad, out)).toEqual([]);
    expect(out.edges).toHaveLength(4);
  });

  it("bridges two chains, and picks the pairing that is not a bow tie", () => {
    // Measured: facing the same way, (0,3) and (2,5). With the second chain's
    // coordinates mirrored the pairing flips to (0,5) and (2,3) — same
    // topology, different geometry, different answer.
    const aligned = wires(
      [
        [0, 0, 0],
        [0.1, 0, 0],
        [0.2, 0, 0],
        [0, 0, 0.2],
        [0.1, 0, 0.2],
        [0.2, 0, 0.2],
      ],
      [
        [0, 1],
        [1, 2],
        [3, 4],
        [4, 5],
      ],
    );
    expect(added(aligned, edgenetPrepare(aligned))).toEqual([
      [0, 3],
      [2, 5],
    ]);

    const reversed = wires(
      [
        [0, 0, 0],
        [0.1, 0, 0],
        [0.2, 0, 0],
        [0.2, 0, 0.2],
        [0.1, 0, 0.2],
        [0, 0, 0.2],
      ],
      [
        [0, 1],
        [1, 2],
        [3, 4],
        [4, 5],
      ],
    );
    expect(added(reversed, edgenetPrepare(reversed))).toEqual([
      [0, 5],
      [2, 3],
    ]);
  });

  it("bridges two single edges", () => {
    const pair = wires(
      [
        [0, 0, 0],
        [0.2, 0, 0],
        [0, 0, 0.2],
        [0.2, 0, 0.2],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );
    expect(added(pair, edgenetPrepare(pair))).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it("refuses a branching net outright", () => {
    // A T: vertex 1 carries three of the net's edges. Blender returns having
    // done nothing and hands back an empty slot.
    const tee = wires(
      [
        [0, 0, 0],
        [0.2, 0, 0],
        [0.1, 0, 0.2],
        [0.1, 0, -0.2],
      ],
      [
        [0, 1],
        [1, 2],
        [1, 3],
      ],
    );
    expect(added(tee, edgenetPrepare(tee))).toEqual([]);
  });

  it("takes only the first two of three chains", () => {
    const three = wires(
      [
        [0, 0, 0],
        [0.1, 0, 0],
        [0, 0, 0.1],
        [0.1, 0, 0.1],
        [0, 0, 0.2],
        [0.1, 0, 0.2],
      ],
      [
        [0, 1],
        [2, 3],
        [4, 5],
      ],
    );
    expect(added(three, edgenetPrepare(three))).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it("makes no face and moves no vertex", () => {
    const chain = wires(
      [
        [0, 0, 0],
        [0.2, 0, 0],
        [0.2, 0, 0.2],
      ],
      [
        [0, 1],
        [1, 2],
      ],
    );
    const out = edgenetPrepare(chain);
    expect(out.polys).toEqual([]);
    expect([...out.positions]).toEqual([...chain.positions]);
  });
});
