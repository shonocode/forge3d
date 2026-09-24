import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";
import { store } from "../store";

export function setParent(child: AbstractMesh, parent: AbstractMesh): void {
  if (child === parent) { status("自分自身を親にできません"); return; }
  // Prevent circular parenting
  let p = parent.parent;
  while (p) {
    if (p === child) { status("循環的な親子関係は不可"); return; }
    p = p.parent;
  }
  const oldParent = (child.parent as AbstractMesh) ?? null;
  child.setParent(parent);
  store.notify();
  status(child.name + " → " + parent.name);

  state.history.push({
    label: "Set Parent",
    undo() { child.setParent(oldParent); store.notify(); },
    redo() { child.setParent(parent); store.notify(); },
  });
}

export function clearParent(mesh: AbstractMesh): void {
  if (!mesh.parent) { status("親なし"); return; }
  const oldParent = mesh.parent as AbstractMesh;
  mesh.setParent(null);
  store.notify();
  status("親を解除: " + mesh.name);

  state.history.push({
    label: "Clear Parent",
    undo() { mesh.setParent(oldParent); store.notify(); },
    redo() { mesh.setParent(null); store.notify(); },
  });
}

export function getChildren(mesh: AbstractMesh): AbstractMesh[] {
  return state.allMeshes.filter((m) => m.parent === mesh);
}

export function getRootMeshes(): AbstractMesh[] {
  return state.allMeshes.filter((m) => !m.parent || !state.allMeshes.includes(m.parent as AbstractMesh));
}
