import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { edgeEnd, edgeOrigin, forEachEdge, type EditMesh } from "./half-edge";
import { isMobile } from "../../state";

// Pick radii scale up on touch devices so fingers can actually hit a vertex
// dot. The mobile multiplier (×2.2) mirrors the gizmo handle scaling already
// used elsewhere in the app.
const VERT_PICK_RADIUS_PX_DESKTOP = 12;
const EDGE_PICK_RADIUS_PX_DESKTOP = 10;
const MOBILE_PICK_SCALE = 2.2;
const vertPickRadius = (): number =>
  isMobile() ? VERT_PICK_RADIUS_PX_DESKTOP * MOBILE_PICK_SCALE : VERT_PICK_RADIUS_PX_DESKTOP;
const edgePickRadius = (): number =>
  isMobile() ? EDGE_PICK_RADIUS_PX_DESKTOP * MOBILE_PICK_SCALE : EDGE_PICK_RADIUS_PX_DESKTOP;

/**
 * Pick a vertex under the cursor by projecting all vertices to screen space.
 * Returns the vertex index, or -1 if nothing is within `VERT_PICK_RADIUS_PX`.
 *
 * For large meshes (>10k vertices) this is O(N) per click — acceptable for
 * forge3d's typical character meshes (<5k verts). Replace with spatial
 * acceleration if we ever exceed that.
 */
export function pickVertex(scene: Scene, em: EditMesh, screenX: number, screenY: number): number {
  const camera = scene.activeCamera;
  if (!camera) return -1;
  const engine = scene.getEngine();
  const w = engine.getRenderWidth();
  const h = engine.getRenderHeight();
  const worldMatrix = em.source.getWorldMatrix();
  const vp = camera.viewport.toGlobal(w, h);
  const transform = scene.getTransformMatrix();

  const r = vertPickRadius();
  let best = -1;
  let bestDist2 = r * r;

  const v3 = new Vector3();
  for (let i = 0; i < em.vertices.length; i++) {
    v3.copyFromFloats(em.positions[i * 3]!, em.positions[i * 3 + 1]!, em.positions[i * 3 + 2]!);
    const screen = Vector3.Project(v3, worldMatrix, transform, vp);
    if (screen.z < 0 || screen.z > 1) continue; // behind near plane or past far
    const dx = screen.x - screenX;
    const dy = screen.y - screenY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      best = i;
    }
  }
  return best;
}

/**
 * Pick an edge under the cursor by projecting each edge segment and finding
 * the closest one within `EDGE_PICK_RADIUS_PX`. Returns the canonical
 * half-edge id, or -1 if none.
 */
export function pickEdge(scene: Scene, em: EditMesh, screenX: number, screenY: number): number {
  const camera = scene.activeCamera;
  if (!camera) return -1;
  const engine = scene.getEngine();
  const vp = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const worldMatrix = em.source.getWorldMatrix();
  const transform = scene.getTransformMatrix();
  const va = new Vector3();
  const vb = new Vector3();

  const r = edgePickRadius();
  let best = -1;
  let bestDist2 = r * r;

  forEachEdge(em, (he) => {
    const a = edgeOrigin(em, he);
    const b = edgeEnd(em, he);
    va.copyFromFloats(em.positions[a * 3]!, em.positions[a * 3 + 1]!, em.positions[a * 3 + 2]!);
    vb.copyFromFloats(em.positions[b * 3]!, em.positions[b * 3 + 1]!, em.positions[b * 3 + 2]!);
    const pa = Vector3.Project(va, worldMatrix, transform, vp);
    const pb = Vector3.Project(vb, worldMatrix, transform, vp);
    if ((pa.z < 0 || pa.z > 1) && (pb.z < 0 || pb.z > 1)) return;
    const d2 = pointSegmentDistSq(screenX, screenY, pa.x, pa.y, pb.x, pb.y);
    if (d2 < bestDist2) {
      bestDist2 = d2;
      best = he;
    }
  });
  return best;
}

function pointSegmentDistSq(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? (apx * abx + apy * aby) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

/**
 * Pick a face under the cursor using Babylon's built-in ray pick. Returns the
 * face index, or -1.
 *
 * `pick.faceId` is the triangle index in the source mesh's index buffer, which
 * is exactly our EditMesh face index since build() walks the index buffer in
 * order.
 */
export function pickFace(scene: Scene, em: EditMesh, screenX: number, screenY: number): number {
  const result = scene.pick(screenX, screenY, (m) => m === em.source);
  if (!result?.hit || result.faceId < 0) return -1;
  if (result.faceId >= em.faces.length) return -1;
  return result.faceId;
}

/** Camera type-narrow helper used by box select. */
export function getCamera(scene: Scene): Camera | null {
  return scene.activeCamera;
}
