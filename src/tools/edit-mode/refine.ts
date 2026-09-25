/**
 * Adding detail, relaxing it, and closing what is left open.
 *
 * Four Blender operators whose defaults are worth stating out loud, because
 * all three of the surprising ones cost a reader an hour if they are assumed:
 *
 * - {@link subdivideEdges} splits a face by **how many** of its edges are cut,
 *   and the two counts people try first are the two that leave it whole: one
 *   cut edge makes a pentagon, all four an octagon (Blender's UI Subdivide
 *   passes `use_grid_fill`, the operator does not). Two or three cut edges do
 *   split. {@link bisectEdges} never splits.
 * - {@link smoothVert} **moves nothing** unless an axis is enabled. All three
 *   `use_axis_*` default to false.
 * - {@link holesFill}'s `sides` is a **maximum**, not a count, and the
 *   operation fills every boundary loop it is given — including the outer one.
 *
 * All measured against Blender 5.1.1; see `tools/modeling/parity/README.md`.
 *
 * Pure and headless — Vitest-pinned.
 */
import { scanfillTriangles } from "./triangle-fill";
import { rebuildPolygons, seamKey, toPolygons, type EditMesh } from "./half-edge";

// ── poke ───────────────────────────────────────────────────────────────────

/** Options for {@link poke}. */
export interface PokeOptions {
  /** Move the new centre vertex along the face normal. Blender's `offset`. */
  offset?: number;
  /**
   * Where the centre goes. Blender's `center_mode`, and its default is
   * `MEAN_WEIGHTED`.
   *
   * - `MEAN` — the plain average of the face's vertices.
   * - `MEAN_WEIGHTED` — each vertex weighted by the two edges meeting at it,
   *   so a long thin face's centre sits nearer its long side. On a trapezoid
   *   this is the difference between y = 0.5 and y = 0.3867; measured.
   * - `BOUNDS` — the middle of the face's bounding box.
   */
  centerMode?: "MEAN" | "MEAN_WEIGHTED" | "BOUNDS";
}

/**
 * Split each selected face into a fan of triangles around a new centre vertex
 * — Blender's `bmesh.ops.poke(faces=, offset=, center_mode=)`.
 *
 * The other way to make a concave n-gon safe for Catmull-Clark: where
 * `connectVertsConcave` cuts it into convex pieces and keeps quads,
 * this always triangulates and always adds a vertex. Poking is what you want
 * when the face should get a spike or a dimple (`offset`), and the other when
 * you want the topology tidied without adding anything.
 *
 * Returns the new triangles.
 */
export function poke(
  em: EditMesh,
  selectedFaces: ReadonlySet<number>,
  opts: PokeOptions = {},
): Set<number> {
  if (selectedFaces.size === 0) return new Set();
  const mode = opts.centerMode ?? "MEAN_WEIGHTED";
  const offset = opts.offset ?? 0;

  const polys = toPolygons(em);
  const P = em.positions;
  const positions: number[] = Array.from(P);
  let nextV = em.vertices.length;

  const out: number[][] = [];
  for (let f = 0; f < polys.length; f++) if (!selectedFaces.has(f)) out.push(polys[f]!);

  const start = out.length;
  for (const f of selectedFaces) {
    const poly = polys[f]!;
    const n = poly.length;

    let cx = 0;
    let cy = 0;
    let cz = 0;
    if (mode === "BOUNDS") {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const v of poly) {
        minX = Math.min(minX, P[v * 3]!); maxX = Math.max(maxX, P[v * 3]!);
        minY = Math.min(minY, P[v * 3 + 1]!); maxY = Math.max(maxY, P[v * 3 + 1]!);
        minZ = Math.min(minZ, P[v * 3 + 2]!); maxZ = Math.max(maxZ, P[v * 3 + 2]!);
      }
      cx = (minX + maxX) / 2; cy = (minY + maxY) / 2; cz = (minZ + maxZ) / 2;
    } else {
      let total = 0;
      for (let i = 0; i < n; i++) {
        const v = poly[i]!;
        let w = 1;
        if (mode === "MEAN_WEIGHTED") {
          const prev = poly[(i + n - 1) % n]!;
          const next = poly[(i + 1) % n]!;
          w =
            Math.hypot(P[v * 3]! - P[prev * 3]!, P[v * 3 + 1]! - P[prev * 3 + 1]!, P[v * 3 + 2]! - P[prev * 3 + 2]!) +
            Math.hypot(P[v * 3]! - P[next * 3]!, P[v * 3 + 1]! - P[next * 3 + 1]!, P[v * 3 + 2]! - P[next * 3 + 2]!);
        }
        cx += P[v * 3]! * w; cy += P[v * 3 + 1]! * w; cz += P[v * 3 + 2]! * w;
        total += w;
      }
      if (total > 1e-20) { cx /= total; cy /= total; cz /= total; }
    }

    if (offset !== 0) {
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < n; i++) {
        const a = poly[i]! * 3;
        const b = poly[(i + 1) % n]! * 3;
        nx += (P[a + 1]! - P[b + 1]!) * (P[a + 2]! + P[b + 2]!);
        ny += (P[a + 2]! - P[b + 2]!) * (P[a]! + P[b]!);
        nz += (P[a]! - P[b]!) * (P[a + 1]! + P[b + 1]!);
      }
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-20) { cx += (nx / len) * offset; cy += (ny / len) * offset; cz += (nz / len) * offset; }
    }

    const centre = nextV++;
    positions.push(cx, cy, cz);
    for (let i = 0; i < n; i++) out.push([poly[i]!, poly[(i + 1) % n]!, centre]);
  }
  const end = out.length;

  rebuildPolygons(em, new Float32Array(positions), out);
  const sel = new Set<number>();
  for (let i = start; i < end; i++) sel.add(i);
  return sel;
}

