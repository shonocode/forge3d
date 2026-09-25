/**
 * Pushing vertices around by something irregular — the "make this box read as
 * a stone" step.
 *
 * Every generated prop that wants a rock, a worn edge or a rippled surface has
 * so far written its own six lines: an LCG seeded with a magic number, three
 * calls per vertex, and a different pseudo-random source each time. Six lines
 * is cheap; **six lines that differ everywhere** is not, because a scene
 * rebuilt with one of them changed is a scene that cannot be diffed against
 * its own render.
 *
 * ## No Blender reference, and why that is said out loud
 *
 * Blender displaces with a modifier driven by a texture, and jitters with
 * `bpy.ops.transform.vertex_random`, whose numbers come out of Blender's own
 * RNG. Neither is a `bmesh.ops` operator, and matching either exactly would
 * mean reimplementing someone's random number generator — which would be a
 * measurement of nothing. So `parity/` does not cover this file, and the
 * guarantee here is the weaker but honest one: **the same seed gives the same
 * mesh, on any machine, in any version of this library.**
 *
 * That is what a build script actually needs. A render that changes because
 * `Math.random` was called somewhere is the failure this exists to prevent.
 *
 * The exceptions are the modifier itself. {@link offsetAlongNormals} is the
 * Displace modifier with **no** texture, a plain push along the normal
 * (`displace-mod`); {@link textureDisplace} is the modifier **with** one of
 * Blender's procedural textures (`tools/texture`, ported 2026-09-25), measured
 * texture by texture (`displace-tex-*`). Those are Blender's noise, not a
 * random generator's, so they can be matched — and are.
 *
 * Pure and headless.
 */
import { withPositions, type MeshData } from "../lib/mesh";
import type { Vec3 } from "./generate";
import { f, meshVertNormals, type V3 } from "./blender-math";
import { textureValue, type ProceduralTexture } from "./texture/texture";

/**
 * A hash-based value in [0, 1) from three integers.
 *
 * Hash rather than a running LCG on purpose: a vertex's offset then depends on
 * the vertex and the seed alone, so adding a vertex somewhere else does not
 * reshuffle the whole mesh. With an LCG, inserting one ring into a lathe moves
 * every stone in the scene.
 */
export function hashNoise(x: number, y: number, z: number, seed = 0): number {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^
    Math.imul(z | 0, 0xcb1ab31f) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  // `^=` yields a SIGNED int32, so the last mix has to be pushed back to
  // unsigned before dividing. Without this roughly half the values come out
  // negative, which reads as a noise field that works — the numbers still vary
  // smoothly — while pushing half the vertices twice as far as `amount`.
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

/**
 * Smooth 3D value noise in [-1, 1], from {@link hashNoise} on a lattice.
 *
 * `scale` is the size of one lattice cell in metres: a stone 100mm across
 * wants something near its own size, and much smaller reads as sandpaper
 * because the mesh cannot carry the detail.
 */
export function valueNoise(p: Vec3, scale = 1, seed = 0): number {
  const s = 1 / (scale || 1);
  const x = p[0] * s, y = p[1] * s, z = p[2] * s;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  // Smoothstep on each axis: linear interpolation alone leaves creases on the
  // lattice planes, which on a displaced box look like manufacturing defects.
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);

  const corner = (dx: number, dy: number, dz: number): number =>
    hashNoise(xi + dx, yi + dy, zi + dz, seed);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  const x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), u);
  const x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), u);
  const x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), u);
  const x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}

export interface DisplaceOptions {
  /** How far a vertex may move, in metres. */
  amount: number;
  /**
   * Which way to push. Default `"normal"`.
   *
   * `"normal"` swells and dents the surface and keeps a closed shell closed.
   * `"free"` moves each vertex in all three axes, which is what turns a box
   * into a stone. A `Vec3` pushes everything one way — a wind-blown banner.
   */
  along?: "normal" | "free" | Vec3;
  /** Lattice size of the noise, metres. Default the mesh's longest side / 4. */
  scale?: number;
  /** Same seed, same mesh. Default 0. */
  seed?: number;
  /**
   * Supply the field yourself: metres of offset for a point, per axis when
   * `along` is `"free"`. Given this, `scale` and `seed` are yours to use.
   */
  by?: (p: Vec3, axis: 0 | 1 | 2) => number;
}

/**
 * Move every vertex by a noise field. Topology is untouched.
 *
 * Vertices that coincide get the same offset, because the field is sampled at
 * the position and not per index — a seam welded shut stays shut, and a UV
 * seam's two copies do not tear apart.
 */
