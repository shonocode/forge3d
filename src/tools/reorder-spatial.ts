/**
 * Reorder a mesh's faces and vertices by where they are — Blender's
 * **Reorder Mesh Spatially** (`MESH_OT_reorder_vertices_spatial`, which calls
 * `bke::mesh_apply_spatial_organization`).
 *
 * The geometry does not change; only the order. The point is locality: faces
 * near each other end up near each other in the arrays, which is what a BVH
 * builder or a sculpt brush wants.
 *
 * Ported from `mesh.cc` and `pbvh.cc`:
 *
 * 1. Faces are split into groups of at most 2500, recursively: the group's
 *    bounds (of the faces' own bounds at the top, of face centres below) are
 *    cut in half across their longest axis, faces whose centre is **at or
 *    above** the middle going first. A group small enough is split once more
 *    per material if it mixes materials. The split is C++'s `std::partition`
 *    as MSVC implements it — two pointers closing in, swapping — so the order
 *    within each half is Blender's too.
 * 2. Groups are visited in the order they were allocated; a leaf lists its
 *    faces as partitioned, then the vertices it uses — in index order, each
 *    only the first time any leaf uses it.
 * 3. Vertices no face uses go last, in index order.
 *
 * Under 2500 faces with one material, nothing moves.
 */
import type { MeshData } from "../lib/mesh";
import { carryFaceLayers, defined, sameFaces } from "./mesh-layers";

const f = Math.fround;
const TARGET = 2500;
const MAX_DEPTH = 100 - 1; // `STACK_FIXED_DEPTH - 1`

/** MSVC's `std::partition`: `pred` true goes first. Returns the split. */
function partition(a: number[], lo: number, hi: number, pred: (x: number) => boolean): number {
  let first = lo;
  let last = hi;
  for (;;) {
    for (;;) {
      if (first === last) return first;
      if (!pred(a[first]!)) break;
      first++;
    }
    do {
      last--;
      if (first === last) return first;
    } while (!pred(a[last]!));
    [a[first], a[last]] = [a[last]!, a[first]!];
    first++;
  }
}

interface Group {
  faces: number[] | null;
  childrenOffset: number;
}

