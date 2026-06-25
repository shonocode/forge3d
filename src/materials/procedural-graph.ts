/**
 * Procedural material node graph — pure, headless core.
 *
 * A small node graph (UV → mapping → noise/checker/gradient → colorRamp/mix →
 * output) that is **evaluated on the CPU per texel** to bake an albedo texture.
 * The baked texture plugs straight into the existing PBR material (and exports
 * cleanly in glTF), so procedural materials need no custom shader pipeline.
 *
 * Everything here is deterministic and scene-free so it can be unit-tested.
 * The scene plumbing (RawTexture creation, material assignment, undo) lives in
 * `procedural-material.ts`.
 */

export type ProcNodeType =
  | "uv"
  | "mapping"
  | "noise"
  | "voronoi"
  | "brick"
  | "checker"
  | "gradient"
  | "colorRamp"
  | "mix"
  | "math"
  | "constColor"
  | "constFloat"
  | "output";

export interface ProcParams {
  scale?: number;
  scaleY?: number;
  offsetX?: number;
  offsetY?: number;
  rotation?: number; // radians
  contrast?: number;
  seed?: number;
  colorA?: string; // hex
  colorB?: string; // hex
  value?: number; // constFloat, or math's scalar second operand
  axis?: number; // gradient: 0 = U, 1 = V
  /** Operation selector — math (0 add,1 sub,2 mul,3 min,4 max,5 avg) / mix (0 mix,1 add,2 mul,3 screen). */
  op?: number;
}

export interface ProcNode {
  id: string;
  type: ProcNodeType;
  params?: ProcParams;
  /** Named input ports → source node id (or null/absent when unconnected). */
  inputs?: Record<string, string | null>;
  /** Canvas position for the node editor (px). Optional; ignored by evaluation. */
  x?: number;
  y?: number;
}

export interface ProceduralGraph {
  nodes: ProcNode[];
  /** Id of the `output` node (root of evaluation). */
  outputId: string;
  /** Baked texture resolution (px, square). */
  resolution: number;
}

/** RGB in 0..1. */
export type RGB = [number, number, number];

/** A value flowing through the graph: a scalar or an RGB colour. */
export type ProcValue = { kind: "float"; v: number } | { kind: "color"; v: RGB };

// ── colour helpers ──

