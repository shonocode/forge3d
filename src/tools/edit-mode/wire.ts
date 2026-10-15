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
import { withPositions, type MeshData } from "../../lib/mesh";
import { carryFaceLayers, defined, type WeightedCorner } from "../mesh-layers";
import { interpWeightsPoly } from "./interp";
import { closestPointOnTriangleBary } from "./attribute-transfer";
import { triangulate as looptris } from "../boolean/intersect";

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

  // Every layer stays (the faces are untouched), and each new vertex copies its source's data — `BM_vert_create(…, v, …)`,
  // vertex groups and the vertex crease (compat-backlog C109).
  const out = withPositions(data, positions);
  out.edges = edges;
  picked.forEach((v, i) => {
    const at = count + i;
    for (const g of out.groups?.values() ?? []) if (g.has(v)) g.set(at, g.get(v)!);
    if (out.vertexCreases?.has(v)) out.vertexCreases.set(at, out.vertexCreases.get(v)!);
  });
  return out;
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
 * ## The rule — a port of `edbm_face_split_by_edges_exec` (compat-backlog C115)
 *
 * Until 2026-10-15 each wire edge cut its face on its own, both its ends joined
 * to the boundary; a vertex inside a chain was joined too, and a two-edge chain
 * made three faces where Blender makes two. Now, as Blender:
 *
 * 1. **Wire that touches a corner of a face** goes to the face whose corner at
 *    that vertex holds its direction, with every unassigned wire it leads to,
 *    and each such face is split by that edge net (below).
 * 2. **The wire left** goes, edge by edge, to the face nearest its midpoint
 *    (`BKE_bmbvh_find_face_closest`; measured to the face's triangles as the
 *    edit mesh has them, so a warped face is measured as Blender measures it). Then, edge
 *    by edge as `edges` lists them, each vertex not on the face that ends the
 *    run of that face's edges (or meets another face's) is set into the face's
 *    edge — as it then stands — nearest it, passing over an edge whose end
 *    already shares an edge with it (`bm_face_split_edge_find`). It stays where
 *    it is (no snapping), and the edge is split in **every** face round it
 *    (`BM_edge_split`), so the neighbour gets the vertex too. Order matters:
 *    one chain listed the other way can cut differently, as Blender's does.
 *    Then each face is split by its edge net.
 * 3. **The split** (`BM_face_split_edgenet`) walks the net from the face's
 *    first corner: at each vertex the pair of edges to close a face by, then a
 *    search that takes, at a fork, the largest turn about the face's normal
 *    first. A loop found is a new face, and its corners are searched from in
 *    turn. A loop that is the face itself is dropped (it exists) — and when
 *    that is the first one found, **nothing is made and the wire stays**
 *    (`gridLeaveWire`: cutting there would give a triangle wound backwards).
 *
 * Measured against Blender 5.1.1 in `face-split-wires` (18 cases: chains,
 * corners, grids, a warped grid, an L-shaped face, a cube, wire left in
 * place, chains over two faces) and on 178 inputs of the reviews — random
 * wires, chains, branches, several chains in a face, cubes, warped grids,
 * closed loops — of which 165 agree; the 13 that do not are all the first
 * limit below.
 *
 * The layers: an end set into an edge takes that edge's corners mixed by where
 * along it it lies, in every face it went into; a corner of a new face on a
 * vertex of the face copies that corner; one on a vertex of the net takes the
 * mean-value mix of the face's corners (`face-split-wires-layers`).
 *
 * ## What is not done
 *
 * - **`BM_face_split_edgenet_connect_islands`.** Blender joins a part of the
 *   net that does not reach the face's boundary to the boundary by new edges
 *   before splitting (and joins back the faces that makes needlessly); here
 *   such a part is left as wire. That is **every closed loop of wire drawn
 *   inside a face** (Blender makes four faces of a triangle loop in a quad;
 *   12 of 12 in the review's sample), and the rarer end that found no edge to
 *   go into (an end of a chain over two faces, joined to a corner).
 * - **The order of the faces in step 2.** Blender goes through them in the
 *   order of a hash map of face pointers, which is not reproducible; it
 *   matters only when ends of edges on different faces compete for one edge.
 *   Here they go from the last face to the first — the order that agreed with
 *   Blender on the second review's random grids (81 of 82, against 79 the
 *   other way); a fit, not Blender's rule.
 * - **The disk order** of the edges round a vertex, which picks between equal
 *   choices in the walk, is the order the edges are met here, not BMesh's.
 *
 * Wire edges that are consumed become face edges and leave `edges`; ones that
 * are not stay.
 */
