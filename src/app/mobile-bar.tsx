/**
 * The row of buttons under the 3D view on a phone — the old screen's
 * `buildMobileBar`: the things a keyboard would do (undo, duplicate, delete,
 * Edit Mode) and the two touch-only switches (camera lock, multi-select).
 * Hidden on a desktop by styles.css.
 */
import { state, status } from "../state";
import { store } from "../store";
import { duplicateSelected, deleteSelected } from "../tools/actions";
import { useForge } from "./use-forge";

export function MobileBar({ onPrimitives }: { onPrimitives(): void }) {
  const camLocked = useForge((s) => s.cameraLocked);
  const multi = useForge((s) => s.multiSelectMode);
  const toggleCam = (): void => {
    state.cameraLocked = !state.cameraLocked;
    if (state.cameraLocked) {
      state.camera.detachControl();
      status("Camera locked");
    } else {
      state.camera.attachControl(state.canvas, true);
      status("Camera unlocked");
    }
  };
  const toggleMulti = (): void => {
    state.multiSelectMode = !state.multiSelectMode;
    store.notify();
  };
  return (
    <nav className="mob-bottom" aria-label="操作ボタン">
      <button type="button" className="mbtn" onClick={onPrimitives}>＋ Prim</button>
      <button type="button" className="mbtn" onClick={() => state.history.undo()}>↶ Undo</button>
      <button type="button" className="mbtn" onClick={duplicateSelected}>⎘ Dup</button>
      <button type="button" className="mbtn dan" onClick={deleteSelected}>✕ Del</button>
      <button type="button" className="mbtn pri" onClick={() => void import("../export/gltf-exporter").then((m) => m.exportGLB())}>⬇ Export</button>
      <button type="button" className="mbtn" onClick={() => void import("../export/gltf-exporter").then((m) => m.saveToLibrary())}>💾 Save</button>
      <button type="button" className="mbtn" onClick={() => void import("../export/gltf-exporter").then((m) => m.loadModelFromFile())}>📂 Load</button>
      <button type="button" className={"mbtn" + (camLocked ? " on" : "")} aria-pressed={camLocked} onClick={toggleCam}>🔒 Cam</button>
      <button type="button" className={"mbtn" + (multi ? " on" : "")} aria-pressed={multi} onClick={toggleMulti}>⊚ Multi</button>
      <button type="button" className="mbtn" aria-label="Toggle Edit Mode" onClick={() => void import("../tools/edit-mode").then((m) => m.toggleEditMode())}>✎ Edit</button>
    </nav>
  );
}
