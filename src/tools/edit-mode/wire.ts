/**
 * The operators that make edges belonging to no face.
 *
 * `MeshData` grew an `edges` field on 2026-09-22 and this is the first thing
 * to use it. Blender has four operators here and they were blocked together,
 * on one missing field rather than on four separate problems — the API matrix
 * called that "a separate project" for a long time, which was a description of
 * where a line had been drawn rather than of the work.
 *
 * Pure and headless. These take and return {@link MeshData} rather than an
 * `EditMesh`, because a half-edge structure is defined by faces and a wire
 * edge has none.
 */
import type { MeshData } from "../../lib/mesh";

/**
 * Duplicate each chosen vertex and join it to its original with a wire edge —
 * Blender's `bmesh.ops.extrude_vert_indiv`.
 *
 * ```ts
 * const bristles = extrudeVertIndiv(sheet, rimVertices);
 * // …then move the new vertices to give them length.
 * ```
 *
 * The starting point for anything built out of strands: hair, wires, a
 * skeleton to thicken later with `wireframe` or `skin`.
 *
 * ## Measured
 *
 * On a quad, extruding one, two and all four corners (Blender 5.1.1,
 * `tools/modeling/parity/probe-wire.py`):
 *
 * - **the duplicate lands exactly on its original** — extruding does not move
 *   anything, the same contract `extrudeFaces` and `extrudeEdges` have, and
 *   the caller moves the result
 * - **the face is untouched.** The quad comes back as the same quad; only
 *   vertices and wire edges are added
 * - one new vertex and one new wire edge per chosen vertex, in the order
 *   given: extruding 0, 1, 2, 3 of a quad gives wires (0,4) (1,5) (2,6) (3,7)
 *
 * Returns a new mesh; the input is not modified. The new vertices are appended
 * in ascending order of the vertex they came from, so their indices are
 * predictable: the first is `positions.length / 3` as it was on the way in.
 */
export function extrudeVertIndiv(
  data: MeshData,
  verts: ReadonlySet<number> | readonly number[],
): MeshData {
  const picked = [...new Set(verts)].sort((a, b) => a - b);
  const count = data.positions.length / 3;
  for (const v of picked)
    if (v < 0 || v >= count || !Number.isInteger(v))
      throw new Error(`extrudeVertIndiv: ${v} is not a vertex of this mesh`);

  const positions = new Float32Array(data.positions.length + picked.length * 3);
  positions.set(data.positions);
  const edges: number[][] = (data.edges ?? []).map((e) => [...e]);

  picked.forEach((v, i) => {
    const at = count + i;
    positions[at * 3] = data.positions[v * 3]!;
    positions[at * 3 + 1] = data.positions[v * 3 + 1]!;
    positions[at * 3 + 2] = data.positions[v * 3 + 2]!;
    edges.push([v, at]);
  });

  return {
    positions,
    polys: data.polys.map((p) => [...p]),
    ...(data.creases ? { creases: new Map(data.creases) } : {}),
    ...(data.seams ? { seams: new Set(data.seams) } : {}),
    edges,
  };
}

/**
 * Edges the old faces had that the new ones do not — what Blender leaves
 * behind when it removes a face and keeps its edges.
 *
 * `bmesh.ops.delete(context='FACES_ONLY')` says it in its name: the faces go,
 * the vertices **and edges** stay, so every edge of a removed face that no
 * surviving face still uses ends up belonging to nothing. `extrude_face_region`
 * does the same to the region's *interior* edges — the boundary ones are taken
 * up by the new side walls, the interior ones are taken up by nothing.
 *
 * ## Why this is a function and not a line inside each operator
 *
 * Because the scope was measured rather than guessed. Seventeen rows that
 * remove faces were run and **only two leave an edge behind**: `delete` and
 * `extrude-region`. Every dissolve, every merge, `mask`, `delete_loose`,
 * `region_extend` — all of them come back with nothing on either side, because
 * those operators clean up after themselves in Blender too. So this is applied
 * at exactly two call sites, and adding a third is a claim that wants its own
 * measurement.
 *
 * Both lists are polygons over the **same vertex numbering**. Order is the
 * order the edges are first met walking `before`, which makes the result
 * stable for a test to name.
 */
export function orphanedEdges(
  before: readonly (readonly number[])[],
  after: readonly (readonly number[])[],
): number[][] {
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

  const survives = new Set<string>();
  for (const poly of after)
    for (let i = 0; i < poly.length; i++)
      survives.add(key(poly[i]!, poly[(i + 1) % poly.length]!));

  const seen = new Set<string>();
  const out: number[][] = [];
  for (const poly of before)
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const k = key(a, b);
      if (survives.has(k) || seen.has(k)) continue;
      seen.add(k);
      out.push(a < b ? [a, b] : [b, a]);
    }
  return out;
}
