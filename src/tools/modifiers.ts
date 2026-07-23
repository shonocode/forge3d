import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { state, status } from "../state";
import type { Modifier, ModifierType, OriginalGeometry, SubdivisionModifier, MirrorModifier, ArrayModifier } from "../state";

// ── Geometry helpers ──

function getGeometry(mesh: AbstractMesh): OriginalGeometry | null {
  const positions = mesh.getVerticesData("position");
  const normals = mesh.getVerticesData("normal");
  const uvs = mesh.getVerticesData("uv");
  const indices = mesh.getIndices();
  if (!positions || !indices) return null;
  return {
    positions: new Float32Array(positions),
    normals: normals ? new Float32Array(normals) : null,
    uvs: uvs ? new Float32Array(uvs) : null,
    indices: Array.from(indices),
  };
}

function applyGeometry(mesh: AbstractMesh, geo: OriginalGeometry): void {
  const vd = new VertexData();
  vd.positions = new Float32Array(geo.positions);
  if (geo.normals) vd.normals = new Float32Array(geo.normals);
  if (geo.uvs) vd.uvs = new Float32Array(geo.uvs);
  vd.indices = geo.indices.slice();
  vd.applyToMesh(mesh as Mesh);
}

function cloneGeometry(geo: OriginalGeometry): OriginalGeometry {
  return {
    positions: new Float32Array(geo.positions),
    normals: geo.normals ? new Float32Array(geo.normals) : null,
    uvs: geo.uvs ? new Float32Array(geo.uvs) : null,
    indices: geo.indices.slice(),
  };
}

// ── Subdivision (loop-style midpoint split) ──
// Exported for headless tests (pure: geo in → geo out).

export function subdivide(geo: OriginalGeometry, level: number): OriginalGeometry {
  let pos = geo.positions;
  let uv = geo.uvs;
  let idx = geo.indices;

  for (let l = 0; l < level; l++) {
    const newPos: number[] = Array.from(pos);
    const newUV: number[] | null = uv ? Array.from(uv) : null;
    const newIdx: number[] = [];
    const edgeMap = new Map<string, number>();
    const uvSrc = uv;

    function midpoint(a: number, b: number): number {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const existing = edgeMap.get(key);
      if (existing !== undefined) return existing;
      const mid = newPos.length / 3;
      newPos.push(
        (newPos[a * 3]! + newPos[b * 3]!) / 2,
        (newPos[a * 3 + 1]! + newPos[b * 3 + 1]!) / 2,
        (newPos[a * 3 + 2]! + newPos[b * 3 + 2]!) / 2,
      );
      // UV midpoint mirrors the position split: the new vert sits halfway
      // along the edge in 3D, so halfway in UV space is exact for the
      // linear interpolation the surface's texturing already uses.
      if (newUV && uvSrc) {
        newUV.push(
          (uvSrc[a * 2]! + uvSrc[b * 2]!) / 2,
          (uvSrc[a * 2 + 1]! + uvSrc[b * 2 + 1]!) / 2,
        );
      }
      edgeMap.set(key, mid);
      return mid;
    }

    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i]!, b = idx[i + 1]!, c = idx[i + 2]!;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      // 4 sub-triangles
      newIdx.push(a, ab, ca);
      newIdx.push(ab, b, bc);
      newIdx.push(ca, bc, c);
      newIdx.push(ab, bc, ca);
    }

    pos = new Float32Array(newPos);
    uv = newUV ? new Float32Array(newUV) : null;
    idx = newIdx;
  }

  // Recompute normals
  const normals = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, idx, normals);
  return { positions: pos, normals, uvs: uv, indices: idx };
}

// ── Mirror ──
// Exported for headless tests (pure: geo in → geo out).

export function mirror(geo: OriginalGeometry, axis: "x" | "y" | "z", merge: boolean, tolerance: number): OriginalGeometry {
  const ai = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const origCount = geo.positions.length / 3;
  const newPos: number[] = Array.from(geo.positions);
  const newUV: number[] | null = geo.uvs ? Array.from(geo.uvs) : null;
  const newIdx: number[] = geo.indices.slice();

  // Add mirrored vertices. Each copy keeps its source vert's UV — the texture
  // mirrors together with the geometry (standard mirror-modifier behavior).
  for (let i = 0; i < origCount; i++) {
    const x = geo.positions[i * 3]!;
    const y = geo.positions[i * 3 + 1]!;
    const z = geo.positions[i * 3 + 2]!;
    const nx = ai === 0 ? -x : x;
    const ny = ai === 1 ? -y : y;
    const nz = ai === 2 ? -z : z;
    newPos.push(nx, ny, nz);
    if (newUV && geo.uvs) newUV.push(geo.uvs[i * 2]!, geo.uvs[i * 2 + 1]!);
  }

  // Add mirrored faces (reversed winding)
  const triCount = geo.indices.length;
  for (let i = 0; i < triCount; i += 3) {
    newIdx.push(
      geo.indices[i]! + origCount,
      geo.indices[i + 2]! + origCount,  // reversed winding
      geo.indices[i + 1]! + origCount,
    );
  }

  // Merge vertices on the mirror plane if requested
  if (merge) {
    const totalCount = newPos.length / 3;
    const remap = new Int32Array(totalCount);
    for (let i = 0; i < totalCount; i++) remap[i] = i;

    for (let i = 0; i < origCount; i++) {
      if (Math.abs(newPos[i * 3 + ai]!) < tolerance) {
        // This vertex is on the mirror plane; link its mirror copy to original
        remap[i + origCount] = i;
      }
    }

    // Apply remap to indices
    for (let i = 0; i < newIdx.length; i++) {
      newIdx[i] = remap[newIdx[i]!]!;
    }
  }

  const positions = new Float32Array(newPos);
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, newIdx, normals);
  return { positions, normals, uvs: newUV ? new Float32Array(newUV) : null, indices: newIdx };
}

