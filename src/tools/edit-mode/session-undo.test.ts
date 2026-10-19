// @vitest-environment jsdom
/**
 * Undo after leaving Edit Mode (compat-backlog C127): every entry made in Edit Mode closes over that session's EditMesh.
 * Until 2026-10-19 a topology step's undo did nothing once the mode was left (and was still spent), and a seam or a
 * drag wrote keys of a numbering the next topology step had replaced. Each entry now keeps the mesh on both
 * sides and puts it back on the mesh itself when its EditMesh is gone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PointerDragBehavior } from "@babylonjs/core/Behaviors/Meshes/pointerDragBehavior";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { state } from "../../state";
import { writeSurfaceWeld, SEAM_METADATA_KEY, CREASE_METADATA_KEY } from "./build";
import { enterEditMode, exitEditMode, extrudeSelection, markCreaseSelection, markSeamSelection, selectAllComponents, setComponentMode } from "./index";

let engine: NullEngine;
let scene: Scene;
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  state.scene = scene;
  state.history.clear();
});
afterEach(() => {
  exitEditMode();
  state.history.clear();
  scene.dispose();
  engine.dispose();
});

const box = (): Mesh => {
  const m = MeshBuilder.CreateBox("b", { size: 2, updatable: true }, scene);
  writeSurfaceWeld(m);
  return m;
};
const positions = (m: Mesh): number[] => Array.from(m.getVerticesData(VertexBuffer.PositionKind)!);

/**
 * Drive the Move gizmo's x arrow by hand: the drag behaviours the gizmo attaches are collected as they attach, and the
 * proxy the gizmo moves is moved directly between the start and the drag (what a pointer would do).
 */
function collectDrags(): PointerDragBehavior[] {
  const out: PointerDragBehavior[] = [];
  const attach = PointerDragBehavior.prototype.attach;
  PointerDragBehavior.prototype.attach = function (this: PointerDragBehavior, ...a: Parameters<typeof attach>) {
    out.push(this);
    return attach.apply(this, a);
  };
  afterEach(() => {
    PointerDragBehavior.prototype.attach = attach;
  });
  return out;
}
const dragEvent = { delta: Vector3.Zero(), dragPlanePoint: Vector3.Zero(), dragPlaneNormal: Vector3.Up(), dragDistance: 0, pointerId: 0, pointerInfo: null };
function dragStart(d: PointerDragBehavior, by: number): void {
  d.onDragStartObservable.notifyObservers(dragEvent as never);
  const proxy = scene.getTransformNodeByName("edit-gizmo-proxy") as TransformNode;
  proxy.position.x += by;
  d.onDragObservable.notifyObservers(dragEvent as never);
}