// ── subdivideEdges ─────────────────────────────────────────────────────────

/**
 * How a quad with two **adjacent** edges cut is split. Blender's
 * `quad_corner_type`.
 *
 * `bmesh.ops.subdivide_edges` defaults to **`STRAIGHT_CUT`** — its enum slot
 * starts at the first entry of the list, measured on 2026-09-25 (no inner
 * vertex appears). The UI's Subdivide passes `INNER_VERT` explicitly.
 *
 * - `STRAIGHT_CUT` — no pattern; the cut points are joined straight across
 *   the corner, nested (`cuts` edges, `cuts` + 1 faces)
 * - `INNER_VERT` — each join gets a midpoint and the midpoints run to the
 *   far corner, so the corner comes out as quads
 * - `PATH` — the joins, plus one from the far corner's neighbour across
 * - `FAN` — every cut point joined to the far corner
 */
export type SubdivideCornerType = "STRAIGHT_CUT" | "INNER_VERT" | "PATH" | "FAN";

/** Options for {@link subdivideEdges}. */
export interface SubdivideEdgesOptions {
  /** New vertices per edge. Blender's `cuts`. */
  cuts: number;
  /**
   * Split a quad with all four edges cut into a grid of quads, and a
   * triangle with all three cut into a grid of triangles. Blender's
   * `use_grid_fill`, **off by default in the operator** and on in the UI's
   * Subdivide, which is why a quad subdivides into four there and into one
   * octagon here.
   */
  useGridFill?: boolean;
  /**
   * Split a quad or triangle with exactly **one** edge cut, by fanning the
   * cut points to the opposite corner(s). Blender's `use_single_edge`, off
   * by default — the face then just gains the vertices.
   */
  useSingleEdge?: boolean;
  /** Blender's `quad_corner_type`. Default `STRAIGHT_CUT`; see the type. */
  cornerType?: SubdivideCornerType;
  /** Leave every face that is not a quad unsplit. Blender's `use_only_quads`. */
  useOnlyQuads?: boolean;
}

/**
 * Put `cuts` new vertices along each selected edge and split the faces those
 * edges belong to — Blender's `bmesh.ops.subdivide_edges(edges=, cuts=,
 * use_grid_fill=, use_single_edge=, quad_corner_type=, use_only_quads=)`,
 * ported from `bmesh/operators/bmo_subdivide.cc` (Blender 5.1.1).
 *
 * Which faces split depends on how many of their edges are cut, and it is
 * not "only when all of them are":
 *
 * | cut edges | quad | triangle | n-gon |
 * |---|---|---|---|
 * | 1 | grows (split with `useSingleEdge`) | grows (split with `useSingleEdge`) | grows |
 * | 2 adjacent | `cornerType` | joined | joined |
 * | 2 apart | joined straight across | ― | joined |
 * | 3 | `quad_3edge`, always | grows (grid with `useGridFill`) | grows |
 * | 4 | grows (grid with `useGridFill`) | ― | grows |
 *
 * "Joined" is Blender's pattern-less path: the k-th cut on one edge to the
 * k-th from the far end of the other. It is skipped for a pair of cut points
 * that also share some **other** face (Blender #32500), and for two adjacent
 * edges within about 0.8° of a straight line.
 *
 * `cuts: 0` is not a no-op, as in Blender: no vertex is added, but the
 * patterns still run, so `INNER_VERT` and `PATH` join two corners of a quad
 * whose two adjacent edges were selected.
 *
 * A cut edge's crease, seam and sharp flag go to every piece of it
 * (`BM_edge_split` copies the edge's attributes). UV / colour / normal
 * layers and vertex groups are not carried — see `EditMesh.loopUVs`.
 *
 * The #32500 test is made once against the faces as they were; Blender makes
 * it as it goes, after earlier faces have split, and its
 * `connect_smallest_face` may pick a smaller neighbour holding both points.
 * The two differ only for faces sharing two edges with degree-2 corners.
 *
 * Not ported: `smooth` / `smooth_falloff` / `use_smooth_even` / `fractal` /
 * `along_normal` / `seed` / `use_sphere` / `edge_percents` — the new
 * vertices sit evenly on the straight edge.
 *
 * Returns the faces that were cut or grew.
 */