export function faceSplitByEdges(data: MeshData): MeshData {
  const P = data.positions;
  const polys = data.polys.map((p) => [...p]);
  // Where each face's corners come from: the input face, and per corner its weights over that face's corners.
  const srcFace = polys.map((_, f) => f);
  const srcW: Map<number, number>[][] = polys.map((p) => p.map((_, i) => new Map([[i, 1]])));
  const wires = (data.edges ?? []).map((e) => [e[0]!, e[1]!] as [number, number]).filter(([a, b]) => a !== b);
  /** Whether wire edge `k` still has no face (`BM_edge_is_wire`). */
  const used = new Set<number>();

  // Every edge there is, for `BM_edge_exists`; kept up to date as ends are set in.
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const existing = new Set<string>();
  for (const p of polys) for (let i = 0; i < p.length; i++) existing.add(edgeKey(p[i]!, p[(i + 1) % p.length]!));
  for (const [a, b] of wires) existing.add(edgeKey(a, b));

  /** Replace face `f` by the faces `BM_face_split_edgenet` made of it (the first takes its place). */
  const replace = (f: number, made: { verts: number[]; w: Map<number, number>[] }[]): void => {
    if (!made.length) return;
    const src = srcFace[f]!;
    polys[f] = made[0]!.verts;
    srcW[f] = made[0]!.w;
    for (const m of made.slice(1)) {
      polys.push(m.verts);
      srcW.push(m.w);
      srcFace.push(src);
    }
  };
  /** Split face `f` by the wire edges `net` (indices into `wires`), its normal `normal`. */
  const split = (f: number, net: number[], normal: V3): void => {
    const made = splitEdgenet(P, polys[f]!, srcW[f]!, net.map((k) => wires[k]!), normal);
    for (const m of made) for (const k of net) if (m.netUsed.has(wires[k]!)) used.add(k);
    replace(f, made);
  };

  // ── 1. Wire edges that touch a corner of a face (`edbm_face_split_by_edges_exec`, first pass). ──
  // Each to the face whose corner at that vertex holds its direction (the most upright one, `|dot(dir, no)|` least), the
  // second vertex deciding when both touch; then each face gathers its edges and every unassigned edge they lead to.
  const normals = polys.map((p) => newellOf(P, p));
  const owner = wires.map(() => -1);
  wires.forEach(([a, b], k) => {
    for (const [v, o] of [[a, b], [b, a]] as const) {
      let best = -1;
      let dotBest = Infinity;
      const corners: Array<[number, number]> = [];
      polys.forEach((p, g) => p.forEach((x, i) => x === v && corners.push([g, i])));
      if (corners.length === 1) best = corners[0]![0];
      else if (corners.length > 1) {
        const dir = unit([P[o * 3]! - P[v * 3]!, P[o * 3 + 1]! - P[v * 3 + 1]!, P[o * 3 + 2]! - P[v * 3 + 2]!]);
        // `BLI_SMALLSTACK` pops the last pushed first.
        for (const [g, i] of [...corners].reverse()) {
          const n = normals[g]!;
          const d = Math.abs(dot(dir, n));
          if (d < dotBest) {
            const p = polys[g]!;
            const prev = p[(i + p.length - 1) % p.length]!, next = p[(i + 1) % p.length]!;
            if (angleOnAxis(P, prev, v, o, n) < angleOnAxis(P, prev, v, next, n)) {
              dotBest = d;
              best = g;
            }
          }
        }
      }
      if (best >= 0) owner[k] = best;
    }
  });
  const faceCount1 = polys.length;
  for (let f = 0; f < faceCount1; f++) {
    const net: number[] = [];
    const stack: number[] = [];
    for (const v of polys[f]!)
      wires.forEach(([a, b], k) => {
        if (owner[k] === f && (a === v || b === v) && !net.includes(k)) {
          net.push(k);
          stack.push(a === v ? b : a);
        }
      });
    while (stack.length) {
      const v = stack.pop()!;
      wires.forEach(([a, b], k) => {
        if (owner[k] === -1 && (a === v || b === v)) {
          owner[k] = f;
          net.push(k);
          stack.push(a === v ? b : a);
        }
      });
    }
    if (net.length) split(f, net, normals[f]!);
  }

  // ── 2. The wire left (`USE_NET_ISLAND_CONNECT`). ──
  // Each edge to the face nearest its midpoint; then, face by face and edge by edge as `edges` lists them, each vertex
  // not on the face that ends the run of its edges there is set into the face's edge nearest it (`bm_face_split_edge_find`)
  // — split in every face round it (`BM_edge_split`) — and then each face is split by its edges.
  const loose = wires.map((_, k) => k).filter((k) => !used.has(k));
  if (loose.length) {
    const normals2 = polys.map((p) => newellOf(P, p));
    const faceOf = new Map<number, number>();
    for (const k of loose) {
      const [a, b] = wires[k]!;
      const f = nearestFace(P, polys, [(P[a * 3]! + P[b * 3]!) / 2, (P[a * 3 + 1]! + P[b * 3 + 1]!) / 2, (P[a * 3 + 2]! + P[b * 3 + 2]!) / 2]);
      if (f >= 0) faceOf.set(k, f);
    }
    // Blender: the order of a hash map of face pointers — not reproducible. Last to first agreed with it on the review's
    // random grids (81 of 82, against 79 first to last); a fit, not its rule (see "What is not done").
    const faces = [...new Set(faceOf.values())].sort((x, y) => y - x);
    const edgesOf = (f: number): number[] => loose.filter((k) => faceOf.get(k) === f);

    /** Set `v` into the edge x–y of every face that has it, `t` of the way from x. */
    const splice = (v: number, x: number, y: number, t: number): void => {
      polys.forEach((ring, g) => {
        for (let i = 0; i < ring.length; i++) {
          const j = (i + 1) % ring.length;
          const fwd = ring[i] === x && ring[j] === y;
          if (!fwd && !(ring[i] === y && ring[j] === x)) continue;
          // The corner data mixed along the edge (`BM_data_interp_face_vert_edge`).
          srcW[g]!.splice(i + 1, 0, mix([srcW[g]![i]!, srcW[g]![j]!], fwd ? [1 - t, t] : [t, 1 - t]));
          ring.splice(i + 1, 0, v);
          break;
        }
      });
      existing.delete(edgeKey(x, y));
      existing.add(edgeKey(v, x));
      existing.add(edgeKey(v, y));
    };
    /** The faces with the edge x–y. */
    const facesWith = (x: number, y: number): number[] =>
      polys.flatMap((ring, g) => (ring.some((u, i) => { const w = ring[(i + 1) % ring.length]!; return (u === x && w === y) || (u === y && w === x); }) ? [g] : []));

    for (const f of faces)
      for (const k of edgesOf(f))
        for (const v of wires[k]!) {
          const ring = polys[f]!;
          if (ring.includes(v)) continue;
          // An end: no other of this face's edges at v, or some edge there belongs to another face.
          let self = false;
          const others = new Set<number>();
          wires.forEach(([a, b], j) => {
            if (j === k || (a !== v && b !== v) || !faceOf.has(j)) return;
            if (faceOf.get(j) === f) self = true;
            else others.add(faceOf.get(j)!);
          });
          if (self && !others.size) continue;
          let at = -1;
          let t = 0;
          let best = Infinity;
          for (let i = 0; i < ring.length; i++) {
            const x = ring[i]!, y = ring[(i + 1) % ring.length]!;
            const r = toSegment(P, v, x, y);
            if (r.d2 < best || at < 0) {
              if (existing.has(edgeKey(v, x)) || existing.has(edgeKey(v, y))) continue;
              // With edges in other faces at v: the edge must be shared by every one of them.
              if (others.size && facesWith(x, y).filter((g) => g !== f && others.has(g)).length !== others.size) continue;
              best = r.d2;
              at = i;
              t = r.t;
            }
          }
          if (at < 0) continue;
          const x = ring[at]!, y = ring[(at + 1) % ring.length]!;
          // `bm_vert_in_faces_radial`: not when v is already on a face on the other side.
          if (facesWith(x, y).some((g) => g !== f && polys[g]!.includes(v))) continue;
          splice(v, x, y, t);
        }
    for (const f of faces) split(f, edgesOf(f), normals2[f]!);
  }

  const leftover = wires.filter((_, k) => !used.has(k)).map((e) => [...e]);
  // The layers (compat-backlog C109): the pieces of a split face take its corners and its face data, the corners the
  // cut made mixed from them; no vertex is added, so the vertex layers stay as they are.
  const corner = (m: Map<number, number>): number | WeightedCorner => {
    if (m.size === 1) {
      const [[k, w]] = [...m] as [[number, number]];
      if (w === 1) return k;
    }
    return { from: [...m.keys()], w: [...m.values()] };
  };
  const out = withPositions(data, new Float32Array(P));
  out.polys = polys;
  out.edges = leftover;
  Object.assign(out, carryFaceLayers(data, polys.map((_, f) => ({ face: srcFace[f]!, corners: srcW[f]!.map(corner) }))));
  return defined(out);
}

