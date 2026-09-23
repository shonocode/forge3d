/**
 * Blender's two normal modifiers — `WEIGHTED_NORMAL` and `NORMAL_EDIT`.
 *
 * The last two items behind `MeshData.normals`, and the only ones that needed
 * no new field: the layer went in with the five `bpy.ops.mesh.*_normals`
 * operators, and these two write the same thing.
 *
 * ## `weightedNormal`
 *
 * Measured on the irregular fan — a cube cannot tell the modes apart (equal
 * areas, equal angles), the fan separates them by two orders of magnitude:
 *
 * | mode | the apex normal |
 * |---|---|
 * | `area` (`FACE_AREA`) | `(0.0000, -1.0000, 0.0000)` |
 * | `angle` (`CORNER_ANGLE`) | `(0.0267, -0.9928, -0.1165)` |
 * | `areaAngle` (`FACE_AREA_WITH_ANGLE`) | `(0.0046, -0.9985, 0.0549)` |
 *
 * **`keepSharp` reads sharp edges, and the first measurement of it was a
 * trap.** It came out as "every corner keeps its own face normal", which looks
 * like the option throwing the weighting away. It is not: a `from_pydata` mesh
 * is **flat shaded**, so every edge counts as sharp and each smooth group is
 * one face. Shading the same fan smooth and marking two edges sharp split the
 * apex into the two groups the edges cut — `(-0.35314, -0.66610, -0.65697)`
 * for the two faces on one side and `(0.11060, -0.97234, 0.20570)` for the
 * three on the other, both exactly the area-weighted average **within the
 * group**. With `keepSharp` off the same mesh gives one answer across all five
 * faces, sharp edges and all. So: off averages per vertex, on averages per
 * smooth group, which is what `smoothGroups` already computes for
 * `averageNormals`.
 *
 * **Only the neutral weight is offered.** `MOD_weighted_normal.cc` divides
 * each *distinct value tier* at a vertex by `weight^tier`, the parameter
 * mapping through `weight / 50` — so 50 collapses every divisor to 1 and
 * anything else re-ranks the faces. A first reading of that did not reproduce
 * the measurement at the extremes (`weight` 100 on the fan is not the largest
 * face's normal), so the numbers are recorded in the probe and the option
 * throws rather than guesses. `thresh` moved nothing on any shape tried.
 *
 * ## `normalEdit`
 *
 * Both modes are exact.
 *
 * * **`radial`** — `normalize(vertex - target)`. Confirmed with three targets,
 *   including one that flips the apex.
 * * **`directional`** — and here the obvious reading is wrong. With
 *   `parallel` on, every corner gets one shared `normalize(target)`. With it
 *   **off, which is Blender's default**, the answer is **not**
 *   `normalize(target - vertex)`: it is
 *
 *   ```
 *   normalize(target + (target - vertex))
 *   ```
 *
 *   — the shared direction *plus* the per-vertex one, summed before
 *   normalising. That fits 9 corners across 3 targets to within 6e-5, while
 *   plain `target - vertex` is off by up to 2e-2 and the sum of the two
 *   *normalised* directions by 1e-3.
 *
 * The mix is exact as well — four modes at three factors each:
 *
 * ```
 * combined = mix(original, computed)   // copy | add | sub | mul
 * final    = normalize(lerp(original, normalize(combined), factor))
 * ```
 *
 * where `sub` is `computed - original` (that direction, not the other) and
 * `mul` is component-wise. `ADD` at factor 1.0 landing on the same vector as
 * `COPY` at 0.5 is what pinned the double normalisation.
 *
 * ### The rewind
 *
 * **`normalEdit` changes geometry**, which nothing about its name suggests and
 * which the parity rows found rather than the probes: the fan came back inside
 * out and a unit cube's signed volume read 0.6667 and -0.6667 instead of 1 —
 * one flipped face of a unit cube being worth exactly 2/6 of it.
 *
 * The cause is `no_polynors_fix`, **off by default**, which reverses every face
 * whose winding disagrees with the normals just written. See
 * `rewindDisagreeingFaces` for the measured predicate and the two details a
 * reading of the tooltip would miss.
 *
 * `weightedNormal` has no such option and never rewinds.
 *
 * ### `offset` is not offered
 *
 * Blender has one, and a first probe read it as a move of the centre —
 * `offset (0, 0.5, 0)` gave the same answers as a target at `(0, 0.5, 0)`.
 * Both halves of that turned out to be too small a measurement:
 *
 *   * **with a target object set, Blender ignores `offset` outright** — four
 *     values, one answer;
 *   * with none, an off-axis `offset (0.3, 0, 0)` does not give
 *     `normalize(vertex - offset)` either. The answer looks like that vector
 *     with two components exchanged, which smells like a space, and one
 *     reading is not enough to name it.
 *
 * Since the usable form of this modifier has a target — `directional` is
 * **disabled** without one — the option would be dead weight even if it were
 * read. `probe-normal-edit-offset.py` holds the numbers. Move the `target`
 * instead.
 *
 * ### What Blender cannot store
 *
 * A custom normal is kept as two 16-bit angles **relative to the corner's own
 * normal space**, not as three floats. So every "exact" above means "within
 * what the layer can hold", which is two different numbers:
 *
 *   * **about 1e-4 of component error in the ordinary case** — an exact
 *     `(0, 1, 0)` comes back as `(1.3e-05, 1.0, -1.8e-05)`, or 0.006°;
 *   * **most of a degree for a direction near perpendicular to its face**,
 *     where the relative encoding is at its worst. Writing the exact radial
 *     into all 620 corners of a closed cage and reading it straight back —
 *     no modifier involved — loses **0.72° at six of them**, every one in the
 *     90–100° band away from its face normal, against 0.028° or less
 *     everywhere else (`probe-custom-normal-storage.py`).
 *
 * So a corner normal read back out of Blender is not a reference value at
 * arbitrary precision. The parity rows for this operator carry a raised
 * tolerance that names the storage rather than either implementation, and the
 * unit tests compare angles for the same reason.
 */
