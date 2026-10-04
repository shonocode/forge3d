/**
 * `bpy.ops.mesh.bisect` — the Bisect tool, as opposed to `bmesh.ops.bisect_plane` ({@link bisectPlane}).
 *
 * The operator is the bmesh op plus its **Fill** option (compat-backlog C25): the edges the cut left on the plane
 * are filled with triangles (`triangle_fill`, along the plane's normal), the triangles are joined back into one
 * face per region (`use_dissolve`), and the new faces take their winding, material and corner data from the faces
 * around them (`face_attribute_fill`).
 */
import type { MeshData } from "../lib/mesh";
import { bisectPlane, type BisectPlaneOptions, type BisectReport } from "./mesh-ops";
import { scanfillOnEdges } from "./edit-mode/triangle-fill";
import { faceAttributeFillAll } from "./edit-mode/loop-data";

/** Options of {@link bisectOperator}: the tool's. */
export interface BisectOperatorOptions extends Omit<BisectPlaneOptions, "dist"> {
  /** The tool's `threshold` ("Axis Threshold"): how near the plane counts as on it. Default 0.0001. */
  threshold?: number;
  /** `use_fill`: fill the cut. Default false. */
  useFill?: boolean;
}

const f32 = Math.fround;
const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * Cut a mesh with a plane the way the Bisect tool does, optionally dropping a side and filling the cut.
 *
 * **Fill**: the cut's edges (`geom_cut.out` — the chords across faces and the edges that already lay on the plane)
 * go to `triangle_fill` with the plane's normal, so the winding comes from the scanfill and not from the faces around;
 * every edge that fill made is then dissolved (`use_dissolve`: `BM_faces_join_pair` on each, in the order the
 * edges were made, a join that would leave the face touching itself being refused), so a simple loop becomes one
 * n-gon and a loop with holes keeps the bridges it cannot dissolve. The new faces are finally wound like the
 * faces beside them and copy their material and corner data (`face_attribute_fill`).
 */