/** `Σ w[i] · maps[i]` over the source corners. */
function mix(maps: readonly Map<number, number>[], w: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  maps.forEach((m, i) => {
    if (!w[i]) return;
    for (const [k, x] of m) out.set(k, (out.get(k) ?? 0) + x * w[i]!);
  });
  return out;
}

/** The unit Newell normal of a polygon. */
function newellOf(P: ArrayLike<number>, poly: readonly number[]): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]! * 3;
    const b = poly[(i + 1) % poly.length]! * 3;
    x += (P[a + 1]! - P[b + 1]!) * (P[a + 2]! + P[b + 2]!);
    y += (P[a + 2]! - P[b + 2]!) * (P[a]! + P[b]!);
    z += (P[a]! - P[b]!) * (P[a + 1]! + P[b + 1]!);
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/**
 * The face nearest `p`, the first on a tie; -1 with no faces — measured, as `BKE_bmbvh_find_face_closest` measures, to the
 * face's triangles as the edit mesh has them (`em->looptris`: a quad by its diagonal rule, a larger face by `polyfill`).
 * A plane through one corner, or a fan from it, is not that: a warped quad or an L-shaped face come out nearer or
 * farther than they are (the C115 reviews).
 */
function nearestFace(P: ArrayLike<number>, polys: readonly number[][], p: readonly [number, number, number]): number {
  let best = -1;
  let bestD = Infinity;
  polys.forEach((poly, f) => {
    for (const [tri] of looptris(poly, P)) {
      const [a, b, c] = tri.map((v) => v * 3) as [number, number, number];
      const r = closestPointOnTriangleBary(p[0], p[1], p[2], P[a]!, P[a + 1]!, P[a + 2]!, P[b]!, P[b + 1]!, P[b + 2]!, P[c]!, P[c + 1]!, P[c + 2]!);
      if (r.dist2 < bestD) {
        bestD = r.dist2;
        best = f;
      }
    }
  });
  return best;
}