import type { MeshData } from "../../lib/mesh";
import {
  cornerAngle,
  currentNormals,
  faceArea,
  faceNormal,
  smoothGroups,
  withNormals,
  type Vec3,
} from "./normals";

export type WeightedNormalMode = "area" | "angle" | "areaAngle";

export interface WeightedNormalOptions {
  /** Blender's `mode`. Default `area`, as Blender's is. */
  mode?: WeightedNormalMode;
  /**
   * Blender's `weight`, 1..100. **Only 50 — the neutral value — is
   * implemented**; anything else throws rather than approximating. See the
   * note at the top of this file.
   */
  weight?: number;
  /**
   * Blender's `keep_sharp`: average within each smooth group rather than
   * across the whole vertex, so sharp edges keep their crease.
   */
  keepSharp?: boolean;
}

export type NormalEditMode = "radial" | "directional";
export type NormalMixMode = "copy" | "add" | "sub" | "mul";

export interface NormalEditOptions {
  /** Blender's `mode`. Default `radial`, as Blender's is. */
  mode?: NormalEditMode;
  /** The target's location, in mesh space. Default the origin. */
  target?: readonly [number, number, number];
  /**
   * Blender's `use_direction_parallel` — one shared direction for every
   * corner. `directional` only; **default off**, which is Blender's default
   * and the surprising branch (see the top of this file).
   */
  parallel?: boolean;
  /** Blender's `mix_mode`. Default `copy`. */
  mixMode?: NormalMixMode;
  /** Blender's `mix_factor`; 0 keeps the original. Default 1. */
  mixFactor?: number;
  /**
   * Blender's `no_polynors_fix`: leave the winding alone. **Default off**, as
   * Blender's is — which means this operator rewinds faces by default. See
   * "the rewind" at the top of this file.
   */
  noPolynorsFix?: boolean;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mulEach = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

function normalized(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]);
  return len > 1e-30 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
}