export function subdivideEdges(
  em: EditMesh,
  selectedEdges: ReadonlySet<number>,
  opts: SubdivideEdgesOptions,
): Set<number> {
  return subdivide(em, selectedEdges, Math.max(0, Math.floor(opts.cuts)), opts);
}

/**
 * Put `cuts` new vertices along each selected edge and **split nothing** —
 * Blender's `bmesh.ops.bisect_edges(edges=, cuts=)`. Every face on a cut
 * edge just gains the vertices: a quad with one edge cut becomes a pentagon,
 * with all four an octagon. `edge_percents` is not ported (the cuts are even).
 *
 * Returns the faces that grew.
 */
export function bisectEdges(
  em: EditMesh,
  selectedEdges: ReadonlySet<number>,
  cuts: number,
): Set<number> {
  return subdivide(em, selectedEdges, Math.max(0, Math.floor(cuts)), null);
}

/** One of `bmo_subdivide.cc`'s face patterns: which edges are cut, and the fill. */
interface SubdPattern {
  sel: readonly number[];
  fill: (c: FaceSplitter, verts: readonly number[], n: number) => void;
}

/**
 * The fragments of one face being split, and the two BMesh moves the
 * patterns are written in: `connect_smallest_face` and cutting an edge.
 *
 * Kept to the one face on purpose. Blender's `connect_smallest_face` looks at
 * every face around the vertex, but both ends are on this face's boundary,
 * so another face could only hold both by sharing two edges with it — the
 * case the pattern-less path checks for separately (#32500).
 */
class FaceSplitter {
  readonly frags: number[][];
  private readonly positions: number[];
  private readonly nextV: { n: number };

  constructor(first: number[], positions: number[], nextV: { n: number }) {
    this.frags = [first];
    this.positions = positions;
    this.nextV = nextV;
  }

  /**
   * Split the smallest fragment holding both `a` and `b` (not side by side)
   * along a new edge a–b. False if none holds both.
   */
  connect(a: number, b: number): boolean {
    let best = -1;
    let ia = -1;
    let ib = -1;
    for (let f = 0; f < this.frags.length; f++) {
      const fr = this.frags[f]!;
      const i = fr.indexOf(a);
      const j = fr.indexOf(b);
      if (i < 0 || j < 0) continue;
      const d = (j - i + fr.length) % fr.length;
      if (d === 1 || d === fr.length - 1) continue;
      if (best < 0 || fr.length < this.frags[best]!.length) {
        best = f;
        ia = i;
        ib = j;
      }
    }
    if (best < 0) return false;
    const fr = this.frags[best]!;
    const one: number[] = [];
    for (let k = ia; ; k = (k + 1) % fr.length) {
      one.push(fr[k]!);
      if (k === ib) break;
    }
    const two: number[] = [];
    for (let k = ib; ; k = (k + 1) % fr.length) {
      two.push(fr[k]!);
      if (k === ia) break;
    }
    this.frags[best] = one;
    this.frags.push(two);
    return true;
  }

  /**
   * Put `k` evenly spaced vertices on the edge a–b, in order from `a`, in
   * every fragment that has that edge. Blender's `subdivide_edge_num` on an
   * edge just made by `connect`, whose `v1` is the first vertex it joined.
   */
  cut(a: number, b: number, k: number): number[] {
    const P = this.positions;
    const made: number[] = [];
    for (let j = 1; j <= k; j++) {
      const t = j / (k + 1);
      made.push(this.nextV.n++);
      P.push(
        P[a * 3]! + (P[b * 3]! - P[a * 3]!) * t,
        P[a * 3 + 1]! + (P[b * 3 + 1]! - P[a * 3 + 1]!) * t,
        P[a * 3 + 2]! + (P[b * 3 + 2]! - P[a * 3 + 2]!) * t,
      );
    }
    for (let f = 0; f < this.frags.length; f++) {
      const fr = this.frags[f]!;
      for (let i = 0; i < fr.length; i++) {
        const x = fr[i]!;
        const y = fr[(i + 1) % fr.length]!;
        if (x === a && y === b) {
          fr.splice(i + 1, 0, ...made);
          break;
        }
        if (x === b && y === a) {
          fr.splice(i + 1, 0, ...[...made].reverse());
          break;
        }
      }
    }
    return made;
  }
}

