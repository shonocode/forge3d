/**
 * `insetRegion` against numbers read off `bmesh.ops.inset_region` in Blender
 * 5.1.1, so a regression shows up without Blender installed.
 *
 * The parity harness (`--op inset`, `inset-even`, `inset-boundary`,
 * `inset-no-boundary`) is the wider check; this is the part of it that runs in
 * CI.
 */
import { describe, it, expect } from "vitest";
import { meshFromData, meshToData } from "../../lib/mesh";
import { insetRegion } from "./operators";

/** Cube spanning -1..1, quads, every face wound outward. */
function cube() {
  return {
    positions: new Float32Array([
      -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
      -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
    ]),
    polys: [
      [0, 3, 2, 1], // -z
      [4, 5, 6, 7], // +z
      [0, 1, 5, 4], // -y
      [2, 3, 7, 6], // +y  <- face 3, the one inset below
      [0, 4, 7, 3], // -x
      [1, 2, 6, 5], // +x
    ],
  };
}

/** Two quads side by side in the y=0 plane, sharing the edge at x=1. */
function twoQuads() {
  return {
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 2, 0, 0,
      0, 0, 1, 1, 0, 1, 2, 0, 1,
    ]),
    polys: [
      [0, 1, 4, 3],
      [1, 2, 5, 4],
    ],
  };
}

const axis = (m: { positions: Float32Array }, k: 0 | 1 | 2): number[] => {
  const out = new Set<number>();
  for (let i = k; i < m.positions.length; i += 3) out.add(Math.round(m.positions[i]! * 1e4) / 1e4);
  return [...out].sort((a, b) => a - b);
};

describe("insetRegion", () => {
  it("matches Blender's topology on a cube's face", () => {
    // Measured: 8 verts / 6 faces becomes 12 / 10. The border vertices stay
    // (the side faces still need them), a ring of 4 appears inside, and 4 quads
    // bridge the two.
    const em = meshFromData(cube());
    const caps = insetRegion(em, new Set([3]), { thickness: 0.2 });
    const out = meshToData(em);

    expect(out.positions).toHaveLength(36);
    expect(out.polys).toHaveLength(10);
    expect(caps.size).toBe(1);
  });

  it("offsets along the bisector by default, not perpendicular", () => {
    // Measured: x values -1, -0.8586, 0.8586, 1. A perpendicular 0.2 would put
    // the ring at 0.8; the bisector puts it at 1 - 0.2/sqrt(2) = 0.8586.
    const em = meshFromData(cube());
    insetRegion(em, new Set([3]), { thickness: 0.2 });
    const out = meshToData(em);
    const xs = axis(out, 0);
    expect(xs).toHaveLength(4);
    expect(xs[1]).toBeCloseTo(-0.8586, 4);
    expect(xs[2]).toBeCloseTo(0.8586, 4);
  });

  it("useEvenOffset measures perpendicular to each edge", () => {
    // Measured: x values -1, -0.8, 0.8, 1 — exactly `thickness` from each edge.
    const em = meshFromData(cube());
    insetRegion(em, new Set([3]), { thickness: 0.2, useEvenOffset: true });
    const xs = axis(meshToData(em), 0);
    expect(xs[1]).toBeCloseTo(-0.8, 4);
    expect(xs[2]).toBeCloseTo(0.8, 4);
  });

  it("keeps the edge two selected faces share — this is the point of region mode", () => {
    // Individual mode would give each quad its own ring and its own cap, so the
    // shared edge at x=1 would be inset from both sides and the two would come
    // back as separate insets with a seam between them.
    const em = meshFromData(twoQuads());
    insetRegion(em, new Set([0, 1]), { thickness: 0.2, useBoundary: true });
    const out = meshToData(em);

    // 6 border verts duplicated, 2 caps + 6 skirts.
    expect(out.positions).toHaveLength(36);
    expect(out.polys).toHaveLength(8);
    // The shared edge is still there, at full length.
    const xs = axis(out, 0);
    expect(xs).toContain(1);
  });

  it("does nothing when the border is the mesh boundary and useBoundary is off", () => {
    // Blender's operator defaults to use_boundary=false, which is the opposite
    // of the Inset tool in the UI. Measured: an open grid comes back untouched.
    const em = meshFromData(twoQuads());
    const caps = insetRegion(em, new Set([0, 1]), { thickness: 0.2 });
    const out = meshToData(em);
    expect(out.positions).toHaveLength(18);
    expect(out.polys).toHaveLength(2);
    expect(caps.size).toBe(2);
  });

  it("depth moves the whole region, interior vertices included", () => {
    // Measured on a 2x2 grid: the middle vertex travels with the rest.
    const em = meshFromData(cube());
    insetRegion(em, new Set([3]), { thickness: 0.2, depth: 0.3 });
    const ys = axis(meshToData(em), 1);
    expect(ys).toContain(1.3);
  });

  it("depth still moves a border that was not inset", () => {
    // `use_boundary` off on an open sheet: nothing is inset, but every vertex
    // of the region travels by `depth` along its vertex normal (-y here) —
    // parity row `inset-depth-no-boundary`, which forge3d failed 0/2 by
    // leaving border vertices behind.
    const em = meshFromData(twoQuads());
    insetRegion(em, new Set([0, 1]), { thickness: 0.2, depth: 0.3 });
    const out = meshToData(em);
    expect(out.positions).toHaveLength(18);
    expect(axis(out, 1)).toEqual([-0.3]);
  });

  it("returns the re-pointed region faces so insets chain", () => {
    const em = meshFromData(cube());
    const first = insetRegion(em, new Set([3]), { thickness: 0.2 });
    const second = insetRegion(em, first, { thickness: 0.2 });
    expect(second.size).toBe(1);
    const xs = axis(meshToData(em), 0);
    // Two rings inside the original border.
    expect(xs).toHaveLength(6);
  });

  it("refuses the flags it does not implement instead of insetting differently", () => {
    const em = meshFromData(cube());
    expect(() => insetRegion(em, new Set([3]), { thickness: 0.2, useRelativeOffset: true })).toThrow(
      /useRelativeOffset/,
    );
    expect(() => insetRegion(em, new Set([3]), { thickness: 0.2, useOutset: true })).toThrow(
      /useOutset/,
    );
  });

  it("is a no-op for an empty selection", () => {
    const em = meshFromData(cube());
    expect(insetRegion(em, new Set(), { thickness: 0.2 }).size).toBe(0);
    expect(meshToData(em).polys).toHaveLength(6);
  });
});