const at = (P: Float32Array, v: number): Vec3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];

/**
 * Write a weighted vertex normal into every corner — Blender's
 * `WEIGHTED_NORMAL` modifier at its neutral weight.
 *
 * ```ts
 * weightedNormal(mesh);                                    // FACE_AREA
 * weightedNormal(mesh, { mode: "areaAngle" });             // FACE_AREA_WITH_ANGLE
 * weightedNormal(mesh, { mode: "angle", keepSharp: true }); // per smooth group
 * ```
 *
 * @throws if `weight` is anything but 50 — see the note at the top of this
 *   file. Approximating it would be a guess, and this project has paid for
 *   those.
 */
export function weightedNormal(data: MeshData, options: WeightedNormalOptions = {}): MeshData {
  const weight = options.weight ?? 50;
  if (weight !== 50)
    throw new Error(
      `weightedNormal: only Blender's neutral weight of 50 is implemented, not ${weight} — ` +
        "the tiered division by weight^tier is measured but not read " +
        "(see probe-normal-modifiers.py)",
    );
  const mode = options.mode ?? "area";
  const P = data.positions;

  // Per-face terms, computed once: the normal and the area, and the angle per
  // corner. `angle` mode drops the area, `area` mode drops the angle, and
  // `areaAngle` keeps both — measured as exactly those three products.
  const normals = data.polys.map((poly) => faceNormal(P, poly));
  const areas = data.polys.map((poly) => (mode === "angle" ? 1 : faceArea(P, poly)));

  const cornerWeight = (f: number, i: number): number =>
    areas[f]! * (mode === "area" ? 1 : cornerAngle(P, data.polys[f]!, i));

  const out: Vec3[][] = data.polys.map((poly) => poly.map(() => [0, 0, 0] as Vec3));

  if (options.keepSharp) {
    // Average within each smooth group, which is what sharp edges cut. The
    // flat-shaded measurement — one face per group — falls out of this.
    for (const group of smoothGroups(data)) {
      let acc: Vec3 = [0, 0, 0];
      for (const [f, i] of group) acc = add(acc, scale(normals[f]!, cornerWeight(f, i)));
      const n = normalized(acc);
      for (const [f, i] of group) out[f]![i] = [...n] as Vec3;
    }
  } else {
    // One answer per vertex, crossing sharp edges — measured: with two edges
    // marked sharp, all five corners at the apex still agree.
    const acc = new Map<number, Vec3>();
    for (const [f, poly] of data.polys.entries())
      for (const [i, v] of poly.entries())
        acc.set(v, add(acc.get(v) ?? [0, 0, 0], scale(normals[f]!, cornerWeight(f, i))));
    for (const [f, poly] of data.polys.entries())
      for (const [i, v] of poly.entries()) out[f]![i] = normalized(acc.get(v)!);
  }
  return withNormals(data, out);
}

/**
 * Aim every corner normal at, or away from, a target — Blender's
 * `NORMAL_EDIT` modifier.
 *
 * ```ts
 * normalEdit(mesh);                                        // radial from the origin
 * normalEdit(mesh, { target: [0, 0.5, 0] });               // from somewhere else
 * normalEdit(mesh, { mode: "directional", target: [0, 1, 0] });
 * normalEdit(mesh, { mixMode: "add", mixFactor: 0.5 });
 * ```
 *
 * `directional` without `parallel` is **not** "aim each normal at the target":
 * it sums the shared direction and the per-vertex one. That is Blender's
 * default and it is measured — see the top of this file.
 *
 * **This operator rewinds faces**, unless `noPolynorsFix` says otherwise. It
 * is the only one in this file that changes geometry.
 */