export function displace(data: MeshData, opts: DisplaceOptions): MeshData {
  const along = opts.along ?? "normal";
  const seed = opts.seed ?? 0;
  const scale = opts.scale ?? defaultScale(data);
  const field =
    opts.by ?? ((p: Vec3, axis: 0 | 1 | 2) => valueNoise(p, scale, seed + axis * 7919));

  const normals = along === "normal" ? vertexNormals(data) : null;
  const out = new Float32Array(data.positions);

  for (let v = 0; v < out.length / 3; v++) {
    const p: Vec3 = [data.positions[v * 3]!, data.positions[v * 3 + 1]!, data.positions[v * 3 + 2]!];
    if (along === "normal") {
      const n = normals!;
      const d = field(p, 0) * opts.amount;
      out[v * 3] = p[0] + n[v * 3]! * d;
      out[v * 3 + 1] = p[1] + n[v * 3 + 1]! * d;
      out[v * 3 + 2] = p[2] + n[v * 3 + 2]! * d;
    } else if (along === "free") {
      out[v * 3] = p[0] + field(p, 0) * opts.amount;
      out[v * 3 + 1] = p[1] + field(p, 1) * opts.amount;
      out[v * 3 + 2] = p[2] + field(p, 2) * opts.amount;
    } else {
      const d = field(p, 0) * opts.amount;
      out[v * 3] = p[0] + along[0] * d;
      out[v * 3 + 1] = p[1] + along[1] * d;
      out[v * 3 + 2] = p[2] + along[2] * d;
    }
  }

  return withPositions(data, out);
}

/**
 * Push every vertex the same distance along its normal — Blender's
 * **Displace** modifier with no texture, direction `NORMAL`, where every
 * vertex reads the value 1 and moves `(1 − mid_level) · strength`. Pass that
 * product as `distance`; negative pulls inward.
 *
 * The normal is Blender's (`Mesh::vert_normals`): face normals weighted by the
 * corner angle. {@link displace}'s `"normal"` weights by area instead and is
 * kept that way on purpose — its promise is that a seed rebuilds the same
 * stone in any version, and changing its normals would move every one. The
 * two agree on a cube and part on anything with uneven faces: at 0.1 m, up to
 * 2.4 mm on the `body` cage and 11 mm on the irregular fan.
 */
export function offsetAlongNormals(data: MeshData, distance: number): MeshData {
  const P: V3[] = [];
  for (let v = 0; v < data.positions.length / 3; v++)
    P.push([f(data.positions[v * 3]!), f(data.positions[v * 3 + 1]!), f(data.positions[v * 3 + 2]!)]);
  const normals = meshVertNormals(P, data.polys);
  const d = f(distance);
  // `madd_v3_v3fl(positions[i], vert_normals[i], delta)`
  const out = new Float32Array(data.positions.length);
  for (let v = 0; v < P.length; v++)
    for (let k = 0; k < 3; k++) out[v * 3 + k] = f(P[v]![k]! + f(normals[v]![k]! * d));
  return withPositions(data, out);
}

export interface TextureDisplaceOptions {
  /** The texture read at each vertex. Absent: every vertex reads 1 (Blender's "white"). */
  texture?: ProceduralTexture;
  /** Blender's `strength`. Default 1. */
  strength?: number;
  /** Blender's `mid_level`: the texture value that moves nothing. Default 0.5. */
  midLevel?: number;
  /**
   * Blender's `direction`. Default `"normal"`. `"rgbToXyz"` moves each axis by
   * its own colour channel (a grey texture moves all three alike).
   */
  direction?: "normal" | "x" | "y" | "z" | "rgbToXyz";
  /**
   * Blender's `texture_coords`. `"local"` (default) reads the texture at the
   * vertex; `"uv"` at `(2u − 1, 2v − 1, 0)` from the first face corner that
   * uses the vertex (`uvs` must be present, else it falls back to local, as
   * Blender does with no UV map). `GLOBAL` / `OBJECT` need an object's
   * matrix, which a `MeshData` does not have — transform the mesh instead.
   */
  coords?: "local" | "uv";
}

/**
 * Blender's **Displace** modifier with a procedural texture
 * (`MOD_displace.cc`): each vertex reads the texture, and moves
 * `(value − midLevel) · strength` along `direction`, clamped to ±10000.
 *
 * ```ts
 * const rock = textureDisplace(box, { texture: { type: "CLOUDS", noiseScale: 0.3 }, strength: 0.05 });
 * ```
 *
 * The value is `BKE_texture_get_value`'s: the intensity, or for a texture that
 * returns colour, the plain mean of its channels. The arithmetic is float32
 * in C's order, and the normal is Blender's (`Mesh::vert_normals`). Textures
 * are `tools/texture` — every legacy procedural type but `NOISE`, which
 * Blender seeds from the clock.
 */