// ── Array ──
// Exported for headless tests (pure: geo in → geo out).

export function arrayRepeat(geo: OriginalGeometry, count: number, ox: number, oy: number, oz: number): OriginalGeometry {
  const origVerts = geo.positions.length / 3;
  const origFaces = geo.indices.length;
  const totalPos: number[] = Array.from(geo.positions);
  const totalUV: number[] | null = geo.uvs ? Array.from(geo.uvs) : null;
  const totalIdx: number[] = geo.indices.slice();

  for (let n = 1; n < count; n++) {
    const base = totalPos.length / 3;
    for (let i = 0; i < origVerts; i++) {
      totalPos.push(
        geo.positions[i * 3]! + ox * n,
        geo.positions[i * 3 + 1]! + oy * n,
        geo.positions[i * 3 + 2]! + oz * n,
      );
      // Every copy repeats the source UVs (each instance textures identically).
      if (totalUV && geo.uvs) totalUV.push(geo.uvs[i * 2]!, geo.uvs[i * 2 + 1]!);
    }
    for (let i = 0; i < origFaces; i++) {
      totalIdx.push(geo.indices[i]! + base);
    }
  }

  const positions = new Float32Array(totalPos);
  const normals = geo.normals ? new Float32Array(positions.length) : null;
  if (normals) {
    // Replicate original normals for each copy
    for (let n = 0; n < count; n++) {
      for (let i = 0; i < origVerts * 3; i++) {
        normals[n * origVerts * 3 + i] = geo.normals![i]!;
      }
    }
  }
  return { positions, normals, uvs: totalUV ? new Float32Array(totalUV) : null, indices: totalIdx };
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
      mod = { id, type: "subdivision", enabled: true, level: 1 };
      break;
    case "mirror":
      mod = { id, type: "mirror", enabled: true, axis: "x", merge: true, mergeTolerance: 0.001 };
      break;
    case "array":
      mod = { id, type: "array", enabled: true, count: 3, offsetX: 2, offsetY: 0, offsetZ: 0 };
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

/** Bake a modifier permanently — removes it and updates the original geometry */
export function applyModifier(mesh: AbstractMesh, modId: string): void {
  const mods = state.modifierMap.get(mesh.uniqueId);
  if (!mods) return;
  const idx = mods.findIndex((m) => m.id === modId);
  if (idx < 0) return;

  // Evaluate up to and including this modifier
  const orig = state.originalGeometryMap.get(mesh.uniqueId);
  if (!orig) return;

  let geo: OriginalGeometry = cloneGeometry(orig);
  for (let i = 0; i <= idx; i++) {
    const m = mods[i]!;
    if (!m.enabled) continue;
    geo = evaluateOne(geo, m);
  }

  // This becomes the new original
  state.originalGeometryMap.set(mesh.uniqueId, geo);
  // Remove the applied modifier
  mods.splice(idx, 1);
  if (mods.length === 0) {
    state.modifierMap.delete(mesh.uniqueId);
    state.originalGeometryMap.delete(mesh.uniqueId);
  }
  // Re-evaluate remaining stack
  evaluateModifierStack(mesh);
}

function evaluateOne(geo: OriginalGeometry, mod: Modifier): OriginalGeometry {
  switch (mod.type) {
    case "subdivision":
      return subdivide(geo, (mod as SubdivisionModifier).level);
    case "mirror": {
      const m = mod as MirrorModifier;
      return mirror(geo, m.axis, m.merge, m.mergeTolerance);
    }
    case "array": {
      const a = mod as ArrayModifier;
      return arrayRepeat(geo, a.count, a.offsetX, a.offsetY, a.offsetZ);
    }
  }
}

export function evaluateModifierStack(mesh: AbstractMesh): void {
  const orig = state.originalGeometryMap.get(mesh.uniqueId);
  if (!orig) return;
  const mods = state.modifierMap.get(mesh.uniqueId) ?? [];

  let geo: OriginalGeometry = cloneGeometry(orig);
  for (const mod of mods) {
    if (!mod.enabled) continue;
    geo = evaluateOne(geo, mod);
  }
  applyGeometry(mesh, geo);
}

export function getModifiers(mesh: AbstractMesh): Modifier[] {
  return state.modifierMap.get(mesh.uniqueId) ?? [];
}
