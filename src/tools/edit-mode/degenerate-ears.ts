/**
 * The second phase of `bmesh.ops.dissolve_degenerate` (`bmo_dissolve.cc`, compat-backlog C84): clipping degenerate **ears**.
 *
 * A corner is an ear when its two edges lie nearly on top of each other — the first phase's short-edge test cannot see a spike like that,
 * because neither edge is short. For each such corner of a face (the corner `l`, edges to the vertices before and after it):
 *
 * - equal lengths (within `dist`): in a triangle the edge opposite is flagged for collapse; in a bigger face the two far ends are joined by
 *   a new edge, which is flagged;
 * - otherwise the longer edge is split at the shorter one's length, so its new vertex sits where the shorter edge ends, and the face is split
 *   between that vertex and the other far end — a sliver whose new edge is flagged.
 *
 * The flagged edges are then collapsed (`collapse`, the same operator the first phase ends with). This file does everything up to that: it
 * returns the mesh with the cuts made and the flagged edges as vertex pairs.
 *
 * The walk is Blender's: the edges in the mesh's order — those the cuts add come last and are walked too — and the loops round each one in radial order,
 * each tested once; a cut restarts the walk round the edge from the loop that made it. The edges the cuts add are not marked, so a corner next to
 * one is not a candidate. Everything is float32, in the C's order.
 */
import { bmFromMesh, bmToMesh, edgeExists, faceSplit, splitEdgeMakeVert, type BE, type BL, type BM } from "../bmesh-lite";
import { f, sub, normalizeInPlace, type V3 } from "../blender-math";

export interface EarClip {
  positions: Float32Array;
  polys: number[][];
  /** The edges flagged for collapse, as the vertex pairs they join. */
  collapse: [number, number][];
}

const len3 = (a: V3, b: V3): number => {
  const d = sub(a, b);
  return f(Math.sqrt(f(f(f(d[0]! * d[0]!) + f(d[1]! * d[1]!)) + f(d[2]! * d[2]!))));
};

/**
 * Clip the ears of `polys` with `dist`. `marked` limits the walk to those edges (pairs written "min_max"), all of them when null.
 * Returns null when nothing was cut and nothing flagged.
 */
export function clipDegenerateEars(
  positions: Float32Array,
  polys: number[][],
  dist: number,
  marked: ReadonlySet<string> | null,
): EarClip | null {
  const bm: BM = bmFromMesh({ positions, polys });
  const d = f(dist);
  const key = (e: BE): string => `${Math.min(e.v1.index, e.v2.index)}_${Math.max(e.v1.index, e.v2.index)}`;
  const mark = new Set<BE>();
  for (const e of bm.edges.items) if (e && (!marked || marked.has(key(e)))) mark.add(e);
  const collapse = new Set<BE>();
  const tested = new Set<BL>();
  let found = false;
  let cut = false;
  // Blender has no bound; a loop this long means the walk does not end (a mesh this port reads differently), so stop rather than hang.
  let budget = 1_000_000;

  /** `BM_face_split(f, l_iter->prev, l_iter->next)`, returning the edge it made (or found) between them. */
  const splitEar = (l: BL): BE | null => {
    const a = l.prev;
    const b = l.next;
    const va = a.v;
    const vb = b.v;
    if (!faceSplit(bm, l.f, a, b, true)) return null;
    cut = true;
    return edgeExists(va, vb);
  };

  // `BM_ITER_MESH`: edges the cuts add are walked too.
  for (let i = 0; i < bm.edges.items.length; i++) {
    const e = bm.edges.items[i];
    if (!e || !e.l || !mark.has(e)) continue;
    let first: BL = e.l;
    let l: BL = first;
    do {
      if (--budget < 0) throw new Error("clipDegenerateEars: the walk did not end");
      if (!tested.has(l)) {
        tested.add(l);
        if (mark.has(l.prev.e!) && !collapse.has(l.e!) && !collapse.has(l.prev.e!)) {
          const dirPrev = sub(l.prev.v.co, l.v.co);
          const dirNext = sub(l.next.v.co, l.v.co);
          const lenPrev = normalizeInPlace(dirPrev);
          const lenNext = normalizeInPlace(dirNext);
          if (f(len3(dirPrev, dirNext) * Math.min(lenPrev, lenNext)) <= d) {
            let reset = false;
            if (Math.abs(f(lenPrev - lenNext)) <= d) {
              if (l.f.len === 3) {
                collapse.add(l.next.e!);
                found = true;
              } else {
                const made = splitEar(l);
                if (made) {
                  collapse.add(made);
                  found = true;
                  reset = true;
                }
              }
            } else if (lenPrev < lenNext) {
              // Split `l.e` at the shorter edge's length from `l.v`; the new vertex is then `l.next.v`.
              const other = l.next.v;
              const { v } = splitEdgeMakeVert(bm, l.v, l.e!);
              const t = f(lenPrev / lenNext);
              for (let k = 0; k < 3; k++) v.co[k] = f(f(f(1 - t) * l.v.co[k]!) + f(t * other.co[k]!));
              const made = splitEar(l);
              if (made) {
                collapse.add(made);
                found = true;
              }
              reset = true;
            } else if (lenNext < lenPrev) {
              const other = l.prev.v;
              const { v } = splitEdgeMakeVert(bm, l.v, l.prev.e!);
              const t = f(lenNext / lenPrev);
              for (let k = 0; k < 3; k++) v.co[k] = f(f(f(1 - t) * l.v.co[k]!) + f(t * other.co[k]!));
              const made = splitEar(l);
              if (made) {
                collapse.add(made);
                found = true;
              }
              reset = true;
            }
            // The walk cannot follow the radial cycle through a cut: start again from here.
            if (reset) first = l;
          }
        }
      }
      l = l.rn!;
    } while (l !== first);
  }

  if (!found && !cut) return null;
  const out = bmToMesh(bm);
  return {
    positions: out.positions,
    polys: out.polys,
    collapse: [...collapse].map((e) => [e.v1.index, e.v2.index]),
  };
}
