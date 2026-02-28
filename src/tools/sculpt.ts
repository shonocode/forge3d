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

// ── Spatial grid for fast radius queries on high-poly meshes ──
const GRID_THRESHOLD = 5000; // Only use grid for meshes with this many+ vertices

// Reusable grid + bucket pool to reduce GC pressure during sculpt strokes
const _gridCache = new Map<number, number[]>();
const _bucketPool: number[][] = [];

// Hash function: pack (ix,iy,iz) into a single number
const _hashCell = (ix: number, iy: number, iz: number) =>
  ix * 73856093 + iy * 19349663 + iz * 83492791;

/** Collect vertex indices within radius using a spatial hash grid. */
function queryRadius(
  pos: Float32Array | number[],
  cx: number, cy: number, cz: number,
  R: number,
): number[] {
  const n = pos.length / 3;
  const R2 = R * R;

  // For small meshes, linear scan is faster than grid overhead
  if (n < GRID_THRESHOLD) {
    const result: number[] = [];
    for (let i = 0; i < pos.length; i += 3) {
      const dx = pos[i]! - cx;
      const dy = pos[i + 1]! - cy;
      const dz = pos[i + 2]! - cz;
      if (dx * dx + dy * dy + dz * dz < R2) result.push(i);
    }
    return result;
  }

  // Recycle grid and buckets from previous call
  for (const bucket of _gridCache.values()) {
    bucket.length = 0;
    _bucketPool.push(bucket);
  }
  _gridCache.clear();

  // Build spatial hash grid with cell size = R (so query checks 3³ = 27 cells)
  const invCell = 1 / R;

  for (let i = 0; i < pos.length; i += 3) {
    const ix = Math.floor(pos[i]! * invCell);
    const iy = Math.floor(pos[i + 1]! * invCell);
    const iz = Math.floor(pos[i + 2]! * invCell);
    const h = _hashCell(ix, iy, iz);
    let bucket = _gridCache.get(h);
    if (!bucket) {
      bucket = _bucketPool.pop() ?? [];
      _gridCache.set(h, bucket);
    }
    bucket.push(i);
  }

  // Query cells within radius
  const minIx = Math.floor((cx - R) * invCell);
  const maxIx = Math.floor((cx + R) * invCell);
  const minIy = Math.floor((cy - R) * invCell);
  const maxIy = Math.floor((cy + R) * invCell);
  const minIz = Math.floor((cz - R) * invCell);
  const maxIz = Math.floor((cz + R) * invCell);

  const result: number[] = [];
  for (let ix = minIx; ix <= maxIx; ix++) {
    for (let iy = minIy; iy <= maxIy; iy++) {
      for (let iz = minIz; iz <= maxIz; iz++) {
        const bucket = _gridCache.get(_hashCell(ix, iy, iz));
        if (!bucket) continue;
        for (const i of bucket) {
          const dx = pos[i]! - cx;
          const dy = pos[i + 1]! - cy;
          const dz = pos[i + 2]! - cz;
          if (dx * dx + dy * dy + dz * dz < R2) result.push(i);
        }
      }
    }
  }
  return result;
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

  // Use spatial query for fast radius lookup
  const inRadius = queryRadius(pos, hitL.x, hitL.y, hitL.z, R);
  for (const i of inRadius) {
    const dx = pos[i]! - hitL.x;
    const dy = pos[i + 1]! - hitL.y;
    const dz = pos[i + 2]! - hitL.z;
    const d2 = dx * dx + dy * dy + dz * dz;
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
          const smoothFactor = Math.min(str * 3, 0.9);
          pos[i] = pos[i]! + (a.x - pos[i]!) * smoothFactor;
          pos[i + 1] = pos[i + 1]! + (a.y - pos[i + 1]!) * smoothFactor;
          pos[i + 2] = pos[i + 2]! + (a.z - pos[i + 2]!) * smoothFactor;
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
        pos[i] = pos[i]! - dx * str * 0.4 * dir;
        pos[i + 1] = pos[i + 1]! - dy * str * 0.4 * dir;
        pos[i + 2] = pos[i + 2]! - dz * str * 0.4 * dir;
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

  // Use spatial query to find vertices in range
  const inRangeIdx = queryRadius(pos, center.x, center.y, center.z, R);
  const inRange: number[] = inRangeIdx.map(i => i / 3);

  // Pre-copy positions of in-range vertices for cache efficiency
  const irCount = inRange.length;
  const irPos = new Float32Array(irCount * 3);
  for (let idx = 0; idx < irCount; idx++) {
    const ix = inRange[idx]! * 3;
    irPos[idx * 3] = pos[ix]!;
    irPos[idx * 3 + 1] = pos[ix + 1]!;
    irPos[idx * 3 + 2] = pos[ix + 2]!;
  }

  for (let a = 0; a < irCount; a++) {
    const ax = a * 3;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (let b = 0; b < irCount; b++) {
      if (b === a) continue;
      const bx = b * 3;
      const dx = irPos[bx]! - irPos[ax]!;
      const dy = irPos[bx + 1]! - irPos[ax + 1]!;
      const dz = irPos[bx + 2]! - irPos[ax + 2]!;
      if (dx * dx + dy * dy + dz * dz < hR2) {
        sx += irPos[bx]!;
        sy += irPos[bx + 1]!;
        sz += irPos[bx + 2]!;
        cnt++;
      }
    }
    if (cnt > 0) result[inRange[a]!] = { x: sx / cnt, y: sy / cnt, z: sz / cnt };
  }
  return result;
}
