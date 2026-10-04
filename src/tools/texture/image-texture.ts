/**
 * Blender's `IMAGE` texture, evaluated at a point — what the Displace /
 * Wave / Warp modifiers read when their texture is an image
 * (`bpy.data.textures.new(name, 'IMAGE')`, `tex.image = ...`).
 *
 * Source (tag **v5.1.1**): `source/blender/render/intern/texture_image.cc`
 * (`imagewrap`, `boxsample`, `boxsampleclip`, the `clip*_rctf` helpers) and
 * `texture_procedural.cc` (`do_2d_mapping`, the flat mapping a modifier gets
 * because it passes no `MTex`).
 *
 * ## What a modifier does with an image
 *
 * - **Flat mapping**: the modifier hands over coordinates in −1..1 (UV maps
 *   are taken to `uv·2 − 1`), and `do_2d_mapping` turns them back into
 *   `(c + 1) / 2`. Then `repeat_x/y` (only with `extension = REPEAT`),
 *   mirroring and the crop rectangle.
 * - **Interpolation is a box filter, not bilinear**: with `use_interpolation`
 *   (the default) the pixel is the area average of a box `filter_size` pixels
 *   wide around the point (`boxsample`), clipped, wrapped (REPEAT, once) or
 *   clamped (EXTEND) at the edges. At `filter_size = 1` that is close to
 *   bilinear but not the same. Without it, the nearest pixel.
 * - **No colour management** (`use_color_management = false` in
 *   `MOD_displace.cc`): bytes are taken as they are, `/ 255`. Float images
 *   are not offered here.
 * - **Alpha**: with `use_alpha` (default on) the box average is of
 *   *premultiplied* colour and alpha, and the colour is divided by alpha again
 *   afterwards, so a transparent pixel does not drag its neighbours' colour.
 * - The value is `BKE_texture_get_value`'s: the **mean of the three colour
 *   channels** after brightness / contrast / saturation (no clamp unless
 *   `use_clamp`, but negative channels are clipped to 0 then).
 *
 * Float arithmetic follows the C (`Math.fround` per operation, C order).
 *
 * Pure and headless.
 */

import type { ColorRamp } from "./colorband";

const f = Math.fround;

/** A byte image. `data` is RGBA, **row 0 at the bottom** (Blender's order), `4 * width * height` bytes. */
export interface TextureImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** RNA `extension`: what lies outside the image. */
export type ImageExtension = "EXTEND" | "CLIP" | "CLIP_CUBE" | "REPEAT" | "CHECKER";

/** An image texture. Every property is optional and defaults to Blender's. */
export interface ImageTextureSettings {
  type: "IMAGE";
  /** RNA `image`. Without one the texture reads 0. */
  image?: TextureImage;
  /** RNA `use_interpolation` (box filter). Default **true**. */
  useInterpolation?: boolean;
  /** RNA `filter_size`. Default 1. */
  filterSize?: number;
  /** RNA `extension`. Default `REPEAT`. */
  extension?: ImageExtension;
  /** RNA `repeat_x` / `repeat_y`, `REPEAT` only. Default 1. */
  repeatX?: number;
  repeatY?: number;
  /** RNA `use_mirror_x` / `use_mirror_y`: every odd repeat reversed. */
  useMirrorX?: boolean;
  useMirrorY?: boolean;
  /** RNA `crop_min_x` … `crop_max_y`. Default 0, 0, 1, 1. */
  cropMinX?: number;
  cropMinY?: number;
  cropMaxX?: number;
  cropMaxY?: number;
  /** RNA `use_flip_axis`: swap x and y (`TEX_IMAROT`). */
  useFlipAxis?: boolean;
  /** RNA `use_alpha` (`TEX_USEALPHA`). Default **true**. */
  useAlpha?: boolean;
  /** RNA `use_calculate_alpha` (`TEX_CALCALPHA`): alpha is the largest of r, g, b. */
  useCalculateAlpha?: boolean;
  /** RNA `invert_alpha` (`TEX_NEGALPHA`). */
  invertAlpha?: boolean;
  /** RNA `checker_distance` (0..0.99), `CHECKER` only. Default 0. */
  checkerDistance?: number;
  /** RNA `use_checker_odd` (default on) / `use_checker_even` (default **off**). */
  useCheckerOdd?: boolean;
  useCheckerEven?: boolean;
  /** RNA `intensity`, `contrast`, `saturation`, `factor_red/green/blue`, `use_clamp` — as for every texture. */
  intensity?: number;
  contrast?: number;
  saturation?: number;
  factorRed?: number;
  factorGreen?: number;
  factorBlue?: number;
  useClamp?: boolean;
  /** RNA `use_color_ramp`: the ramp is read at the image's alpha (`tin`), see `TextureCommon.colorRamp`. */
  colorRamp?: ColorRamp;
}