// The patterns, transcribed from `bmo_subdivide.cc`. `verts` starts at the
// first cut on the pattern's edge 0 and runs round the grown face, so with
// n cuts a quad's corners sit at n, 2n+1, 3n+2, … as each edge adds n.

const QUAD_1EDGE: SubdPattern = {
  sel: [1, 0, 0, 0],
  fill(c, v, n) {
    let add = 2;
    if (n % 2 === 0) {
      for (let i = 0; i < n; i++) {
        if (i === n / 2) add -= 1;
        c.connect(v[i]!, v[n + add]!);
      }
    } else {
      for (let i = 0; i < n; i++) {
        c.connect(v[i]!, v[n + add]!);
        if (i === Math.floor(n / 2)) {
          add -= 1;
          c.connect(v[i]!, v[n + add]!);
        }
      }
    }
  },
};

const QUAD_2EDGE_PATH: SubdPattern = {
  sel: [1, 1, 0, 0],
  fill(c, v, n) {
    for (let i = 0; i < n; i++) c.connect(v[i]!, v[n + (n - i)]!);
    c.connect(v[n * 2 + 3]!, v[n * 2 + 1]!);
  },
};

const QUAD_2EDGE_INNERVERT: SubdPattern = {
  sel: [1, 1, 0, 0],
  fill(c, v, n) {
    let last = v[n]!;
    for (let i = n - 1; i >= 0; i--) {
      const a = v[i]!;
      const b = v[n + (n - i)]!;
      c.connect(a, b);
      const mid = c.cut(a, b, 1)[0]!;
      if (i !== n - 1) c.connect(last, mid);
      last = mid;
    }
    c.connect(last, v[n * 2 + 2]!);
  },
};

const QUAD_2EDGE_FAN: SubdPattern = {
  sel: [1, 1, 0, 0],
  fill(c, v, n) {
    for (let i = 0; i < n; i++) {
      c.connect(v[i]!, v[n * 2 + 2]!);
      c.connect(v[n + (n - i)]!, v[n * 2 + 2]!);
    }
  },
};

const QUAD_3EDGE: SubdPattern = {
  sel: [1, 1, 1, 0],
  fill(c, v, n) {
    let add = 0;
    const half = Math.floor(n / 2);
    for (let i = 0; i < n; i++) {
      if (i === half) {
        if (n % 2 !== 0) c.connect(v[n - i - 1 + add]!, v[i + n + 1]!);
        add = n * 2 + 2;
      }
      c.connect(v[n - i - 1 + add]!, v[i + n + 1]!);
    }
    for (let i = 0; i < half + 1; i++) c.connect(v[i]!, v[n - i + n * 2 + 1]!);
  },
};

const QUAD_4EDGE: SubdPattern = {
  sel: [1, 1, 1, 1],
  fill(c, v, n) {
    const s = n + 2;
    const lines: number[] = new Array(s * s).fill(-1);
    for (let i = 0; i < s; i++) lines[i] = v[n * 3 + 2 + (n - i + 1)]!;
    for (let i = 0; i < s; i++) lines[(s - 1) * s + i] = v[n + i]!;
    for (let i = 0; i < n; i++) {
      const a = v[i]!;
      const b = v[n + 1 + n + 1 + (n - i - 1)]!;
      if (!c.connect(a, b)) continue;
      lines[(i + 1) * s] = a;
      lines[(i + 1) * s + s - 1] = b;
      const made = c.cut(a, b, n);
      for (let j = 0; j < n; j++) lines[(i + 1) * s + j + 1] = made[j]!;
    }
    for (let i = 1; i < n + 2; i++)
      for (let j = 1; j <= n; j++) {
        const a = lines[i * s + j]!;
        const b = lines[(i - 1) * s + j]!;
        if (a >= 0 && b >= 0) c.connect(a, b);
      }
  },
};

const TRI_1EDGE: SubdPattern = {
  sel: [1, 0, 0],
  fill(c, v, n) {
    for (let i = 0; i < n; i++) c.connect(v[i]!, v[n + 1]!);
  },
};

const TRI_3EDGE: SubdPattern = {
  sel: [1, 1, 1],
  fill(c, v, n) {
    const lines: number[][] = [[v[n * 2 + 1]!]];
    const rows: number[][] = [];
    for (let i = 0; i < n; i++) {
      const a = v[n * 2 + 2 + i]!;
      const b = v[n + n - i]!;
      if (!c.connect(a, b)) return;
      rows.push([a, ...c.cut(a, b, i), b]);
    }
    lines.push(...rows);
    lines.push([v[n * 3 + 2]!, ...v.slice(0, n), v[n]!]);
    for (let i = 1; i <= n; i++)
      for (let j = 0; j < i; j++) {
        c.connect(lines[i]![j]!, lines[i + 1]![j + 1]!);
        c.connect(lines[i]![j + 1]!, lines[i + 1]![j + 1]!);
      }
  },
};

