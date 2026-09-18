import { describe, it, expect } from "vitest";
import { box, plane, cylinder, sphere, circle, circleProfile, torus, revolve, sweep } from "./generate";
import { meshFromData, type MeshData } from "../lib/mesh";
import { facePolyNormal } from "./edit-mode/half-edge";

/**
 * Signed volume via the divergence theorem. Positive means the polygons are
 * wound CCW seen from outside, which is the contract every generator here
 * promises and the thing a renderer will silently punish you for getting
 * wrong.
 */
function signedVolume(m: MeshData): number {
  const p = (i: number): [number, number, number] => [
    m.positions[i * 3]!,
    m.positions[i * 3 + 1]!,
    m.positions[i * 3 + 2]!,
  ];
  let vol = 0;
  for (const poly of m.polys)
    for (let k = 1; k < poly.length - 1; k++) {
      const a = p(poly[0]!);
      const b = p(poly[k]!);
      const c = p(poly[k + 1]!);
      vol +=
        a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
  return vol / 6;
}

const vertCount = (m: MeshData): number => m.positions.length / 3;
const vert = (m: MeshData, i: number): [number, number, number] => [
  m.positions[i * 3]!,
  m.positions[i * 3 + 1]!,
  m.positions[i * 3 + 2]!,
];

describe("box", () => {
  it("is a welded cube: 8 verts, 6 quads", () => {
    const m = box({ size: [2, 2, 2] });
    expect(vertCount(m)).toBe(8);
    expect(m.polys).toHaveLength(6);
    expect(m.polys.every((p) => p.length === 4)).toBe(true);
  });

  it("encloses its stated volume, wound outward", () => {
    expect(signedVolume(box({ size: [2, 3, 4] }))).toBeCloseTo(24, 5);
  });

  it("stays closed and correctly wound when segmented", () => {
    const m = box({ size: [2, 2, 2], segments: [2, 3, 4] });
    // Surface lattice only — no interior verts.
    expect(m.polys).toHaveLength(2 * (2 * 3 + 3 * 4 + 4 * 2));
    expect(signedVolume(m)).toBeCloseTo(8, 4);
  });

  it("pivot 'base' sits the box on y = 0", () => {
    const m = box({ size: [1, 4, 1], pivot: "base" });
    let minY = Infinity;
    for (let i = 0; i < vertCount(m); i++) minY = Math.min(minY, vert(m, i)[1]);
    expect(minY).toBeCloseTo(0, 6);
  });

  it("places the box at `at`", () => {
    const m = box({ size: [1, 1, 1], at: [5, 6, 7] });
    let sum = 0;
    for (let i = 0; i < vertCount(m); i++) sum += vert(m, i)[0];
    expect(sum / vertCount(m)).toBeCloseTo(5, 6);
  });
});

describe("plane", () => {
  it("is one quad by default", () => {
    const m = plane();
    expect(m.polys).toHaveLength(1);
    expect(vertCount(m)).toBe(4);
  });

  it("subdivides into a grid", () => {
    const m = plane({ segments: [3, 2] });
    expect(m.polys).toHaveLength(6);
    expect(vertCount(m)).toBe(4 * 3);
  });

  it("faces the requested way", () => {
    // Cross two edges of the single quad and check the normal's sign.
    for (const [facing, axis, sign] of [
      ["+y", 1, 1],
      ["-y", 1, -1],
      ["+z", 2, 1],
      ["-x", 0, -1],
    ] as const) {
      const m = plane({ facing });
      const [a, b, c] = [vert(m, m.polys[0]![0]!), vert(m, m.polys[0]![1]!), vert(m, m.polys[0]![2]!)];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ];
      expect(Math.sign(n[axis]!)).toBe(sign);
    }
  });
});

describe("cylinder", () => {
  it("caps both ends with an n-gon", () => {
    const m = cylinder({ uSegments: 8 });
    expect(vertCount(m)).toBe(16);
    expect(m.polys.filter((p) => p.length === 8)).toHaveLength(2);
    expect(m.polys.filter((p) => p.length === 4)).toHaveLength(8);
  });

  it("approaches πr²h as the radial count rises", () => {
    const v = signedVolume(cylinder({ radius1: 1, depth: 2, uSegments: 256 }));
    expect(v).toBeCloseTo(Math.PI * 2, 2);
    expect(v).toBeGreaterThan(0);
  });

  it("welds a zero top radius into a single apex", () => {
    const m = cylinder({ radius1: 1, radius2: 0, depth: 1, uSegments: 8 });
    expect(vertCount(m)).toBe(9); // 8 around the base + 1 apex
    expect(m.polys.filter((p) => p.length === 3)).toHaveLength(8);
  });

  it("omits caps on request", () => {
    const m = cylinder({ uSegments: 6, caps: "none" });
    expect(m.polys.every((p) => p.length === 4)).toBe(true);
  });
});

