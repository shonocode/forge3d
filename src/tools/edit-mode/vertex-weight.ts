/**
 * The three `VERTEX_WEIGHT_*` modifiers — Edit, Mix and Proximity.
 *
 * Three operators behind **one new field**, `MeshData.groups`, which is the
 * shape that has paid for itself three times here already: wire edges opened
 * four operators, the per-corner loop layers six, the custom-normal layer
 * seven. And the curve table was already measured — `falloffWeight` got
 * Blender's seven falloffs off the running binary during the `WARP` work, and
 * its own note already listed "vertex-weight proximity" as a caller.
 *
 * **Their answer is a weight and nothing else.** No vertex moves and no face
 * changes, so distance, area, volume, `facing`, UVs, sharp flags and normals
 * all read a clean match however wrong the weights are. That is why the parity
 * harness had to learn `#weight` lines before a row could say anything, the
 * same way it learned `#crease`, `#sharp` and `vn`.
 *
 * ## The falloff curves are the ones already here
 *
 * `LINEAR`, `SHARP`, `SMOOTH`, `ROOT` and `ICON_SPHERECURVE` reproduce
 * `falloffWeight` exactly — measured again through these modifiers on a ramp
 * of 0, 0.25, 0.5, 0.75, 1:
 *
 * | Blender | here | w(0.25) |
 * |---|---|---|
 * | `LINEAR` | `linear` | 0.25 |
 * | `SHARP` | `sharp` | 0.0625 |
 * | `SMOOTH` | `smooth` | 0.15625 |
 * | `ROOT` | `root` | 0.5 |
 * | `ICON_SPHERECURVE` | `sphere` | 0.661438 |
 * | `STEP` | `step` | 0 (and 1 from 0.5 up) |
 *
 * **`invert_falloff` is `1 - curve(w)`, not `curve(1 - w)`.** Those agree for
 * `linear` and differ everywhere else: `SHARP` inverted reads 0.9375 at 0.25,
 * which is `1 - 0.0625`, where `curve(1 - w)` would give 0.5625.
 *
 * Two of Blender's eight are **not offered**. `CURVE` is a custom curve
 * widget, so there is nothing to reproduce without the curve. `RANDOM` came
 * back identical across two runs in one session, so it is not time-seeded —
 * but it is Blender's RNG stream, and a library cannot claim a number it got
 * from someone else's generator.
 *
 * ## `vertexWeightEdit`
 *
 * ```
 * candidate = falloff(weight, or defaultWeight when the vertex is not a member)
 * result    = lerp(original, candidate, maskConstant)
 * ```
 *
 * then membership moves:
 *
 * * **`add`** puts a non-member in when `candidate >= addThreshold`. Measured
 *   on the boundary: a candidate of 0.3 joins at 0.29 and at 0.30, and not at
 *   0.31.
 * * **`remove`** takes a member out when `weight <= removeThreshold`. Also on
 *   the boundary: 0.4 survives 0.39 and is dropped at 0.40.
 * * `normalize` divides every weight in the group by the largest — measured
 *   against 0.81, which became 1 while 0.04 became 0.049383.
 *
 * **`defaultWeight` does nothing without `add`.** The first probe read it as
 * inert because every vertex in that input was already a member; with
 * non-members present it is the weight they arrive at.
 *
 * ## `vertexWeightMix`
 *
 * Nine modes, all exact on a pair of ramps, and all **clamped to 0..1** —
 * which is how `ADD` and `SUB` were pinned rather than guessed:
 *
 * | mode | a ∘ b |
 * |---|---|
 * | `set` | b |
 * | `add` | a + b |
 * | `sub` | a − b |
 * | `mul` | a · b |
 * | `div` | a / b, and **1 where b is 0** |
 * | `dif` | \|a − b\| |
 * | `avg` | (a + b) / 2 |
 * | `min` | min(a, b) |
 * | `max` | max(a, b) |
 *
 * **`mixSet` decides which vertices are touched at all**, and reading it took
 * a second input: the first had every vertex in group A, so all five values
 * gave one answer. With a vertex in A only, one in both, one in B only and one
 * in neither:
 *
 * | `mixSet` | who is mixed | who ends up in A |
 * |---|---|---|
 * | `all` | everyone | everyone |
 * | `a` | members of A | the members of A |
 * | `b` | members of B | A's members plus B's |
 * | `or` | members of either | the same |
 * | `and` | members of both | the members of A |
 *
 * `defaultWeightA` / `defaultWeightB` are what a non-member counts as, and
 * `maskConstant` is the same lerp as in Edit — **with the clamp after it, not
 * before**. That last word cost a red parity row: without a clamp the two
 * orders are algebraically the same thing, since `lerp(a, a + b, m)` *is*
 * `a + m·b`, so every probe whose sum stayed inside 0..1 agreed with both
 * readings. On a cage where `a + b` goes above 1 they differ — 0.999557
 * against 0.812389 for `a = 0.249557`, `b = 1`, `m = 0.75`. The probes could
 * not have caught it; the row could.
 *
 * ## `vertexWeightProximity`
 *
 * ```
 * t      = (distance - minDist) / (maxDist - minDist), clamped to 0..1
 * result = lerp(original, falloff(t), maskConstant)
 * ```
 *
 * **`minDist` above `maxDist` is not an error, it inverts the ramp** —
 * measured: `min 1, max 0` turns a distance of 0 into a weight of 1.
 *
 * The distance is one of four things, and the four are genuinely different —
 * the case that proved it is a target quad standing at x = 1.5 with its
 * corners at y, z = ±0.5, against a strip along y = z = 0:
 *
 * | `geometry` | distance from x = 0 | what it is |
 * |---|---|---|
 * | `["face"]` | 1.5 | the nearest point on a face |
 * | `["edge"]` | √2.5 ≈ 1.5811 | the nearest point on an edge |
 * | `["vertex"]` | √2.75 ≈ 1.6583 | the nearest target vertex |
 * | `[]` | the vertex's own distance to `origin` | Blender's fallback |
 *
 * Several flags together take the **minimum**, measured: `vertex` and `face`
 * together give the `face` answer.
 *
 * **Blender's `OBJECT` mode is not offered, and that is a measurement rather
 * than an omission.** It reads the distance between the two *objects'
 * origins*, so every vertex of the mesh gets the same weight — a target at
 * `(0.5, 0, 0)` gave all ten vertices 0.5 and one at `(0, 1, 0)` gave all ten
 * 1.0, whatever their own positions. In a library with no object transforms
 * that is one scalar the caller already knows, and `geometry: []` covers the
 * useful half of it by measuring each vertex to a point.
 */
