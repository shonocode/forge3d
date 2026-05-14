import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { GizmoManager } from "@babylonjs/core/Gizmos/gizmoManager";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { state, status, isMobile } from "../state";
import { initEnvironment } from "./environment";
import { initShadows } from "./shadows";

export function initViewport(): void {
  const canvas = document.getElementById("rc") as HTMLCanvasElement;
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
    adaptToDeviceRatio: true,
  });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.03, 0.03, 0.05, 1);

  // Camera
  const cam = new ArcRotateCamera("c", -Math.PI / 4, Math.PI / 3, 14, Vector3.Zero(), scene);
  cam.attachControl(canvas, true);
  cam.wheelPrecision = 18;
  cam.minZ = 0.05;
  cam.lowerRadiusLimit = 0.5;
  cam.upperRadiusLimit = 120;
  cam.panningSensibility = 80;
  cam.pinchPrecision = 40;
  // Enable two-finger pan+zoom
  const pointersInput = cam.inputs.attached.pointers;
  if (pointersInput && "multiTouchPanAndZoom" in pointersInput) {
    (pointersInput as Record<string, unknown>).multiTouchPanAndZoom = true;
  }

  // Lights
  const hemi = new HemisphericLight("h", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.55;
  hemi.diffuse = new Color3(0.92, 0.92, 1);
  hemi.groundColor = new Color3(0.12, 0.12, 0.18);

  const dirL = new DirectionalLight("d", new Vector3(-1, -2.5, 1.5), scene);
  dirL.intensity = 0.45;

  const rimL = new DirectionalLight("r", new Vector3(1, 0.5, -1), scene);
  rimL.intensity = 0.12;
  rimL.diffuse = new Color3(0.7, 0.75, 1);

  // Grid
  makeGrid(scene);

  // Gizmo
  const gizMgr = new GizmoManager(scene, isMobile() ? 3 : 1);
  gizMgr.positionGizmoEnabled = false;
  gizMgr.rotationGizmoEnabled = false;
  gizMgr.scaleGizmoEnabled = false;
  gizMgr.usePointerToAttachGizmos = false;

  // WebGL context loss recovery
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    status("⚠ WebGL lost — restoring...");
  });
  canvas.addEventListener("webglcontextrestored", () => {
    // Re-compile all materials and effects after context restore
    engine.resize();
    for (const mat of scene.materials) {
      mat.markDirty();
    }
    scene.markAllMaterialsAsDirty(0x3F); // ALL flags
    // Re-attach camera controls
    cam.attachControl(canvas, true);
    status("WebGL restored");
  });

  // Store in state
  state.scene = scene;
  state.engine = engine;
  state.camera = cam;
  state.canvas = canvas;
  state.gizmoManager = gizMgr;

  // HDRI environment for PBR
  initEnvironment();

  // Shadows
  initShadows(dirL);

  // Shadow-receiving ground plane
  const ground = MeshBuilder.CreateGround("shadowGround", { width: 50, height: 50 }, scene);
  const gMat = new PBRMaterial("groundMat", scene);
  gMat.albedoColor = new Color3(0.08, 0.08, 0.12);
  gMat.metallic = 0;
  gMat.roughness = 1;
  ground.material = gMat;
  ground.receiveShadows = true;
  ground.isPickable = false;
}

function makeGrid(scene: Scene): void {
  const lines: Vector3[][] = [];
  const colors: Color4[][] = [];
  const S = 25;
  for (let i = -S; i <= S; i++) {
    lines.push([new Vector3(i, 0, -S), new Vector3(i, 0, S)]);
    lines.push([new Vector3(-S, 0, i), new Vector3(S, 0, i)]);
    const isMajor = i % 5 === 0;
    const col = isMajor
      ? new Color4(0.18, 0.18, 0.26, 1)
      : new Color4(0.1, 0.1, 0.16, 0.6);
    colors.push([col, col]);
    colors.push([col, col]);
  }
  const grid = MeshBuilder.CreateLineSystem("grid", { lines, colors }, scene);
  grid.isPickable = false;
}