type V3 = [number, number, number];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
};

/** `angle_signed_on_axis_v3v3v3_v3`: the angle at b from a to c, about `axis`, in [0, 2π). */
function angleOnAxis(P: ArrayLike<number>, a: number, b: number, c: number, axis: readonly number[]): number {
  const proj = (v: V3): V3 => {
    const d = dot(v, axis);
    return [v[0] - axis[0]! * d, v[1] - axis[1]! * d, v[2] - axis[2]! * d];
  };
  const v1 = proj([P[a * 3]! - P[b * 3]!, P[a * 3 + 1]! - P[b * 3 + 1]!, P[a * 3 + 2]! - P[b * 3 + 2]!]);
  const v2 = proj([P[c * 3]! - P[b * 3]!, P[c * 3 + 1]! - P[b * 3 + 1]!, P[c * 3 + 2]! - P[b * 3 + 2]!]);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(unit(v1), unit(v2)))));
  const cr: V3 = [v2[1] * v1[2] - v2[2] * v1[1], v2[2] * v1[0] - v2[0] * v1[2], v2[0] * v1[1] - v2[1] * v1[0]];
  return dot(cr, axis) < 0 ? Math.PI * 2 - angle : angle;
}

/**
 * `BM_face_split_edgenet`: the faces the edge net `net` cuts face `ring` into, each with its corners' weights (a vertex
 * of the face takes its corner's, one of the net the mean-value mix of the face's at its position); empty when it makes
 * none — the walk from the face's first corner can close the face itself, which is dropped as already there, and then
 * nothing more is looked for.
 */
