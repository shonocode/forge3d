import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";
import { createDefaultPBR } from "./pbr-helpers";
import { bakeAlbedo, bakeMetallicRoughness, bakeNormalMap, type ProceduralGraph } from "./procedural-graph";

/**
 * Scene-side glue for procedural materials: bake a {@link ProceduralGraph} to
 * textures and drive them onto a mesh's PBR material (albedo, and an optional
 * glTF-standard metallic-roughness map). The graph is stored on
 * `mesh.metadata.proceduralGraph` so the UI can re-bake on parameter changes,
 * and so undo/redo reconstruct state by re-baking rather than holding fragile
 * texture references.
 */

const ALB_SUFFIX = "_procAlb";
const MR_SUFFIX = "_procMR";
const NRM_SUFFIX = "_procNrm";
const isProc = (t: BaseTexture | null | undefined): boolean => !!t?.name && t.name.includes("_proc");

interface ProcMeta {
  proceduralGraph?: ProceduralGraph | null;
  proceduralPreset?: unknown;
}

/** PBR fields a procedural bake touches — captured for first-apply undo. */
export interface MatSnapshot {
  albedoTexture: BaseTexture | null;
  metallicTexture: BaseTexture | null;
  bumpTexture: BaseTexture | null;
  metallic: number | null;
  roughness: number | null;
  roughGreen: boolean;
  metalBlue: boolean;
}

function ensurePBR(mesh: AbstractMesh): PBRMaterial {
  if (mesh.material instanceof PBRMaterial) return mesh.material;
  const m = createDefaultPBR(mesh.name + "_mat", "#cccccc");
  mesh.material = m;
  return m;
}

function getMeta(mesh: AbstractMesh): ProcMeta {
  if (!mesh.metadata) mesh.metadata = {};
  return mesh.metadata as ProcMeta;
}

export function getProceduralGraph(mesh: AbstractMesh): ProceduralGraph | null {
  return (mesh.metadata as ProcMeta | undefined)?.proceduralGraph ?? null;
}

export function getProceduralPreset(mesh: AbstractMesh): unknown {
  return (mesh.metadata as ProcMeta | undefined)?.proceduralPreset ?? null;
}

function snapshot(mat: PBRMaterial): MatSnapshot {
  return {
    albedoTexture: mat.albedoTexture,
    metallicTexture: mat.metallicTexture,
    bumpTexture: mat.bumpTexture,
    metallic: mat.metallic,
    roughness: mat.roughness,
    roughGreen: mat.useRoughnessFromMetallicTextureGreen,
    metalBlue: mat.useMetallnessFromMetallicTextureBlue,
  };
}

function makeTexture(data: Uint8ClampedArray, size: number, name: string): RawTexture {
  const tex = RawTexture.CreateRGBATexture(
    new Uint8Array(data.buffer.slice(0)),
    size,
    size,
    state.scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE
  );
  tex.name = name;
  return tex;
}

/**
 * Bake `graph` onto the mesh's PBR material. **No undo** — the live-preview
 * path (called on every parameter change). Replaced procedural textures are
 * disposed so rebaking doesn't leak; the user's own (non-procedural) textures
 * are left intact.
 */
export function bakeProceduralToMesh(
  mesh: AbstractMesh,
  graph: ProceduralGraph,
  preset?: unknown
): void {
  const mat = ensurePBR(mesh);
  const size = Math.max(8, Math.min(1024, graph.resolution | 0));

  // Albedo.
  const albedoTex = makeTexture(bakeAlbedo(graph, size), size, mesh.name + ALB_SUFFIX);
  const prevA = mat.albedoTexture;
  mat.albedoTexture = albedoTex;
  if (isProc(prevA) && prevA !== albedoTex) prevA!.dispose();

  // Metallic-roughness (optional).
  const mrData = bakeMetallicRoughness(graph, size);
  const prevM = mat.metallicTexture;
  if (mrData) {
    const mrTex = makeTexture(mrData, size, mesh.name + MR_SUFFIX);
    mat.metallicTexture = mrTex;
    mat.useRoughnessFromMetallicTextureGreen = true;
    mat.useMetallnessFromMetallicTextureBlue = true;
    mat.metallic = 1; // let the texture's B channel drive metalness
    mat.roughness = 1; // let the texture's G channel drive roughness
    if (isProc(prevM) && prevM !== mrTex) prevM!.dispose();
  } else if (isProc(prevM)) {
    // Was procedural MR, now no MR channel — remove it.
    mat.metallicTexture = null;
    mat.useRoughnessFromMetallicTextureGreen = false;
    mat.useMetallnessFromMetallicTextureBlue = false;
    prevM!.dispose();
  }

  // Normal map (optional).
  const nrmData = bakeNormalMap(graph, size);
  const prevN = mat.bumpTexture;
  if (nrmData) {
    const nrmTex = makeTexture(nrmData, size, mesh.name + NRM_SUFFIX);
    mat.bumpTexture = nrmTex;
    if (isProc(prevN) && prevN !== nrmTex) prevN!.dispose();
  } else if (isProc(prevN)) {
    mat.bumpTexture = null;
    prevN!.dispose();
  }

  const meta = getMeta(mesh);
  meta.proceduralGraph = graph;
  if (preset !== undefined) meta.proceduralPreset = preset;
}