export function reorderSpatial(data: MeshData): MeshData {
  const P = data.positions;
  const nVerts = P.length / 3;
  const nFaces = data.polys.length;
  if (nVerts === 0 || nFaces === 0) return data;

  // Face bounds and centres, in float.
  const centers: number[][] = [];
  const rootMin = [Infinity, Infinity, Infinity];
  const rootMax = [-Infinity, -Infinity, -Infinity];
  for (const poly of data.polys) {
    const mn = [P[poly[0]! * 3]!, P[poly[0]! * 3 + 1]!, P[poly[0]! * 3 + 2]!];
    const mx = [...mn];
    for (const v of poly.slice(1))
      for (let k = 0; k < 3; k++) {
        const x = P[v * 3 + k]!;
        if (x < mn[k]!) mn[k] = x;
        if (x > mx[k]!) mx[k] = x;
      }
    centers.push([0, 1, 2].map((k) => f(f(mn[k]! + mx[k]!) * 0.5)));
    for (let k = 0; k < 3; k++) {
      rootMin[k] = Math.min(rootMin[k]!, mn[k]!);
      rootMax[k] = Math.max(rootMax[k]!, mx[k]!);
    }
  }
  const materials = data.materials;

  const needsMaterialSplit = (faces: number[], lo: number, hi: number): boolean => {
    if (!materials) return false;
    const first = materials[faces[lo]!] ?? 0;
    for (let i = lo; i < hi; i++) if ((materials[faces[i]!] ?? 0) !== first) return true;
    return false;
  };

  const order = [...Array(nFaces).keys()];
  const groups: Group[] = [{ faces: null, childrenOffset: 0 }];

  const recurse = (lo: number, hi: number, node: number, depth: number, bounds: [number[], number[]] | null): void => {
    const small = hi - lo <= TARGET || depth >= MAX_DEPTH;
    if (small && !needsMaterialSplit(order, lo, hi)) {
      groups[node] = { faces: order.slice(lo, hi), childrenOffset: 0 };
      return;
    }
    const children = groups.length;
    groups[node] = { faces: null, childrenOffset: children };
    groups.push({ faces: null, childrenOffset: 0 }, { faces: null, childrenOffset: 0 });
    let split: number;
    if (!small) {
      let mn: number[];
      let mx: number[];
      if (bounds) [mn, mx] = bounds;
      else {
        mn = [Infinity, Infinity, Infinity];
        mx = [-Infinity, -Infinity, -Infinity];
        for (let i = lo; i < hi; i++)
          for (let k = 0; k < 3; k++) {
            const c = centers[order[i]!]![k]!;
            if (c < mn[k]!) mn[k] = c;
            if (c > mx[k]!) mx[k] = c;
          }
      }
      const d = [0, 1, 2].map((k) => Math.abs(f(mx[k]! - mn[k]!)));
      const axis = d[0]! > d[1]! ? (d[0]! > d[2]! ? 0 : 2) : d[1]! > d[2]! ? 1 : 2;
      const middle = f(f(mn[axis]! + mx[axis]!) * 0.5);
      split = partition(order, lo, hi, (face) => centers[face]![axis]! >= middle) - lo;
    } else {
      const first = materials![order[lo]!] ?? 0;
      split = partition(order, lo, hi, (face) => (materials![face] ?? 0) === first) - lo;
    }
    recurse(lo, lo + split, children, depth + 1, null);
    recurse(lo + split, hi, children + 1, depth + 1, null);
  };
  recurse(0, nFaces, 0, 0, [rootMin, rootMax]);

  const newVertOrder: number[] = [];
  const added = new Uint8Array(nVerts);
  const newFaceOrder: number[] = [];
  for (const g of groups) {
    if (!g.faces || g.childrenOffset !== 0) continue;
    const verts = [...new Set(g.faces.flatMap((fi) => data.polys[fi]!))].sort((a, b) => a - b);
    for (const v of verts)
      if (!added[v]) {
        added[v] = 1;
        newVertOrder.push(v);
      }
    newFaceOrder.push(...g.faces);
  }
  for (let v = 0; v < nVerts; v++) if (!added[v]) newVertOrder.push(v);

  const reverse = new Int32Array(nVerts);
  newVertOrder.forEach((old, i) => (reverse[old] = i));
  const positions = new Float32Array(P.length);
  newVertOrder.forEach((old, i) => {
    positions[i * 3] = P[old * 3]!;
    positions[i * 3 + 1] = P[old * 3 + 1]!;
    positions[i * 3 + 2] = P[old * 3 + 2]!;
  });
  const remapKey = (k: string): string => {
    const [a, b] = k.split("_").map(Number);
    const x = reverse[a!]!;
    const y = reverse[b!]!;
    return x < y ? `${x}_${y}` : `${y}_${x}`;
  };
  // Every layer follows its vertex or face (compat-backlog A3).
  return defined({
    positions,
    polys: newFaceOrder.map((fi) => data.polys[fi]!.map((v) => reverse[v]!)),
    ...(data.edges ? { edges: data.edges.map((e) => e.map((v) => reverse[v]!)) } : {}),
    ...(data.creases ? { creases: new Map([...data.creases].map(([k, s]) => [remapKey(k), s])) } : {}),
    ...(data.seams ? { seams: new Set([...data.seams].map(remapKey)) } : {}),
    ...(data.sharp ? { sharp: new Set([...data.sharp].map(remapKey)) } : {}),
    ...(data.groups
      ? { groups: new Map([...data.groups].map(([k, g]) => [k, new Map([...g].map(([v, w]) => [reverse[v]!, w]))])) }
      : {}),
    ...carryFaceLayers(data, sameFaces(newFaceOrder, data)),
    ...(data.materials ? { materials: newFaceOrder.map((fi) => data.materials![fi] ?? 0) } : {}),
  });
}
