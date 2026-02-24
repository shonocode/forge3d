import { Tools } from "@babylonjs/core/Misc/tools";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { state, E } from "../state";
import type { BoneData, SkeletonData } from "../state";
import { selectMesh, lastSelected } from "../tools/selection";
import { deleteOne } from "../tools/actions";
import { updateMorphUI } from "../tools/morph";
import { selectBone, getActiveSkeleton } from "../tools/skeleton-tool";
import { refreshWeightOverlay, hasWeightData } from "../tools/weight-paint";
import { getActiveClip } from "../tools/animation-tool";
import { placeModel, deleteFromLibrary, removeMapInstance } from "../tools/map-editor";
import type { ModelMetadata } from "../storage/metadata-store";
import { PALETTE } from "../tools/primitives";

// Callback to avoid circular dependency with animation-tool
let _scrubCallback: ((frame: number) => void) | null = null;
export function registerScrubCallback(cb: (frame: number) => void): void {
  _scrubCallback = cb;
}

export function updateHierarchy(): void {
  const el = E("sList");
  el.innerHTML = "";
  for (const m of state.allMeshes) {
    const d = document.createElement("div");
    d.className = "sitem" + (state.selectedMeshes.includes(m) ? " sel" : "");
    const mat = m.material as StandardMaterial | null;
    const col = mat?.diffuseColor?.toHexString() ?? "#5b7fff";
    d.innerHTML = `<div class="cd" style="background:${col}"></div><span>${m.name}</span>
      <button class="dl" data-name="${m.name}">✕</button>`;
    d.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("dl")) return;
      selectMesh(m, e.ctrlKey || e.metaKey);
    });
    const delBtn = d.querySelector<HTMLElement>(".dl")!;
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteOne(m.name);
    });
    // Long press for multi-select on mobile
    let lt: ReturnType<typeof setTimeout>;
    d.addEventListener("touchstart", () => { lt = setTimeout(() => selectMesh(m, true), 500); }, { passive: true });
    d.addEventListener("touchend", () => clearTimeout(lt), { passive: true });
    d.addEventListener("touchmove", () => clearTimeout(lt), { passive: true });
    el.appendChild(d);
  }
}

export function updateProperties(): void {
  updateTransform();
  updateMaterial();
  updateMorphUI();
}

export function updateTransform(): void {
  const el = E("xfC");
  if (!state.selectedMeshes.length) {
    el.innerHTML = '<div class="empty">メッシュを選択</div>';
    return;
  }
  const m = lastSelected()!;
  el.innerHTML = `
    <div class="pg"><div class="pgt">Position</div>${v3h("pos", m.position)}</div>
    <div class="pg"><div class="pgt">Rotation (°)</div>${v3h("rot", { x: deg(m.rotation.x), y: deg(m.rotation.y), z: deg(m.rotation.z) })}</div>
    <div class="pg"><div class="pgt">Scale</div>${v3h("scl", m.scaling)}</div>`;
  el.querySelectorAll<HTMLInputElement>(".pi").forEach((inp) => {
    inp.addEventListener("input", () => {
      const [g, a] = inp.dataset.b!.split("_") as [string, "x" | "y" | "z"];
      const v = parseFloat(inp.value) || 0;
      if (g === "pos") m.position[a] = v;
      else if (g === "rot") m.rotation[a] = rad(v);
      else if (g === "scl") m.scaling[a] = v;
    });
  });
}

function v3h(pf: string, v: { x: number; y: number; z: number }): string {
  return (["x", "y", "z"] as const)
    .map(
      (a) =>
        `<div class="pr"><span class="pl ${a}">${a.toUpperCase()}</span><input type="number" step="0.1" class="pi" data-b="${pf}_${a}" value="${v[a].toFixed(3)}"></div>`
    )
    .join("");
}

function deg(r: number): number { return Tools.ToDegrees(r); }
function rad(d: number): number { return Tools.ToRadians(d); }

