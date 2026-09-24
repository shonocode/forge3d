/**
 * The GUI's CSG, headless: two render buffers in, one render buffer out,
 * through `booleanMesh` — the Blender-exact boolean (ADR-012) — instead of
 * Babylon's BSP `CSG`, which the GUI used until 2026-09-25.
 *
 * A render buffer is what a Babylon mesh holds: vertices split wherever a
 * normal or a UV is discontinuous, triangles over them. `booleanMesh` needs
 * the surface itself, so each input is
 *
 * 1. **welded** by exact position (after the world transform was applied by
 *    the caller) — a box's 24 render vertices are its 8 corners;
 * 2. **oriented**: Blender's solver decides inside from winding, and a render
 *    buffer's winding follows the renderer's convention. The signed volume
 *    says which way each part faces; a part facing in is reversed going in,
 *    and the result is reversed back so it renders as the inputs did.
 *
 * On the way out the result is triangulated (beauty, as Blender would) and
 * each triangle corner takes its **UV from the input surface**: from the old
 * triangle under a point nudged a little into the new triangle — so a corner
 * on a UV seam takes the value of the side its face is on — evaluated at the
 * corner. Corners sharing position and UV share a vertex; the rest split, so
 * the seams survive.
 *
 * Pure and headless; `csg.ts` is the Babylon side.
 */
import { booleanMesh, type BooleanOperation } from "./boolean/boolean";
import { triangulate } from "./triangulate";
import { closestPointOnTriangleBary } from "./edit-mode/attribute-transfer";
import { removeDoubles } from "./remove-doubles";

/** A render buffer in world space. `polys`, when present, are its real faces (quads / n-gons) over the same vertices. */
export interface RenderBuffer {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  uvs?: ArrayLike<number> | null;
  polys?: readonly (readonly number[])[];
}

export interface RenderResult {
  positions: Float32Array;
  indices: number[];
  uvs: Float32Array | null;
  /** The faces before triangulation, over `positions`' welded vertices — for the record. */
  faceCount: number;
}

const f = Math.fround;

/** Weld a buffer's vertices by exact float position. Returns the surface. */
function weld(buf: RenderBuffer): { positions: number[]; polys: number[][] } {
  const n = buf.positions.length / 3;
  const map = new Int32Array(n);
  const index = new Map<string, number>();
  const positions: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = f(buf.positions[i * 3]!), y = f(buf.positions[i * 3 + 1]!), z = f(buf.positions[i * 3 + 2]!);
    const key = `${x},${y},${z}`;
    let j = index.get(key);
    if (j === undefined) {
      j = positions.length / 3;
      index.set(key, j);
      positions.push(x, y, z);
    }
    map[i] = j;
  }
  const src: (readonly number[])[] = buf.polys ? [...buf.polys] : [];
  if (!buf.polys) for (let t = 0; t < buf.indices.length; t += 3) src.push([buf.indices[t]!, buf.indices[t + 1]!, buf.indices[t + 2]!]);
  const polys: number[][] = [];
  for (const p of src) {
    const q: number[] = [];
    for (const v of p) {
      const w = map[v]!;
      if (q[q.length - 1] !== w) q.push(w);
    }
    while (q.length > 1 && q[0] === q[q.length - 1]) q.pop();
    if (q.length >= 3) polys.push(q);
  }
  // Exact welding is not enough for Babylon's own spheres: the longitude
  // seam's two copies differ in the last bits (sin 2π is not 0), which leaves
  // a slit of 100 open edges down the side and sends the solver to its
  // open-mesh path. Blender's remove_doubles at 1e-6 closes it.
  const closed = removeDoubles({ positions: Float32Array.from(positions), polys }, WELD_DIST);
  return { positions: Array.from(closed.positions), polys: closed.polys.filter((p) => p.length >= 3).map((p) => [...p]) };
}

/** Distance within which render vertices are the same surface point. */
const WELD_DIST = 1e-6;