export function hexToRgb(hex: string | undefined, fallback: RGB = [0, 0, 0]): RGB {
  if (!hex) return fallback;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  if (h.length !== 6) return fallback;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return fallback;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function asFloat(val: ProcValue): number {
  if (val.kind === "float") return val.v;
  // Luminance of a colour.
  return 0.2126 * val.v[0] + 0.7152 * val.v[1] + 0.0722 * val.v[2];
}

function asColor(val: ProcValue): RGB {
  if (val.kind === "color") return val.v;
  return [val.v, val.v, val.v];
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (t: number): number => t * t * (3 - 2 * t);

// ── deterministic value noise ──

/** Integer hash → [0,1). Deterministic, no Math.random. */
function hash2(x: number, y: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1442695041;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** 2D value noise in [0,1]. */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smooth(xf);
  const v = smooth(yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

// ── evaluation ──

export interface EvalContext {
  u: number;
  v: number;
}

/** Read a coordinate from a node's `uv` input, defaulting to the context UV. */
function coordOf(
  graph: ProceduralGraph,
  node: ProcNode,
  ctx: EvalContext,
  memo: Map<string, ProcValue>
): [number, number] {
  const src = node.inputs?.uv;
  if (src) {
    const c = asColor(evalNode(graph, src, ctx, memo));
    return [c[0], c[1]];
  }
  return [ctx.u, ctx.v];
}

function evalNode(
  graph: ProceduralGraph,
  nodeId: string,
  ctx: EvalContext,
  memo: Map<string, ProcValue>
): ProcValue {
  const cached = memo.get(nodeId);
  if (cached) return cached;

  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { kind: "float", v: 0 };
  const p = node.params ?? {};

  let out: ProcValue;
  switch (node.type) {
    case "uv": {
      out = { kind: "color", v: [ctx.u, ctx.v, 0] };
      break;
    }
    case "mapping": {
      const [cu, cv] = coordOf(graph, node, ctx, memo);
      const sx = p.scale ?? 1;
      const sy = p.scaleY ?? p.scale ?? 1;
      const rot = p.rotation ?? 0;
      // scale about (0.5,0.5), then rotate, then offset.
      let x = (cu - 0.5) * sx;
      let y = (cv - 0.5) * sy;
      if (rot) {
        const cs = Math.cos(rot);
        const sn = Math.sin(rot);
        const rx = x * cs - y * sn;
        const ry = x * sn + y * cs;
        x = rx;
        y = ry;
      }
      out = { kind: "color", v: [x + 0.5 + (p.offsetX ?? 0), y + 0.5 + (p.offsetY ?? 0), 0] };
      break;
    }
    case "noise": {
      const [cu, cv] = coordOf(graph, node, ctx, memo);
      const scale = p.scale ?? 8;
      let n = valueNoise(cu * scale, cv * scale, p.seed ?? 0);
      const contrast = p.contrast ?? 1;
      if (contrast !== 1) n = clamp01((n - 0.5) * contrast + 0.5);
      out = { kind: "float", v: n };
      break;
    }
    case "voronoi": {
      const [cu, cv] = coordOf(graph, node, ctx, memo);
      const scale = p.scale ?? 6;
      const seed = p.seed ?? 0;
      const x = cu * scale;
      const y = cv * scale;
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      // Worley F1: distance to the nearest per-cell feature point in the 3×3
      // neighbourhood. Normalized so a cell-sized gap maps to ~1.
      let minD = Infinity;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = xi + ox;
          const cy = yi + oy;
          const fx = cx + hash2(cx, cy, seed);
          const fy = cy + hash2(cx, cy, seed + 9871);
          const dx = fx - x;
          const dy = fy - y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < minD) minD = d;
        }
      }
      let f = clamp01(minD);
      const contrast = p.contrast ?? 1;
      if (contrast !== 1) f = clamp01((f - 0.5) * contrast + 0.5);
      out = { kind: "float", v: f };
      break;
    }
    case "brick": {
      const [cu, cv] = coordOf(graph, node, ctx, memo);
      const scale = p.scale ?? 6; // rows
      const mortar = p.contrast ?? 0.08; // reuse contrast as mortar thickness
      const ratio = 2; // brick width : height
      const row = cv * scale;
      const ri = Math.floor(row);
      const rowFrac = row - ri;
      const offset = ri & 1 ? 0.5 : 0; // running bond
      const col = (cu * scale) / ratio + offset;
      const colFrac = col - Math.floor(col);
      const inMortar = rowFrac < mortar || colFrac < mortar;
      out = { kind: "float", v: inMortar ? 0 : 1 };
      break;
    }
    case "checker": {
      const [cu, cv] = coordOf(graph, node, ctx, memo);
      const scale = p.scale ?? 8;
      const cx = Math.floor(cu * scale);
      const cy = Math.floor(cv * scale);
      out = { kind: "float", v: (cx + cy) & 1 ? 1 : 0 };
      break;
    }
    case "gradient": {
      const [cu, cv] = coordOf(graph, node, ctx, memo);
      out = { kind: "float", v: clamp01(p.axis === 1 ? cv : cu) };
      break;
    }
    case "colorRamp": {
      const fac = clamp01(asFloat(node.inputs?.fac ? evalNode(graph, node.inputs.fac, ctx, memo) : { kind: "float", v: 0 }));
      const a = hexToRgb(p.colorA, [0, 0, 0]);
      const b = hexToRgb(p.colorB, [1, 1, 1]);
      out = { kind: "color", v: [lerp(a[0], b[0], fac), lerp(a[1], b[1], fac), lerp(a[2], b[2], fac)] };
      break;
    }
    case "mix": {
      const fac = clamp01(asFloat(node.inputs?.fac ? evalNode(graph, node.inputs.fac, ctx, memo) : { kind: "float", v: 0.5 }));
      const a = asColor(node.inputs?.a ? evalNode(graph, node.inputs.a, ctx, memo) : { kind: "color", v: [0, 0, 0] });
      const b = asColor(node.inputs?.b ? evalNode(graph, node.inputs.b, ctx, memo) : { kind: "color", v: [1, 1, 1] });
      const op = p.op ?? 0;
      // Per channel: blend a toward op(a,b) by fac. op 0 (mix) → b, so lerp(a,b,fac).
      const blend = (ca: number, cb: number): number => {
        switch (op) {
          case 1: return ca + cb; // add
          case 2: return ca * cb; // multiply
          case 3: return 1 - (1 - ca) * (1 - cb); // screen
          default: return cb; // mix
        }
      };
      out = {
        kind: "color",
        v: [lerp(a[0], blend(a[0], b[0]), fac), lerp(a[1], blend(a[1], b[1]), fac), lerp(a[2], blend(a[2], b[2]), fac)],
      };
      break;
    }
    case "math": {
      const a = asFloat(node.inputs?.a ? evalNode(graph, node.inputs.a, ctx, memo) : { kind: "float", v: 0 });
      const b = node.inputs?.b ? asFloat(evalNode(graph, node.inputs.b, ctx, memo)) : (p.value ?? 0.5);
      const op = p.op ?? 2;
      let r: number;
      switch (op) {
        case 0: r = a + b; break;
        case 1: r = a - b; break;
        case 3: r = Math.min(a, b); break;
        case 4: r = Math.max(a, b); break;
        case 5: r = (a + b) / 2; break;
        case 2:
        default: r = a * b; break;
      }
      out = { kind: "float", v: r };
      break;
    }
    case "constColor": {
      out = { kind: "color", v: hexToRgb(p.colorA, [0.5, 0.5, 0.5]) };
      break;
    }
    case "constFloat": {
      out = { kind: "float", v: p.value ?? 0 };
      break;
    }
    case "output": {
      const albedo = node.inputs?.albedo
        ? asColor(evalNode(graph, node.inputs.albedo, ctx, memo))
        : [0.5, 0.5, 0.5] as RGB;
      out = { kind: "color", v: albedo };
      break;
    }
    default:
      out = { kind: "float", v: 0 };
  }

  memo.set(nodeId, out);
  return out;
}

// ── preset graph builders ──
//
// These compose the node primitives into the common procedural patterns the
// MVP UI exposes. They are pure data factories so the UI (and tests) build the
// same graph the evaluator/baker consume.

export type ProcPresetKind = "noise" | "voronoi" | "brick" | "checker" | "gradient";

export interface PresetParams {
  scale?: number;
  contrast?: number;
  seed?: number;
  colorA?: string;
  colorB?: string;
  axis?: number;
  resolution?: number;
  /** Drive PBR roughness from the same pattern (bakes a metallic-roughness map). */
  roughness?: boolean;
  /** Drive a normal map from the pattern as a height field (bakes a normal map). */
  normal?: boolean;
  /** Bump strength when `normal` is set (default 1). */
  normalStrength?: number;
}

const DEFAULT_RES = 256;

/**
 * Build a preset's output node, wiring the colour ramp to albedo and
 * optionally the pattern float to roughness / height (normal). Bump strength
 * is stored as the output node's `value` param so re-baking is self-contained.
 */
function presetOutputNode(p: PresetParams): ProcNode {
  const inputs: Record<string, string | null> = { albedo: "ramp" };
  if (p.roughness) inputs.roughness = "src";
  if (p.normal) inputs.height = "src";
  const node: ProcNode = { id: "out", type: "output", inputs };
  if (p.normal) node.params = { value: p.normalStrength ?? 1 };
  return node;
}

/** Noise → colour-ramp albedo. */
export function makeNoiseGraph(p: PresetParams = {}): ProceduralGraph {
  return {
    resolution: p.resolution ?? DEFAULT_RES,
    outputId: "out",
    nodes: [
      { id: "uv", type: "uv" },
      {
        id: "src",
        type: "noise",
        params: { scale: p.scale ?? 8, contrast: p.contrast ?? 1.5, seed: p.seed ?? 0 },
        inputs: { uv: "uv" },
      },
      { id: "ramp", type: "colorRamp", params: { colorA: p.colorA ?? "#202020", colorB: p.colorB ?? "#d8d8d8" }, inputs: { fac: "src" } },
      presetOutputNode(p),
    ],
  };
}

/** Worley/voronoi cells → colour-ramp albedo. */
export function makeVoronoiGraph(p: PresetParams = {}): ProceduralGraph {
  return {
    resolution: p.resolution ?? DEFAULT_RES,
    outputId: "out",
    nodes: [
      { id: "uv", type: "uv" },
      {
        id: "src",
        type: "voronoi",
        params: { scale: p.scale ?? 6, contrast: p.contrast ?? 1, seed: p.seed ?? 0 },
        inputs: { uv: "uv" },
      },
      { id: "ramp", type: "colorRamp", params: { colorA: p.colorA ?? "#101822", colorB: p.colorB ?? "#88a0c0" }, inputs: { fac: "src" } },
      presetOutputNode(p),
    ],
  };
}

/** Brick pattern (mortar↔brick) → colour-ramp albedo. */
export function makeBrickGraph(p: PresetParams = {}): ProceduralGraph {
  return {
    resolution: p.resolution ?? DEFAULT_RES,
    outputId: "out",
    nodes: [
      { id: "uv", type: "uv" },
      {
        id: "src",
        type: "brick",
        params: { scale: p.scale ?? 6, contrast: p.contrast ?? 0.08 },
        inputs: { uv: "uv" },
      },
      { id: "ramp", type: "colorRamp", params: { colorA: p.colorA ?? "#cfcaba", colorB: p.colorB ?? "#8a3b2e" }, inputs: { fac: "src" } },
      presetOutputNode(p),
    ],
  };
}

/** Checkerboard → colour-ramp albedo. */
export function makeCheckerGraph(p: PresetParams = {}): ProceduralGraph {
  return {
    resolution: p.resolution ?? DEFAULT_RES,
    outputId: "out",
    nodes: [
      { id: "uv", type: "uv" },
      { id: "src", type: "checker", params: { scale: p.scale ?? 8 }, inputs: { uv: "uv" } },
      { id: "ramp", type: "colorRamp", params: { colorA: p.colorA ?? "#101010", colorB: p.colorB ?? "#e0e0e0" }, inputs: { fac: "src" } },
      presetOutputNode(p),
    ],
  };
}

/** Linear gradient → colour-ramp albedo. */
export function makeGradientGraph(p: PresetParams = {}): ProceduralGraph {
  return {
    resolution: p.resolution ?? DEFAULT_RES,
    outputId: "out",
    nodes: [
      { id: "uv", type: "uv" },
      { id: "src", type: "gradient", params: { axis: p.axis ?? 0 }, inputs: { uv: "uv" } },
      { id: "ramp", type: "colorRamp", params: { colorA: p.colorA ?? "#3050ff", colorB: p.colorB ?? "#ff5030" }, inputs: { fac: "src" } },
      presetOutputNode(p),
    ],
  };
}

export function makePresetGraph(kind: ProcPresetKind, p: PresetParams = {}): ProceduralGraph {
  switch (kind) {
    case "voronoi":
      return makeVoronoiGraph(p);
    case "brick":
      return makeBrickGraph(p);
    case "checker":
      return makeCheckerGraph(p);
    case "gradient":
      return makeGradientGraph(p);
    case "noise":
    default:
      return makeNoiseGraph(p);
  }
}

/** Evaluate the graph's output albedo colour at a single UV coordinate. */
export function evaluateAlbedoAt(graph: ProceduralGraph, u: number, v: number): RGB {
  const memo = new Map<string, ProcValue>();
  return asColor(evalNode(graph, graph.outputId, { u, v }, memo));
}

/**
 * Bake the graph's albedo channel to an RGBA byte buffer (row-major, top-left
 * origin), length `size*size*4`. Pure — no canvas or GPU.
 */
export function bakeAlbedo(graph: ProceduralGraph, size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const c = evaluateAlbedoAt(graph, u, v);
      const i = (py * size + px) * 4;
      out[i] = c[0] * 255;
      out[i + 1] = c[1] * 255;
      out[i + 2] = c[2] * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

export interface MaterialSample {
  albedo: RGB;
  /** null when the output has no roughness input. */
  roughness: number | null;
  /** null when the output has no metallic input. */
  metallic: number | null;
}

/** Evaluate albedo + optional roughness/metallic at one UV coordinate. */
export function evaluateMaterialAt(graph: ProceduralGraph, u: number, v: number): MaterialSample {
  const memo = new Map<string, ProcValue>();
  const ctx: EvalContext = { u, v };
  const outNode = graph.nodes.find((n) => n.id === graph.outputId);
  const albedo = outNode?.inputs?.albedo
    ? asColor(evalNode(graph, outNode.inputs.albedo, ctx, memo))
    : ([0.5, 0.5, 0.5] as RGB);
  const roughness = outNode?.inputs?.roughness
    ? clamp01(asFloat(evalNode(graph, outNode.inputs.roughness, ctx, memo)))
    : null;
  const metallic = outNode?.inputs?.metallic
    ? clamp01(asFloat(evalNode(graph, outNode.inputs.metallic, ctx, memo)))
    : null;
  return { albedo, roughness, metallic };
}

/** True when the graph's output drives a roughness and/or metallic channel. */
export function hasMetallicRoughnessChannel(graph: ProceduralGraph): boolean {
  const outNode = graph.nodes.find((n) => n.id === graph.outputId);
  return !!(outNode?.inputs?.roughness || outNode?.inputs?.metallic);
}

/**
 * Bake the glTF-standard metallic-roughness map (R = AO white, G = roughness,
 * B = metallic), or `null` when the graph drives neither channel. Defaults:
 * roughness 0.5, metallic 0 for any channel left unconnected.
 */
export function bakeMetallicRoughness(graph: ProceduralGraph, size: number): Uint8ClampedArray | null {
  if (!hasMetallicRoughnessChannel(graph)) return null;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const s = evaluateMaterialAt(graph, u, v);
      const i = (py * size + px) * 4;
      out[i] = 255; // AO (unused → white)
      out[i + 1] = (s.roughness ?? 0.5) * 255;
      out[i + 2] = (s.metallic ?? 0) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** True when the graph's output drives a height (normal map) channel. */
export function hasNormalChannel(graph: ProceduralGraph): boolean {
  return !!graph.nodes.find((n) => n.id === graph.outputId)?.inputs?.height;
}

/** Evaluate the output's height input at one UV, or `null` if unconnected. */
export function evaluateHeightAt(graph: ProceduralGraph, u: number, v: number): number | null {
  const outNode = graph.nodes.find((n) => n.id === graph.outputId);
  if (!outNode?.inputs?.height) return null;
  const memo = new Map<string, ProcValue>();
  return asFloat(evalNode(graph, outNode.inputs.height, { u, v }, memo));
}

/**
 * Bake a tangent-space normal map from the graph's height channel (R=x, G=y,
 * B=z, encoded to 0..255), or `null` when no height is wired. Normals come from
 * central differences of the height field; bump strength is read from the
 * output node's `value` param (default 1). Edge samples clamp to the border.
 */
export function bakeNormalMap(graph: ProceduralGraph, size: number): Uint8ClampedArray | null {
  if (!hasNormalChannel(graph)) return null;
  const strength = graph.nodes.find((n) => n.id === graph.outputId)?.params?.value ?? 1;

  const out = new Uint8ClampedArray(size * size * 4);
  const e = 1 / size;
  const at = (u: number, v: number): number =>
    evaluateHeightAt(graph, clamp01(u), clamp01(v)) ?? 0;

  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      // Gradient of height in UV space (central difference).
      const gradU = ((at(u + e, v) - at(u - e, v)) * size) / 2;
      const gradV = ((at(u, v + e) - at(u, v - e)) * size) / 2;
      let nx = -gradU * strength;
      let ny = -gradV * strength;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      const nzN = nz * inv;
      const i = (py * size + px) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nzN * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}