import type { MeshData } from "../../lib/mesh";
import { falloffWeight, type ProportionalFalloff } from "./proportional";
import { closestPointOnTriangleBary } from "./attribute-transfer";

/**
 * Blender's `falloff_type` on the weight modifiers.
 *
 * The first five are `falloffWeight`'s, confirmed through these modifiers.
 * `step` is Blender's `STEP`, which the shared table does not have.
 * `CURVE` and `RANDOM` are not offered — see the note at the top of this file.
 */
export type VertexWeightFalloff = "linear" | "sharp" | "smooth" | "root" | "sphere" | "step";

export type VertexWeightMixMode =
  | "set"
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "dif"
  | "avg"
  | "min"
  | "max";

/** Blender's `mix_set` — which vertices the mix is allowed to touch. */
export type VertexWeightMixSet = "all" | "a" | "b" | "or" | "and";

/** Which of a target's features the distance is measured to. */
export type ProximityGeometry = "vertex" | "edge" | "face";

export interface VertexWeightEditOptions {
  /** The group to edit. It must exist. */
  group: string;
  /**
   * What a vertex that is **not** a member counts as. Default 0, Blender's.
   * Only reaches the mesh when `add` lets that vertex in.
   */
  defaultWeight?: number;
  /** Blender's `falloff_type`. Default `linear`, Blender's. */
  falloff?: VertexWeightFalloff;
  /** `1 - curve(w)`, which is not `curve(1 - w)`. Default false. */
  invertFalloff?: boolean;
  /** Blender's `use_add`: let non-members in. Default false. */
  add?: boolean;
  /** The candidate weight a non-member needs to join. Default 0.01, Blender's. */
  addThreshold?: number;
  /** Blender's `use_remove`: drop members. Default false. */
  remove?: boolean;
  /** At or below this a member is dropped. Default 0.01, Blender's. */
  removeThreshold?: number;
  /** How far from the original toward the result, 0..1. Default 1. */
  maskConstant?: number;
  /** Divide the group by its largest weight afterwards. Default false. */
  normalize?: boolean;
}

