import type { AbstractMesh, GizmoManager, Scene, ArcRotateCamera, Engine } from "@babylonjs/core";
import type { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Bone } from "@babylonjs/core/Bones/bone";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";

export type ToolId = "select" | "move" | "rotate" | "scale" | "sculpt" | "paint" | "bone" | "weight" | "anim";
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

  // Touch modifier toggles (mobile substitute for Ctrl/Shift)
  touchModifiers: { ctrl: false, shift: false },
  multiSelectMode: false,

  // Map editor state
  mapInstances: [] as MapInstance[],

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
