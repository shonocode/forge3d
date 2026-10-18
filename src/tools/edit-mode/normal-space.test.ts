/**
 * Custom normals in Blender's corner normal spaces (compat-backlog C29b). The parity rows `custom-normal-set*` compare the
 * stored int16 pairs with Blender's exactly; these hold the rules in place without Blender.
 */
import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { cornerFans, cornerFanSpace, customDataToNormal, customNormalToData, decodeCustomNormals, setCustomNormals, throughStoredNormals } from "./normal-space";
import { meshFromData, meshToData } from "../../lib/mesh";
import { rebuildPolygons } from "./half-edge";
import { reverseFaces } from "./operators";
import { withMovedPositions } from "./normal-space";
import { setSharpnessByAngle } from "./sharpness";
import { fanNormals, mixCornerNormals } from "./normals";
import { textureDisplace } from "../displace";
import { weightedNormal } from "./normal-modifiers";
import { moveFaces, offsetFaces } from "./face-transform";
import { transformMesh } from "../mesh-ops";

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

describe("operators through the stored pairs (compat-backlog C29c)", () => {
  it("reverse faces: each corner keeps its pair, read in the flipped face's space", () => {
    const m = cube();
    const { clnors, sharp } = setCustomNormals(m, tagged(m));
    const shown = decodeCustomNormals({ ...m, sharp }, clnors);
    const em = meshFromData({ ...m, sharp, normals: shown });
    reverseFaces(em, new Set([0, 1, 2, 3, 4, 5]));
    const out = meshToData(em);
    // The same pairs, moved with their vertices into the reversed rings, read in the reversed mesh.
    let c = 0;
    const byVertex = m.polys.map((p) => new Map(p.map((v) => [v, clnors[c++]!] as const)));
    const flipped = out.polys.flatMap((p, f) => p.map((v) => byVertex[f]!.get(v)!));
    const want = decodeCustomNormals({ ...m, polys: out.polys, sharp }, flipped);
    // Within one int16 step: the operator re-derives the pairs from the vectors it was given (see throughStoredNormals).
    out.normals.forEach((face, f) => face.forEach((n, i) => expect(angle(n, want[f]![i]!)).toBeLessThan(2e-4)));
    // And not the vectors it had: a flipped face's corner turns.
    expect(out.normals.some((face, f) => face.some((n, i) => angle(n, shown[f]![out.polys[f]!.length - 1 - i]!) > 0.01))).toBe(true);
  });

  it("a corner made on a split edge copies the pair where the edge starts, and is not mixed", () => {
    const em = meshFromData({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0, 0]),
      polys: [[0, 1, 2, 3]],
      normals: [[[11, 1, 0], [22, 2, 0], [33, 3, 0], [44, 4, 0]]],
    });
    em.loopNormalsArePairs = true;
    rebuildPolygons(em, em.positions, [[0, 4, 1, 2, 3]], { origins: new Map([[4, { from: [0, 1], w: [0.5, 0.5] }]]) });
    expect(em.loopNormals![0]![1]).toEqual([11, 1, 0]);
  });

  it("throughStoredNormals leaves a mesh without custom normals alone", () => {
    const em = meshFromData(cube());
    let ran = false;
    throughStoredNormals(em, () => (ran = true));
    expect(ran).toBe(true);
    expect(em.loopNormals).toBeUndefined();
    expect(em.loopNormalsArePairs).toBeUndefined();
  });

  it("an operator that throws leaves the vectors as they were — not the pairs", () => {
    const m = cube();
    const em = meshFromData({ ...m, normals: tagged(m) });
    const before = JSON.stringify(em.loopNormals);
    expect(() => throughStoredNormals(em, () => {
      throw new Error("no");
    })).toThrow("no");
    expect(JSON.stringify(em.loopNormals)).toBe(before);
    expect(em.loopNormalsArePairs).toBeUndefined();
  });

  it("an operator that changes nothing leaves the vectors exactly", () => {
    const m = cube();
    const em = meshFromData({ ...m, normals: tagged(m) });
    const before = JSON.stringify(em.loopNormals);
    throughStoredNormals(em, () => undefined);
    expect(JSON.stringify(em.loopNormals)).toBe(before);
  });
});

