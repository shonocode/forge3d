import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { state } from "../state";
import type { Modifier, ModifierType, OriginalGeometry, SubdivisionModifier, MirrorModifier, ArrayModifier } from "../state";

// ── Geometry helpers ──

function getGeometry(mesh: AbstractMesh): OriginalGeometry | null {
  const positions = mesh.getVerticesData("position");
  const normals = mesh.getVerticesData("normal");
  const indices = mesh.getIndices();
  if (!positions || !indices) return null;
  return {
    positions: new Float32Array(positions),
    normals: normals ? new Float32Array(normals) : null,
    indices: Array.from(indices),
  };
}

function applyGeometry(mesh: AbstractMesh, geo: OriginalGeometry): void {
  const vd = new VertexData();
  vd.positions = new Float32Array(geo.positions);
  if (geo.normals) vd.normals = new Float32Array(geo.normals);
  vd.indices = geo.indices.slice();
  vd.applyToMesh(mesh as Mesh);
}

// ── Subdivision (loop-style midpoint split) ──

function subdivide(geo: OriginalGeometry, level: number): OriginalGeometry {
  let pos = geo.positions;
  let idx = geo.indices;

  for (let l = 0; l < level; l++) {
    const newPos: number[] = Array.from(pos);
    const newIdx: number[] = [];
    const edgeMap = new Map<string, number>();

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
    idx = newIdx;
  }

  // Recompute normals
  const normals = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, idx, normals);
  return { positions: pos, normals, indices: idx };
}

// ── Mirror ──

function mirror(geo: OriginalGeometry, axis: "x" | "y" | "z", merge: boolean, tolerance: number): OriginalGeometry {
  const ai = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const origCount = geo.positions.length / 3;
  const newPos: number[] = Array.from(geo.positions);
  const newIdx: number[] = geo.indices.slice();

  // Add mirrored vertices
  for (let i = 0; i < origCount; i++) {
    const x = geo.positions[i * 3]!;
    const y = geo.positions[i * 3 + 1]!;
    const z = geo.positions[i * 3 + 2]!;
    const nx = ai === 0 ? -x : x;
    const ny = ai === 1 ? -y : y;
    const nz = ai === 2 ? -z : z;
    newPos.push(nx, ny, nz);
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
  return { positions, normals, indices: newIdx };
}

// ── Array ──

function arrayRepeat(geo: OriginalGeometry, count: number, ox: number, oy: number, oz: number): OriginalGeometry {
  const origVerts = geo.positions.length / 3;
  const origFaces = geo.indices.length;
  const totalPos: number[] = Array.from(geo.positions);
  const totalIdx: number[] = geo.indices.slice();

  for (let n = 1; n < count; n++) {
    const base = totalPos.length / 3;
    for (let i = 0; i < origVerts; i++) {
      totalPos.push(
        geo.positions[i * 3]! + ox * n,
        geo.positions[i * 3 + 1]! + oy * n,
        geo.positions[i * 3 + 2]! + oz * n,
      );
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
  return { positions, normals, indices: totalIdx };
}

// ── Public API ──

function ensureOriginal(mesh: AbstractMesh): void {
  if (!state.originalGeometryMap.has(mesh.uniqueId)) {
    const geo = getGeometry(mesh);
    if (geo) state.originalGeometryMap.set(mesh.uniqueId, geo);
  }
}

export function addModifier(mesh: AbstractMesh, type: ModifierType): Modifier | null {
  ensureOriginal(mesh);
  if (!state.originalGeometryMap.has(mesh.uniqueId)) return null;

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
  return mod;
}

export function removeModifier(mesh: AbstractMesh, modId: string): void {
  const mods = state.modifierMap.get(mesh.uniqueId);
  if (!mods) return;
  const idx = mods.findIndex((m) => m.id === modId);
  if (idx < 0) return;
  mods.splice(idx, 1);
  if (mods.length === 0) {
    state.modifierMap.delete(mesh.uniqueId);
    // Restore original geometry
    const orig = state.originalGeometryMap.get(mesh.uniqueId);
    if (orig) {
      applyGeometry(mesh, orig);
      state.originalGeometryMap.delete(mesh.uniqueId);
    }
  } else {
    evaluateModifierStack(mesh);
  }
}

export function toggleModifier(mesh: AbstractMesh, modId: string): void {
  const mods = state.modifierMap.get(mesh.uniqueId);
  const mod = mods?.find((m) => m.id === modId);
  if (mod) {
    mod.enabled = !mod.enabled;
    evaluateModifierStack(mesh);
  }
}

export function updateModifierParam(mesh: AbstractMesh, modId: string, params: Record<string, unknown>): void {
  const mods = state.modifierMap.get(mesh.uniqueId);
  const mod = mods?.find((m) => m.id === modId);
  if (mod) {
    Object.assign(mod, params);
    evaluateModifierStack(mesh);
  }
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

  let geo: OriginalGeometry = { ...orig, positions: new Float32Array(orig.positions), normals: orig.normals ? new Float32Array(orig.normals) : null, indices: orig.indices.slice() };
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

  let geo: OriginalGeometry = { positions: new Float32Array(orig.positions), normals: orig.normals ? new Float32Array(orig.normals) : null, indices: orig.indices.slice() };
  for (const mod of mods) {
    if (!mod.enabled) continue;
    geo = evaluateOne(geo, mod);
  }
  applyGeometry(mesh, geo);
}

export function getModifiers(mesh: AbstractMesh): Modifier[] {
  return state.modifierMap.get(mesh.uniqueId) ?? [];
}