const CORNER: Record<SubdivideCornerType, SubdPattern | null> = {
  STRAIGHT_CUT: null,
  INNER_VERT: QUAD_2EDGE_INNERVERT,
  PATH: QUAD_2EDGE_PATH,
  FAN: QUAD_2EDGE_FAN,
};

/** Two adjacent cut edges closer to a straight line than this don't join. */
const FACE_SPLIT_EPSILON = 0.00005;

/** `subdivideEdges` and `bisectEdges`; `opts` null means split nothing. */
function subdivide(
  em: EditMesh,
  selectedEdges: ReadonlySet<number>,
  cuts: number,
  opts: SubdivideEdgesOptions | null,
): Set<number> {
  // cuts=0 still runs the patterns in Blender: INNER_VERT and PATH then join
  // two corners of a quad with two adjacent edges selected (a diagonal).
  if (selectedEdges.size === 0 || (cuts === 0 && !opts)) return new Set();

  const polys = toPolygons(em);
  const P = em.positions;
  const positions: number[] = Array.from(P);
  const nextV = { n: em.vertices.length };

  // One set of new vertices per undirected edge, shared by both its faces.
  const cutsOn = new Map<string, number[]>();
  for (const he of selectedEdges) {
    const h = em.halfEdges[he];
    if (!h) continue;
    const a = h.v;
    const b = em.halfEdges[h.next]!.v;
    const key = seamKey(a, b);
    if (cutsOn.has(key)) continue;
    const made: number[] = [];
    for (let k = 1; k <= cuts; k++) {
      const t = k / (cuts + 1);
      made.push(nextV.n++);
      positions.push(
        P[a * 3]! + (P[b * 3]! - P[a * 3]!) * t,
        P[a * 3 + 1]! + (P[b * 3 + 1]! - P[a * 3 + 1]!) * t,
        P[a * 3 + 2]! + (P[b * 3 + 2]! - P[a * 3 + 2]!) * t,
      );
    }
    // Stored low-to-high so both faces can read it in their own direction.
    cutsOn.set(key, a < b ? made : made.reverse());
    if (cuts > 0) carryEdgeFlags(em, a, b, a < b ? made : [...made].reverse());
  }

  // The pattern table in `bmo_subdivide.cc`'s order; the first that matches
  // (at its first rotation) wins.
  const patterns: SubdPattern[] = [];
  if (opts) {
    if (opts.useSingleEdge) patterns.push(QUAD_1EDGE);
    const corner = CORNER[opts.cornerType ?? "STRAIGHT_CUT"];
    if (corner) patterns.push(corner);
    if (opts.useSingleEdge) patterns.push(TRI_1EDGE);
    if (opts.useGridFill) patterns.push(QUAD_4EDGE);
    patterns.push(QUAD_3EDGE);
    if (opts.useGridFill) patterns.push(TRI_3EDGE);
  }

  // Which faces each cut edge belongs to, for #32500 below.
  const facesOf = new Map<string, number[]>();
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    for (let i = 0; i < poly.length; i++) {
      const key = seamKey(poly[i]!, poly[(i + 1) % poly.length]!);
      if (!cutsOn.has(key)) continue;
      const list = facesOf.get(key);
      if (list) list.push(f);
      else facesOf.set(key, [f]);
    }
  }

  const out: number[][] = [];
  const touched = new Set<number>();
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    const len = poly.length;
    const keys: string[] = [];
    const sel: boolean[] = [];
    let totesel = 0;
    for (let i = 0; i < len; i++) {
      keys.push(seamKey(poly[i]!, poly[(i + 1) % len]!));
      sel.push(cutsOn.has(keys[i]!));
      if (sel[i]) totesel++;
    }
    if (totesel === 0) {
      out.push(poly);
      continue;
    }

    const grown: number[] = [];
    const startOf: number[] = []; // index in `grown` of each original corner
    for (let i = 0; i < len; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % len]!;
      startOf.push(grown.length);
      grown.push(a);
      const made = cutsOn.get(keys[i]!);
      if (made) grown.push(...(a < b ? made : [...made].reverse()));
    }

    const splitter = new FaceSplitter(grown, positions, nextV);
    if (opts && !(opts.useOnlyQuads && len !== 4)) {
      let pat: SubdPattern | null = null;
      let rot = 0;
      for (const p of patterns) {
        if (p.sel.length !== len) continue;
        for (let a = 0; a < len && !pat; a++) {
          let ok = true;
          for (let b = 0; b < len && ok; b++) ok = sel[(b + a) % len] === (p.sel[b] === 1);
          if (ok) {
            pat = p;
            rot = a;
          }
        }
        if (pat) break;
      }

      if (pat) {
        const from = startOf[rot]! + 1;
        const verts = grown.map((_, k) => grown[(from + k) % grown.length]!);
        pat.fill(splitter, verts, cuts);
      } else if (totesel === 2 && !nearlyStraight(poly, sel, P)) {
        joinTwoEdges(splitter, grown, f, keys, sel, cutsOn, facesOf, cuts);
      }
    }

    const changed = splitter.frags.length > 1 || grown.length > len;
    for (const fr of splitter.frags) {
      if (changed) touched.add(out.length);
      out.push(fr);
    }
  }

  rebuildPolygons(em, new Float32Array(positions), out);
  return touched;
}

