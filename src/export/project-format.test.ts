import { describe, it, expect } from "vitest";
import {
  packProject,
  unpackProject,
  validateSidecar,
  float32ToBase64,
  base64ToFloat32,
  type ProjectSidecar,
} from "./project-format";

const SIDECAR: ProjectSidecar = {
  format: "forge3d-project",
  version: 1,
  meshes: [
    { name: "body", proceduralGraph: '{"format":"forge3d-procedural-graph"}', layerName: "Layer 1" },
    { name: "arm_L", sculptMask: float32ToBase64(new Float32Array([0, 0.5, 1])) },
  ],
  layers: [{ name: "Layer 1", visible: true }, { name: "BG", visible: false }],
  activeLayerName: "Layer 1",
};

describe("float32 base64 round-trip", () => {
  it("round-trips exactly, including large arrays", () => {
    const src = new Float32Array(70000); // beyond one btoa chunk
    for (let i = 0; i < src.length; i++) src[i] = Math.fround(i * 0.001 - 30);
    const back = base64ToFloat32(float32ToBase64(src));
    expect(back.length).toBe(src.length);
    expect(back[0]).toBe(src[0]);
    expect(back[69999]).toBe(src[69999]);
  });
});

describe("pack / unpack", () => {
  const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4, 5]);

  it("round-trips sidecar and GLB bytes exactly", () => {
    const packed = packProject(SIDECAR, glb);
    const { sidecar, glb: outGlb } = unpackProject(packed);
    expect(sidecar).toEqual(SIDECAR);
    expect(Array.from(outGlb)).toEqual(Array.from(glb));
  });

  it("rejects a plain GLB (wrong magic)", () => {
    expect(() => unpackProject(glb)).toThrow(/magic|short/);
  });

  it("rejects truncated files", () => {
    const packed = packProject(SIDECAR, glb);
    expect(() => unpackProject(packed.subarray(0, 10))).toThrow();
  });

  it("rejects a corrupted sidecar length", () => {
    const packed = packProject(SIDECAR, glb);
    const view = new DataView(packed.buffer, packed.byteOffset);
    view.setUint32(8, 999999, true);
    expect(() => unpackProject(packed)).toThrow(/out of range/);
  });

  it("rejects future container versions", () => {
    const packed = packProject(SIDECAR, glb);
    const view = new DataView(packed.buffer, packed.byteOffset);
    view.setUint32(4, 99, true);
    expect(() => unpackProject(packed)).toThrow(/version/);
  });
});

describe("validateSidecar", () => {
  it("accepts a well-formed sidecar", () => {
    expect(validateSidecar(SIDECAR)).toEqual(SIDECAR);
  });

  it.each([
    [null],
    [{ format: "other", version: 1, meshes: [], layers: [] }],
    [{ format: "forge3d-project", version: 1, meshes: [{}], layers: [] }],
    [{ format: "forge3d-project", version: 1, meshes: [], layers: [{ name: 1, visible: true }] }],
  ])("rejects malformed sidecar %#", (bad) => {
    expect(() => validateSidecar(bad)).toThrow();
  });
});

describe("boneRolls sidecar field", () => {
  it("round-trips bone rolls through pack/unpack", () => {
    const withRolls: ProjectSidecar = {
      ...SIDECAR,
      boneRolls: { arm_L: Math.PI / 4, arm_R: -Math.PI / 4 },
    };
    const packed = packProject(withRolls, new Uint8Array([1, 2, 3]));
    const { sidecar } = unpackProject(packed);
    expect(sidecar.boneRolls).toEqual(withRolls.boneRolls);
  });

  it("accepts a sidecar without boneRolls (pre-F-M6 projects)", () => {
    expect(() => validateSidecar(SIDECAR)).not.toThrow();
  });

  it("rejects non-object boneRolls", () => {
    expect(() => validateSidecar({ ...SIDECAR, boneRolls: [1, 2] })).toThrow(/boneRolls/);
  });

  it("rejects non-numeric roll values", () => {
    expect(() => validateSidecar({ ...SIDECAR, boneRolls: { spine: "12" } })).toThrow(/boneRolls/);
  });
});
