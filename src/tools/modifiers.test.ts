import { describe, it, expect } from "vitest";
import { subdivide, mirror, arrayRepeat } from "./modifiers";
import type { OriginalGeometry } from "../state";

/** Unit right-triangle pair (a quad) in the z=0 plane with a simple UV map. */
function makeQuad(): OriginalGeometry {
  return {
    positions: new Float32Array([
      0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
    ]),
    normals: null,
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: [0, 1, 2, 0, 2, 3],
  };
}

describe("subdivide (modifier)", () => {
  it("splits each tri into 4 and interpolates midpoint UVs", () => {
    const out = subdivide(makeQuad(), 1);
    expect(out.indices.length).toBe(6 * 4); // 2 tris → 8 tris
    // 4 original + 5 unique edge midpoints (shared diagonal counted once).
    expect(out.positions.length / 3).toBe(9);
    expect(out.uvs).not.toBeNull();
    expect(out.uvs!.length / 2).toBe(9);
    // Original verts keep their UVs verbatim.
    for (let v = 0; v < 4; v++) {
      expect(out.uvs![v * 2]).toBe(makeQuad().uvs![v * 2]);
      expect(out.uvs![v * 2 + 1]).toBe(makeQuad().uvs![v * 2 + 1]);
    }
    // Every midpoint UV is the average of some original pair — spot check:
    // midpoint of edge 0-1 (positions (0.5,0,0)) must carry UV (0.5, 0).
    let found = false;
    for (let v = 4; v < 9; v++) {
      if (out.positions[v * 3] === 0.5 && out.positions[v * 3 + 1] === 0 && out.positions[v * 3 + 2] === 0) {
        expect(out.uvs![v * 2]).toBeCloseTo(0.5, 6);
        expect(out.uvs![v * 2 + 1]).toBeCloseTo(0, 6);
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it("UV interpolation matches position interpolation on every new vert (planar map)", () => {
    // With the identity-like planar map (u=x, v=y), every subdivided vert must
    // satisfy uv == (x, y) exactly — catches any pairing/order bug.
    const out = subdivide(makeQuad(), 2);
    const n = out.positions.length / 3;
    expect(out.uvs!.length / 2).toBe(n);
    for (let v = 0; v < n; v++) {
      expect(out.uvs![v * 2]).toBeCloseTo(out.positions[v * 3]!, 6);
      expect(out.uvs![v * 2 + 1]).toBeCloseTo(out.positions[v * 3 + 1]!, 6);
    }
  });

  it("passes through null UVs (meshes without a UV map)", () => {
    const geo = makeQuad();
    geo.uvs = null;
    const out = subdivide(geo, 1);
    expect(out.uvs).toBeNull();
    expect(out.positions.length / 3).toBe(9);
  });
});

describe("mirror (modifier)", () => {
  it("mirrored copies keep their source vert's UV", () => {
    const out = mirror(makeQuad(), "x", false, 0.001);
    expect(out.positions.length / 3).toBe(8);
    expect(out.uvs!.length / 2).toBe(8);
    for (let v = 0; v < 4; v++) {
      // Position mirrored on x…
      expect(out.positions[(v + 4) * 3]).toBe(-out.positions[v * 3]!);
      // …UV identical.
      expect(out.uvs![(v + 4) * 2]).toBe(out.uvs![v * 2]);
      expect(out.uvs![(v + 4) * 2 + 1]).toBe(out.uvs![v * 2 + 1]);
    }
  });

  it("merge keeps the UV buffer aligned (indices remapped, buffers untouched)", () => {
    const out = mirror(makeQuad(), "x", true, 0.001);
    // Verts 0 and 3 sit on the mirror plane → their copies remap onto them.
    // Buffers stay full-length; only indices change.
    expect(out.uvs!.length / 2).toBe(out.positions.length / 3);
    // No index references a vertex out of range.
    const n = out.positions.length / 3;
    for (const i of out.indices) expect(i).toBeLessThan(n);
  });

  it("passes through null UVs", () => {
    const geo = makeQuad();
    geo.uvs = null;
    expect(mirror(geo, "y", true, 0.001).uvs).toBeNull();
  });
});

describe("arrayRepeat (modifier)", () => {
  it("each copy repeats the source UVs verbatim", () => {
    const out = arrayRepeat(makeQuad(), 3, 2, 0, 0);
    expect(out.positions.length / 3).toBe(12);
    expect(out.uvs!.length / 2).toBe(12);
    for (let n = 1; n < 3; n++) {
      for (let v = 0; v < 4; v++) {
        expect(out.positions[(n * 4 + v) * 3]).toBeCloseTo(out.positions[v * 3]! + 2 * n, 6);
        expect(out.uvs![(n * 4 + v) * 2]).toBe(out.uvs![v * 2]);
        expect(out.uvs![(n * 4 + v) * 2 + 1]).toBe(out.uvs![v * 2 + 1]);
      }
    }
  });

  it("passes through null UVs", () => {
    const geo = makeQuad();
    geo.uvs = null;
    expect(arrayRepeat(geo, 2, 1, 0, 0).uvs).toBeNull();
  });
});

describe("modifier chain keeps UVs end-to-end", () => {
  it("subdivide → mirror → array preserves a full-length UV buffer", () => {
    let geo = subdivide(makeQuad(), 1);
    geo = mirror(geo, "x", true, 0.001);
    geo = arrayRepeat(geo, 2, 0, 0, 3);
    expect(geo.uvs).not.toBeNull();
    expect(geo.uvs!.length / 2).toBe(geo.positions.length / 3);
    for (const uv of geo.uvs!) expect(Number.isFinite(uv)).toBe(true);
  });
});
