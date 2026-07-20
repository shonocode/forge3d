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

  it("starts with the F3DP magic bytes (autosave recovery sniffs these)", () => {
    const packed = packProject(SIDECAR, glb);
    // main.ts recovery detects a container by 0x46 0x33 0x44 0x50 = "F3DP".
    expect([packed[0], packed[1], packed[2], packed[3]]).toEqual([0x46, 0x33, 0x44, 0x50]);
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

describe("boneConstraints sidecar field", () => {
  const CONSTRAINTS = {
    arm_L: {
      limitRotation: { enabled: true, limitX: true, minXDeg: -45, maxXDeg: 45 },
      aim: { enabled: true, targetX: 1, targetY: 2, targetZ: 3 },
    },
    head: {
      aim: { enabled: true, targetX: 0, targetY: 1.5, targetZ: 0.5 },
    },
  };

  it("round-trips constraints through pack/unpack", () => {
    const withConstraints: ProjectSidecar = { ...SIDECAR, boneConstraints: CONSTRAINTS };
    const packed = packProject(withConstraints, new Uint8Array([1, 2, 3]));
    const { sidecar } = unpackProject(packed);
    expect(sidecar.boneConstraints).toEqual(CONSTRAINTS);
  });

  it("accepts a sidecar without boneConstraints (older projects)", () => {
    expect(() => validateSidecar(SIDECAR)).not.toThrow();
  });

  it("rejects non-object boneConstraints", () => {
    expect(() => validateSidecar({ ...SIDECAR, boneConstraints: [1] })).toThrow(/boneConstraints/);
  });

  it("rejects a limitRotation without a boolean enabled", () => {
    expect(() =>
      validateSidecar({ ...SIDECAR, boneConstraints: { arm: { limitRotation: { enabled: "yes" } } } })
    ).toThrow(/limitRotation/);
  });

  it("rejects an aim with missing / non-numeric targets", () => {
    expect(() =>
      validateSidecar({ ...SIDECAR, boneConstraints: { arm: { aim: { enabled: true, targetX: 1 } } } })
    ).toThrow(/aim/);
  });
});

describe("paint layers / channels sidecar fields", () => {
  it("accepts well-formed paintLayers + paintChannels entries", () => {
    const s: ProjectSidecar = {
      ...SIDECAR,
      meshes: [
        {
          name: "body",
          paintLayers: {
            active: 1,
            layers: [
              { name: "Base", visible: true, opacity: 1, blend: "normal", isBase: true, png: "data:image/png;base64,x" },
              { name: "Layer 1", visible: true, opacity: 0.5, blend: "multiply", isBase: false, png: "data:image/png;base64,y" },
            ],
          },
          paintChannels: { baseRough: 0.5, baseMetal: 0, roughPng: "data:image/png;base64,r", metalPng: "data:image/png;base64,m" },
        },
      ],
    };
    expect(validateSidecar(structuredClone(s))).toEqual(s);
  });

  it("rejects paintLayers without a layers array or numeric active", () => {
    const bad = structuredClone(SIDECAR) as ProjectSidecar & { meshes: Array<Record<string, unknown>> };
    bad.meshes = [{ name: "body", paintLayers: { active: "0", layers: [] } }];
    expect(() => validateSidecar(bad)).toThrow(/paintLayers/);
  });

  it("rejects paintChannels missing the PNG payloads", () => {
    const bad = structuredClone(SIDECAR) as ProjectSidecar & { meshes: Array<Record<string, unknown>> };
    bad.meshes = [{ name: "body", paintChannels: { baseRough: 0.5, baseMetal: 0 } }];
    expect(() => validateSidecar(bad)).toThrow(/paintChannels/);
  });
});

describe("edit structure sidecar fields (half-edge V2 persistence)", () => {
  const WITH_EDIT: ProjectSidecar = {
    ...SIDECAR,
    meshes: [
      {
        name: "cube",
        editPolys: [[0, 3, 2, 1], [4, 5, 6, 7]],
        editSeams: ["0_3", "1_2"],
        editCreases: [["0_1", 1], ["2_3", 2.5]],
      },
    ],
  };

  it("round-trips editPolys / editSeams / editCreases through pack/unpack", () => {
    const packed = packProject(WITH_EDIT, new Uint8Array([9, 9, 9]));
    const { sidecar } = unpackProject(packed);
    const m = sidecar.meshes[0]!;
    expect(m.editPolys).toEqual([[0, 3, 2, 1], [4, 5, 6, 7]]);
    expect(m.editSeams).toEqual(["0_3", "1_2"]);
    expect(m.editCreases).toEqual([["0_1", 1], ["2_3", 2.5]]);
  });

  it("accepts a sidecar without any edit-structure fields (older projects)", () => {
    expect(() => validateSidecar(SIDECAR)).not.toThrow();
  });

  it("rejects a malformed editPolys entry (too few verts)", () => {
    const bad = { ...SIDECAR, meshes: [{ name: "x", editPolys: [[0, 1]] }] };
    expect(() => validateSidecar(bad)).toThrow(/editPolys/);
  });

  it("rejects a malformed editCreases entry (missing sharpness)", () => {
    const bad = { ...SIDECAR, meshes: [{ name: "x", editCreases: [["0_1"]] }] };
    expect(() => validateSidecar(bad)).toThrow(/editCreases/);
  });

  it("rejects non-string editSeams entries", () => {
    const bad = { ...SIDECAR, meshes: [{ name: "x", editSeams: [12] }] };
    expect(() => validateSidecar(bad)).toThrow(/editSeams/);
  });
});
