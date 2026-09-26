/**
 * Bridge Edge Loops as the editor's operator runs it —
 * `MESH_OT_bridge_edge_loops` (`editors/mesh/editmesh_tools.cc`,
 * Blender 5.1.1): `bridge_loops`, with the face-selection form in front and
 * `subdivide_edgering` behind.
 */
import { meshFromData, meshToData, type MeshData } from "../lib/mesh";
import { bridgeLoops } from "./bridge-loops";
import { deleteGeometryMapped } from "./delete-geometry";
import { edgeEnd, edgeOrigin, forEachEdge, seamKey } from "./edit-mode/half-edge";
import { subdivideEdgering } from "./edit-mode/operators";
import type { EdgeringInterpolation } from "./edit-mode/edgering-interp";
import type { SubdivideFalloff } from "./edit-mode/refine";

/** The operator's settings. The defaults are its own, which are not `bmesh.ops`'. */
export interface BridgeSelectionOptions {
  /** `type`: `SINGLE` (a chain, default), `CLOSED` (back to the first), `PAIRS` (1–2, 3–4, …). */
  type?: "SINGLE" | "CLOSED" | "PAIRS";
  /** `use_merge`: weld the loops instead of spanning them. Default false. */
  useMerge?: boolean;
  /** `merge_factor`. Default 0.5. */
  mergeFactor?: number;
  /** `twist_offset`. Default 0. */
  twistOffset?: number;
  /** `number_cuts`: loops cut across the new band afterwards. Default 0. */
  cuts?: number;
  /** `interpolation`. Default `PATH`. */
  interpolation?: EdgeringInterpolation;
  /** `smoothness`. Default 1. */
  smoothness?: number;
  /** `profile_shape`. Default `SMOOTH`. */
  profileShape?: SubdivideFalloff;
  /** `profile_shape_factor`. Default 0. */
  profileShapeFactor?: number;
}

/**
 * Bridge the selected edge loops — or, given faces, the holes those faces
 * leave.
 *
 * - **Edges.** `bridge_loops` over them ({@link bridgeLoops}).
 * - **Faces.** The selection flushes to their edges; a selected edge on the
 *   mesh's rim, or with an unselected face on it, is a loop edge, and the
 *   faces on the others are deleted with `DEL_FACES_KEEP_BOUNDARY` — so two
 *   faces selected on either side of a solid are replaced by a tunnel.
 *   (`edbm_bridge_tag_boundary_edges`.) Blender deletes the faces even if the
 *   bridge then fails; this throws instead, and returns nothing.
 * - **Cuts.** With `cuts` and not `useMerge`, the new band's cross edges
 *   (the bridge's `edges.out`) are cut by `subdivide_edgering` with
 *   `interpolation`, `smoothness` and the profile ({@link subdivideEdgering}).
 *
 * Edges are vertex pairs, faces indices into `data.polys`. The operator's
 * own flush from edges up to faces (every edge of a face selected selects
 * it) is the caller's: pass the faces.
 */
export function bridgeSelection(
  data: MeshData,
  selection: { edges?: readonly (readonly [number, number])[]; faces?: readonly number[] },
  opts: BridgeSelectionOptions = {},
): MeshData {
  const faces = new Set(selection.faces ?? []);
  const selEdges = new Map<string, [number, number]>();
  for (const [a, b] of selection.edges ?? []) selEdges.set(seamKey(a, b), [a, b]);
  for (const f of faces) {
    const p = data.polys[f]!;
    p.forEach((a, i) => {
      const b = p[(i + 1) % p.length]!;
      selEdges.set(seamKey(a, b), [a, b]);
    });
  }

  let base = data;
  let loopEdges = [...selEdges.values()];
  if (faces.size > 0) {
    // Which faces each edge is on.
    const on = new Map<string, number[]>();
    data.polys.forEach((p, f) =>
      p.forEach((a, i) => {
        const k = seamKey(a, p[(i + 1) % p.length]!);
        const l = on.get(k);
        if (l) l.push(f);
        else on.set(k, [f]);
      }),
    );
    const tagged: [number, number][] = [];
    const doomed = new Set<number>();
    for (const [k, e] of selEdges) {
      const fs = on.get(k) ?? [];
      if (fs.length <= 1) {
        tagged.push(e); // wire or rim
        continue;
      }
      let allSelected = true;
      for (const f of fs) {
        if (faces.has(f)) doomed.add(f);
        else allSelected = false;
      }
      if (!allSelected) tagged.push(e);
    }
    const { data: kept, source } = deleteGeometryMapped(data, { faces: [...doomed] }, "FACES_KEEP_BOUNDARY");
    const to = new Map<number, number>();
    source.forEach((old, v) => to.set(old, v));
    base = kept;
    loopEdges = tagged.filter(([a, b]) => to.has(a) && to.has(b)).map(([a, b]) => [to.get(a)!, to.get(b)!]);
  }

  let edgesOut: [number, number][] = [];
  const bridged = bridgeLoops(base, loopEdges, {
    useCyclic: opts.type === "CLOSED",
    usePairs: opts.type === "PAIRS",
    twistOffset: opts.twistOffset ?? 0,
    useMerge: opts.useMerge ?? false,
    mergeFactor: opts.mergeFactor ?? 0.5,
    onEdgesOut: (e) => (edgesOut = e),
  });
  const cuts = Math.max(0, Math.floor(opts.cuts ?? 0));
  if (opts.useMerge || cuts === 0) return bridged;

  // edges.out: the band's cross edges — faces that were already there
  // included, so bridging the two rims of a tube cuts the tube.
  const want = new Set(edgesOut.map(([a, b]) => seamKey(a, b)));
  const em = meshFromData(bridged);
  const ring = new Set<number>();
  forEachEdge(em, (he) => {
    if (want.has(seamKey(edgeOrigin(em, he), edgeEnd(em, he)))) ring.add(he);
  });
  if (ring.size === 0) return bridged;
  subdivideEdgering(em, ring, cuts, {
    interpolation: opts.interpolation ?? "PATH",
    smooth: opts.smoothness ?? 1,
    profileShape: opts.profileShape ?? "SMOOTH",
    profileShapeFactor: opts.profileShapeFactor ?? 0,
  });
  return meshToData(em);
}
