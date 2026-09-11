import { describe, it, expect } from "vitest";
import { meshFromData, meshToData } from "../../lib/mesh";
import { box } from "../generate";
import { insetFaces } from "./operators";
import {
  moveFaces,
  offsetFaces,
  scaleFaces,
  averageNormal,
  facesFacing,
  extrudeFacesBy,
  insetFacesByWidth,
} from "./face-transform";
import { faceVerts } from "./half-edge";
import type { EditMesh } from "./half-edge";

const cube = (): EditMesh => meshFromData(box({ size: [2, 2, 2] }));

/** Bounds of the whole mesh, for checking a face actually moved. */
function bounds(em: EditMesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < em.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = em.positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  return { min, max };
}

describe("facesFacing", () => {
  it("finds exactly one face per axis of a cube", () => {
    const em = cube();
    for (const dir of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      expect(facesFacing(em, dir).size).toBe(1);
    }
  });

  it("widens with tolerance", () => {
    const em = cube();
    // Past 90° every face except the opposite one qualifies.
    expect(facesFacing(em, [0, 0, 1], Math.PI / 2 + 0.01).size).toBe(5);
    expect(facesFacing(em, [0, 0, 1], 0.01).size).toBe(1);
  });

  it("normalises the direction it is given", () => {
    const em = cube();
    expect(facesFacing(em, [0, 7, 0]).size).toBe(1);
  });
});

describe("averageNormal", () => {
  it("returns the face normal for a single face", () => {
    const em = cube();
    const n = averageNormal(em, facesFacing(em, [0, 0, 1]));
    expect(n[2]).toBeCloseTo(1, 6);
    expect(n[0]).toBeCloseTo(0, 6);
  });

  it("cancels to zero over a closed mesh", () => {
    const em = cube();
    const all = new Set(em.faces.map((_, i) => i));
    expect(averageNormal(em, all)).toEqual([0, 0, 0]);
  });

  it("is weighted by area, so a big face outvotes small ones", () => {
    // A slab: the two large faces are ±Z, the four edges are slivers.
    const em = meshFromData(box({ size: [4, 4, 0.1] }));
    const n = averageNormal(em, new Set([...facesFacing(em, [0, 0, 1]), ...facesFacing(em, [1, 0, 0])]));
    expect(Math.abs(n[2])).toBeGreaterThan(Math.abs(n[0]) * 10);
  });
});

describe("moveFaces", () => {
  it("moves only the selected face's vertices", () => {
    const em = cube();
    moveFaces(em, facesFacing(em, [0, 1, 0]), 0, 3, 0);
    const bb = bounds(em);
    expect(bb.max[1]).toBeCloseTo(4, 6);
    expect(bb.min[1]).toBeCloseTo(-1, 6);
  });

  it("moves a shared vertex once, not once per face", () => {
    const em = cube();
    const two = new Set([...facesFacing(em, [0, 1, 0]), ...facesFacing(em, [1, 0, 0])]);
    moveFaces(em, two, 1, 0, 0);
    // The corner shared by both faces lands at x = 2, not x = 3.
    expect(bounds(em).max[0]).toBeCloseTo(2, 6);
  });
});

describe("offsetFaces", () => {
  it("pushes a face out along its own normal", () => {
    const em = cube();
    offsetFaces(em, facesFacing(em, [0, 0, 1]), 0.5);
    expect(bounds(em).max[2]).toBeCloseTo(1.5, 6);
  });

  it("negative distance recesses the face", () => {
    const em = cube();
    offsetFaces(em, facesFacing(em, [0, 0, 1]), -0.5);
    expect(bounds(em).max[2]).toBeCloseTo(0.5, 6);
  });

  it("is a no-op for an empty selection or zero distance", () => {
    const em = cube();
    const before = Array.from(em.positions);
    offsetFaces(em, new Set(), 1);
    offsetFaces(em, facesFacing(em, [0, 0, 1]), 0);
    expect(Array.from(em.positions)).toEqual(before);
  });
});

describe("scaleFaces", () => {
  it("test_shrinks_a_face_about_its_own_centre", () => {
    const em = cube();
    const top = facesFacing(em, [0, 1, 0]);

    scaleFaces(em, top, 0.5);

    // Half the size, and the centre has not drifted: the top stays at y = 1
    // and its corners come in to half a unit on the other two axes.
    const data = meshToData(em);
    for (const v of faceVerts(em, [...top][0]!)) {
      expect(data.positions[v * 3 + 1]!).toBeCloseTo(1, 5);
      expect(Math.abs(data.positions[v * 3]!)).toBeCloseTo(0.5, 5);
      expect(Math.abs(data.positions[v * 3 + 2]!)).toBeCloseTo(0.5, 5);
    }
  });

  it("test_a_factor_of_one_leaves_the_mesh_alone", () => {
    const em = cube();
    const before = meshToData(em).positions.slice();

    scaleFaces(em, facesFacing(em, [0, 1, 0]), 1);

    expect(Array.from(meshToData(em).positions)).toEqual(Array.from(before));
  });
});