export function normalEdit(data: MeshData, options: NormalEditOptions = {}): MeshData {
  const mode = options.mode ?? "radial";
  const target: Vec3 = [...(options.target ?? [0, 0, 0])] as Vec3;
  const centre = target;
  const mixMode = options.mixMode ?? "copy";
  const factor = options.mixFactor ?? 1;
  const P = data.positions;

  const shared = normalized(target);
  const computed = (v: number): Vec3 => {
    if (mode === "radial") return normalized(sub(at(P, v), centre));
    if (options.parallel) return shared;
    return normalized(add(target, sub(target, at(P, v))));
  };

  const current = currentNormals(data);
  const out = data.polys.map((poly, f) =>
    poly.map((v, i) => {
      const original = current[f]![i]!;
      const want = computed(v);
      const combined =
        mixMode === "copy"
          ? want
          : mixMode === "add"
            ? add(original, want)
            : mixMode === "sub"
              ? sub(want, original)
              : mulEach(original, want);
      const unit = normalized(combined);
      // Blender blends in the *normalised* combination, then normalises the
      // blend. `ADD` at factor 1 landing on `COPY` at 0.5 is what proves it.
      return normalized([
        original[0] + (unit[0] - original[0]) * factor,
        original[1] + (unit[1] - original[1]) * factor,
        original[2] + (unit[2] - original[2]) * factor,
      ]);
    }),
  );
  if (options.noPolynorsFix) return withNormals(data, out);
  return rewindDisagreeingFaces(data, out);
}

/**
 * Reverse every face whose winding disagrees with the normals just written —
 * Blender's `no_polynors_fix` **off**, which is its default.
 *
 * The predicate is `dot(faceNormal, sum of the new corner normals) < 0`,
 * measured on 8 arrangements: none of a cube's faces on a radial from its own
 * centre, one for a radial from above, one for a parallel direction, five for
 * the non-parallel one, all five of a fan, and none for a mix that stays near
 * the face normal.
 *
 * Two details that only a measurement gives:
 *
 *   * **A face exactly perpendicular to its new normals is not reversed.**
 *     Four of the cube's faces sit at a dot of analytically zero in the
 *     parallel case and Blender leaves all four alone. So the tie goes to
 *     "keep", and the comparison here uses a small negative threshold rather
 *     than `< 0` — at exactly zero the sign of a float sum is noise, and this
 *     project does not imitate branches decided by rounding.
 *   * **The ring keeps its first vertex** — `(2, 3, 7, 6)` comes back as
 *     `(2, 6, 7, 3)` — and the corner data travels with its vertex. Every
 *     per-corner layer has to be reversed the same way, which is why this
 *     writes `uvs` and `colors` itself instead of letting `withNormals` copy
 *     them straight.
 */
function rewindDisagreeingFaces(data: MeshData, normals: Vec3[][]): MeshData {
  /**
   * How far from perpendicular the face has to be before the winding counts
   * as disagreeing. Relative to the corner count, since the test sums one
   * unit vector per corner.
   */
  const PERPENDICULAR = 1e-7;

  const flip: boolean[] = data.polys.map((poly, f) => {
    const n = faceNormal(data.positions, poly);
    let acc: Vec3 = [0, 0, 0];
    for (const corner of normals[f]!) acc = add(acc, corner);
    return n[0] * acc[0] + n[1] * acc[1] + n[2] * acc[2] < -PERPENDICULAR * poly.length;
  });
  if (!flip.some(Boolean)) return withNormals(data, normals);

  /** `[a, b, c, d]` → `[a, d, c, b]`: the first stays, the rest reverse. */
  const rewind = <T>(list: readonly T[]): T[] => [list[0]!, ...list.slice(1).reverse()];

  const out = withNormals(
    data,
    normals.map((face, f) => (flip[f] ? rewind(face) : face)),
  );
  out.polys = data.polys.map((poly, f) => (flip[f] ? rewind(poly) : [...poly]));
  if (data.uvs) out.uvs = data.uvs.map((face, f) => (flip[f] ? rewind(face) : face));
  if (data.colors) out.colors = data.colors.map((face, f) => (flip[f] ? rewind(face) : face));
  return out;
}
