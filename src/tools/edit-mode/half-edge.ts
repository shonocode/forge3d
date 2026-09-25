import type { Mesh } from "@babylonjs/core/Meshes/mesh";

/**
 * Index-based Half-Edge data structure for Edit Mode operators.
 *
 * V2 (quad / n-gon): faces are arbitrary polygons — each face is a cycle of
 * ≥3 half-edges linked by `next`. Babylon renders triangles only, so the
 * render index buffer is always derived by fan-triangulating every face
 * ({@link triangulateFaces}); `EditMesh.triToFace` maps each render triangle
 * back to its owning logical face (used by face picking). The polygon
 * structure itself survives outside Edit Mode via `mesh.metadata.forge3dPolys`
 * (written on every topology commit, validated against the index buffer on
 * the next Edit Mode entry — see build.ts).
 *
 * Half-edges are indices rather than object references (the original design
 * had objects): an array of indices is faster to mutate and easier to
 * serialize for undo snapshots.
 */
export interface HalfEdge {
  /** Origin vertex index. */
  v: number;
  /** Next half-edge index within the same face (CCW). */
  next: number;
  /** Pair half-edge on the adjacent face, or -1 if this edge is a boundary. */
  twin: number;
  /** Owning face index. */
  face: number;
}

export interface EditFace {
  /** Any one half-edge belonging to this face. */
  he: number;
}

export interface EditVertex {
  /** Any one half-edge whose origin is this vertex, or -1 if isolated. */
  he: number;
}

export interface EditMesh {
  /**
   * Source Babylon mesh — positions are written back here on commit.
   *
   * Null when the mesh was built from plain arrays rather than entered from
   * the viewport (see `lib/mesh.ts`). Every operator works on the half-edge
   * data alone; only commit, picking, overlay and the gizmos need a scene
   * object to talk to, and those are viewport paths that always have one.
   */
  source: Mesh | null;
  vertices: EditVertex[];
  faces: EditFace[];
  halfEdges: HalfEdge[];
  /** Local-space positions, length = vertices.length * 3, mutable. */
  positions: Float32Array;
  /**
   * Edges marked as UV seams. Keyed by `seamKey(v1, v2)` = "min_max" of the
   * two vertex indices, NOT by half-edge index — this lets seams survive
   * topology rebuilds (extrude / bevel / etc.) as long as the endpoint
   * vertex IDs stay valid. Unwrap uses these to break face clusters.
   */
  seams: Set<string>;
  /**
   * Edges belonging to no face, carried through untouched.
   *
   * **No operator in this module reads or writes these.** A half-edge
   * structure is defined by faces, and a wire edge has none — threading them
   * through would be a change to every operator rather than a field. They ride
   * here so `meshFromData` → operator → `meshToData` does not silently drop
   * what `MeshData.edges` was given.
   *
   * The consequence to know: an operator that **renumbers vertices** leaves
   * these pointing at the old numbers. The operators here do not renumber
   * (forge3d leaves orphaned vertices where Blender compacts, which is five
   * parity rows' worth of documented difference); the ones that do go through
   * `compactMesh`, which remaps them.
   */
  wireEdges?: number[][];
  /**
   * Per-face-corner UV and colour, shaped like the faces.
   *
   * **They follow the faces through `rebuildPolygons`**, which every
   * topology change goes through (`layer-carry.test.ts` holds that): an
   * operator checked against Blender carries them by Blender's rules, any
   * other keeps the faces that did not change and **drops** the layer if one
   * did — never stale. Until 2026-09-25 they rode along untouched and came
   * out describing faces that no longer existed. See {@link LayerCarry}.
   */
  loopUVs?: number[][][];
  loopColors?: number[][][];
  /**
   * Edges marked sharp, keyed the way `creases` and `seams` are — carried
   * through untouched, with the same warning as {@link wireEdges}: an
   * operator that renumbers vertices leaves these pointing at the old
   * numbers.
   *
   * Added 2026-09-23 with `setSharpnessByAngle`, which takes `MeshData`
   * directly and never comes through here. This is so a mesh that merely
   * *passes* an operator does not lose the flag silently — the round trip
   * through `meshFromData` and `meshToData` is the shared path, and a layer
   * that vanishes there vanishes without a word.
   */
  sharpEdges?: Set<string>;
  /**
   * An explicit normal per face corner, following the faces like the loop
   * layers above — except that a corner which would have to be
   * interpolated drops the layer (see {@link LayerCarry}).
   */
  loopNormals?: number[][][];
  /**
   * A material slot per face (`MeshData.materials`), following the faces
   * through `rebuildPolygons` like the corner layers: a face keeps its
   * source face's slot (a joined face its first corner's face's), and a face
   * whose source is not known drops the layer.
   */
  faceMaterials?: number[];
  /**
   * Vertex groups (`MeshData.groups`), keyed by vertex index. A vertex keeps
   * its weights; a vertex an operator made from others (`VertexOrigin`)
   * takes the weighted mix Blender's `BM_edge_split` / `BM_loop_interp_from_face`
   * give it (a group missing from a source counts 0); a new vertex with no
   * known origin drops the layer.
   */
  vertexGroups?: Map<string, Map<number, number>>;
  /**
   * Edge sharpness for Catmull-Clark creases. Keyed by `seamKey(v1, v2)`
   * (same vertex-pair scheme as `seams`), value = σ ≥ 0 (0 / absent = smooth,
   * ≥ 1 = fully sharp). Only Subdivide reads these; other operators leave them
   * alone (a stale key simply matches no current edge and is ignored).
   */
  creases: Map<string, number>;
  /**
   * Render-triangle → logical-face map for the CURRENT source index buffer.
   * Kept in sync by build (entry) and commitTopology (every topology op) so
   * `scene.pick().faceId` can be resolved to a polygon face.
   */
  triToFace: number[];
}

