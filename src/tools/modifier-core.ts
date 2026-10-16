/**
 * The GUI's modifier stack, headless: a render buffer in, a render buffer out,
 * through the library's own operators — `subsurfModifier`, `mirrorModifier`,
 * `arrayMesh`, `solidifyModifier`, `decimateCollapse`, `smoothMesh`,
 * `triangulateModifier`, `mergeByDistance` — the ones the parity rows measure
 * (the rows `gui-stack-*` run this very path; compat-backlog C86). Until
 * 2026-10-08 Smooth, Weld and Subdivision called their Edit Mode or generator
 * cousins (`smoothVert`, `weldMesh`, `catmullClark`), which answer differently.
 * Until 2026-09-25 the GUI had its own three (a midpoint split of
 * the triangles, and per-triangle mirror and array) that shared nothing with
 * what `import { ... } from "forge3d"` gives.
 *
 * The operators work on the **surface** (`MeshData`: welded vertices, real
 * faces, a UV per face corner); a Babylon mesh holds a **render buffer**
 * (vertices split wherever a normal or a UV is discontinuous, triangles over
 * them). So the stack runs
 *
 * 1. `renderToSurface`: weld the render vertices (1e-6, which also closes
 *    Babylon's sphere seam — see `csg-core`), keep each corner's UV, and read
 *    off the shading the mesh was drawn with as an Auto Smooth angle. Where
 *    the buffer names each render vertex's surface vertex (`weld`, written by
 *    step 3), only vertices of the same surface vertex weld — two parts that
 *    touch stay two (compat-backlog C113). The creases and seams Edit Mode
 *    put on the render vertices come along onto the surface (C112);
 * 2. each enabled modifier, in order;
 * 3. `surfaceToRender`: corner normals under that angle, vertices split by
 *    position + UV + normal, faces fan-triangulated — so the faces go back
 *    onto the mesh as its polygon metadata and Edit Mode still sees quads —
 *    with the surface vertex of each render vertex, and the creases and
 *    seams onto every render edge of their surface edge.
 *
 * Pure; `modifiers.ts` is the Babylon side.
 */
import type { MeshData } from "../lib/mesh";
import type { Modifier, OriginalGeometry } from "../state";
import { subsurfModifier } from "./subsurf-modifier";
import { smoothMesh } from "./smooth-mesh";
import { mergeByDistance } from "./remove-doubles";
import { closestPointOnTriangleBary } from "./edit-mode/attribute-transfer";
import { arrayMesh, mirrorModifier, weldMesh } from "./mesh-ops";
import { solidifyModifier } from "./solidify-modifier";
import { decimateCollapse } from "./decimate";
import { triangulateModifier } from "./triangulate";

/** Distance within which render vertices are the same surface point. */
const WELD_DIST = 1e-6;

/** Used when the mesh carries no normals to read the shading from. */
export const DEFAULT_SMOOTH_ANGLE = (30 * Math.PI) / 180;

type V3 = [number, number, number];

/** Newell normal of a polygon — its length is twice the area. */
function newell(P: ArrayLike<number>, poly: readonly number[]): V3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]! * 3;
    const b = poly[(i + 1) % poly.length]! * 3;
    x += (P[a + 1]! - P[b + 1]!) * (P[a + 2]! + P[b + 2]!);
    y += (P[a + 2]! - P[b + 2]!) * (P[a]! + P[b]!);
    z += (P[a]! - P[b]!) * (P[a + 1]! + P[b + 1]!);
  }
  return [x, y, z];
}

function unit(n: V3): V3 {
  const l = Math.hypot(n[0], n[1], n[2]);
  return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0];
}

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** "min_max" — the edge key `MeshData` and Edit Mode use. */
const seamKeyOf = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * The faces a render buffer stands for: its stored polygons when they fit,
 * else its triangles with consecutive pairs rejoined into quads.
 */
