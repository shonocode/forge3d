/**
 * Blender's **Data Transfer** modifier, for vertex-group weights with the
 * **Nearest** vertex mapping — every target vertex takes the weights of the
 * closest source vertex.
 *
 * The map listed `transferAttribute` / `transferSkinWeights` as this
 * modifier's counterpart ("partial") until 2026-09-25. They are not: those two
 * carry an attribute through an edit — the old vertices keep their values
 * verbatim and only the new ones sample the old surface. This is the modifier:
 * two meshes, every vertex mapped.
 *
 * Only the `NEAREST` vertex mapping is offered. The others (nearest edge,
 * nearest face interpolated, projected) interpolate over a polygon with
 * Blender's own weights and are not ported.
 *
 * Pure and headless.
 */
import type { MeshData } from "../lib/mesh";

export interface TransferWeightsOptions {
  /** Which groups to carry. Default every group the source has. */
  groups?: readonly string[];
}

/**
 * Give every vertex of `target` the vertex-group weights of the nearest vertex
 * of `source` — Blender's Data Transfer, `VGROUP_WEIGHTS`, vertex mapping
 * `NEAREST`, groups matched by name, mix mode Replace at factor 1.
 *
 * ```ts
 * const rigged = transferWeights(lod, fullDetail); // weights onto a new LOD
 * ```
 *
 * Membership travels with the weight: a target vertex whose nearest source
 * vertex is not in a group ends up not in it either. Groups the target has
 * that are not carried are left as they were. The meshes are compared in
 * their own coordinates — place them first.
 */
export function transferWeights(
  target: MeshData,
  source: MeshData,
  options: TransferWeightsOptions = {},
): MeshData {
  const S = source.positions;
  const T = target.positions;
  const ns = S.length / 3;
  const nt = T.length / 3;
  const names = options.groups ?? [...(source.groups?.keys() ?? [])];

  // The nearest source vertex, first of equals.
  const nearest = new Int32Array(nt).fill(-1);
  for (let v = 0; v < nt; v++) {
    let best = Infinity;
    for (let s = 0; s < ns; s++) {
      const dx = S[s * 3]! - T[v * 3]!;
      const dy = S[s * 3 + 1]! - T[v * 3 + 1]!;
      const dz = S[s * 3 + 2]! - T[v * 3 + 2]!;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) {
        best = d;
        nearest[v] = s;
      }
    }
  }

  const groups = new Map(target.groups ?? []);
  for (const name of names) {
    const from = source.groups?.get(name);
    if (!from) continue;
    const to = new Map<number, number>();
    for (let v = 0; v < nt; v++) {
      const w = from.get(nearest[v]!);
      if (w !== undefined) to.set(v, w);
    }
    groups.set(name, to);
  }
  return { ...target, groups };
}
