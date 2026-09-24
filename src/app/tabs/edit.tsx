/**
 * The Edit tab (ADR-014 port): Component Mode / gizmo mode, the operator
 * palette, and UV Unwrap — ported from `buildEditToolsPanel` in
 * `src/ui/builders.ts`. Also exports `snapControls` (Transform tab's Snap
 * section, from the `tb-xform` markup + the snap block in
 * `src/ui/bindings.ts`) and `ioControls` (the Export / Save block shared by
 * every tab).
 *
 * The heavy mesh-editing kernel (`tools/edit-mode`) is dynamic-imported per
 * action, same as the old screen — it pulls in half-edge / operator code
 * that most sessions never touch.
 *
 * Gizmo transform mode (Move/Rotate/Scale) is not part of the reactive
 * `state` object — it lives in a module-private variable inside
 * `tools/edit-mode` (`getEditGizmoMode()`). It is tracked here with local
 * `useState`, set optimistically on click and re-synced from the module
 * after every render (an effect with no dependency array; `setState` to an
 * unchanged primitive is a no-op re-render in React, so this is cheap). A
 * change originating purely from a keyboard shortcut with no other state
 * change would not immediately update the highlight — see the report.
 */
import { useEffect, useState, type ReactNode } from "react";
import { state, status, type ComponentMode } from "../../state";
import { store } from "../../store";
import { useForge } from "../use-forge";
import { keyLabel, type ActionId } from "../../keymap";
import { applySnapToGizmos } from "../../tools/snap";
import { duplicateSelected, deleteSelected } from "../../tools/actions";

type EditModeApi = typeof import("../../tools/edit-mode");
type EditGizmoMode = Parameters<EditModeApi["setEditGizmoMode"]>[0];

/** Load the edit-mode kernel and run `fn` against it. */
function runEdit(fn: (m: EditModeApi) => void): void {
  void import("../../tools/edit-mode").then(fn);
}

const COMP_KEY: Record<ComponentMode, ActionId> = {
  vertex: "comp.vertex",
  edge: "comp.edge",
  face: "comp.face",
};

const COMPONENT_MODES: { id: ComponentMode; label: string }[] = [
  { id: "vertex", label: "Vertex" },
  { id: "edge", label: "Edge" },
  { id: "face", label: "Face" },
];

const GIZMO_MODES: { id: EditGizmoMode; label: string }[] = [
  { id: "move", label: "Move" },
  { id: "rotate", label: "Rotate" },
  { id: "scale", label: "Scale" },
];

