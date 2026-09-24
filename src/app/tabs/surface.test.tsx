// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { matControls, morphControls, sceneControls, mapControls } from "./surface";
import { state } from "../../state";
import { PALETTE } from "../../tools/primitives";
import type { LightData } from "../../state";

/**
 * These components read the real `state` singleton directly (like
 * TransformFields / ModifierPanel / `brush.tsx`), so tests restore what
 * they touch rather than injecting a fake state.
 */
afterEach(() => {
  cleanup();
  state.selectedMeshes.length = 0;
  state.allMeshes.length = 0;
  state.morphMap.clear();
  state.morphDrivers = [];
  state.lightMap.clear();
  state.selectedLightId = null;
  state.mapInstances.length = 0;
  state.activeEnvPresetId = "studio";
  state.envIntensity = 0.8;
  state.showSkybox = false;
  state.shadowsEnabled = true;
  state.shadowQuality = 1024;
});

function fakeMesh(uniqueId: number, name: string, material: unknown = null): AbstractMesh {
  return { uniqueId, name, material } as unknown as AbstractMesh;
}

/** Enough of a PBRMaterial for the Material tab's reads/writes — no Babylon engine involved. */
function fakePBRMaterial(): PBRMaterial {
  return {
    albedoColor: Color3.FromHexString("#5b7fff"),
    metallic: 0.5,
    roughness: 0.4,
    alpha: 1,
    emissiveColor: Color3.FromHexString("#000000"),
    emissiveIntensity: 0,
    clearCoat: { intensity: 0, roughness: 0, isEnabled: false },
    sheen: { intensity: 0, color: Color3.FromHexString("#ffffff"), isEnabled: false },
    subSurface: { refractionIntensity: 0, indexOfRefraction: 1.5, isRefractionEnabled: false },
    wireframe: false,
    unlit: false,
    albedoTexture: null,
    bumpTexture: null,
    metallicTexture: null,
    ambientTexture: null,
    emissiveTexture: null,
  } as unknown as PBRMaterial;
}

describe("matControls — nothing selected", () => {
  it("alb / pbr / emi / tex all show the old screen's empty hint", () => {
    render(<>{matControls.alb?.()}</>);
    expect(screen.getByText("メッシュを選択")).toBeTruthy();
    cleanup();
    render(<>{matControls.pbr?.()}</>);
    expect(screen.getByText("メッシュを選択")).toBeTruthy();
    cleanup();
    render(<>{matControls.emi?.()}</>);
    expect(screen.getByText("メッシュを選択")).toBeTruthy();
    cleanup();
    render(<>{matControls.tex?.()}</>);
    expect(screen.getByText("メッシュを選択")).toBeTruthy();
  });

  it("shows 'No material' for a mesh with no albedo-carrying material", () => {
    state.selectedMeshes.push(fakeMesh(1, "Empty", null));
    render(<>{matControls.alb?.()}</>);
    expect(screen.getByText("No material")).toBeTruthy();
  });
});

describe("matControls — a mesh with a PBR material selected", () => {
  it("alb: a swatch per palette colour, plus the colour picker at the material's albedo", () => {
    const mesh = fakeMesh(2, "Cube", fakePBRMaterial());
    state.selectedMeshes.push(mesh);
    render(<>{matControls.alb?.()}</>);
    expect(screen.getAllByLabelText(/^Albedo #/).length).toBe(PALETTE.length);
    expect((screen.getByLabelText("Albedo color") as HTMLInputElement).value).toBe("#5b7fff");
  });

  it("pbr: Metallic / Roughness / Alpha sliders show the material's values", () => {
    const mesh = fakeMesh(3, "Cube", fakePBRMaterial());
    state.selectedMeshes.push(mesh);
    render(<>{matControls.pbr?.()}</>);
    expect((screen.getByRole("slider", { name: "Metallic" }) as HTMLInputElement).value).toBe("0.5");
    expect((screen.getByRole("slider", { name: "Roughness" }) as HTMLInputElement).value).toBe("0.4");
    expect((screen.getByRole("slider", { name: "Alpha" }) as HTMLInputElement).value).toBe("1");
  });

  it("pbr: dragging Metallic writes the material and pushes one undo step", async () => {
    const mat = fakePBRMaterial();
    const mesh = fakeMesh(4, "Cube", mat);
    state.selectedMeshes.push(mesh);
    render(<>{matControls.pbr?.()}</>);
    const before = state.history.undoCount();
    const slider = screen.getByRole("slider", { name: "Metallic" });
    fireEvent.pointerDown(slider);
    await act(async () => fireEvent.change(slider, { target: { value: "0.9" } }));
    expect(mat.metallic).toBe(0.9);
    await act(async () => fireEvent.pointerUp(slider));
    expect(state.history.undoCount()).toBe(before + 1);
  });

  it("emi: Emissive, Clear Coat, Sheen and Transmission all render (left out of their own section on the old screen — nearest section)", () => {
    const mesh = fakeMesh(5, "Cube", fakePBRMaterial());
    state.selectedMeshes.push(mesh);
    render(<>{matControls.emi?.()}</>);
    expect(screen.getByText("Clear Coat")).toBeTruthy();
    expect(screen.getByText("Sheen")).toBeTruthy();
    expect(screen.getByText("Transmission")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "IOR" })).toBeTruthy();
  });

  it("tex: the five texture slots, AO/Normal bake rows, Procedural and Display all render", () => {
    const mesh = fakeMesh(6, "Cube", fakePBRMaterial());
    state.selectedMeshes.push(mesh);
    render(<>{matControls.tex?.()}</>);
    for (const label of ["Albedo", "Normal", "Metal/Rough", "AO", "Emissive"]) {
      expect(screen.getByLabelText("Import " + label + " texture")).toBeTruthy();
    }
    expect(screen.getByText("AO Bake")).toBeTruthy();
    expect(screen.getByText("Nrm Bake")).toBeTruthy();
    expect(screen.getByText("Procedural")).toBeTruthy();
    expect(screen.getByText("Display")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Wireframe" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Unlit" })).toBeTruthy();
  });

  it("tex: toggling Wireframe writes the material and pushes one undo step", async () => {
    const mat = fakePBRMaterial();
    const mesh = fakeMesh(7, "Cube", mat);
    state.selectedMeshes.push(mesh);
    render(<>{matControls.tex?.()}</>);
    const before = state.history.undoCount();
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: "Wireframe" })));
    expect(mat.wireframe).toBe(true);
    expect(state.history.undoCount()).toBe(before + 1);
  });
});