export function updateMaterial(): void {
  const el = E("matC");
  if (!state.selectedMeshes.length) {
    el.innerHTML = '<div class="empty">メッシュを選択</div>';
    return;
  }
  const m = lastSelected()!;
  const mt = m.material as StandardMaterial | null;
  if (!mt?.diffuseColor) {
    el.innerHTML = '<div class="empty">No material</div>';
    return;
  }
  el.innerHTML = `
    <div class="pg"><div class="pgt">Color</div>
      <div class="cgrid">${PALETTE.map((c) => `<div class="csw" style="background:${c}" data-col="${c}"></div>`).join("")}</div>
      <div class="pr" style="margin-top:6px"><span class="pl">🎨</span>
        <input type="color" value="${mt.diffuseColor.toHexString()}" id="matColorPicker"
          style="flex:1;min-height:26px;border:none;cursor:pointer;background:var(--bg2);border-radius:3px;padding:0;"></div>
    </div>
    <div class="pg"><div class="pgt">Properties</div>
      <div class="sr"><label>Spec Power <span id="spV">${(mt.specularPower || 48) | 0}</span></label>
        <input type="range" min="1" max="256" value="${mt.specularPower || 48}" id="matSpecPower"></div>
      <div class="sr"><label>Alpha <span id="alV">${(mt.alpha != null ? mt.alpha : 1).toFixed(2)}</span></label>
        <input type="range" min="0" max="1" step=".05" value="${mt.alpha != null ? mt.alpha : 1}" id="matAlpha"></div>
      <div class="pr"><span class="pl" style="font-size:10px;color:var(--t3)">Wire</span>
        <input type="checkbox" ${mt.wireframe ? "checked" : ""} id="matWire" style="margin-left:auto"></div>
    </div>`;

  // Attach events
  el.querySelectorAll<HTMLElement>(".csw").forEach((sw) =>
    sw.addEventListener("click", () => setColor(sw.dataset.col!))
  );
  el.querySelector<HTMLInputElement>("#matColorPicker")?.addEventListener("change", function () {
    setColor(this.value);
  });
  el.querySelector<HTMLInputElement>("#matSpecPower")?.addEventListener("input", function () {
    (lastSelected()!.material as StandardMaterial).specularPower = +this.value;
    E("spV").textContent = String(+this.value | 0);
  });
  el.querySelector<HTMLInputElement>("#matAlpha")?.addEventListener("input", function () {
    (lastSelected()!.material as StandardMaterial).alpha = +this.value;
    E("alV").textContent = (+this.value).toFixed(2);
  });
  el.querySelector<HTMLInputElement>("#matWire")?.addEventListener("change", function () {
    (lastSelected()!.material as StandardMaterial).wireframe = this.checked;
  });
}

function setColor(hex: string): void {
  if (!state.selectedMeshes.length) return;
  const m = lastSelected()!;
  const mat = m.material as StandardMaterial;
  const c = Color3.FromHexString(hex);
  mat.diffuseColor = c;
  mat.emissiveColor = c.scale(0.03);
  updateHierarchy();
}

// ── Bone UI ──

export function updateBoneUI(): void {
  updateSkeletonInfo();
  updateBoneHierarchy();
  updateBoneProperties();
  refreshWeightOverlay();
}

function updateSkeletonInfo(): void {
  const el = E("skelC");
  const skelData = getActiveSkeleton();
  if (!skelData) {
    el.innerHTML = '<div class="empty">BONEツールで骨格を作成</div>';
    return;
  }
  const name = skelData.skeleton.name;
  const count = skelData.bones.length;
  const assigned = skelData.assignedMesh?.name ?? "未割当";
  el.innerHTML = `
    <div style="font-size:10px;color:var(--t2);line-height:1.6;">
      <div><span style="color:var(--t4)">Name:</span> ${name}</div>
      <div><span style="color:var(--t4)">Bones:</span> ${count}</div>
      <div><span style="color:var(--t4)">Mesh:</span> ${assigned}</div>
    </div>`;
}