interface Rect {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

type Rgba = [number, number, number, number];

/** `ibuf_get_color` for a byte buffer: straight bytes made pre-multiplied. */
function getColor(img: TextureImage, x: number, y: number): Rgba {
  const o = 4 * (y * img.width + x);
  const k = f(1 / 255);
  const a = f(img.data[o + 3]! * k);
  return [f(f(img.data[o]! * k) * a), f(f(img.data[o + 1]! * k) * a), f(f(img.data[o + 2]! * k) * a), a];
}

function rectSizeX(r: Rect): number {
  return f(r.xmax - r.xmin);
}
function rectSizeY(r: Rect): number {
  return f(r.ymax - r.ymin);
}

/** `clipx_rctf_swap`: pieces of `stack` outside [x1, x2] wrapped to the other side. */
function clipxSwap(stack: Rect[], x1: number, x2: number): void {
  const n = stack.length;
  for (let a = 0; a < n; a++) {
    const rf = stack[a]!;
    if (rf.xmin < x1) {
      if (rf.xmax < x1) {
        rf.xmin = f(rf.xmin + f(x2 - x1));
        rf.xmax = f(rf.xmax + f(x2 - x1));
      } else {
        rf.xmax = Math.min(rf.xmax, x2);
        const nr: Rect = { xmax: x2, xmin: f(rf.xmin + f(x2 - x1)), ymin: rf.ymin, ymax: rf.ymax };
        if (nr.xmin !== nr.xmax) stack.push(nr);
        rf.xmin = x1;
      }
    } else if (rf.xmax > x2) {
      if (rf.xmin > x2) {
        rf.xmin = f(rf.xmin - f(x2 - x1));
        rf.xmax = f(rf.xmax - f(x2 - x1));
      } else {
        rf.xmin = Math.max(rf.xmin, x1);
        const nr: Rect = { xmin: x1, xmax: f(rf.xmax - f(x2 - x1)), ymin: rf.ymin, ymax: rf.ymax };
        if (nr.xmin !== nr.xmax) stack.push(nr);
        rf.xmax = x2;
      }
    }
  }
}

/** `clipy_rctf_swap`. */
function clipySwap(stack: Rect[], y1: number, y2: number): void {
  const n = stack.length;
  for (let a = 0; a < n; a++) {
    const rf = stack[a]!;
    if (rf.ymin < y1) {
      if (rf.ymax < y1) {
        rf.ymin = f(rf.ymin + f(y2 - y1));
        rf.ymax = f(rf.ymax + f(y2 - y1));
      } else {
        rf.ymax = Math.min(rf.ymax, y2);
        const nr: Rect = { ymax: y2, ymin: f(rf.ymin + f(y2 - y1)), xmin: rf.xmin, xmax: rf.xmax };
        if (nr.ymin !== nr.ymax) stack.push(nr);
        rf.ymin = y1;
      }
    } else if (rf.ymax > y2) {
      if (rf.ymin > y2) {
        rf.ymin = f(rf.ymin - f(y2 - y1));
        rf.ymax = f(rf.ymax - f(y2 - y1));
      } else {
        rf.ymin = Math.max(rf.ymin, y1);
        const nr: Rect = { ymin: y1, ymax: f(rf.ymax - f(y2 - y1)), xmin: rf.xmin, xmax: rf.xmax };
        if (nr.ymin !== nr.ymax) stack.push(nr);
        rf.ymax = y2;
      }
    }
  }
}

/** `clipx_rctf`: clip to [x1, x2]; returns the fraction of the width that was inside. */
function clipx(rf: Rect, x1: number, x2: number): number {
  const size = rectSizeX(rf);
  rf.xmin = Math.max(rf.xmin, x1);
  rf.xmax = Math.min(rf.xmax, x2);
  if (rf.xmin > rf.xmax) {
    rf.xmin = rf.xmax;
    return 0;
  }
  if (size !== 0) return f(rectSizeX(rf) / size);
  return 1;
}

function clipy(rf: Rect, y1: number, y2: number): number {
  const size = rectSizeY(rf);
  rf.ymin = Math.max(rf.ymin, y1);
  rf.ymax = Math.min(rf.ymax, y2);
  if (rf.ymin > rf.ymax) {
    rf.ymin = rf.ymax;
    return 0;
  }
  if (size !== 0) return f(rectSizeY(rf) / size);
  return 1;
}

/** `boxsampleclip`: the area-weighted average over a rect already inside the image. */
function boxsampleclip(img: TextureImage, rf: Rect): Rgba {
  let startx = Math.floor(rf.xmin);
  let endx = Math.floor(rf.xmax);
  let starty = Math.floor(rf.ymin);
  let endy = Math.floor(rf.ymax);
  startx = Math.max(startx, 0);
  starty = Math.max(starty, 0);
  if (endx >= img.width) endx = img.width - 1;
  if (endy >= img.height) endy = img.height - 1;

  if (starty === endy && startx === endx) return getColor(img, startx, starty);

  const out: Rgba = [0, 0, 0, 0];
  let div = 0;
  const madd = (col: Rgba, k: number): void => {
    for (let i = 0; i < 4; i++) out[i] = f(out[i]! + f(col[i]! * k));
  };
  for (let y = starty; y <= endy; y++) {
    let muly = 1;
    if (starty !== endy) {
      if (y === starty) muly = f(1 - f(rf.ymin - y));
      if (y === endy) muly = f(rf.ymax - y);
    }
    if (startx === endx) {
      const mulx = muly;
      madd(getColor(img, startx, y), mulx);
      div = f(div + mulx);
    } else {
      for (let x = startx; x <= endx; x++) {
        let mulx = muly;
        if (x === startx) mulx = f(mulx * f(1 - f(rf.xmin - x)));
        if (x === endx) mulx = f(mulx * f(rf.xmax - x));
        const col = getColor(img, x, y);
        if (mulx === 1) {
          for (let i = 0; i < 4; i++) out[i] = f(out[i]! + col[i]!);
          div = f(div + 1);
        } else {
          madd(col, mulx);
          div = f(div + mulx);
        }
      }
    }
  }
  if (div !== 0) {
    const inv = f(1 / div);
    for (let i = 0; i < 4; i++) out[i] = f(out[i]! * inv);
    return out;
  }
  return [0, 0, 0, 0];
}

/** `boxsample`: the box [minx, maxx] × [miny, maxy] (in 0..1 of the image), wrapped or clamped as asked. */
function boxsample(
  img: TextureImage,
  minx: number,
  miny: number,
  maxx: number,
  maxy: number,
  talpha: boolean,
  repeat: boolean,
  extend: boolean,
): Rgba {
  const first: Rect = {
    xmin: f(minx * img.width),
    xmax: f(maxx * img.width),
    ymin: f(miny * img.height),
    ymax: f(maxy * img.height),
  };
  const stack: Rect[] = [first];
  let alphaclip = 1;
  const clampTo = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);
  if (extend) {
    first.xmin = clampTo(first.xmin, img.width - 1);
    first.xmax = clampTo(first.xmax, img.width - 1);
  } else if (repeat) {
    clipxSwap(stack, 0, img.width);
  } else {
    alphaclip = clipx(first, 0, img.width);
    if (alphaclip <= 0) return [0, 0, 0, 0];
  }
  if (extend) {
    first.ymin = clampTo(first.ymin, img.height - 1);
    first.ymax = clampTo(first.ymax, img.height - 1);
  } else if (repeat) {
    clipySwap(stack, 0, img.height);
  } else {
    alphaclip = f(alphaclip * clipy(first, 0, img.height));
    if (alphaclip <= 0) return [0, 0, 0, 0];
  }