describe("facesFacing", () => {
  it("test_a_right_angle_tolerance_includes_the_perpendicular_faces", () => {
    const em = cube();
    // cos(pi/2) is 6.1e-17, not 0 — without an epsilon the four sides fall out
    // and this returns 1 instead of 5.
    expect(facesFacing(em, [0, 1, 0], Math.PI / 2).size).toBe(5);
  });
});

describe("extrudeFacesBy", () => {
  it("actually moves the new cap, unlike extrudeFaces alone", () => {
    const em = cube();
    const caps = extrudeFacesBy(em, facesFacing(em, [0, 1, 0]), 1);
    expect(caps.size).toBe(1);
    expect(bounds(em).max[1]).toBeCloseTo(2, 6);
    // 8 original + 4 duplicated for the new cap.
    expect(em.positions.length / 3).toBe(12);
  });

  it("chains, because it returns the caps", () => {
    const em = cube();
    const first = extrudeFacesBy(em, facesFacing(em, [0, 1, 0]), 1);
    extrudeFacesBy(em, first, 2);
    expect(bounds(em).max[1]).toBeCloseTo(4, 5);
  });

  it("leaves a mesh the polygon round-trip accepts", () => {
    const em = cube();
    extrudeFacesBy(em, facesFacing(em, [0, 1, 0]), 1);
    const data = meshToData(em);
    expect(data.polys.every((p) => p.length >= 3)).toBe(true);
    expect(meshToData(meshFromData(data)).polys).toHaveLength(data.polys.length);
  });
});

describe("insetFacesByWidth", () => {
  it("gives the same border on a non-square face, where the ratio inset cannot", () => {
    const em = meshFromData(box({ size: [0.44, 0.66, 0.02] }));
    const field = insetFacesByWidth(em, facesFacing(em, [0, 0, 1]), 0.055);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const f of field)
      for (const v of faceVerts(em, f)) {
        minX = Math.min(minX, em.positions[v * 3]!);
        maxX = Math.max(maxX, em.positions[v * 3]!);
        minY = Math.min(minY, em.positions[v * 3 + 1]!);
        maxY = Math.max(maxY, em.positions[v * 3 + 1]!);
      }
    // 55mm off every side, both axes — a 330 x 550 panel.
    expect(maxX - minX).toBeCloseTo(0.44 - 0.11, 4);
    expect(maxY - minY).toBeCloseTo(0.66 - 0.11, 4);

    // The ratio-based inset cannot do this: matching the stile leaves the
    // rail wrong by exactly the aspect ratio.
    const ratio = meshFromData(box({ size: [0.44, 0.66, 0.02] }));
    const rField = insetFaces(ratio, facesFacing(ratio, [0, 0, 1]), 0.25);
    let rx = -Infinity, ry = -Infinity;
    for (const f of rField)
      for (const v of faceVerts(ratio, f)) {
        rx = Math.max(rx, ratio.positions[v * 3]!);
        ry = Math.max(ry, ratio.positions[v * 3 + 1]!);
      }
    expect(0.22 - rx).toBeCloseTo(0.055, 4);
    expect(0.33 - ry).toBeCloseTo(0.0825, 4); // 50% wider than the stile
  });

  it("stays planar, so the panel can still be offset as one piece", () => {
    const em = meshFromData(box({ size: [0.5, 0.5, 0.02] }));
    const field = insetFacesByWidth(em, facesFacing(em, [0, 0, 1]), 0.05);
    for (const f of field)
      for (const v of faceVerts(em, f)) expect(em.positions[v * 3 + 2]).toBeCloseTo(0.01, 6);
  });

  it("is a no-op for zero width or an empty selection", () => {
    const em = cube();
    const before = Array.from(em.positions);
    insetFacesByWidth(em, facesFacing(em, [0, 0, 1]), 0);
    expect(Array.from(em.positions)).toEqual(before);
  });
});

describe("a raised-panel door, the way a build script would write it", () => {
  it("insets a frame and recesses the panel", () => {
    const em = meshFromData(box({ size: [0.44, 0.66, 0.019] }));
    const front = facesFacing(em, [0, 0, 1]);
    const field = insetFacesByWidth(em, front, 0.055);
    offsetFaces(em, field, -0.006);

    // The recessed panel is behind the stiles but still inside the slab.
    let panelZ = -Infinity;
    for (const f of field) for (const v of faceVerts(em, f)) panelZ = Math.max(panelZ, em.positions[v * 3 + 2]!);
    expect(panelZ).toBeCloseTo(0.0095 - 0.006, 5);
    expect(bounds(em).max[2]).toBeCloseTo(0.0095, 5);

    // And the panel is 110mm narrower than the door on each axis.
    let minX = Infinity;
    let maxX = -Infinity;
    for (const f of field)
      for (const v of faceVerts(em, f)) {
        minX = Math.min(minX, em.positions[v * 3]!);
        maxX = Math.max(maxX, em.positions[v * 3]!);
      }
    expect(maxX - minX).toBeCloseTo(0.44 - 0.11, 5);
  });
});
