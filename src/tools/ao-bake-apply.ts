import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { state, status, showLoading, hideLoading } from "../state";
import { bakeAO } from "./ao-bake";

/**
 * Scene plumbing for the AO bake (F-M10): reads the mesh buffers, runs the
 * pure {@link bakeAO}, wraps the result in a RawTexture and assigns it to
 * the PBR material's `ambientTexture` slot — which the glTF serializer
 * exports as `occlusionTexture`, so baked AO survives into GLB.
 *
 * One bake = one undo entry (restores the previous ambient texture).
 * Textures referenced by history entries are intentionally not disposed;
 * at ≤512² they are small and the history is capped at 50.
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