/**
 * The edge a–b is now a, …`made`…, b: give every piece the crease, seam and
 * sharp flag the whole edge had, and drop the old key. Blender's
 * `BM_edge_split` copies the edge's attributes to the new half the same way.
 */
function carryEdgeFlags(em: EditMesh, a: number, b: number, made: readonly number[]): void {
  const key = seamKey(a, b);
  const chain = [a, ...made, b];
  const pieces: string[] = [];
  for (let i = 0; i + 1 < chain.length; i++) pieces.push(seamKey(chain[i]!, chain[i + 1]!));
  const crease = em.creases.get(key);
  if (crease !== undefined) {
    em.creases.delete(key);
    for (const k of pieces) em.creases.set(k, crease);
  }
  if (em.seams.delete(key)) for (const k of pieces) em.seams.add(k);
  if (em.sharpEdges?.delete(key)) for (const k of pieces) em.sharpEdges.add(k);
}

/**
 * Two cut edges that share a vertex and point the same way (or exactly
 * opposite) to within `FACE_SPLIT_EPSILON`: Blender leaves that face whole.
 */
function nearlyStraight(poly: readonly number[], sel: readonly boolean[], P: ArrayLike<number>): boolean {
  const len = poly.length;
  const picked: number[] = [];
  for (let i = 0; i < len; i++) if (sel[i]) picked.push(i);
  const [i, j] = picked as [number, number];
  const e1 = [poly[i]!, poly[(i + 1) % len]!];
  const e2 = [poly[j]!, poly[(j + 1) % len]!];
  if (!e1.some((v) => e2.includes(v))) return false;
  const dir = (e: number[]) => {
    const d = [0, 1, 2].map((k) => P[e[1]! * 3 + k]! - P[e[0]! * 3 + k]!);
    const l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    return d.map((x) => x / l);
  };
  const a = dir(e1);
  const b = dir(e2);
  return Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) > 1 - FACE_SPLIT_EPSILON;
}

/**
 * The pattern-less path for a face with two cut edges: the first cut on one
 * edge to the last on the other, and inwards from there. A pair whose two
 * points also share another face is skipped (#32500 — two faces on the same
 * two edges, where cutting both along the same line is ambiguous).
 */
function joinTwoEdges(
  c: FaceSplitter,
  grown: readonly number[],
  f: number,
  keys: readonly string[],
  sel: readonly boolean[],
  cutsOn: ReadonlyMap<string, number[]>,
  facesOf: ReadonlyMap<string, number[]>,
  n: number,
): void {
  const inner = new Set<number>();
  for (const made of cutsOn.values()) for (const v of made) inner.add(v);
  const vlen = grown.length;
  const isIn = (k: number) => inner.has(grown[((k % vlen) + vlen) % vlen]!);

  let a = 0;
  for (; a < vlen; a++) if (!isIn(a - 1) && isIn(a)) break;
  let b = 0;
  if (isIn(a + n + 1)) b = (a + n + 1) % vlen;
  else
    for (let j = 0; j < vlen; j++) {
      b = (j + a + n + 1) % vlen;
      if (!isIn(b - 1) && isIn(b)) break;
    }
  b += n - 1;

  // Another face on both cut edges (#32500): every pair on them is shared.
  const [k1, k2] = keys.filter((_, i) => sel[i]) as [string, string];
  const other = (facesOf.get(k1) ?? []).some((g) => g !== f && (facesOf.get(k2) ?? []).includes(g));

  const pairs: [number, number][] = [];
  for (let j = 0; j < n; j++) {
    if (!other) pairs.push([grown[a % vlen]!, grown[((b % vlen) + vlen) % vlen]!]);
    b -= 1;
    a = (a + 1) % vlen;
  }
  for (const [x, y] of pairs) c.connect(x, y);
}

// ── smoothVert ─────────────────────────────────────────────────────────────