/** Dispose procedural textures + reset metadata (no undo). */
function stripProcedural(mesh: AbstractMesh): void {
  const mat = mesh.material;
  if (mat instanceof PBRMaterial) {
    if (isProc(mat.albedoTexture)) {
      mat.albedoTexture!.dispose();
      mat.albedoTexture = null;
    }
    if (isProc(mat.metallicTexture)) {
      mat.metallicTexture!.dispose();
      mat.metallicTexture = null;
      mat.useRoughnessFromMetallicTextureGreen = false;
      mat.useMetallnessFromMetallicTextureBlue = false;
    }
    if (isProc(mat.bumpTexture)) {
      mat.bumpTexture!.dispose();
      mat.bumpTexture = null;
    }
  }
  const meta = getMeta(mesh);
  meta.proceduralGraph = null;
  meta.proceduralPreset = null;
}

/** Dispose current procedural textures, then restore a captured snapshot. */
function restoreSnapshot(mesh: AbstractMesh, snap: MatSnapshot): void {
  const mat = mesh.material;
  if (mat instanceof PBRMaterial) {
    if (isProc(mat.albedoTexture) && mat.albedoTexture !== snap.albedoTexture) mat.albedoTexture!.dispose();
    if (isProc(mat.metallicTexture) && mat.metallicTexture !== snap.metallicTexture) mat.metallicTexture!.dispose();
    if (isProc(mat.bumpTexture) && mat.bumpTexture !== snap.bumpTexture) mat.bumpTexture!.dispose();
    mat.albedoTexture = snap.albedoTexture;
    mat.metallicTexture = snap.metallicTexture;
    mat.bumpTexture = snap.bumpTexture;
    mat.metallic = snap.metallic;
    mat.roughness = snap.roughness;
    mat.useRoughnessFromMetallicTextureGreen = snap.roughGreen;
    mat.useMetallnessFromMetallicTextureBlue = snap.metalBlue;
  }
  const meta = getMeta(mesh);
  meta.proceduralGraph = null;
  meta.proceduralPreset = null;
}

/**
 * Apply a procedural graph with a single undo entry. Undo re-bakes the prior
 * graph (if any) or restores the pre-procedural material; redo re-bakes this
 * graph.
 */
export function applyProceduralGraph(
  mesh: AbstractMesh,
  graph: ProceduralGraph,
  preset?: unknown
): void {
  const mat = ensurePBR(mesh);
  const meta = getMeta(mesh);
  const prevGraph = meta.proceduralGraph ?? null;
  const prevPreset = meta.proceduralPreset ?? null;
  const snap = prevGraph ? null : snapshot(mat);

  bakeProceduralToMesh(mesh, graph, preset);

  state.history.push({
    label: "Procedural Material",
    undo() {
      if (prevGraph) bakeProceduralToMesh(mesh, prevGraph, prevPreset);
      else if (snap) restoreSnapshot(mesh, snap);
    },
    redo() {
      bakeProceduralToMesh(mesh, graph, preset);
    },
  });

  status("Procedural material baked (" + (graph.resolution | 0) + "px)");
}

/**
 * Capture the material's procedural-relevant fields (for the node editor to
 * restore the pre-edit state on cancel/undo). Returns null for non-PBR meshes.
 */
export function captureProceduralSnapshot(mesh: AbstractMesh): MatSnapshot | null {
  return mesh.material instanceof PBRMaterial ? snapshot(mesh.material) : null;
}

/** Restore a snapshot captured by {@link captureProceduralSnapshot}. */
export function restoreProceduralSnapshot(mesh: AbstractMesh, snap: MatSnapshot): void {
  restoreSnapshot(mesh, snap);
}

/** Clear the procedural material from a mesh (undo-able). */
export function clearProceduralGraph(mesh: AbstractMesh): void {
  const graph = getProceduralGraph(mesh);
  if (!graph) {
    status("No procedural material");
    return;
  }
  const preset = getProceduralPreset(mesh);
  stripProcedural(mesh);

  state.history.push({
    label: "Clear Procedural",
    undo() {
      bakeProceduralToMesh(mesh, graph, preset);
    },
    redo() {
      stripProcedural(mesh);
    },
  });
  status("Procedural material cleared");
}