function ComponentModeSection() {
  const editMesh = useForge((s) => s.editMesh);
  const mode = useForge((s) => s.editSelection.mode);
  const proportional = useForge((s) => s.editConfig.proportional);
  const propRadius = useForge((s) => s.editConfig.proportionalRadius);
  const [gizmoMode, setGizmoMode] = useState<EditGizmoMode>("move");

  // Re-sync from the module's own state after every render — see file doc.
  useEffect(() => {
    void import("../../tools/edit-mode").then((m) => setGizmoMode(m.getEditGizmoMode()));
  });

  const selectMode = (m: ComponentMode): void => {
    if (!editMesh) {
      status("⚠ Enter Edit Mode (Tab) first");
      return;
    }
    runEdit((mod) => {
      mod.setComponentMode(m);
      // setComponentMode reports nothing and pushes no history — the store
      // would not otherwise see this write.
      store.notify();
    });
  };

  const selectGizmo = (g: EditGizmoMode): void => {
    if (!editMesh) {
      status("⚠ Enter Edit Mode (Tab) first");
      return;
    }
    setGizmoMode(g);
    runEdit((mod) => mod.setEditGizmoMode(g)); // reports its own status
  };

  return (
    <>
      <div className="choice-row" role="group" aria-label="Component mode">
        {COMPONENT_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={"abtn" + (mode === m.id ? " bon on" : "")}
            aria-label={`${m.label} mode`}
            aria-pressed={mode === m.id}
            onClick={() => selectMode(m.id)}
          >
            {m.label} ({keyLabel(COMP_KEY[m.id], "edit")})
          </button>
        ))}
      </div>
      <div className="choice-row" role="group" aria-label="Gizmo transform mode">
        {GIZMO_MODES.map((g) => (
          <button
            key={g.id}
            type="button"
            className={"abtn" + (gizmoMode === g.id ? " bon on" : "")}
            aria-label={`Gizmo ${g.label} mode`}
            aria-pressed={gizmoMode === g.id}
            onClick={() => selectGizmo(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>
      <label className="pr" title="選択の周囲 Radius 内の頂点も減衰しながら一緒に動く (Blender の O)">
        <input
          type="checkbox"
          checked={proportional}
          aria-label="Proportional editing"
          onChange={(e) => {
            state.editConfig.proportional = e.target.checked;
            store.notify();
          }}
        />
        ◉ Proportional (周辺も追従)
      </label>
      <div className="sr">
        <label>
          Prop. Radius <span>{propRadius.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0.05}
          max={3}
          step={0.05}
          value={propRadius}
          aria-label="Prop. Radius"
          onChange={(e) => {
            state.editConfig.proportionalRadius = +e.target.value;
            store.notify();
          }}
        />
      </div>
    </>
  );
}

interface OpDef {
  label: string;
  key: string;
  modes: ComponentMode[];
  run: (m: EditModeApi) => void;
}

// Same set and order as buildEditToolsPanel's `ops` array. "Edge Slide"'s
// key is G G (a double-press of edit.move) — not a single keymap binding,
// so it stays a literal like the old screen.
const OPS: OpDef[] = [
  { label: "Extrude", key: keyLabel("edit.extrude", "edit"), modes: ["face", "edge"], run: (m) => m.extrudeSelection() },
  { label: "Inset", key: keyLabel("edit.inset", "edit"), modes: ["face"], run: (m) => m.insetSelection() },
  { label: "Bevel", key: keyLabel("edit.bevel", "edit"), modes: ["edge"], run: (m) => m.bevelSelection() },
  { label: "Loop Cut", key: keyLabel("edit.loopCut", "edit"), modes: ["edge"], run: (m) => m.loopCutSelection() },
  { label: "Knife", key: keyLabel("edit.knife", "edit"), modes: ["vertex", "edge", "face"], run: (m) => { m.startKnifeCut(); } },
  { label: "Fill", key: keyLabel("edit.fill", "edit"), modes: ["vertex", "edge"], run: (m) => m.fillSelection() },
  { label: "Flip Diagonal", key: "", modes: ["vertex"], run: (m) => m.flipDiagonalSelection() },
  { label: "Edge Slide", key: "G G", modes: ["edge"], run: (m) => m.edgeSlideSelection() },
  { label: "Vertex Slide", key: keyLabel("edit.vertexSlide", "edit"), modes: ["vertex"], run: (m) => m.vertexSlideSelection() },
  { label: "Merge", key: keyLabel("edit.merge", "edit"), modes: ["vertex", "edge"], run: (m) => m.mergeSelection() },
  { label: "Bridge Loops", key: keyLabel("edit.bridge", "edit"), modes: ["edge"], run: (m) => m.bridgeSelection() },
  { label: "Mark Seam", key: "", modes: ["edge"], run: (m) => m.markSeamSelection() },
  { label: "Mark Crease", key: keyLabel("edit.markCrease", "edit"), modes: ["edge"], run: (m) => m.markCreaseSelection() },
  { label: "Set Crease σ", key: keyLabel("edit.setCrease", "edit"), modes: ["edge"], run: (m) => m.setCreaseSelection() },
  { label: "Tris to Quads", key: keyLabel("edit.trisToQuads", "edit"), modes: ["vertex", "edge", "face"], run: (m) => m.trisToQuadsSelection() },
  { label: "Quads to Tris", key: keyLabel("edit.quadsToTris", "edit"), modes: ["vertex", "edge", "face"], run: (m) => m.quadsToTrisSelection() },
  { label: "Subdivide (CC)", key: "", modes: ["vertex", "edge", "face"], run: (m) => m.subdivideSelection() },
  { label: "Delete", key: keyLabel("edit.delete", "edit"), modes: ["vertex", "edge", "face"], run: (m) => m.deleteSelection() },
];

function OperatorsSection() {
  const editMesh = useForge((s) => s.editMesh);
  const mode = useForge((s) => s.editSelection.mode);
  const insetAmount = useForge((s) => s.editConfig.insetAmount);
  const bevelOffset = useForge((s) => s.editConfig.bevelOffset);
  const slideAmount = useForge((s) => s.editConfig.slideAmount);
  const creaseWeight = useForge((s) => s.editConfig.creaseWeight);
  const inEdit = editMesh !== null;

  return (
    <>
      {OPS.map((op) => {
        const enabled = inEdit && op.modes.includes(mode);
        return (
          <button
            key={op.label}
            type="button"
            className="abtn"
            disabled={!enabled}
            aria-label={op.key ? `${op.label} (${op.key})` : op.label}
            onClick={() => runEdit(op.run)}
          >
            {op.label}
            {op.key ? ` (${op.key})` : ""}
          </button>
        );
      })}
      <div className="choice-row" role="group" aria-label="Selection">
        <button
          type="button"
          className="abtn"
          aria-label={`Select All (${keyLabel("select.all", "edit")})`}
          onClick={() => runEdit((m) => m.selectAllComponents())}
        >
          Select All
        </button>
        <button
          type="button"
          className="abtn"
          aria-label={`Box Select (${keyLabel("select.box", "edit")})`}
          onClick={() => runEdit((m) => { m.startBoxSelect(); })}
        >
          Box Select
        </button>
        <button
          type="button"
          className="abtn"
          aria-label="Clear selection"
          onClick={() =>
            runEdit((m) => {
              m.clearComponentSelection();
              // Reports nothing on its own.
              store.notify();
            })
          }
        >
          Clear
        </button>
      </div>
      <div className="sr">
        <label>
          Inset Amount <span>{insetAmount.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0}
          max={0.5}
          step={0.01}
          value={insetAmount}
          aria-label="Inset Amount"
          onChange={(e) => {
            state.editConfig.insetAmount = +e.target.value;
            store.notify();
          }}
        />
      </div>
      <div className="sr">
        <label>
          Bevel Offset % <span>{bevelOffset.toFixed(0)}</span>
        </label>
        <input
          type="range"
          min={0}
          max={49}
          step={1}
          value={bevelOffset}
          aria-label="Bevel Offset %"
          onChange={(e) => {
            state.editConfig.bevelOffset = +e.target.value;
            store.notify();
          }}
        />
      </div>
      <div className="sr">
        <label>
          Slide Amount <span>{slideAmount.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={-0.95}
          max={0.95}
          step={0.05}
          value={slideAmount}
          aria-label="Slide Amount"
          onChange={(e) => {
            state.editConfig.slideAmount = +e.target.value;
            store.notify();
          }}
        />
      </div>
      <div className="sr">
        <label>
          Crease Weight <span>{creaseWeight.toFixed(1)}</span>
        </label>
        <input
          type="range"
          min={0}
          max={4}
          step={0.5}
          value={creaseWeight}
          aria-label="Crease Weight"
          onChange={(e) => {
            state.editConfig.creaseWeight = +e.target.value;
            store.notify();
          }}
        />
      </div>
      <div className="mod-hint">
        Tab ↔ Object Mode ・ Click: select ・ Ctrl+click: add ・ Ctrl+Z / Shift+Ctrl+Z: undo / redo
      </div>
    </>
  );
}

function UVSection() {
  const method = useForge((s) => s.editConfig.unwrapMethod);

  return (
    <>
      <div className="choice-row" role="group" aria-label="UV unwrap method">
        <button
          type="button"
          className={"abtn" + (method === "project" ? " bon on" : "")}
          aria-pressed={method === "project"}
          title="平面投影（速い、平らな面向き）"
          onClick={() => {
            state.editConfig.unwrapMethod = "project";
            store.notify();
          }}
        >
          Project
        </button>
        <button
          type="button"
          className={"abtn" + (method === "conformal" ? " bon on" : "")}
          aria-pressed={method === "conformal"}
          title="LSCM 共形展開（角度を保つ、曲面の歪みが少ない）"
          onClick={() => {
            state.editConfig.unwrapMethod = "conformal";
            store.notify();
          }}
        >
          Conformal
        </button>
      </div>
      <button
        type="button"
        className="abtn"
        aria-label={`Smart UV Project (${keyLabel("edit.unwrap", "edit")})`}
        onClick={() => runEdit((m) => m.unwrapMesh())}
      >
        Smart UV Project ({keyLabel("edit.unwrap", "edit")})
      </button>
      <button
        type="button"
        className="abtn"
        aria-label="UV Editor"
        title="2D UV ビューで島の移動 / 回転 / 拡縮、頂点編集、ストレッチ可視化"
        onClick={() => {
          void import("../../ui/uv-editor").then((m) => m.openUVEditor());
        }}
      >
        🗺 UV Editor
      </button>
      <div className="mod-hint">
        Edge mode で辺を選び Mark Seam でシーム指定 → Smart UV Project。展開後は 🗺 UV Editor でレイアウト調整。
        ⚠ rig 済みメッシュには使えない
      </div>
    </>
  );
}

/** The Edit tab's sections (`cm`, `ops`, `uv` — see `TAB_SECTIONS.edit`). */
export const editControls: Record<string, () => ReactNode> = {
  cm: () => <ComponentModeSection />,
  ops: () => <OperatorsSection />,
  uv: () => <UVSection />,
};

const SNAP_STORAGE_KEY = "forge3d_snap";

function SnapControls() {
  const cfg = useForge((s) => s.snapConfig);

  // Restore from localStorage once — the old screen did this at startup in
  // bindings.ts, which the new screen's boot() does not call.
  useEffect(() => {
    const saved = localStorage.getItem(SNAP_STORAGE_KEY);
    if (!saved) return;
    try {
      Object.assign(state.snapConfig, JSON.parse(saved));
    } catch {
      /* ignore */
    }
    applySnapToGizmos();
    store.notify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (patch: Partial<typeof state.snapConfig>): void => {
    Object.assign(state.snapConfig, patch);
    applySnapToGizmos();
    localStorage.setItem(SNAP_STORAGE_KEY, JSON.stringify(state.snapConfig));
    store.notify();
  };

  return (
    <>
      <div className="pr">
        <span className="pl">Position</span>
        <input
          type="checkbox"
          checked={cfg.positionEnabled}
          aria-label="Position snap enabled"
          onChange={(e) => set({ positionEnabled: e.target.checked })}
        />
        <input
          type="number"
          className="pi"
          value={cfg.positionIncrement}
          step={0.1}
          min={0.05}
          aria-label="Position snap value"
          onChange={(e) => set({ positionIncrement: Math.max(0.01, +e.target.value || 0.5) })}
        />
      </div>
      <div className="pr">
        <span className="pl">Rotation</span>
        <input
          type="checkbox"
          checked={cfg.rotationEnabled}
          aria-label="Rotation snap enabled"
          onChange={(e) => set({ rotationEnabled: e.target.checked })}
        />
        <input
          type="number"
          className="pi"
          value={cfg.rotationIncrement}
          step={5}
          min={1}
          aria-label="Rotation snap value"
          onChange={(e) => set({ rotationIncrement: Math.max(1, +e.target.value || 15) })}
        />
      </div>
      <div className="pr">
        <span className="pl">Scale</span>
        <input
          type="checkbox"
          checked={cfg.scaleEnabled}
          aria-label="Scale snap enabled"
          onChange={(e) => set({ scaleEnabled: e.target.checked })}
        />
        <input
          type="number"
          className="pi"
          value={cfg.scaleIncrement}
          step={0.05}
          min={0.01}
          aria-label="Scale snap value"
          onChange={(e) => set({ scaleIncrement: Math.max(0.01, +e.target.value || 0.25) })}
        />
      </div>
    </>
  );
}

/** The Transform tab's Snap section. */
export const snapControls = (): ReactNode => <SnapControls />;

function IoControls() {
  return (
    <>
      <div className="choice-row">
        <button
          type="button"
          className="abtn pri"
          aria-label="Export GLB"
          onClick={() => {
            void import("../../export/gltf-exporter").then((m) => void m.exportGLB());
          }}
        >
          ⬇ GLB
        </button>
        <button
          type="button"
          className="abtn"
          aria-label="Export OBJ"
          onClick={() => {
            void import("../../export/gltf-exporter").then((m) => m.exportOBJ());
          }}
        >
          OBJ
        </button>
      </div>
      <button
        type="button"
        className="abtn"
        onClick={() => {
          void import("../../export/gltf-exporter").then((m) => void m.saveToLibrary());
        }}
      >
        💾 Save to Library
      </button>
      <button
        type="button"
        className="abtn"
        onClick={() => {
          void import("../../export/gltf-exporter").then((m) => m.loadModelFromFile());
        }}
      >
        📂 Load Model
      </button>
      <button
        type="button"
        className="abtn"
        onClick={() => {
          void import("../../export/project-io").then((m) => void m.exportProject());
        }}
      >
        📦 Export Project
      </button>
      <button
        type="button"
        className="abtn"
        onClick={() => {
          void import("../../export/project-io").then((m) => m.openProjectDialog());
        }}
      >
        📂 Open Project
      </button>
      <button type="button" className="abtn" onClick={() => duplicateSelected()}>
        ⎘ Duplicate
      </button>
      <button type="button" className="abtn dan" onClick={() => deleteSelected()}>
        ✕ Delete
      </button>
    </>
  );
}

/** The Export / Save section shared by every tab. */
export const ioControls = (): ReactNode => <IoControls />;