function updateBoneHierarchy(): void {
  const el = E("boneList");
  const skelData = getActiveSkeleton();
  if (!skelData || !skelData.bones.length) {
    el.innerHTML = '<div class="empty">ボーンなし</div>';
    return;
  }
  el.innerHTML = "";
  for (const bd of skelData.bones) {
    const depth = getBoneDepth(bd, skelData);
    const div = document.createElement("div");
    div.className = "sitem" + (bd.id === state.selectedBoneId ? " sel" : "");
    div.style.paddingLeft = (8 + depth * 12) + "px";
    div.innerHTML = `<span style="color:var(--ac);font-size:10px;">●</span><span>${bd.name}</span>`;
    div.addEventListener("click", () => {
      selectBone(bd.id);
      updateBoneUI();
    });
    el.appendChild(div);
  }
}

function updateBoneProperties(): void {
  const el = E("boneProps");
  const skelData = getActiveSkeleton();
  if (!skelData || !state.selectedBoneId) {
    el.innerHTML = '<div class="empty">ボーンを選択</div>';
    return;
  }
  const bd = skelData.bones.find((b) => b.id === state.selectedBoneId);
  if (!bd) {
    el.innerHTML = '<div class="empty">ボーンを選択</div>';
    return;
  }
  const pos = bd.visual?.position;
  const parentName = bd.parentId
    ? skelData.bones.find((b) => b.id === bd.parentId)?.name ?? "—"
    : "— (root)";
  el.innerHTML = `
    <div style="font-size:10px;color:var(--t2);line-height:1.6;">
      <div><span style="color:var(--t4)">Name:</span> ${bd.name}</div>
      <div><span style="color:var(--t4)">Parent:</span> ${parentName}</div>
      ${pos ? `<div><span style="color:var(--t4)">Pos:</span> ${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}</div>` : ""}
    </div>`;
}

function getBoneDepth(bd: BoneData, skelData: SkeletonData): number {
  let depth = 0;
  let current = bd;
  while (current.parentId) {
    depth++;
    const parent = skelData.bones.find((b) => b.id === current.parentId);
    if (!parent) break;
    current = parent;
  }
  return depth;
}

// ── Animation UI ──

export function updateAnimUI(): void {
  updateAnimClipInfo();
  updateKeyframeList();
  updateImportedAnimUI();
}

function updateAnimClipInfo(): void {
  const el = E("animClipInfo");
  const clip = getActiveClip();
  if (!clip) {
    el.innerHTML = '<div class="empty">クリップを作成してアニメーション</div>';
    return;
  }
  const trackCount = clip.tracks.length;
  let kfCount = 0;
  for (const t of clip.tracks) kfCount += t.keyframes.length;
  el.innerHTML = `
    <div style="font-size:10px;color:var(--t2);line-height:1.6;">
      <div><span style="color:var(--t4)">Name:</span> ${clip.name}</div>
      <div><span style="color:var(--t4)">FPS:</span> ${clip.frameRate}</div>
      <div><span style="color:var(--t4)">Frames:</span> ${clip.maxFrames}</div>
      <div><span style="color:var(--t4)">Loop:</span> ${clip.loopMode}</div>
      <div><span style="color:var(--t4)">Tracks:</span> ${trackCount}</div>
      <div><span style="color:var(--t4)">Keyframes:</span> ${kfCount}</div>
    </div>`;
}

