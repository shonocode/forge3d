/**
 * Blender's **Edge Split** modifier — `modifiers/intern/MOD_edgesplit.cc`
 * (`doEdgeSplit`), Blender 5.1.1.
 */
import type { MeshData } from "../lib/mesh";
import { meshFromData, meshToData } from "../lib/mesh";
import { f, dot, faceNormalCalc, newell, normalizeInPlace, FLT_EPSILON, type V3 } from "./blender-math";
import { edgeEnd, edgeOrigin, forEachEdge, seamKey, toPolygons } from "./edit-mode/half-edge";
import { splitEdges } from "./edit-mode/operators";

export interface EdgeSplitModifierOptions {
  /** `use_edge_angle` (default true): split edges whose faces meet at more than `splitAngle`. */
  useEdgeAngle?: boolean;
  /** `split_angle`, radians (default 30°, as the float Blender stores). */
  splitAngle?: number;
  /** `use_edge_sharp` (default true): split edges marked sharp. */
  useEdgeSharp?: boolean;
}

/** Blender's default `split_angle`: 30° as a float32. */
const DEFAULT_SPLIT_ANGLE = f(Math.PI / 6);

/**
 * The Edge Split modifier: tag edges, then tear the mesh along them
 * (`BM_mesh_edgesplit`, the same tearing as {@link splitEdges}).
 *
 * - **By angle** (when `useEdgeAngle` and `splitAngle < π`): an edge between
 *   two faces is tagged when the dot of their normals is below
 *   `cos(splitAngle + 1.75e-7)` (float, the C's nudge — about 1.5 ulp, which
 *   no row tells apart: a 12-sided prism's 30° sides split the same with or
 *   without it, and JS `Math.cos` is not MSVC's `cosf`), every edge used by
 *   three or more faces is tagged, and an angle below `FLT_EPSILON` tags
 *   every edge with two faces. Face normals as BMesh computes them (a quad
 *   by its diagonals, a triangle by its cross product, larger by Newell —
 *   and a degenerate n-gon's stays zero, so it splits from everything).
 * - **By sharp flag**: every edge marked sharp that lies on a face.
 *
 * With both off nothing changes, as in Blender. Defaults read from Blender
 * (`probe-edge-split-defaults.py`): both on, 30°.
 *
 * ```ts
 * const hard = edgeSplitModifier(mesh);                          // as added
 * const byFlag = edgeSplitModifier(mesh, { useEdgeAngle: false }); // sharp edges only
 * ```
 */
export function edgeSplitModifier(data: MeshData, opts: EdgeSplitModifierOptions = {}): MeshData {
  const useAngle = opts.useEdgeAngle ?? true;
  const useSharp = opts.useEdgeSharp ?? true;
  const angle = f(opts.splitAngle ?? DEFAULT_SPLIT_ANGLE);
  const em = meshFromData(data);
  if (!useAngle && !useSharp) return meshToData(em);

  const doAngle = useAngle && angle < f(Math.PI);
  const doAll = doAngle && angle < FLT_EPSILON;
  const threshold = f(Math.cos(f(angle + f(0.000000175))));

  const polys = toPolygons(em);
  const P: V3[] = [];
  for (let i = 0; i < em.positions.length / 3; i++)
    P.push([f(em.positions[i * 3]!), f(em.positions[i * 3 + 1]!), f(em.positions[i * 3 + 2]!)]);
  // `BM_face_calc_normal`: as the Mesh's, except that a degenerate n-gon
  // keeps a zero normal (the Mesh points it up) — so it splits from anything.
  const normals = polys.map((p) => {
    if (p.length <= 4) return faceNormalCalc(P, p);
    const n = newell(p.map((v) => P[v]!));
    normalizeInPlace(n);
    return n;
  });
  const facesOf = new Map<string, number[]>();
  polys.forEach((p, fi) => {
    for (let i = 0; i < p.length; i++) {
      const k = seamKey(p[i]!, p[(i + 1) % p.length]!);
      const l = facesOf.get(k);
      if (l) l.push(fi);
      else facesOf.set(k, [fi]);
    }
  });

  const tagged = new Set<string>();
  if (doAngle)
    for (const [k, fs] of facesOf) {
      if (fs.length < 2) continue;
      if (fs.length > 2 || doAll || dot(normals[fs[0]!]!, normals[fs[1]!]!) < threshold) tagged.add(k);
    }
  if (useSharp && em.sharpEdges) for (const k of em.sharpEdges) if (facesOf.has(k)) tagged.add(k);

  const sel = new Set<number>();
  forEachEdge(em, (he) => {
    if (tagged.has(seamKey(edgeOrigin(em, he), edgeEnd(em, he)))) sel.add(he);
  });
  splitEdges(em, sel);
  return meshToData(em);
}
