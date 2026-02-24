/**
 * OPFS-based model store for GLB binary data.
 * Falls back to IndexedDB if OPFS is unavailable.
 */

const MODELS_DIR = "models";

async function getModelsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(MODELS_DIR, { create: true });
}

function hasOPFS(): boolean {
  return "storage" in navigator && "getDirectory" in navigator.storage;
}

// ── OPFS Implementation ──

async function saveToOPFS(id: string, data: ArrayBuffer): Promise<void> {
  const dir = await getModelsDir();
  const file = await dir.getFileHandle(id + ".glb", { create: true });
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}

async function loadFromOPFS(id: string): Promise<ArrayBuffer | null> {
  try {
    const dir = await getModelsDir();
    const file = await dir.getFileHandle(id + ".glb");
    const f = await file.getFile();
    return f.arrayBuffer();
  } catch {
    return null;
  }
}

async function deleteFromOPFS(id: string): Promise<void> {
  try {
    const dir = await getModelsDir();
    await dir.removeEntry(id + ".glb");
  } catch { /* ignore if not found */ }
}

async function listOPFS(): Promise<string[]> {
  const dir = await getModelsDir();
  const ids: string[] = [];
  // Use values() which is more widely typed; entries() may lack TS types
  for await (const entry of (dir as any).entries()) {
    const name = entry[0] as string;
    if (name.endsWith(".glb")) {
      ids.push(name.replace(".glb", ""));
    }
  }
  return ids;
}

// ── IndexedDB Fallback ──

const IDB_NAME = "forge3d_models";
const IDB_STORE = "blobs";

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveToIDB(id: string, data: ArrayBuffer): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(data, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadFromIDB(id: string): Promise<ArrayBuffer | null> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteFromIDB(id: string): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function listIDB(): Promise<string[]> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).getAllKeys();
    req.onsuccess = () => resolve((req.result as string[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

// ── Public API ──

export const modelStore = {
  async save(id: string, data: ArrayBuffer): Promise<void> {
    if (hasOPFS()) {
      try {
        return await saveToOPFS(id, data);
      } catch {
        // OPFS full or failed — fall back to IDB
      }
    }
    return saveToIDB(id, data);
  },

  async load(id: string): Promise<ArrayBuffer | null> {
    if (hasOPFS()) return loadFromOPFS(id);
    return loadFromIDB(id);
  },

  async delete(id: string): Promise<void> {
    if (hasOPFS()) return deleteFromOPFS(id);
    return deleteFromIDB(id);
  },

  async list(): Promise<string[]> {
    if (hasOPFS()) return listOPFS();
    return listIDB();
  },
};
