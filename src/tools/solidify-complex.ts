/**
 * Blender's **Solidify modifier**, Complex mode (`solidify_mode = NON_MANIFOLD`) — a port of
 * `source/blender/modifiers/intern/MOD_solidify_nonmanifold.cc` at `v5.1.1` (compat-backlog C30).
 *
 * Simple mode ({@link solidifyModifier}) moves every vertex along its normal and closes the boundary with a
 * rim. Complex mode first builds, at every vertex, the **groups of edges that belong together** — the edges
 * around the vertex in the order the faces meet, split where the surface passes through itself — and gives each
 * group its own new vertex. That is what lets it shell a mesh that is not a manifold (three faces on an edge,
 * faces that touch at a point, a boundary that meets itself) and put the rim only where the surface really
 * opens. The new vertex's place is then worked out from the faces of its group: a fixed or even thickness along
 * their normals, or `CONSTRAINTS`, which solves for the point that keeps every face at its own distance.
 *
 * Merging (`nonmanifold_merge_threshold`) collapses vertices closer than the threshold first, and faces that
 * would degenerate are dropped.
 *
 * Not carried: custom normals (as in Simple mode, compat-backlog C29), bevel weights (a `MeshData` has none —
 * `bevelConvex` therefore does nothing) and vertex creases (none either).
 */
import type { MeshData } from "../lib/mesh";
import { faceNormalCalc, type V3 } from "./blender-math";
import { seamKey } from "./edit-mode/half-edge";
import { calcEdges } from "./bmesh-lite";
import { vertexGroupWeights } from "./mesh-layers";

export interface SolidifyComplexOptions {
  /** `thickness`. Default 0.01. */
  thickness?: number;
  /** `offset`, −1 … 1: where the shell sits against the surface. Default −1 (inside). */
  offset?: number;
  /** `nonmanifold_thickness_mode`: `"FIXED"`, `"EVEN"` or `"CONSTRAINTS"` (Blender's default). */
  thicknessMode?: "FIXED" | "EVEN" | "CONSTRAINTS";
  /** `nonmanifold_boundary_mode`: how the shell's boundary is held — `"NONE"` (default), `"ROUND"` or `"FLAT"`. */
  boundaryMode?: "NONE" | "ROUND" | "FLAT";
  /** `nonmanifold_merge_threshold`: vertices closer than this merge first. Default 0.0001. */
  mergeThreshold?: number;
  /** `use_rim`. Default on. */
  rim?: boolean;
  /** `use_rim_only`: no shell, the rim alone. */
  rimOnly?: boolean;
  /** `use_flip_normals`. */
  flip?: boolean;
  /** `thickness_clamp`: at most this many times the shortest edge at a vertex. Default 0 (off). */
  thicknessClamp?: number;
  /** `use_thickness_angle_clamp`. */
  angleClamp?: boolean;
  /** `vertex_group`, `invert_vertex_group`, `thickness_vertex_group`, `use_flat_faces`. */
  vertexGroup?: string;
  invertVertexGroup?: boolean;
  vertexGroupFactor?: number;
  /** `use_flat_faces`: with a vertex group, the faces (not the vertices) take the weight, to stay flat. */
  flatFaces?: boolean;
  /**
   * `shell_vertex_group` / `rim_vertex_group`: groups the new shell / rim vertices go into at 1. Blender writes them only when the
   * object already has a group of that name; here the group is made when it is missing.
   */
  shellVertexGroup?: string;
  rimVertexGroup?: string;
  /** `material_offset` / `material_offset_rim` (clamped to the highest slot a face uses). */
  materialOffset?: number;
  materialOffsetRim?: number;
  /** `bevel_convex`: a bevel weight on the edges of the new shell — a `MeshData` has no weights, so not read. */
  bevelConvex?: number;
}

const f = Math.fround;
const FLT_EPSILON = 1.1920929e-7;
const EMPTY = -1; // MOD_SOLIDIFY_EMPTY_TAG, uint(-1)

const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V3 => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const mulFl = (a: readonly number[], k: number): V3 => [a[0]! * k, a[1]! * k, a[2]! * k];
const lenSq = (a: readonly number[]): number => dot(a, a);
const lenV = (a: readonly number[]): number => Math.sqrt(dot(a, a));
function normalizeIn(a: number[]): number {
  const d = dot(a, a);
  if (d > 1e-35) {
    const l = Math.sqrt(d);
    a[0] = a[0]! / l;
    a[1] = a[1]! / l;
    a[2] = a[2]! / l;
    return l;
  }
  a[0] = a[1] = a[2] = 0;
  return 0;
}
const safeAsin = (x: number): number => Math.asin(Math.max(-1, Math.min(1, x)));
function angleNormalized(a: readonly number[], b: readonly number[]): number {
  if (dot(a, b) >= 0) return 2 * safeAsin(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) / 2);
  return Math.PI - 2 * safeAsin(Math.hypot(a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!) / 2);
}
/** `angle_v3v3v3`: the angle at `v2`. */
function angleV3V3V3(v1: readonly number[], v2: readonly number[], v3: readonly number[]): number {
  const a = sub(v1, v2);
  const b = sub(v3, v2);
  normalizeIn(a);
  normalizeIn(b);
  return angleNormalized(a, b);
}
/** `project_v3_v3`: `r -= a · (r·a)`, returning the dot. */
function projectV3V3(r: number[], a: readonly number[]): number {
  const d = dot(r, a);
  r[0] = r[0]! - a[0]! * d;
  r[1] = r[1]! - a[1]! * d;
  r[2] = r[2]! - a[2]! * d;
  return d;
}
/** `angle_signed_on_axis_normalized_v3v3_v3`. */
function angleSignedOnAxisNormalized(n: readonly number[], refN: readonly number[], axis: readonly number[]): number {
  const d = Math.max(-1, Math.min(1, dot(n, refN)));
  let angle = Math.acos(d);
  const c = cross(n, refN);
  if (dot(c, axis) >= 0) angle = 2 * Math.PI - angle;
  return angle;
}
const clampNonzero = (value: number, epsilon: number): number => (value < 0 ? Math.min(value, -epsilon) : Math.max(value, epsilon));

/** `invert_m3` on a symmetric 3 × 3 (row-major array of 9), by the adjugate; unchanged when singular. */
function invertM3(m: number[]): void {
  const [a, b, c, d, e, g, h, i, j] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * j - g * i;
  const B = -(d * j - g * h);
  const C = d * i - e * h;
  const det = a * A + b * B + c * C;
  const inv = [
    A, -(b * j - c * i), b * g - c * e,
    B, a * j - c * h, -(a * g - c * d),
    C, -(a * i - b * h), a * e - b * d,
  ];
  if (det === 0) return;
  for (let k = 0; k < 9; k++) m[k] = inv[k]! / det;
}

interface NewFaceRef {
  face: number;
  /** `face_sides_arr` position: `face * 2 + (reversed ? 1 : 0)`. */
  slot: number;
  reversed: boolean;
  linkEdges: (NewEdgeRef | null)[];
}
interface NewEdgeRef {
  oldEdge: number;
  faces: [NewFaceRef | null, NewFaceRef | null];
  linkEdgeGroups: [EdgeGroup | null, EdgeGroup | null];
  angle: number;
  newEdge: number;
}
interface EdgeGroup {
  edges: NewEdgeRef[];
  openFaceEdge: number;
  isOrigClosed: boolean;
  isEvenSplit: boolean;
  split: number;
  isSingularity: boolean;
  topoGroup: number;
  co: V3;
  no: V3;
  newVert: number;
}
interface OldEdgeFaceRef {
  faces: number[];
  reversed: boolean[];
  used: number;
}
interface OldVertEdgeRef {
  edges: number[];
  edgesLen: number;
}

const newGroup = (edges: NewEdgeRef[], o: Partial<EdgeGroup>): EdgeGroup => ({
  edges,
  openFaceEdge: EMPTY,
  isOrigClosed: true,
  isEvenSplit: false,
  split: 0,
  isSingularity: false,
  topoGroup: 0,
  co: [0, 0, 0],
  no: [0, 0, 0],
  newVert: EMPTY,
  ...o,
});

/**
 * Blender's Solidify modifier, Complex mode — see the file's header. UVs, colours, vertex groups, materials, edge
 * creases, seams and sharp edges carry as Blender's `LegacyMeshInterpolator` copies them; custom normals do not.
 */
