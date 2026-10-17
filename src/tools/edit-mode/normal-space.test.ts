/**
 * Custom normals in Blender's corner normal spaces (compat-backlog C29b). The parity rows `custom-normal-set*` compare the
 * stored int16 pairs with Blender's exactly; these hold the rules in place without Blender.
 */
import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { cornerFans, cornerFanSpace, customDataToNormal, customNormalToData, decodeCustomNormals, setCustomNormals } from "./normal-space";

/** The parity `cube` (unit, centred), faces 0 and 3 flat as `--tag-sharp-faces` lays them down. */
function cube(): MeshData {
  const positions = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]);
  const polys = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
  return { positions, polys, sharpFaces: polys.map((_, f) => f % 3 === 0) };
}

/** forge-run.ts's `tagNormals`: normalize(Newell face normal + 0.5 · normalize(vertex)), in doubles. */
function tagged(m: MeshData): number[][][] {
  const P = m.positions;
  const unit = (x: number, y: number, z: number): number[] => {
    const l = Math.sqrt(x * x + y * y + z * z);
    return l > 1e-12 ? [x / l, y / l, z / l] : [0, 0, 1];
  };
  return m.polys.map((poly) => {
    let nx = 0, ny = 0, nz = 0;
    poly.forEach((a, i) => {
      const b = poly[(i + 1) % poly.length]!;
      nx += (P[a * 3 + 1]! - P[b * 3 + 1]!) * (P[a * 3 + 2]! + P[b * 3 + 2]!);
      ny += (P[a * 3 + 2]! - P[b * 3 + 2]!) * (P[a * 3]! + P[b * 3]!);
      nz += (P[a * 3]! - P[b * 3]!) * (P[a * 3 + 1]! + P[b * 3 + 1]!);
    });
    const fn = unit(nx, ny, nz);
    return poly.map((v) => {
      const d = unit(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
      return unit(fn[0]! + 0.5 * d[0]!, fn[1]! + 0.5 * d[1]!, fn[2]! + 0.5 * d[2]!);
    });
  });
}

const angle = (a: readonly number[], b: readonly number[]): number => {
  const la = Math.hypot(a[0]!, a[1]!, a[2]!);
  const lb = Math.hypot(b[0]!, b[1]!, b[2]!);
  return Math.acos(Math.min(1, (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (la * lb)));
};

describe("normals_split_custom_set on the parity cube", () => {
  it("stores Blender's pairs and adds Blender's sharp edges (read off Blender 5.1.1's `custom_normal`)", () => {
    const m = cube();
    const { clnors, sharp } = setCustomNormals(m, tagged(m));
    expect(clnors.every(([a, b]) => a === 6399 && b === -16383)).toBe(true);
    // Every edge with a smooth face on both sides: the fans there held normals that disagree.
    expect([...sharp].sort()).toEqual(["0_4", "1_5", "4_5", "4_7", "5_6"]);
  });

  it("the stored pairs read back within the int16 step of what was asked", () => {
    const m = cube();
    const want = tagged(m);
    const { clnors, sharp } = setCustomNormals(m, want);
    const shown = decodeCustomNormals({ ...m, sharp }, clnors);
    shown.forEach((face, f) => face.forEach((n, i) => expect(angle(n, want[f]![i]!)).toBeLessThan(2e-4)));
  });
});

describe("the spaces", () => {
  it("a zero vector or the fan's own normal stores (0, 0), which reads back as the fan's normal", () => {
    const fans = cornerFans(cube());
    const space = fans.spaces[0]!;
    expect(customNormalToData(space, [0, 0, 0])).toEqual([0, 0]);
    expect(customNormalToData(space, space.lnor)).toEqual([0, 0]);
    expect(customDataToNormal(space, [0, 0])).toEqual(space.lnor);
  });

  it("a reference edge along the normal is a space Blender cannot build: alpha and beta 0", () => {
    const s = cornerFanSpace([0, 0, 1], [0, 0, 1], [1, 0, 0], []);
    expect(s.alpha).toBe(0);
    expect(s.beta).toBe(0);
  });

  it("a closed fan starts at its lowest corner; a flat face's corners are fans of one", () => {
    const m: MeshData = {
      // A square pyramid's apex (vertex 4) with every face smooth: one closed fan of four corners.
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, 0, 1]),
      polys: [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
    };
    const fans = cornerFans(m);
    const apex = fans.fans.find((fan) => fan.length === 4)!;
    expect(apex[0]).toBe(Math.min(...apex));
    const flat = cornerFans({ ...m, sharpFaces: [true, false, false, false] });
    expect(flat.fans.filter((fan) => fan.includes(2))).toEqual([[2]]); // face 0's apex corner, alone
  });

  it("a fan reads its corners' pairs averaged (integer division) — two different pairs show one normal", () => {
    const m: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0.2, 0, 1, 0, -1, 1, 0.2, -1, 0, 0]),
      polys: [[0, 1, 2, 3], [0, 3, 4, 5]],
    };
    // Corner 0 is vertex 0 in face 0, corner 4 the same vertex in face 1.
    const corners = [[1000, 0], [0, 0], [0, 0], [0, 0], [-3001, 50], [0, 0], [0, 0], [0, 0]] as [number, number][];
    const shown = cornerFans(m, corners).normals;
    // One fan, mean (-1000.5 → -1000, 25): truncated, as C++'s int division.
    expect(shown[0]).toEqual(shown[4]);
    const space = cornerFans(m).spaces[cornerFans(m).fanOf[0]!]!;
    expect(shown[0]).toEqual(customDataToNormal(space, [-1000, 25]));
  });

  it("a face that repeats a vertex: its second corner is in no fan and keeps its pair (no crash)", () => {
    const m: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 2, 0, -1, 1, 0]),
      polys: [[0, 1, 2, 0, 3, 4]],
    };
    expect(cornerFans(m).fanOf[3]).toBe(-1);
    const held: [number, number][] = [[0, 0], [0, 0], [0, 0], [7, 9], [0, 0], [0, 0]];
    const { clnors } = setCustomNormals(m, [m.polys[0]!.map(() => [0, 0, 1])], held);
    expect(clnors[3]).toEqual([7, 9]);
  });
});
