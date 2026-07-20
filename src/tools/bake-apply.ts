import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { state, status, showLoading, hideLoading } from "../state";
import { bakeAO } from "./ao-bake";
import { bakeNormalFromHigh } from "./normal-bake";

/**
 * Scene plumbing for the texture bakers (F-M10): reads mesh buffers, runs
 * the pure bakers ({@link bakeAO} / {@link bakeNormalFromHigh}), wraps the
 * result in a RawTexture and assigns it to the right PBR slot —
 * `ambientTexture` exports as glTF `occlusionTexture`, `bumpTexture` as
 * `normalTexture`, so bakes survive into GLB.
 *
 * One bake = one undo entry (restores the previous texture). Textures
 * referenced by history entries are intentionally not disposed; at ≤512²
 * they are small and the history is capped at 50.
 */
export function bakeAOToMesh(mesh: AbstractMesh, resolution: 256 | 512): void {
  const mat = mesh.material as PBRMaterial | null;
  if (!mat || !("albedoTexture" in mat)) {
    status("⚠ AO Bake: PBRMaterial が必要");
    return;
  }
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
  const indices = mesh.getIndices();
  if (!positions || !indices || indices.length === 0) {
    status("⚠ AO Bake: ジオメトリがない");
    return;
  }
  if (!uvs) {
    status("⚠ AO Bake: UV がない — 先に Smart UV Project を実行");
    return;
  }

  showLoading("AO Baking…");
  // Let the loading overlay paint before the synchronous bake blocks.
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const result = bakeAO(positions, Array.from(indices), uvs, { resolution });
      if (!result) {
        status("⚠ AO Bake: ベイク失敗 (メッシュが退化している)");
        return;
      }
      const tex = RawTexture.CreateRGBATexture(
        new Uint8Array(result.pixels.buffer.slice(0)),
        result.resolution,
        result.resolution,
        state.scene,
        true,
        false,
        Texture.TRILINEAR_SAMPLINGMODE,
      );
      tex.name = mesh.name + "_aoBake";

      const prev = mat.ambientTexture;
      mat.ambientTexture = tex;
      const matRef = mat;
      state.history.push({
        label: "AO Bake",
        undo() { matRef.ambientTexture = prev; },
        redo() { matRef.ambientTexture = tex; },
      });
      const ms = Math.round(performance.now() - t0);
      status(`AO Bake completed: ${result.resolution}px, coverage ${(result.coverage * 100).toFixed(0)}% (${ms}ms)`);
    } finally {
      hideLoading();
    }
  }, 30);
}

/** World-space vertex positions of a mesh (bakes pair meshes across transforms). */
function worldPositions(mesh: AbstractMesh): Float32Array | null {
  const local = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!local) return null;
  const m = mesh.computeWorldMatrix(true);
  const out = new Float32Array(local.length);
  const v = new Vector3();
  const r = new Vector3();
  for (let i = 0; i < local.length / 3; i++) {
    v.copyFromFloats(local[i * 3]!, local[i * 3 + 1]!, local[i * 3 + 2]!);
    Vector3.TransformCoordinatesToRef(v, m, r);
    out[i * 3] = r.x;
    out[i * 3 + 1] = r.y;
    out[i * 3 + 2] = r.z;
  }
  return out;
}

/**
 * Bake the high mesh's surface normals into a tangent-space normal map on
 * the low mesh (retopo workflow). Both meshes are taken in WORLD space, so
 * the pair only needs to overlap visually — transforms are respected.
 */
export function bakeNormalToLowMesh(low: AbstractMesh, high: AbstractMesh, resolution: 256 | 512): void {
  const mat = low.material as PBRMaterial | null;
  if (!mat || !("albedoTexture" in mat)) {
    status("⚠ Normal Bake: PBRMaterial が必要");
    return;
  }
  if (low === high) {
    status("⚠ Normal Bake: ハイポリに別のメッシュを選択");
    return;
  }
  const lowUVs = low.getVerticesData(VertexBuffer.UVKind);
  const lowIdx = low.getIndices();
  const highIdx = high.getIndices();
  if (!lowUVs) {
    status("⚠ Normal Bake: ローポリに UV がない — 先に Smart UV Project");
    return;
  }
  if (!lowIdx || lowIdx.length === 0 || !highIdx || highIdx.length === 0) {
    status("⚠ Normal Bake: ジオメトリがない");
    return;
  }
  const lowPos = worldPositions(low);
  const highPos = worldPositions(high);
  if (!lowPos || !highPos) {
    status("⚠ Normal Bake: ジオメトリがない");
    return;
  }

  showLoading("Normal Baking…");
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const result = bakeNormalFromHigh(lowPos, Array.from(lowIdx), lowUVs, highPos, Array.from(highIdx), {
        resolution,
      });
      if (!result) {
        status("⚠ Normal Bake: ベイク失敗 (メッシュが退化している)");
        return;
      }
      const tex = RawTexture.CreateRGBATexture(
        new Uint8Array(result.pixels.buffer.slice(0)),
        result.resolution,
        result.resolution,
        state.scene,
        true,
        false,
        Texture.TRILINEAR_SAMPLINGMODE,
      );
      tex.name = low.name + "_normalBake";

      const prev = mat.bumpTexture;
      mat.bumpTexture = tex;
      const matRef = mat;
      state.history.push({
        label: "Normal Bake",
        undo() { matRef.bumpTexture = prev; },
        redo() { matRef.bumpTexture = tex; },
      });
      const ms = Math.round(performance.now() - t0);
      const hitPct = (result.hitRatio * 100).toFixed(0);
      status(`Normal Bake completed: ${result.resolution}px, hit ${hitPct}% (${ms}ms)`);
      if (result.hitRatio < 0.5) {
        status(`⚠ Normal Bake: ヒット率 ${hitPct}% — ハイポリがローポリに重なっているか確認`);
      }
    } finally {
      hideLoading();
    }
  }, 30);
}
