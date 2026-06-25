import { describe, it, expect } from "vitest";
import {
  hexToRgb,
  valueNoise,
  evaluateAlbedoAt,
  evaluateMaterialAt,
  hasMetallicRoughnessChannel,
  hasNormalChannel,
  bakeAlbedo,
  bakeMetallicRoughness,
  bakeNormalMap,
  makeNoiseGraph,
  makeVoronoiGraph,
  makeBrickGraph,
  makeCheckerGraph,
  makeGradientGraph,
  makePresetGraph,
  type ProceduralGraph,
} from "./procedural-graph";

describe("hexToRgb", () => {
  it("parses 6-digit hex to 0..1", () => {
    expect(hexToRgb("#ff0000")).toEqual([1, 0, 0]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    const g = hexToRgb("#808080");
    expect(g[0]).toBeCloseTo(0.5019, 3);
  });
  it("expands 3-digit hex", () => {
    expect(hexToRgb("#f00")).toEqual([1, 0, 0]);
  });
  it("falls back on garbage", () => {
    expect(hexToRgb("nope", [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
    expect(hexToRgb(undefined, [0.4, 0.4, 0.4])).toEqual([0.4, 0.4, 0.4]);
  });
});

describe("valueNoise", () => {
  it("is deterministic", () => {
    expect(valueNoise(1.3, 2.7, 0)).toBe(valueNoise(1.3, 2.7, 0));
  });
  it("stays within [0,1]", () => {
    for (let i = 0; i < 50; i++) {
      const n = valueNoise(i * 0.37, i * 1.13, 5);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });
  it("varies with seed", () => {
    expect(valueNoise(1.3, 2.7, 0)).not.toBe(valueNoise(1.3, 2.7, 1));
  });
});

describe("checker graph", () => {
  const g = makeCheckerGraph({ scale: 2, colorA: "#000000", colorB: "#ffffff" });
  it("alternates cells", () => {
    // scale 2 → cells at u/v in [0,0.5) vs [0.5,1).
    const c00 = evaluateAlbedoAt(g, 0.25, 0.25); // floor(0.5)+floor(0.5)=0 → colorA black
    const c10 = evaluateAlbedoAt(g, 0.75, 0.25); // 1+0=1 → colorB white
    expect(c00[0]).toBeCloseTo(0, 5);
    expect(c10[0]).toBeCloseTo(1, 5);
  });
});

describe("gradient graph", () => {
  it("ramps from colorA at u=0 to colorB at u=1", () => {
    const g = makeGradientGraph({ axis: 0, colorA: "#000000", colorB: "#ffffff" });
    expect(evaluateAlbedoAt(g, 0, 0.5)[0]).toBeCloseTo(0, 5);
    expect(evaluateAlbedoAt(g, 1, 0.5)[0]).toBeCloseTo(1, 5);
    expect(evaluateAlbedoAt(g, 0.5, 0.5)[0]).toBeCloseTo(0.5, 2);
  });
  it("respects the V axis", () => {
    const g = makeGradientGraph({ axis: 1, colorA: "#000000", colorB: "#ffffff" });
    expect(evaluateAlbedoAt(g, 0.5, 0)[0]).toBeCloseTo(0, 5);
    expect(evaluateAlbedoAt(g, 0.5, 1)[0]).toBeCloseTo(1, 5);
  });
});

describe("noise graph", () => {
  it("produces colours within the ramp range", () => {
    const g = makeNoiseGraph({ scale: 6, colorA: "#000000", colorB: "#ffffff", seed: 3 });
    for (let i = 0; i < 20; i++) {
      const c = evaluateAlbedoAt(g, (i * 7) % 13 / 13, (i * 5) % 11 / 11);
      for (const ch of c) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("bakeAlbedo", () => {
  const g = makeCheckerGraph({ scale: 2, colorA: "#000000", colorB: "#ffffff" });

  it("produces an RGBA buffer of the right size with opaque alpha", () => {
    const size = 8;
    const buf = bakeAlbedo(g, size);
    expect(buf).toHaveLength(size * size * 4);
    for (let i = 3; i < buf.length; i += 4) expect(buf[i]).toBe(255);
  });

  it("is deterministic", () => {
    const a = bakeAlbedo(g, 8);
    const b = bakeAlbedo(g, 8);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("bakes the checker pattern (corners differ)", () => {
    const size = 8;
    const buf = bakeAlbedo(g, size);
    // top-left texel (u,v≈0.06) is cell (0,0) → black; texel near u≈0.56 is white.
    const topLeft = buf[0]!;
    const idxRight = (0 * size + Math.floor(size * 0.75)) * 4;
    expect(topLeft).toBeLessThan(10);
    expect(buf[idxRight]!).toBeGreaterThan(245);
  });
});

describe("voronoi graph", () => {
  const g = makeVoronoiGraph({ scale: 5, colorA: "#000000", colorB: "#ffffff", seed: 1 });
  it("stays within the ramp range and is deterministic", () => {
    for (let i = 0; i < 20; i++) {
      const u = (i * 3) % 17 / 17;
      const v = (i * 7) % 13 / 13;
      const c = evaluateAlbedoAt(g, u, v);
      expect(c[0]).toBeGreaterThanOrEqual(0);
      expect(c[0]).toBeLessThanOrEqual(1);
      expect(evaluateAlbedoAt(g, u, v)[0]).toBeCloseTo(c[0], 10);
    }
  });
});

describe("brick graph", () => {
  const g = makeBrickGraph({ scale: 4, contrast: 0.1, colorA: "#000000", colorB: "#ffffff" });
  it("returns mortar (colorA) near a row edge and brick (colorB) in the body", () => {
    // v just inside a row boundary → mortar (dark); mid-cell → brick (light).
    const mortar = evaluateAlbedoAt(g, 0.5, 0.01); // rowFrac ~0.04 < 0.1 → mortar
    const brick = evaluateAlbedoAt(g, 0.6, 0.6); // mid-cell, off edges → brick
    expect(mortar[0]).toBeLessThan(0.2);
    expect(brick[0]).toBeGreaterThan(0.8);
  });
});

describe("metallic-roughness channel", () => {
  it("is absent unless the output drives roughness/metallic", () => {
    const plain = makeNoiseGraph({});
    expect(hasMetallicRoughnessChannel(plain)).toBe(false);
    expect(bakeMetallicRoughness(plain, 8)).toBeNull();
  });

  it("is present and baked when roughness is wired from the pattern", () => {
    const g = makeNoiseGraph({ roughness: true, scale: 6 });
    expect(hasMetallicRoughnessChannel(g)).toBe(true);
    const buf = bakeMetallicRoughness(g, 8)!;
    expect(buf).not.toBeNull();
    expect(buf).toHaveLength(8 * 8 * 4);
    // R = AO white, A opaque; G (roughness) varies with the pattern.
    for (let i = 0; i < buf.length; i += 4) {
      expect(buf[i]).toBe(255); // R / AO
      expect(buf[i + 3]).toBe(255); // alpha
    }
  });

  it("evaluateMaterialAt reports roughness only when connected", () => {
    const withR = makeNoiseGraph({ roughness: true });
    const withoutR = makeNoiseGraph({});
    expect(evaluateMaterialAt(withR, 0.3, 0.7).roughness).not.toBeNull();
    expect(evaluateMaterialAt(withoutR, 0.3, 0.7).roughness).toBeNull();
    expect(evaluateMaterialAt(withoutR, 0.3, 0.7).metallic).toBeNull();
  });
});

describe("math node", () => {
  const build = (op: number, aVal: number, bVal: number): ProceduralGraph => ({
    resolution: 4,
    outputId: "out",
    nodes: [
      { id: "a", type: "constFloat", params: { value: aVal } },
      { id: "m", type: "math", params: { op, value: bVal }, inputs: { a: "a" } },
      { id: "ramp", type: "colorRamp", params: { colorA: "#000000", colorB: "#ffffff" }, inputs: { fac: "m" } },
      { id: "out", type: "output", inputs: { albedo: "ramp" } },
    ],
  });
  // The ramp maps fac 0→black, 1→white, so albedo R reads the math result clamped to [0,1].
  const r = (op: number, a: number, b: number) => evaluateAlbedoAt(build(op, a, b), 0.5, 0.5)[0];

  it("adds, subtracts, multiplies", () => {
    expect(r(0, 0.3, 0.4)).toBeCloseTo(0.7, 3); // add
    expect(r(1, 0.9, 0.4)).toBeCloseTo(0.5, 3); // sub
    expect(r(2, 0.5, 0.5)).toBeCloseTo(0.25, 3); // mul
  });
  it("min / max / avg", () => {
    expect(r(3, 0.2, 0.8)).toBeCloseTo(0.2, 3);
    expect(r(4, 0.2, 0.8)).toBeCloseTo(0.8, 3);
    expect(r(5, 0.2, 0.8)).toBeCloseTo(0.5, 3);
  });
  it("uses the scalar param when b is unconnected", () => {
    expect(r(2, 0.6, 0.5)).toBeCloseTo(0.3, 3); // 0.6 * 0.5
  });
});

describe("mix blend modes", () => {
  const build = (op: number, fac: number): ProceduralGraph => ({
    resolution: 4,
    outputId: "out",
    nodes: [
      { id: "a", type: "constColor", params: { colorA: "#400000" } }, // r=0.25
      { id: "b", type: "constColor", params: { colorA: "#800000" } }, // r=0.5
      { id: "f", type: "constFloat", params: { value: fac } },
      { id: "mix", type: "mix", params: { op }, inputs: { a: "a", b: "b", fac: "f" } },
      { id: "out", type: "output", inputs: { albedo: "mix" } },
    ],
  });
  const red = (op: number, fac: number) => evaluateAlbedoAt(build(op, fac), 0.5, 0.5)[0];

  it("fac=0 returns a for every mode", () => {
    for (const op of [0, 1, 2, 3]) expect(red(op, 0)).toBeCloseTo(0.25, 2);
  });
  it("mix (op0) lerps toward b", () => {
    expect(red(0, 1)).toBeCloseTo(0.5, 2);
  });
  it("add (op1) at fac=1 sums", () => {
    expect(red(1, 1)).toBeCloseTo(0.75, 2); // 0.25 + 0.5
  });
  it("multiply (op2) at fac=1 multiplies", () => {
    expect(red(2, 1)).toBeCloseTo(0.125, 2); // 0.25 * 0.5
  });
});

describe("normal channel", () => {
  it("is absent unless the output drives height", () => {
    const plain = makeNoiseGraph({});
    expect(hasNormalChannel(plain)).toBe(false);
    expect(bakeNormalMap(plain, 8)).toBeNull();
  });

  it("bakes a normal map flat (≈0,0,1) for a constant height field", () => {
    // Checker at scale 1 over [0,1) is a single constant cell → zero gradient.
    const g: ProceduralGraph = {
      resolution: 8,
      outputId: "out",
      nodes: [
        { id: "uv", type: "uv" },
        { id: "src", type: "checker", params: { scale: 1 }, inputs: { uv: "uv" } },
        { id: "ramp", type: "colorRamp", inputs: { fac: "src" } },
        { id: "out", type: "output", inputs: { albedo: "ramp", height: "src" }, params: { value: 1 } },
      ],
    };
    const buf = bakeNormalMap(g, 8)!;
    expect(buf).not.toBeNull();
    // Interior texel: flat → R≈128, G≈128, B≈255.
    const i = (4 * 8 + 4) * 4;
    expect(buf[i]).toBeGreaterThan(120);
    expect(buf[i]).toBeLessThan(136);
    expect(buf[i + 1]).toBeGreaterThan(120);
    expect(buf[i + 1]).toBeLessThan(136);
    expect(buf[i + 2]).toBeGreaterThan(250);
  });

  it("tilts the normal along a height gradient (U-gradient → R shifts, B dominant)", () => {
    const g: ProceduralGraph = {
      resolution: 16,
      outputId: "out",
      nodes: [
        { id: "uv", type: "uv" },
        { id: "src", type: "gradient", params: { axis: 0 }, inputs: { uv: "uv" } }, // height = u
        { id: "ramp", type: "colorRamp", inputs: { fac: "src" } },
        { id: "out", type: "output", inputs: { albedo: "ramp", height: "src" }, params: { value: 2 } },
      ],
    };
    const buf = bakeNormalMap(g, 16)!;
    const i = (8 * 16 + 8) * 4; // interior texel
    // Height rises with u → normal tilts so R (x) < 128, G (y) ≈ 128, B largest.
    expect(buf[i]).toBeLessThan(128);
    expect(buf[i + 1]).toBeGreaterThan(120);
    expect(buf[i + 1]).toBeLessThan(136);
    expect(buf[i + 2]).toBeGreaterThan(buf[i]!);
    expect(buf[i + 3]).toBe(255);
  });

  it("preset wires height only when normal requested", () => {
    const out = (g: ProceduralGraph) => g.nodes.find((n) => n.id === g.outputId)!;
    expect(out(makeNoiseGraph({ normal: true })).inputs?.height).toBe("src");
    expect(out(makeNoiseGraph({})).inputs?.height).toBeUndefined();
    expect(out(makeNoiseGraph({ normal: true, normalStrength: 3 })).params?.value).toBe(3);
  });
});

describe("makePresetGraph", () => {
  it("dispatches by kind and defaults to noise", () => {
    expect(makePresetGraph("checker").nodes.some((n) => n.type === "checker")).toBe(true);
    expect(makePresetGraph("gradient").nodes.some((n) => n.type === "gradient")).toBe(true);
    expect(makePresetGraph("noise").nodes.some((n) => n.type === "noise")).toBe(true);
    expect(makePresetGraph("voronoi").nodes.some((n) => n.type === "voronoi")).toBe(true);
    expect(makePresetGraph("brick").nodes.some((n) => n.type === "brick")).toBe(true);
  });
  it("carries resolution through", () => {
    const g: ProceduralGraph = makePresetGraph("noise", { resolution: 128 });
    expect(g.resolution).toBe(128);
  });
  it("wires roughness output only when requested", () => {
    const out = (g: ProceduralGraph) => g.nodes.find((n) => n.id === g.outputId)!;
    expect(out(makePresetGraph("brick", { roughness: true })).inputs?.roughness).toBe("src");
    expect(out(makePresetGraph("brick", {})).inputs?.roughness).toBeUndefined();
  });
});
