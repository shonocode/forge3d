import type { AbstractMesh, GizmoManager, Scene, ArcRotateCamera, Engine } from "@babylonjs/core";
import type { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Bone } from "@babylonjs/core/Bones/bone";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { PointLight } from "@babylonjs/core/Lights/pointLight";
import type { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { UndoHistory } from "./undo";
import type { EditMesh } from "./tools/edit-mode/half-edge";

export type ToolId = "select" | "move" | "rotate" | "scale" | "sculpt" | "paint" | "bone" | "weight" | "anim";
export type ComponentMode = "vertex" | "edge" | "face";

export interface EditSelection {
  mode: ComponentMode;
  /**
   * Selected component IDs in the active mode:
   *   vertex → vertex index
   *   edge   → canonical half-edge index (min(he, twin))
   *   face   → face index
   */
  indices: Set<number>;
}
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

/**
 * Channel identifier for per-axis tangent storage.
 *
 * The graph editor speaks in these short codes so the data model stays
 * compact and the same key works for both lookup and serialization.
 */
export type AnimChannel = "px" | "py" | "pz" | "rx" | "ry" | "rz";

/**
 * Cubic Bezier handle pair for one channel of one keyframe.
 *
 * Both `in` and `out` are deltas **from the keyframe in graph space**
 * — `[deltaFrame, deltaValue]`. `in` is the incoming handle (points
 * back toward the previous key, so its dx is typically negative);
 * `out` is the outgoing handle (points toward the next key, dx
 * positive).
 *
 * Stored as tuples (not `{x,y}` or `{dx,dy}` objects) to keep
 * serialized clips small — six channels × two tangents × two numbers
 * adds up across long animations.
 */
export interface KeyframeChannelTangent {
  in: [number, number];
  out: [number, number];
}

/**
 * Per-channel tangent map. Optional per channel: a key can have a
 * custom curve on `rx` but linear/easing-driven curves on the rest.
 * `interpolateTrack` falls back to the keyframe's `easing` when a
 * channel has no tangent on either side of a segment.
 */
export interface KeyframeTangents {
  px?: KeyframeChannelTangent;
  py?: KeyframeChannelTangent;
  pz?: KeyframeChannelTangent;
  rx?: KeyframeChannelTangent;
  ry?: KeyframeChannelTangent;
  rz?: KeyframeChannelTangent;
}

export interface KeyframeData {
  frame: number;
  rotation: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
  easing?: import("./tools/easing").EasingType;
  /**
   * Optional per-channel Bezier handles. When set on both surrounding
   * keys of a segment for a given channel, the runtime uses cubic
   * Bezier interpolation for that channel instead of `easing`. Other
   * channels keep their easing-based interpolation.
   *
   * Missing entirely → "linear / easing" mode (V1 behavior preserved
   * for existing clips that pre-date Bezier support).
   */
  tangents?: KeyframeTangents;
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
  /**
   * Bone editing sub-mode (only meaningful while a bone-family tool is active).
   *
   * - `"edit"`: position gizmo on selected bone — for laying out the rest pose.
   *   Drag moves the bone in world space; `syncBoneFromVisual` rebuilds the
   *   local matrix.
   * - `"pose"`: rotation gizmo on selected bone — for keyframable poses.
   *   Drag rotates the bone; `syncBoneRotationFromVisual` bakes the rotation
   *   into the local matrix and propagates to children.
   *
   * Defaults to `"edit"` so first-time skeleton construction behaves as before.
   */
  boneEditMode: "edit" as "edit" | "pose",

  // Animation state
  animClips: [] as AnimClipData[],
  activeClipId: null as string | null,
  currentFrame: 0,
  isPlaying: false,
  animClipCounter: 0,
  importedAnimGroups: [] as AnimationGroup[],
  keyframeClipboard: null as KeyframeData | null,

  // Touch modifier toggles (mobile substitute for Ctrl/Shift)
  touchModifiers: { ctrl: false, shift: false },
  multiSelectMode: false,
  cameraLocked: false,

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

  // Bone display config — controls visual size of bone gizmos and whether
  // they X-ray through meshes. Defaults match Blender's armature convention
  // (size = 1.0 reference, X-ray on).
  boneDisplay: {
    /** Scale multiplier for bone sphere visuals. 1.0 = default world radius
     *  of ~0.06; bump up for large meshes, down for fine detail. */
    size: 1.0,
    /** When true, bones render in a higher layer with depth test disabled so
     *  they're visible even when embedded inside a skinned mesh. */
    xray: true,
  },

  // Edit Mode (component-level editing — see forge3d/EDIT-MODE-DESIGN.md)
  editMesh: null as EditMesh | null,
  editSelection: { mode: "vertex", indices: new Set<number>() } as EditSelection,
  editConfig: {
    /** Per-face inset interpolation toward centroid (0 = no inset, 0.5 = halfway). */
    insetAmount: 0.2,
    /** Bevel split factor along incident edges (0 = no bevel, must stay < 0.5). */
    bevelWidth: 0.15,
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

let _statusTimer: ReturnType<typeof setTimeout> | null = null;
export function status(s: string): void {
  const el = document.getElementById("stxt");
  const bar = el?.parentElement;
  if (!el || !bar) return;
  el.textContent = s;
  bar.classList.remove("stat-err", "stat-ok", "stat-fade");
  if (s.startsWith("⚠")) bar.classList.add("stat-err");
  else if (/exported|saved|loaded|completed/i.test(s)) bar.classList.add("stat-ok");
  if (_statusTimer) clearTimeout(_statusTimer);
  _statusTimer = setTimeout(() => bar.classList.add("stat-fade"), 4000);
}

export function showLoading(msg = "Loading..."): void {
  const el = document.getElementById("loadingOverlay");
  const txt = document.getElementById("loadingText");
  if (el) el.classList.add("active");
  if (txt) txt.textContent = msg;
}
export function hideLoading(): void {
  const el = document.getElementById("loadingOverlay");
  if (el) el.classList.remove("active");
}

export function E(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export function isMobile(): boolean {
  return window.innerWidth <= 900;
}
