import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { edgeEnd, edgeOrigin, faceVerts, forEachEdge, type EditMesh } from "./half-edge";
import type { EditSelection } from "../../state";

/**
 * Rectangular box select. Projects every relevant component (or its centroid)
 * to screen space and includes it if inside the given screen-space rectangle.
 *
 * @returns the set of newly-collected component IDs in the active mode (caller
 *          decides whether to replace or add to the existing selection).
 */
export function collectBoxSelection(
  scene: Scene,
  em: EditMesh,
  mode: EditSelection["mode"],
  rect: { x1: number; y1: number; x2: number; y2: number },
): Set<number> {
  const camera = scene.activeCamera;
  const out = new Set<number>();
  if (!camera) return out;

  const engine = scene.getEngine();
  const vp = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const worldMatrix = em.source.getWorldMatrix();
  const transform = scene.getTransformMatrix();
  const v = new Vector3();

  const xMin = Math.min(rect.x1, rect.x2);
  const xMax = Math.max(rect.x1, rect.x2);
  const yMin = Math.min(rect.y1, rect.y2);
  const yMax = Math.max(rect.y1, rect.y2);

  const projectVert = (i: number): { x: number; y: number; z: number } => {
    v.copyFromFloats(em.positions[i * 3]!, em.positions[i * 3 + 1]!, em.positions[i * 3 + 2]!);
    return Vector3.Project(v, worldMatrix, transform, vp);
  };

  const inRect = (sx: number, sy: number, sz: number): boolean =>
    sz >= 0 && sz <= 1 && sx >= xMin && sx <= xMax && sy >= yMin && sy <= yMax;

  if (mode === "vertex") {
    for (let i = 0; i < em.vertices.length; i++) {
      const p = projectVert(i);
      if (inRect(p.x, p.y, p.z)) out.add(i);
    }
  } else if (mode === "edge") {
    forEachEdge(em, (he) => {
      const a = projectVert(edgeOrigin(em, he));
      const b = projectVert(edgeEnd(em, he));
      // Include edge if either endpoint or midpoint is inside.
      if (inRect(a.x, a.y, a.z) || inRect(b.x, b.y, b.z)) out.add(he);
    });
  } else {
    for (let f = 0; f < em.faces.length; f++) {
      const verts = faceVerts(em, f);
      let cx = 0, cy = 0, cz = 0;
      for (const vi of verts) {
        const p = projectVert(vi);
        cx += p.x; cy += p.y; cz += p.z;
      }
      const n = verts.length;
      if (inRect(cx / n, cy / n, cz / n)) out.add(f);
    }
  }

  return out;
}