  let res: Rgba;
  if (stack.length > 1) {
    res = [0, 0, 0, 0];
    let tot = 0;
    for (const rf of stack) {
      const c = boxsampleclip(img, rf);
      const opp = f(rectSizeX(rf) * rectSizeY(rf));
      tot = f(tot + opp);
      for (let i = 0; i < 3; i++) res[i] = f(res[i]! + f(opp * c[i]!));
      if (talpha) res[3] = f(res[3]! + f(opp * c[3]!));
    }
    if (tot !== 0) {
      for (let i = 0; i < 3; i++) res[i] = f(res[i]! / tot);
      if (talpha) res[3] = f(res[3]! / tot);
    }
  } else res = boxsampleclip(img, first);

  if (!talpha) res[3] = 1;
  if (alphaclip !== 1) for (let i = 0; i < 4; i++) res[i] = f(res[i]! * alphaclip);
  return res;
}

/** Everything `imagewrap` leaves in `TexResult`: the colour and alpha, before `BKE_texture_get_value` averages. */
export interface ImageSample {
  color: [number, number, number];
  alpha: number;
  /** `texres->tin`: the alpha **before** `invert_alpha` (what a colour ramp reads). */
  tin: number;
}

/**
 * `do_2d_mapping` (flat, no `MTex`) and `imagewrap`, up to but not including
 * `BRICONTRGB`: the colour the image gives at the modifier's coordinate `co`.
 * `null` where `imagewrap` returns early (no image, outside a clipped image, a skipped checker
 * square) — it leaves every channel 0 and skips `BRICONTRGB`.
 */