function facesOf(geo: OriginalGeometry): number[][] {
  const n = geo.positions.length / 3;
  if (geo.polys && geo.polys.length && geo.polys.every((p) => p.length >= 3 && p.every((v) => Number.isInteger(v) && v >= 0 && v < n)))
    return geo.polys.map((p) => [...p]);
  return pairTriangles(geo.positions, geo.indices);
}

/**
 * Rejoin a triangle list into the quads it was cut from. Babylon's own
 * generators (`CreateBox`, the sides of a cylinder, a sphere's bands) carry
 * no polygon metadata and emit each quad as two **consecutive** triangles over
 * the same render vertices; a Box is 12 triangles, and Catmull-Clark on those
 * comes out lopsided where Blender's cube — six quads — comes out round. So a
 * triangle joins the next one when they share an edge, lie flat (1e-6) and
 * make a convex quad; anything else stays a triangle. Pairs are only looked
 * for between neighbours in the list, so a mesh that was triangulated some
 * other way is left as it is rather than re-paired by guesswork.
 */
export function pairTriangles(P: ArrayLike<number>, indices: readonly number[]): number[][] {
  const tri = (t: number): number[] => [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!];
  const T = Math.floor(indices.length / 3);
  const out: number[][] = [];
  for (let t = 0; t < T; t++) {
    const a = tri(t);
    if (t + 1 < T) {
      const quad = joinPair(P, a, tri(t + 1));
      if (quad) {
        out.push(quad);
        t++;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

function joinPair(P: ArrayLike<number>, a: number[], b: number[]): number[] | null {
  for (let i = 0; i < 3; i++) {
    const x = a[(i + 1) % 3]!, y = a[(i + 2) % 3]!;
    // b must run the shared edge the other way, y → x.
    for (let j = 0; j < 3; j++) {
      if (b[j] !== y || b[(j + 1) % 3] !== x) continue;
      const w = b[(j + 2) % 3]!;
      const p = a[i]!;
      if (w === p) return null;
      const quad = [p, x, w, y];
      const na = unit(newell(P, a));
      const nb = unit(newell(P, b));
      if (dot(na, nb) < 1 - 1e-6) return null;
      // Convex: every corner turns the same way as the face.
      for (let k = 0; k < 4; k++) {
        const o = quad[k]! * 3, q = quad[(k + 1) % 4]! * 3, r = quad[(k + 2) % 4]! * 3;
        const e1: V3 = [P[q]! - P[o]!, P[q + 1]! - P[o + 1]!, P[q + 2]! - P[o + 2]!];
        const e2: V3 = [P[r]! - P[q]!, P[r + 1]! - P[q + 1]!, P[r + 2]! - P[q + 2]!];
        const c: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (dot(c, na) <= 0) return null;
      }
      return quad;
    }
  }
  return null;
}

/**
 * A render buffer as a surface, plus the Auto Smooth angle it was drawn with.
 *
 * The angle is read off the normals: an edge whose two faces share their
 * corner normals was drawn smooth, one where they differ was drawn sharp. The
 * angle is put halfway between the steepest smooth edge and the flattest
 * sharp one, so re-shading the result reproduces what the mesh looked like —
 * a box stays crisp, a sphere stays smooth. No sharp edge at all reads as π.
 */
export function renderToSurface(geo: OriginalGeometry): { surface: MeshData; smoothAngle: number } {
  const faces = facesOf(geo);
  const n = geo.positions.length / 3;
  // A list that no longer fits the buffer (another tool rebuilt it) says nothing; the weld is then by position alone.
  const weld = geo.weld && geo.weld.length === n && geo.weld.every((w) => Number.isInteger(w)) ? geo.weld : undefined;
  const edgeKeyOk = (k: string): boolean => {
    const [a, b] = k.split("_").map(Number);
    return Number.isInteger(a) && Number.isInteger(b) && a! >= 0 && b! >= 0 && a! < n && b! < n && a !== b;
  };
  const U = geo.uvs;
  const N = geo.normals;
  // Each corner carries [u, v, nx, ny, nz] through the weld, which keeps the
  // layer shaped like the surviving faces; the normals are split off after.
  const corners = faces.map((p) =>
    p.map((v) => [U ? U[v * 2]! : 0, U ? U[v * 2 + 1]! : 0, N ? N[v * 3]! : 0, N ? N[v * 3 + 1]! : 0, N ? N[v * 3 + 2]! : 0]),
  );
  const welded = weldMesh(
    {
      positions: Float32Array.from(geo.positions),
      polys: faces,
      uvs: corners,
      // Ascending, so where two render copies of one edge differ the larger is the edge's (the weld keeps the last).
      creases: new Map((geo.creases ?? []).filter(([k, c]) => edgeKeyOk(k) && c > 0).sort((x, y) => x[1] - y[1])),
      seams: new Set((geo.seams ?? []).filter(edgeKeyOk)),
    },
    WELD_DIST,
    weld,
  );
  const layer = welded.uvs!;

  let smoothAngle = DEFAULT_SMOOTH_ANGLE;
  if (N) {
    const fn = welded.polys.map((p) => unit(newell(welded.positions, p)));
    const edges = new Map<string, Array<[number, number]>>();
    welded.polys.forEach((p, f) => {
      for (let i = 0; i < p.length; i++) {
        const a = p[i]!, b = p[(i + 1) % p.length]!;
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        const list = edges.get(key) ?? [];
        list.push([f, i]);
        edges.set(key, list);
      }
    });
    const nAt = (f: number, i: number): V3 => {
      const c = layer[f]![i]!;
      return unit([c[2]!, c[3]!, c[4]!]);
    };
    let maxSmooth = 0;
    let minSharp = Infinity;
    for (const list of edges.values()) {
      if (list.length !== 2) continue;
      const [[f, i], [g, j]] = list as [[number, number], [number, number]];
      const dihedral = Math.acos(Math.max(-1, Math.min(1, dot(fn[f]!, fn[g]!))));
      if (dihedral < 1e-3) continue;
      const nf = welded.polys[f]!.length;
      const ng = welded.polys[g]!.length;
      // f runs a→b at corner i, g runs b→a at corner j.
      const same =
        dot(nAt(f, i), nAt(g, (j + 1) % ng)) > 0.9999 && dot(nAt(f, (i + 1) % nf), nAt(g, j)) > 0.9999;
      if (same) maxSmooth = Math.max(maxSmooth, dihedral);
      else minSharp = Math.min(minSharp, dihedral);
    }
    smoothAngle = minSharp === Infinity ? Math.PI : maxSmooth < minSharp ? (maxSmooth + minSharp) / 2 : minSharp * 0.999;
  }

  const surface: MeshData = { positions: welded.positions, polys: welded.polys };
  if (U) surface.uvs = layer.map((f) => f.map((c) => [c[0]!, c[1]!]));
  if (welded.creases?.size) surface.creases = welded.creases;
  if (welded.seams?.size) surface.seams = welded.seams;
  return { surface, smoothAngle };
}

/**
 * A surface as a render buffer, shaded with Auto Smooth at `smoothAngle`: a
 * corner's normal averages (by area) the faces round its vertex that are
 * within the angle of its own face. Vertices split by position, UV and normal.
 * `polys` are the faces over the new vertices, fan-triangulated into
 * `indices` — the form `buildEditMesh` accepts as polygon metadata.
 */
export function surfaceToRender(s: MeshData, smoothAngle: number): OriginalGeometry & { polys: number[][]; weld: number[] } {
  const P = s.positions;
  const area = s.polys.map((p) => newell(P, p));
  const fn = area.map(unit);
  const around = new Map<number, number[]>();
  s.polys.forEach((p, f) => {
    for (const v of p) {
      const list = around.get(v);
      if (list) list.push(f);
      else around.set(v, [f]);
    }
  });
  const cosT = smoothAngle >= Math.PI ? -2 : Math.cos(smoothAngle) - 1e-9;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const weld: number[] = [];
  const index = new Map<string, number>();
  const polys: number[][] = [];
  const indices: number[] = [];
  s.polys.forEach((p, f) => {
    const ring: number[] = [];
    p.forEach((v, i) => {
      let n: V3 = [0, 0, 0];
      for (const g of around.get(v)!)
        if (g === f || dot(fn[f]!, fn[g]!) >= cosT) {
          n[0] += area[g]![0];
          n[1] += area[g]![1];
          n[2] += area[g]![2];
        }
      n = unit(n);
      const uv = s.uvs?.[f]?.[i];
      const key = `${v}|${uv ? `${Math.fround(uv[0]!)},${Math.fround(uv[1]!)}` : ""}|${n[0].toFixed(4)},${n[1].toFixed(4)},${n[2].toFixed(4)}`;
      let j = index.get(key);
      if (j === undefined) {
        j = positions.length / 3;
        index.set(key, j);
        positions.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
        normals.push(n[0], n[1], n[2]);
        weld.push(v);
        if (s.uvs) uvs.push(uv ? uv[0]! : 0, uv ? uv[1]! : 0);
      }
      ring.push(j);
    });
    polys.push(ring);
    for (let k = 1; k + 1 < ring.length; k++) indices.push(ring[0]!, ring[k]!, ring[k + 1]!);
  });
  // A surface edge is as many render edges as its ends were split into; each gets the edge's crease and seam.
  const creases = new Map<string, number>();
  const seams = new Set<string>();
  s.polys.forEach((p, f) => {
    const ring = polys[f]!;
    for (let i = 0; i < p.length; i++) {
      const surfaceKey = seamKeyOf(p[i]!, p[(i + 1) % p.length]!);
      const renderKey = seamKeyOf(ring[i]!, ring[(i + 1) % ring.length]!);
      const c = s.creases?.get(surfaceKey);
      if (c !== undefined && c > 0) creases.set(renderKey, c);
      if (s.seams?.has(surfaceKey)) seams.add(renderKey);
    }
  });
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: s.uvs ? Float32Array.from(uvs) : null,
    indices,
    polys,
    weld,
    ...(creases.size ? { creases: [...creases] } : {}),
    ...(seams.size ? { seams: [...seams] } : {}),
    smoothAngle,
  };
}

/**
 * Blender's Subdivision "Simple": every face cut into quads at its edge
 * midpoints and its centre, the shape left as it was — `subsurfModifier` with
 * `subdivisionType: "SIMPLE"`, which carries the layers (materials, vertex
 * groups, colours, creases, sharp, seams, vertex creases) the way Blender's
 * `subdiv_mesh.cc` does (compat-backlog C89). UVs are cut linearly per face,
 * so seams stay seams. Matches the modifier with `subdivision_type = SIMPLE`
 * at levels 1 and 2 — `subdiv-simple`, `subdiv-simple-uv`,
 * `subdiv-simple-layers` (compat-backlog B1).
 */
export function simpleSubdivide(s: MeshData, level: number): MeshData {
  return subsurfModifier(s, { levels: level, subdivisionType: "SIMPLE" });
}

/**
 * **Not called by the stack any more** (compat-backlog C86: Decimate now takes the UVs in and folds them, as Blender's does); kept,
 * with its test, as a way to read UVs off one surface onto another.
 *
 * UVs for a surface whose faces were rebuilt (Decimate), sampled from the
 * surface it came from: each corner takes the UV of the old triangle nearest
 * a point nudged a little into its own face — so a corner on a UV seam reads
 * the side its face is on — evaluated at the corner itself. A grid over the
 * old triangles keeps it near-linear.
 */
export function transferUVs(from: MeshData, to: MeshData): number[][][] | undefined {
  if (!from.uvs) return undefined;
  const OP = from.positions;
  const tris: number[] = [];
  const triUV: number[][] = [];
  from.polys.forEach((p, f) => {
    for (let k = 1; k + 1 < p.length; k++) {
      tris.push(p[0]!, p[k]!, p[k + 1]!);
      triUV.push([...from.uvs![f]![0]!, ...from.uvs![f]![k]!, ...from.uvs![f]![k + 1]!]);
    }
  });
  const T = tris.length / 3;
  if (T === 0) return to.polys.map((p) => p.map(() => [0, 0]));

  let lo: V3 = [Infinity, Infinity, Infinity];
  let hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < OP.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, OP[i + k]!);
      hi[k] = Math.max(hi[k]!, OP[i + k]!);
    }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const cell = diag / Math.max(1, Math.cbrt(T) * 2);
  lo = [lo[0] - cell, lo[1] - cell, lo[2] - cell];
  hi = [hi[0] + cell, hi[1] + cell, hi[2] + cell];
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((hi[k]! - lo[k]!) / cell))) as V3;
  const cellOf = (x: number, k: number): number => Math.min(dims[k]! - 1, Math.max(0, Math.floor((x - lo[k]!) / cell)));
  const grid = new Map<number, number[]>();
  const keyOf = (i: number, j: number, k: number): number => (i * dims[1] + j) * dims[2] + k;
  for (let t = 0; t < T; t++) {
    const a = [0, 1, 2].map((k) => Math.min(OP[tris[t * 3]! * 3 + k]!, OP[tris[t * 3 + 1]! * 3 + k]!, OP[tris[t * 3 + 2]! * 3 + k]!));
    const b = [0, 1, 2].map((k) => Math.max(OP[tris[t * 3]! * 3 + k]!, OP[tris[t * 3 + 1]! * 3 + k]!, OP[tris[t * 3 + 2]! * 3 + k]!));
    for (let i = cellOf(a[0]!, 0); i <= cellOf(b[0]!, 0); i++)
      for (let j = cellOf(a[1]!, 1); j <= cellOf(b[1]!, 1); j++)
        for (let k = cellOf(a[2]!, 2); k <= cellOf(b[2]!, 2); k++) {
          const key = keyOf(i, j, k);
          const list = grid.get(key);
          if (list) list.push(t);
          else grid.set(key, [t]);
        }
  }
  const closest = (x: number, y: number, z: number, t: number) => {
    const a = tris[t * 3]! * 3, b = tris[t * 3 + 1]! * 3, c = tris[t * 3 + 2]! * 3;
    return closestPointOnTriangleBary(x, y, z, OP[a]!, OP[a + 1]!, OP[a + 2]!, OP[b]!, OP[b + 1]!, OP[b + 2]!, OP[c]!, OP[c + 1]!, OP[c + 2]!);
  };
  const nearest = (x: number, y: number, z: number): number => {
    const ci = cellOf(x, 0), cj = cellOf(y, 1), ck = cellOf(z, 2);
    let best = -1;
    let bestD = Infinity;
    const seen = new Set<number>();
    const maxR = Math.max(dims[0], dims[1], dims[2]);
    for (let r = 0; r <= maxR; r++) {
      for (let i = ci - r; i <= ci + r; i++)
        for (let j = cj - r; j <= cj + r; j++)
          for (let k = ck - r; k <= ck + r; k++) {
            if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue;
            if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) continue;
            for (const t of grid.get(keyOf(i, j, k)) ?? []) {
              if (seen.has(t)) continue;
              seen.add(t);
              const d = closest(x, y, z, t).dist2;
              if (d < bestD) {
                bestD = d;
                best = t;
              }
            }
          }
      // Anything in ring r + 1 or beyond is at least r cells away.
      if (best >= 0 && bestD <= (r * cell) ** 2) break;
    }
    return best;
  };

  const P = to.positions;
  return to.polys.map((p) => {
    const cx = p.reduce((s, v) => s + P[v * 3]!, 0) / p.length;
    const cy = p.reduce((s, v) => s + P[v * 3 + 1]!, 0) / p.length;
    const cz = p.reduce((s, v) => s + P[v * 3 + 2]!, 0) / p.length;
    return p.map((v) => {
      const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!;
      const t = nearest(x + (cx - x) * 1e-3, y + (cy - y) * 1e-3, z + (cz - z) * 1e-3);
      const r = closest(x, y, z, t);
      const q = triUV[t]!;
      return [q[0]! * r.u + q[2]! * r.v + q[4]! * r.w, q[1]! * r.u + q[3]! * r.v + q[5]! * r.w];
    });
  });
}

