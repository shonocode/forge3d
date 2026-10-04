/**
 * `bmesh.ops.offset_edgeloops` — a port of `bmo_offset_edgeloops.cc` on {@link BMesh}, step for step.
 *
 * What it does: every edge that leaves the selected loop is split at the loop's own vertex (the new vertex lies
 * on top of it), the faces round the loop are cut so the loop is flanked by a strip on each side, and — unless
 * `use_cap_endpoint` — vertices that ended up with just two edges are removed again. Nothing moves; sliding the new
 * loops apart is the second half (`edgeSlide`).
 *
 * The order things are walked in decides the result in awkward places (a selection that is not a complete loop, a
 * vertex of high valence, an edge inside a closed mesh), so the disk and radial cycles are modelled as Blender keeps
 * them, and one of Blender's own quirks is kept: when a vertex with only selected edges is dropped from the work list
 * (`STACK_REMOVE`), the vertex swapped into its place is not looked at.
 */
import { BMesh, BMVert, type BMEdge, type CornerRef, type BMLoop, type Vec3 } from "./bmesh-model";
import type { ExplicitFace, VertexOrigin } from "./half-edge";

export interface OffsetEdgeLoopsResult {
  positions: Float32Array;
  polys: number[][];
  /** Per output face, where each corner and the material come from (`LayerCarry.faces`). */
  faces: ExplicitFace[];
  /** Per made vertex, the input vertices its data is mixed from. */
  origins: Map<number, VertexOrigin>;
  /** The made vertices that are left. */
  added: Set<number>;
}