describe("morphControls", () => {
  it("mt: nothing selected shows the empty hint; the two action buttons are always present", () => {
    render(<>{morphControls.mt?.()}</>);
    expect(screen.getByText("メッシュを選択")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ ターゲット有効化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /形状キャプチャ/ })).toBeTruthy();
  });

  it("mt: a mesh with no morph targets shows 'ターゲットなし'", () => {
    const mesh = fakeMesh(10, "Face");
    state.selectedMeshes.push(mesh);
    state.morphMap.set(mesh.uniqueId, { manager: {} as never, targets: [] });
    render(<>{morphControls.mt?.()}</>);
    expect(screen.getByText("ターゲットなし")).toBeTruthy();
  });

  it("mt: a captured target shows its name and influence slider (no skeleton — no driver row)", () => {
    const mesh = fakeMesh(11, "Face");
    state.selectedMeshes.push(mesh);
    state.morphMap.set(mesh.uniqueId, {
      manager: {} as never,
      targets: [{ name: "target_0", influence: 0.25 } as never],
    });
    render(<>{morphControls.mt?.()}</>);
    const slider = screen.getByRole("slider", { name: "Morph target target_0 influence" }) as HTMLInputElement;
    expect(slider.value).toBe("0.25");
    expect(screen.getByRole("button", { name: "Delete morph target target_0" })).toBeTruthy();
  });

  it("mt: clicking + ターゲット有効化 with nothing selected reports a warning instead of throwing", async () => {
    render(<>{morphControls.mt?.()}</>);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "+ ターゲット有効化" })));
  });
});

describe("sceneControls", () => {
  it("li: no lights shows the empty hint; + Point / + Spot are always present", () => {
    render(<>{sceneControls.li?.()}</>);
    expect(screen.getByText("ライトなし")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Point" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Spot" })).toBeTruthy();
  });

  it("li: a light shows in the list; clicking it selects and reveals its props (selectedLightId is not in the store's fingerprint)", async () => {
    const data: LightData = {
      id: "light_1",
      type: "point",
      light: { position: { x: 0, y: 3, z: 0 }, intensity: 1 } as never,
      visual: {} as never,
      color: "#ffffff",
      intensity: 1,
      range: 20,
    };
    state.lightMap.set("light_1", data);
    render(<>{sceneControls.li?.()}</>);
    expect(screen.getByText("Point 1")).toBeTruthy();
    expect(screen.queryByLabelText("Light light_1 intensity")).toBeNull();
    await act(async () => fireEvent.click(screen.getByText("Point 1")));
    expect(state.selectedLightId).toBe("light_1");
    expect(screen.getByLabelText("Light light_1 intensity")).toBeTruthy();
  });

  it("env: shows the studio preset and default intensity", () => {
    render(<>{sceneControls.env?.()}</>);
    expect((screen.getByLabelText("Environment preset") as HTMLSelectElement).value).toBe("studio");
    expect(screen.getByText("0.80")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import HDRI" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Import Reference/ })).toBeTruthy();
  });

  it("shd: defaults to enabled / medium, and toggling writes state + notifies (no Babylon scene touched)", async () => {
    render(<>{sceneControls.shd?.()}</>);
    const enabled = screen.getByRole("checkbox", { name: "Shadows enabled" }) as HTMLInputElement;
    expect(enabled.checked).toBe(true);
    expect((screen.getByLabelText("Shadow quality") as HTMLSelectElement).value).toBe("1024");
    await act(async () => fireEvent.click(enabled));
    expect(state.shadowsEnabled).toBe(false);
  });
});

describe("mapControls", () => {
  it("lib: empty library shows the old hint and a Refresh Library button", async () => {
    render(<>{mapControls.lib?.()}</>);
    await waitFor(() => expect(screen.getByText("Save to Libraryでモデルを保存")).toBeTruthy());
    expect(screen.getByRole("button", { name: /Refresh Library/ })).toBeTruthy();
  });

  it("inst: no instances shows the old hint", () => {
    render(<>{mapControls.inst?.()}</>);
    expect(screen.getByText("ライブラリからモデルを配置")).toBeTruthy();
  });

  it("inst: a placed instance is listed with a remove button", () => {
    state.mapInstances.push({ instanceId: "i1", modelId: "m1", modelName: "Chair", meshUniqueIds: [1] });
    render(<>{mapControls.inst?.()}</>);
    expect(screen.getByText("Chair")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Chair" })).toBeTruthy();
  });

  it("lay: Name field, Export/Import/Clear all render; typing updates the field", () => {
    render(<>{mapControls.lay?.()}</>);
    const name = screen.getByLabelText("Layout name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "My Layout" } });
    expect(name.value).toBe("My Layout");
    expect(screen.getByRole("button", { name: /Export Layout JSON/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Import Layout/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Clear Scene/ })).toBeTruthy();
  });
});
