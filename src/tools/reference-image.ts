/**
 * Reference images — import concept art / blueprints as unlit planes to model
 * against, Blender's "image empty" workflow.
 *
 * Reference planes are ordinary scene meshes (selectable, movable, layerable,
 * deletable) but are excluded from every export path by their `refimg_` name
 * prefix (see gltf-exporter's shouldExportNode / exportOBJ) — they are
 * modeling aids, not assets.
 */

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { state, status } from "../state";
import { selectMesh, updateGizmo } from "./selection";
import { assignToActiveLayer } from "./layers";
import { updateHierarchy } from "../ui/panels";
import { openFileDialog } from "../ui/file-input";

/** Name prefix that marks a mesh as a non-exported reference plane. */
export const REF_IMAGE_PREFIX = "refimg_";

/** True when the mesh is a reference plane (excluded from all exports). */
export function isReferenceImage(name: string): boolean {
  return name.startsWith(REF_IMAGE_PREFIX);
}

let _refCounter = 0;

/** Open a file dialog and place the chosen image as a reference plane. */
export function importReferenceImage(): void {
  openFileDialog("image/*", (file) => {
    const url = URL.createObjectURL(file);
    const tex = new Texture(
      url,
      state.scene,
      false,
      true,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => {
        try {
          createRefPlane(file.name, tex);
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      () => {
        URL.revokeObjectURL(url);
        status("⚠ 画像を読み込めませんでした: " + file.name);
      },
    );
  });
}

function createRefPlane(fileName: string, tex: Texture): void {
  _refCounter++;
  const size = tex.getSize();
  const aspect = size.height > 0 ? size.width / size.height : 1;
  const height = 3; // world units — roughly character-sized
  const name = REF_IMAGE_PREFIX + _refCounter + "_" + fileName.replace(/\.[^.]+$/, "");

  const mesh = MeshBuilder.CreatePlane(name, { width: height * aspect, height, sideOrientation: 2 }, state.scene);
  mesh.position.y = height / 2;

  // Unlit, slightly transparent, double-sided — reads like a drawing board,
  // never fights the scene lighting, and stays visible from behind.
  const mat = new StandardMaterial(name + "_mat", state.scene);
  mat.emissiveTexture = tex;
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.alpha = 0.75;
  mat.backFaceCulling = false;
  mesh.material = mat;

  mesh.isPickable = true;
  assignToActiveLayer(mesh);
  state.allMeshes.push(mesh);
  selectMesh(mesh, false);
  updateHierarchy();

  state.history.push({
    label: "Add Reference Image",
    undo() {
      mesh.setEnabled(false);
      const idx = state.allMeshes.indexOf(mesh);
      if (idx >= 0) state.allMeshes.splice(idx, 1);
      state.selectedMeshes = state.selectedMeshes.filter((x) => x !== mesh);
      updateGizmo();
      updateHierarchy();
    },
    redo() {
      mesh.setEnabled(true);
      state.allMeshes.push(mesh);
      selectMesh(mesh, false);
      updateHierarchy();
    },
  });

  status("Reference: " + fileName + "（Gizmo で配置、Export には含まれません）");
}
