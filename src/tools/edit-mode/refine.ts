/**
 * Adding detail, relaxing it, and closing what is left open.
 *
 * Four Blender operators whose defaults are worth stating out loud, because
 * all three of the surprising ones cost a reader an hour if they are assumed:
 *
 * - {@link subdivideEdges} **does not split faces.** Cutting all four edges of
 *   a quad gives one octagon, not four quads. Blender's UI Subdivide passes
 *   `use_grid_fill`, the operator does not.
 * - {@link smoothVert} **moves nothing** unless an axis is enabled. All three
 *   `use_axis_*` default to false.
 * - {@link holesFill}'s `sides` is a **maximum**, not a count, and the
 *   operation fills every boundary loop it is given — including the outer one.
 *
 * All measured against Blender 5.1.1; see `tools/modeling/parity/README.md`.
 *
 * Pure and headless — Vitest-pinned.
 */
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

/** Options for {@link subdivideEdges}. */
export interface SubdivideEdgesOptions {
  /** New vertices per edge. Blender's `cuts`. */
  cuts: number;
  /**
   * Rebuild a fully-cut quad as a grid of quads instead of leaving it an
   * n-gon. Blender's `use_grid_fill`, **off by default in the operator** and
   * on in the UI's Subdivide, which is why a quad subdivides into four there
   * and into one octagon here.
   *
   * Only the case Blender's UI relies on is implemented: a quad with all four
   * edges cut the same number of times. Any other face keeps the n-gon form.
   */
  useGridFill?: boolean;
}

/**
 * Put `cuts` new vertices along each selected edge — Blender's
 * `bmesh.ops.subdivide_edges(edges=, cuts=)`.
 *
 * **The faces are not split.** A quad with one edge cut becomes a pentagon; cut
 * all four and it is an octagon. That is the operator's behaviour, measured,
 * and it is the general form of `loopCut` — which cuts one ring and does split.
 */
export function subdivideEdges(
  em: EditMesh,
  selectedEdges: ReadonlySet<number>,
  opts: SubdivideEdgesOptions,
): Set<number> {
  const cuts = Math.max(0, Math.floor(opts.cuts));
  if (cuts === 0 || selectedEdges.size === 0) return new Set();

  const polys = toPolygons(em);
  const P = em.positions;
  const positions: number[] = Array.from(P);
  let nextV = em.vertices.length;

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
      made.push(nextV++);
      positions.push(
        P[a * 3]! + (P[b * 3]! - P[a * 3]!) * t,
        P[a * 3 + 1]! + (P[b * 3 + 1]! - P[a * 3 + 1]!) * t,
        P[a * 3 + 2]! + (P[b * 3 + 2]! - P[a * 3 + 2]!) * t,
      );
    }
    // Stored low-to-high so both faces can read it in their own direction.
    cutsOn.set(key, a < b ? made : made.reverse());
  }

  const out: number[][] = [];
  const touched = new Set<number>();
  for (let f = 0; f < polys.length; f++) {
    const poly = polys[f]!;
    const grown: number[] = [];
    let changed = false;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      grown.push(a);
      const made = cutsOn.get(seamKey(a, b));
      if (!made) continue;
      changed = true;
      grown.push(...(a < b ? made : [...made].reverse()));
    }

    if (!changed) {
      out.push(poly);
      continue;
    }

    if (opts.useGridFill && poly.length === 4 && grown.length === 4 * (cuts + 1)) {
      // The UI's Subdivide: a fully-cut quad becomes (cuts+1)^2 quads.
      const side = cuts + 1;
      const ring = grown;
      const at = (i: number, j: number): number => {
        if (j === 0) return ring[i]!;
        if (i === side) return ring[side + j]!;
        if (j === side) return ring[side * 3 - i]!;
        if (i === 0) return ring[side * 4 - j]!;
        return -1;
      };
      const id: number[][] = [];
      for (let i = 0; i <= side; i++) {
        const row: number[] = [];
        for (let j = 0; j <= side; j++) {
          const edge = at(i, j);
          if (edge >= 0) {
            row.push(edge);
            continue;
          }
          // Bilinear from the four corners of the ring.
          const u = i / side;
          const v = j / side;
          const c = [ring[0]!, ring[side]!, ring[side * 2]!, ring[side * 3]!];
          const p = [0, 1, 2].map(
            (k) =>
              (1 - u) * (1 - v) * P[c[0]! * 3 + k]! +
              u * (1 - v) * P[c[1]! * 3 + k]! +
              u * v * P[c[2]! * 3 + k]! +
              (1 - u) * v * P[c[3]! * 3 + k]!,
          );
          row.push(nextV++);
          positions.push(p[0]!, p[1]!, p[2]!);
        }
        id.push(row);
      }
      for (let i = 0; i < side; i++)
        for (let j = 0; j < side; j++) {
          touched.add(out.length);
          out.push([id[i]![j]!, id[i + 1]![j]!, id[i + 1]![j + 1]!, id[i]![j + 1]!]);
        }
      continue;
    }

    touched.add(out.length);
    out.push(grown);
  }

  rebuildPolygons(em, new Float32Array(positions), out);
  return touched;
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
