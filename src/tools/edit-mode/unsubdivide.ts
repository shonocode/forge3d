/**
 * Un-Subdivide — undo a subdivision by dissolving every other vertex.
 *
 * Blender's `bmesh.ops.unsubdivide(verts=, iterations=)`, whose real work is in
 * `bmesh_decimate_unsubdivide.cc`. The API matrix carried this as half-read for
 * three sessions: the counts matched (a 4x4 grid loses 9 of 25 vertices, a 6x6
 * loses 21 of 49, the four corners survive) and two questions did not fall out
 * of two examples — **which** of the two checkerboards, and what a triangle
 * mesh does when no 2-colouring exists. Reading it answered both, and neither
 * answer is what the guesses were.
 *
 * ## Which vertices go
 *
 * Not a parity of `(i + j)`. Per iteration:
 *
 * 1. every vertex the topology test accepts is marked *undecided*;
 * 2. vertices are walked **in index order**, and the first undecided one is
 *    marked **keep** — it seeds an island;
 * 3. the island expands by alternating: undecided neighbours of the keep set
 *    become *collapse*, undecided neighbours of the collapse set become keep,
 *    until nothing expands. Then the walk continues to the next undecided
 *    vertex, which seeds the next island.
 *
 * So the checkerboard is the one whose **first eligible vertex is kept**. On a
 * grid that is the boundary vertex next to a corner, which is why the corners
 * survive and the `(i + j)` even side goes — a description that happens to be
 * true of a grid and is not the rule.
 *
 * ## Which vertices are eligible
 *
 * A topology test, and it is what spares the corners:
 *
 * | edges at the vertex | |
 * |---|---|
 * | 4 manifold, no boundary | interior fan |
 * | 3 manifold, no boundary | interior fan |
 * | 3 with exactly 2 boundary | boundary fan |
 * | 2, both wire | wire chain |
 * | 2, both manifold | interior chain |
 *
 * Anything else — a grid's corner with its two boundary edges, a triangulated
 * grid's interior vertex with six — is not eligible.
 *
 * **That is the whole answer about triangles.** A triangulated grid's interior
 * vertices have valence 6 and its boundary vertices have 2 boundary edges plus
 * two or three more, so **nothing is eligible and the mesh comes back
 * unchanged** — measured, and the same for an icosphere. There was never a
 * 2-colouring to fail at.
 *
 * ## What dissolving does to the faces
 *
 * For a fan: every incident face with more than three corners is first split
 * across the vertex's corner, and then the vertex is dissolved, which merges
 * everything still touching it into one face. The result, expressed without
 * the intermediate steps:
 *
 * - a face with more than three corners loses the vertex from its corner list;
 * - a triangle disappears;
 * - one new face appears: the ring of the vertex's neighbours, in the order the
 *   incident faces chain them.
 *
 * On a 2x2 grid that turns 4 quads into 4 triangles and 1 quad — measured, 9
 * vertices and 4 faces become 8 and 5.
 *
 * For a chain the vertex is simply removed from the faces (or the two wire
 * edges are joined), and no face is added.
 */
import type { MeshData } from "../../lib/mesh";

export interface UnsubdivideOptions {
  /**
   * How many times to repeat. Blender clamps this to at least 1 and stops
   * early when an iteration finds nothing to dissolve — measured on an 8x8
   * grid, where iterations 3 and 4 give the same 27 vertices.
   */
  iterations?: number;
  /**
   * Which vertices may be dissolved. Left out, every vertex is a candidate —
   * which is Blender's `unsubdivide` with everything selected, and the only
   * form the parity rows measure.
   */
  verts?: ReadonlySet<number>;
}

/** What the topology test found, if anything. */
type Method = "fan" | "chain" | "wire";

const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * Dissolve every other vertex, as far as the topology allows.
 *
 * ```ts
 * const coarse = unsubdivide(dense);                 // one pass
 * const coarser = unsubdivide(dense, { iterations: 3 });
 * ```
 *
 * Returns a new mesh. Vertices are renumbered, because dissolving removes
 * some — anything holding vertex indices across this call (a selection, a
 * weight map) has to be remapped by the caller, the same as with
 * `remove_doubles`.
 */
