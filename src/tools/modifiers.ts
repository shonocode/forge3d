import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { state, status } from "../state";
import type { Modifier, ModifierType, OriginalGeometry } from "../state";
import { buildEditMesh, POLY_METADATA_KEY } from "./edit-mode/build";
import { toPolygons } from "./edit-mode/half-edge";
import { evaluateStack } from "./modifier-core";

// ── Geometry helpers ──
// The evaluation itself is `modifier-core.ts` (headless, the library's
// operators); this side reads and writes Babylon meshes.

function getGeometry(mesh: AbstractMesh): OriginalGeometry | null {
  const positions = mesh.getVerticesData("position");
  const normals = mesh.getVerticesData("normal");
  const uvs = mesh.getVerticesData("uv");
  const indices = mesh.getIndices();
  if (!positions || !indices) return null;
  // The real faces, when the mesh has polygon metadata that still matches the
  // triangles — buildEditMesh drops the key when it is stale. Without it the
  // triangles go in bare and modifier-core rejoins Babylon's quad pairs.
  const built = mesh instanceof Mesh ? buildEditMesh(mesh) : null;
  const hasPolys = !!(mesh.metadata as Record<string, unknown> | null)?.[POLY_METADATA_KEY];
  const em = hasPolys ? built : null;
  return {
    positions: new Float32Array(positions),
    normals: normals ? new Float32Array(normals) : null,
    uvs: uvs ? new Float32Array(uvs) : null,
    indices: Array.from(indices),
    ...(em ? { polys: toPolygons(em) } : {}),
  };
}

function applyGeometry(mesh: AbstractMesh, geo: OriginalGeometry): void {
  const vd = new VertexData();
  vd.positions = new Float32Array(geo.positions);
  if (geo.normals) vd.normals = new Float32Array(geo.normals);
  if (geo.uvs) vd.uvs = new Float32Array(geo.uvs);
  vd.indices = geo.indices.slice();
  vd.applyToMesh(mesh as Mesh, true);
  // The faces go with the triangles, so Edit Mode and CSG see quads.
  const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
  if (geo.polys) meta[POLY_METADATA_KEY] = geo.polys.map((p) => [...p]);
  else delete meta[POLY_METADATA_KEY];
  mesh.metadata = meta;
}

// ── Public API ──

function ensureOriginal(mesh: AbstractMesh): void {
  if (!state.originalGeometryMap.has(mesh.uniqueId)) {
    const geo = getGeometry(mesh);
    if (geo) state.originalGeometryMap.set(mesh.uniqueId, geo);
  }
}

const MAX_MODIFIERS = 8;

export function addModifier(mesh: AbstractMesh, type: ModifierType): Modifier | null {
  ensureOriginal(mesh);
  if (!state.originalGeometryMap.has(mesh.uniqueId)) return null;

  const existing = state.modifierMap.get(mesh.uniqueId) ?? [];
  if (existing.length >= MAX_MODIFIERS) {
    status("\u26a0 \u30e2\u30c7\u30a3\u30d5\u30a1\u30a4\u30a2\u4e0a\u9650 (" + MAX_MODIFIERS + ")");
    return null;
  }

  state.modifierCounter++;
  const id = "mod_" + state.modifierCounter;
  let mod: Modifier;

  switch (type) {
    case "subdivision":
      mod = { id, type: "subdivision", enabled: true, level: 1, mode: "catmull-clark" };
      break;
    case "mirror":
      mod = { id, type: "mirror", enabled: true, axis: "x", merge: true, mergeTolerance: 0.001 };
      break;
    case "array":
      mod = { id, type: "array", enabled: true, count: 3, offsetX: 2, offsetY: 0, offsetZ: 0 };
      break;
    case "solidify":
      mod = { id, type: "solidify", enabled: true, thickness: 0.1 };
      break;
    case "decimate":
      mod = { id, type: "decimate", enabled: true, ratio: 0.5 };
      break;
    case "smooth":
      // Blender's Smooth modifier defaults.
      mod = { id, type: "smooth", enabled: true, factor: 0.5, repeat: 1 };
      break;
    case "triangulate":
      mod = { id, type: "triangulate", enabled: true, quadMethod: "beauty", ngonMethod: "beauty" };
      break;
    case "weld":
      mod = { id, type: "weld", enabled: true, distance: 0.001 };
      break;
  }

  const mods = state.modifierMap.get(mesh.uniqueId) ?? [];
  mods.push(mod);
  state.modifierMap.set(mesh.uniqueId, mods);
  evaluateModifierStack(mesh);

  state.history.push({
    label: "Add Modifier",
    undo() {
      const ms = state.modifierMap.get(mesh.uniqueId);
      if (!ms) return;
      const i = ms.indexOf(mod);
      if (i >= 0) ms.splice(i, 1);
      if (ms.length === 0) {
        state.modifierMap.delete(mesh.uniqueId);
        const orig = state.originalGeometryMap.get(mesh.uniqueId);
        if (orig) { applyGeometry(mesh, orig); state.originalGeometryMap.delete(mesh.uniqueId); }
      } else { evaluateModifierStack(mesh); }
    },
    redo() {
      ensureOriginal(mesh);
      const ms = state.modifierMap.get(mesh.uniqueId) ?? [];
      ms.push(mod);
      state.modifierMap.set(mesh.uniqueId, ms);
      evaluateModifierStack(mesh);
    },
  });

  return mod;
}