const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * Run the operator on a polygon mesh. `loopEdges` are the selected edges as vertex pairs; they are walked in the
 * order a Mesh made from these polygons numbers its edges (each face's closing edge first, new edges only), which is
 * the order the operator reads its `edges` slot in.
 */
export function offsetEdgeLoopsPort(
  positions: Float32Array,
  polys: readonly (readonly number[])[],
  loopEdges: readonly (readonly [number, number])[],
  useCapEndpoint = false,
): OffsetEdgeLoopsResult | null {
  const bm = new BMesh();
  const nVerts = positions.length / 3;
  const verts: BMVert[] = [];
  for (let i = 0; i < nVerts; i++) {
    const v = bm.vertCreate([positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]);
    v.idx = i;
    verts.push(v);
  }
  // The Mesh's edges: face by face, the closing edge first, new edges only; low vertex to high.
  const edgeOf = new Map<string, BMEdge>();
  const edgeIndex = new Map<string, number>();
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i + poly.length - 1) % poly.length]!;
      const b = poly[i]!;
      const k = key(a, b);
      if (edgeOf.has(k)) continue;
      edgeIndex.set(k, edgeOf.size);
      edgeOf.set(k, bm.edgeCreate(verts[Math.min(a, b)]!, verts[Math.max(a, b)]!, null, false));
    }
  polys.forEach((poly, f) => {
    bm.faceCreate(
      poly.map((v) => verts[v]!),
      poly.map((_, i) => [[f, i, 1] as const] as CornerRef[]),
      f,
      true,
    );
  });

  const selected = [...new Set(loopEdges.map(([a, b]) => key(a, b)))]
    .filter((k) => edgeOf.has(k))
    .sort((x, y) => edgeIndex.get(x)! - edgeIndex.get(y)!)
    .map((k) => edgeOf.get(k)!);
  if (selected.length === 0) return null;

  // The vertices of the selected edges, first seen first.
  const work: BMVert[] = [];
  for (const e of selected) {
    e.tag = true;
    for (const v of [e.v1, e.v2]) {
      if (!v.tag) {
        v.tag = true;
        work.push(v);
      }
    }
  }
  // Drop the vertices that only selected edges meet at. `STACK_REMOVE` swaps the last one into the gap and the
  // loop moves on — so that vertex is not examined.
  let len = work.length;
  for (let i = 0; i < len; i++) {
    let flag = 0;
    for (const e of bm.edgesOfVert(work[i]!)) {
      flag |= e.tag ? 1 : 2;
      if (flag === 3) break;
    }
    if (flag !== 3) work[i] = work[--len]!;
  }
  work.length = len;
  if (len === 0) return null;

  // Main loop: every edge that is not selected is split at this vertex's end.
  const endpoint = new Set<BMVert>();
  for (let i = 0; i < len; i++) {
    const v = work[i]!;
    let tagged = 0;
    for (const e of bm.edgesOfVert(v)) {
      if (!e.tag) {
        for (const l of bm.loopsOfEdge(e)) l.f.tag = true;
        bm.edgeSplit(e, bm.otherVert(e, v), 1);
      } else tagged++;
    }
    if (tagged === 1) endpoint.add(v);
  }

  // Cut the faces: a corner whose neighbours are both new vertices is cut off, longer runs by a chord.
  for (let i = 0; i < len; i++) {
    const v = work[i]!;
    for (const l of bm.loopsOfVert(v)) {
      if (!(l.f.tag && l.f.len !== 3)) continue;
      if (l.next.v.idx === -1 && l.prev.v.idx === -1) {
        if (useCapEndpoint || !endpoint.has(v)) bm.faceSplit(l.f, l.prev, l.next, true);
      } else if (l.f.len > 4) {
        if (l.e!.tag !== l.prev.e!.tag) {
          if (l.next.v.idx === -1) {
            if (l.prev.prev.v.idx === -1) {
              bm.faceSplit(l.f, l.prev.prev, l.next, true);
              l.f.tag = false;
            } else {
              walkBack(bm, l);
              l.f.tag = false;
            }
          }
        }
      }
    }
  }

  // Without caps, the made vertices that are just a pass-through are removed again.
  if (!useCapEndpoint) {
    for (let i = 0; i < len; i++) {
      const v = work[i]!;
      const stack: BMVert[] = [];
      for (const e of bm.edgesOfVert(v)) {
        const o = bm.otherVert(e, v);
        if (o.idx === -1 && bm.vertIsEdgePair(o)) {
          // `v_other->e = e`: the edge to `v` becomes the head of its cycle.
          o.disk = [e, ...o.disk.filter((x) => x !== e)];
          stack.push(o);
        }
      }
      let k: BMVert | undefined;
      while ((k = stack.pop())) bm.joinEdgeKillVert(k.disk[0]!, k, true);
    }
  }

  // Out.
  const outId = new Map<BMVert, number>();
  const outPositions: number[] = [];
  const origins = new Map<number, VertexOrigin>();
  const added = new Set<number>();
  for (const v of bm.verts) if (v.idx >= 0) outId.set(v, v.idx);
  let next = nVerts;
  for (const v of bm.verts) if (v.idx < 0) outId.set(v, next++);
  const ordered = [...outId.entries()].sort((a, b) => a[1] - b[1]);
  for (const [v, id] of ordered) {
    outPositions.push(...(v.co as Vec3));
    if (id >= nVerts) {
      added.add(id);
      if (v.origin) origins.set(id, v.origin);
    }
  }
  const outPolys: number[][] = [];
  const faces: ExplicitFace[] = [];
  for (const f of bm.faces) {
    const loops = bm.faceLoops(f);
    outPolys.push(loops.map((l) => outId.get(l.v)!));
    faces.push({ corners: loops.map((l) => l.src.map((s) => [s[0], s[1], s[2]] as const)), material: f.material });
  }
  return { positions: Float32Array.from(outPositions), polys: outPolys, faces, origins, added };
}

/**
 * `bm_face_split_walk_back`: from `l` back over the run of old vertices, then a chord from the new vertex before the run
 * to the one after `l`, with a vertex on it at the position of each old vertex passed.
 */
function walkBack(bm: BMesh, lSrc: BMLoop): void {
  let lDst = lSrc.prev;
  let num = 0;
  while (lDst.prev.v.idx !== -1) {
    lDst = lDst.prev;
    num++;
  }
  const cos: Vec3[] = new Array<Vec3>(num);
  let i = 0;
  for (let l = lSrc.prev; l.prev.v.idx !== -1; l = l.prev, i++) cos[num - (i + 1)] = [...l.v.co] as Vec3;
  bm.faceSplitN(lSrc.f, lDst.prev, lSrc.next, cos);
}