describe("Edit Mode's history after leaving it", () => {
  it("each step undoes and redoes from Object Mode", () => {
    const m = box();
    const before = positions(m);
    enterEditMode(m);
    setComponentMode("face");
    state.editSelection.indices.add(0);
    extrudeSelection();
    const once = positions(m);
    extrudeSelection();
    const twice = positions(m);
    expect(twice.length).toBeGreaterThan(once.length);
    exitEditMode();
    expect(state.history.undoCount()).toBe(2);

    state.history.undo();
    expect(positions(m)).toEqual(once);
    state.history.undo();
    expect(positions(m)).toEqual(before);
    state.history.redo();
    state.history.redo();
    expect(positions(m)).toEqual(twice);
  });

  it("a seam marked before a topology step comes back with the mesh it was marked on", () => {
    const m = box();
    const seams = (): string => JSON.stringify((m.metadata as Record<string, unknown> | null)?.[SEAM_METADATA_KEY] ?? null);
    const seamsBefore = seams();
    enterEditMode(m);
    setComponentMode("edge");
    state.editSelection.indices.add(0);
    markSeamSelection();
    const seamsMarked = seams();
    expect(seamsMarked).not.toBe(seamsBefore);
    setComponentMode("face");
    state.editSelection.indices.add(1);
    extrudeSelection();
    exitEditMode();
    state.history.undo();
    expect(seams()).toBe(seamsMarked);
    state.history.undo();
    expect(seams()).toBe(seamsBefore);
  });

  it("undone from inside a later session on the same mesh, the mesh is rebuilt rather than left stale", () => {
    const m = box();
    const before = positions(m);
    enterEditMode(m);
    setComponentMode("face");
    state.editSelection.indices.add(0);
    extrudeSelection();
    exitEditMode();
    enterEditMode(m);
    state.history.undo();
    expect(positions(m)).toEqual(before);
    expect(state.editMesh?.source).toBe(m);
    expect(state.editMesh?.vertices.length).toBe(8);
  });

  it("undo, redo across a later session, then leave and undo: back to the start (C127 review A)", () => {
    const m = box();
    const before = positions(m);
    enterEditMode(m);
    setComponentMode("face");
    state.editSelection.indices.add(0);
    extrudeSelection();
    const edited = positions(m);
    exitEditMode();
    enterEditMode(m);
    state.history.undo();
    state.history.redo();
    expect(positions(m)).toEqual(edited);
    exitEditMode();
    state.history.undo();
    expect(positions(m)).toEqual(before);
  });

  it("an entry made in Edit Mode about something else stays its own (C127 review B)", () => {
    const m = box();
    let undone = false;
    enterEditMode(m);
    state.history.push({ label: "other", undo: () => { undone = true; }, redo: () => {} });
    exitEditMode();
    state.history.undo();
    expect(undone).toBe(true);
  });

  it("a gizmo drag undoes and redoes after a later topology step and leaving", () => {
    const drags = collectDrags();
    const m = box();
    const start = positions(m);
    enterEditMode(m);
    selectAllComponents();
    dragStart(drags[0]!, 0.5);
    drags[0]!.onDragEndObservable.notifyObservers(dragEvent as never);
    const moved = positions(m);
    expect(moved).not.toEqual(start);
    setComponentMode("face");
    state.editSelection.indices.add(0);
    extrudeSelection();
    exitEditMode();
    state.history.undo();
    expect(positions(m)).toEqual(moved);
    state.history.undo();
    expect(positions(m)).toEqual(start);
    state.history.redo();
    expect(positions(m)).toEqual(moved);
  });

  it("Ctrl+Z held through a drag in a later session records nothing from inside the undo (C127 review)", () => {
    const drags = collectDrags();
    const m = box();
    const before = positions(m);
    enterEditMode(m);
    setComponentMode("face");
    state.editSelection.indices.add(0);
    extrudeSelection();
    exitEditMode();
    const first = drags.length;
    enterEditMode(m);
    selectAllComponents();
    const d = drags[first]!; // the second session's Move x arrow, attached first as in the first session
    dragStart(d, 0.5);
    (d as unknown as { dragging: boolean }).dragging = true;
    state.history.undo();
    expect(state.history.undoCount()).toBe(0);
    expect(state.history.redoCount()).toBe(1);
    expect(positions(m)).toEqual(before);
  });

  it("Mark Crease undoes from Object Mode", () => {
    const m = box();
    const creases = (): string => JSON.stringify((m.metadata as Record<string, unknown> | null)?.[CREASE_METADATA_KEY] ?? null);
    const creasesBefore = creases();
    enterEditMode(m);
    setComponentMode("edge");
    state.editSelection.indices.add(0);
    markCreaseSelection();
    expect(creases()).not.toBe(creasesBefore);
    setComponentMode("face");
    state.editSelection.indices.add(1);
    extrudeSelection();
    exitEditMode();
    state.history.undo();
    state.history.undo();
    expect(creases()).toBe(creasesBefore);
  });

  it("undoing one mesh's entry while another is edited leaves that one's EditMesh alone", () => {
    const a = box();
    const b = MeshBuilder.CreateBox("b2", { size: 1, updatable: true }, scene);
    writeSurfaceWeld(b);
    const aBefore = positions(a);
    enterEditMode(a);
    setComponentMode("face");
    state.editSelection.indices.add(0);
    extrudeSelection();
    exitEditMode();
    enterEditMode(b);
    const emB = state.editMesh;
    state.history.undo();
    expect(positions(a)).toEqual(aBefore);
    expect(state.editMesh).toBe(emB);
  });
});