/** Cycle guard for face walks — no sane face has more sides than this. */
const MAX_FACE_ARITY = 4096;

/**
 * The source mesh, for code paths that genuinely need a scene object —
 * commit, picking, overlays, gizmos.
 *
 * Throws rather than returning null because every caller is a viewport path
 * reached from `enterEditMode(mesh)`, where a source always exists. A mesh
 * built from plain arrays hitting one of these is a programming error, and a
 * named failure beats a null dereference three frames later.
 */
export function sourceMesh(em: EditMesh): Mesh {
  if (!em.source) {
    throw new Error("EditMesh has no source mesh — this operation needs one from the viewport");
  }
  return em.source;
}

/** Build a stable, direction-agnostic key for an edge between two vertices. */
export function seamKey(v1: number, v2: number): string {
  return v1 < v2 ? `${v1}_${v2}` : `${v2}_${v1}`;
}

/** True iff the given (canonical) half-edge is currently marked as a seam. */
export function isSeam(em: EditMesh, he: number): boolean {
  const a = edgeOrigin(em, he);
  const b = edgeEnd(em, he);
  return em.seams.has(seamKey(a, b));
}

/** Crease sharpness (σ) of the given half-edge's edge — 0 when not creased. */
export function creaseOf(em: EditMesh, he: number): number {
  const a = edgeOrigin(em, he);
  const b = edgeEnd(em, he);
  return em.creases.get(seamKey(a, b)) ?? 0;
}

/** Half-edge representing the edge from `vertex(he)` to `vertex(next)`. */
export function edgeOrigin(em: EditMesh, he: number): number {
  return em.halfEdges[he]!.v;
}

export function edgeEnd(em: EditMesh, he: number): number {
  const h = em.halfEdges[he]!;
  return em.halfEdges[h.next]!.v;
}

/**
 * Canonical half-edge index for an edge. Each undirected edge corresponds to
 * two half-edges (or one, on a boundary); we treat the smaller-indexed one as
 * the "edge id" so the same edge has a stable identifier regardless of which
 * face we touched it from.
 */
export function canonicalEdge(em: EditMesh, he: number): number {
  const twin = em.halfEdges[he]!.twin;
  if (twin < 0) return he;
  return he < twin ? he : twin;
}

/** Iterate every unique edge exactly once. */
export function forEachEdge(em: EditMesh, cb: (he: number) => void): void {
  for (let i = 0; i < em.halfEdges.length; i++) {
    const twin = em.halfEdges[i]!.twin;
    if (twin < 0 || i < twin) cb(i);
  }
}

/** All half-edges of face `f`, in CCW cycle order starting at `faces[f].he`. */
export function faceHalfEdges(em: EditMesh, f: number): number[] {
  const out: number[] = [];
  const h0 = em.faces[f]!.he;
  let h = h0;
  let guard = 0;
  do {
    out.push(h);
    h = em.halfEdges[h]!.next;
  } while (h !== h0 && ++guard < MAX_FACE_ARITY);
  return out;
}

