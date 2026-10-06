/**
 * The order and the choice of triangle pairs `bmesh.ops.join_triangles` joins (`bmo_join_triangles.cc`, compat-backlog C74):
 * every manifold edge between two input triangles that is not delimited is a candidate, ranked by `quad_calc_error` — how far the
 * quad it would make is from flat (the angle between the two ways of cutting it), from four right angles, and from convex (the
 * ratio of the areas of the two cuts) — and taken best first from a `BLI_heap`, skipping an edge whose triangles an earlier join has used.
 *
 * Everything is float32, in the C's order. `topology_influence` (the neighbour re-ranking) is not ported: the operator's default is 0.
 */
import { bmFromMesh, liveEdges, type BE } from "../bmesh-lite";
import { f, sub, dot, cross, normalizeInPlace, normalTri, heapInsert, heapPopMin, FLT_EPSILON, type Heap, type V3 } from "../blender-math";

const saasin = (x: number): number => (x <= -1 ? f(-Math.PI / 2) : x >= 1 ? f(Math.PI / 2) : f(Math.asin(x)));
const lenV = (a: V3): number => f(Math.sqrt(dot(a, a)));
/** `angle_normalized_v3v3`. */
function angleNormalized(a: V3, b: V3): number {
  if (dot(a, b) >= 0) return f(2 * saasin(f(lenV(sub(a, b)) / 2)));
  const nb: V3 = [f(-b[0]!), f(-b[1]!), f(-b[2]!)];
  return f(f(Math.PI) - f(2 * saasin(f(lenV(sub(a, nb)) / 2))));
}
const HALF_PI = f(Math.PI / 2);
const TWO_PI = f(Math.PI * 2);
/** `area_tri_v3`. */
const areaTri = (a: V3, b: V3, c: V3): number => f(lenV(cross(sub(a, b), sub(b, c))) * f(0.5));

/** `quad_calc_error`: flatness, right-angledness and convexity of the quad `v1 v2 v3 v4`, each as a share of a half turn. */
export function quadCalcError(v1: V3, v2: V3, v3: V3, v4: V3): number {
  let error = 0;
  {
    const same = (a: V3, b: V3): boolean => Math.abs(a[0]! - b[0]!) <= FLT_EPSILON && Math.abs(a[1]! - b[1]!) <= FLT_EPSILON && Math.abs(a[2]! - b[2]!) <= FLT_EPSILON;
    let n1 = normalTri(v1, v2, v3);
    let n2 = normalTri(v1, v3, v4);
    const angleA = same(n1, n2) ? 0 : angleNormalized(n1, n2);
    n1 = normalTri(v2, v3, v4);
    n2 = normalTri(v4, v1, v2);
    const angleB = same(n1, n2) ? 0 : angleNormalized(n1, n2);
    error = f(error + f(f(angleA + angleB) / TWO_PI));
  }
  {
    const e: V3[] = [sub(v1, v2), sub(v2, v3), sub(v3, v4), sub(v4, v1)];
    for (const v of e) normalizeInPlace(v);
    const diff = f(
      f(
        f(f(Math.abs(f(angleNormalized(e[0]!, e[1]!) - HALF_PI))) + f(Math.abs(f(angleNormalized(e[1]!, e[2]!) - HALF_PI)))) +
          f(Math.abs(f(angleNormalized(e[2]!, e[3]!) - HALF_PI))),
      ) + f(Math.abs(f(angleNormalized(e[3]!, e[0]!) - HALF_PI))),
    );
    error = f(error + f(diff / TWO_PI));
  }
  {
    const areaA = f(areaTri(v1, v2, v3) + areaTri(v1, v3, v4));
    const areaB = f(areaTri(v2, v3, v4) + areaTri(v4, v1, v2));
    const min = Math.min(areaA, areaB);
    const max = Math.max(areaA, areaB);
    error = f(error + (max ? f(1 - f(min / max)) : 1));
  }
  return error;
}

/** `is_quad_flip_v3`: true when either pair of opposite corners turns the other way. */
function isQuadFlip(v1: V3, v2: V3, v3: V3, v4: V3): boolean {
  const d12 = sub(v1, v2);
  const d23 = sub(v2, v3);
  const d34 = sub(v3, v4);
  const d41 = sub(v4, v1);
  return dot(cross(d12, d23), cross(d34, d41)) < 0 || dot(cross(d23, d34), cross(d41, d12)) < 0;
}

export interface JoinPair {
  /** The face `BM_faces_join_pair` starts from (`e->l->f`: its material is the quad's) and the other. */
  first: number;
  second: number;
  /** The joined quad in Blender's order, `bm_edge_to_quad_verts`: `l.v`, the far corner of the other face, `l.next.v`, the far corner of `l`'s face. */
  quad: [number, number, number, number];
}

/**
 * The joins, in the order they are made. `angleFace` and `angleShape` are the delimit thresholds in radians (180° or more turns them
 * off): the face normals may differ by at most `angleFace`, and, with `angleShape`, the quad must not be flipped and every corner
 * within `angleShape` of a right angle.
 */
export function joinTrianglePairs(
  positions: Float32Array,
  polys: number[][],
  input: ReadonlySet<number> | null,
  angleFace: number,
  angleShape: number,
): JoinPair[] {
  const bm = bmFromMesh({ positions, polys });
  const useFace = angleFace < f(Math.PI);
  const cosFace = f(Math.cos(angleFace));
  const useShape = angleShape < f(Math.PI);
  const heap: Heap<BE> = { tree: [] };
  const used = new Set<number>();
  const inScope = (face: { len: number; index: number }): boolean => face.len === 3 && (!input || input.has(face.index));

  for (const e of liveEdges(bm)) {
    const la = e.l;
    const lb = la?.rn;
    if (!la || !lb || lb === la || lb.rn !== la) continue; // `BM_edge_face_pair`: exactly two faces
    if (!inScope(la.f) || !inScope(lb.f)) continue;
    if (useFace && dot(la.f.no, lb.f.no) < cosFace) continue;
    const quad = [la.v, lb.prev.v, la.next.v, la.prev.v];
    const co = quad.map((v) => v.co);
    if (useShape) {
      if (isQuadFlip(co[0]!, co[1]!, co[2]!, co[3]!)) continue;
      const vec = [sub(co[0]!, co[1]!), sub(co[1]!, co[2]!), sub(co[2]!, co[3]!), sub(co[3]!, co[0]!)];
      for (const v of vec) normalizeInPlace(v);
      let off = false;
      for (let i = 0; i < 4; i++) if (Math.abs(f(angleNormalized(vec[i]!, vec[(i + 1) % 4]!) - HALF_PI)) > angleShape) off = true;
      if (off) continue;
    }
    heapInsert(heap, quadCalcError(co[0]!, co[1]!, co[2]!, co[3]!), e);
  }

  const out: JoinPair[] = [];
  while (heap.tree.length) {
    const e = heapPopMin(heap);
    const la = e.l!;
    const lb = la.rn!;
    // A face an earlier join has used is a quad now.
    if (used.has(la.f.index) || used.has(lb.f.index)) continue;
    used.add(la.f.index);
    used.add(lb.f.index);
    out.push({ first: la.f.index, second: lb.f.index, quad: [la.v.index, lb.prev.v.index, la.next.v.index, la.prev.v.index] });
  }
  return out;
}
