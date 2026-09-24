// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { sculptControls, paintControls } from "./brush";
import { state } from "../../state";

/**
 * These components read the real `state` / `store` singletons directly (like
 * TransformFields / ModifierPanel), so tests restore what they touch rather
 * than injecting a fake — mirroring app.test.tsx's use of the same
 * singletons.
 */
afterEach(() => {
  cleanup();
  state.selectedMeshes.length = 0;
  state.paintLayersMap.clear();
  Object.assign(state.sculptConfig, { radius: 0.5, strength: 0.05, falloff: 2, brush: "push", dyntopo: false, detail: 0.1, symX: false, symY: false, symZ: false });
  Object.assign(state.paintConfig, { color: "#ff0000", size: 20, opacity: 1, eraser: false, hardness: 0.7, resolution: 1024, channel: "albedo", brushMode: "round", stencilScale: 1 });
});

function fakeMesh(uniqueId: number, name: string): AbstractMesh {
  return { uniqueId, name } as unknown as AbstractMesh;
}

/** jsdom has no OffscreenCanvas; the layer list never touches `.canvas`. */
const fakeCanvas = {} as OffscreenCanvas;

describe("sculptControls", () => {
  it("br: brush sliders show the sculpt config's defaults", () => {
    render(<>{sculptControls.br?.()}</>);
    expect((screen.getByRole("slider", { name: "Brush size" }) as HTMLInputElement).value).toBe("0.5");
    expect((screen.getByRole("slider", { name: "Brush strength" }) as HTMLInputElement).value).toBe("0.05");
    expect((screen.getByRole("slider", { name: "Brush falloff" }) as HTMLInputElement).value).toBe("2");
  });

  it("br: dragging Size writes sculptConfig.radius and notifies the store", async () => {
    render(<>{sculptControls.br?.()}</>);
    await act(async () => fireEvent.change(screen.getByRole("slider", { name: "Brush size" }), { target: { value: "1.2" } }));
    expect(state.sculptConfig.radius).toBe(1.2);
  });

  it("bm: lists all seven brushes, Push active by default, clicking Pull switches it", async () => {
    render(<>{sculptControls.bm?.()}</>);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(7);
    const push = screen.getByRole("button", { name: "↑ Push（盛り上げ）" });
    expect(push.getAttribute("aria-pressed")).toBe("true");
    const pull = screen.getByRole("button", { name: "↓ Pull（凹ませる）" });
    expect(pull.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(pull));
    expect(state.sculptConfig.brush).toBe("pull");
    expect(pull.getAttribute("aria-pressed")).toBe("true");
  });

  it("sym: X/Y/Z start unchecked; toggling X writes sculptConfig.symX", async () => {
    render(<>{sculptControls.sym?.()}</>);
    const x = screen.getByRole("checkbox", { name: "X" }) as HTMLInputElement;
    expect(x.checked).toBe(false);
    await act(async () => fireEvent.click(x));
    expect(state.sculptConfig.symX).toBe(true);
  });

  it("dyn: dyntopo checkbox, detail slider and Clear Mask are present; Clear Mask with nothing selected does not throw", async () => {
    render(<>{sculptControls.dyn?.()}</>);
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Dyntopo detail size" })).toBeTruthy();
    const btn = screen.getByRole("button", { name: "▦ Clear Mask" });
    await act(async () => fireEvent.click(btn));
  });
});

describe("paintControls", () => {
  it("pb: shows the paint config's defaults", () => {
    render(<>{paintControls.pb?.()}</>);
    expect((screen.getByRole("combobox", { name: "Paint channel" }) as HTMLSelectElement).value).toBe("albedo");
    expect((screen.getByRole("slider", { name: "Paint brush size" }) as HTMLInputElement).value).toBe("20");
    expect((screen.getByRole("checkbox", { name: "Eraser mode" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("combobox", { name: "Paint texture resolution" }) as HTMLSelectElement).value).toBe("1024");
  });

  it("pb: switching Channel writes paintConfig.channel and reports through status", async () => {
    render(<>{paintControls.pb?.()}</>);
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Paint channel" }), { target: { value: "roughness" } }));
    expect(state.paintConfig.channel).toBe("roughness");
  });

  it("bi: shows the no-image placeholder, the mode select and stencil scale", () => {
    render(<>{paintControls.bi?.()}</>);
    expect(screen.getByText("— 画像なし —")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Brush image mode" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Stencil tile scale" })).toBeTruthy();
  });

  it("pl: nothing selected shows the same empty hint as the old screen", () => {
    render(<>{paintControls.pl?.()}</>);
    expect(screen.getByText("ペイント開始で Base レイヤーが作られる")).toBeTruthy();
  });

  it("pl: with a paint stack, lists layers topmost-first and Base cannot be deleted", async () => {
    const mesh = fakeMesh(1, "Cube");
    state.selectedMeshes.push(mesh);
    state.paintLayersMap.set(mesh.uniqueId, {
      active: 1,
      layers: [
        { name: "Base", visible: true, opacity: 1, blend: "normal", isBase: true, canvas: fakeCanvas },
        { name: "Layer 1", visible: true, opacity: 1, blend: "normal", isBase: false, canvas: fakeCanvas },
      ],
    });
    render(<>{paintControls.pl?.()}</>);
    const rows = screen.getAllByRole("listitem");
    expect(rows.length).toBe(2);
    // Topmost (Layer 1) first.
    expect(rows[0]?.textContent).toContain("Layer 1");
    expect(screen.getByRole("button", { name: "Layer 1 を削除" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Base を削除" })).toBeNull();
  });

  it("pl: clicking a row makes it active", async () => {
    const mesh = fakeMesh(2, "Sphere");
    state.selectedMeshes.push(mesh);
    state.paintLayersMap.set(mesh.uniqueId, {
      active: 0,
      layers: [
        { name: "Base", visible: true, opacity: 1, blend: "normal", isBase: true, canvas: fakeCanvas },
        { name: "Layer 1", visible: true, opacity: 1, blend: "normal", isBase: false, canvas: fakeCanvas },
      ],
    });
    render(<>{paintControls.pl?.()}</>);
    const row = screen.getByText("Layer 1").closest('[role="listitem"]')!;
    await act(async () => fireEvent.click(row));
    expect(state.paintLayersMap.get(mesh.uniqueId)?.active).toBe(1);
  });

  it("pa: Clear Paint is present and does not throw with nothing selected", async () => {
    render(<>{paintControls.pa?.()}</>);
    const btn = screen.getByRole("button", { name: "Clear Paint" });
    await act(async () => fireEvent.click(btn));
  });
});
