import type { AbstractMesh, GizmoManager, Scene, ArcRotateCamera, Engine } from "@babylonjs/core";
import type { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Bone } from "@babylonjs/core/Bones/bone";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { PointLight } from "@babylonjs/core/Lights/pointLight";
import type { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { UndoHistory } from "./undo";

export type ToolId = "select" | "move" | "rotate" | "scale" | "sculpt" | "paint" | "bone" | "weight" | "anim";
export type ViewportMode = "solid" | "wire" | "matcap" | "textured";
export type AnimLoopMode = "cycle" | "constant";
export type WeightMode = "add" | "subtract" | "smooth";
export type BrushId = "push" | "pull" | "smooth" | "flatten" | "pinch" | "inflate";

export interface SculptConfig {
  radius: number;
  strength: number;
  falloff: number;
  brush: BrushId;
}

export interface PaintConfig {
  color: string;   // hex color
  size: number;     // brush radius in px (on 1024 texture)
  opacity: number;  // 0-1
  eraser: boolean;
}

export interface WeightPaintConfig {
  radius: number;    // world-space brush radius
  strength: number;  // paint strength per stroke
  falloff: number;   // falloff exponent
  mode: WeightMode;
}

export interface MorphData {
  manager: import("@babylonjs/core").MorphTargetManager;
  targets: import("@babylonjs/core").MorphTarget[];
}

export interface BoneData {
  id: string;
  name: string;
  bone: Bone;
  parentId: string | null;
  visual: AbstractMesh | null;
  ikConstraint?: IKConstraint;
}

export interface SkeletonData {
  skeleton: Skeleton;
  bones: BoneData[];
  assignedMesh: AbstractMesh | null;
  hierarchyLines: AbstractMesh | null;
}

export interface KeyframeData {
  frame: number;
  rotation: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
  easing?: import("./tools/easing").EasingType;
}

export interface IKConstraint {
  enabled: boolean;
  chainLength: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

export interface BoneTrack {
  boneId: string;
  boneName: string;
  keyframes: KeyframeData[];
}

export interface AnimClipData {
  id: string;
  name: string;
  frameRate: number;
  maxFrames: number;
  loopMode: AnimLoopMode;
  tracks: BoneTrack[];
}

export interface MapInstance {
  instanceId: string;
  modelId: string;
  modelName: string;
  meshUniqueIds: number[];
}

// ── Modifier Stack ──
export type ModifierType = "subdivision" | "mirror" | "array";

export interface OriginalGeometry {
  positions: Float32Array;
  normals: Float32Array | null;
  indices: number[];
}

export interface BaseModifier {
  id: string;
  type: ModifierType;
  enabled: boolean;
}

export interface SubdivisionModifier extends BaseModifier {
  type: "subdivision";
  level: number;  // 1 or 2
}

export interface MirrorModifier extends BaseModifier {
  type: "mirror";
  axis: "x" | "y" | "z";
  merge: boolean;
  mergeTolerance: number;
}

export interface ArrayModifier extends BaseModifier {
  type: "array";
  count: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

export type Modifier = SubdivisionModifier | MirrorModifier | ArrayModifier;

// ── Snap Config ──
export interface SnapConfig {
  positionEnabled: boolean;
  positionIncrement: number;
  rotationEnabled: boolean;
  rotationIncrement: number;
  scaleEnabled: boolean;
  scaleIncrement: number;
}

// ── Light System ──
export type LightType = "point" | "spot";
export interface LightData {
  id: string;
  type: LightType;
  light: PointLight | SpotLight;
  visual: AbstractMesh;
  color: string;
  intensity: number;
  range: number;
  angle?: number;
}

// ── Measurement ──
export interface MeasurementData {
  id: string;
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  distance: number;
  lineMesh: AbstractMesh;
  labelDiv: HTMLDivElement;
  startMarker: AbstractMesh;
  endMarker: AbstractMesh;
}

// ── Layer System ──
export interface LayerData {
  id: string;
  name: string;
  visible: boolean;
}

/** Global editor state — single source of truth */
export const state = {
  tool: "select" as ToolId,
  selectedMeshes: [] as AbstractMesh[],
  allMeshes: [] as AbstractMesh[],
  meshCounter: 0,
  colorIndex: 0,
  sculpting: false,
  painting: false,
  keysDown: new Set<string>(),
  morphMap: new Map<number, MorphData>(),
  sculptConfig: { radius: 0.5, strength: 0.05, falloff: 2, brush: "push" } as SculptConfig,
  paintConfig: { color: "#ff0000", size: 20, opacity: 1, eraser: false } as PaintConfig,
  paintTextureMap: new Map<number, DynamicTexture>(),

  // Weight paint state
  weightPainting: false,
  weightOverlayActive: false,
  weightConfig: { radius: 0.5, strength: 0.3, falloff: 2, mode: "add" } as WeightPaintConfig,

  // Skeleton/Bone state
  skeletonMap: new Map<string, SkeletonData>(),
  activeSkeletonId: null as string | null,
  selectedBoneId: null as string | null,
  boneCounter: 0,
  skeletonCounter: 0,

  // Animation state
  animClips: [] as AnimClipData[],
  activeClipId: null as string | null,
  currentFrame: 0,
  isPlaying: false,
  animPreviewGroup: null as AnimationGroup | null,
  animClipCounter: 0,
  importedAnimGroups: [] as AnimationGroup[],
  keyframeClipboard: null as KeyframeData | null,

  // Touch modifier toggles (mobile substitute for Ctrl/Shift)
  touchModifiers: { ctrl: false, shift: false },
  multiSelectMode: false,

  // Modifier stack
  modifierMap: new Map<number, Modifier[]>(),
  originalGeometryMap: new Map<number, OriginalGeometry>(),
  modifierCounter: 0,

  // Layer system
  layers: [{ id: "layer_1", name: "Layer 1", visible: true }] as LayerData[],
  activeLayerId: "layer_1" as string,
  meshLayerMap: new Map<number, string>(),
  layerCounter: 1,

  // Dynamic lights
  lightMap: new Map<string, LightData>(),
  selectedLightId: null as string | null,
  lightCounter: 0,

  // Measurement
  measurements: [] as MeasurementData[],
  measuringActive: false,
  measureStartPoint: null as import("@babylonjs/core/Maths/math.vector").Vector3 | null,
  measureCounter: 0,

  // Map editor state
  mapInstances: [] as MapInstance[],

  // Environment/Scene state
  activeEnvPresetId: "studio" as string,
  envIntensity: 0.8,
  showSkybox: false,
  shadowsEnabled: true,
  shadowQuality: 1024 as 512 | 1024 | 2048,
  viewportMode: "textured" as ViewportMode,
  isOrthographic: false,
  snapConfig: {
    positionEnabled: false, positionIncrement: 0.5,
    rotationEnabled: false, rotationIncrement: 15,
    scaleEnabled: false, scaleIncrement: 0.25,
  } as SnapConfig,

  // Post-processing
  postProcess: {
    bloomEnabled: false,
    bloomIntensity: 0.5,
    fxaaEnabled: true,
    chromaticEnabled: false,
    chromaticIntensity: 0.5,
    vignetteEnabled: false,
    vignetteWeight: 1.5,
    ssaoEnabled: false,
    ssaoIntensity: 1.0,
  },

  // Undo/Redo
  history: new UndoHistory(),

  // Set during init
  scene: null as unknown as Scene,
  engine: null as unknown as Engine,
  camera: null as unknown as ArcRotateCamera,
  canvas: null as unknown as HTMLCanvasElement,
  gizmoManager: null as unknown as GizmoManager,
};

export function status(s: string): void {
  const el = document.getElementById("stxt");
  if (el) el.textContent = s;
}

export function E(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export function isMobile(): boolean {
  return window.innerWidth <= 900;
}
