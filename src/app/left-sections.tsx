/**
 * Left panel controls for the Measure, Layers and Hierarchy sections
 * (`LEFT_SECTIONS` ids `meas` / `lyr` / `hier` in `./guide/guide`). Ported
 * from the old screen:
 *
 * - Measure: `btnMeasure` / `btnClearMeasure` in `src/ui/bindings.ts`,
 *   calling `toggleMeasureMode` / `clearMeasurements` (`src/tools/measure.ts`).
 * - Layers: `updateLayerUI` / `renderLayerRow` in `src/ui/panels.ts` and
 *   `btnNewLayer` in `bindings.ts`, calling into `src/tools/layers.ts`.
 * - Hierarchy: `updateHierarchy` / `setOutlinerFilter` in `panels.ts`,
 *   `btnIsolate` / `btnSetParent` / `btnClearParent` in `bindings.ts`,
 *   calling `src/tools/selection.ts`, `src/tools/actions.ts` (delete,
 *   isolate) and `src/tools/parenting.ts` (children, set/clear parent).
 *
 * `src/app/left-panel.tsx` wraps each of these in `<SectionNote>` (heading +
 * note come from there); this file only renders the controls.
 */
import { useState } from "react";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { state, status, type LayerData } from "../state";
import { store } from "../store";
import { useForge } from "./use-forge";
import { getAlbedoColor } from "../materials/pbr-helpers";
import { toggleMeasureMode, clearMeasurements } from "../tools/measure";
import {
  createLayer,
  deleteLayer,
  getMeshesOnLayer,
  isLayerEffectivelyVisible,
  setActiveLayer,
  toggleLayerVisibility,
} from "../tools/layers";
import { selectMesh, lastSelected } from "../tools/selection";
import { deleteOne, isIsolated, toggleIsolate } from "../tools/actions";
import { getChildren, getRootMeshes, setParent, clearParent } from "../tools/parenting";
import "./left-sections.css";

// ── Measure ──

/** Measure Distance (toggle) / Clear All — old `btnMeasure` / `btnClearMeasure`. */
export function MeasureControls() {
  useForge(() => null); // re-render on status()'s store.setStatus (both actions call it)
  return (
    <>
      <button
        type="button"
        className="cbtn"
        aria-pressed={state.measuringActive}
        onClick={() => toggleMeasureMode()}
      >
        Measure Distance
      </button>
      <button type="button" className="cbtn" onClick={() => clearMeasurements()}>
        Clear All
      </button>
    </>
  );
}

// ── Layers ──

interface LayerRowData {
  layer: LayerData;
  depth: number;
}

/** Roots first, children indented, DFS — same order as old `updateLayerUI`. */
function layerRows(layers: LayerData[]): LayerRowData[] {
  const out: LayerRowData[] = [];
  const children = (id: string): LayerData[] => layers.filter((l) => l.parentId === id);
  const walk = (layer: LayerData, depth: number): void => {
    out.push({ layer, depth });
    for (const child of children(layer.id)) walk(child, depth + 1);
  };
  const roots = layers.filter((l) => !l.parentId || !layers.some((p) => p.id === l.parentId));
  for (const root of roots) walk(root, 0);
  return out;
}

