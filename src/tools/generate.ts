/**
 * Parametric geometry generators, as plain data.
 *
 * `tools/primitives.ts` makes primitives for the *editor*: it calls
 * `MeshBuilder`, touches `state`, assigns a material and selects the result.
 * None of that can be called from a build script, and what it produces is
 * triangles — which `catmullClark` cannot refine usefully.
 *
 * This module is the pure half. Every function returns {@link MeshData} made
 * of **quads**, wound CCW outward, so the output feeds straight into
 * `meshFromData` and the operator set, or into `catmullClark` for a rounded
 * version of the same shape.
 *
 * ```ts
 * import { box, sweep, creaseAll, meshFromData, catmullClark } from "forge3d";
 *
 * const top = box({ size: [1.2, 0.04, 0.6], pivot: "base" });
 * creaseAll(top, 1);                       // keep it hard-surface
 * const trim = sweep({ profile: OGEE, path: roomPerimeter, closedPath: true });
 * ```
 *
 * Pure and headless — Vitest-pinned.
 */
import type { MeshData } from "../lib/mesh";

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

/** Accumulates positions and polygons, welding vertices that coincide. */
class Builder {
  positions: number[] = [];
  polys: number[][] = [];
  private index = new Map<string, number>();
  private weld: boolean;

  constructor(weld = true) {
    this.weld = weld;
  }

  vert(x: number, y: number, z: number): number {
    if (this.weld) {
      // 1e-5 m — a hundredth of a millimetre. Tight enough that deliberately
      // close geometry survives, loose enough to catch float drift from the
      // trig in the round generators.
      const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
      const hit = this.index.get(key);
      if (hit !== undefined) return hit;
      const id = this.positions.length / 3;
      this.positions.push(x, y, z);
      this.index.set(key, id);
      return id;
    }
    const id = this.positions.length / 3;
    this.positions.push(x, y, z);
    return id;
  }

  face(...verts: number[]): void {
    // A degenerate ring (a pole quad collapsing to a triangle, a zero-radius
    // cap) would break the half-edge build, so drop repeats here instead.
    const ring: number[] = [];
    for (const v of verts) if (ring[ring.length - 1] !== v) ring.push(v);
    if (ring.length > 2 && ring[0] === ring[ring.length - 1]) ring.pop();
    if (ring.length >= 3) this.polys.push(ring);
  }

  build(): MeshData {
    return { positions: new Float32Array(this.positions), polys: this.polys };
  }
}

/** Emit a quad grid spanning `u` x `v` from `origin`; normal is u × v. */
function gridFace(
  b: Builder,
  origin: Vec3,
  u: Vec3,
  v: Vec3,
  su: number,
  sv: number,
): void {
  const id: number[][] = [];
  for (let i = 0; i <= su; i++) {
    const row: number[] = [];
    const fu = i / su;
    for (let j = 0; j <= sv; j++) {
      const fv = j / sv;
      row.push(
        b.vert(
          origin[0] + u[0] * fu + v[0] * fv,
          origin[1] + u[1] * fu + v[1] * fv,
          origin[2] + u[2] * fu + v[2] * fv,
        ),
      );
    }
    id.push(row);
  }
  for (let i = 0; i < su; i++)
    for (let j = 0; j < sv; j++)
      b.face(id[i]![j]!, id[i + 1]![j]!, id[i + 1]![j + 1]!, id[i]![j + 1]!);
}

export interface BoxOptions {
  /** Extent on x, y, z. Default [1, 1, 1]. */
  size?: Vec3;
  /** Quads per axis. Default [1, 1, 1]. */
  segments?: Vec3;
  /** Where the box sits relative to the origin. Default [0, 0, 0]. */
  at?: Vec3;
  /**
   * `"center"` puts the origin at the middle; `"base"` puts it at the centre
   * of the bottom face, which is what you want for anything standing on a
   * floor — most of a room, in practice.
   */
  pivot?: "center" | "base";
}

/**
 * An axis-aligned box of quads.
 *
 * Blender's nearest is `bmesh.ops.create_cube(size=, matrix=)`, but that is a
 * true cube — one scalar edge length, one quad per face. Per-axis `size` and
 * `segments` have no equivalent there; in Blender you would scale the matrix
 * and run `subdivide_edges` afterwards.
 */