export function removeModifier(mesh: AbstractMesh, modId: string): void {
  const mods = state.modifierMap.get(mesh.uniqueId);
  if (!mods) return;
  const idx = mods.findIndex((m) => m.id === modId);
  if (idx < 0) return;
  const removed = mods[idx]!;

  mods.splice(idx, 1);
  if (mods.length === 0) {
    state.modifierMap.delete(mesh.uniqueId);
    const orig = state.originalGeometryMap.get(mesh.uniqueId);
    if (orig) {
      applyGeometry(mesh, orig);
      state.originalGeometryMap.delete(mesh.uniqueId);
    }
  } else {
    evaluateModifierStack(mesh);
  }

  state.history.push({
    label: "Remove Modifier",
    undo() {
      ensureOriginal(mesh);
      const ms = state.modifierMap.get(mesh.uniqueId) ?? [];
      ms.splice(idx, 0, removed);
      state.modifierMap.set(mesh.uniqueId, ms);
      evaluateModifierStack(mesh);
    },
    redo() {
      const ms = state.modifierMap.get(mesh.uniqueId);
      if (!ms) return;
      const i = ms.indexOf(removed);
      if (i >= 0) ms.splice(i, 1);
      if (ms.length === 0) {
        state.modifierMap.delete(mesh.uniqueId);
        const orig = state.originalGeometryMap.get(mesh.uniqueId);
        if (orig) { applyGeometry(mesh, orig); state.originalGeometryMap.delete(mesh.uniqueId); }
      } else { evaluateModifierStack(mesh); }
    },
  });
}

export function toggleModifier(mesh: AbstractMesh, modId: string): void {
  const mods = state.modifierMap.get(mesh.uniqueId);
  const mod = mods?.find((m) => m.id === modId);
  if (!mod) return;
  mod.enabled = !mod.enabled;
  evaluateModifierStack(mesh);

  state.history.push({
    label: "Toggle Modifier",
    undo() { mod.enabled = !mod.enabled; evaluateModifierStack(mesh); },
    redo() { mod.enabled = !mod.enabled; evaluateModifierStack(mesh); },
  });
}

export function updateModifierParam(mesh: AbstractMesh, modId: string, params: Record<string, unknown>): void {
  const mods = state.modifierMap.get(mesh.uniqueId);
  const mod = mods?.find((m) => m.id === modId);
  if (!mod) return;

  const before: Record<string, unknown> = {};
  for (const key of Object.keys(params)) {
    before[key] = (mod as unknown as Record<string, unknown>)[key];
  }
  Object.assign(mod, params);
  evaluateModifierStack(mesh);

  state.history.push({
    label: "Modifier Param",
    undo() { Object.assign(mod, before); evaluateModifierStack(mesh); },
    redo() { Object.assign(mod, params); evaluateModifierStack(mesh); },
  });
}

/**
 * Bake a modifier permanently: the base geometry becomes the stack evaluated
 * up to and including it. The modifiers above it are baked in by that, so
 * they leave the stack too — keeping them would apply them twice.
 */
export function applyModifier(mesh: AbstractMesh, modId: string): void {
  const mods = state.modifierMap.get(mesh.uniqueId);
  if (!mods) return;
  const idx = mods.findIndex((m) => m.id === modId);
  if (idx < 0) return;
  const orig = state.originalGeometryMap.get(mesh.uniqueId);
  if (!orig) return;

  const geo: OriginalGeometry = evaluateStack(orig, mods, idx + 1);
  if (orig.smoothAngle !== undefined) geo.smoothAngle = orig.smoothAngle;
  const beforeMods = mods.slice();
  const afterMods = mods.slice(idx + 1);

  const set = (base: OriginalGeometry, stack: Modifier[]): void => {
    if (stack.length === 0) {
      state.modifierMap.delete(mesh.uniqueId);
      state.originalGeometryMap.delete(mesh.uniqueId);
      applyGeometry(mesh, base);
    } else {
      state.modifierMap.set(mesh.uniqueId, stack.slice());
      state.originalGeometryMap.set(mesh.uniqueId, base);
      evaluateModifierStack(mesh);
    }
  };
  set(geo, afterMods);
  if (idx > 0) status(`モディファイア ${idx + 1} 個を確定（上にあったものも一緒に焼き込み）`);

  state.history.push({
    label: "Apply Modifier",
    undo() { set(orig, beforeMods); },
    redo() { set(geo, afterMods); },
  });
}

export function evaluateModifierStack(mesh: AbstractMesh): void {
  const orig = state.originalGeometryMap.get(mesh.uniqueId);
  if (!orig) return;
  const mods = state.modifierMap.get(mesh.uniqueId) ?? [];
  try {
    applyGeometry(mesh, evaluateStack(orig, mods));
  } catch (e) {
    console.error("Modifier error:", e);
    status("⚠ モディファイアの計算に失敗: " + (e as Error).message);
  }
}

/**
 * Shade a mesh that has modifiers: the angle goes onto the base geometry, so
 * the next evaluation keeps it instead of reading the shading back off the
 * base. Returns false when the mesh has no stack (shade it directly).
 */
export function setModifierShading(mesh: AbstractMesh, angleRad: number): boolean {
  const orig = state.originalGeometryMap.get(mesh.uniqueId);
  if (!orig || !state.modifierMap.get(mesh.uniqueId)?.length) return false;
  const before = orig.smoothAngle;
  orig.smoothAngle = angleRad;
  evaluateModifierStack(mesh);
  state.history.push({
    label: "Shade",
    undo() {
      if (before === undefined) delete orig.smoothAngle;
      else orig.smoothAngle = before;
      evaluateModifierStack(mesh);
    },
    redo() {
      orig.smoothAngle = angleRad;
      evaluateModifierStack(mesh);
    },
  });
  return true;
}

export function getModifiers(mesh: AbstractMesh): Modifier[] {
  return state.modifierMap.get(mesh.uniqueId) ?? [];
}
