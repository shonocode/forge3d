import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { state, status } from "../state";
import type { BrushId } from "../state";

export const BRUSHES = [
  { id: "push" as BrushId, label: "↑ Push（盛り上げ）" },
  { id: "pull" as BrushId, label: "↓ Pull（凹ませる）" },
  { id: "smooth" as BrushId, label: "〜 Smooth（平滑化）" },
  { id: "flatten" as BrushId, label: "— Flatten（平坦化）" },
  { id: "pinch" as BrushId, label: "⊕ Pinch（つまむ）" },
  { id: "inflate" as BrushId, label: "◇ Inflate（膨張）" },
];

export function setBrush(b: BrushId): void {
  state.sculptConfig.brush = b;
  document.querySelectorAll<HTMLElement>(".bon").forEach((e) =>
    e.classList.toggle("on", e.id === "sb_" + b)
  );
  status("Brush: " + b);
}

export function sculptAt(mesh: AbstractMesh, pick: PickingInfo): void {
  if (!mesh || !pick.hit) return;
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const nor = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!pos || !nor) return;

  const hitW = pick.pickedPoint;
  if (!hitW) return;
  let inv: Matrix;
  try {
    inv = Matrix.Invert(mesh.getWorldMatrix());
  } catch { return; }
  const hitL = Vector3.TransformCoordinates(hitW, inv);

  const { radius: R, strength: S, falloff: F } = state.sculptConfig;
  const ctrlDown = state.keysDown.has("Control") || state.keysDown.has("Meta") || state.touchModifiers.ctrl;
  const shiftDown = state.keysDown.has("Shift") || state.touchModifiers.shift;
  const brush: BrushId = shiftDown ? "smooth" : state.sculptConfig.brush;
  const dir = ctrlDown ? -1 : 1;

  let avgC: (({ x: number; y: number; z: number }) | undefined)[] | null = null;
  if (brush === "smooth") avgC = smoothAvg(pos, hitL, R);

  const R2 = R * R;
  for (let i = 0; i < pos.length; i += 3) {
    const dx = pos[i]! - hitL.x;
    const dy = pos[i + 1]! - hitL.y;
    const dz = pos[i + 2]! - hitL.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= R2) continue;
    const dist = Math.sqrt(d2);
    const fall = Math.pow(1 - dist / R, F);
    const str = fall * S;
    const nx = nor[i]!;
    const ny = nor[i + 1]!;
    const nz = nor[i + 2]!;

    switch (brush) {
      case "push":
        pos[i] = pos[i]! + nx * str * dir;
        pos[i + 1] = pos[i + 1]! + ny * str * dir;
        pos[i + 2] = pos[i + 2]! + nz * str * dir;
        break;
      case "pull":
        pos[i] = pos[i]! - nx * str * dir;
        pos[i + 1] = pos[i + 1]! - ny * str * dir;
        pos[i + 2] = pos[i + 2]! - nz * str * dir;
        break;
      case "smooth": {
        const vi = i / 3;
        if (avgC && avgC[vi]) {
          const a = avgC[vi]!;
          pos[i] = pos[i]! + (a.x - pos[i]!) * str * 3;
          pos[i + 1] = pos[i + 1]! + (a.y - pos[i + 1]!) * str * 3;
          pos[i + 2] = pos[i + 2]! + (a.z - pos[i + 2]!) * str * 3;
        }
        break;
      }
      case "flatten": {
        const dot =
          (pos[i]! - hitL.x) * nx +
          (pos[i + 1]! - hitL.y) * ny +
          (pos[i + 2]! - hitL.z) * nz;
        pos[i] = pos[i]! - nx * dot * str * 2;
        pos[i + 1] = pos[i + 1]! - ny * dot * str * 2;
        pos[i + 2] = pos[i + 2]! - nz * dot * str * 2;
        break;
      }
      case "pinch":
        pos[i] = pos[i]! - dx * str * 0.4;
        pos[i + 1] = pos[i + 1]! - dy * str * 0.4;
        pos[i + 2] = pos[i + 2]! - dz * str * 0.4;
        break;
      case "inflate":
        pos[i] = pos[i]! + nx * str * dir * 0.8;
        pos[i + 1] = pos[i + 1]! + ny * str * dir * 0.8;
        pos[i + 2] = pos[i + 2]! + nz * str * dir * 0.8;
        break;
    }
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, pos);
  const idx = mesh.getIndices();
  if (idx) {
    VertexData.ComputeNormals(pos, idx, nor);
    mesh.updateVerticesData(VertexBuffer.NormalKind, nor);
  }
}

function smoothAvg(
  pos: Float32Array | number[],
  center: Vector3,
  R: number
): (({ x: number; y: number; z: number }) | undefined)[] {
  const n = pos.length / 3;
  const result: (({ x: number; y: number; z: number }) | undefined)[] = new Array(n);
  const hR = R * 0.6;
  const hR2 = hR * hR;
  const R2 = R * R;
  const inRange: number[] = [];
  for (let i = 0; i < n; i++) {
    const ix = i * 3;
    const dx = pos[ix]! - center.x;
    const dy = pos[ix + 1]! - center.y;
    const dz = pos[ix + 2]! - center.z;
    if (dx * dx + dy * dy + dz * dz < R2) inRange.push(i);
  }
  for (const i of inRange) {
    const ix = i * 3;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const j of inRange) {
      if (j === i) continue;
      const jx = j * 3;
      const dx = pos[jx]! - pos[ix]!;
      const dy = pos[jx + 1]! - pos[ix + 1]!;
      const dz = pos[jx + 2]! - pos[ix + 2]!;
      if (dx * dx + dy * dy + dz * dz < hR2) {
        sx += pos[jx]!;
        sy += pos[jx + 1]!;
        sz += pos[jx + 2]!;
        cnt++;
      }
    }
    if (cnt > 0) result[i] = { x: sx / cnt, y: sy / cnt, z: sz / cnt };
  }
  return result;
}
