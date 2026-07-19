/**
 * .forge3d project container — a portable, single-file save format.
 *
 * The browser-local library (OPFS/IndexedDB) stores plain GLB, which loses
 * everything glTF cannot express: editable procedural graphs, sculpt masks,
 * layer organization. This container bundles the GLB together with a JSON
 * sidecar so a project can be exported to disk, backed up, shared, and
 * reopened elsewhere without loss.
 *
 * Binary layout (all integers little-endian, mirroring GLB's own header
 * style):
 *
 *   bytes 0-3   magic "F3DP"
 *   bytes 4-7   u32 container version (1)
 *   bytes 8-11  u32 sidecar JSON byte length N
 *   bytes 12-(12+N-1)  sidecar JSON, UTF-8
 *   bytes (12+N)-end   GLB payload, verbatim
 *
 * Pure and headless-testable: no DOM, no Babylon.
 */

export const PROJECT_MAGIC = "F3DP";
export const PROJECT_VERSION = 1;
const HEADER_BYTES = 12;

/** Per-mesh sidecar payload, keyed to the GLB by mesh name. */
export interface ProjectMeshEntry {
  /** Mesh name inside the GLB (re-association key on import). */
  name: string;
  /** Serialized procedural graph (graph-io JSON text), if one was applied. */
  proceduralGraph?: string;
  /** Preset id the graph panel had selected, if any. */
  proceduralPreset?: unknown;
  /** Sculpt mask as base64-encoded Float32Array, if painted. */
  sculptMask?: string;
  /** Name of the layer this mesh belongs to. */
  layerName?: string;
}

export interface ProjectSidecar {
  format: "forge3d-project";
  version: number;
  meshes: ProjectMeshEntry[];
  /** `parent` = parent layer's name (collections nest); absent = root. */
  layers: Array<{ name: string; visible: boolean; parent?: string }>;
  activeLayerName?: string;
  /**
   * Bone rest-orientation rolls (radians), keyed by bone name — glTF has no
   * per-joint roll concept, so the sidecar carries it. Only non-zero rolls
   * are stored; absent for pre-F-M6 projects (all rolls 0).
   */
  boneRolls?: Record<string, number>;
  /**
   * Per-bone Limit Rotation / Aim constraints, keyed by bone name — like
   * roll, glTF has no constraint concept. Only bones with at least one
   * constraint are stored; absent for projects that pre-date constraints.
   */
  boneConstraints?: Record<string, ProjectBoneConstraintEntry>;
}

/** One bone's constraint payload inside {@link ProjectSidecar.boneConstraints}. */
export interface ProjectBoneConstraintEntry {
  limitRotation?: import("../tools/bone-constraints").LimitRotationConstraint;
  aim?: import("../tools/bone-constraints").AimConstraint;
}

// ── base64 helpers (chunked to stay under argument limits) ────────────────

/** Encode a Float32Array as base64 (byte-exact, little-endian platform order). */
export function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Decode a base64 string produced by {@link float32ToBase64}. */
export function base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// ── pack / unpack ──────────────────────────────────────────────────────────

/** Bundle sidecar + GLB bytes into a .forge3d container. */
export function packProject(sidecar: ProjectSidecar, glb: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(sidecar));
  const out = new Uint8Array(HEADER_BYTES + json.length + glb.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = PROJECT_MAGIC.charCodeAt(i);
  view.setUint32(4, PROJECT_VERSION, true);
  view.setUint32(8, json.length, true);
  out.set(json, HEADER_BYTES);
  out.set(glb, HEADER_BYTES + json.length);
  return out;
}

/**
 * Split a .forge3d container back into sidecar + GLB bytes.
 * Throws with a human-readable message on any malformed input.
 */
export function unpackProject(data: Uint8Array): { sidecar: ProjectSidecar; glb: Uint8Array } {
  if (data.length < HEADER_BYTES) throw new Error("Not a .forge3d file (too short)");
  let magic = "";
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(data[i]!);
  if (magic !== PROJECT_MAGIC) throw new Error("Not a .forge3d file (bad magic)");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint32(4, true);
  if (version > PROJECT_VERSION) {
    throw new Error(`Unsupported .forge3d version ${version} (this build reads up to ${PROJECT_VERSION})`);
  }
  const jsonLen = view.getUint32(8, true);
  if (HEADER_BYTES + jsonLen > data.length) throw new Error("Corrupt .forge3d file (sidecar length out of range)");

  const jsonBytes = data.subarray(HEADER_BYTES, HEADER_BYTES + jsonLen);
  let sidecar: unknown;
  try {
    sidecar = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    throw new Error("Corrupt .forge3d file (sidecar is not valid JSON)");
  }
  const glb = data.subarray(HEADER_BYTES + jsonLen);
  return { sidecar: validateSidecar(sidecar), glb };
}

/** Structural validation — reject garbage early with a clear error. */
export function validateSidecar(raw: unknown): ProjectSidecar {
  if (typeof raw !== "object" || raw === null) throw new Error("Sidecar: not an object");
  const s = raw as Record<string, unknown>;
  if (s.format !== "forge3d-project") throw new Error("Sidecar: wrong format tag");
  if (typeof s.version !== "number") throw new Error("Sidecar: missing version");
  if (!Array.isArray(s.meshes)) throw new Error("Sidecar: meshes must be an array");
  for (const m of s.meshes) {
    if (typeof m !== "object" || m === null || typeof (m as { name?: unknown }).name !== "string") {
      throw new Error("Sidecar: each mesh entry needs a string name");
    }
  }
  if (!Array.isArray(s.layers)) throw new Error("Sidecar: layers must be an array");
  for (const l of s.layers) {
    const layer = l as { name?: unknown; visible?: unknown };
    if (typeof layer.name !== "string" || typeof layer.visible !== "boolean") {
      throw new Error("Sidecar: each layer needs name + visible");
    }
  }
  if (s.boneRolls !== undefined) {
    if (typeof s.boneRolls !== "object" || s.boneRolls === null || Array.isArray(s.boneRolls)) {
      throw new Error("Sidecar: boneRolls must be an object");
    }
    for (const v of Object.values(s.boneRolls)) {
      if (typeof v !== "number") throw new Error("Sidecar: boneRolls values must be numbers");
    }
  }
  if (s.boneConstraints !== undefined) {
    if (typeof s.boneConstraints !== "object" || s.boneConstraints === null || Array.isArray(s.boneConstraints)) {
      throw new Error("Sidecar: boneConstraints must be an object");
    }
    for (const v of Object.values(s.boneConstraints)) {
      if (typeof v !== "object" || v === null) {
        throw new Error("Sidecar: each boneConstraints entry must be an object");
      }
      const entry = v as { limitRotation?: unknown; aim?: unknown };
      if (entry.limitRotation !== undefined) {
        const lr = entry.limitRotation as { enabled?: unknown };
        if (typeof lr !== "object" || lr === null || typeof lr.enabled !== "boolean") {
          throw new Error("Sidecar: limitRotation needs a boolean enabled");
        }
      }
      if (entry.aim !== undefined) {
        const aim = entry.aim as { enabled?: unknown; targetX?: unknown; targetY?: unknown; targetZ?: unknown };
        if (
          typeof aim !== "object" || aim === null || typeof aim.enabled !== "boolean" ||
          typeof aim.targetX !== "number" || typeof aim.targetY !== "number" || typeof aim.targetZ !== "number"
        ) {
          throw new Error("Sidecar: aim needs enabled + numeric targetX/Y/Z");
        }
      }
    }
  }
  return raw as ProjectSidecar;
}