/** Six times the signed volume, fanning each polygon (right-handed). */
function volume6(positions: ArrayLike<number>, polys: readonly (readonly number[])[]): number {
  let v = 0;
  for (const p of polys)
    for (let i = 1; i + 1 < p.length; i++) {
      const a = p[0]! * 3, b = p[i]! * 3, c = p[i + 1]! * 3;
      const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
      const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
      const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
      v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
  return v;
}

/**
 * `a op b` for two world-space render buffers. `"difference"` is a − b.
 * Throws when either input has no faces.
 */
export function booleanBuffers(a: RenderBuffer, b: RenderBuffer, operation: BooleanOperation): RenderResult {
  const wa = weld(a);
  const wb = weld(b);
  if (!wa.polys.length || !wb.polys.length) throw new Error("CSG: 面の無いメッシュがある");
  // Orientation, per part. The renderer's winding is the same for both parts
  // unless one is mirrored, so decide from A and flip B only if it disagrees.
  const flipA = volume6(wa.positions, wa.polys) < 0;
  const flipB = volume6(wb.positions, wb.polys) < 0;
  const rev = (ps: number[][], flip: boolean): number[][] => (flip ? ps.map((p) => [...p].reverse()) : ps);
  const offset = wa.positions.length / 3;
  const polysA = rev(wa.polys, flipA);
  const polysB = rev(wb.polys, flipB).map((p) => p.map((v) => v + offset));
  const set = new Set<number>();
  for (let i = 0; i < polysB.length; i++) set.add(polysA.length + i);
  const out = booleanMesh(
    { positions: Float32Array.from([...wa.positions, ...wb.positions]), polys: [...polysA, ...polysB] },
    { operation, set },
  );
  // Back to the renderer's winding (A's).
  const faces = flipA ? out.polys.map((p) => [...p].reverse()) : out.polys;
  const tris = triangulate({ positions: out.positions, polys: faces }).polys;

  // UVs from the old surface, per corner.
  const hasUV = !!(a.uvs && b.uvs);
  const oldPos = [...Array.from(a.positions), ...Array.from(b.positions)];
  const na = a.positions.length / 3;
  const oldIdx = [...Array.from(a.indices), ...Array.from(b.indices, (i) => i + na)];
  const oldUV = hasUV ? [...Array.from(a.uvs!), ...Array.from(b.uvs!)] : [];
  const P = out.positions;
  const uvAt = (corner: number, tri: number[]): [number, number] => {
    const cx = (P[tri[0]! * 3]! + P[tri[1]! * 3]! + P[tri[2]! * 3]!) / 3;
    const cy = (P[tri[0]! * 3 + 1]! + P[tri[1]! * 3 + 1]! + P[tri[2]! * 3 + 1]!) / 3;
    const cz = (P[tri[0]! * 3 + 2]! + P[tri[1]! * 3 + 2]! + P[tri[2]! * 3 + 2]!) / 3;
    const px = P[corner * 3]!, py = P[corner * 3 + 1]!, pz = P[corner * 3 + 2]!;
    const nx = px + (cx - px) * 1e-3, ny = py + (cy - py) * 1e-3, nz = pz + (cz - pz) * 1e-3;
    let best = -1;
    let bestD = Infinity;
    for (let t = 0; t < oldIdx.length; t += 3) {
      const i0 = oldIdx[t]! * 3, i1 = oldIdx[t + 1]! * 3, i2 = oldIdx[t + 2]! * 3;
      const r = closestPointOnTriangleBary(nx, ny, nz,
        oldPos[i0]!, oldPos[i0 + 1]!, oldPos[i0 + 2]!,
        oldPos[i1]!, oldPos[i1 + 1]!, oldPos[i1 + 2]!,
        oldPos[i2]!, oldPos[i2 + 1]!, oldPos[i2 + 2]!);
      if (r.dist2 < bestD) {
        bestD = r.dist2;
        best = t;
        if (r.dist2 === 0) break;
      }
    }
    const i0 = oldIdx[best]!, i1 = oldIdx[best + 1]!, i2 = oldIdx[best + 2]!;
    const r = closestPointOnTriangleBary(px, py, pz,
      oldPos[i0 * 3]!, oldPos[i0 * 3 + 1]!, oldPos[i0 * 3 + 2]!,
      oldPos[i1 * 3]!, oldPos[i1 * 3 + 1]!, oldPos[i1 * 3 + 2]!,
      oldPos[i2 * 3]!, oldPos[i2 * 3 + 1]!, oldPos[i2 * 3 + 2]!);
    return [
      oldUV[i0 * 2]! * r.u + oldUV[i1 * 2]! * r.v + oldUV[i2 * 2]! * r.w,
      oldUV[i0 * 2 + 1]! * r.u + oldUV[i1 * 2 + 1]! * r.v + oldUV[i2 * 2 + 1]! * r.w,
    ];
  };

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const index = new Map<string, number>();
  for (const tri of tris)
    for (const corner of tri) {
      const uv = hasUV ? uvAt(corner, tri) : null;
      const key = uv ? `${corner}:${f(uv[0])},${f(uv[1])}` : `${corner}`;
      let j = index.get(key);
      if (j === undefined) {
        j = positions.length / 3;
        index.set(key, j);
        positions.push(P[corner * 3]!, P[corner * 3 + 1]!, P[corner * 3 + 2]!);
        if (uv) uvs.push(uv[0], uv[1]);
      }
      indices.push(j);
    }
  return { positions: Float32Array.from(positions), indices, uvs: hasUV ? Float32Array.from(uvs) : null, faceCount: faces.length };
}