/** Options for {@link smoothVert}. */
export interface SmoothVertOptions {
  /** How far toward the neighbours' average, 0..1. Blender's `factor`. */
  factor: number;
  /**
   * Which axes are allowed to move. **All three default to false**, which is
   * Blender's default and means the call does nothing — measured, and the
   * kind of silence that reads as a broken operator.
   */
  useAxisX?: boolean;
  useAxisY?: boolean;
  useAxisZ?: boolean;
}

/**
 * Move each selected vertex toward the average of the vertices it shares an
 * edge with — Blender's `bmesh.ops.smooth_vert(verts=, factor=, use_axis_*=)`.
 *
 * `factor = 1` lands exactly on that average: measured on a vertex lifted to
 * z = 1 with neighbours at 0, 0 and 1, which comes back at 1/3.
 *
 * Positions only; nothing is added or removed. Run it twice for more.
 */
export function smoothVert(
  em: EditMesh,
  selectedVerts: ReadonlySet<number>,
  opts: SmoothVertOptions,
): void {
  const mask = [opts.useAxisX ?? false, opts.useAxisY ?? false, opts.useAxisZ ?? false];
  if (selectedVerts.size === 0 || !mask.some(Boolean) || opts.factor === 0) return;

  const polys = toPolygons(em);
  const neighbours = new Map<number, Set<number>>();
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        const set = neighbours.get(x!);
        if (set) set.add(y!);
        else neighbours.set(x!, new Set([y!]));
      }
    }

  const P = em.positions;
  const moved: Array<[number, number, number, number]> = [];
  for (const v of selectedVerts) {
    const near = neighbours.get(v);
    if (!near || near.size === 0) continue;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const n of near) {
      sx += P[n * 3]!;
      sy += P[n * 3 + 1]!;
      sz += P[n * 3 + 2]!;
    }
    moved.push([v, sx / near.size, sy / near.size, sz / near.size]);
  }

  // Every target is read before anything moves, or a vertex would be smoothed
  // toward neighbours that had already moved this pass.
  for (const [v, tx, ty, tz] of moved) {
    const target = [tx, ty, tz];
    for (let k = 0; k < 3; k++) {
      if (!mask[k]) continue;
      P[v * 3 + k] = P[v * 3 + k]! + (target[k]! - P[v * 3 + k]!) * opts.factor;
    }
  }
}

// ── holesFill ──────────────────────────────────────────────────────────────

/** Options for {@link holesFill}. */
export interface HolesFillOptions {
  /**
   * The **largest** hole to fill, counted in edges. Blender's `sides`, and 0
   * means no limit.
   *
   * Measured: a square hole in a grid is filled at `sides = 0` and left alone
   * at `sides = 3`, which is what makes it a maximum rather than a count.
   */
  sides?: number;
}

/**
 * Close every open loop with a single face — Blender's
 * `bmesh.ops.holes_fill(edges=, sides=)`.
 *
 * **Including the outer one.** A grid with a face punched out has two boundary
 * loops, the hole and the grid's own border, and both get filled — measured, 3
 * faces become 5. That is the operation, not a bug in it: "hole" means "loop
 * with nothing on one side", and a flat sheet's rim qualifies.
 *
 * Returns the new faces.
 */
export function holesFill(em: EditMesh, opts: HolesFillOptions = {}): Set<number> {
  const limit = opts.sides ?? 0;
  const polys = toPolygons(em);

  // Boundary half-edges, in the direction their face traverses them. The fill
  // face runs the other way, or its normal would face into the surface.
  const next = new Map<number, number>();
  for (let he = 0; he < em.halfEdges.length; he++) {
    const h = em.halfEdges[he]!;
    if (h.twin >= 0) continue;
    next.set(em.halfEdges[h.next]!.v, h.v);
  }

  const out = polys.map((p) => p);
  const start = out.length;
  const seen = new Set<number>();

  for (const from of next.keys()) {
    if (seen.has(from)) continue;
    const loop: number[] = [from];
    seen.add(from);
    let cur = next.get(from)!;
    let ok = true;
    while (cur !== from) {
      if (cur === undefined || seen.has(cur) || loop.length > next.size) {
        ok = false;
        break;
      }
      seen.add(cur);
      loop.push(cur);
      cur = next.get(cur)!;
    }
    if (!ok || loop.length < 3) continue;
    if (limit > 0 && loop.length > limit) continue;
    out.push(loop);
  }

  if (out.length === start) return new Set();
  rebuildPolygons(em, em.positions, out);
  const sel = new Set<number>();
  for (let i = start; i < out.length; i++) sel.add(i);
  return sel;
}

// ── Filling a named loop ───────────────────────────────────────────────────

