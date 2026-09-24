// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

import { MeasureControls, LayerControls, HierarchyControls } from "./left-sections";
import { state } from "../state";
import type { LayerData } from "../state";

/**
 * These components read the real `state` singleton directly (like
 * TransformFields / ModifierPanel / the tab controls), so tests restore what
 * they touch rather than injecting a fake state. No Babylon engine/scene is
 * created — mesh rows only exercise property reads and the visibility toggle
 * (a plain property write); clicking a row to *select* a mesh would reach
 * `selectMesh`'s gizmo/edge-overlay code, which needs a real scene, so that
 * path is left untested here (see `src/app/left-panel.tsx`'s existing mesh
 * list, which has the same constraint).
 */
afterEach(() => {
  cleanup();
  state.selectedMeshes.length = 0;
  state.allMeshes.length = 0;
  state.layers.length = 0;
  state.layers.push({ id: "layer_1", name: "Layer 1", visible: true });
  state.activeLayerId = "layer_1";
  state.layerCounter = 1;
  state.meshLayerMap.clear();
  state.measurements.length = 0;
  state.measuringActive = false;
  state.measureStartPoint = null;
  state.history.clear();
});

function fakeMesh(uniqueId: number, name: string, extra: Partial<AbstractMesh> = {}): AbstractMesh {
  return { uniqueId, name, material: null, isVisible: true, parent: null, ...extra } as unknown as AbstractMesh;
}

describe("MeasureControls", () => {
  it("renders Measure Distance and Clear All", () => {
    render(<MeasureControls />);
    expect(screen.getByRole("button", { name: "Measure Distance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear All" })).toBeTruthy();
  });

  it("Measure Distance toggles measuringActive (old btnMeasure → toggleMeasureMode)", async () => {
    render(<MeasureControls />);
    const btn = screen.getByRole("button", { name: "Measure Distance" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(btn));
    expect(state.measuringActive).toBe(true);
    expect(screen.getByRole("button", { name: "Measure Distance" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("Clear All with nothing measured does not throw (old btnClearMeasure → clearMeasurements)", async () => {
    render(<MeasureControls />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear All" })));
    expect(state.measurements.length).toBe(0);
  });
});

describe("LayerControls", () => {
  it("shows the default Layer 1 (no delete button — old screen keeps the last layer) and + New Layer", () => {
    render(<LayerControls />);
    expect(screen.getByText("Layer 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete layer Layer 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "+ New Layer" })).toBeTruthy();
  });

  it("+ New Layer adds a layer and makes it active (old btnNewLayer → createLayer, which calls status())", async () => {
    render(<LayerControls />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "+ New Layer" })));
    expect(state.layers.length).toBe(2);
    expect(screen.getByText("Layer 2")).toBeTruthy();
    expect(state.activeLayerId).toBe(state.layers[1]!.id);
    // Both layers now show a delete button since more than one exists.
    expect(screen.getByRole("button", { name: "Delete layer Layer 1" })).toBeTruthy();
  });

  it("clicking a layer row sets it active (activeLayerId is not in the store's fingerprint)", async () => {
    const second: LayerData = { id: "layer_2", name: "Second", visible: true };
    state.layers.push(second);
    render(<LayerControls />);
    await act(async () => fireEvent.click(screen.getByText("Second")));
    expect(state.activeLayerId).toBe("layer_2");
  });

  it("nested layers (sub-collections) render indented under their parent", () => {
    state.layers.push({ id: "layer_2", name: "Child", visible: true, parentId: "layer_1" });
    render(<LayerControls />);
    expect(screen.getByText("Child")).toBeTruthy();
  });

  it("the eye button flips the layer's visible flag (old renderLayerRow's eyeBtn)", () => {
    render(<LayerControls />);
    fireEvent.click(screen.getByRole("button", { name: "Hide layer Layer 1" }));
    expect(state.layers[0]!.visible).toBe(false);
  });
});

describe("HierarchyControls", () => {
  it("shows the empty hint, filter, Isolate, Set Parent and Clear Parent with nothing in the scene", () => {
    render(<HierarchyControls />);
    expect(screen.getByText("メッシュなし ― 上の Primitives から追加")).toBeTruthy();
    expect(screen.getByLabelText("Filter meshes by name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "◎ Isolate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set Parent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear Parent" })).toBeTruthy();
  });

  it("Set Parent with fewer than 2 selected reports a warning instead of throwing (old btnSetParent)", async () => {
    render(<HierarchyControls />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Set Parent" })));
  });

  it("Isolate with nothing selected reports a warning and stays off (old btnIsolate → toggleIsolate)", async () => {
    render(<HierarchyControls />);
    const btn = screen.getByRole("button", { name: "◎ Isolate" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(btn));
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("a fake mesh list renders names, and the per-item visibility toggle flips isVisible (old updateHierarchy)", async () => {
    const a = fakeMesh(1, "Cube");
    const b = fakeMesh(2, "Sphere");
    state.allMeshes.push(a, b);
    render(<HierarchyControls />);
    expect(screen.getByText("Cube")).toBeTruthy();
    expect(screen.getByText("Sphere")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Hide Cube" })));
    expect(a.isVisible).toBe(false);
  });

  it("the name filter narrows the list to matching names (old outlinerSearch → setOutlinerFilter)", () => {
    state.allMeshes.push(fakeMesh(1, "Cube"), fakeMesh(2, "Sphere"));
    render(<HierarchyControls />);
    fireEvent.change(screen.getByLabelText("Filter meshes by name"), { target: { value: "sph" } });
    expect(screen.queryByText("Cube")).toBeNull();
    expect(screen.getByText("Sphere")).toBeTruthy();
  });
});