export interface VertexWeightMixOptions {
  /** The group that receives the result. It must exist. */
  groupA: string;
  /** The group mixed into it. Optional — without it `defaultWeightB` is all of it. */
  groupB?: string;
  /** What a non-member of A counts as. Default 0. */
  defaultWeightA?: number;
  /** What a non-member of B counts as. Default 0. */
  defaultWeightB?: number;
  /** Blender's `mix_mode`. Default `set`, Blender's. */
  mixMode?: VertexWeightMixMode;
  /** Blender's `mix_set`. Default `and`, Blender's. */
  mixSet?: VertexWeightMixSet;
  /** How far from the original toward the mix, 0..1. Default 1. */
  maskConstant?: number;
  /** Divide the group by its largest weight afterwards. Default false. */
  normalize?: boolean;
}

export interface VertexWeightProximityOptions {
  /** The group to write. It must exist. */
  group: string;
  /** The mesh to measure to. Needed unless `geometry` is empty. */
  target?: MeshData;
  /**
   * Where `geometry: []` measures from — Blender's target object origin.
   * Default the origin.
   */
  origin?: readonly [number, number, number];
  /**
   * Which of the target's features to measure to; several take the minimum.
   * **Empty means the vertex's distance to `origin`**, which is Blender's
   * behaviour with no flag set. Default `["vertex"]`, Blender's.
   */
  geometry?: readonly ProximityGeometry[];
  /** The distance that maps to 0. Default 0. May be above `maxDist`. */
  minDist?: number;
  /** The distance that maps to 1. Default 1. */
  maxDist?: number;
  /** Blender's `falloff_type`. Default `linear`. */
  falloff?: VertexWeightFalloff;
  /** `1 - curve(t)`. Default false. */
  invertFalloff?: boolean;
  /** How far from the original toward the result, 0..1. Default 1. */
  maskConstant?: number;
  /** Divide the group by its largest weight afterwards. Default false. */
  normalize?: boolean;
}

/** Blender's `STEP`, and otherwise the shared table. */
function curve(t: number, falloff: VertexWeightFalloff, invert: boolean): number {
  // Measured finely: 0.4444 gives 0, 0.5556 gives 1, and 0.5 gives 1.
  const w = falloff === "step" ? (t >= 0.5 ? 1 : 0) : falloffWeight(t, falloff as ProportionalFalloff);
  return invert ? 1 - w : w;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function groupOf(data: MeshData, name: string, what: string): Map<number, number> {
  const g = data.groups?.get(name);
  if (!g) throw new Error(`${what}: no vertex group named "${name}"`);
  return g;
}

/** A copy of `data` with `groups` replaced by `next`. */
function withGroups(data: MeshData, next: Map<string, Map<number, number>>): MeshData {
  const out: MeshData = {
    positions: Float32Array.from(data.positions),
    polys: data.polys.map((p) => [...p]),
    groups: next,
  };
  if (data.creases) out.creases = new Map(data.creases);
  if (data.seams) out.seams = new Set(data.seams);
  if (data.sharp && data.sharp.size > 0) out.sharp = new Set(data.sharp);
  if (data.edges) out.edges = data.edges.map((e) => [...e]);
  if (data.uvs) out.uvs = data.uvs.map((f) => f.map((c) => [...c]));
  if (data.colors) out.colors = data.colors.map((f) => f.map((c) => [...c]));
  if (data.normals) out.normals = data.normals.map((f) => f.map((c) => [...c]));
  if (data.materials) out.materials = [...data.materials];
  return out;
}

/** Every group copied, so the result shares nothing with the input. */
function copyGroups(data: MeshData): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const [name, g] of data.groups ?? []) out.set(name, new Map(g));
  return out;
}

/**
 * Divide the group by its largest weight — Blender's `normalize`.
 *
 * Measured against a group whose largest was 0.81: it became 1, and 0.04
 * became 0.049383. An empty group, or one whose largest is 0, is left alone.
 */
function normalizeGroup(g: Map<number, number>): void {
  let max = 0;
  for (const w of g.values()) if (w > max) max = w;
  if (max <= 0) return;
  for (const [v, w] of g) g.set(v, w / max);
}

/**
 * Reshape one group's weights through a falloff curve, and move vertices in
 * and out of it — Blender's **Vertex Weight Edit** modifier.
 *
 * ```ts
 * vertexWeightEdit(mesh, { group: "A", falloff: "sharp" });
 * vertexWeightEdit(mesh, { group: "A", remove: true, removeThreshold: 0.3 });
 * vertexWeightEdit(mesh, { group: "A", add: true, defaultWeight: 0.5 });
 * ```
 */