export function sampleImage(t: ImageTextureSettings, co: readonly [number, number, number]): ImageSample | null {
  const img = t.image;
  if (!img || img.width <= 0 || img.height <= 0) return null;
  const extension = t.extension ?? "REPEAT";

  // do_2d_mapping, MTEX_FLAT.
  let fx = f(f(co[0] + 1) / 2);
  let fy = f(f(co[1] + 1) / 2);
  if (extension === "REPEAT") {
    const xrep = t.repeatX ?? 1;
    if (xrep > 1) {
      const orig = (fx = f(fx * xrep));
      if (fx > 1) fx = f(fx - Math.trunc(fx));
      else if (fx < 0) fx = f(fx + (1 - Math.trunc(fx)));
      if (t.useMirrorX && Math.floor(orig) & 1) fx = f(1 - fx);
    }
    const yrep = t.repeatY ?? 1;
    if (yrep > 1) {
      const orig = (fy = f(fy * yrep));
      if (fy > 1) fy = f(fy - Math.trunc(fy));
      else if (fy < 0) fy = f(fy + (1 - Math.trunc(fy)));
      if (t.useMirrorY && Math.floor(orig) & 1) fy = f(1 - fy);
    }
  }
  const cxmin = f(t.cropMinX ?? 0);
  const cxmax = f(t.cropMaxX ?? 1);
  const cymin = f(t.cropMinY ?? 0);
  const cymax = f(t.cropMaxY ?? 1);
  if (cxmin !== 0 || cxmax !== 1) fx = f(cxmin + f(fx * f(cxmax - cxmin)));
  if (cymin !== 0 || cymax !== 1) fy = f(cymin + f(fy * f(cymax - cymin)));

  // imagewrap.
  if (t.useFlipAxis) [fx, fy] = [fy, fx];
  if (extension === "CHECKER") {
    const xs = Math.floor(fx);
    const ys = Math.floor(fy);
    fx = f(fx - xs);
    fy = f(fy - ys);
    // The C's naming is crossed: with `use_checker_odd` off the squares where xs + ys is even are
    // dropped, with `use_checker_even` off those where it is odd. Defaults: odd on, even off.
    const sumOdd = ((xs + ys) & 1) === 1;
    if (!(t.useCheckerOdd ?? true) && !sumOdd) return null;
    if (!(t.useCheckerEven ?? false) && sumOdd) return null;
    const dist = f(t.checkerDistance ?? 0);
    if (dist < 1) {
      fx = f(f(f(fx - 0.5) / f(1 - dist)) + 0.5);
      fy = f(f(f(fy - 0.5) / f(1 - dist)) + 0.5);
    }
  }
  const xi = Math.floor(f(fx * img.width));
  const yi = Math.floor(f(fy * img.height));
  let x = xi;
  let y = yi;
  const outside = x < 0 || y < 0 || x >= img.width || y >= img.height;
  if (extension === "CLIP_CUBE") {
    if (outside || co[2] < -1 || co[2] > 1) return null;
  } else if (extension === "CLIP" || extension === "CHECKER") {
    if (outside) return null;
  } else if (extension === "EXTEND") {
    x = x >= img.width ? img.width - 1 : x < 0 ? 0 : x;
    y = y >= img.height ? img.height - 1 : y < 0 ? 0 : y;
  } else {
    x %= img.width;
    if (x < 0) x += img.width;
    y %= img.height;
    if (y < 0) y += img.height;
  }

  const useAlpha = t.useAlpha ?? true;
  const calcAlpha = t.useCalculateAlpha ?? false;
  // `ima->alpha_mode != IMA_ALPHA_IGNORE` holds for a straight-alpha image, the only kind built here.
  const talpha = useAlpha && !calcAlpha;

  let col: Rgba;
  if (t.useInterpolation ?? true) {
    const size = f(t.filterSize ?? 1);
    const filterx = f(f(0.5 * size) / img.width);
    const filtery = f(f(0.5 * size) / img.height);
    fx = f(fx - f((xi - x) / img.width));
    fy = f(fy - f((yi - y) / img.height));
    col = boxsample(
      img,
      f(fx - filterx),
      f(fy - filtery),
      f(fx + filterx),
      f(fy + filtery),
      talpha,
      extension === "REPEAT",
      extension === "EXTEND",
    );
  } else col = getColor(img, x, y);

  let alpha: number;
  if (talpha) alpha = col[3];
  else if (calcAlpha) alpha = f(Math.max(col[0], col[1], col[2]));
  else alpha = 1;
  col[3] = alpha;
  const tin = alpha;
  if (t.invertAlpha) col[3] = f(1 - col[3]);
  // De-pre-multiply, unless the alpha was generated.
  if (col[3] !== 1 && col[3] > f(1e-4) && !calcAlpha) {
    const inv = f(1 / col[3]);
    for (let i = 0; i < 3; i++) col[i] = f(col[i]! * inv);
  }
  return { color: [col[0], col[1], col[2]], alpha: col[3], tin };
}
