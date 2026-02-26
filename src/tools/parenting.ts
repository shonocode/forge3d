import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";

export function setParent(child: AbstractMesh, parent: AbstractMesh): void {
  if (child === parent) { status("自分自身を親にできません"); return; }
  // Prevent circular parenting
  let p = parent.parent;
  while (p) {
    if (p === child) { status("循環的な親子関係は不可"); return; }
    p = p.parent;
  }
  child.setParent(parent);
  status(child.name + " → " + parent.name);
}

export function clearParent(mesh: AbstractMesh): void {
  if (!mesh.parent) { status("親なし"); return; }
  mesh.setParent(null);
  status("親を解除: " + mesh.name);
}

export function getChildren(mesh: AbstractMesh): AbstractMesh[] {
  return state.allMeshes.filter((m) => m.parent === mesh);
}

export function getRootMeshes(): AbstractMesh[] {
  return state.allMeshes.filter((m) => !m.parent || !state.allMeshes.includes(m.parent as AbstractMesh));
}