export function vertexWeightEdit(data: MeshData, options: VertexWeightEditOptions): MeshData {
  const groups = copyGroups(data);
  const g = groupOf({ ...data, groups }, options.group, "vertexWeightEdit");
  const falloff = options.falloff ?? "linear";
  const invert = options.invertFalloff ?? false;
  const mask = options.maskConstant ?? 1;
  const dflt = options.defaultWeight ?? 0;
  const addThreshold = options.addThreshold ?? 0.01;
  const removeThreshold = options.removeThreshold ?? 0.01;
  const count = data.positions.length / 3;

  const next = new Map<number, number>();
  for (let v = 0; v < count; v++) {
    const member = g.has(v);
    const original = member ? g.get(v)! : dflt;
    const candidate = clamp01(curve(clamp01(original), falloff, invert));
    const result = clamp01(lerp(original, candidate, mask));

    if (!member) {
      // A non-member only joins with `add`, and only if its candidate clears
      // the threshold. Measured on the boundary: `>=`, not `>`.
      if (options.add && candidate >= addThreshold) next.set(v, result);
      continue;
    }
    // A member is dropped when its **original** weight is at or below the
    // threshold — also measured on the boundary.
    if (options.remove && original <= removeThreshold) continue;
    next.set(v, result);
  }
  if (options.normalize) normalizeGroup(next);
  groups.set(options.group, next);
  return withGroups(data, groups);
}

function mixed(mode: VertexWeightMixMode, a: number, b: number): number {
  switch (mode) {
    case "set":
      return b;
    case "add":
      return a + b;
    case "sub":
      return a - b;
    case "mul":
      return a * b;
    case "div":
      // Measured: a weight divided by zero comes back as 1, which is what
      // clamping an infinity does. Written out rather than relying on it.
      return b === 0 ? 1 : a / b;
    case "dif":
      return Math.abs(a - b);
    case "avg":
      return (a + b) / 2;
    case "min":
      return Math.min(a, b);
    default:
      return Math.max(a, b);
  }
}

/**
 * Combine two groups into the first — Blender's **Vertex Weight Mix**
 * modifier.
 *
 * ```ts
 * vertexWeightMix(mesh, { groupA: "A", groupB: "B", mixMode: "add", mixSet: "all" });
 * ```
 *
 * `mixSet` is the part worth reading the note for: it decides which vertices
 * are touched at all, and four of its five values leave some of them alone.
 */
export function vertexWeightMix(data: MeshData, options: VertexWeightMixOptions): MeshData {
  const groups = copyGroups(data);
  const a = groupOf({ ...data, groups }, options.groupA, "vertexWeightMix");
  const b = options.groupB === undefined ? null : groupOf({ ...data, groups }, options.groupB, "vertexWeightMix");
  const mode = options.mixMode ?? "set";
  const set = options.mixSet ?? "and";
  const mask = options.maskConstant ?? 1;
  const da = options.defaultWeightA ?? 0;
  const db = options.defaultWeightB ?? 0;
  const count = data.positions.length / 3;

  const next = new Map<number, number>();
  for (let v = 0; v < count; v++) {
    const inA = a.has(v);
    const inB = b !== null && b.has(v);
    const touch =
      set === "all"
        ? true
        : set === "a"
          ? inA
          : set === "b"
            ? inB
            : set === "or"
              ? inA || inB
              : inA && inB;
    if (!touch) {
      // Untouched, and it keeps its membership exactly as it was.
      if (inA) next.set(v, a.get(v)!);
      continue;
    }
    const wa = inA ? a.get(v)! : da;
    const wb = inB ? b!.get(v)! : db;
    // **The clamp comes after the mask, not before it** — and the parity rows
    // found that, not the probes. Without a clamp the two readings are
    // algebraically identical: `lerp(a, a + b, m)` *is* `a + m·b`, so every
    // measurement where the sum stayed inside 0..1 agreed with both. The
    // cages put `a + b` above 1, and there `clamp01(lerp(a, a + b, m))` and
    // `lerp(a, clamp01(a + b), m)` part company — 0.999557 against 0.812389
    // for a = 0.249557, b = 1, m = 0.75.
    next.set(v, clamp01(lerp(wa, mixed(mode, wa, wb), mask)));
  }
  if (options.normalize) normalizeGroup(next);
  groups.set(options.groupA, next);
  return withGroups(data, groups);
}