export function box(opts: BoxOptions = {}): MeshData {
  const [sx, sy, sz] = opts.size ?? [1, 1, 1];
  const [nx, ny, nz] = opts.segments ?? [1, 1, 1];
  const [ax, ay, az] = opts.at ?? [0, 0, 0];
  const yOff = opts.pivot === "base" ? sy / 2 : 0;

  const x0 = ax - sx / 2;
  const y0 = ay - sy / 2 + yOff;
  const z0 = az - sz / 2;
  const x1 = x0 + sx;
  const y1 = y0 + sy;
  const z1 = z0 + sz;

  const b = new Builder();
  gridFace(b, [x1, y0, z0], [0, sy, 0], [0, 0, sz], ny, nz); // +X
  gridFace(b, [x0, y0, z0], [0, 0, sz], [0, sy, 0], nz, ny); // -X
  gridFace(b, [x0, y1, z0], [0, 0, sz], [sx, 0, 0], nz, nx); // +Y
  gridFace(b, [x0, y0, z0], [sx, 0, 0], [0, 0, sz], nx, nz); // -Y
  gridFace(b, [x0, y0, z1], [sx, 0, 0], [0, sy, 0], nx, ny); // +Z
  gridFace(b, [x0, y0, z0], [0, sy, 0], [sx, 0, 0], ny, nx); // -Z
  return b.build();
}

export interface PlaneOptions {
  /** Extent along the plane's two axes — Blender's `size`, but per-axis. Default [1, 1]. */
  size?: Vec2;
  /** Quads along each axis — Blender's `x_segments` / `y_segments`. Default [1, 1]. */
  segments?: Vec2;
  /** Which way the plane faces. Default "+y" (a floor). Blender does this with `matrix`. */
  facing?: "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
  /** Where to put it. Blender does this with `matrix`. */
  at?: Vec3;
}

/**
 * A single-sided quad grid.
 *
 * Blender: `bmesh.ops.create_grid(x_segments=, y_segments=, size=)`, whose
 * `size` is one scalar where this takes an extent per axis.
 */
export function plane(opts: PlaneOptions = {}): MeshData {
  const [sa, sb] = opts.size ?? [1, 1];
  const [na, nb] = opts.segments ?? [1, 1];
  const [ax, ay, az] = opts.at ?? [0, 0, 0];
  const facing = opts.facing ?? "+y";

  // origin / u / v per facing, chosen so u × v is the stated normal.
  const table: Record<string, [Vec3, Vec3, Vec3]> = {
    "+y": [[-sa / 2, 0, -sb / 2], [0, 0, sb], [sa, 0, 0]],
    "-y": [[-sa / 2, 0, -sb / 2], [sa, 0, 0], [0, 0, sb]],
    "+z": [[-sa / 2, -sb / 2, 0], [sa, 0, 0], [0, sb, 0]],
    "-z": [[-sa / 2, -sb / 2, 0], [0, sb, 0], [sa, 0, 0]],
    "+x": [[0, -sb / 2, -sa / 2], [0, sb, 0], [0, 0, sa]],
    "-x": [[0, -sb / 2, -sa / 2], [0, 0, sa], [0, sb, 0]],
  } as Record<string, [Vec3, Vec3, Vec3]>;

  const [o, u, v] = table[facing]!;
  const su = facing === "+y" || facing === "-y" ? (facing === "+y" ? nb : na) : na;
  const sv = facing === "+y" || facing === "-y" ? (facing === "+y" ? na : nb) : nb;

  const b = new Builder();
  gridFace(b, [o[0] + ax, o[1] + ay, o[2] + az], u, v, su, sv);
  return b.build();
}

export interface CylinderOptions {
  /** Bottom radius — Blender's `radius1`. Default 0.5. */
  radius1?: number;
  /** Top radius — Blender's `radius2`. 0 makes a cone. Defaults to `radius1`. */
  radius2?: number;
  /** Extent along Y — Blender's `depth`. Default 1. */
  depth?: number;
  /** Segments around — Blender's `segments`. Default 16. */
  uSegments?: number;
  /**
   * Segments along the axis. Default 1.
   *
   * No Blender equivalent: `create_cone` is always one ring tall and you
   * subdivide afterwards. Named `v` to agree with `sphere`, where u runs
   * around and v runs along.
   */
  vSegments?: number;
  /**
   * `"ngon"` closes each end with one polygon, `"none"` leaves it open.
   *
   * Blender spells this `cap_ends` / `cap_tris`: `"ngon"` is
   * `cap_ends=True, cap_tris=False`, `"none"` is `cap_ends=False`. A triangle
   * fan cap (`cap_tris=True`) is not implemented.
   */
  caps?: "ngon" | "none";
  /** Where to put it. Blender does this with `matrix`. */
  at?: Vec3;
  pivot?: "center" | "base";
}