/** All vertex indices of face `f` in CCW order (variable arity — V2). */
export function faceVerts(em: EditMesh, f: number): number[] {
  return faceHalfEdges(em, f).map((h) => em.halfEdges[h]!.v);
}

/** Number of sides of face `f`. */
export function faceVertexCount(em: EditMesh, f: number): number {
  return faceHalfEdges(em, f).length;
}

/** True iff any face has more than 3 sides. */
export function hasNonTriFaces(em: EditMesh): boolean {
  for (let f = 0; f < em.faces.length; f++) {
    if (faceVertexCount(em, f) !== 3) return true;
  }
  return false;
}

/**
 * The FIRST THREE vertex indices of a face (CCW order).
 *
 * Triangle-only legacy helper — correct solely for 3-sided faces. Polygon-
 * aware code must use {@link faceVerts}. Retained for the tri-specific
 * operators (Flip Diagonal, bevel fan math) and their tests.
 */
export function faceVertices(em: EditMesh, f: number): [number, number, number] {
  const h0 = em.faces[f]!.he;
  const he0 = em.halfEdges[h0]!;
  const he1 = em.halfEdges[he0.next]!;
  return [he0.v, he1.v, em.halfEdges[he1.next]!.v];
}

/**
 * Face normal via Newell's method — robust for arbitrary (even slightly
 * non-planar) polygons, and identical to the cross-product normal for
 * triangles. Returns a normalized vector (zero vector for degenerate faces).
 */
export function facePolyNormal(em: EditMesh, f: number): [number, number, number] {
  const verts = faceVerts(em, f);
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    const ax = em.positions[a * 3]!, ay = em.positions[a * 3 + 1]!, az = em.positions[a * 3 + 2]!;
    const bx = em.positions[b * 3]!, by = em.positions[b * 3 + 1]!, bz = em.positions[b * 3 + 2]!;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-9) { nx /= len; ny /= len; nz /= len; }
  return [nx, ny, nz];
}

/** Set the world-local position of a vertex (used by gizmo drag). */
export function setVertexPosition(em: EditMesh, v: number, x: number, y: number, z: number): void {
  em.positions[v * 3] = x;
  em.positions[v * 3 + 1] = y;
  em.positions[v * 3 + 2] = z;
}

export function getVertexPosition(em: EditMesh, v: number, out: [number, number, number]): void {
  out[0] = em.positions[v * 3]!;
  out[1] = em.positions[v * 3 + 1]!;
  out[2] = em.positions[v * 3 + 2]!;
}

/**
 * Replace `em`'s geometry with the supplied positions + polygon list and
 * rebuild every half-edge from scratch. Used by topology-changing operators
 * (Extrude, Delete, …) — for small meshes (<10k faces) the rebuild cost
 * (O(F)) is dominated by the operator's own work.
 *
 * Each polygon is a CCW cycle of ≥3 vertex indices. `em.source` is left
 * unchanged; callers commit to Babylon separately via `commitTopology`.
 *
 * The per-corner layers (`loopUVs`, `loopColors`, `loopNormals`) follow the
 * faces as `carry` says — see {@link LayerCarry}. They never come out
 * describing faces that no longer exist: a layer that cannot be carried is
 * dropped.
 */
export function rebuildPolygons(
  em: EditMesh,
  positions: Float32Array,
  polys: number[][],
  carry?: LayerCarry,
): void {
  const hasLayers =
    LAYER_KEYS.some((k) => em[k] !== undefined) || em.faceMaterials !== undefined || em.vertexGroups !== undefined;
  const oldPolys = hasLayers ? toPolygons(em) : [];
  const oldNumV = em.vertices.length;
  const oldPositions = em.positions;
  rebuildTopology(em, positions, polys);
  if (hasLayers) carryLayers(em, oldPolys, oldNumV, oldPositions, polys, carry);
}

function rebuildTopology(em: EditMesh, positions: Float32Array, polys: number[][]): void {
  const numV = positions.length / 3;
  let totalHE = 0;
  for (const p of polys) totalHE += p.length;

  em.positions = positions;
  em.vertices = new Array(numV);
  for (let i = 0; i < numV; i++) em.vertices[i] = { he: -1 };
  em.faces = new Array(polys.length);
  em.halfEdges = new Array(totalHE);

  const edgeMap = new Map<number, number>();
  const key = (a: number, b: number): number => (a < b ? a * numV + b : b * numV + a);

  let base = 0;
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % n]!;
      em.halfEdges[base + i] = { v: a, next: base + ((i + 1) % n), twin: -1, face: f };
      if (em.vertices[a]!.he < 0) em.vertices[a]!.he = base + i;
      pairTwin(edgeMap, em, key(a, b), base + i);
    }
    em.faces[f] = { he: base };
    base += n;
  }
}

