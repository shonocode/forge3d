/**
 * Blender's colour ramp (`ColorBand`) — what a texture's `use_color_ramp`
 * runs its intensity through (`multitex`: `BKE_colorband_evaluate(coba, tin)`).
 *
 * Source (tag **v5.1.1**): `source/blender/blenkernel/intern/colorband.cc`
 * (`BKE_colorband_evaluate`, `colorband_hue_interp`), `blenkernel/intern/key.cc`
 * (`key_curve_position_weights`, the Cardinal / B-spline weights) and
 * `blenlib/intern/math_color.cc` (`rgb_to_hsl`, `hsl_to_rgb`).
 *
 * `interpolation` only applies in `RGB` colour mode; HSV and HSL always blend
 * linearly (the C forces `COLBAND_INTERP_LINEAR`), with `hueInterpolation`
 * choosing which way round the hue wheel. Float arithmetic follows the C
 * (`Math.fround` per operation).
 */

const f = Math.fround;

/** RNA `ColorRamp.interpolation`. */
export type RampInterpolation = "EASE" | "CARDINAL" | "LINEAR" | "B_SPLINE" | "CONSTANT";
/** RNA `ColorRamp.color_mode`. */
export type RampColorMode = "RGB" | "HSV" | "HSL";
/** RNA `ColorRamp.hue_interpolation`. */
export type RampHueInterpolation = "NEAR" | "FAR" | "CW" | "CCW";

/** One stop: RNA `ColorRampElement`. */
export interface RampElement {
  /** `position`, 0..1. */
  position: number;
  /** `color`, RGBA, linear. */
  color: readonly [number, number, number, number];
}

/** RNA `ColorRamp`. `elements` must be sorted by position, as Blender keeps them. */
export interface ColorRamp {
  elements: readonly RampElement[];
  /** Default `LINEAR` (what a new ramp gets). */
  interpolation?: RampInterpolation;
  /** Default `RGB`. */
  colorMode?: RampColorMode;
  /** Default `NEAR`. */
  hueInterpolation?: RampHueInterpolation;
}