type Vec3 = [number, number, number];

/** Squared distance from `p` to the closest point on a segment. */
function distance2ToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (len2 > 1e-30)
    t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / len2;
  t = clamp01(t);
  const dx = p[0] - (a[0] + abx * t);
  const dy = p[1] - (a[1] + aby * t);
  const dz = p[2] - (a[2] + abz * t);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Write a weight from how close each vertex is to another mesh — Blender's
 * **Vertex Weight Proximity** modifier.
 *
 * ```ts
 * vertexWeightProximity(mesh, { group: "A", target, geometry: ["face"], maxDist: 2 });
 * vertexWeightProximity(mesh, { group: "A", geometry: [], origin: [0, 1, 0] });
 * ```
 *
 * The four distances are genuinely different and the note at the top of this
 * file has the case that proves it.
 */
export function vertexWeightProximity(
  data: MeshData,
  options: VertexWeightProximityOptions,
): MeshData {
  const groups = copyGroups(data);
  const g = groupOf({ ...data, groups }, options.group, "vertexWeightProximity");
  const geometry = options.geometry ?? (["vertex"] as const);
  const minDist = options.minDist ?? 0;
  const maxDist = options.maxDist ?? 1;
  const falloff = options.falloff ?? "linear";
  const invert = options.invertFalloff ?? false;
  const mask = options.maskConstant ?? 1;
  const origin: Vec3 = [...(options.origin ?? [0, 0, 0])] as Vec3;

  if (geometry.length > 0 && !options.target)
    throw new Error(
      "vertexWeightProximity: geometry was asked for but no target mesh was given " +
        "(pass `geometry: []` to measure to `origin` instead)",
    );

  // The target's features, prepared once.
  const T = options.target;
  const tris: number[] = [];
  const segments: [number, number][] = [];
  if (T && geometry.includes("face"))
    for (const poly of T.polys)
      for (let i = 1; i + 1 < poly.length; i++) tris.push(poly[0]!, poly[i]!, poly[i + 1]!);
  if (T && geometry.includes("edge"))
    for (const poly of T.polys)
      for (let i = 0; i < poly.length; i++)
        segments.push([poly[i]!, poly[(i + 1) % poly.length]!]);

  const at = (P: Float32Array, v: number): Vec3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  const count = data.positions.length / 3;
  const span = maxDist - minDist;

  const next = new Map<number, number>();
  for (const [v, original] of g) {
    if (v >= count) continue;
    const p = at(data.positions, v);

    let best = Infinity;
    if (geometry.length === 0) {
      // Blender's fallback with no geometry flag: each vertex to the target's
      // origin. Measured — the strip's own x coordinates came straight back.
      best = Math.hypot(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
    } else {
      let best2 = Infinity;
      if (geometry.includes("vertex"))
        for (let w = 0; w * 3 < T!.positions.length; w++) {
          const q = at(T!.positions, w);
          const d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
          if (d2 < best2) best2 = d2;
        }
      for (const [a, b] of segments) {
        const d2 = distance2ToSegment(p, at(T!.positions, a), at(T!.positions, b));
        if (d2 < best2) best2 = d2;
      }
      for (let f = 0; f * 3 < tris.length; f++) {
        const a = tris[f * 3]!;
        const b = tris[f * 3 + 1]!;
        const c = tris[f * 3 + 2]!;
        const r = closestPointOnTriangleBary(
          p[0], p[1], p[2],
          T!.positions[a * 3]!, T!.positions[a * 3 + 1]!, T!.positions[a * 3 + 2]!,
          T!.positions[b * 3]!, T!.positions[b * 3 + 1]!, T!.positions[b * 3 + 2]!,
          T!.positions[c * 3]!, T!.positions[c * 3 + 1]!, T!.positions[c * 3 + 2]!,
        );
        if (r.dist2 < best2) best2 = r.dist2;
      }
      best = Math.sqrt(best2);
    }

    // `minDist` above `maxDist` inverts the ramp rather than erroring —
    // measured: min 1, max 0 turns a distance of 0 into a weight of 1.
    const t = span === 0 ? (best >= maxDist ? 1 : 0) : clamp01((best - minDist) / span);
    const candidate = clamp01(curve(t, falloff, invert));
    next.set(v, clamp01(lerp(original, candidate, mask)));
  }
  if (options.normalize) normalizeGroup(next);
  groups.set(options.group, next);
  return withGroups(data, groups);
}