function updateKeyframeList(): void {
  const el = E("kfList");
  const clip = getActiveClip();
  if (!clip || !state.selectedBoneId) {
    el.innerHTML = '<div class="empty">ボーンを選択してキーフレーム表示</div>';
    return;
  }
  const track = clip.tracks.find((t) => t.boneId === state.selectedBoneId);
  if (!track || track.keyframes.length === 0) {
    el.innerHTML = '<div class="empty">キーフレームなし</div>';
    return;
  }
  el.innerHTML = "";
  for (const kf of track.keyframes) {
    const div = document.createElement("div");
    div.className = "sitem";
    div.style.fontSize = "10px";
    div.style.cursor = "pointer";
    const rx = kf.rotation.x.toFixed(2);
    const ry = kf.rotation.y.toFixed(2);
    const rz = kf.rotation.z.toFixed(2);
    div.innerHTML = `<span style="color:var(--ac);min-width:32px">F${kf.frame}</span><span style="color:var(--t3)">R(${rx},${ry},${rz})</span>`;
    div.addEventListener("click", () => {
      (E("animFrame") as HTMLInputElement).value = String(kf.frame);
      E("afV").textContent = String(kf.frame);
      _scrubCallback?.(kf.frame);
    });
    el.appendChild(div);
  }
}

// ── Imported Animation UI ──

function updateImportedAnimUI(): void {
  const el = document.getElementById("importedAnimC");
  if (!el) return;

  if (state.importedAnimGroups.length === 0) {
    el.innerHTML = "";
    return;
  }

  const options = state.importedAnimGroups
    .map((g, i) => `<option value="${i}">${g.name || "Anim_" + i}</option>`)
    .join("");

  el.innerHTML = `
    <div style="margin-top:8px;border-top:1px solid var(--bg3);padding-top:6px;">
      <div style="font-size:10px;color:var(--t4);margin-bottom:4px;">Imported Animations (${state.importedAnimGroups.length})</div>
      <select id="importedAnimSelect" style="width:100%;font-size:10px;padding:3px;background:var(--bg2);color:var(--t1);border:1px solid var(--bg3);border-radius:3px;margin-bottom:4px;">
        ${options}
      </select>
      <div style="display:flex;gap:4px;">
        <button class="abtn" id="playImportedAnim" style="flex:1;">▶ Play</button>
        <button class="abtn" id="stopImportedAnim" style="flex:1;">■ Stop</button>
      </div>
    </div>`;

  // Bind events inline (re-binds each update, but simple and reliable)
  el.querySelector("#playImportedAnim")?.addEventListener("click", () => {
    const select = document.getElementById("importedAnimSelect") as HTMLSelectElement;
    const idx = parseInt(select.value);
    if (isNaN(idx) || idx < 0 || idx >= state.importedAnimGroups.length) return;
    // Stop any currently playing
    for (const ag of state.importedAnimGroups) ag.stop();
    if (state.animPreviewGroup) {
      state.animPreviewGroup.stop();
      state.animPreviewGroup = null;
    }
    const group = state.importedAnimGroups[idx]!;
    group.start(true); // loop
    state.isPlaying = true;
  });

  el.querySelector("#stopImportedAnim")?.addEventListener("click", () => {
    for (const ag of state.importedAnimGroups) ag.stop();
    if (state.animPreviewGroup) {
      state.animPreviewGroup.stop();
      state.animPreviewGroup = null;
    }
    state.isPlaying = false;
  });
}

// ── Map Editor UI ──