describe("sphere", () => {
  it("collapses the pole quads into triangles", () => {
    const m = sphere({ uSegments: 8, vSegments: 4 });
    expect(m.polys.filter((p) => p.length === 3)).toHaveLength(16); // 8 per pole
    expect(vertCount(m)).toBe(8 * 3 + 2);
  });

  it("approaches 4/3 πr³, wound outward", () => {
    const v = signedVolume(sphere({ radius: 1, uSegments: 128, vSegments: 64 }));
    expect(v).toBeCloseTo((4 / 3) * Math.PI, 2);
  });
});

describe("revolve", () => {
  it("reproduces a cylinder from its half-section", () => {
    const m = revolve({
      profile: [
        [0, 0],
        [1, 0],
        [1, 2],
        [0, 2],
      ],
      steps: 256,
    });
    expect(signedVolume(m)).toBeCloseTo(Math.PI * 2, 2);
  });

  it("leaves a partial revolve open", () => {
    const full = revolve({ profile: [[1, 0], [1, 1]], steps: 8 });
    const half = revolve({ profile: [[1, 0], [1, 1]], steps: 8, angle: Math.PI });
    expect(full.polys).toHaveLength(8);
    expect(half.polys).toHaveLength(8);
    expect(vertCount(half)).toBe(18); // 9 rings, not wrapped
  });

  /**
   * Every case above draws its half-section bottom-to-top, which is how one is
   * usually drawn and why this went unnoticed through two rooms. A recessed
   * downlight is drawn the other way — from the ceiling down into the can —
   * and produced an inside-out shell. Babylon hid it, because it shades from
   * the normals and those had already been flipped outward elsewhere; it
   * surfaced the first time the asset met a renderer that uses the geometric
   * normal.
   */
  it("winds outward whichever way the profile runs", () => {
    const up = revolve({
      profile: [[0, 0], [0.075, 0], [0.075, 0.05], [0.058, 0.05]],
      steps: 16,
    });
    const down = revolve({
      profile: [[0.075, 0], [0.075, -0.01], [0.058, -0.01], [0.058, -0.05], [0, -0.05]],
      steps: 16,
    });
    expect(signedVolume(up)).toBeGreaterThan(0);
    expect(signedVolume(down)).toBeGreaterThan(0);
  });

  it("gives a descending profile the same volume as its mirror", () => {
    // Closed both times: signed volume only means anything for a closed
    // surface, and the first attempt at this test compared two open shells and
    // failed for that reason rather than for the one it was written to catch.
    const up = revolve({ profile: [[0, 0], [1, 0], [1, 2], [0, 2]], steps: 128 });
    const down = revolve({ profile: [[0, 0], [1, 0], [1, -2], [0, -2]], steps: 128 });
    expect(signedVolume(up)).toBeCloseTo(Math.PI * 2, 2);
    expect(signedVolume(down)).toBeCloseTo(Math.PI * 2, 2);
  });
});

describe("sweep", () => {
  /** 60mm out from the wall, 100mm tall — a plain skirting section. */
  const TRIM = [
    [0, 0],
    [0.06, 0],
    [0.06, 0.1],
    [0, 0.1],
  ] as const;

  it("mitres a 90° corner so the section keeps its true width", () => {
    // Square path in XZ. Verts are emitted ring by ring in path order, so the
    // outer-bottom vertex of the corner ring is at index 1*4 + 1.
    const m = sweep({
      profile: TRIM,
      path: [
        [0, 0, 0],
        [2, 0, 0],
        [2, 0, 2],
        [0, 0, 2],
      ],
      closedPath: true,
    });
    const corner = vert(m, 1 * TRIM.length + 1);

    // Perpendicular distance to each of the two runs meeting here must still
    // be the profile's 60mm. A sweep without mitre compensation gives 42mm.
    expect(corner[2]).toBeCloseTo(0.06, 6); // from the run along X
    expect(2 - corner[0]).toBeCloseTo(0.06, 6); // from the run along Z
  });

  it("keeps a straight run exactly the profile's width", () => {
    const m = sweep({ profile: TRIM, path: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] });
    expect(vert(m, 1 * TRIM.length + 1)[2]).toBeCloseTo(0.06, 6);
  });

  it("closes the loop without caps and caps an open run", () => {
    const closed = sweep({
      profile: TRIM,
      path: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
      closedPath: true,
    });
    expect(closed.polys).toHaveLength(4 * TRIM.length); // 4 spans, no caps

    const open = sweep({ profile: TRIM, path: [[0, 0, 0], [1, 0, 0]] });
    expect(open.polys).toHaveLength(1 * TRIM.length + 2);
  });

  it("winds outward for a profile drawn counterclockwise in (side, up)", () => {
    // A capped straight run is a closed solid, so its signed volume is the
    // section area times the length — and positive only if the normals face
    // out. This is the check that caught the round generators being inside
    // out, and sweep was wrong the same way.
    const m = sweep({ profile: TRIM, path: [[0, 0, 0], [2, 0, 0]] });
    expect(signedVolume(m)).toBeCloseTo(0.06 * 0.1 * 2, 6);
  });

  it("winds outward around a closed loop too", () => {
    // A square ring of trim: outer 2m box minus the inner hole, 100mm tall.
    const m = sweep({
      profile: TRIM,
      path: [
        [0, 0, 0],
        [2, 0, 0],
        [2, 0, 2],
        [0, 0, 2],
      ],
      closedPath: true,
    });
    // Not perimeter x section: the mitre makes the ring a square annulus, so
    // the corners are counted once rather than twice. The path square is 2m
    // and the trim sits 60mm inside it, leaving a 1.88m hole — which is only
    // true because the corners are properly mitred.
    expect(signedVolume(m)).toBeCloseTo((2 * 2 - 1.88 * 1.88) * 0.1, 5);
  });

  it("returns an empty mesh for a degenerate path", () => {
    expect(sweep({ profile: TRIM, path: [[0, 0, 0]] }).polys).toHaveLength(0);
  });

  it("survives a vertical run, where the side vector is undefined", () => {
    const m = sweep({ profile: TRIM, path: [[0, 0, 0], [0, 1, 0]] });
    expect(m.polys.length).toBeGreaterThan(0);
    for (let i = 0; i < vertCount(m); i++) expect(Number.isFinite(vert(m, i)[0])).toBe(true);
  });
});

