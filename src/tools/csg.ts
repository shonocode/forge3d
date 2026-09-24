import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { state, status } from "../state";
import { selectMesh } from "./selection";
import { applyDefaultEdges, applyShading } from "./mesh-utils";
import { addShadowCaster, removeShadowCaster } from "../viewport/shadows";
import { registerMeshForShading } from "../viewport/shading";
import { assignToActiveLayer } from "./layers";
import { buildEditMesh } from "./edit-mode/build";
import { toPolygons } from "./edit-mode/half-edge";
import { booleanBuffers, type RenderBuffer, type RenderResult } from "./csg-core";
import type { BooleanOperation } from "./boolean/boolean";
import { store } from "../store";

export type CSGOp = "union" | "subtract" | "intersect";

/** Auto Smooth angle for the result — the same 30° the Mesh Tools default to. */
const SHADE_ANGLE = (30 * Math.PI) / 180;

/**
 * A mesh's render buffer in world space, with its real faces when the
 * polygon metadata still matches (a quad stays a quad going into the boolean).
 */
function worldBuffer(mesh: Mesh): RenderBuffer | null {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const idx = mesh.getIndices();
  if (!pos || !idx) return null;
  const world = mesh.computeWorldMatrix(true);
  const out = new Float32Array(pos.length);
  const v = new Vector3();
  for (let i = 0; i < pos.length; i += 3) {
    Vector3.TransformCoordinatesFromFloatsToRef(pos[i]!, pos[i + 1]!, pos[i + 2]!, world, v);
    out[i] = v.x;
    out[i + 1] = v.y;
    out[i + 2] = v.z;
  }
  const em = buildEditMesh(mesh);
  return {
    positions: out,
    indices: Array.from(idx),
    uvs: mesh.getVerticesData(VertexBuffer.UVKind),
    polys: em ? toPolygons(em) : undefined,
  };
}

/** One boolean at a time — a second click while one runs is refused. */
let busy = false;

/**
 * Run the boolean in a Web Worker so the viewport keeps drawing (the exact
 * arithmetic takes seconds on a 10,000-triangle sphere); on the page's
 * thread where workers are unavailable.
 */
function runBoolean(a: RenderBuffer, b: RenderBuffer, operation: BooleanOperation): Promise<{ result: RenderResult; ms: number }> {
  if (typeof Worker === "undefined") {
    const t0 = performance.now();
    return Promise.resolve({ result: booleanBuffers(a, b, operation), ms: performance.now() - t0 });
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./csg-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: RenderResult; ms?: number; error?: string }>) => {
      worker.terminate();
      if (e.data.ok) resolve({ result: e.data.result!, ms: e.data.ms! });
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ a, b, operation });
  });
}

/**
 * Union / Subtract / Intersect of the first two selected meshes, through the
 * Blender-exact boolean (`booleanMesh`, ADR-012) — Subtract is first minus
 * second, as in Blender's Difference. The originals are hidden, not deleted,
 * so undo brings them back.
 *
 * Shapes that only touch at a point count as not overlapping — Blender's
 * exact solver says the same (measured: a box and the sphere inscribed in
 * it, `probe-csg-tangent.py`, give Blender's answer to the vertex).
 */
export async function doCSG(op: CSGOp): Promise<void> {
  if (busy) {
    status("⚠ CSG 計算中 — 終わるまで待ってください");
    return;
  }
  if (state.selectedMeshes.length < 2) {
    status("⚠ 2つのメッシュを選択してください");
    return;
  }
  const a = state.selectedMeshes[0]!;
  const b = state.selectedMeshes[1]!;
  if (!(a instanceof Mesh) || !(b instanceof Mesh)) {
    status("⚠ CSGにはMeshが必要です");
    return;
  }

  let nm: Mesh;
  busy = true;
  try {
    const ba = worldBuffer(a);
    const bb = worldBuffer(b);
    if (!ba || !bb) throw new Error("頂点データの無いメッシュがある");
    status(`CSG ${op} 計算中…（厳密計算。大きいメッシュは数秒かかる）`);
    const { result: r, ms } = await runBoolean(ba, bb, op === "subtract" ? "difference" : op);
    if (r.indices.length === 0) {
      status(`⚠ CSG ${op}: 結果が空 — 重なっていない、または全部削られた（点で接しているだけの形は Blender と同じく「重なっていない」扱い。少し動かすか大きさを変える）`);
      return;
    }
    state.meshCounter++;
    nm = new Mesh("csg_" + op + "_" + state.meshCounter, state.scene);
    const vd = new VertexData();
    vd.positions = r.positions;
    vd.indices = r.indices;
    if (r.uvs) vd.uvs = r.uvs;
    const normals = new Float32Array(r.positions.length);
    VertexData.ComputeNormals(r.positions, r.indices, normals);
    vd.normals = normals;
    vd.applyToMesh(nm, true);
    applyShading(nm, SHADE_ANGLE);
    nm.material = a.material;
    nm.isPickable = true;
    applyDefaultEdges(nm);
    registerMeshForShading(nm);
    assignToActiveLayer(nm);
    status(`CSG ${op} 完了 — ${r.faceCount} faces, ${ms.toFixed(0)} ms`);
  } catch (e) {
    console.error("CSG error:", e);
    status("⚠ CSG エラー: " + (e as Error).message);
    return;
  } finally {
    busy = false;
  }

  // Soft-delete originals (keep references for undo)
  const hideOriginals = (): void => {
    state.selectedMeshes = state.selectedMeshes.filter((x) => x !== a && x !== b);
    a.setEnabled(false);
    b.setEnabled(false);
    removeShadowCaster(a);
    removeShadowCaster(b);
    for (const m of [a, b]) {
      const i = state.allMeshes.indexOf(m);
      if (i >= 0) state.allMeshes.splice(i, 1);
    }
  };
  const showResult = (): void => {
    nm.setEnabled(true);
    addShadowCaster(nm);
    state.allMeshes.push(nm);
    selectMesh(nm, false);
    store.notify();
  };
  hideOriginals();
  showResult();

  state.history.push({
    label: "CSG " + op,
    undo() {
      nm.setEnabled(false);
      removeShadowCaster(nm);
      const ni = state.allMeshes.indexOf(nm);
      if (ni >= 0) state.allMeshes.splice(ni, 1);
      a.setEnabled(true);
      b.setEnabled(true);
      addShadowCaster(a);
      addShadowCaster(b);
      state.allMeshes.push(a);
      state.allMeshes.push(b);
      selectMesh(a, false);
      store.notify();
    },
    redo() {
      hideOriginals();
      showResult();
    },
  });
}