export function solidifyComplex(data: MeshData, opts: SolidifyComplexOptions = {}): MeshData {
  const vertsNum = data.positions.length / 3;
  const polys = data.polys;
  const facesNum = polys.length;
  if (facesNum === 0) return data;
  for (const p of polys)
    if (new Set(p).size !== p.length) throw new Error("solidifyComplex: a face repeats a vertex");

  const thickness = f(opts.thickness ?? 0.01);
  const offsetFac = f(opts.offset ?? -1);
  const doRim = opts.rim ?? true;
  const doShell = !(doRim && opts.rimOnly);
  const doFlip = !!opts.flip === (thickness > 0);
  const offsetClamp = f(opts.thicknessClamp ?? 0);
  const doClamp = offsetClamp !== 0;
  const doAngleClamp = !!opts.angleClamp;
  const offsetMode = opts.thicknessMode ?? "CONSTRAINTS";
  const boundaryMode = opts.boundaryMode ?? "NONE";
  const mergeTolerance = f(opts.mergeThreshold ?? 0.0001);
  const offsetFacVg = f(opts.vertexGroupFactor ?? 0);
  const offsetFacVgInv = 1 - offsetFacVg;

  const matMax = data.materials && data.materials.length ? Math.max(0, ...data.materials) : 0;
  const matNrs = matMax + 1;
  const matNrMax = matNrs - 1;
  const matOfs = matNrs > 1 ? opts.materialOffset ?? 0 : 0;
  const matOfsRim = matNrs > 1 ? opts.materialOffsetRim ?? 0 : 0;
  const srcMaterial = (face: number): number => data.materials?.[face] ?? 0;

  const ofsFront = f(f(f(offsetFac + 1) * 0.5) * thickness);
  const ofsBack = f(ofsFront - f(thickness * offsetFac));
  const ofsFrontClamped = clampNonzero(ofsFront, 1e-5);
  const ofsBackClamped = clampNonzero(ofsBack, 1e-5);
  const offset = Math.abs(thickness) * offsetClamp;

  const vg = vertexGroupWeights(data, opts.vertexGroup, opts.invertVertexGroup);
  const vgW = vg && !vg.empty ? vg.weights : null;
  const doFlatFaces = !!vgW && !!opts.flatFaces;

  // The edges in the order `mesh_calc_edges` makes them (the one the OBJ importer's mesh has), which decides the merge order.
  const origEdges: [number, number][] = calcEdges(polys, polys.length < 1000 ? 1 : 8);
  const edgeIndex = new Map<string, number>();
  origEdges.forEach((e, i) => edgeIndex.set(seamKey(e[0], e[1]), i));
  const edgeOf = (a: number, b: number): number => edgeIndex.get(seamKey(a, b))!;
  const faceStart: number[] = [];
  const cornerVerts: number[] = [];
  const cornerEdges: number[] = [];
  for (const p of polys) {
    faceStart.push(cornerVerts.length);
    for (let i = 0; i < p.length; i++) {
      cornerVerts.push(p[i]!);
      cornerEdges.push(edgeOf(p[i]!, p[(i + 1) % p.length]!));
    }
  }
  const edgesNum = origEdges.length;

  const origCo: V3[] = Array.from({ length: vertsNum }, (_, i) => [data.positions[i * 3]!, data.positions[i * 3 + 1]!, data.positions[i * 3 + 2]!]);
  const faceNors: V3[] = polys.map((p) => [...faceNormalCalc(origCo, p)] as V3);

  const faceSides: NewFaceRef[] = new Array(facesNum * 2);
  const nullFaces: boolean[] | null = offsetMode === "CONSTRAINTS" ? new Array<boolean>(facesNum).fill(false) : null;
  let largestNgon = 3;
  polys.forEach((p, i) => {
    if (lenSq(faceNors[i]!) < 0.5) {
      const edge = origEdges[cornerEdges[faceStart[i]!]!]!;
      const edgedir = sub(origCo[edge[1]]!, origCo[edge[0]]!);
      if (Math.abs(edgedir[2]!) < Math.abs(edgedir[1]!)) faceNors[i]![2] = 1;
      else faceNors[i]![1] = 1;
      if (nullFaces) nullFaces[i] = true;
    }
    faceSides[i * 2] = { face: i, slot: i * 2, reversed: false, linkEdges: new Array(p.length).fill(null) };
    faceSides[i * 2 + 1] = { face: i, slot: i * 2 + 1, reversed: true, linkEdges: new Array(p.length).fill(null) };
    if (p.length > largestNgon) largestNgon = p.length;
  });
  const otherSide = (face: NewFaceRef): NewFaceRef => faceSides[face.slot ^ 1]!;

  const edgeAdjFacesLen = new Array<number>(edgesNum).fill(0);
  polys.forEach((_, i) => {
    for (let c = 0; c < polys[i]!.length; c++) edgeAdjFacesLen[cornerEdges[faceStart[i]! + c]!]!++;
  });

  const origEdgeData: (NewEdgeRef[] | null)[] = new Array(edgesNum).fill(null);
  const origEdgeLengths = new Array<number>(edgesNum).fill(0);
  const origVertGroups: (EdgeGroup[] | null)[] = new Array(vertsNum).fill(null);
  const vm = Array.from({ length: vertsNum }, (_, i) => i);

  let hasSingularities = false;
  const vertAdjEdges: (OldVertEdgeRef | null)[] = new Array(vertsNum).fill(null);
  const mvertCo: V3[] = origCo.map((c) => [...c] as V3);
  let newVertsNum = 0;

  // ── the edge → NewEdgeRef map ──────────────────────────────────────────
  {
    const edgeAdjFaces: (OldEdgeFaceRef | null)[] = new Array(edgesNum).fill(null);
    polys.forEach((p, i) => {
      for (let c = 0; c < p.length; c++) {
        const vert = cornerVerts[faceStart[i]! + c]!;
        const edge = cornerEdges[faceStart[i]! + c]!;
        const reversed = origEdges[edge]![1] !== vert;
        const ref = edgeAdjFaces[edge];
        if (!ref) {
          const len = edgeAdjFacesLen[edge]!;
          const faces = new Array<number>(len).fill(EMPTY);
          const rev = new Array<boolean>(len).fill(false);
          faces[0] = i;
          rev[0] = reversed;
          edgeAdjFaces[edge] = { faces, reversed: rev, used: 1 };
        } else {
          for (let k = 1; k < ref.faces.length; k++)
            if (ref.faces[k] === EMPTY) {
              ref.faces[k] = i;
              ref.reversed[k] = reversed;
              break;
            }
        }
      }
    });

    let edgedir: V3 = [0, 0, 0];
    const vertAdjEdgesLen = new Array<number>(vertsNum).fill(0);

    // Edge lengths, and the merge of vertices closer than the tolerance.
    {
      const mergeTolSqr = f(mergeTolerance * mergeTolerance);
      const combinedVerts = new Array<number>(vertsNum).fill(0);
      for (let i = 0; i < edgesNum; i++) {
        const edge = origEdges[i]!;
        if (edgeAdjFacesLen[i]! > 0) {
          let v1 = vm[edge[0]]!;
          let v2 = vm[edge[1]]!;
          if (v1 === v2) continue;
          if (v2 < v1) [v1, v2] = [v2, v1];
          // `len_squared_v3` in float, a step at a time: a merge threshold that equals an edge's length is decided by this rounding.
          edgedir = sub(mvertCo[v2]!, mvertCo[v1]!).map(f) as V3;
          origEdgeLengths[i] = f(f(f(edgedir[0]! * edgedir[0]!) + f(edgedir[1]! * edgedir[1]!)) + f(edgedir[2]! * edgedir[2]!));
          if (origEdgeLengths[i]! <= mergeTolSqr) {
            // Merge verts, unless that would make a face with fewer than three distinct corners.
            let canMerge = true;
            const isV = (x: number): boolean => x === v1 || x === v2;
            for (let k = 0; k < edgesNum && canMerge; k++) {
              if (k !== i && edgeAdjFacesLen[k]! > 0 && isV(vm[origEdges[k]![0]]!) !== isV(vm[origEdges[k]![1]]!)) {
                const adj = edgeAdjFaces[k]!;
                for (let j = 0; j < adj.faces.length && canMerge; j++) {
                  const fi = adj.faces[j]!;
                  const size = polys[fi]!.length;
                  let changes = 0;
                  let hasMultipleUniqueOthers = false;
                  let uniqueOtherVert = EMPTY;
                  let cur = size - 1;
                  for (let next = 0; next < size && changes <= 2; next++) {
                    const curV = vm[cornerVerts[faceStart[fi]! + cur]!]!;
                    const nextV = vm[cornerVerts[faceStart[fi]! + next]!]!;
                    changes += isV(curV) !== isV(nextV) ? 1 : 0;
                    if (!isV(curV)) {
                      if (uniqueOtherVert === EMPTY) uniqueOtherVert = curV;
                      else if (uniqueOtherVert !== curV) hasMultipleUniqueOthers = true;
                    }
                    cur = next;
                  }
                  canMerge = canMerge && changes <= 2 && !(changes === 2 && !hasMultipleUniqueOthers);
                }
              }
            }
            if (!canMerge) {
              origEdgeLengths[i] = 0;
              vertAdjEdgesLen[v1]!++;
              vertAdjEdgesLen[v2]!++;
              continue;
            }
            edgedir = mulFl(edgedir, f((combinedVerts[v2]! + 1) / (combinedVerts[v1]! + combinedVerts[v2]! + 2))).map(f) as V3;
            mvertCo[v1] = add(mvertCo[v1]!, edgedir).map(f) as V3;
            for (let j = v2; j < vertsNum; j++) if (vm[j] === v2) vm[j] = v1;
            vertAdjEdgesLen[v1] = vertAdjEdgesLen[v1]! + vertAdjEdgesLen[v2]!;
            vertAdjEdgesLen[v2] = 0;
            combinedVerts[v1] = combinedVerts[v1]! + combinedVerts[v2]! + 1;
            edgeAdjFacesLen[i] = 0;
            edgeAdjFaces[i] = null;
          } else {
            origEdgeLengths[i] = f(Math.sqrt(origEdgeLengths[i]!));
            vertAdjEdgesLen[v1]!++;
            vertAdjEdgesLen[v2]!++;
          }
        }
      }
      // Remove zero faces in a second pass: an edge both of whose ends merged takes its faces with it.
      for (let i = 0; i < edgesNum; i++) {
        const edge = origEdges[i]!;
        const v1 = vm[edge[0]]!;
        const v2 = vm[edge[1]]!;
        if (v1 === v2 && edgeAdjFaces[i]) {
          edgeAdjFacesLen[i] = 0;
          edgeAdjFaces[i] = null;
        }
      }
    }

    // The vertex → edges map.
    for (let i = 0; i < edgesNum; i++) {
      const edge = origEdges[i]!;
      if (edgeAdjFacesLen[i]! > 0) {
        const vs = [vm[edge[0]]!, vm[edge[1]]!];
        let invalidEdgeIndex = 0;
        let invalidEdgeReversed = false;
        for (let j = 0; j < 2; j++) {
          const vert = vs[j]!;
          const len = vertAdjEdgesLen[vert]!;
          if (len > 0) {
            const ref = vertAdjEdges[vert];
            if (!ref) {
              const adj = new Array<number>(len).fill(EMPTY);
              adj[0] = i;
              vertAdjEdges[vert] = { edges: adj, edgesLen: 1 };
            } else {
              for (let k = 0; k < len && k <= ref.edgesLen; k++) {
                const e = ref.edges[k]!;
                if (e === EMPTY || k === ref.edgesLen) {
                  ref.edges[k] = i;
                  ref.edgesLen++;
                  break;
                }
                if (vm[origEdges[e]![0]] === vs[1 - j]) {
                  invalidEdgeIndex = e + 1;
                  invalidEdgeReversed = j === 0;
                  break;
                }
                if (vm[origEdges[e]![1]] === vs[1 - j]) {
                  invalidEdgeIndex = e + 1;
                  invalidEdgeReversed = j === 1;
                  break;
                }
              }
              if (invalidEdgeIndex) {
                // Should never actually be executed.
                if (j === 1) vertAdjEdges[vs[0]!]!.edgesLen--;
                break;
              }
            }
          }
        }
        // Remove zero faces in the shape of an edge: two edges between the same pair of merged verts become one.
        if (invalidEdgeIndex) {
          const kept = invalidEdgeIndex - 1;
          const dropped = i;
          const iAdj = edgeAdjFaces[kept]!;
          const invAdj = edgeAdjFaces[dropped]!;
          let j = 0;
          for (let k = 0; k < iAdj.faces.length; k++)
            for (let l = 0; l < invAdj.faces.length; l++)
              if (iAdj.faces[k] === invAdj.faces[l] && iAdj.faces[k] !== EMPTY) {
                iAdj.faces[k] = EMPTY;
                invAdj.faces[l] = EMPTY;
                j++;
              }
          const faces: number[] = [];
          const rev: boolean[] = [];
          for (let k = 0; k < iAdj.faces.length; k++)
            if (iAdj.faces[k] !== EMPTY) {
              faces.push(iAdj.faces[k]!);
              rev.push(iAdj.reversed[k]!);
            }
          for (let k = 0; k < invAdj.faces.length; k++)
            if (invAdj.faces[k] !== EMPTY) {
              faces.push(invAdj.faces[k]!);
              rev.push(invalidEdgeReversed !== invAdj.reversed[k]!);
            }
          edgeAdjFacesLen[dropped] = 0;
          edgeAdjFacesLen[kept] = faces.length;
          iAdj.faces = faces;
          iAdj.reversed = rev;
          iAdj.used += invAdj.used;
          edgeAdjFaces[dropped] = iAdj;
          // Reset the counter to continue after the edge that was being handled.
          i = dropped;
        }
      }
    }

    // Filter duplicate faces: two faces with the same vertices (after merging) leave one.
    for (let i = 0; i < edgesNum; i++) {
      if (edgeAdjFacesLen[i]! > 0) {
        const adj = edgeAdjFaces[i]!;
        let adjLen = adj.faces.length;
        if (adjLen > 1) {
          for (let j = 0; j < adjLen; j++) {
            const face = adj.faces[j]!;
            const jLoopStart = faceStart[face]!;
            const totloop = polys[face]!.length;
            const jFirstV = vm[cornerVerts[jLoopStart]!]!;
            for (let k = j + 1; k < adjLen; k++) {
              if (polys[adj.faces[k]!]!.length !== totloop) continue;
              const kLoopStart = faceStart[adj.faces[k]!]!;
              let l = 0;
              while (l < totloop && vm[cornerVerts[kLoopStart + l]!] !== jFirstV) l++;
              if (l === totloop) continue;
              const reversed = adj.reversed[j] !== adj.reversed[k];
              const countDir = reversed ? -1 : 1;
              let hasDiff = false;
              for (let m = 0, n = l + totloop; m < totloop && !hasDiff; m++, n += countDir) {
                const vert = cornerVerts[jLoopStart + m]!;
                hasDiff = hasDiff || vm[vert] !== vm[cornerVerts[kLoopStart + (n % totloop)]!];
              }
              if (!hasDiff) {
                for (let m = 0; m < totloop; m++) {
                  const e = cornerEdges[jLoopStart + m]!;
                  const eAdj = edgeAdjFaces[e];
                  if (eAdj) {
                    let faceIndex = j;
                    if (eAdj.faces !== adj.faces) {
                      faceIndex = 0;
                      while (faceIndex < eAdj.faces.length && eAdj.faces[faceIndex] !== face) faceIndex++;
                      if (faceIndex === eAdj.faces.length) continue;
                    } else adjLen--;
                    eAdj.faces.splice(faceIndex, 1);
                    eAdj.reversed.splice(faceIndex, 1);
                    if (edgeAdjFacesLen[e]! > 0) {
                      edgeAdjFacesLen[e]!--;
                      if (edgeAdjFacesLen[e] === 0) {
                        eAdj.used--;
                        edgeAdjFaces[e] = null;
                      }
                    } else if (eAdj.used > 1) {
                      for (let n = 0; n < edgesNum; n++)
                        if (edgeAdjFaces[n] === eAdj && edgeAdjFacesLen[n]! > 0) {
                          edgeAdjFacesLen[n]!--;
                          if (edgeAdjFacesLen[n] === 0) {
                            edgeAdjFaces[n]!.used--;
                            edgeAdjFaces[n] = null;
                          }
                          break;
                        }
                    }
                  }
                }
                break;
              }
            }
          }
        }
      }
    }

    // The NewEdgeRef arrays.
    for (let i = 0; i < edgesNum; i++) {
      const edge = origEdges[i]!;
      const v1 = vm[edge[0]]!;
      const v2 = vm[edge[1]]!;
      if (edgeAdjFacesLen[i]! > 0) {
        if (origEdgeLengths[i]! > FLT_EPSILON) {
          edgedir = sub(mvertCo[v2]!, mvertCo[v1]!);
          edgedir = mulFl(edgedir, 1 / origEdgeLengths[i]!);
        } else {
          // Smart fallback: the edge has no length, so its direction is taken from the edges around it.
          const pos = mvertCo[v2]!;
          const link1 = vertAdjEdges[v1]!;
          let v1Dir: V3 = [0, 0, 0];
          for (let j = 0; j < link1.edgesLen; j++) {
            const e = link1.edges[j]!;
            if (edgeAdjFacesLen[e]! > 0 && e !== i) {
              const otherV = vm[vm[origEdges[e]![0]] === v1 ? origEdges[e]![1] : origEdges[e]![0]]!;
              edgedir = sub(mvertCo[otherV]!, pos);
              v1Dir = add(v1Dir, edgedir);
            }
          }
          const link2 = vertAdjEdges[v2]!;
          let v2Dir: V3 = [0, 0, 0];
          for (let j = 0; j < link2.edgesLen; j++) {
            const e = link2.edges[j]!;
            if (edgeAdjFacesLen[e]! > 0 && e !== i) {
              const otherV = vm[vm[origEdges[e]![0]] === v2 ? origEdges[e]![1] : origEdges[e]![0]]!;
              edgedir = sub(mvertCo[otherV]!, pos);
              v2Dir = add(v2Dir, edgedir);
            }
          }
          edgedir = sub(v2Dir, v1Dir);
          if (normalizeIn(edgedir) === 0) edgedir = [0, 0, 1];
        }

        const adj = edgeAdjFaces[i]!;
        const adjLen = adj.faces.length;
        let newEdgesLen = 0;
        const sortedFaces: { angle: number; face: NewFaceRef }[] = new Array(adjLen);
        if (adjLen > 1) {
          newEdgesLen = adjLen;
          let refNor: V3 = [0, 0, 0];
          for (let j = 0; j < adjLen; j++) {
            const reverse = adj.reversed[j]!;
            const faceI = adj.faces[j]!;
            const nor: number[] = reverse ? [-faceNors[faceI]![0]!, -faceNors[faceI]![1]!, -faceNors[faceI]![2]!] : [...faceNors[faceI]!];
            let d = 1;
            if (polys[faceI]!.length > 3) {
              d = projectV3V3(nor, edgedir);
              if (d !== 0) d = normalizeIn(nor);
              else d = 1;
            }
            let angle: number;
            if (d === 0) angle = 0;
            else if (j === 0) {
              refNor = [nor[0]!, nor[1]!, nor[2]!];
              angle = 0;
            } else angle = -angleSignedOnAxisNormalized(nor, refNor, edgedir);
            sortedFaces[j] = { angle, face: faceSides[adj.faces[j]! * 2 + (adj.reversed[j]! ? 1 : 0)]! };
          }
          // Order the faces round the edge (a stable sort on the angle, as the C library's `qsort` is for short arrays).
          sortedFaces.sort((a, b) => Number(a.angle > b.angle) - Number(a.angle < b.angle));
        } else {
          newEdgesLen = 2;
          sortedFaces[0] = { angle: 0, face: faceSides[adj.faces[0]! * 2 + (adj.reversed[0]! ? 1 : 0)]! };
        }

        const newEdges: NewEdgeRef[] = [];
        for (let j = 0; j < newEdgesLen; j++) {
          let faces: [NewFaceRef | null, NewFaceRef | null];
          let angle: number;
          if (adjLen > 1) {
            const nextJ = j + 1 === adjLen ? 0 : j + 1;
            faces = [sortedFaces[j]!.face, otherSide(sortedFaces[nextJ]!.face)];
            angle = sortedFaces[nextJ]!.angle - sortedFaces[j]!.angle;
            if (angle < 0) angle += 2 * Math.PI;
          } else {
            const base = sortedFaces[0]!.face;
            faces = [faceSides[base.reversed ? base.slot - j : base.slot + j]!, null];
            angle = 0;
          }
          const edgeData: NewEdgeRef = {
            oldEdge: i,
            faces,
            linkEdgeGroups: [null, null],
            angle,
            newEdge: doShell || (adjLen === 1 && doRim) ? 0 : EMPTY,
          };
          newEdges.push(edgeData);
          for (let k = 0; k < 2; k++) {
            const fk = faces[k];
            if (fk) {
              for (let l = 0; l < polys[fk.face]!.length; l++) {
                const edge2 = cornerEdges[faceStart[fk.face]! + l]!;
                if (edgeAdjFaces[edge2] === edgeAdjFaces[i]) {
                  if (edge2 !== i && origEdgeData[edge2] === null) origEdgeData[edge2] = newEdges;
                  fk.linkEdges[l] = edgeData;
                  break;
                }
              }
            }
          }
        }
        origEdgeData[i] = newEdges;
      }
    }
  }

  // ── sorted edge groups for every vertex ────────────────────────────────
  for (let i = 0; i < vertsNum; i++) {
    const adjRef = vertAdjEdges[i];
    if (!adjRef || adjRef.edgesLen < 2) continue;
    const edgeGroups: EdgeGroup[] = [];
    let egIndex = -1;
    let containsLongGroups = false;
    let topoGroups = 0;

    // Initial sorted creation.
    {
      const adjEdges = adjRef.edges;
      const totAdjEdges = adjRef.edgesLen;
      const unassigned: (NewEdgeRef | null)[] = [];
      for (let j = 0; j < totAdjEdges; j++) {
        const newEdges = origEdgeData[adjEdges[j]!];
        if (newEdges) for (const e of newEdges) unassigned.push(e);
      }
      const unassignedLen = unassigned.length;
      let assignedLen = 0;
      let foundEdge: NewEdgeRef | null = null;
      let foundEdgeIndex = 0;
      let insertAtStart = false;
      const egTrackFaces: (NewFaceRef | null)[] = [null, null];
      let lastOpenEdgeTrack: NewFaceRef | null = null;

      while (assignedLen < unassignedLen) {
        foundEdge = null;
        insertAtStart = false;
        if (egIndex >= 0 && edgeGroups[egIndex]!.edges.length === 0) {
          // A group was just started: find an unused edge to begin it.
          let j = 0;
          let edge: NewEdgeRef | null = null;
          while (!edge && j < unassignedLen) {
            edge = unassigned[j++] ?? null;
            if (edge && lastOpenEdgeTrack && (edge.faces[0] !== lastOpenEdgeTrack || edge.faces[1] !== null)) edge = null;
          }
          if (!edge && lastOpenEdgeTrack) {
            topoGroups++;
            lastOpenEdgeTrack = null;
            edgeGroups[egIndex]!.topoGroup++;
            j = 0;
            while (!edge && j < unassignedLen) edge = unassigned[j++] ?? null;
          } else if (!lastOpenEdgeTrack && egIndex > 0) {
            topoGroups++;
            edgeGroups[egIndex]!.topoGroup++;
          }
          foundEdgeIndex = j - 1;
          foundEdge = edge!;
          if (!lastOpenEdgeTrack && vm[origEdges[edge!.oldEdge]![0]] === i) {
            egTrackFaces[0] = edge!.faces[0];
            egTrackFaces[1] = edge!.faces[1];
            if (edge!.faces[1] === null) lastOpenEdgeTrack = otherSide(edge!.faces[0]!);
          } else {
            egTrackFaces[0] = edge!.faces[1];
            egTrackFaces[1] = edge!.faces[0];
          }
        } else if (egIndex >= 0) {
          for (foundEdgeIndex = 0; foundEdgeIndex < unassignedLen; foundEdgeIndex++) {
            const edge = unassigned[foundEdgeIndex];
            if (edge) {
              if (edge.faces[0] === egTrackFaces[1]) {
                insertAtStart = false;
                egTrackFaces[1] = edge.faces[1];
                foundEdge = edge;
                if (edge.faces[1] === null) {
                  edgeGroups[egIndex]!.isOrigClosed = false;
                  lastOpenEdgeTrack = otherSide(edge.faces[0]!);
                }
                break;
              }
              if (edge.faces[0] === egTrackFaces[0]) {
                insertAtStart = true;
                egTrackFaces[0] = edge.faces[1];
                foundEdge = edge;
                if (edge.faces[1] === null) edgeGroups[egIndex]!.isOrigClosed = false;
                break;
              }
              if (edge.faces[1] !== null) {
                if (edge.faces[1] === egTrackFaces[1]) {
                  insertAtStart = false;
                  egTrackFaces[1] = edge.faces[0];
                  foundEdge = edge;
                  break;
                }
                if (edge.faces[1] === egTrackFaces[0]) {
                  insertAtStart = true;
                  egTrackFaces[0] = edge.faces[0];
                  foundEdge = edge;
                  break;
                }
              }
            }
          }
        }
        if (foundEdge) {
          unassigned[foundEdgeIndex] = null;
          assignedLen++;
          const grp = edgeGroups[egIndex]!;
          if (insertAtStart) grp.edges.unshift(foundEdge);
          else grp.edges.push(foundEdge);
          if (grp.edges[grp.edges.length - 1]!.faces[1] !== null) lastOpenEdgeTrack = null;
          if (grp.edges.length > 3) containsLongGroups = true;
        } else {
          // First iteration, or the current group is complete: start a new one.
          egIndex++;
          edgeGroups[egIndex] = newGroup([], { topoGroup: topoGroups });
          egTrackFaces[0] = null;
          egTrackFaces[1] = null;
        }
      }
      egIndex++;
      topoGroups++;
    }

    // Split long self-intersecting groups.
    {
      let splits = 0;
      if (containsLongGroups) {
        let addIndex = 0;
        for (let j = 0; j < egIndex; j++) {
          const edgesLen = edgeGroups[j + addIndex]!.edges.length;
          if (edgesLen > 3) {
            let hasDoubles = false;
            const doubles = new Array<boolean>(edgesLen).fill(false);
            const g = edgeGroups[j + addIndex]!;
            for (let k = 0; k < edgesLen; k++)
              for (let l = k + 1; l < edgesLen; l++)
                if (g.edges[k]!.oldEdge === g.edges[l]!.oldEdge) {
                  doubles[k] = true;
                  doubles[l] = true;
                  hasDoubles = true;
                }
            if (hasDoubles) {
              const priorSplits = splits;
              const priorIndex = addIndex;
              let uniqueStart = -1;
              let firstUniqueEnd = -1;
              let lastSplit = -1;
              let firstSplit = -1;
              let firstEvenSplit = false;
              let realK = 0;
              while (
                realK < edgesLen ||
                (g.isOrigClosed && (realK <= (firstUniqueEnd === -1 ? 0 : firstUniqueEnd) + edgesLen || firstSplit !== lastSplit))
              ) {
                const k = realK % edgesLen;
                if (!doubles[k]) {
                  if (firstUniqueEnd !== -1 && uniqueStart === -1) uniqueStart = realK;
                } else if (firstUniqueEnd === -1) firstUniqueEnd = k;
                else if (uniqueStart !== -1) {
                  const split = Math.floor((uniqueStart + realK + 1) / 2) % edgesLen;
                  const isEvenSplit = ((uniqueStart + realK) & 1) !== 0;
                  if (lastSplit !== -1) {
                    // Override g on the first split (no insert).
                    if (priorSplits !== splits) {
                      // `memmove(edge_groups + j + add_index + 1, …)`: a slot after the group just written.
                      edgeGroups.splice(j + addIndex + 1, 0, g);
                      addIndex++;
                    }
                    let edges: NewEdgeRef[];
                    if (lastSplit > split) edges = [...g.edges.slice(lastSplit), ...g.edges.slice(0, split)];
                    else edges = g.edges.slice(lastSplit, split);
                    edgeGroups[j + addIndex] = newGroup(edges, {
                      isOrigClosed: g.isOrigClosed,
                      isEvenSplit,
                      split: addIndex - priorIndex + 1 + (g.isOrigClosed ? 0 : 1),
                      topoGroup: g.topoGroup,
                    });
                    splits++;
                  }
                  lastSplit = split;
                  if (firstSplit === -1) {
                    firstSplit = split;
                    firstEvenSplit = isEvenSplit;
                  }
                  uniqueStart = -1;
                }
                realK++;
              }
              if (firstSplit !== -1) {
                if (!g.isOrigClosed) {
                  // Two slots round the split groups (one before, one after), or one after `g` when it was not split.
                  if (priorSplits !== splits) {
                    // `memmove` copies what is there: the first split piece goes one slot up, the last one after the pieces.
                    edgeGroups.splice(j + priorIndex + 1, 0, edgeGroups[j + priorIndex]!);
                    edgeGroups.splice(j + addIndex + 2, 0, edgeGroups[j + addIndex + 1]!);
                    addIndex++;
                  } else edgeGroups.splice(j + addIndex + 1, 0, g);
                  edgeGroups[j + priorIndex] = newGroup(g.edges.slice(0, firstSplit), {
                    isOrigClosed: g.isOrigClosed,
                    isEvenSplit: firstEvenSplit,
                    split: 1,
                    topoGroup: g.topoGroup,
                  });
                  addIndex++;
                  splits++;
                  edgeGroups[j + addIndex] = newGroup(g.edges.slice(lastSplit), {
                    isOrigClosed: g.isOrigClosed,
                    isEvenSplit: false,
                    split: addIndex - priorIndex + 1,
                    topoGroup: g.topoGroup,
                  });
                }
              }
              if (firstUniqueEnd !== -1 && priorSplits === splits) {
                hasSingularities = true;
                edgeGroups[j + addIndex]!.isSingularity = true;
              }
            }
          }
        }
      }
    }

    origVertGroups[i] = edgeGroups;
    // Link every NewEdgeRef to its groups and number the groups' new vertices.
    for (const g of edgeGroups) {
      for (const e of g.edges) {
        const flip = vm[origEdges[e.oldEdge]![1]] === i ? 1 : 0;
        e.linkEdgeGroups[flip] = g;
      }
      if (doShell || (doRim && !g.isOrigClosed)) g.newVert = newVertsNum++;
    }
  }

  // ── the EdgeGroup vertex positions ─────────────────────────────────────
  {
    let faceWeight: number[] | null = null;
    if (doFlatFaces) {
      faceWeight = polys.map((p) => {
        let scalar = 1;
        for (const v of p) {
          const w = vgW![v]!;
          scalar = Math.min(w, scalar);
        }
        return offsetFacVg + scalar * offsetFacVgInv;
      });
    }

    for (let i = 0; i < vertsNum; i++) {
      const groups = origVertGroups[i];
      if (!groups) continue;
      for (const g of groups) {
        if (!g.isSingularity) {
          let nor: V3 = g.no;
          let moveNor: V3 = [0, 0, 0];
          let disableBoundaryFix = boundaryMode === "NONE" || g.isOrigClosed || g.split !== 0;
          let approximateFreeDirection = false;
          if (offsetMode === "CONSTRAINTS") {
            let firstEdge: NewEdgeRef | null = null;
            const planesQueue: number[][] = [];
            let fallbackNor: V3 = [0, 0, 0];
            let fallbackOfs = 0;
            const cycle = (g.isOrigClosed && !g.split) || g.isEvenSplit;
            for (let k = 0; k < g.edges.length; k++) {
              if (!(k & 1) || (!cycle && k === g.edges.length - 1)) {
                const edge = g.edges[k]!;
                for (let l = 0; l < 2; l++) {
                  const face = edge.faces[l];
                  if (face && (firstEdge === null || (firstEdge.faces[0] !== face && firstEdge.faces[1] !== face))) {
                    let ofs = face.reversed ? ofsBackClamped : ofsFrontClamped;
                    if (doFlatFaces) ofs *= faceWeight![face.face]!;
                    if (!nullFaces![face.face]) {
                      const n = mulFl(faceNors[face.face]!, face.reversed ? -1 : 1);
                      planesQueue.push([n[0]!, n[1]!, n[2]!, ofs]);
                    } else {
                      fallbackNor = mulFl(faceNors[face.face]!, face.reversed ? -1 : 1);
                      fallbackOfs = ofs;
                    }
                  }
                }
                if ((cycle && k === 0) || (!cycle && k + 3 >= g.edges.length)) firstEdge = edge;
              }
            }
            let queueIndex = planesQueue.length;
            const swap = (a: number, b: number): void => {
              const t = planesQueue[a]!;
              planesQueue[a] = planesQueue[b]!;
              planesQueue[b] = t;
            };
            if (queueIndex > 2) {
              // Find the two most different normals.
              let minP = 2;
              let minN0 = 0;
              let minN1 = 0;
              for (let k = 0; k < queueIndex; k++)
                for (let m = k + 1; m < queueIndex; m++) {
                  const p = dot(planesQueue[k]!, planesQueue[m]!);
                  if (p < minP) {
                    minP = p;
                    minN0 = k;
                    minN1 = m;
                  }
                }
              // Put them first in the queue.
              if (minN1 !== 0) {
                swap(minN0, 0);
                swap(minN1, 1);
              } else swap(minN0, 1);
              // Find the third most different one.
              minP = 1;
              minN1 = 2;
              let maxP = -1;
              for (let k = 2; k < queueIndex; k++) {
                maxP = Math.max(dot(planesQueue[0]!, planesQueue[k]!), dot(planesQueue[1]!, planesQueue[k]!));
                if (maxP <= minP) {
                  minP = maxP;
                  minN1 = k;
                }
              }
              swap(minN1, 2);
            }
            // Remove / average duplicate normals.
            while (queueIndex > 2) {
              let bestN0 = 0;
              let bestN1 = 0;
              let bestP = -1;
              let bestOfsDiff = 0;
              for (let k = 0; k < queueIndex; k++)
                for (let m = k + 1; m < queueIndex; m++) {
                  const p = dot(planesQueue[m]!, planesQueue[k]!);
                  const ofsDiff = Math.abs(planesQueue[m]![3]! - planesQueue[k]![3]!);
                  if (p > bestP + FLT_EPSILON || (p >= bestP && ofsDiff < bestOfsDiff)) {
                    bestP = p;
                    bestOfsDiff = ofsDiff;
                    bestN0 = k;
                    bestN1 = m;
                  }
                }
              // Equal planes only: the threshold keeps the methods below free of numerical trouble.
              if (bestP < 0.98) break;
              const a = planesQueue[bestN0]!;
              const b = planesQueue[bestN1]!;
              const sum: number[] = [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
              normalizeIn(sum);
              planesQueue[bestN0] = [sum[0]!, sum[1]!, sum[2]!, (a[3]! + b[3]!) * 0.5];
              queueIndex--;
              planesQueue.splice(bestN1, 1);
            }
            const size = queueIndex;
            // With more than two planes the boundary fix may only be used if it keeps the thickness within ~10%.
            const boundaryFixThreshold = 0.7;
            if (size > 3) {
              // The most general least squares.
              const mat = new Array<number>(9).fill(0);
              for (let k = 0; k < 3; k++) {
                for (let m = 0; m < size; m++)
                  for (let c = 0; c < 3; c++) mat[k * 3 + c] = mat[k * 3 + c]! + planesQueue[m]![c]! * planesQueue[m]![k]!;
                mat[k * 3 + k] = mat[k * 3 + k]! + 5e-5;
              }
              invertM3(mat);
              nor = [0, 0, 0];
              for (let k = 0; k < size; k++) nor = [nor[0]! + planesQueue[k]![0]! * planesQueue[k]![3]!, nor[1]! + planesQueue[k]![1]! * planesQueue[k]![3]!, nor[2]! + planesQueue[k]![2]! * planesQueue[k]![3]!];
              nor = [
                mat[0]! * nor[0]! + mat[3]! * nor[1]! + mat[6]! * nor[2]!,
                mat[1]! * nor[0]! + mat[4]! * nor[1]! + mat[7]! * nor[2]!,
                mat[2]! * nor[0]! + mat[5]! * nor[1]! + mat[8]! * nor[2]!,
              ];
              if (!disableBoundaryFix) {
                let greatestAngleCos = 1;
                for (let k = 0; k < 2; k++)
                  for (let m = 2; m < size; m++) greatestAngleCos = Math.min(dot(planesQueue[m]!, planesQueue[k]!), greatestAngleCos);
                if (greatestAngleCos > boundaryFixThreshold) approximateFreeDirection = true;
                else disableBoundaryFix = true;
              }
            } else if (size > 1) {
              // Up to three constraint normals have a direct solution.
              const stopExplosion = 0.999 - Math.abs(offsetFac) * 0.05;
              const q = dot(planesQueue[0]!, planesQueue[1]!);
              let d = 1 - q * q;
              moveNor = cross(planesQueue[0]!, planesQueue[1]!);
              normalizeIn(moveNor);
              let p0 = planesQueue[0]!;
              let p1 = planesQueue[1]!;
              if (d > FLT_EPSILON * 10 && q < stopExplosion) {
                d = 1 / d;
                const s0 = (p0[3]! - p1[3]! * q) * d;
                const s1 = (p1[3]! - p0[3]! * q) * d;
                p0 = [p0[0]! * s0, p0[1]! * s0, p0[2]! * s0, p0[3]!];
                p1 = [p1[0]! * s1, p1[1]! * s1, p1[2]! * s1, p1[3]!];
              } else {
                d = 1 / (Math.abs(q) + 1);
                p0 = [p0[0]! * p0[3]! * d, p0[1]! * p0[3]! * d, p0[2]! * p0[3]! * d, p0[3]!];
                p1 = [p1[0]! * p1[3]! * d, p1[1]! * p1[3]! * d, p1[2]! * p1[3]! * d, p1[3]!];
              }
              nor = add(p0, p1);
              if (size === 3) {
                const p2 = planesQueue[2]!;
                d = dot(p2, moveNor);
                // The third plane is ignored when it is almost orthogonal to the still-free direction.
                if (Math.abs(d) > 0.02) {
                  let tmp: V3 = [nor[0]! + p2[0]! * -p2[3]!, nor[1]! + p2[1]! * -p2[3]!, nor[2]! + p2[2]! * -p2[3]!];
                  tmp = mulFl(moveNor, dot(p2, tmp) / d);
                  nor = sub(nor, tmp);
                  // Disable the boundary fix if the constraints would be majorly unsatisfied.
                  if (Math.abs(d) > 1 - boundaryFixThreshold) disableBoundaryFix = true;
                }
              }
              approximateFreeDirection = false;
            } else if (size === 1) {
              // A face corner.
              nor = mulFl(planesQueue[0]!, planesQueue[0]![3]!);
              if (g.edges.length > 2) {
                disableBoundaryFix = true;
                approximateFreeDirection = true;
              }
            } else {
              // Fallback for null faces.
              nor = mulFl(fallbackNor, fallbackOfs);
              disableBoundaryFix = true;
            }
          } else {
            // Fixed / Even.
            let totalAngle = 0;
            let totalAngleBack = 0;
            let firstEdge: NewEdgeRef | null = null;
            nor = [0, 0, 0];
            let norBack: V3 = [0, 0, 0];
            let hasBack = false;
            let hasFront = false;
            const cycle = (g.isOrigClosed && !g.split) || g.isEvenSplit;
            for (let k = 0; k < g.edges.length; k++) {
              if (!(k & 1) || (!cycle && k === g.edges.length - 1)) {
                const edge = g.edges[k]!;
                for (let l = 0; l < 2; l++) {
                  const face = edge.faces[l];
                  if (face && (firstEdge === null || (firstEdge.faces[0] !== face && firstEdge.faces[1] !== face))) {
                    let angle = 1;
                    let ofs = face.reversed ? -ofsBackClamped : ofsFrontClamped;
                    if (doFlatFaces) ofs *= faceWeight![face.face]!;
                    if (offsetMode === "EVEN") {
                      const size = polys[face.face]!.length;
                      const start = faceStart[face.face]!;
                      let cornerNext = start;
                      let corner = cornerNext + (size - 1);
                      let cornerPrev = corner - 1;
                      for (let m = 0; m < size && vm[cornerVerts[corner]!] !== i; m++, cornerNext++) {
                        cornerPrev = corner;
                        corner = cornerNext;
                      }
                      angle = angleV3V3V3(mvertCo[vm[cornerVerts[cornerPrev]!]!]!, mvertCo[i]!, mvertCo[vm[cornerVerts[cornerNext]!]!]!);
                      if (face.reversed) totalAngleBack += angle * ofs * ofs;
                      else totalAngle += angle * ofs * ofs;
                    } else if (face.reversed) totalAngleBack++;
                    else totalAngle++;
                    const faceNor = mulFl(faceNors[face.face]!, angle * ofs);
                    if (face.reversed) {
                      norBack = add(norBack, faceNor);
                      hasBack = true;
                    } else {
                      nor = add(nor, faceNor);
                      hasFront = true;
                    }
                  }
                }
                if ((cycle && k === 0) || (!cycle && k + 3 >= g.edges.length)) firstEdge = edge;
              }
            }
            if (offsetMode === "EVEN") {
              if (hasFront) {
                const lengthSq = lenSq(nor);
                if (lengthSq > FLT_EPSILON) nor = mulFl(nor, totalAngle / lengthSq);
              }
              if (hasBack) {
                const lengthSq = lenSq(norBack);
                if (lengthSq > FLT_EPSILON) norBack = mulFl(norBack, totalAngleBack / lengthSq);
                if (!hasFront) nor = [...norBack] as V3;
              }
              if (hasFront && hasBack) {
                const norLength = lenV(nor);
                const norBackLength = lenV(norBack);
                let q = dot(nor, norBack);
                if (Math.abs(q) > FLT_EPSILON) q /= norLength * norBackLength;
                let d = 1 - q * q;
                if (d > FLT_EPSILON) {
                  d = 1 / d;
                  if (norLength > FLT_EPSILON) nor = mulFl(nor, (1 - (norBackLength * q) / norLength) * d);
                  if (norBackLength > FLT_EPSILON) norBack = mulFl(norBack, (1 - (norLength * q) / norBackLength) * d);
                  nor = add(nor, norBack);
                } else {
                  nor = mulFl(nor, 0.5);
                  norBack = mulFl(norBack, 0.5);
                  nor = add(nor, norBack);
                }
              }
            } else {
              if (hasFront && totalAngle > FLT_EPSILON) nor = mulFl(nor, 1 / totalAngle);
              if (hasBack && totalAngleBack > FLT_EPSILON) {
                norBack = mulFl(norBack, 1 / totalAngleBack);
                nor = add(nor, norBack);
                if (hasFront && totalAngle > FLT_EPSILON) nor = mulFl(nor, 0.5);
              }
            }
            // Set move_nor for the boundary fix.
            if (!disableBoundaryFix && g.edges.length > 2) approximateFreeDirection = true;
            else disableBoundaryFix = true;
          }
          if (approximateFreeDirection) {
            let k: number;
            for (k = 1; k + 1 < g.edges.length; k++) {
              const edge = origEdges[g.edges[k]!.oldEdge]!;
              const tmp = sub(mvertCo[vm[edge[0]] === i ? edge[1] : edge[0]]!, mvertCo[i]!);
              moveNor = add(moveNor, tmp);
            }
            if (k === 1) disableBoundaryFix = true;
            else {
              const m = [...moveNor];
              disableBoundaryFix = normalizeIn(m) === 0;
              moveNor = [m[0]!, m[1]!, m[2]!];
            }
          }
          // Fix boundary verts.
          if (!disableBoundaryFix) {
            let constrNor: number[];
            const e0Edge = origEdges[g.edges[0]!.oldEdge]!;
            const e1Edge = origEdges[g.edges[g.edges.length - 1]!.oldEdge]!;
            const e0 = sub(mvertCo[vm[e0Edge[0]] === i ? e0Edge[1] : e0Edge[0]]!, mvertCo[i]!);
            const e1 = sub(mvertCo[vm[e1Edge[0]] === i ? e1Edge[1] : e1Edge[0]]!, mvertCo[i]!);
            if (boundaryMode === "FLAT") {
              constrNor = cross(e0, e1);
              normalizeIn(constrNor);
            } else {
              const first = g.edges[0]!.faces[0]!;
              const last = g.edges[g.edges.length - 1]!.faces[0]!;
              const f0 = mulFl(faceNors[first.face]!, first.reversed ? -1 : 1);
              const f1 = mulFl(faceNors[last.face]!, last.reversed ? -1 : 1);
              const n0 = cross(e0, f0);
              const n1 = cross(f1, e1);
              normalizeIn(n0);
              normalizeIn(n1);
              constrNor = add(n0, n1);
              normalizeIn(constrNor);
            }
            const d = dot(constrNor, moveNor);
            // Only allow the thickness to increase about 10 times.
            if (Math.abs(d) > 0.1) {
              moveNor = mulFl(moveNor, dot(constrNor, nor) / d);
              nor = sub(nor, moveNor);
            }
          }
          let scalarVgroup = 1;
          if (vgW && !doFlatFaces) scalarVgroup = offsetFacVg + vgW[i]! * offsetFacVgInv;
          // Clamping.
          if (doClamp) {
            if (doAngleClamp) {
              if (g.edges.length > 2) {
                let minLength = 0;
                let angle = 0.5 * Math.PI;
                g.edges.forEach((p, k) => {
                  const length = origEdgeLengths[p.oldEdge]!;
                  angle = Math.max(p.angle, angle);
                  if (length < minLength || k === 0) minLength = length;
                });
                const cosAng = Math.cos(angle * 0.5);
                if (cosAng > 0) {
                  const maxOff = (minLength * 0.5) / cosAng;
                  if (maxOff < offset * 0.5) scalarVgroup *= (maxOff / offset) * 2;
                }
              }
            } else {
              let minLength = 0;
              g.edges.forEach((p, k) => {
                const length = origEdgeLengths[p.oldEdge]!;
                if (length < minLength || k === 0) minLength = length;
              });
              if (minLength < offset) scalarVgroup *= minLength / offset;
            }
          }
          nor = mulFl(nor, scalarVgroup);
          g.co = add(nor, mvertCo[i]!);
        } else g.co = [...mvertCo[i]!] as V3;
      }
    }
  }

  // ── correction for adjacent one-sided groups (singularities) ───────────
  const singularityEdges: [number, number][] = [];
  if (hasSingularities) {
    hasSingularities = false;
    for (let i = 0; i < edgesNum; i++) {
      const newEdges = origEdgeData[i];
      if (newEdges && (doShell || edgeAdjFacesLen[i] === 1) && newEdges[0]!.oldEdge === i) {
        for (const l of newEdges) {
          if (l.linkEdgeGroups[0]!.isSingularity && l.linkEdgeGroups[1]!.isSingularity) {
            const v1 = l.linkEdgeGroups[0]!.newVert;
            const v2 = l.linkEdgeGroups[1]!.newVert;
            const exists = singularityEdges.some((p) => (p[0] === v1 && p[1] === v2) || (p[0] === v2 && p[1] === v1));
            if (!exists) {
              hasSingularities = true;
              singularityEdges.push([v1, v2]);
            }
          }
        }
      }
    }
  }
  const totSingularity = singularityEdges.length;

  // ── the result ─────────────────────────────────────────────────────────
  const outPos: V3[] = new Array(newVertsNum);
  const srcVert: number[] = new Array(newVertsNum).fill(EMPTY);
  const outEdges: [number, number][] = [];
  const srcEdge: number[] = [];
  const outCrease: number[] = [];
  const hasCrease = !!data.creases && data.creases.size > 0;
  const origCrease = (e: number): number => data.creases?.get(seamKey(origEdges[e]![0], origEdges[e]![1])) ?? 0;
  const outFaces: { corners: number[]; edges: number[]; srcCorner: number[]; srcFace: number; material: number }[] = [];

  // New vertices.
  for (let i = 0; i < vertsNum; i++) {
    const groups = origVertGroups[i];
    if (groups)
      for (const g of groups)
        if (g.newVert !== EMPTY) {
          srcVert[g.newVert] = i;
          outPos[g.newVert] = g.co;
        }
  }

  // Edges.
  let edgeIdx = totSingularity;
  for (let i = 0; i < edgesNum; i++) {
    const newEdges = origEdgeData[i];
    if (newEdges && (doShell || edgeAdjFacesLen[i] === 1) && newEdges[0]!.oldEdge === i) {
      for (const l of newEdges) {
        if (l.newEdge !== EMPTY) {
          const v1 = l.linkEdgeGroups[0]!.newVert;
          const v2 = l.linkEdgeGroups[1]!.newVert;
          let insert = edgeIdx;
          if (hasSingularities && l.linkEdgeGroups[0]!.isSingularity && l.linkEdgeGroups[1]!.isSingularity) {
            insert = singularityEdges.findIndex((p) => (p[0] === v1 && p[1] === v2) || (p[0] === v2 && p[1] === v1));
          } else edgeIdx++;
          srcEdge[insert] = i;
          outEdges[insert] = [v1, v2];
          outCrease[insert] = hasCrease ? origCrease(l.oldEdge) : 0;
          l.newEdge = insert;
        }
      }
    }
  }

  // Boundary edges / faces (the open faces at a vertex whose groups are open or split).
  for (let i = 0; i < vertsNum; i++) {
    const gs = origVertGroups[i];
    if (!gs) continue;
    let g2 = 0;
    let lastG: EdgeGroup | null = null;
    let firstG: EdgeGroup | null = null;
    let lastMaxCrease = 0;
    let firstMaxCrease = 0;
    let j = 0;
    for (let gi = 0; gi < gs.length; gi++) {
      const g = gs[gi]!;
      if ((doRim && !g.isOrigClosed) || (doShell && g.split)) {
        let maxCrease = 0;
        if (g.edges.length === 2) {
          if (hasCrease) maxCrease = Math.min(origCrease(g.edges[0]!.oldEdge), origCrease(g.edges[1]!.oldEdge));
        } else {
          for (let k = 1; k < g.edges.length - 1; k++) {
            const oe = g.edges[k]!.oldEdge;
            if (hasCrease && origCrease(oe) > maxCrease) maxCrease = origCrease(oe);
          }
        }
        if (!firstG) {
          firstG = g;
          firstMaxCrease = maxCrease;
        } else {
          lastG!.openFaceEdge = outEdges.length;
          const idx = outEdges.length;
          srcEdge[idx] = lastG!.edges[0]!.oldEdge;
          outEdges[idx] = [lastG!.newVert, g.newVert];
          outCrease[idx] = Math.max(0, Math.min(lastMaxCrease, maxCrease));
        }
        lastG = g;
        lastMaxCrease = maxCrease;
        j++;
      }
      if (gi + 1 >= gs.length || g.topoGroup !== gs[gi + 1]!.topoGroup) {
        if (j === 2) lastG!.openFaceEdge = outEdges.length - 1;
        if (j > 2) {
          const idx = outEdges.length;
          srcEdge[idx] = lastG!.edges[0]!.oldEdge;
          lastG!.openFaceEdge = idx;
          outEdges[idx] = [lastG!.newVert, firstG!.newVert];
          outCrease[idx] = Math.max(0, Math.min(lastMaxCrease, firstMaxCrease));
          const edgeEnd = outEdges.length;

          // The face's material is the consensus of the faces at its two far ends.
          let mostMatNr = 0;
          let mostMatNrFace = 0;
          let mostMatNrCount = 0;
          for (let l = 0; l < matNrs; l++) {
            let count = 0;
            let face = 0;
            let k = 0;
            for (let g3i = g2; g3i < gs.length && k < j; g3i++) {
              const g3 = gs[g3i]!;
              if ((doRim && !g3.isOrigClosed) || (doShell && g3.split)) {
                if (srcMaterial(g3.edges[0]!.faces[0]!.face) === l) {
                  face = g3.edges[0]!.faces[0]!.face;
                  count++;
                }
                const le = g3.edges[g3.edges.length - 1]!;
                if (le.faces[1] && srcMaterial(le.faces[1].face) === l) {
                  face = le.faces[1].face;
                  count++;
                } else if (!le.faces[1] && srcMaterial(le.faces[0]!.face) === l) {
                  face = le.faces[0]!.face;
                  count++;
                }
                k++;
              }
            }
            if (count > mostMatNrCount) {
              mostMatNr = l;
              mostMatNrFace = face;
              mostMatNrCount = count;
            }
          }
          const loopsData: number[] = [];
          for (let k = 0; g2 < gs.length && k < j; g2++) {
            const gg = gs[g2]!;
            if ((doRim && !gg.isOrigClosed) || (doShell && gg.split)) {
              const face = gg.edges[0]!.faces[0]!.face;
              for (let l = 0; l < polys[face]!.length; l++)
                if (vm[cornerVerts[faceStart[face]! + l]!] === i) {
                  loopsData[k] = faceStart[face]! + l;
                  break;
                }
              k++;
            }
          }
          const corners: number[] = [];
          const edgesOf: number[] = [];
          const srcCorner: number[] = [];
          if (!doFlip) {
            for (let k = 0; k < j; k++) {
              srcCorner.push(loopsData[k]!);
              corners.push(outEdges[edgeEnd - j + k]![0]);
              edgesOf.push(edgeEnd - j + k);
            }
          } else {
            for (let k = 1; k <= j; k++) {
              srcCorner.push(loopsData[j - k]!);
              corners.push(outEdges[edgeEnd - k]![1]);
              edgesOf.push(edgeEnd - k);
            }
          }
          outFaces.push({
            corners,
            edges: edgesOf,
            srcCorner,
            srcFace: mostMatNrFace,
            material: Math.max(0, Math.min(matNrMax, mostMatNr + (g.isOrigClosed || !doRim ? 0 : matOfsRim))),
          });
        }
        j = 0;
        lastG = null;
        firstG = null;
        lastMaxCrease = 0;
        firstMaxCrease = 0;
      }
    }
  }

  const shellGroupVerts = new Set<number>();
  const rimGroupVerts = new Set<number>();

  // Boundary faces (the rim, along the edges with a single face).
  if (doRim) {
    for (let i = 0; i < edgesNum; i++) {
      if (edgeAdjFacesLen[i] === 1 && origEdgeData[i] && origEdgeData[i]![0]!.oldEdge === i) {
        const newEdges = origEdgeData[i]!;
        const edge1 = newEdges[0]!;
        const edge2 = newEdges[1]!;
        const v1Singularity = edge1.linkEdgeGroups[0]!.isSingularity && edge2.linkEdgeGroups[0]!.isSingularity;
        const v2Singularity = edge1.linkEdgeGroups[1]!.isSingularity && edge2.linkEdgeGroups[1]!.isSingularity;
        if (v1Singularity && v2Singularity) continue;

        const origFace = newEdges[0]!.faces[0]!.face;
        const size = polys[origFace]!.length;
        const start = faceStart[origFace]!;
        let loop1 = -1;
        let loop2 = -1;
        const oldV1 = vm[origEdges[edge1.oldEdge]![0]]!;
        const oldV2 = vm[origEdges[edge1.oldEdge]![1]]!;
        for (let j = 0; j < size; j++) {
          const vert = cornerVerts[start + j]!;
          if (vm[vert] === oldV1) loop1 = start + j;
          else if (vm[vert] === oldV2) loop2 = start + j;
        }
        const corners: number[] = [];
        const edgesOf: number[] = [];
        const srcCorner: number[] = [];
        const push = (loop: number, vert: number, edge: number): void => {
          srcCorner.push(loop);
          corners.push(vert);
          edgesOf.push(edge);
          rimGroupVerts.add(vert);
        };
        const edgeOfOpen = (openIdx: number, other: number, ends: 0 | 1, fallbackGroup: EdgeGroup): number => {
          const ofe = outEdges[openIdx]!;
          return ofe[0] === outEdges[other]![ends] || ofe[1] === outEdges[other]![ends] ? openIdx : fallbackGroup.openFaceEdge;
        };
        if (!doFlip) {
          push(loop1, outEdges[edge1.newEdge]![0], edge1.newEdge);
          if (!v2Singularity) {
            const openIdx = edge1.linkEdgeGroups[1]!.openFaceEdge;
            push(loop2, outEdges[edge1.newEdge]![1], edgeOfOpen(openIdx, edge2.newEdge, 1, edge2.linkEdgeGroups[1]!));
          }
          push(loop2, outEdges[edge2.newEdge]![1], edge2.newEdge);
          if (!v1Singularity) {
            const openIdx = edge2.linkEdgeGroups[0]!.openFaceEdge;
            push(loop1, outEdges[edge2.newEdge]![0], edgeOfOpen(openIdx, edge1.newEdge, 0, edge1.linkEdgeGroups[0]!));
          }
        } else {
          if (!v1Singularity) {
            const openIdx = edge1.linkEdgeGroups[0]!.openFaceEdge;
            push(loop1, outEdges[edge1.newEdge]![0], edgeOfOpen(openIdx, edge2.newEdge, 0, edge2.linkEdgeGroups[0]!));
          }
          push(loop1, outEdges[edge2.newEdge]![0], edge2.newEdge);
          if (!v2Singularity) {
            const openIdx = edge2.linkEdgeGroups[1]!.openFaceEdge;
            push(loop2, outEdges[edge2.newEdge]![1], edgeOfOpen(openIdx, edge1.newEdge, 1, edge1.linkEdgeGroups[1]!));
          }
          push(loop2, outEdges[edge1.newEdge]![1], edge1.newEdge);
        }
        outFaces.push({
          corners,
          edges: edgesOf,
          srcCorner,
          srcFace: origFace,
          material: Math.max(0, Math.min(matNrMax, srcMaterial(origFace) + matOfsRim)),
        });
      }
    }
  }

  // Faces (the shell).
  if (doShell) {
    for (let i = 0; i < facesNum * 2; i++) {
      const fr = faceSides[i]!;
      const loopStart = faceStart[fr.face]!;
      let totloop = polys[fr.face]!.length;
      let validEdges = 0;
      let k = 0;
      const faceLoops: number[] = [];
      const faceVerts: number[] = [];
      const faceEdges: number[] = [];
      while (totloop > 0 && (!fr.linkEdges[totloop - 1] || fr.linkEdges[totloop - 1]!.newEdge === EMPTY)) totloop--;
      if (totloop > 0) {
        let priorEdge = fr.linkEdges[totloop - 1]!;
        let priorFlip = vm[origEdges[priorEdge.oldEdge]![0]] === vm[cornerVerts[loopStart + (totloop - 1)]!] ? 1 : 0;
        for (let j = 0; j < totloop; j++) {
          const newEdge = fr.linkEdges[j];
          if (newEdge && newEdge.newEdge !== EMPTY) {
            validEdges++;
            const flip = vm[origEdges[newEdge.oldEdge]![1]] === vm[cornerVerts[loopStart + j]!] ? 1 : 0;
            const newV1 = newEdge.linkEdgeGroups[flip]!.newVert;
            const newV2 = newEdge.linkEdgeGroups[1 - flip]!.newVert;
            if (k === 0 || faceVerts[k - 1] !== newV1) {
              faceLoops[k] = loopStart + j;
              faceEdges[k] = fr.reversed ? priorEdge.linkEdgeGroups[priorFlip]!.openFaceEdge : newEdge.linkEdgeGroups[flip]!.openFaceEdge;
              faceVerts[k++] = newV1;
            }
            priorEdge = newEdge;
            priorFlip = 1 - flip;
            if (j < totloop - 1 || faceVerts[0] !== newV2) {
              faceLoops[k] = loopStart + ((j + 1) % totloop);
              faceEdges[k] = newEdge.newEdge;
              faceVerts[k++] = newV2;
            } else faceEdges[0] = newEdge.newEdge;
          }
        }
        if (k > 2 && validEdges > 2) {
          const corners: number[] = [];
          const edgesOf: number[] = [];
          const srcCorner: number[] = [];
          if (fr.reversed !== doFlip) {
            for (let l = k - 1; l >= 0; l--) {
              shellGroupVerts.add(faceVerts[l]!);
              srcCorner.push(faceLoops[l]!);
              corners.push(faceVerts[l]!);
              edgesOf.push(faceEdges[l]!);
            }
          } else {
            let l = k - 1;
            for (let nextL = 0; nextL < k; nextL++) {
              srcCorner.push(faceLoops[l]!);
              corners.push(faceVerts[l]!);
              edgesOf.push(faceEdges[nextL]!);
              l = nextL;
            }
          }
          outFaces.push({
            corners,
            edges: edgesOf,
            srcCorner,
            srcFace: fr.face,
            material: Math.max(0, Math.min(matNrMax, srcMaterial(fr.face) + (fr.reversed !== doFlip ? matOfs : 0))),
          });
        }
      }
    }
  }

  // ── a MeshData ─────────────────────────────────────────────────────────
  const positions = new Float32Array(newVertsNum * 3);
  for (let v = 0; v < newVertsNum; v++) {
    const p = outPos[v]!;
    positions[v * 3] = p[0]!;
    positions[v * 3 + 1] = p[1]!;
    positions[v * 3 + 2] = p[2]!;
  }
  const out: MeshData = { positions, polys: outFaces.map((fc) => fc.corners) };
  // The source corner's layer value, by flat corner index.
  const flat = <T>(layer: T[][] | undefined): T[] | null => (layer && layer.length === polys.length ? layer.flat() : null);
  const uvFlat = flat(data.uvs);
  if (uvFlat) out.uvs = outFaces.map((fc) => fc.srcCorner.map((c) => [...uvFlat[c]!]));
  const colFlat = flat(data.colors);
  if (colFlat) out.colors = outFaces.map((fc) => fc.srcCorner.map((c) => [...colFlat[c]!]));
  if (data.materials && data.materials.length === polys.length) out.materials = outFaces.map((fc) => fc.material);

  if (data.groups || opts.shellVertexGroup || opts.rimVertexGroup) {
    const groups = new Map<string, Map<number, number>>();
    for (const [name, g] of data.groups ?? []) {
      const ng = new Map<number, number>();
      for (let nv = 0; nv < newVertsNum; nv++) {
        const w = g.get(srcVert[nv]!);
        if (w !== undefined) ng.set(nv, w);
      }
      groups.set(name, ng);
    }
    const ensure = (name: string): Map<number, number> => {
      let g = groups.get(name);
      if (!g) groups.set(name, (g = new Map()));
      return g;
    };
    if (opts.rimVertexGroup) {
      const g = ensure(opts.rimVertexGroup);
      for (const v of rimGroupVerts) g.set(v, 1);
    }
    if (opts.shellVertexGroup) {
      const g = ensure(opts.shellVertexGroup);
      for (const v of shellGroupVerts) g.set(v, 1);
    }
    out.groups = groups;
  }

  // Edge layers: a new edge copies its source edge's flags; creases are what the rule above wrote.
  const creases = new Map<string, number>();
  const seams = new Set<string>();
  const sharp = new Set<string>();
  outEdges.forEach((e, idx) => {
    const key = seamKey(e[0], e[1]);
    const so = srcEdge[idx];
    if (hasCrease && outCrease[idx]) creases.set(key, outCrease[idx]!);
    if (so !== undefined) {
      const ok = seamKey(origEdges[so]![0], origEdges[so]![1]);
      if (data.seams?.has(ok)) seams.add(key);
      if (data.sharp?.has(ok)) sharp.add(key);
    }
  });
  if (creases.size) out.creases = creases;
  if (seams.size) out.seams = seams;
  if (sharp.size) out.sharp = sharp;
  return out;
}
