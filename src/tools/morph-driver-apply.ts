import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { state } from "../state";
import { getActiveSkeleton } from "./skeleton-tool";
import { channelValue, evalDriver } from "./morph-driver";

/**
 * Runtime for shape key drivers (F-M5): every frame — after IK and bone
 * constraints have settled the pose — read each driver's bone channel from
 * the live local matrix and write the mapped influence onto the morph
 * target. Driven targets therefore override slider values and morph-track
 * keys while a driver is enabled (Blender semantics: a driven value is not
 * directly animatable).
 *
 * Hooked from `installIkRenderHook` in animation-tool.ts.
 */

const _scale = new Vector3();
const _quat = new Quaternion();
const _pos = new Vector3();
const _euler = new Vector3();

export function applyMorphDrivers(): void {
  const drivers = state.morphDrivers;
  if (drivers.length === 0) return;
  const skel = getActiveSkeleton();
  if (!skel) return;

  for (const d of drivers) {
    if (!d.enabled) continue;
    const bd = skel.bones.find((b) => b.name === d.boneName);
    if (!bd) continue;
    const morph = state.morphMap.get(d.meshUniqueId);
    const target = morph?.targets[d.targetIndex];
    if (!target) continue;

    bd.bone.getLocalMatrix().decompose(_scale, _quat, _pos);
    _quat.toEulerAnglesToRef(_euler);
    const input = channelValue(
      { rotation: { x: _euler.x, y: _euler.y, z: _euler.z }, position: { x: _pos.x, y: _pos.y, z: _pos.z } },
      d.channel,
    );
    target.influence = evalDriver(input, d.inMin, d.inMax);
  }
}

/** Drop drivers whose mesh no longer exists (mesh deletion cleanup). */
export function cleanupMorphDriversForMesh(meshUniqueId: number): void {
  state.morphDrivers = state.morphDrivers.filter((d) => d.meshUniqueId !== meshUniqueId);
}