export function bisectOperator(data: MeshData, opts: BisectOperatorOptions): MeshData {
  const report: BisectReport = { cutEdges: [] };
  const cut = bisectPlane(
    data,
    { ...opts, dist: opts.threshold ?? 0.0001 },
    report,
  );
  if (!opts.useFill || report.cutEdges.length === 0) return cut;

  const [px, py, pz] = opts.planeNo;
  const len = f32(Math.sqrt(f32(f32(f32(px * px) + f32(py * py)) + f32(pz * pz))));
  const normal = len === 0 ? [0, 0, 1] : [f32(px / len), f32(py / len), f32(pz / len)];
  const tris = scanfillOnEdges(cut.positions, report.cutEdges, normal);
  if (tris.length === 0) return cut;

  const marked = new Set(report.cutEdges.map(([a, b]) => edgeKey(a, b)));
  const faces: number[][] = cut.polys.map((p) => [...p]);
  const alive: boolean[] = faces.map(() => true);
  const isNewFace = new Set<number>();

  // The radial cycle of every edge, head first: `bmesh_radial_loop_append` puts the newest loop at the head and
  // the old head at the back; removing a loop moves the head on only if it was the head.
  const radial = new Map<string, number[]>();
  const edgeOrder: string[] = [];
  /** `BM_edge_create`: the edge exists from now on, last in the pool. */
  const ensure = (k: string): void => {
    if (radial.has(k)) return;
    radial.set(k, []);
    edgeOrder.push(k);
  };
  const append = (k: string, f: number): void => {
    ensure(k);
    const list = radial.get(k)!;
    radial.set(k, list.length === 0 ? [f] : [f, ...list.slice(1), list[0]!]);
  };
  const remove = (k: string, f: number): void => {
    radial.set(
      k,
      radial.get(k)!.filter((g) => g !== f),
    );
  };
  const edgesOf = (f: number): string[] => faces[f]!.map((v, i) => edgeKey(v, faces[f]![(i + 1) % faces[f]!.length]!));
  faces.forEach((_, f) => {
    // A Mesh made from these polygons numbers each face's closing edge first.
    const ks = edgesOf(f);
    for (const k of [ks[ks.length - 1]!, ...ks.slice(0, -1)]) ensure(k);
    for (const k of ks) append(k, f);
  });
  for (const [a, b] of (cut.edges ?? []) as number[][]) ensure(edgeKey(a!, b!));

  // `triangle_fill`: the triangles (an existing face is not made again), the edges they bring flagged new.
  const have = new Set(faces.map((p) => [...p].sort((x, y) => x - y).join(",")));
  const flagged = new Set<string>();
  for (const t of tris) {
    const k = [...t].sort((x, y) => x - y).join(",");
    if (have.has(k)) continue;
    have.add(k);
    const f = faces.length;
    faces.push([...t]);
    alive.push(true);
    isNewFace.add(f);
    // `BM_face_create_verts` makes the edges closing edge first, then the loops in order.
    const ks = [0, 1, 2].map((i) => edgeKey(t[i]!, t[(i + 1) % 3]!));
    for (const e of [ks[2]!, ks[0]!, ks[1]!]) ensure(e);
    for (const e of ks) {
      if (!marked.has(e)) flagged.add(e);
      append(e, f);
    }
  }

  // `use_dissolve`.
  const joinPair = (a: number, b: number): number[] | null => {
    const inSet = (f: number): boolean => f === a || f === b;
    const boundary: [number, number][] = []; // directed as the loop runs, faces[0] first
    for (const f of [a, b]) {
      const p = faces[f]!;
      for (let i = 0; i < p.length; i++) {
        const v = p[i]!;
        const w = p[(i + 1) % p.length]!;
        const count = radial.get(edgeKey(v, w))!.filter(inSet).length;
        if (count > 2) return null;
        if (count === 1) boundary.push([v, w]);
      }
    }
    if (boundary.length < 3) return null;
    const around = new Map<number, number[]>();
    for (const [v, w] of boundary) {
      (around.get(v) ?? around.set(v, []).get(v)!).push(w);
      (around.get(w) ?? around.set(w, []).get(w)!).push(v);
    }
    // One closed chain, each vertex once: a vertex with other than two boundary edges is a vertex "in the loop
    // multiple times".
    for (const list of around.values()) if (list.length !== 2) return null;
    const ring = [boundary[0]![0]];
    let prev = boundary[0]![0];
    let cur = boundary[0]![1];
    while (cur !== ring[0]) {
      ring.push(cur);
      const next = around.get(cur)!.find((w) => w !== prev)!;
      prev = cur;
      cur = next;
      if (ring.length > boundary.length) return null;
    }
    return ring.length === boundary.length ? ring : null;
  };
  for (const k of [...edgeOrder]) {
    if (!flagged.has(k)) continue;
    const list = radial.get(k)!;
    if (list.length !== 2) continue; // not manifold: left alone
    const [a, b] = [list[0]!, list[1]!];
    const ring = joinPair(a, b);
    if (!ring) continue;
    const f = faces.length;
    faces.push(ring);
    alive.push(true);
    isNewFace.add(f);
    ring.forEach((v, i) => append(edgeKey(v, ring[(i + 1) % ring.length]!), f));
    for (const g of [a, b]) {
      for (const e of edgesOf(g)) remove(e, g);
      alive[g] = false;
      isNewFace.delete(g);
    }
  }

  // The mesh again: faces that survive, the new ones last; their layers blank.
  const order: number[] = [];
  faces.forEach((_, f) => {
    if (alive[f] && !isNewFace.has(f)) order.push(f);
  });
  const made: number[] = [];
  faces.forEach((_, f) => {
    if (alive[f] && isNewFace.has(f)) {
      made.push(order.length);
      order.push(f);
    }
  });
  const oldCount = cut.polys.length;
  const layer = (src: number[][][] | undefined, blank: number, width0: number): number[][][] | undefined => {
    if (!src || src.length !== oldCount) return undefined;
    const width = src.find((c) => c.length > 0)?.[0]?.length ?? width0;
    return order.map((f) => (f < oldCount ? src[f]!.map((c) => [...c]) : faces[f]!.map(() => new Array<number>(width).fill(blank))));
  };
  const polys = order.map((f) => faces[f]!);
  const filled: MeshData = { ...cut, polys };
  const uvs = layer(cut.uvs, 0, 2);
  const colors = layer(cut.colors, 1, 4);
  const normals = layer(cut.normals, 0, 3);
  if (uvs) filled.uvs = uvs;
  if (colors) filled.colors = colors;
  if (normals) filled.normals = normals;
  if (cut.materials && cut.materials.length === oldCount) filled.materials = order.map((f) => (f < oldCount ? cut.materials![f]! : 0));
  // A wire edge the fill made a face of is a wire edge no more.
  if (cut.edges) {
    const used = new Set<string>();
    for (const p of polys) p.forEach((v, i) => used.add(edgeKey(v, p[(i + 1) % p.length]!)));
    const rest = cut.edges.filter((e) => !used.has(edgeKey(e[0]!, e[1]!)));
    if (rest.length > 0) filled.edges = rest;
    else delete filled.edges;
  }
  return faceAttributeFillAll(filled, made, true);
}