export function textureDisplace(data: MeshData, opts: TextureDisplaceOptions = {}): MeshData {
  const count = data.positions.length / 3;
  const P: V3[] = [];
  for (let v = 0; v < count; v++)
    P.push([f(data.positions[v * 3]!), f(data.positions[v * 3 + 1]!), f(data.positions[v * 3 + 2]!)]);
  const direction = opts.direction ?? "normal";
  const mid = f(opts.midLevel ?? 0.5);
  const strength = f(opts.strength ?? 1);
  const coords = textureCoords(data, P, opts.coords ?? "local");
  const normals = direction === "normal" ? meshVertNormals(P, data.polys) : null;
  const out = new Float32Array(data.positions.length);
  for (let v = 0; v < count; v++) {
    const value = opts.texture ? textureValue(opts.texture, coords[v]!) : null;
    const p = P[v]!;
    if (direction === "rgbToXyz") {
      const rgb = value ? value.color : [1, 1, 1];
      for (let k = 0; k < 3; k++) out[v * 3 + k] = f(p[k]! + f(f(rgb[k]! - mid) * strength));
      continue;
    }
    let delta = f((value ? value.intensity : 1) - mid);
    delta = Math.min(10000, Math.max(-10000, f(delta * strength)));
    for (let k = 0; k < 3; k++) out[v * 3 + k] = p[k]!;
    if (normals) for (let k = 0; k < 3; k++) out[v * 3 + k] = f(p[k]! + f(normals[v]![k]! * delta));
    else {
      const k = direction === "x" ? 0 : direction === "y" ? 1 : 2;
      out[v * 3 + k] = f(p[k]! + delta);
    }
  }
  return withPositions(data, out);
}

/**
 * `MOD_get_texture_coords` for `LOCAL` and `UV` — shared by the Displace and
 * Wave modifiers. A vertex no face reaches has UV coordinates (0, 0, 0).
 */
export function textureCoords(
  data: MeshData,
  P: readonly V3[],
  coords: "local" | "uv",
): [number, number, number][] {
  if (coords === "uv" && data.uvs) {
    const out: [number, number, number][] = P.map(() => [0, 0, 0]);
    const done = new Uint8Array(P.length);
    data.polys.forEach((poly, face) =>
      poly.forEach((v, i) => {
        if (done[v]) return;
        const uv = data.uvs![face]?.[i] ?? [0, 0];
        out[v] = [f(f(f(uv[0]!) * 2) - 1), f(f(f(uv[1]!) * 2) - 1), 0];
        done[v] = 1;
      }),
    );
    return out;
  }
  return P.map((p) => [p[0]!, p[1]!, p[2]!]);
}

/** A quarter of the longest side: coarse enough to read as shape, not grain. */
function defaultScale(data: MeshData): number {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const value = data.positions[i + k]!;
      if (value < min[k]!) min[k] = value;
      if (value > max[k]!) max[k] = value;
    }
  }
  const longest = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  return longest > 0 && Number.isFinite(longest) ? longest / 4 : 1;
}

/** Area-weighted vertex normals, from the polygon list alone. */
function vertexNormals(data: MeshData): Float32Array {
  const normals = new Float32Array(data.positions.length);
  for (const poly of data.polys) {
    // Newell's method: correct for n-gons, and for a triangle it is the cross
    // product scaled by area, which is the weighting wanted anyway.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const ax = data.positions[a * 3]!, ay = data.positions[a * 3 + 1]!, az = data.positions[a * 3 + 2]!;
      const bx = data.positions[b * 3]!, by = data.positions[b * 3 + 1]!, bz = data.positions[b * 3 + 2]!;
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    for (const v of poly) {
      normals[v * 3] = normals[v * 3]! + nx;
      normals[v * 3 + 1] = normals[v * 3 + 1]! + ny;
      normals[v * 3 + 2] = normals[v * 3 + 2]! + nz;
    }
  }
  for (let v = 0; v < normals.length / 3; v++) {
    const l = Math.hypot(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!);
    if (l > 0) {
      normals[v * 3] = normals[v * 3]! / l;
      normals[v * 3 + 1] = normals[v * 3 + 1]! / l;
      normals[v * 3 + 2] = normals[v * 3 + 2]! / l;
    }
  }
  return normals;
}
