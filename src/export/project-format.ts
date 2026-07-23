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
  /**
   * Paint layer stack (F-M11): every layer's pixels as a PNG data URL plus
   * its blend metadata, bottom-up (index 0 = Base). Restoring rebuilds the
   * stack + the composited albedo texture, so layered paintings survive
   * .forge3d round-trips (plain GLB / autosave only keep the composite).
   */
  paintLayers?: {
    active: number;
    layers: Array<{
      name: string;
      visible: boolean;
      opacity: number;
      blend: string;
      isBase: boolean;
      png: string;
    }>;
  };
  /** Roughness / metalness channel-paint canvases (PNG data URLs) + bases. */
  paintChannels?: {
    baseRough: number;
    baseMetal: number;
    roughPng: string;
    metalPng: string;
  };
  /**
   * Edit Mode polygon structure (half-edge V2): quad / n-gon faces as CCW
   * vertex-index cycles. GLB is triangle-only, so without this the quad flow
   * is lost on reopen. Validated against the imported index buffer on the next
   * Edit Mode entry (stale copy discarded). Absent for tri-only meshes.
   */
  editPolys?: number[][];
  /** UV seam edge keys ("min_max" vertex pairs) — see Mark Seam. */
  editSeams?: string[];
  /** Catmull-Clark creases as [edgeKey, sharpness] pairs — see Mark Crease. */
  editCreases?: Array<[string, number]>;
  /** UV Editor pin vertex indices — held fixed by ⚓ Re-unwrap (LSCM). */
  editUVPins?: number[];
  /**
   * Modifier stack (.forge3d v2): the GLB only holds the EVALUATED mesh, so
   * without this the stack collapses into baked geometry on reopen. `original`
   * is the pre-modifier base geometry (positions/normals base64 Float32 +
   * triangle indices); `stack` is the modifier definitions in evaluation
   * order. On restore the evaluated GLB geometry is kept as-is (identical to
   * re-evaluating) and the stack becomes editable again.
   */
  modifiers?: {
    original: { positions: string; normals: string | null; indices: number[] };
    stack: Array<Record<string, unknown>>;
  };
}

/**
 * Validate one serialized modifier into a typed {@link Modifier} — returns
 * null on anything malformed (drop-don't-throw, like morph drivers). Numeric
 * params are clamped to the UI's ranges so a hand-edited file can't smuggle a
 * memory bomb (subdivision level ≤ 2 quadruples tris per level; array ≤ 10).
 */
export function validateModifierEntry(raw: unknown): import("../state").Modifier | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.enabled !== "boolean") return null;
  const id = typeof m.id === "string" ? m.id : "";
  switch (m.type) {
    case "subdivision": {
      if (typeof m.level !== "number" || !Number.isFinite(m.level)) return null;
      const level = Math.min(2, Math.max(1, Math.round(m.level)));
      return { id, type: "subdivision", enabled: m.enabled, level };
    }
    case "mirror": {
      if (m.axis !== "x" && m.axis !== "y" && m.axis !== "z") return null;
      if (typeof m.merge !== "boolean" || typeof m.mergeTolerance !== "number" || !Number.isFinite(m.mergeTolerance)) return null;
      return { id, type: "mirror", enabled: m.enabled, axis: m.axis, merge: m.merge, mergeTolerance: Math.abs(m.mergeTolerance) };
    }
    case "array": {
      if (typeof m.count !== "number" || !Number.isFinite(m.count)) return null;
      if (typeof m.offsetX !== "number" || typeof m.offsetY !== "number" || typeof m.offsetZ !== "number") return null;
      const count = Math.min(10, Math.max(2, Math.round(m.count)));
      return { id, type: "array", enabled: m.enabled, count, offsetX: m.offsetX, offsetY: m.offsetY, offsetZ: m.offsetZ };
    }
    default:
      return null;
  }
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
  /**
   * Shape key drivers (bone channel → morph influence). Meshes and bones
   * are referenced by NAME (uniqueIds are session-scoped); entries are
   * validated by `validateMorphDrivers` on load, so malformed items are
   * dropped rather than failing the whole project. Absent pre-F-M5-drivers.
   */
  morphDrivers?: import("../tools/morph-driver").MorphDriverSidecarEntry[];
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
  for (const m of s.meshes as Array<Record<string, unknown>>) {
    if (typeof m !== "object" || m === null) continue;
    if (m.paintLayers !== undefined) {
      const pl = m.paintLayers as { layers?: unknown; active?: unknown };
      if (typeof pl !== "object" || pl === null || !Array.isArray(pl.layers) || typeof pl.active !== "number") {
        throw new Error("Sidecar: paintLayers needs a layers array + numeric active");
      }
    }
    if (m.paintChannels !== undefined) {
      const pc = m.paintChannels as { roughPng?: unknown; metalPng?: unknown };
      if (typeof pc !== "object" || pc === null || typeof pc.roughPng !== "string" || typeof pc.metalPng !== "string") {
        throw new Error("Sidecar: paintChannels needs roughPng + metalPng strings");
      }
    }
    if (m.editPolys !== undefined) {
      if (!Array.isArray(m.editPolys)) throw new Error("Sidecar: editPolys must be an array");
      for (const poly of m.editPolys) {
        if (!Array.isArray(poly) || poly.length < 3 || !poly.every((v) => Number.isInteger(v))) {
          throw new Error("Sidecar: each editPolys entry must be an int array of length ≥3");
        }
      }
    }
    if (m.editSeams !== undefined) {
      if (!Array.isArray(m.editSeams) || !m.editSeams.every((k) => typeof k === "string")) {
        throw new Error("Sidecar: editSeams must be a string array");
      }
    }
    if (m.editCreases !== undefined) {
      if (!Array.isArray(m.editCreases)) throw new Error("Sidecar: editCreases must be an array");
      for (const pair of m.editCreases) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "number") {
          throw new Error("Sidecar: each editCreases entry must be [string, number]");
        }
      }
    }
    if (m.editUVPins !== undefined) {
      if (!Array.isArray(m.editUVPins) || !m.editUVPins.every((v) => Number.isInteger(v) && (v as number) >= 0)) {
        throw new Error("Sidecar: editUVPins must be an array of non-negative ints");
      }
    }
    if (m.modifiers !== undefined) {
      // Container shape only — per-entry validation (drop-don't-throw) happens
      // in validateModifierEntry at restore time.
      const mo = m.modifiers as { original?: unknown; stack?: unknown };
      if (typeof mo !== "object" || mo === null) throw new Error("Sidecar: modifiers must be an object");
      const orig = mo.original as { positions?: unknown; normals?: unknown; indices?: unknown } | undefined;
      if (
        typeof orig !== "object" || orig === null ||
        typeof orig.positions !== "string" ||
        (orig.normals !== null && typeof orig.normals !== "string") ||
        !Array.isArray(orig.indices) || !orig.indices.every((v) => Number.isInteger(v) && (v as number) >= 0)
      ) {
        throw new Error("Sidecar: modifiers.original needs base64 positions, normals|null, int indices");
      }
      if (!Array.isArray(mo.stack)) throw new Error("Sidecar: modifiers.stack must be an array");
    }
  }
  if (s.morphDrivers !== undefined) {
    // Per-entry validation (with drop-don't-throw semantics) happens in
    // validateMorphDrivers at restore time; here only the container shape.
    if (!Array.isArray(s.morphDrivers)) throw new Error("Sidecar: morphDrivers must be an array");
  }
  return raw as ProjectSidecar;
}
