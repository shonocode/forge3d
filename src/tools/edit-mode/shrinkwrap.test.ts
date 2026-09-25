import { describe, it, expect } from "vitest";
import type { MeshData } from "../../lib/mesh";
import { shrinkwrap } from "./shrinkwrap";

/**
 * `shrinkwrap`, against Blender 5.1.1.
 *
 * Every number is measured — `probe-shrinkwrap.py` and
 * `probe-shrinkwrap2.py`. The second exists because a single flat quad makes
 * four different questions unanswerable: it has no inside, so three of the
 * four wrap modes had nothing to correct; it is one face, so the flat and
 * interpolated normals are the same vector; and a ray through it meets it
 * once, so "which of the two hits" could not come up.
 *
 * The one case that did the most work is the source vertex that lands on the
 * quad's **rim**. Every vertex sitting squarely above a face agrees with both
 * readings of the offset direction; only the rim separates "back the way it
 * came" from "along the target's normal".
 *
 * `ABOVE_SURFACE` fitted every shape these probes use and then disagreed with
 * Blender on all 36 vertices of `arm` when the parity row gave it a non-cubic
 * box — the shapes here make its normal interpolation degenerate, so they
 * cannot tell the candidate readings apart. It was left out until 2026-09-25,
 * when `shrinkwrap.cc` settled it (corner-angle vertex normals, the
 * (0,1,2)(0,2,3) split); its test below uses the probe's own number.
 */

/** The target from the first probe: one quad in the z = 0 plane, ±0.5. */
function quad(): MeshData {
  return {
    positions: Float32Array.from([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]),
    polys: [[0, 1, 2, 3]],
  };
}

/** A quad in the plane z = 0.3x, so its normal is not an axis. */
function tiltedQuad(): MeshData {
  const pts: [number, number][] = [
    [-0.6, -0.6],
    [0.6, -0.6],
    [0.6, 0.6],
    [-0.6, 0.6],
  ];
  const positions: number[] = [];
  for (const [x, y] of pts) positions.push(x, y, 0.3 * x);
  return { positions: Float32Array.from(positions), polys: [[0, 1, 2, 3]] };
}

/** A closed box, half-extent 0.5 — the target that has an inside. */
function box(): MeshData {
  return {
    positions: Float32Array.from([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5,
      -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]),
    polys: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ],
  };
}

/** A source of isolated points, one triangle each — as the probes built it. */
function points(coords: readonly [number, number, number][]): MeshData {
  const positions: number[] = [];
  const polys: number[][] = [];
  for (const [x, y, z] of coords) {
    const i = positions.length / 3;
    positions.push(x, y, z, x + 1e-4, y, z, x, y + 1e-4, z);
    polys.push([i, i + 1, i + 2]);
  }
  return { positions: Float32Array.from(positions), polys };
}

/** The first vertex of each of those triangles — the point that was asked about. */
function firsts(data: MeshData, n: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++)
    out.push([data.positions[i * 9]!, data.positions[i * 9 + 1]!, data.positions[i * 9 + 2]!]);
  return out;
}

function expectPoint(got: readonly number[], want: readonly number[], why?: string): void {
  for (let i = 0; i < 3; i++) expect(got[i]!, `${why ?? ""} axis ${i}`).toBeCloseTo(want[i]!, 5);
}

/** The first probe's source: a 3×3 grid at z = 0.4, slid so a column hangs off. */
function slidGrid(z = 0.4): MeshData {
  const positions: number[] = [];
  for (let j = 0; j <= 2; j++)
    for (let i = 0; i <= 2; i++) positions.push(0.4 * (i / 2 - 0.5) + 0.45, 0.4 * (j / 2 - 0.5), z);
  const polys: number[][] = [];
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const a = j * 3 + i;
      polys.push([a, a + 1, a + 4, a + 3]);
    }
  return { positions: Float32Array.from(positions), polys };
}

function vertex(data: MeshData, v: number): number[] {
  return [data.positions[v * 3]!, data.positions[v * 3 + 1]!, data.positions[v * 3 + 2]!];
}

/** The four probe points of the second run: outside far, outside near, inside, on. */
const PROBES: [number, number, number][] = [
  [0.2, 0.1, 0.9],
  [0.2, 0.1, 0.55],
  [0.2, 0.1, 0.1],
  [0.2, 0.1, 0.5],
];

