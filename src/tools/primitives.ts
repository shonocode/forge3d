import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Vector4 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status } from "../state";
import { selectMesh, updateGizmo } from "./selection";
import { updateHierarchy } from "../ui/panels";
import { applyDefaultEdges } from "./mesh-utils";
import { createDefaultPBR } from "../materials/pbr-helpers";
import { assignToActiveLayer } from "./layers";
import { addShadowCaster, removeShadowCaster } from "../viewport/shadows";
import { registerMeshForShading } from "../viewport/shading";

export const PALETTE = [
  "#5b7fff", "#4ce0a0", "#ff5c5c", "#ffc855", "#ff8f44",
  "#b07cff", "#44d9e0", "#ff6eb4", "#8a9bb0", "#c4c4d8",
  "#3a3a52", "#1a1a28",
];

export const PRIMS = [
  { id: "box", icon: "▣", label: "Box" },
  { id: "sphere", icon: "●", label: "Sphere" },
  { id: "cylinder", icon: "⬭", label: "Cylinder" },
  { id: "cone", icon: "▲", label: "Cone" },
  { id: "torus", icon: "◎", label: "Torus" },
  { id: "plane", icon: "▬", label: "Plane" },
  { id: "torusKnot", icon: "∞", label: "Knot" },
  { id: "icosphere", icon: "⬡", label: "Ico" },
] as const;

export type PrimType = (typeof PRIMS)[number]["id"];

// Per-face UV regions so painting affects only the clicked face
const BOX_FACE_UV = [
  new Vector4(0, 0, 1/3, 1/2), new Vector4(1/3, 0, 2/3, 1/2), new Vector4(2/3, 0, 1, 1/2),
  new Vector4(0, 1/2, 1/3, 1), new Vector4(1/3, 1/2, 2/3, 1), new Vector4(2/3, 1/2, 1, 1),
];
const CYL_FACE_UV = [
  new Vector4(0, 0, 1, 2/3),     // side
  new Vector4(0, 2/3, 1/2, 1),   // top cap
  new Vector4(1/2, 2/3, 1, 1),   // bottom cap
];

function mkMat(hex?: string): import("@babylonjs/core/Materials/PBR/pbrMaterial").PBRMaterial {
  const color = hex ?? PALETTE[state.colorIndex++ % PALETTE.length]!;
  return createDefaultPBR("m_" + state.meshCounter, color);
}

export function addPrimitive(type: PrimType): AbstractMesh | null {
  const { scene } = state;
  state.meshCounter++;
  const nm = type + "_" + state.meshCounter;
  const S = 48;
  let m: AbstractMesh | undefined;

  try {
    switch (type) {
      case "box": m = MeshBuilder.CreateBox(nm, { size: 2, updatable: true, faceUV: BOX_FACE_UV }, scene); break;
      case "sphere": m = MeshBuilder.CreateSphere(nm, { diameter: 2, segments: S, updatable: true }, scene); break;
      case "cylinder": m = MeshBuilder.CreateCylinder(nm, { height: 2, diameter: 1.5, tessellation: S, updatable: true, faceUV: CYL_FACE_UV }, scene); break;
      case "cone": m = MeshBuilder.CreateCylinder(nm, { height: 2, diameterTop: 0, diameterBottom: 1.5, tessellation: S, updatable: true, faceUV: CYL_FACE_UV }, scene); break;
      case "torus": m = MeshBuilder.CreateTorus(nm, { diameter: 2, thickness: 0.5, tessellation: S, updatable: true }, scene); break;
      case "plane": m = MeshBuilder.CreateGround(nm, { width: 2, height: 2, subdivisions: 20, updatable: true }, scene); break;
      case "torusKnot": m = MeshBuilder.CreateTorusKnot(nm, { radius: 0.8, tube: 0.25, radialSegments: 80, tubularSegments: 20, updatable: true }, scene); break;
      case "icosphere": m = MeshBuilder.CreateIcoSphere(nm, { radius: 1, subdivisions: 5, updatable: true }, scene); break;
    }
  } catch (e) {
    console.warn("Primitive creation error:", e);
    status("⚠ 作成エラー");
    return null;
  }

  if (!m) return null;

  m.position.y = 1;
  m.material = mkMat();
  m.isPickable = true;
  applyDefaultEdges(m);

  // Ensure normals
  try {
    if (!m.getVerticesData(VertexBuffer.NormalKind)) {
      const pos = m.getVerticesData(VertexBuffer.PositionKind);
      const idx = m.getIndices();
      if (pos && idx) {
        const nor = new Float32Array(pos.length);
        VertexData.ComputeNormals(pos, idx, nor);
        m.setVerticesData(VertexBuffer.NormalKind, nor, true);
      }
    }
  } catch (e) { console.warn("Normal computation:", e); }

  addShadowCaster(m);
  registerMeshForShading(m);
  assignToActiveLayer(m);
  state.allMeshes.push(m);
  selectMesh(m, false);
  updateHierarchy();

  // Undo: remove mesh; Redo: re-add
  const mesh = m;
  state.history.push({
    label: "Add " + type,
    undo() {
      mesh.setEnabled(false);
      removeShadowCaster(mesh);
      const idx = state.allMeshes.indexOf(mesh);
      if (idx >= 0) state.allMeshes.splice(idx, 1);
      state.selectedMeshes = state.selectedMeshes.filter((x) => x !== mesh);
      updateGizmo();
      updateHierarchy();
    },
    redo() {
      mesh.setEnabled(true);
      addShadowCaster(mesh);
      state.allMeshes.push(mesh);
      selectMesh(mesh, false);
      updateHierarchy();
    },
  });

  status(type + " を追加");
  return m;
}