/**
 * A cylinder, cone or truncated cone, around the Y axis.
 *
 * Blender: `bmesh.ops.create_cone(radius1=, radius2=, depth=, segments=,
 * cap_ends=, cap_tris=)`. Argument names match apart from `uSegments`
 * (Blender's `segments`) and the two extras documented above.
 */
export function cylinder(opts: CylinderOptions = {}): MeshData {
  const r0 = opts.radius1 ?? 0.5;
  const r1 = opts.radius2 ?? r0;
  const h = opts.depth ?? 1;
  const radial = Math.max(3, opts.uSegments ?? 16);
  const rings = Math.max(1, opts.vSegments ?? 1);
  const [ax, ay, az] = opts.at ?? [0, 0, 0];
  const yBase = ay - (opts.pivot === "base" ? 0 : h / 2);

  const b = new Builder();
  const loops: number[][] = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const r = r0 + (r1 - r0) * t;
    const y = yBase + h * t;
    const loop: number[] = [];
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      loop.push(b.vert(ax + Math.cos(a) * r, y, az + Math.sin(a) * r));
    }
    loops.push(loop);
  }
  // Rings run counterclockwise in XZ, which reads as *clockwise* looking down
  // the +Y axis — so the side quads go up-then-around, and the top cap is the
  // reversed ring, to put every normal on the outside.
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < radial; i++) {
      const n = (i + 1) % radial;
      b.face(loops[j]![i]!, loops[j + 1]![i]!, loops[j + 1]![n]!, loops[j]![n]!);
    }

  if ((opts.caps ?? "ngon") === "ngon") {
    if (r1 > 0) b.face(...[...loops[rings]!].reverse());
    if (r0 > 0) b.face(...loops[0]!);
  }
  return b.build();
}

export interface SphereOptions {
  radius?: number;
  /** Segments around the equator — Blender's `u_segments`. Default 24. */
  uSegments?: number;
  /** Segments pole to pole — Blender's `v_segments`. Default 12. */
  vSegments?: number;
  /** Where to put it. Blender does this with `matrix`. */
  at?: Vec3;
}

/**
 * A UV sphere: quads everywhere, collapsing to triangles at the two poles.
 *
 * Blender: `bmesh.ops.create_uvsphere(u_segments=, v_segments=, radius=)`.
 */
export function sphere(opts: SphereOptions = {}): MeshData {
  const r = opts.radius ?? 0.5;
  const seg = Math.max(3, opts.uSegments ?? 24);
  const rings = Math.max(2, opts.vSegments ?? 12);
  const [ax, ay, az] = opts.at ?? [0, 0, 0];

  const b = new Builder();
  const loops: number[][] = [];
  for (let j = 0; j <= rings; j++) {
    const phi = (j / rings) * Math.PI;
    const y = Math.cos(phi) * r;
    const rr = Math.sin(phi) * r;
    const loop: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      loop.push(b.vert(ax + Math.cos(a) * rr, ay + y, az + Math.sin(a) * rr));
    }
    loops.push(loop);
  }
  // Top ring is at phi=0, so its verts all weld to the pole; `face` drops the
  // repeats and the quad becomes the triangle it geometrically is.
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < seg; i++) {
      const n = (i + 1) % seg;
      b.face(loops[j]![i]!, loops[j]![n]!, loops[j + 1]![n]!, loops[j + 1]![i]!);
    }
  return b.build();
}

export interface RevolveOptions {
  /**
   * Half-section in the XY plane: x is the radius, y the height. Spun around
   * the Y axis. Points at x = 0 land on the axis and weld into a pole.
   */
  profile: readonly Vec2[];
  /** Segments around — Blender's `steps`. Default 24. */
  steps?: number;
  /** Sweep angle in radians — Blender's `angle`. Default 2π, left open if partial. */
  angle?: number;
  /** Where to put it. Blender's `cent`. */
  at?: Vec3;
}

/**
 * Spin a half-section around the Y axis — a lathe.
 *
 * This is how you get the shapes a box cannot fake: a vase, a wine glass, a
 * turned leg, a faucet spout, a pendant shade.
 *
 * Blender: `bmesh.ops.spin(geom=, cent=, axis=, angle=, steps=)`. The axis is
 * fixed to +Y here, and `spin`'s `dvec` (which turns the revolve into a screw)
 * has no equivalent — `sweep` is the way to get a helix.
 */