/**
 * Walk a set of boundary edges into the closed loops they form.
 *
 * Shared by the three fills. Returns one vertex ring per loop, wound so the
 * face built from it faces the way the surrounding surface does — a fill run
 * the other way is a hole with a lid on backwards, which nothing but the
 * volume column would report.
 *
 * Edges that do not close into a ring are left out rather than guessed at.
 */
function loopsFromEdges(em: EditMesh, selectedEdges: ReadonlySet<number>): number[][] {
  // Boundary half-edges in the direction their own face traverses them. The
  // fill runs the other way, or its normal points into the surface.
  const next = new Map<number, number>();
  for (const heRaw of selectedEdges) {
    const h = em.halfEdges[heRaw];
    if (!h || h.twin >= 0) continue; // interior: not a hole's border
    next.set(em.halfEdges[h.next]!.v, h.v);
  }

  const out: number[][] = [];
  const seen = new Set<number>();
  for (const from of next.keys()) {
    if (seen.has(from)) continue;
    const loop: number[] = [from];
    seen.add(from);
    let cur = next.get(from)!;
    let ok = true;
    while (cur !== from) {
      if (cur === undefined || seen.has(cur) || loop.length > next.size) {
        ok = false;
        break;
      }
      seen.add(cur);
      loop.push(cur);
      cur = next.get(cur)!;
    }
    if (ok && loop.length >= 3) out.push(loop);
  }
  return out;
}

/**
 * Close each named loop with **one** face — Blender's
 * `bmesh.ops.edgeloop_fill(edges=)`.
 *
 * The difference from {@link holesFill} is the selection: that one finds every
 * open loop in the mesh and closes them all, this one closes the loops you
 * name. On a sheet with a square hole punched in it, handing over the hole's
 * four edges gives one quad back and leaves the sheet's own rim open —
 * measured, 15 faces become 16 and the area goes from 0.9375 to 1.0.
 *
 * **Interior edges in the selection are ignored rather than refused**: an edge
 * with a face on both sides is not part of any hole, so there is nothing for
 * it to close. A selection made only of those fills nothing and returns an
 * empty set — read the return value rather than assuming.
 *
 * Returns the new faces.
 */
export function edgeloopFill(em: EditMesh, selectedEdges: ReadonlySet<number>): Set<number> {
  const loops = loopsFromEdges(em, selectedEdges);
  if (loops.length === 0) return new Set();

  const out = toPolygons(em);
  const start = out.length;
  for (const loop of loops) out.push(loop);
  rebuildPolygons(em, em.positions, out);

  const made = new Set<number>();
  for (let i = start; i < out.length; i++) made.add(i);
  return made;
}

/**
 * The same, but filled with **triangles** — Blender's
 * `bmesh.ops.triangle_fill(use_beauty=False)`: the whole edge selection is
 * projected onto one plane and filled by `BLI_scanfill`'s sweep line, holes
 * and several loops at once, then wound like the faces already on the
 * boundary. The port is `triangle-fill.ts`.
 *
 * (Until 2026-09-25 this fanned each loop on its own and was declared a
 * different algorithm: a tube's two rims gave 32 faces where Blender gives
 * 18, since the sweep line fills the *pair* of rims as one region with a
 * hole.)
 */
export function triangleFill(em: EditMesh, selectedEdges: ReadonlySet<number>): Set<number> {
  const tris = scanfillTriangles(em, [...selectedEdges]);
  if (tris.length === 0) return new Set();
  const out = toPolygons(em);
  const start = out.length;
  // `BM_CREATE_NO_DOUBLE`: a triangle that is already a face is not made again.
  const have = new Set(out.map((p) => [...p].sort((x, y) => x - y).join(",")));
  for (const t of tris) {
    const k = [...t].sort((x, y) => x - y).join(",");
    if (have.has(k)) continue;
    have.add(k);
    out.push(t);
  }
  rebuildPolygons(em, em.positions, out);
  const made = new Set<number>();
  for (let i = start; i < out.length; i++) made.add(i);
  return made;
}

/**
 * Close the loops in an edge selection — Blender's
 * `bmesh.ops.edgenet_fill(edges=)`.
 *
 * **Measured to agree with {@link edgeloopFill} on a single closed loop**, and
 * that is the whole of what can be compared here. Blender's version is more
 * general: it takes a *net* of loose edges crossing a region and works out the
 * faces between them. forge3d's `MeshData` is positions and polygons with no
 * wire edges in it, so a net has nowhere to live, and the general case is not
 * reachable rather than unimplemented.
 *
 * Kept as its own name because the two are different operators in Blender and
 * a caller looking for this one should find it, with the scope written down.
 */
export function edgenetFill(em: EditMesh, selectedEdges: ReadonlySet<number>): Set<number> {
  return edgeloopFill(em, selectedEdges);
}