/**
 * Where a vertex made by an operator came from, for the per-corner layers:
 * its corner value in a face is `Σ w[i] · value(from[i])` in that same face.
 *
 * A point cut into an edge is `{ from: [a, b], w: [1 - t, t] }` — Blender's
 * `BM_edge_split`, which interpolates each face's two loops on the edge
 * (`BM_data_interp_face_vert_edge`). `from` may name other new vertices; they
 * are expanded in turn.
 */
export interface VertexOrigin {
  from: readonly number[];
  w: readonly number[];
}

/**
 * How {@link rebuildPolygons} treats the per-corner layers (`loopUVs`,
 * `loopColors`, `loopNormals`).
 *
 * - absent — **keep only what did not change**: a face that comes back with
 *   the same vertices in the same cyclic order, **none of them moved**, keeps
 *   its corners; any other face means the layer is dropped. Never stale,
 *   never guessed. This is the default so that an operator nobody has
 *   checked against Blender loses the layer visibly instead of carrying
 *   plausible wrong values. (The "not moved" half is there because merge,
 *   weld and collapse renumber the survivors, and a face can come back with
 *   the numbers another face had — found by review.)
 * - `{ origins }` — the operator has been checked (a parity row with UVs)
 *   and every new face derives from the old ones by Blender's rules:
 *   1. a face whose corners, expanded through `origins`, all lie in **one**
 *      old face takes its values from that face (`BM_face_split` copies the
 *      loop at the same vertex; new vertices interpolate per `origins`)
 *   2. otherwise, a corner at an old vertex `v` takes the value from the old
 *      face that had the directed edge `v → next` (the loop `BM_faces_join`
 *      keeps), else `prev → v`. With `joins`, this comes first
 *   Anything left over drops the layer, as above.
 *
 * Not matched to Blender, and not measured by any row: an edge used by
 * three or more faces (rule 2 reads the last face registered for the
 * direction; Blender looks only among the faces being joined); a face that
 * visits a vertex twice (the first corner is read); a colour layer (Blender
 * stores byte colours in sRGB and rounds each interpolation — this stays
 * float); and custom normals, which are copied as vectors where Blender
 * copies two angles and reads them back in the new corner's normal space.
 */
/** One new face's corners and material, as an operator states them (`LayerCarry.faces`). */
export interface ExplicitFace {
  corners: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>>;
  material: number;
}

export interface LayerCarry {
  origins?: ReadonlyMap<number, VertexOrigin>;
  /**
   * The operator **joins** faces (dissolve, join triangles, edge rotate):
   * try rule 2 before rule 1. A joined face can lie wholly inside one of
   * the faces it swallowed — a concave quad and the triangle filling its
   * notch — and rule 1 would then read every corner from that one face,
   * where `BM_faces_join` keeps each corner of the face whose edge leaves it.
   * Not the default, because on a **reversed** face the edge leaving a
   * corner belongs to the neighbour.
   */
  joins?: boolean;
  /**
   * The faces are the old ones in the same order with the same corners, and
   * only the vertex numbers changed (a compaction). The layers stay as they are.
   */
  sameCorners?: boolean;
  /** With `sameCorners`: old vertex -> new vertex (-1 gone), for the vertex groups. */
  vertexMap?: ArrayLike<number>;
  /**
   * Per new face (aligned with the new polygons), where each corner comes
   * from, stated by the operator: `corners[i]` is a list of
   * `[old face, old corner, weight]` (empty for Blender's default, a zero
   * value — a loop created with no example), and `material` the old face
   * whose slot the face takes (-1 for slot 0). An undefined entry falls back
   * to the rules above. For operators whose rule is not "copy the face it was
   * split from" — extrude copies a side face's corners from the face across
   * the edge (`bm_extrude_copy_face_loop_attributes`).
   */
  faces?: ReadonlyArray<ExplicitFace | undefined>;
}

const LAYER_KEYS = ["loopUVs", "loopColors", "loopNormals"] as const;