export function revolve(opts: RevolveOptions): MeshData {
  const prof = opts.profile;
  const seg = Math.max(3, opts.steps ?? 24);
  const angle = opts.angle ?? Math.PI * 2;
  const closed = Math.abs(angle - Math.PI * 2) < 1e-6;
  const [ax, ay, az] = opts.at ?? [0, 0, 0];

  const b = new Builder();
  const stations = closed ? seg : seg + 1;
  const loops: number[][] = [];
  for (let i = 0; i < stations; i++) {
    const a = (i / seg) * angle;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const loop: number[] = [];
    // `-sa`: +X turns toward **-Z**, the right-hand rule about +Y. This used
    // to turn the other way, which put `revolve` and `radialArray` — both
    // spinning about +Y, both in this library — in opposite directions, and
    // put both out of step with Blender's `spin`. A full turn is the same
    // point set either way, so nothing that ships changed shape; a partial
    // turn is a mirror image, and that is what the parity row caught.
    for (const p of prof) loop.push(b.vert(ax + ca * p[0], ay + p[1], az - sa * p[0]));
    loops.push(loop);
  }
  // A profile drawn downwards produces an inside-out shell, so it is turned
  // back the right way here rather than left to the caller.
  //
  // This used to be documented and not handled — "assumes the profile is
  // ordered bottom-to-top" — and a half-section is usually drawn that way, so
  // it held for two rooms. The exceptions were the recessed downlight housings
  // and a lamp shade, whose profiles descend from the ceiling because that is
  // how those objects are drawn, and all four came out inside out. Nothing
  // caught it: Babylon shades from the normals, which `computeVertexNormals`
  // had already flipped outward, so the file was self-consistent and wrong
  // only to a renderer that uses the geometric normal.
  //
  // A generator's contract should be that its output faces outward. Wanting a
  // shell seen from within is a legitimate thing to want, and mirroring is the
  // honest way to ask for it.
  //
  // The two branches swapped when the spin direction did, above: reversing the
  // way the stations travel reverses which side of each quad is the outside,
  // so keeping the old pairing would have turned every full revolve in the
  // scene builders inside out while the vertex positions stayed put.
  const descending = prof.length > 1 && prof[prof.length - 1]![1] < prof[0]![1];
  for (let i = 0; i < (closed ? stations : stations - 1); i++) {
    const n = (i + 1) % stations;
    for (let j = 0; j < prof.length - 1; j++) {
      const [a0, a1, b1, b0] = [loops[i]![j]!, loops[i]![j + 1]!, loops[n]![j + 1]!, loops[n]![j]!];
      if (descending) b.face(a0, a1, b1, b0);
      else b.face(a0, b0, b1, a1);
    }
  }
  return b.build();
}