interface Stop {
  pos: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `key_curve_position_weights` for the two kinds a ramp uses. */
function keyWeights(t: number, kind: "CARDINAL" | "B_SPLINE"): [number, number, number, number] {
  const t2 = f(t * t);
  const t3 = f(t2 * t);
  if (kind === "CARDINAL") {
    const fc = f(0.71);
    return [
      f(f(f(-fc * t3) + f(f(2 * fc) * t2)) - f(fc * t)),
      f(f(f(f(2 - fc) * t3) + f(f(fc - 3) * t2)) + 1),
      f(f(f(f(fc - 2) * t3) + f(f(3 - f(2 * fc)) * t2)) + f(fc * t)),
      f(f(fc * t3) - f(fc * t2)),
    ];
  }
  const sixth = f(0.16666666);
  return [
    f(f(f(f(-sixth * t3) + f(0.5 * t2)) - f(0.5 * t)) + sixth),
    f(f(f(0.5 * t3) - t2) + f(0.66666666)),
    f(f(f(f(-0.5 * t3) + f(0.5 * t2)) + f(0.5 * t)) + sixth),
    f(sixth * t3),
  ];
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** `rgb_to_hsv`, as `texture.ts` has it (its private copy is the same function). */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  let k = 0;
  if (g < b) {
    const t = g; g = b; b = t;
    k = -1;
  }
  let minGb = b;
  if (r < g) {
    const t = r; r = g; g = t;
    k = f(f(-2 / 6) - k);
    minGb = Math.min(g, b);
  }
  const chroma = f(r - minGb);
  const h = Math.abs(f(k + f(f(g - b) / f(f(6 * chroma) + f(1e-20)))));
  const s = f(chroma / f(r + f(1e-20)));
  return [h, s, r];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const h6 = f(h * 6);
  const nr = clamp01(f(Math.abs(f(h6 - 3)) - 1));
  const ng = clamp01(f(2 - Math.abs(f(h6 - 2))));
  const nb = clamp01(f(2 - Math.abs(f(h6 - 4))));
  const ch = (n: number): number => f(f(f(f(n - 1) * s) + 1) * v);
  return [ch(nr), ch(ng), ch(nb)];
}

/** `rgb_to_hsl`. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const cmax = Math.max(r, g, b);
  const cmin = Math.min(r, g, b);
  const l = Math.min(1, f(f(cmax + cmin) / 2));
  let h: number;
  let s: number;
  if (cmax === cmin) {
    h = s = 0;
  } else {
    const d = f(cmax - cmin);
    s = l > 0.5 ? f(d / f(f(2 - cmax) - cmin)) : f(d / f(cmax + cmin));
    if (cmax === r) h = f(f(f(g - b) / d) + (g < b ? 6 : 0));
    else if (cmax === g) h = f(f(f(b - r) / d) + 2);
    else h = f(f(f(r - g) / d) + 4);
  }
  h = f(h / 6);
  return [h, s, l];
}

/** `hsl_to_rgb`. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const h6 = f(h * 6);
  const nr = clamp01(f(Math.abs(f(h6 - 3)) - 1));
  const ng = clamp01(f(2 - Math.abs(f(h6 - 2))));
  const nb = clamp01(f(2 - Math.abs(f(h6 - 4))));
  const chroma = f(f(1 - Math.abs(f(f(2 * l) - 1))) * s);
  return [f(f(f(nr - 0.5) * chroma) + l), f(f(f(ng - 0.5) * chroma) + l), f(f(f(nb - 0.5) * chroma) + l)];
}

/** `colorband_hue_interp`. */
function hueInterp(kind: RampHueInterpolation, mfac: number, fac: number, h1: number, h2: number): number {
  const mod = (h: number): number => (h < 1 ? h : f(h - 1));
  const lerp = (a: number, b: number): number => f(f(mfac * a) + f(fac * b));
  h1 = mod(h1);
  h2 = mod(h2);
  let mode = 0;
  if (kind === "NEAR") {
    if (h1 < h2 && f(h2 - h1) > 0.5) mode = 1;
    else if (h1 > h2 && f(h2 - h1) < -0.5) mode = 2;
  } else if (kind === "FAR") {
    if (h1 === h2) mode = 1;
    else if (h1 < h2 && f(h2 - h1) < 0.5) mode = 1;
    else if (h1 > h2 && f(h2 - h1) > -0.5) mode = 2;
  } else if (kind === "CCW") {
    mode = h1 > h2 ? 2 : 0;
  } else {
    mode = h1 < h2 ? 1 : 0;
  }
  if (mode === 1) return mod(lerp(f(h1 + 1), h2));
  if (mode === 2) return mod(lerp(h1, f(h2 + 1)));
  return lerp(h1, h2);
}

/**
 * `BKE_colorband_evaluate`: the ramp's RGBA at `input`, or `null` for a ramp
 * with no stops (Blender then leaves the texture's own result alone).
 */
export function evaluateColorRamp(ramp: ColorRamp, input: number): [number, number, number, number] | null {
  const tot = ramp.elements.length;
  if (tot === 0) return null;
  const data: Stop[] = ramp.elements.map((e) => ({
    pos: f(e.position),
    r: f(e.color[0]),
    g: f(e.color[1]),
    b: f(e.color[2]),
    a: f(e.color[3]),
  }));
  const colorMode = ramp.colorMode ?? "RGB";
  const ipotype: RampInterpolation = colorMode === "RGB" ? (ramp.interpolation ?? "LINEAR") : "LINEAR";
  const rgba = (s: Stop): [number, number, number, number] => [s.r, s.g, s.b, s.a];
  const inV = f(input);

  if (tot === 1) return rgba(data[0]!);
  const flat = ipotype === "LINEAR" || ipotype === "EASE" || ipotype === "CONSTANT";
  if (inV <= data[0]!.pos && flat) return rgba(data[0]!);

  // The first stop after `input`; `a` is its index, `tot` when there is none.
  let a = 0;
  while (a < tot && !(data[a]!.pos > inV)) a++;
  let cbd1: Stop;
  let cbd2: Stop;
  if (a === tot) {
    cbd2 = data[a - 1]!;
    cbd1 = { ...cbd2, pos: 1 };
  } else if (a === 0) {
    cbd1 = data[0]!;
    cbd2 = { ...cbd1, pos: 0 };
  } else {
    cbd1 = data[a]!;
    cbd2 = data[a - 1]!;
  }
  if (a === tot && flat) return rgba(cbd2);
  if (ipotype === "CONSTANT") return rgba(cbd2);

  let fac: number;
  if (cbd2.pos !== cbd1.pos) fac = f(f(inV - cbd1.pos) / f(cbd2.pos - cbd1.pos));
  else fac = a !== tot ? 0 : 1;

  if (ipotype === "B_SPLINE" || ipotype === "CARDINAL") {
    // Interpolate from right to left: `3 2 1 0`.
    const cbd0 = a >= tot - 1 ? cbd1 : data[a + 1]!;
    const cbd3 = a < 2 ? cbd2 : data[a - 2]!;
    fac = clamp01(fac);
    const t = keyWeights(fac, ipotype);
    const ch = (k: "r" | "g" | "b" | "a"): number =>
      clamp01(f(f(f(f(t[3] * cbd3[k]) + f(t[2] * cbd2[k])) + f(t[1] * cbd1[k])) + f(t[0] * cbd0[k])));
    return [ch("r"), ch("g"), ch("b"), ch("a")];
  }
  if (ipotype === "EASE") {
    const fac2 = f(fac * fac);
    fac = f(f(3 * fac2) - f(f(2 * fac2) * fac));
  }
  const mfac = f(1 - fac);
  const mix = (x: number, y: number): number => f(f(mfac * x) + f(fac * y));
  if (colorMode === "HSV" || colorMode === "HSL") {
    const toHs = colorMode === "HSV" ? rgbToHsv : rgbToHsl;
    const c1 = toHs(cbd1.r, cbd1.g, cbd1.b);
    const c2 = toHs(cbd2.r, cbd2.g, cbd2.b);
    const h = hueInterp(ramp.hueInterpolation ?? "NEAR", mfac, fac, c1[0], c2[0]);
    const rgb = (colorMode === "HSV" ? hsvToRgb : hslToRgb)(h, mix(c1[1], c2[1]), mix(c1[2], c2[2]));
    return [rgb[0], rgb[1], rgb[2], mix(cbd1.a, cbd2.a)];
  }
  return [mix(cbd1.r, cbd2.r), mix(cbd1.g, cbd2.g), mix(cbd1.b, cbd2.b), mix(cbd1.a, cbd2.a)];
}