/** One modifier on a surface. */
export function applyModifierTo(s: MeshData, mod: Modifier): MeshData {
  switch (mod.type) {
    case "subdivision": {
      if ((mod.mode ?? "simple") === "simple") return simpleSubdivide(s, mod.level);
      // Blender's Subdivision Surface modifier as it is added: limit surface on (compat-backlog C86). `catmullClark` alone is plain
      // refinement — a different shape at the same level. The limit surface refuses UVs at a non-manifold vertex (a render mesh
      // welded back together can have one); that mesh is refined without it rather than failing the whole stack.
      try {
        return subsurfModifier(s, { levels: mod.level });
      } catch (e) {
        // Only that refusal; any other error from the limit surface is a real one and goes up.
        if (!(e instanceof Error) || !/non-manifold vertex/.test(e.message)) throw e;
        return subsurfModifier(s, { levels: mod.level, limitSurface: false });
      }
    }
    case "mirror":
      // Blender's Mirror modifier: each vertex welds onto its own image only.
      return mirrorModifier(s, { axes: { [mod.axis]: true }, merge: mod.merge, mergeThreshold: mod.mergeTolerance });
    case "array": {
      // Constant and relative offsets add, as Blender's (`MOD_ARR_OFF_CONST | MOD_ARR_OFF_RELATIVE`). A file from before
      // C122 has neither flag: constant only.
      const constant = mod.useConstant ?? true;
      const relative = mod.useRelative ?? false;
      return arrayMesh(
        s,
        mod.count,
        constant ? [mod.offsetX, mod.offsetY, mod.offsetZ] : [0, 0, 0],
        relative ? { relative: [mod.relX ?? 1, mod.relY ?? 0, mod.relZ ?? 0] } : {},
      );
    }
    case "solidify":
      // Blender's Solidify modifier (Simple mode, its defaults: offset -1, even off, rim on).
      return solidifyModifier(s, { thickness: mod.thickness });
    case "decimate":
      // The corners' UVs go in with the faces and are folded by the collapse, as Blender's (compat-backlog C86). They used to be
      // dropped and read back off the result by nearest point (`transferUVs`), which is not what Decimate does.
      return decimateCollapse(s, { ratio: mod.ratio });
    case "smooth":
      // Blender's Smooth modifier (`smoothMesh`, the port of `MOD_smooth.cc`): each vertex toward the mean of its edges' midpoints.
      // `smoothVert` — the Edit Mode operator — moves toward the mean of the neighbours, about twice as far for the same factor.
      // Positions only; every other layer comes back as it went in.
      return smoothMesh(s, { factor: mod.factor, iterations: mod.repeat });
    case "triangulate":
      return triangulateModifier(s, { quadMethod: mod.quadMethod, ngonMethod: mod.ngonMethod });
    case "weld":
      // Blender's Weld modifier, mode All (`mergeByDistance`). `weldMesh` is the generators' seam closer: it keeps a vertex where
      // it is, where the modifier moves the survivor to the cluster's mean (compat-backlog C86).
      return mergeByDistance(s, mod.distance);
  }
}

/**
 * The whole stack: `mods` (disabled ones skipped) over the base geometry.
 * `upTo` stops after that many entries — Apply bakes the first ones only.
 */
export function evaluateStack(
  base: OriginalGeometry,
  mods: readonly Modifier[],
  upTo = mods.length,
): OriginalGeometry & { polys: number[][]; weld: number[] } {
  const { surface, smoothAngle: read } = renderToSurface(base);
  const angle = base.smoothAngle ?? read;
  let s = surface;
  for (let i = 0; i < upTo && i < mods.length; i++) {
    const m = mods[i]!;
    if (m.enabled) s = applyModifierTo(s, m);
  }
  return surfaceToRender(s, angle);
}
