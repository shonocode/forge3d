// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { editControls, ioControls, snapControls } from "./edit";
import { state } from "../../state";
import { store } from "../../store";

afterEach(cleanup);

beforeEach(() => {
  state.editMesh = null;
  state.editSelection = { mode: "vertex", indices: new Set() };
  state.editConfig.insetAmount = 0.2;
  state.editConfig.bevelOffset = 15;
  state.editConfig.slideAmount = 0.25;
  state.editConfig.proportional = false;
  state.editConfig.proportionalRadius = 0.5;
  state.editConfig.creaseWeight = 1;
  state.editConfig.unwrapMethod = "project";
  state.snapConfig.positionEnabled = false;
  state.snapConfig.positionIncrement = 0.5;
  state.snapConfig.rotationEnabled = false;
  state.snapConfig.rotationIncrement = 15;
  state.snapConfig.scaleEnabled = false;
  state.snapConfig.scaleIncrement = 0.25;
  state.selectedMeshes = [];
  // applySnapToGizmos() (tools/snap.ts) reads state.gizmoManager.gizmos —
  // null until boot() runs the real viewport. Stub the shape it needs.
  state.gizmoManager = { gizmos: {} } as unknown as typeof state.gizmoManager;
  localStorage.clear();
});

describe("edit tab: Component Mode", () => {
  it("shows Vertex / Edge / Face and Move / Rotate / Scale, with Vertex keyed 1", () => {
    render(<>{editControls.cm!()}</>);
    expect(screen.getByRole("button", { name: "Vertex mode" }).textContent).toBe("Vertex (1)");
    expect(screen.getByRole("button", { name: "Edge mode" }).textContent).toBe("Edge (2)");
    expect(screen.getByRole("button", { name: "Face mode" }).textContent).toBe("Face (3)");
    expect(screen.getByRole("button", { name: "Gizmo Move mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gizmo Rotate mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gizmo Scale mode" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Proportional editing" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Prop. Radius" })).toBeTruthy();
  });

  it("clicking a mode button with no mesh in Edit Mode warns instead of switching", async () => {
    render(<>{editControls.cm!()}</>);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edge mode" }));
    });
    expect(store.status?.text).toBe("⚠ Enter Edit Mode (Tab) first");
  });
});

describe("edit tab: Operators", () => {
  it("lists every operator, disabled outside Edit Mode", () => {
    render(<>{editControls.ops!()}</>);
    const extrude = screen.getByRole("button", { name: /^Extrude/ }) as HTMLButtonElement;
    const del = screen.getByRole("button", { name: /^Delete/ }) as HTMLButtonElement;
    expect(extrude.disabled).toBe(true);
    expect(del.disabled).toBe(true);
    expect(screen.getByRole("button", { name: /^Inset/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Bevel/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Loop Cut/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Knife/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Fill/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Flip Diagonal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edge Slide (G G)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Vertex Slide/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Merge/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Bridge Loops/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark Seam" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Mark Crease/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Set Crease/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Tris to Quads/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Quads to Tris/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Subdivide (CC)" })).toBeTruthy();
  });

  it("has the selection helpers and the parameter sliders at their old-screen defaults", () => {
    render(<>{editControls.ops!()}</>);
    expect(screen.getByRole("button", { name: /^Select All/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Box Select/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeTruthy();
    expect((screen.getByRole("slider", { name: "Inset Amount" }) as HTMLInputElement).value).toBe("0.2");
    expect((screen.getByRole("slider", { name: "Bevel Offset %" }) as HTMLInputElement).value).toBe("15");
    expect((screen.getByRole("slider", { name: "Slide Amount" }) as HTMLInputElement).value).toBe("0.25");
    expect((screen.getByRole("slider", { name: "Crease Weight" }) as HTMLInputElement).value).toBe("1");
  });
});

describe("edit tab: UV Unwrap", () => {
  it("shows the Project/Conformal toggle (Project active by default), Smart UV Project and UV Editor", () => {
    render(<>{editControls.uv!()}</>);
    const project = screen.getByRole("button", { name: "Project" });
    const conformal = screen.getByRole("button", { name: "Conformal" });
    expect(project.getAttribute("aria-pressed")).toBe("true");
    expect(conformal.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /^Smart UV Project/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "UV Editor" })).toBeTruthy();
  });
});

describe("Transform tab: Snap", () => {
  it("shows Position / Rotation / Scale with the old defaults", () => {
    render(<>{snapControls()}</>);
    expect((screen.getByRole("checkbox", { name: "Position snap enabled" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("spinbutton", { name: "Position snap value" }) as HTMLInputElement).value).toBe("0.5");
    expect((screen.getByRole("spinbutton", { name: "Rotation snap value" }) as HTMLInputElement).value).toBe("15");
    expect((screen.getByRole("spinbutton", { name: "Scale snap value" }) as HTMLInputElement).value).toBe("0.25");
  });

  it("toggling Position snap updates state and persists to localStorage", async () => {
    render(<>{snapControls()}</>);
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Position snap enabled" }));
    });
    expect(state.snapConfig.positionEnabled).toBe(true);
    expect(JSON.parse(localStorage.getItem("forge3d_snap")!).positionEnabled).toBe(true);
  });
});

describe("io: Export / Save", () => {
  it("has GLB, OBJ, Save, Load, project export/open, Duplicate and Delete", () => {
    render(<>{ioControls()}</>);
    expect(screen.getByRole("button", { name: "Export GLB" }).textContent).toBe("⬇ GLB");
    expect(screen.getByRole("button", { name: "Export OBJ" }).textContent).toBe("OBJ");
    expect(screen.getByRole("button", { name: "💾 Save to Library" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "📂 Load Model" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "📦 Export Project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "📂 Open Project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "⎘ Duplicate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "✕ Delete" })).toBeTruthy();
  });

  it("Duplicate and Delete no-op without a selection instead of throwing", () => {
    render(<>{ioControls()}</>);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "⎘ Duplicate" }))).not.toThrow();
    expect(() => fireEvent.click(screen.getByRole("button", { name: "✕ Delete" }))).not.toThrow();
  });
});