/**
 * Carry the per-corner layers from `oldPolys` to `newPolys`. Returns, per
 * layer, the new layer or undefined (dropped).
 */
function carryLayers(
  em: EditMesh,
  oldPolys: readonly (readonly number[])[],
  oldNumV: number,
  oldPositions: ArrayLike<number>,
  newPolys: readonly (readonly number[])[],
  carry: LayerCarry | undefined,
): void {
  const layers = LAYER_KEYS.filter((k) => em[k] !== undefined);

  // A layer that already disagrees with the faces is stale from before; drop it.
  for (const k of layers) {
    const layer = em[k]!;
    const ok =
      layer.length === oldPolys.length && layer.every((f, i) => f.length === oldPolys[i]!.length);
    if (!ok) em[k] = undefined;
  }
  if (em.faceMaterials && em.faceMaterials.length !== oldPolys.length) em.faceMaterials = undefined;
  const live = LAYER_KEYS.filter((k) => em[k] !== undefined);
  if (live.length === 0 && !em.faceMaterials && !em.vertexGroups) return;
  if (carry?.sameCorners) {
    const same =
      newPolys.length === oldPolys.length && newPolys.every((p, i) => p.length === oldPolys[i]!.length);
    if (!same) {
      for (const k of live) em[k] = undefined;
      em.faceMaterials = undefined;
    }
    if (em.vertexGroups) {
      const map = carry.vertexMap;
      if (!map) em.vertexGroups = undefined;
      else
        em.vertexGroups = new Map(
          [...em.vertexGroups].map(([name, g]) => {
            const ng = new Map<number, number>();
            for (const [v, w] of g) if (v < map.length && map[v]! >= 0) ng.set(map[v]!, w);
            return [name, ng];
          }),
        );
    }
    return;
  }

  // Old faces by their cyclic vertex sequence (rotated to start at the least).
  const cyclicKey = (p: readonly number[]): string => {
    let m = 0;
    for (let i = 1; i < p.length; i++) if (p[i]! < p[m]!) m = i;
    const out: number[] = [];
    for (let i = 0; i < p.length; i++) out.push(p[(m + i) % p.length]!);
    return out.join(",");
  };
  const byKey = new Map<string, number>();
  oldPolys.forEach((p, g) => byKey.set(cyclicKey(p), g));
  const cornerOf = (g: number, v: number): number => oldPolys[g]!.indexOf(v);

  // One source per new corner: a weighted sum of (old face, old corner).
  type Source = Array<[g: number, corner: number, w: number]>;
  const sources: Source[][] = [];

  let failed = false;
  // The same numbers are only the same vertices if they did not move: an
  // operator that renumbers (merge, weld, collapse compact the survivors)
  // can hand a face the numbers another face used to have.
  const P = em.positions;
  const unmoved = (v: number): boolean =>
    v < oldNumV &&
    oldPositions[v * 3] === P[v * 3] &&
    oldPositions[v * 3 + 1] === P[v * 3 + 1] &&
    oldPositions[v * 3 + 2] === P[v * 3 + 2];
  const exact = (poly: readonly number[]): Source[] | null => {
    const g = byKey.get(cyclicKey(poly));
    if (g === undefined || !poly.every(unmoved)) return null;
    return poly.map((v) => [[g, cornerOf(g, v), 1]]);
  };

  const origins = carry?.origins ?? new Map<number, VertexOrigin>();
  const memo = new Map<number, Map<number, number> | null>();
  const expand = (v: number, depth = 0): Map<number, number> | null => {
    const hit = memo.get(v);
    if (hit !== undefined) return hit;
    let out: Map<number, number> | null;
    const o = origins.get(v);
    if (o) {
      out = new Map();
      for (let i = 0; i < o.from.length && out; i++) {
        const sub = depth > 64 ? null : expand(o.from[i]!, depth + 1);
        if (!sub) out = null;
        else for (const [u, w] of sub) out.set(u, (out.get(u) ?? 0) + w * o.w[i]!);
      }
    } else out = v < oldNumV ? new Map([[v, 1]]) : null;
    memo.set(v, out);
    return out;
  };

  const explicitMaterial = new Map<number, number>();
  if (!carry) {
    for (const poly of newPolys) {
      const s = exact(poly);
      if (!s) {
        failed = true;
        break;
      }
      sources.push(s);
    }
  } else {
    const facesOfV = new Map<number, number[]>();
    oldPolys.forEach((p, g) => {
      for (const v of p) {
        const l = facesOfV.get(v);
        if (l) l.push(g);
        else facesOfV.set(v, [g]);
      }
    });
    const directed = new Map<string, number>();
    oldPolys.forEach((p, g) => {
      for (let i = 0; i < p.length; i++) directed.set(`${p[i]}>${p[(i + 1) % p.length]}`, g);
    });

    for (let pi = 0; pi < newPolys.length; pi++) {
      const poly = newPolys[pi]!;
      const stated = carry.faces?.[pi];
      if (stated) {
        sources.push(stated.corners.map((c) => c.map(([g, k, w]) => [g, k, w] as [number, number, number])));
        explicitMaterial.set(pi, stated.material);
        continue;
      }
      const same = exact(poly);
      if (same) {
        sources.push(same);
        continue;
      }
      // Rule 2: each old corner from the face that owned its outgoing edge
      // (else its incoming one) — the loop `BM_faces_join` keeps.
      const byEdges = (): Source[] | null => {
        const n = poly.length;
        const per: Source[] = [];
        for (let i = 0; i < n; i++) {
          const v = poly[i]!;
          if (v >= oldNumV || origins.has(v)) return null;
          const g = directed.get(`${v}>${poly[(i + 1) % n]}`) ?? directed.get(`${poly[(i + n - 1) % n]}>${v}`);
          if (g === undefined) return null;
          per.push([[g, cornerOf(g, v), 1]]);
        }
        return per;
      };
      const exp = poly.map((v) => expand(v));
      let s: Source[] | null = carry.joins ? byEdges() : null;
      // Rule 1: one old face holding every vertex the corners draw on.
      if (!s && exp.every((e) => e !== null)) {
        const used = new Set<number>();
        for (const e of exp) for (const u of e!.keys()) used.add(u);
        let cands: number[] | null = null;
        for (const u of used) {
          const fs = facesOfV.get(u) ?? [];
          cands = cands === null ? [...fs] : cands.filter((g) => fs.includes(g));
          if (cands.length === 0) break;
        }
        if (cands && cands.length > 0) {
          // More than one when the new face draws only on vertices two old
          // faces share; prefer the one that runs the same way round.
          const g =
            cands.find((c) => {
              const old = poly.filter((v) => v < oldNumV && !origins.has(v));
              for (let i = 0; i + 1 < old.length; i++) {
                const a = oldPolys[c]!.indexOf(old[i]!);
                const b = oldPolys[c]!.indexOf(old[i + 1]!);
                if ((b - a + oldPolys[c]!.length) % oldPolys[c]!.length === oldPolys[c]!.length - 1) return false;
              }
              return true;
            }) ?? cands[0]!;
          s = exp.map((e) => [...e!].map(([u, w]) => [g, cornerOf(g, u), w] as [number, number, number]));
        }
      }
      if (!s && !carry.joins) s = byEdges();
      if (!s) {
        failed = true;
        break;
      }
      sources.push(s);
    }
  }

  // A custom normal is not a value to average: Blender keeps it as two
  // angles in the corner's own normal space. Copied corners keep theirs;
  // an interpolated one drops the layer rather than invent a direction.
  const interpolated = !failed && sources.some((f) => f.some((s) => s.length > 1 || (s.length === 1 && s[0]![2] !== 1)));
  for (const k of live) {
    if (failed || (k === "loopNormals" && interpolated)) {
      em[k] = undefined;
      continue;
    }
    const old = em[k]!;
    const layerWidth = old.find((fc) => fc.length > 0)?.[0]?.length ?? 2;
    em[k] = sources.map((face) =>
      face.map((src) => {
        if (src.length === 0) return new Array<number>(layerWidth).fill(0);
        const width = old[src[0]![0]]![src[0]![1]]!.length;
        const out = new Array<number>(width).fill(0);
        for (const [g, c, w] of src) {
          const val = old[g]![c]!;
          for (let j = 0; j < width; j++) out[j] = out[j]! + w * val[j]!;
        }
        return out;
      }),
    );
  }

  // Materials: a face keeps the slot of the face its corners came from. A
  // joined face whose sources disagree takes its first corner's face —
  // `BM_faces_join` keeps its `faces[0]`'s, and which face the caller put
  // first is not reproduced here. Not measured.
  if (em.faceMaterials) {
    const old = em.faceMaterials;
    em.faceMaterials = failed
      ? undefined
      : sources.map((face, i) => {
          const stated = explicitMaterial.get(i);
          if (stated !== undefined) return stated < 0 ? 0 : (old[stated] ?? 0);
          return old[face[0]![0]![0]] ?? 0;
        });
  }

  // Vertex groups: a vertex keeps its weights; a made one mixes its origins'.
  if (em.vertexGroups) {
    let ok = !failed;
    const used = new Set<number>();
    for (const p of newPolys) for (const v of p) used.add(v);
    const mixes = new Map<number, Map<number, number>>();
    for (const v of used) {
      if (v < oldNumV && !origins.has(v)) continue;
      const e = expand(v);
      if (!e) {
        ok = false;
        break;
      }
      mixes.set(v, e);
    }
    if (!ok) em.vertexGroups = undefined;
    else
      for (const [name, g] of em.vertexGroups) {
        const ng = new Map<number, number>();
        for (const [v, w] of g) if (v < oldNumV && !origins.has(v)) ng.set(v, w);
        // `layerInterp_mdeformvert`: a source adds a group only where its
        // weight times the factor is not zero, and the sum is capped at 1.
        for (const [v, mix] of mixes) {
          // A plain copy (a duplicated vertex, `BM_elem_attrs_copy`) keeps
          // membership as it is, a weight of 0 included.
          if (mix.size === 1) {
            const [[u, w]] = [...mix] as [[number, number]];
            if (w === 1) {
              const x = g.get(u);
              if (x !== undefined) ng.set(v, x);
              continue;
            }
          }
          let member = false;
          let sum = 0;
          for (const [u, w] of mix) {
            const x = g.get(u);
            if (x !== undefined && x * w !== 0) {
              member = true;
              sum += w * x;
            }
          }
          if (member) ng.set(v, Math.min(sum, 1));
        }
        em.vertexGroups.set(name, ng);
      }
  }
}