describe("circle", () => {
  it("test_lies_flat_and_faces_up", () => {
    const m = circle({ radius: 0.2, segments: 8 });
    expect(m.positions.length / 3).toBe(8);
    expect(m.polys).toHaveLength(1);
    for (let v = 0; v < 8; v++) {
      expect(m.positions[v * 3 + 1]).toBeCloseTo(0, 6);
      expect(Math.hypot(m.positions[v * 3]!, m.positions[v * 3 + 2]!)).toBeCloseTo(0.2, 6);
    }
    // Wound so the disc's normal is +y, the way `plane`'s default is.
    const em = meshFromData(m);
    expect(facePolyNormal(em, 0)[1]).toBeGreaterThan(0);
  });

  it("test_no_cap_keeps_the_ring_without_claiming_a_surface", () => {
    const m = circle({ segments: 6, caps: "none" });
    expect(m.positions.length / 3).toBe(6);
    expect(m.polys).toHaveLength(0);
  });

  it("test_circleProfile_is_the_same_ring_in_2d", () => {
    const ring = circleProfile(0.2, 8);
    expect(ring).toHaveLength(8);
    for (const [x, y] of ring) expect(Math.hypot(x, y)).toBeCloseTo(0.2, 6);
  });
});

describe("torus", () => {
  it("test_is_a_closed_quad_surface_of_the_stated_size", () => {
    const m = torus({ majorRadius: 0.2, minorRadius: 0.05, majorSegments: 8, minorSegments: 6 });
    expect(m.positions.length / 3).toBe(48);
    expect(m.polys).toHaveLength(48);
    for (const poly of m.polys) expect(poly).toHaveLength(4);

    // Every vertex sits `minor` from the ring of radius `major`.
    for (let v = 0; v < 48; v++) {
      const x = m.positions[v * 3]!, y = m.positions[v * 3 + 1]!, z = m.positions[v * 3 + 2]!;
      const fromAxis = Math.hypot(x, z) - 0.2;
      expect(Math.hypot(fromAxis, y)).toBeCloseTo(0.05, 5);
    }
  });

  it("test_is_wound_outward", () => {
    // The first version was inside out and measured 0.0000mm against Blender
    // all the same — a surface distance cannot see winding, only the signed
    // volume can.
    const m = torus({ majorRadius: 0.2, minorRadius: 0.05, majorSegments: 12, minorSegments: 8 });
    expect(signedVolume(m)).toBeGreaterThan(0);
  });

  it("test_the_axis_turns_it", () => {
    const flat = torus({ majorRadius: 0.2, minorRadius: 0.05, axis: "y" });
    const upright = torus({ majorRadius: 0.2, minorRadius: 0.05, axis: "z" });
    const spread = (m: { positions: Float32Array }, k: number): number => {
      let min = Infinity, max = -Infinity;
      for (let v = 0; v < m.positions.length / 3; v++) {
        min = Math.min(min, m.positions[v * 3 + k]!);
        max = Math.max(max, m.positions[v * 3 + k]!);
      }
      return max - min;
    };
    // Lying flat, the thin direction is y; stood on its edge, it is z.
    expect(spread(flat, 1)).toBeCloseTo(0.1, 5);
    expect(spread(upright, 2)).toBeCloseTo(0.1, 5);
  });
});