describe("shrinkwrap", () => {
  it("moves each vertex to the closest point on the target surface", () => {
    // Blender, all nine vertices. The first two columns drop straight down;
    // the third is past the quad's edge at x = 0.5 and lands **on the rim**,
    // which is what says "closest point on the surface".
    const out = shrinkwrap(slidGrid(), { target: quad() });
    expectPoint(vertex(out, 0), [0.25, -0.2, 0], "vertex 0");
    expectPoint(vertex(out, 1), [0.45, -0.2, 0], "vertex 1");
    expectPoint(vertex(out, 2), [0.5, -0.2, 0], "vertex 2, past the rim");
    expectPoint(vertex(out, 5), [0.5, 0, 0], "vertex 5");
    expectPoint(vertex(out, 8), [0.5, 0.2, 0], "vertex 8");
  });

  it("moves each vertex to the closest target vertex", () => {
    // Measured: the bottom row goes to the quad's (0.5, -0.5) corner. The
    // middle row at y = 0 is **exactly equidistant** from two corners, and
    // Blender's answer there comes out of its BVH order — this implementation
    // takes the lowest index and says so, so the middle row is asserted only
    // as "one of the two", and the rows either side carry the rule.
    const out = shrinkwrap(slidGrid(), { target: quad(), method: "nearestVertex" });
    expectPoint(vertex(out, 0), [0.5, -0.5, 0], "vertex 0");
    expectPoint(vertex(out, 2), [0.5, -0.5, 0], "vertex 2");
    expectPoint(vertex(out, 6), [0.5, 0.5, 0], "vertex 6");
    expectPoint(vertex(out, 8), [0.5, 0.5, 0], "vertex 8");
    const tied = vertex(out, 3);
    expect(Math.abs(tied[1]!), "the tied row lands on one of the two corners").toBeCloseTo(0.5, 5);
  });

  it("offsets back the way the vertex came, not along the target normal", () => {
    // **The rim vertex is the whole test.** Blender gives
    // (0.53511, -0.2, 0.09363), which is hit + 0.1 * normalize(original -
    // hit). Along the target's normal it would be (0.5, -0.2, 0.1).
    const out = shrinkwrap(slidGrid(), { target: quad(), offset: 0.1 });
    expectPoint(vertex(out, 0), [0.25, -0.2, 0.1], "over the face");
    expectPoint(vertex(out, 2), [0.53511, -0.2, 0.09363], "on the rim");
    const back = shrinkwrap(slidGrid(), { target: quad(), offset: -0.1 });
    expectPoint(vertex(back, 0), [0.25, -0.2, -0.1], "negative, over the face");
    expectPoint(vertex(back, 2), [0.46489, -0.2, -0.09363], "negative, on the rim");
  });

  it("offsets to the side the vertex was on", () => {
    // Measured with the same grid moved below the target: the same positive
    // offset now comes out negative in z. So it is "away from the surface on
    // my side", not "up".
    const out = shrinkwrap(slidGrid(-0.4), { target: quad(), offset: 0.1 });
    expectPoint(vertex(out, 0), [0.25, -0.2, -0.1], "over the face");
    expectPoint(vertex(out, 2), [0.53511, -0.2, -0.09363], "on the rim");
  });

  it("leaves a vertex already on the surface where it is", () => {
    // Measured: `original - hit` is the zero vector there, and Blender applies
    // no offset rather than falling back to a normal. The fourth probe point
    // sits exactly on the box's +z face.
    const out = shrinkwrap(points(PROBES), { target: box(), offset: 0.1 });
    expectPoint(firsts(out, 4)[3]!, [0.2, 0.1, 0.5], "exactly on the face");
  });

  it("aboveSurface offsets along the blended vertex normal (probe-shrinkwrap2.py)", () => {
    // Blender, box ±0.5, the point above it: the hit is (0.2, 0.1, 0.5) and the
    // offset runs along (0.3651, 0.1826, 0.9129) — the top face's corner
    // normals (±1, ±1, 1)/√3 blended by the hit's weights, not the flat +z.
    const out = firsts(
      shrinkwrap(points(PROBES), { target: box(), mode: "aboveSurface", offset: 0.1 }),
      4,
    );
    expectPoint(out[0]!, [0.23651, 0.11826, 0.59129], "above the top face");
  });

  it("offsets along the travel direction on a tilted quad too", () => {
    // The tilted quad's unit normal is (-0.28735, 0, 0.95783), so a point past
    // its rim separates "back the way I came" from "along the normal" a second
    // time, on a target whose normal is not an axis.
    //
    // **`ABOVE_SURFACE` used to be asserted here and is no longer offered.**
    // It measured `(0.57127, 0, 0.27578)` for the same point — exactly
    // `hit + 0.1 * the quad's normal` — and that reading survived a box as
    // well, but the parity row disagreed on **all 36 vertices of `arm`** once
    // the target was a non-cubic box. See the note at the top of the
    // implementation: two unknowns, one measurement.
    const src = points([
      [0, 0, 0.5],
      [0.3, 0.2, 0.5],
      [0.9, 0, 0.5],
    ]);
    const on = shrinkwrap(src, { target: tiltedQuad(), offset: 0.1 });
    expectPoint(firsts(on, 3)[2]!, [0.66839, 0, 0.25295], "past the rim");
    // The foot of the first point lands inside the face, where the offset is
    // along the surface normal either way.
    expectPoint(firsts(on, 3)[0]!, [0.10888, 0, 0.13707], "inside the face");
  });

  it("clamps the signed distance for inside, outside and outsideSurface", () => {
    // Measured on the box at offset 0.1, four probe points each.
    const inside = firsts(
      shrinkwrap(points(PROBES), { target: box(), offset: 0.1, mode: "inside" }),
      4,
    );
    expectPoint(inside[0]!, [0.2, 0.1, 0.4], "inside: outside far is pulled in");
    expectPoint(inside[1]!, [0.2, 0.1, 0.4], "inside: outside near is pulled in");
    expectPoint(inside[2]!, [0.2, 0.1, 0.1], "inside: already 0.3 inside, kept");
    expectPoint(inside[3]!, [0.2, 0.1, 0.4], "inside: on the face is pushed in");

    const outside = firsts(
      shrinkwrap(points(PROBES), { target: box(), offset: 0.1, mode: "outside" }),
      4,
    );
    expectPoint(outside[0]!, [0.2, 0.1, 0.9], "outside: already 0.4 out, kept");
    expectPoint(outside[1]!, [0.2, 0.1, 0.6], "outside: 0.05 out is pushed to 0.1");
    expectPoint(outside[2]!, [0.6, 0.1, 0.1], "outside: inside is pushed out");
    expectPoint(outside[3]!, [0.2, 0.1, 0.6], "outside: on the face is pushed out");

    const surface = firsts(
      shrinkwrap(points(PROBES), { target: box(), offset: 0.1, mode: "outsideSurface" }),
      4,
    );
    expectPoint(surface[0]!, [0.2, 0.1, 0.6], "outsideSurface always snaps");
    expectPoint(surface[2]!, [0.6, 0.1, 0.1], "outsideSurface: inside comes out");
  });

  it("keeps what is already outside when the offset is zero", () => {
    // The row that separates `outside` from `outsideSurface` with no band at
    // all: `outside` keeps three of the four, `outsideSurface` snaps all four.
    const outside = firsts(
      shrinkwrap(points(PROBES), { target: box(), mode: "outside" }),
      4,
    );
    expectPoint(outside[0]!, [0.2, 0.1, 0.9], "kept");
    expectPoint(outside[1]!, [0.2, 0.1, 0.55], "kept");
    expectPoint(outside[2]!, [0.5, 0.1, 0.1], "snapped, it was inside");
    expectPoint(outside[3]!, [0.2, 0.1, 0.5], "kept, already on the surface");
    const surface = firsts(
      shrinkwrap(points(PROBES), { target: box(), mode: "outsideSurface" }),
      4,
    );
    expectPoint(surface[0]!, [0.2, 0.1, 0.5], "snapped");
    expectPoint(surface[1]!, [0.2, 0.1, 0.5], "snapped");
  });

  it("projects along one axis, in the direction asked for", () => {
    // Measured on the box. The negative-only ray from inside hits the far
    // face; the positive-only one from outside above misses entirely.
    const down = firsts(
      shrinkwrap(points(PROBES), {
        target: box(),
        method: "project",
        project: { axis: "z", negative: true, positive: false },
      }),
      4,
    );
    expectPoint(down[0]!, [0.2, 0.1, 0.5], "from above, downward");
    expectPoint(down[2]!, [0.2, 0.1, -0.5], "from inside, downward");

    const up = firsts(
      shrinkwrap(points(PROBES), {
        target: box(),
        method: "project",
        project: { axis: "z", negative: false, positive: true },
      }),
      4,
    );
    expectPoint(up[0]!, [0.2, 0.1, 0.9], "from above, upward: misses, stays");
    expectPoint(up[1]!, [0.2, 0.1, 0.55], "from just above, upward: misses, stays");
    expectPoint(up[2]!, [0.2, 0.1, 0.5], "from inside, upward");
  });

  it("casts one diagonal ray when several axes are on", () => {
    // `proj_axis` in shrinkwrap.cc: X and Z summed and normalised. The probe
    // point above the box moves (-0.4, 0, -0.4) — the measurement that was
    // once refused as "not a composition of the single-axis answers".
    const out = firsts(
      shrinkwrap(points(PROBES), {
        target: box(),
        method: "project",
        project: { axis: ["x", "z"], negative: true, positive: true },
      }),
      4,
    );
    expectPoint(out[0]!, [-0.2, 0.1, 0.5], "down the negative diagonal");
  });

  it("takes the nearer hit when both directions are on", () => {
    // The point inside the box is 0.4 from the +z face and 0.6 from the -z
    // one, and comes back on the near side.
    const both = firsts(
      shrinkwrap(points(PROBES), {
        target: box(),
        method: "project",
        project: { axis: "z", negative: true, positive: true },
      }),
      4,
    );
    expectPoint(both[2]!, [0.2, 0.1, 0.5], "the nearer of the two");
  });

  it("reads limit as the longest ray, with 0 meaning unlimited", () => {
    // At 0.2 the vertices 0.4 from the surface find nothing; at 0.45 they do.
    const tight = firsts(
      shrinkwrap(points(PROBES), {
        target: box(),
        method: "project",
        project: { axis: "z", negative: true, positive: true, limit: 0.2 },
      }),
      4,
    );
    expectPoint(tight[0]!, [0.2, 0.1, 0.9], "too far, stays");
    expectPoint(tight[1]!, [0.2, 0.1, 0.5], "0.05 away, hits");
    expectPoint(tight[2]!, [0.2, 0.1, 0.1], "0.4 away, stays");

    const loose = firsts(
      shrinkwrap(points(PROBES), {
        target: box(),
        method: "project",
        project: { axis: "z", negative: true, positive: true, limit: 0.45 },
      }),
      4,
    );
    expectPoint(loose[0]!, [0.2, 0.1, 0.5], "0.4 away, now hits");
    expectPoint(loose[2]!, [0.2, 0.1, 0.5], "0.4 away, now hits");
  });

  it("projects along the vertex normal when no axis is named", () => {
    // Blender's "no axis selected". The probe grid's normals are ±z, so it
    // lands where the z projection does — which is how the measurement was
    // read, and the default here.
    const out = shrinkwrap(slidGrid(), {
      target: quad(),
      method: "project",
      project: { negative: true, positive: true },
    });
    expectPoint(vertex(out, 0), [0.25, -0.2, 0], "over the face");
    expectPoint(vertex(out, 2), [0.65, -0.2, 0.4], "past the rim: misses, stays");
  });

  it("only moves the vertices it is given", () => {
    const out = shrinkwrap(slidGrid(), { target: quad(), verts: new Set([0]) });
    expectPoint(vertex(out, 0), [0.25, -0.2, 0], "asked for");
    expectPoint(vertex(out, 1), [0.45, -0.2, 0.4], "not asked for");
  });

  it("changes no face and refuses a target with none", () => {
    const before = slidGrid();
    const out = shrinkwrap(before, { target: quad() });
    expect(out.polys).toEqual(before.polys);
    expect(() =>
      shrinkwrap(before, { target: { positions: Float32Array.from([0, 0, 0]), polys: [] } }),
    ).toThrow(/no faces/);
  });
});