/**
 * Triangle-list convenience wrapper over {@link rebuildPolygons}. Kept for
 * the tri-producing paths (Knife plane cut, unwrap fallbacks, tests).
 */
export function rebuildHalfEdges(em: EditMesh, positions: Float32Array, indices: number[]): void {
  const polys: number[][] = new Array(indices.length / 3);
  for (let f = 0; f < polys.length; f++) {
    polys[f] = [indices[f * 3]!, indices[f * 3 + 1]!, indices[f * 3 + 2]!];
  }
  rebuildPolygons(em, positions, polys);
}

function pairTwin(edgeMap: Map<number, number>, em: EditMesh, k: number, heIdx: number): void {
  const existing = edgeMap.get(k);
  if (existing === undefined) {
    edgeMap.set(k, heIdx);
  } else {
    em.halfEdges[existing]!.twin = heIdx;
    em.halfEdges[heIdx]!.twin = existing;
  }
}

/** Read back the current polygon list (one CCW vertex cycle per face). */
export function toPolygons(em: EditMesh): number[][] {
  const out: number[][] = new Array(em.faces.length);
  for (let f = 0; f < em.faces.length; f++) out[f] = faceVerts(em, f);
  return out;
}

/**
 * Fan-triangulate every face for rendering: polygon (v0…vn₋₁) emits
 * (v0, vᵢ, vᵢ₊₁) for i = 1…n-2. Triangle faces pass through unchanged, so a
 * tri-only mesh round-trips exactly. `triToFace[t]` is the owning face of
 * output triangle `t`.
 */
export function triangulateFaces(em: EditMesh): { indices: number[]; triToFace: number[] } {
  const indices: number[] = [];
  const triToFace: number[] = [];
  for (let f = 0; f < em.faces.length; f++) {
    const verts = faceVerts(em, f);
    for (let i = 1; i + 1 < verts.length; i++) {
      indices.push(verts[0]!, verts[i]!, verts[i + 1]!);
      triToFace.push(f);
    }
  }
  return { indices, triToFace };
}

/**
 * Fan-triangulate a single polygon (standalone list form) — shared by
 * operators that need render triangles without an EditMesh.
 */
export function fanTriangulate(poly: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < poly.length; i++) out.push(poly[0]!, poly[i]!, poly[i + 1]!);
  return out;
}

/** Read back the current triangle index list (fan-triangulated for n-gons). */
export function toIndexArray(em: EditMesh): number[] {
  return triangulateFaces(em).indices;
}