export interface SweepOptions {
  /**
   * Closed 2D cross-section. `x` runs along the path's side vector, `y` along
   * up. For trim, draw it the way you would on a shop drawing: x out from the
   * wall, y up from the floor.
   */
  profile: readonly Vec2[];
  /** Centre line the profile rides along. */
  path: readonly Vec3[];
  /** Join the last path point back to the first. Default false. */
  closedPath?: boolean;
  /** Which way the profile's +y points. Default [0, 1, 0]. */
  up?: Vec3;
  /** Cap the two ends when the path is open. Default true. */
  caps?: boolean;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Sweep a cross-section along a path — mouldings, skirting, rails, handles.
 *
 * ## Why the miter matters
 *
 * The naive version puts the profile in the plane perpendicular to each
 * segment, which pinches the section at every corner: run a 60mm cornice into
 * a 90° room corner and it comes out 42mm across the diagonal. Here each joint
 * sits in the bisector plane and the profile's side offset is divided by
 * `cos(θ/2)`, so the section stays its true width all the way round — the same
 * thing a miter saw does.
 *
 * The compensation is exact for a path that turns only about `up` (every
 * architectural run: a room perimeter, a plinth, a worktop edge). A path that
 * also climbs will join cleanly but the section is measured in the bisector
 * plane, so a very steep turn thins slightly.
 */
export function sweep(opts: SweepOptions): MeshData {
  const prof = opts.profile;
  const path = opts.path;
  const closed = opts.closedPath ?? false;
  const up = norm(opts.up ?? [0, 1, 0]);
  if (path.length < 2 || prof.length < 2) return { positions: new Float32Array(), polys: [] };

  const n = path.length;
  const loops: number[][] = [];
  // Welding would fuse the two ends of a closed run and the seam of a profile
  // that doubles back; the sweep already emits each ring once.
  const b = new Builder(false);

  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? path[i - 1]! : closed ? path[n - 1]! : null;
    const next = i < n - 1 ? path[i + 1]! : closed ? path[0]! : null;
    const tIn = prev ? norm(sub(path[i]!, prev)) : null;
    const tOut = next ? norm(sub(next, path[i]!)) : null;

    const tangent = norm(
      tIn && tOut ? add(tIn, tOut) : ((tIn ?? tOut) as Vec3),
    );
    // Side is horizontal-ish: perpendicular to both the run and up. When the
    // run is vertical there is no such direction, so fall back to any normal.
    let side = norm(cross(tangent, up));
    if (Math.hypot(side[0], side[1], side[2]) < 1e-9) {
      side = norm(cross(tangent, [1, 0, 0]));
      if (Math.hypot(side[0], side[1], side[2]) < 1e-9) side = norm(cross(tangent, [0, 0, 1]));
    }
    const vUp = norm(cross(side, tangent));

    // 1 / cos(half turn). Clamped: a hairpin would otherwise blow up.
    const cosHalf = tIn && tOut ? Math.max(0.15, dot(tIn, tangent)) : 1;
    const miter = 1 / cosHalf;

    const p = path[i]!;
    const loop: number[] = [];
    for (const s of prof) {
      const sx = s[0] * miter;
      loop.push(
        b.vert(
          p[0] + side[0] * sx + vUp[0] * s[1],
          p[1] + side[1] * sx + vUp[1] * s[1],
          p[2] + side[2] * sx + vUp[2] * s[1],
        ),
      );
    }
    loops.push(loop);
  }

  // Winding follows the profile: drawn counterclockwise in its own (side, up)
  // plane — the way a section is drawn on paper — the tube's normals point
  // out. Same convention as `revolve`.
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const a = loops[i]!;
    const c = loops[(i + 1) % n]!;
    for (let j = 0; j < prof.length; j++) {
      const k = (j + 1) % prof.length;
      b.face(a[j]!, c[j]!, c[k]!, a[k]!);
    }
  }

  if (!closed && (opts.caps ?? true)) {
    b.face(...loops[0]!);
    b.face(...[...loops[n - 1]!].reverse());
  }
  return b.build();
}

export interface CircleOptions {
  /** Distance from the centre to each vertex — Blender's `radius`. Default 0.5. */
  radius?: number;
  /** How many vertices around — Blender's `segments`. Default 32. */
  segments?: number;
  /**
   * `"ngon"` closes it with one polygon, `"none"` leaves a ring of edges with
   * no face at all — Blender's `cap_ends`. Default `"ngon"`.
   *
   * `"none"` is the useful one for a build script: it is a **profile**, and
   * what you do with it is `sweep` it along a path or `revolve` it. That is
   * the case the matrix filed under "要らなさそう" until the brazier's chain
   * needed a ring and wrote one out point by point.
   */
  caps?: "ngon" | "none";
  /** Which way the disc faces. Default `"+y"` — flat on the floor, like `plane`. */
  facing?: "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
  /** Where to put it. */
  at?: Vec3;
}

/**
 * A regular polygon — Blender's `bmesh.ops.create_circle`.
 *
 * The ring starts at +x and turns the same way Blender's does — but **not from
 * the same vertex**: measured, `create_circle` starts a quarter turn along
 * (+y of its own XY plane). Matching that would put this generator out of step
 * with `cylinder`, `sphere` and `revolve`, which all start at angle 0, so the
 * start stays where the rest of the module puts it and the difference is
 * written down instead.
 *
 * With `caps: "none"` the result has **no faces**: `MeshData` carries the ring
 * as a single open polygon so the points survive `meshFromData`, and the
 * profile helpers below (`circleProfile`) give the same ring as `Vec2`s for
 * `sweep` and `revolve`, which is usually what a build script wants.
 */
