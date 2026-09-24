// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ForgeStore } from "../store";
import { useForge, useStatus, type EditorState } from "./use-forge";
import { connectStore, type ConnectSource, type FrameSource } from "./connect";
import { UndoHistory } from "../undo";

afterEach(cleanup);

/** Just enough of the editor state for these components. */
function fakeState(): ConnectSource & { selectedMeshes: Array<{ uniqueId: number; name: string }> } {
  return {
    tool: "select",
    selectedMeshes: [],
    allMeshes: [],
    editMesh: null,
    sculpting: false,
    painting: false,
    weightPainting: false,
    boneEditMode: "edit",
    viewportMode: "textured",
    history: new UndoHistory(),
  };
}

/** A scene's after-render hook, driven by hand. */
function fakeFrames(): FrameSource & { frame(): void; count(): number } {
  const cbs = new Set<() => void>();
  return {
    onAfterRenderObservable: {
      add: (cb: () => void) => (cbs.add(cb), cb),
      remove: (o: unknown) => cbs.delete(o as () => void),
    },
    frame: () => cbs.forEach((cb) => cb()),
    count: () => cbs.size,
  };
}

function Selection({ src, forge }: { src: EditorState; forge: ForgeStore }) {
  const names = useForge((s) => s.selectedMeshes.map((m) => m.name).join(", ") || "なし", src, forge);
  return <p>選択: {names}</p>;
}

function Status({ forge }: { forge: ForgeStore }) {
  const line = useStatus(forge);
  return <p data-kind={line?.kind ?? "none"}>{line?.text ?? "—"}</p>;
}

describe("useForge + connectStore", () => {
  it("redraws when a frame finds the selection changed — a write that reports nothing", async () => {
    const forge = new ForgeStore();
    const src = fakeState();
    const frames = fakeFrames();
    connectStore(forge, src, frames);
    render(<Selection src={src as unknown as EditorState} forge={forge} />);
    expect(screen.getByText("選択: なし")).toBeTruthy();

    // Mutated in place, as the editor does; nothing is told.
    src.selectedMeshes.push({ uniqueId: 7, name: "box" });
    expect(screen.getByText("選択: なし")).toBeTruthy();
    await act(async () => {
      frames.frame();
    });
    expect(screen.getByText("選択: box")).toBeTruthy();
  });

  it("redraws on an undo-history change without waiting for a frame", async () => {
    const forge = new ForgeStore();
    const src = fakeState();
    connectStore(forge, src, fakeFrames());
    let renders = 0;
    function Counter() {
      renders++;
      const n = useForge((s) => s.history.undoCount(), src as unknown as EditorState, forge);
      return <p>undo {n}</p>;
    }
    render(<Counter />);
    const before = renders;
    await act(async () => {
      (src.history as UndoHistory).push({ label: "x", undo() {}, redo() {} });
    });
    expect(screen.getByText("undo 1")).toBeTruthy();
    expect(renders).toBe(before + 1);
  });

  it("shows the last status line with its kind", async () => {
    const forge = new ForgeStore();
    render(<Status forge={forge} />);
    expect(screen.getByText("—")).toBeTruthy();
    await act(async () => {
      forge.setStatus("⚠ CSGにはMeshが必要です");
    });
    expect(screen.getByText("⚠ CSGにはMeshが必要です").dataset.kind).toBe("error");
  });

  it("disconnecting stops both feeds", async () => {
    const forge = new ForgeStore();
    const src = fakeState();
    const frames = fakeFrames();
    const off = connectStore(forge, src, frames);
    expect(frames.count()).toBe(1);
    off();
    expect(frames.count()).toBe(0);
    let calls = 0;
    forge.subscribe(() => calls++);
    (src.history as UndoHistory).push({ label: "x", undo() {}, redo() {} });
    await Promise.resolve();
    expect(calls).toBe(0);
  });
});