function splitEdgenet(
  P: ArrayLike<number>,
  ring: readonly number[],
  ringW: readonly Map<number, number>[],
  net: readonly (readonly [number, number])[],
  normal: V3,
): Array<{ verts: number[]; w: Map<number, number>[]; netUsed: Set<readonly [number, number]> }> {
  interface Edge { a: number; b: number; net: readonly [number, number] | null; loops: Array<{ face: number; from: number }> }
  const edges: Edge[] = [];
  const disk = new Map<number, number[]>();
  const add = (e: Edge): void => {
    edges.push(e);
    for (const v of [e.a, e.b]) {
      const d = disk.get(v);
      if (d) d.push(edges.length - 1);
      else disk.set(v, [edges.length - 1]);
    }
  };
  ring.forEach((v, i) => add({ a: v, b: ring[(i + 1) % ring.length]!, net: null, loops: [{ face: 0, from: v }] }));
  const seen = new Set(edges.map((e) => (e.a < e.b ? `${e.a}_${e.b}` : `${e.b}_${e.a}`)));
  for (const e of net) {
    const key = e[0] < e[1] ? `${e[0]}_${e[1]}` : `${e[1]}_${e[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add({ a: e[0], b: e[1], net: e, loops: [] });
  }
  const other = (e: number, v: number): number => (edges[e]!.a === v ? edges[e]!.b : edges[e]!.a);
  /** `v->e`: where each vertex's disk starts, set by the walk. */
  const vE = new Map<number, number>();
  const diskFrom = (v: number): number[] => {
    const d = disk.get(v) ?? [];
    const s = vE.has(v) ? Math.max(0, d.indexOf(vE.get(v)!)) : 0;
    return [...d.slice(s), ...d.slice(0, s)];
  };
  const count = (e: number): number => edges[e]!.loops.length;

  const pairExists = (v: number): boolean => {
    let boundary = 0, wire = 0;
    for (const e of diskFrom(v)) {
      if (count(e) === 1) boundary++;
      else if (count(e) === 0) wire++;
    }
    return boundary > 0 && (wire > 0 || boundary >= 2);
  };

  const findPair = (vInit: number): [number, number] | null => {
    const boundary: number[] = [], wire: number[] = [];
    for (const e of diskFrom(vInit)) {
      if (count(e) === 1) boundary.push(e);
      else if (count(e) === 0) wire.push(e);
    }
    if (!boundary.length) return null;
    const pair: [number, number] = [boundary.pop()!, -1];
    let search: number[] = [];
    if (!wire.length) {
      if (!boundary.length) return null;
      pair[1] = boundary.pop()!;
      if (boundary.length) search = boundary;
    } else {
      pair[1] = wire.pop()!;
      if (wire.length) search = wire;
    }
    if (search.length) {
      const dir = (e: number): [number, number] => planar(P, other(e, vInit), vInit, normal);
      const prev = dir(pair[0]);
      let bestCos = dot2(dir(pair[1]), prev);
      while (search.length) {
        const e = search.pop()!;
        const c = dot2(prev, dir(e));
        if (c > bestCos) {
          bestCos = c;
          pair[1] = e;
        }
      }
    }
    // The winding: `face_normal == l_walk->f->no` holds for the face being split only.
    const l = edges[pair[0]]!.loops[0]!;
    let swap = false;
    if (l.face === 0) swap = !swap;
    if (l.from !== vInit) swap = !swap;
    if (swap) pair.reverse();
    return pair;
  };

  const visited = new Set<number>();
  const walk = (vInit: number, pair: [number, number]): boolean => {
    let A: number[] = [];
    let B: number[] = [];
    let v = other(pair[0], vInit);
    vE.set(v, pair[0]);
    A.push(v);
    const dst = other(pair[1], vInit);
    const tagged: number[] = [];
    let found = false;
    outer: while (A.length) {
      v = A.pop()!;
      for (;;) {
        if (v === dst) {
          found = true;
          break outer;
        }
        const order: number[] = [];
        for (const e of diskFrom(v).slice(1)) {
          if (count(e) >= 2) continue;
          const w = other(e, v);
          if (!visited.has(w)) {
            order.push(w);
            vE.set(w, e);
          }
        }
        if (order.length === 1) {
          v = order[0]!;
          continue;
        }
        if (order.length > 1) {
          const prev = other(vE.get(v)!, v);
          const angle = new Map(order.map((w) => [w, angleOnAxis(P, prev, v, w, normal)]));
          order.sort((x, y) => angle.get(y)! - angle.get(x)!);
          visited.add(v);
          tagged.push(v);
        }
        while (order.length) B.push(order.pop()!);
        if (B.length) [A, B] = [B, A];
        break;
      }
    }
    for (const t of tagged) visited.delete(t);
    return found;
  };

  const ringSet = new Set(ring);
  const sameAsFace = (vs: number[]): boolean => vs.length === ring.length && vs.every((v) => ringSet.has(v));
  const made: Array<{ verts: number[]; w: Map<number, number>[]; netUsed: Set<readonly [number, number]> }> = [];
  const queue = [ring[0]!];
  const inQueue = new Set(queue);
  while (queue.length) {
    const vInit = queue.pop()!;
    inQueue.delete(vInit);
    const pair = findPair(vInit);
    if (!pair || !walk(vInit, pair)) continue;
    const verts = [vInit];
    const loopEdges = [pair[1]];
    let v = other(pair[1], vInit);
    do {
      verts.push(v);
      loopEdges.push(vE.get(v)!);
      v = other(vE.get(v)!, v);
    } while (v !== vInit);
    if (verts.length < 3) continue;
    // Faces with no wire edge in them are checked against the mesh: the face itself is one, and is not made again.
    const anyWire = loopEdges.some((e) => count(e) === 0 && edges[e]!.net);
    if (!anyWire && sameAsFace(verts)) continue;
    const id = made.length + 1;
    loopEdges.forEach((e, i) => edges[e]!.loops.push({ face: id, from: verts[i]! }));
    made.push({ verts, w: [], netUsed: new Set(loopEdges.flatMap((e) => (edges[e]!.net ? [edges[e]!.net!] : []))) });
    for (const u of verts)
      if (!inQueue.has(u) && pairExists(u)) {
        queue.push(u);
        inQueue.add(u);
      }
  }
  // The corners: a vertex of the face copies its corner; one of the net is the mean-value mix of the face at it.
  for (const m of made)
    m.w = m.verts.map((v) => {
      const i = ring.indexOf(v);
      if (i >= 0) return ringW[i]!;
      return mix(ringW, interpWeightsPoly(P, ring, normal, [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!]));
    });
  return made;
}

/** `normalize_v2_m3_v3v3`: the direction from b to a in the face's plane. */
function planar(P: ArrayLike<number>, a: number, b: number, n: V3): [number, number] {
  const ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit([n[1] * ax[2]! - n[2] * ax[1]!, n[2] * ax[0]! - n[0] * ax[2]!, n[0] * ax[1]! - n[1] * ax[0]!]);
  const w: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const d: V3 = [P[a * 3]! - P[b * 3]!, P[a * 3 + 1]! - P[b * 3 + 1]!, P[a * 3 + 2]! - P[b * 3 + 2]!];
  const x = dot(d, u), y = dot(d, w);
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}
const dot2 = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]!;
