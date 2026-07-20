/**
 * Auto-save: periodically checkpoint scene to IDB for crash recovery.
 */
import { state } from "../state";

const DB_NAME = "forge3d_autosave";
const STORE = "checkpoint";
const KEY = "latest";
const INTERVAL = 30_000; // 30 seconds

let _timer: ReturnType<typeof setInterval> | null = null;
let _saving = false;
let _db: IDBDatabase | null = null;
/** Scene signature at the last successful checkpoint — unchanged = skip. */
let _lastSavedSig = "";

/**
 * Cheap change signature: the undo-history edit counter covers every
 * undoable operation, the mesh count catches non-undoable imports. Live
 * tweaks that bypass history (layer opacity sliders etc.) are picked up by
 * the next history-bumping edit — an acceptable approximation for a crash
 * checkpoint.
 */
function sceneSignature(): string {
  return state.history.version + ":" + state.allMeshes.length;
}

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

async function saveCheckpoint(data: ArrayBuffer): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ data, timestamp: Date.now() }, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadCheckpoint(): Promise<{ data: ArrayBuffer; timestamp: number } | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function clearCheckpoint(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

async function doAutoSave(): Promise<void> {
  if (_saving || !state.allMeshes.length) return;
  // Differential skip: nothing changed since the last checkpoint → don't
  // re-serialize the whole scene (GLB export causes a visible hitch on
  // large scenes and burns battery when idle).
  const sig = sceneSignature();
  if (sig === _lastSavedSig) return;
  _saving = true;
  // Lazy imports keep the initial bundle small and avoid circular deps.
  const { GLTF2Export } = await import("@babylonjs/serializers/glTF");
  const { getActiveSkeleton } = await import("../tools/skeleton-tool");
  const { prepareExportRig, disposeExportRig } = await import("../export/skeleton-export-bridge");
  type Rig = Awaited<ReturnType<typeof prepareExportRig>>;

  const skelData = getActiveSkeleton();
  let rig: Rig | null = null;
  try {
    if (skelData && skelData.bones.length > 0) {
      rig = prepareExportRig(skelData, state.scene);
    }
    const result = await GLTF2Export.GLBAsync(state.scene, "autosave", {
      shouldExportNode(node) {
        if (node.name.startsWith("bone_visual_") || node.name === "bone_hierarchy_lines") return false;
        if (node.name.startsWith("boneTN_")) return true;
        return state.allMeshes.includes(node as never);
      },
      shouldExportAnimation: () => true,
      animationSampleRate: 30,
    });
    const glbFile = result.glTFFiles["autosave.glb"];
    if (glbFile) {
      const blob = glbFile as Blob;
      const buffer = await blob.arrayBuffer();
      await saveCheckpoint(buffer);
      _lastSavedSig = sig;
    }
  } catch (e) {
    console.warn("Auto-save failed:", e);
  } finally {
    if (skelData && rig) disposeExportRig(skelData, rig);
    _saving = false;
  }
}

export function startAutoSave(): void {
  if (_timer) return;
  _timer = setInterval(() => void doAutoSave(), INTERVAL);
}

export function stopAutoSave(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