describe("custom normals on operators that move vertices and change edges (compat-backlog C29d)", () => {
  const turned = (m: MeshData, t: number): Float32Array => {
    // A quarter turn about z: (x, y, z) → (−y, x, z).
    const P = new Float32Array(m.positions.length);
    for (let v = 0; v < P.length / 3; v++) {
      P[v * 3] = -m.positions[v * 3 + 1]! * t;
      P[v * 3 + 1] = m.positions[v * 3]! * t;
      P[v * 3 + 2] = m.positions[v * 3 + 2]! * t;
    }
    return P;
  };

  it("withMovedPositions turns the custom normals with the surface; withPositions-style copying would not", () => {
    const m = cube();
    const { clnors, sharp } = setCustomNormals(m, tagged(m));
    const shown = decodeCustomNormals({ ...m, sharp }, clnors);
    const out = withMovedPositions({ ...m, sharp, normals: shown }, turned(m, 1));
    out.normals!.forEach((face, f) =>
      face.forEach((n, i) => {
        const was = shown[f]![i]!;
        expect(angle(n, [-was[1]!, was[0]!, was[2]!])).toBeLessThan(2e-4);
      }),
    );
  });

  it("setSharpnessByAngle with no custom normals fills each corner's fan normal — not the face normal — on a smooth fan", () => {
    // A 2×2 grid, its centre raised a little (no edge there reaches 0.5 rad), and a fifth quad folded down 90° off one
    // side so that something does turn sharp. The centre's four corners are one fan.
    const m: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0.1, 2, 1, 0, 0, 2, 0, 1, 2, 0, 2, 2, 0, 2, 1, -1, 2, 0, -1]),
      polys: [[0, 1, 4, 3], [1, 2, 5, 4], [3, 4, 7, 6], [4, 5, 8, 7], [5, 2, 10, 9]],
    };
    const out = setSharpnessByAngle(m, { angle: 0.5 });
    expect(out.sharp && out.sharp.size).toBeGreaterThan(0);
    const centre = out.polys.flatMap((p, f) => p.flatMap((v, i) => (v === 4 ? [out.normals![f]![i]!] : [])));
    expect(centre).toHaveLength(4);
    for (const n of centre) expect(angle(n, centre[0]!)).toBeLessThan(1e-6); // one fan, one normal
    expect(angle(centre[0]!, [0, 0, 1])).toBeLessThan(0.01); // the mean of four faces tilted about it, not any one
    expect(angle(centre[0]!, out.normals![0]![0]!)).toBeGreaterThan(0); // and not face 0's own corner normal at vertex 0
  });

  it("setSharpnessByAngle keeps a mesh's custom normals instead of overwriting them", () => {
    const m = cube();
    const want = tagged(m);
    const kept = setSharpnessByAngle({ ...m, normals: want }, { angle: 0.5 });
    kept.normals!.forEach((face, f) => face.forEach((n, i) => expect(angle(n, want[f]![i]!)).toBeLessThan(2e-4)));
  });

  it("Displace CUSTOM_NORMAL moves along the mix of each vertex's corner normals", () => {
    const m = cube();
    const normals = tagged(m);
    const out = textureDisplace({ ...m, normals }, { strength: 1, midLevel: 0, direction: "customNormal" });
    const along = mixCornerNormals(m, normals as never);
    for (let v = 0; v < 8; v++)
      for (let k = 0; k < 3; k++) expect(out.positions[v * 3 + k]).toBeCloseTo(m.positions[v * 3 + k]! + along[v]![k]!, 5);
  });

  it("Displace CUSTOM_NORMAL on a mesh with no custom normals moves as NORMAL does (`vert_normals_true`)", () => {
    const m = cube();
    const a = textureDisplace(m, { strength: 1, midLevel: 0, direction: "customNormal" });
    const b = textureDisplace(m, { strength: 1, midLevel: 0, direction: "normal" });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });

  it("Weighted Normal with a vertex group: a corner outside it keeps the mesh's custom normal, stored per fan", () => {
    // Every face smooth, custom normals that disagree inside the fans; vertex 0 outside the group. Its corners keep their
    // own normals — laying them down splits the fans with sharp edges — where the fan's mean would come from before C29d.
    const m: MeshData = { ...cube(), sharpFaces: undefined };
    const normals = tagged(m);
    m.groups = new Map([["g", new Map([1, 2, 3, 4, 5, 6, 7].map((v) => [v, 1] as [number, number]))]]);
    const out = weightedNormal({ ...m, normals }, { vertexGroup: "g" });
    out.polys.forEach((p, f) => p.forEach((v, i) => v === 0 && expect(angle(out.normals![f]![i]!, normals[f]![i]!)).toBeLessThan(2e-4)));
    expect(out.sharp && out.sharp.size).toBeGreaterThan(0);
  });
});

describe("edit-mode vertex moves and transforms (compat-backlog C29e)", () => {
  it("an operator built on another (offsetFaces → moveFaces) encodes once: the normals come back as normals", () => {
    const m = cube();
    const data = { ...m, normals: tagged(m) };
    const em = meshFromData(data);
    // Pushed out, then slid sideways (a shear of the sides — 0.285 rad of turn, well over the tolerance).
    offsetFaces(em, new Set([1]), 0.3);
    moveFaces(em, new Set([1]), 0.3, 0, 0);
    // The input's pairs read in the moved shape — what one encode / decode gives.
    const want = withMovedPositions(data, em.positions).normals!;
    em.loopNormals!.forEach((face, f) => face.forEach((n, i) => expect(angle(n, want[f]![i]!)).toBeLessThan(2e-4)));
    expect(em.loopNormalsArePairs).toBeUndefined();
  });

  it("transformMesh with a non-uniform scale reads the stored pairs in the scaled shape — not the inverse transpose", () => {
    const m = cube();
    const data = { ...m, normals: tagged(m) };
    const out = transformMesh(data, { scale: [2, 0.5, 1] });
    const want = withMovedPositions(data, out.positions).normals!;
    out.normals!.forEach((face, f) => face.forEach((n, i) => expect(angle(n, want[f]![i]!)).toBeLessThan(1e-6)));
  });

  it("transformMesh with a rotation and one scale turns the vectors exactly and adds no sharp edge", () => {
    const m = cube();
    const data = { ...m, normals: tagged(m) };
    const out = transformMesh(data, { rotate: [0, 0, Math.PI / 2], scale: [2, 2, 2] });
    expect(out.sharp).toBeUndefined();
    out.normals!.forEach((face, f) =>
      face.forEach((n, i) => {
        const was = data.normals[f]![i]!;
        expect(angle(n, [-was[1]!, was[0]!, was[2]!])).toBeLessThan(1e-6);
      }),
    );
  });
});

