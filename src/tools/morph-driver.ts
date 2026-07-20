/**
 * Shape key drivers (F-M5) — pure math + validation, headless.
 *
 * A driver binds one morph target's influence to a bone pose channel
 * (Blender's "driver on a shape key value"): as the bone bends, the morph
 * fades in — the standard tool for corrective shapes (elbow bulge, cheek
 * squash) and automated facial rigging.
 *
 * `influence = clamp01((input − inMin) / (inMax − inMin))`
 *
 * `inMin > inMax` is legal and reverses the mapping (value fades OUT as the
 * channel grows). Runtime application (reading live bone matrices, writing
 * `MorphTarget.influence`) lives in `morph-driver-apply.ts`; sidecar
 * persistence resolves meshes/bones by NAME so drivers survive save/load.
 */

import type { AnimChannel } from "../state";

export interface MorphDriver {
  enabled: boolean;
  /** Live mesh id (session-scoped; sidecar round-trips via meshName). */
  meshUniqueId: number;
  targetIndex: number;
  /** Bone resolved by name at apply time (stable across sessions). */
  boneName: string;
  channel: AnimChannel;
  /** Channel value mapped to influence 0. */
  inMin: number;
  /** Channel value mapped to influence 1. */
  inMax: number;
}

/** Map a channel value into [0, 1] influence. `inMin === inMax` → 0. */
export function evalDriver(input: number, inMin: number, inMax: number): number {
  const span = inMax - inMin;
  if (span === 0) return 0;
  const t = (input - inMin) / span;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Pick one pose channel out of a decomposed local pose. */
export function channelValue(
  pose: { rotation: { x: number; y: number; z: number }; position: { x: number; y: number; z: number } },
  channel: AnimChannel,
): number {
  switch (channel) {
    case "px": return pose.position.x;
    case "py": return pose.position.y;
    case "pz": return pose.position.z;
    case "rx": return pose.rotation.x;
    case "ry": return pose.rotation.y;
    case "rz": return pose.rotation.z;
  }
}

const CHANNELS: readonly AnimChannel[] = ["px", "py", "pz", "rx", "ry", "rz"];

/** Sidecar entry — mesh referenced by name (uniqueIds change per session). */
export interface MorphDriverSidecarEntry {
  enabled: boolean;
  meshName: string;
  targetIndex: number;
  boneName: string;
  channel: AnimChannel;
  inMin: number;
  inMax: number;
}

/**
 * Validate a raw sidecar payload into well-formed entries. Malformed items
 * are dropped (a stale hand-edited file must not brick project load).
 */
export function validateMorphDrivers(raw: unknown): MorphDriverSidecarEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MorphDriverSidecarEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.meshName !== "string" || e.meshName.length === 0) continue;
    if (typeof e.boneName !== "string" || e.boneName.length === 0) continue;
    if (typeof e.targetIndex !== "number" || !Number.isInteger(e.targetIndex) || e.targetIndex < 0) continue;
    if (typeof e.channel !== "string" || !CHANNELS.includes(e.channel as AnimChannel)) continue;
    if (typeof e.inMin !== "number" || !Number.isFinite(e.inMin)) continue;
    if (typeof e.inMax !== "number" || !Number.isFinite(e.inMax)) continue;
    out.push({
      enabled: e.enabled !== false,
      meshName: e.meshName,
      targetIndex: e.targetIndex,
      boneName: e.boneName,
      channel: e.channel as AnimChannel,
      inMin: e.inMin,
      inMax: e.inMax,
    });
  }
  return out;
}

/** Find a driver for (mesh, target) in a list, or null. */
export function findDriver(
  drivers: readonly MorphDriver[],
  meshUniqueId: number,
  targetIndex: number,
): MorphDriver | null {
  return drivers.find((d) => d.meshUniqueId === meshUniqueId && d.targetIndex === targetIndex) ?? null;
}
