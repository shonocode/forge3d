import { describe, it, expect } from "vitest";

import { box, plane, sphere } from "./generate";
import { displace, valueNoise, hashNoise } from "./displace";
import { weldMesh } from "./mesh-ops";
import type { MeshData } from "../lib/mesh";

const vertCount = (m: MeshData): number => m.positions.length / 3;

/** How far the furthest vertex moved. */
function maxShift(a: MeshData, b: MeshData): number {
  let worst = 0;
  for (let i = 0; i < a.positions.length; i += 3) {
    worst = Math.max(
      worst,
      Math.hypot(
        b.positions[i]! - a.positions[i]!,
        b.positions[i + 1]! - a.positions[i + 1]!,
        b.positions[i + 2]! - a.positions[i + 2]!,
      ),
    );
  }
  return worst;
}

describe("hashNoise", () => {
  it("test_is_a_function_of_its_inputs_only", () => {
    expect(hashNoise(3, 4, 5, 1)).toBe(hashNoise(3, 4, 5, 1));
    expect(hashNoise(3, 4, 5, 1)).not.toBe(hashNoise(3, 4, 5, 2));
    expect(hashNoise(3, 4, 5, 1)).not.toBe(hashNoise(4, 4, 5, 1));
  });

  it("test_stays_inside_the_unit_range", () => {
    for (let i = 0; i < 200; i++) {
      const v = hashNoise(i, i * 7, -i, 11);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("valueNoise", () => {
  it("test_is_continuous_across_a_lattice_line", () => {
    // Linear interpolation alone leaves a crease on every lattice plane, which
    // on a displaced box reads as a manufacturing defect rather than a stone.
    const at = (x: number): number => valueNoise([x, 0.31, 0.17], 1, 3);
    const left = at(1 - 1e-4);
    const right = at(1 + 1e-4);
    expect(Math.abs(right - left)).toBeLessThan(1e-3);
  });

  it("test_scale_changes_how_fast_it_varies", () => {
    const step = (scale: number): number =>
      Math.abs(valueNoise([0.1, 0, 0], scale, 5) - valueNoise([0.2, 0, 0], scale, 5));
    // Same distance walked; a coarse lattice changes less over it.
    expect(step(4)).toBeLessThan(step(0.25));
  });
});

describe("displace", () => {
  it("test_the_same_seed_gives_the_same_mesh", () => {
    // The whole guarantee: there is no Blender reference for this, so what is
    // promised is that a build script's render does not change under it.
    const a = displace(box({ size: [1, 1, 1] }), { amount: 0.1, seed: 7 });
    const b = displace(box({ size: [1, 1, 1] }), { amount: 0.1, seed: 7 });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));

    const other = displace(box({ size: [1, 1, 1] }), { amount: 0.1, seed: 8 });
    expect(Array.from(other.positions)).not.toEqual(Array.from(a.positions));
  });

  it("test_topology_is_untouched", () => {
    const before = sphere({ uSegments: 12, vSegments: 8 });
    const after = displace(before, { amount: 0.05, seed: 1 });
    expect(vertCount(after)).toBe(vertCount(before));
    expect(after.polys).toEqual(before.polys);
  });

  it("test_nothing_moves_further_than_amount", () => {
    const before = box({ size: [1, 1, 1] });
    expect(maxShift(before, displace(before, { amount: 0.2, seed: 2 }))).toBeLessThanOrEqual(0.2 + 1e-6);
    expect(maxShift(before, displace(before, { amount: 0, seed: 2 }))).toBe(0);
  });

  it("test_coincident_vertices_move_together", () => {
    // The field is sampled at the position, not per index, so a seam that was
    // welded shut stays shut. Sampling per index tears it open.
    const twoPlanes = { ...plane({ segments: [2, 2] }) };
    const doubled: MeshData = {
      positions: Float32Array.from([...twoPlanes.positions, ...twoPlanes.positions]),
      polys: [
        ...twoPlanes.polys,
        ...twoPlanes.polys.map((p) => p.map((v) => v + vertCount(twoPlanes))),
      ],
    };
    const moved = displace(doubled, { amount: 0.3, along: "free", seed: 4 });
    expect(vertCount(weldMesh(moved))).toBe(vertCount(weldMesh(doubled)));
  });

  it("test_along_a_direction_pushes_only_that_way", () => {
    const before = box({ size: [1, 1, 1] });
    const after = displace(before, { amount: 0.2, along: [0, 1, 0], seed: 3 });
    for (let i = 0; i < before.positions.length; i += 3) {
      expect(after.positions[i]).toBeCloseTo(before.positions[i]!, 6);
      expect(after.positions[i + 2]).toBeCloseTo(before.positions[i + 2]!, 6);
    }
    expect(maxShift(before, after)).toBeGreaterThan(0);
  });

  it("test_a_field_can_be_supplied", () => {
    // `by` is the escape hatch: a prop with its own idea of the field should
    // not have to fight the built-in noise.
    const before = plane({ segments: [2, 2] });
    const after = displace(before, { amount: 1, along: [0, 1, 0], by: (p) => p[0] });
    for (let v = 0; v < vertCount(before); v++) {
      expect(after.positions[v * 3 + 1]).toBeCloseTo(
        before.positions[v * 3 + 1]! + before.positions[v * 3]!,
        5,
      );
    }
  });
});
