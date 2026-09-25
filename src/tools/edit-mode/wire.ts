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
 * Add one loose vertex at `co` — Blender's `bmesh.ops.create_vert`. It goes
 * last, so its index is the old vertex count; everything else is untouched.
 *
 * No parity row: its output has no faces, and two faceless meshes compare
 * equal whatever they are, so a row would say nothing. The unit test checks
 * where it lands.
 */
export function createVert(data: MeshData, co: readonly [number, number, number]): MeshData {
  const positions = new Float32Array(data.positions.length + 3);
  positions.set(data.positions);
  positions.set(co, data.positions.length);
  return {
    ...data,
    positions,
    polys: data.polys.map((p) => [...p]),
    ...(data.edges ? { edges: data.edges.map((e) => [...e]) } : {}),
  };
}

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

/** Squared distance from `p` to the segment `a`–`b`, and where along it. */
function toSegment(
  P: Float32Array,
  p: number,
  a: number,
  b: number,
): { d2: number; t: number } {
  const ax = P[a * 3]!, ay = P[a * 3 + 1]!, az = P[a * 3 + 2]!;
  const ux = P[b * 3]! - ax, uy = P[b * 3 + 1]! - ay, uz = P[b * 3 + 2]! - az;
  const wx = P[p * 3]! - ax, wy = P[p * 3 + 1]! - ay, wz = P[p * 3 + 2]! - az;
  const uu = ux * ux + uy * uy + uz * uz;
  const t = uu < 1e-20 ? 0 : Math.max(0, Math.min(1, (wx * ux + wy * uy + wz * uz) / uu));
  const dx = wx - t * ux, dy = wy - t * uy, dz = wz - t * uz;
  return { d2: dx * dx + dy * dy + dz * dz, t };
}

/**
 * Split faces along the wire edges lying across them — Blender's
 * **Face ▸ Split by Edges** (`bpy.ops.mesh.face_split_by_edges`).
 *
 * The way a cut drawn as loose edges becomes real topology: lay the line you
 * want down as wire, then make the faces respect it.
 *
 * **Not a `bmesh.ops`.** Calling `bmesh.ops.face_split_by_edges` gets
 * `operator "face_split_by_edges" doesn't exist` — it lives only on
 * `bpy.ops.mesh`, which is why the API matrix files it under "real operators
 * that are not in bmesh.ops".
 *
 * ## The rule, measured
 *
 * It is **not** a snap with a tolerance. A wire end 5% of the quad away from
 * the boundary gives byte-identical output to one exactly on it, so nothing is
 * being rounded — each end is simply **attached to the boundary edge nearest
 * it** and the face's ring is cut in two at the two attachment points.
 * Reproduced exactly on three arrangements (`probe-split.py`):
 *
 * | the wire edge | Blender | and here |
 * |---|---|---|
 * | ends on two opposite edges | (0,4,5,3) (5,4,1,2) | same |
 * | ends floating in the interior | (0,1,5,4) (4,5,2,3) | same |
 * | a diagonal between two corners | (0,1,2) (2,3,0) | same |
 *
 * ## What is refused
 *
 * **Both ends nearest the same boundary edge.** Blender answers a pentagon and
 * a *zero-area* triangle there — for ends at 0.3 and 0.7 along a quad's bottom
 * edge it gives (0,4,5,2,3) and (5,4,1), the second of which has no area — and
 * the ring order that produces it is not the one every other case follows. One
 * sample of a degenerate arrangement is not a rule, so this throws rather than
 * inventing an answer.
 *
 * Wire edges that are consumed become face edges and leave `edges`; ones that
 * no face claims stay.
 */
export function faceSplitByEdges(data: MeshData): MeshData {
  const P = data.positions;
  let polys = data.polys.map((p) => [...p]);
  const leftover: number[][] = [];

  for (const wire of data.edges ?? []) {
    const [a, b] = wire as [number, number];
    let target = -1;
    let bestScore = Infinity;

    // The face this wire belongs to: the one whose boundary both ends are
    // closest to. A wire across nothing keeps to itself.
    for (let f = 0; f < polys.length; f++) {
      const ring = polys[f]!;
      let worst = 0;
      for (const end of [a, b]) {
        if (ring.includes(end)) continue;
        let near = Infinity;
        for (let i = 0; i < ring.length; i++)
          near = Math.min(near, toSegment(P, end, ring[i]!, ring[(i + 1) % ring.length]!).d2);
        worst = Math.max(worst, near);
      }
      if (worst < bestScore) {
        bestScore = worst;
        target = f;
      }
    }
    if (target < 0) {
      leftover.push([...wire]);
      continue;
    }

    // Attach each end that is not already a corner to the nearest boundary
    // edge, remembering how far along so several ends on one edge keep order.
    const ring = polys[target]!;
    const inserts = new Map<number, Array<{ v: number; t: number }>>();
    const where = new Map<number, number>();
    for (const end of [a, b]) {
      if (ring.includes(end)) continue;
      let at = 0;
      let t = 0;
      let best = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const r = toSegment(P, end, ring[i]!, ring[(i + 1) % ring.length]!);
        if (r.d2 < best) {
          best = r.d2;
          at = i;
          t = r.t;
        }
      }
      where.set(end, at);
      const list = inserts.get(at);
      if (list) list.push({ v: end, t });
      else inserts.set(at, [{ v: end, t }]);
    }
    if (where.size === 2 && where.get(a) === where.get(b))
      throw new Error(
        `faceSplitByEdges: both ends of the wire edge ${a}-${b} are nearest the ` +
          `same boundary edge. Blender answers a zero-area triangle there and ` +
          `the ring order that produces it does not follow the rule every other ` +
          `arrangement does, so this is refused rather than guessed.`,
      );

    const grown: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      grown.push(ring[i]!);
      const added = inserts.get(i);
      if (added) for (const { v } of added.sort((x, y) => x.t - y.t)) grown.push(v);
    }

    const ia = grown.indexOf(a);
    const ib = grown.indexOf(b);
    if (ia < 0 || ib < 0) {
      leftover.push([...wire]);
      continue;
    }
    const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
    const first = grown.slice(lo, hi + 1);
    const second = [...grown.slice(hi), ...grown.slice(0, lo + 1)];
    if (first.length < 3 || second.length < 3) {
      leftover.push([...wire]);
      continue;
    }
    polys = [...polys.slice(0, target), first, second, ...polys.slice(target + 1)];
  }

  return {
    positions: new Float32Array(P),
    polys,
    ...(data.creases ? { creases: new Map(data.creases) } : {}),
    ...(data.seams ? { seams: new Set(data.seams) } : {}),
    edges: leftover,
  };
}