export function updateModelLibrary(models: ModelMetadata[]): void {
  const el = E("modelLib");
  if (models.length === 0) {
    el.innerHTML = '<div class="empty">Save to Libraryでモデルを保存</div>';
    return;
  }
  el.innerHTML = "";
  for (const meta of models) {
    const div = document.createElement("div");
    div.style.cssText = "display:flex;gap:6px;padding:4px;border-bottom:1px solid var(--bg3);align-items:center;";

    // Thumbnail
    if (meta.thumbnail) {
      const img = document.createElement("img");
      img.src = meta.thumbnail;
      img.style.cssText = "width:40px;height:40px;object-fit:cover;border-radius:3px;background:var(--bg2);";
      div.appendChild(img);
    }

    // Info + buttons
    const info = document.createElement("div");
    info.style.cssText = "flex:1;min-width:0;";
    const nameSpan = document.createElement("div");
    nameSpan.style.cssText = "font-size:10px;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    nameSpan.textContent = meta.name;
    const sizeSpan = document.createElement("div");
    sizeSpan.style.cssText = "font-size:9px;color:var(--t4);";
    sizeSpan.textContent = meta.size ? formatBytes(meta.size) : "";
    info.appendChild(nameSpan);
    info.appendChild(sizeSpan);
    div.appendChild(info);

    // Place button
    const placeBtn = document.createElement("button");
    placeBtn.className = "abtn";
    placeBtn.style.cssText = "padding:2px 6px;font-size:9px;min-width:0;";
    placeBtn.textContent = "+";
    placeBtn.title = "Place in scene";
    placeBtn.addEventListener("click", () => {
      placeBtn.disabled = true;
      void placeModel(meta.id, meta.name).then(() => updateMapInstances()).finally(() => { placeBtn.disabled = false; });
    });
    div.appendChild(placeBtn);

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.className = "abtn dan";
    delBtn.style.cssText = "padding:2px 6px;font-size:9px;min-width:0;";
    delBtn.textContent = "✕";
    delBtn.title = "Delete from library";
    delBtn.addEventListener("click", () => {
      delBtn.disabled = true;
      void deleteFromLibrary(meta.id).then(() => {
        import("../tools/map-editor").then((m) =>
          m.loadModelLibrary().then((updated) => updateModelLibrary(updated))
        );
      });
    });
    div.appendChild(delBtn);

    el.appendChild(div);
  }
}

export function updateMapInstances(): void {
  const el = E("mapInstList");
  if (state.mapInstances.length === 0) {
    el.innerHTML = '<div class="empty">ライブラリからモデルを配置</div>';
    return;
  }
  el.innerHTML = "";
  for (const inst of state.mapInstances) {
    const div = document.createElement("div");
    div.className = "sitem";
    div.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;";

    const nameSpan = document.createElement("span");
    nameSpan.style.cssText = "flex:1;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    nameSpan.textContent = inst.modelName;
    div.appendChild(nameSpan);

    // Select on click
    div.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      const mesh = state.allMeshes.find((m) => inst.meshUniqueIds.includes(m.uniqueId));
      if (mesh) selectMesh(mesh, false);
    });

    // Remove button
    const delBtn = document.createElement("button");
    delBtn.className = "abtn dan";
    delBtn.style.cssText = "padding:2px 6px;font-size:9px;min-width:0;";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", () => {
      removeMapInstance(inst.instanceId);
      updateMapInstances();
    });
    div.appendChild(delBtn);

    el.appendChild(div);
  }
}

export function updateWeightInfo(): void {
  const el = E("weightInfo");
  const m = lastSelected();
  if (!m || !m.skeleton) {
    el.innerHTML = '<div class="empty">\u30b9\u30b1\u30eb\u30c8\u30f3\u3092\u30a2\u30bf\u30c3\u30c1\u3057\u305f\u30e1\u30c3\u30b7\u30e5\u3092\u9078\u629e</div>';
    return;
  }
  const hasW = hasWeightData(m);
  const boneCount = m.skeleton.bones.length;
  const boneName = state.selectedBoneId
    ? (state.skeletonMap.get(state.activeSkeletonId!)?.bones.find((b) => b.id === state.selectedBoneId)?.name ?? "\u2014")
    : "\u672a\u9078\u629e";
  el.innerHTML = `
    <div style="font-size:10px;color:var(--t2);line-height:1.6;">
      <div><span style="color:var(--t4)">Weight Data:</span> ${hasW ? "\u2713 initialized" : "\u2715 not initialized"}</div>
      <div><span style="color:var(--t4)">Bones:</span> ${boneCount}</div>
      <div><span style="color:var(--t4)">Active Bone:</span> ${boneName}</div>
    </div>`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