function LayerRow({ layer, depth, active, deletable }: { layer: LayerData; depth: number; active: boolean; deletable: boolean }) {
  const count = getMeshesOnLayer(layer.id).length;
  const effVisible = isLayerEffectivelyVisible(layer.id);
  return (
    <div
      className={"layer-row sitem" + (active ? " sel" : "")}
      role="button"
      tabIndex={0}
      style={{ paddingLeft: 4 + depth * 14, opacity: effVisible ? 1 : 0.5 }}
      onClick={() => {
        setActiveLayer(layer.id);
        store.notify(); // activeLayerId is not in the store's fingerprint, and setActiveLayer pushes no history
      }}
    >
      <button
        type="button"
        className="eye-btn"
        title={layer.visible ? "Hide" : "Show"}
        aria-label={(layer.visible ? "Hide" : "Show") + " layer " + layer.name}
        onClick={(e) => {
          e.stopPropagation();
          toggleLayerVisibility(layer.id);
        }}
      >
        {layer.visible ? "\u{1F441}" : "○"}
      </button>
      <span className="name">{layer.name}</span>
      <span className="count">{count}</span>
      <button
        type="button"
        className="sub-btn"
        title="サブコレクションを作成"
        aria-label={"Add sub-collection under " + layer.name}
        onClick={(e) => {
          e.stopPropagation();
          createLayer(undefined, layer.id);
        }}
      >
        +
      </button>
      {deletable && (
        <button
          type="button"
          className="dl"
          aria-label={"Delete layer " + layer.name}
          onClick={(e) => {
            e.stopPropagation();
            deleteLayer(layer.id);
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** The layer list (visibility, active layer, nesting) + New Layer — old `updateLayerUI` / `btnNewLayer`. */
export function LayerControls() {
  useForge(() => null); // re-render on any store notify (layer create/delete/toggle push history; active-layer click notifies itself above)
  const rows = layerRows(state.layers);
  const deletable = state.layers.length > 1;
  return (
    <>
      <div className="layer-list">
        {rows.map(({ layer, depth }) => (
          <LayerRow key={layer.id} layer={layer} depth={depth} active={layer.id === state.activeLayerId} deletable={deletable} />
        ))}
      </div>
      <button type="button" className="cbtn" onClick={() => createLayer()}>
        + New Layer
      </button>
    </>
  );
}

// ── Hierarchy ──

interface MeshRowData {
  mesh: AbstractMesh;
  depth: number;
}

/**
 * Root meshes and their children, DFS. While filtering, a non-matching mesh
 * is skipped but its children are still walked (a match nested under a
 * non-match is not lost) and everything shown is flattened to depth 0 —
 * same behaviour as old `updateHierarchy`'s `addMeshItem`.
 */
function meshRows(filter: string): MeshRowData[] {
  const out: MeshRowData[] = [];
  const f = filter.trim().toLowerCase();
  const add = (m: AbstractMesh, depth: number): void => {
    if (f && !m.name.toLowerCase().includes(f)) {
      for (const child of getChildren(m)) add(child, 0);
      return;
    }
    out.push({ mesh: m, depth: f ? 0 : depth });
    for (const child of getChildren(m)) add(child, depth + 1);
  };
  for (const root of getRootMeshes()) add(root, 0);
  return out;
}

function HierarchyRow({ mesh, depth, selected }: { mesh: AbstractMesh; depth: number; selected: boolean }) {
  const col = getAlbedoColor(mesh.material)?.toHexString() ?? "#5b7fff";
  return (
    <div
      role="listitem"
      className={"sitem" + (selected ? " sel" : "")}
      style={{ paddingLeft: 8 + depth * 16, opacity: mesh.isVisible ? 1 : 0.45 }}
      onClick={(e) => selectMesh(mesh, e.ctrlKey || e.metaKey)}
    >
      <div className="cd" style={{ background: col }} />
      {depth > 0 && <span className="hier-indent">└</span>}
      <span>{mesh.name}</span>
      <button
        type="button"
        className="vis-btn"
        title="表示/非表示"
        aria-label={(mesh.isVisible ? "Hide" : "Show") + " " + mesh.name}
        style={{ opacity: mesh.isVisible ? 1 : 0.4 }}
        onClick={(e) => {
          e.stopPropagation();
          mesh.isVisible = !mesh.isVisible;
          store.notify(); // isVisible is not in the store's fingerprint
        }}
      >
        {mesh.isVisible ? "\u{1F441}" : "─"}
      </button>
      <button
        type="button"
        className="dl"
        aria-label={"Delete " + mesh.name}
        onClick={(e) => {
          e.stopPropagation();
          deleteOne(mesh.uniqueId);
        }}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Name filter, ◎ Isolate, the mesh tree, Set Parent / Clear Parent — old
 * `outlinerSearch` / `btnIsolate` / `sList` / `btnSetParent` / `btnClearParent`.
 */
export function HierarchyControls() {
  useForge(() => null); // re-render on selection/mesh-list changes (fingerprinted) and on status()-reporting actions below
  const [filter, setFilter] = useState("");
  const totalMeshes = state.allMeshes.length;
  const rows = meshRows(filter);

  const handleSetParent = (): void => {
    if (state.selectedMeshes.length < 2) {
      status("2つのメッシュを選択（Ctrl+click）");
      return;
    }
    const child = lastSelected()!;
    const parent = state.selectedMeshes.find((m) => m !== child)!;
    // setParent records its own undo. The old screen's button pushed a second
    // entry on top, whose undo called setParent / clearParent again — which
    // pushed yet another entry mid-undo and cleared the redo stack.
    setParent(child, parent);
  };

  const handleClearParent = (): void => {
    const m = lastSelected();
    if (!m || !m.parent) return;
    clearParent(m); // records its own undo, as setParent does
  };

  return (
    <>
      <div className="hier-toolbar">
        <input
          type="search"
          placeholder="🔍 filter…"
          aria-label="Filter meshes by name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className="cbtn"
          title="選択メッシュのみ表示 (再度押して解除)"
          aria-pressed={isIsolated()}
          onClick={() => toggleIsolate()}
        >
          ◎ Isolate
        </button>
      </div>
      {totalMeshes === 0 ? (
        <div className="empty">メッシュなし ― 上の Primitives から追加</div>
      ) : (
        <div className="slist" role="list">
          {rows.map(({ mesh, depth }) => (
            <HierarchyRow key={mesh.uniqueId} mesh={mesh} depth={depth} selected={state.selectedMeshes.includes(mesh)} />
          ))}
        </div>
      )}
      <div className="hier-parent-row">
        <button type="button" className="cbtn" onClick={handleSetParent}>
          Set Parent
        </button>
        <button type="button" className="cbtn" onClick={handleClearParent}>
          Clear Parent
        </button>
      </div>
    </>
  );
}