export function circle(opts: CircleOptions = {}): MeshData {
  const r = opts.radius ?? 0.5;
  const seg = Math.max(3, opts.segments ?? 32);
  const facing = opts.facing ?? "+y";
  const [ax, ay, az] = opts.at ?? [0, 0, 0];

  // u × v is the stated normal, so the ring comes out wound CCW seen from the
  // side the disc faces — the same convention `plane` uses.
  const frame: Record<string, [Vec3, Vec3]> = {
    "+y": [[1, 0, 0], [0, 0, -1]],
    "-y": [[1, 0, 0], [0, 0, 1]],
    "+z": [[1, 0, 0], [0, 1, 0]],
    "-z": [[-1, 0, 0], [0, 1, 0]],
    "+x": [[0, 0, -1], [0, 1, 0]],
    "-x": [[0, 0, 1], [0, 1, 0]],
  };
  const [u, v] = frame[facing]!;

  const b = new Builder();
  const ring: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a) * r;
    const s = Math.sin(a) * r;
    ring.push(b.vert(ax + u[0] * c + v[0] * s, ay + u[1] * c + v[1] * s, az + u[2] * c + v[2] * s));
  }
  b.face(...ring);
  const data = b.build();
  // `caps: "none"` keeps the ring as geometry without claiming it is a
  // surface. An empty `polys` would lose the vertices entirely.
  return opts.caps === "none" ? { positions: data.positions, polys: [] } : data;
}

/** The same ring as a 2D profile, for `sweep` and `revolve`. */
export function circleProfile(radius = 0.5, segments = 32, at: Vec2 = [0, 0]): Vec2[] {
  const out: Vec2[] = [];
  const n = Math.max(3, segments);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([at[0] + Math.cos(a) * radius, at[1] + Math.sin(a) * radius]);
  }
  return out;
}

export interface TorusOptions {
  /** Centre of the tube to the centre of the torus — Blender's `major_radius`. Default 1. */
  majorRadius?: number;
  /** The tube's own radius — Blender's `minor_radius`. Default 0.25. */
  minorRadius?: number;
  /** Segments around the ring — Blender's `major_segments`. Default 48. */
  majorSegments?: number;
  /** Segments around the tube — Blender's `minor_segments`. Default 12. */
  minorSegments?: number;
  /** Which axis the ring turns about. Default `"y"` — lying flat, like a quoit. */
  axis?: "x" | "y" | "z";
  /** Where to put it. */
  at?: Vec3;
}

/**
 * A torus — a chain link, a ring, a tyre, a handle.
 *
 * Blender puts this in the add-mesh menu (`bpy.ops.mesh.primitive_torus_add`)
 * rather than in `bmesh.ops`, so the API matrix could not list it; the brazier
 * found it anyway, because a chain is torus after torus and writing one out by
 * hand is a `revolve` of a circle that has to be spelled point by point.
 *
 * `revolve(circleProfile(minor, minorSegments, [major, 0]))` is the same shape
 * — this is that, named after what it is.
 */
export function torus(opts: TorusOptions = {}): MeshData {
  const major = opts.majorRadius ?? 1;
  const minor = opts.minorRadius ?? 0.25;
  const majorSegments = Math.max(3, opts.majorSegments ?? 48);
  const minorSegments = Math.max(3, opts.minorSegments ?? 12);
  const axis = opts.axis ?? "y";
  const [ax, ay, az] = opts.at ?? [0, 0, 0];

  const b = new Builder();
  const loops: number[][] = [];
  for (let i = 0; i < majorSegments; i++) {
    const around = (i / majorSegments) * Math.PI * 2;
    const loop: number[] = [];
    for (let j = 0; j < minorSegments; j++) {
      const through = (j / minorSegments) * Math.PI * 2;
      // Distance from the axis, and height along it.
      const rr = major + Math.cos(through) * minor;
      const h = Math.sin(through) * minor;
      const c = Math.cos(around) * rr;
      const s = Math.sin(around) * rr;
      const p: Vec3 =
        axis === "y" ? [c, h, s] : axis === "z" ? [c, s, h] : [h, c, s];
      loop.push(b.vert(ax + p[0], ay + p[1], az + p[2]));
    }
    loops.push(loop);
  }
  for (let i = 0; i < majorSegments; i++) {
    const ni = (i + 1) % majorSegments;
    for (let j = 0; j < minorSegments; j++) {
      const nj = (j + 1) % minorSegments;
      // Wound this way round, not the other: the first version came out with
      // the same surface as Blender's to 0.0000mm and the **signed volume
      // negated**, which is a torus turned inside out. No distance measurement
      // can see that; the volume line in `compare.ts` is what caught it.
      b.face(loops[i]![j]!, loops[i]![nj]!, loops[ni]![nj]!, loops[ni]![j]!);
    }
  }
  return b.build();
}