export function unsubdivide(data: MeshData, options: UnsubdivideOptions = {}): MeshData {
  const iterations = Math.max(1, Math.trunc(options.iterations ?? 1));
  let polys = data.polys.map((p) => [...p]);
  let wires = (data.edges ?? []).map((e) => [...e]);
  const positions = Array.from(data.positions);
  const total = positions.length / 3;
  const removed = new Uint8Array(total);

  for (let pass = 0; pass < iterations; pass++) {
    // ── how each edge is used, and which faces touch each vertex ──────────
    const faceCount = new Map<string, number>();
    const facesAt = new Map<number, number[]>();
    for (const [f, poly] of polys.entries()) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        faceCount.set(key(a, b), (faceCount.get(key(a, b)) ?? 0) + 1);
        const list = facesAt.get(a);
        if (list) list.push(f);
        else facesAt.set(a, [f]);
      }
    }
    const wireAt = new Map<number, number[]>();
    for (const e of wires) {
      for (const v of e) {
        const list = wireAt.get(v);
        if (list) list.push(v === e[0] ? e[1]! : e[0]!);
        else wireAt.set(v, [v === e[0] ? e[1]! : e[0]!]);
      }
    }
    const neighbours = new Map<number, Set<number>>();
    const add = (a: number, b: number): void => {
      const s = neighbours.get(a);
      if (s) s.add(b);
      else neighbours.set(a, new Set([b]));
    };
    for (const poly of polys)
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        add(a, b);
        add(b, a);
      }
    for (const e of wires) {
      add(e[0]!, e[1]!);
      add(e[1]!, e[0]!);
    }

    /** Blender's `bm_vert_dissolve_fan_or_chain_test`, the cheap pass. */
    const methodOf = (v: number): Method | null => {
      if (removed[v]) return null;
      if (options.verts && !options.verts.has(v)) return null;
      let boundary = 0;
      let manifold = 0;
      let wire = 0;
      let edges = 0;
      for (const n of neighbours.get(v) ?? []) {
        const used = faceCount.get(key(v, n)) ?? 0;
        if (used === 1) boundary++;
        else if (used === 2) manifold++;
        else if (used === 0) wire++;
        else return null; // three or more faces on an edge
        edges++;
      }
      if (edges === 4 && boundary === 0 && manifold === 4) return "fan";
      if (edges === 3 && boundary === 0 && manifold === 3) return "fan";
      if (edges === 3 && boundary === 2 && manifold === 1) return "fan";
      if (edges === 2 && wire === 2) return "wire";
      if (edges === 2 && manifold === 2) return "chain";
      return null;
    };

    // ── the alternating walk, in index order ──────────────────────────────
    const UNDECIDED = 0;
    const COLLAPSE = 1;
    const KEEP = 2;
    const state = new Uint8Array(total);
    const eligible: (Method | null)[] = new Array(total).fill(null);
    for (let v = 0; v < total; v++) {
      eligible[v] = methodOf(v);
      state[v] = eligible[v] ? UNDECIDED : KEEP;
    }
    let marked = false;
    for (let seed = 0; seed < total; seed++) {
      if (state[seed] !== UNDECIDED) continue;
      state[seed] = KEEP;
      let front = [seed];
      let want = COLLAPSE;
      while (front.length > 0) {
        const next: number[] = [];
        for (const v of front)
          for (const n of neighbours.get(v) ?? [])
            if (state[n] === UNDECIDED) {
              state[n] = want;
              next.push(n);
            }
        if (want === COLLAPSE && next.length > 0) marked = true;
        front = next;
        want = want === COLLAPSE ? KEEP : COLLAPSE;
      }
    }
    // Blender stops when a pass marks nothing: later passes cannot find more.
    if (!marked) break;

    // ── dissolve, in index order ─────────────────────────────────────────
    for (let v = 0; v < total; v++) {
      if (state[v] !== COLLAPSE || removed[v]) continue;
      const method = eligible[v]!;
      if (method === "wire") {
        const ends = wireAt.get(v) ?? [];
        if (ends.length !== 2) continue;
        wires = wires.filter((e) => e[0] !== v && e[1] !== v);
        wires.push([ends[0]!, ends[1]!]);
        removed[v] = 1;
        continue;
      }

      const incident = [...new Set(facesAt.get(v) ?? [])].filter((f) => polys[f]!.includes(v));
      if (incident.length === 0) continue;

      if (method === "chain") {
        for (const f of incident) polys[f] = polys[f]!.filter((x) => x !== v);
        removed[v] = 1;
        continue;
      }

      // A fan. Each incident face gives the pair of neighbours either side of
      // `v`; chaining those pairs walks the ring.
      //
      // **Chained `next -> prev`, not `prev -> next`.** Both give the same
      // ring of vertices and opposite windings, and the wrong one leaves a
      // mesh that is inside out — which no distance measure can see. The
      // parity harness's `facing` and signed volume caught it: `0.0000 mm`
      // with `VOLUME SIGNS OPPOSITE` beside it.
      const step = new Map<number, number>();
      for (const f of incident) {
        const poly = polys[f]!;
        const i = poly.indexOf(v);
        step.set(poly[(i + 1) % poly.length]!, poly[(i - 1 + poly.length) % poly.length]!);
      }
      const startCandidates = [...step.keys()].filter((k) => ![...step.values()].includes(k));
      const start = startCandidates.length > 0 ? startCandidates[0]! : [...step.keys()][0]!;
      const ring: number[] = [start];
      let at = start;
      for (let guard = 0; guard <= step.size; guard++) {
        const nxt = step.get(at);
        if (nxt === undefined || nxt === start) break;
        ring.push(nxt);
        at = nxt;
      }
      if (ring.length < 3) continue;

      for (const f of incident) {
        const poly = polys[f]!;
        if (poly.length > 3) polys[f] = poly.filter((x) => x !== v);
        else polys[f] = [];
      }
      polys.push(ring);
      removed[v] = 1;
    }
    polys = polys.filter((p) => p.length >= 3);
  }

  // ── renumber, dropping the dissolved vertices ──────────────────────────
  const remap = new Int32Array(total).fill(-1);
  const out: number[] = [];
  for (let v = 0; v < total; v++) {
    if (removed[v]) continue;
    remap[v] = out.length / 3;
    out.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
  }
  const result: MeshData = {
    positions: Float32Array.from(out),
    polys: polys.map((p) => p.map((v) => remap[v]!)),
  };
  const keptWires = wires
    .filter((e) => remap[e[0]!]! >= 0 && remap[e[1]!]! >= 0)
    .map((e) => [remap[e[0]!]!, remap[e[1]!]!]);
  if (keptWires.length > 0) result.edges = keptWires;
  return result;
}
