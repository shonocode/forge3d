import { Tools } from "@babylonjs/core/Misc/tools";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { getAlbedoColor } from "../materials/pbr-helpers";
import { getTextureInfo, importTextureForSlot, clearTextureSlot, type TextureSlot } from "../tools/texture-import";
import { state, E, status } from "../state";
import type { BoneData, SkeletonData } from "../state";
import { selectMesh, lastSelected } from "../tools/selection";
import { deleteOne } from "../tools/actions";
import { updateMorphUI } from "../tools/morph";
import { escapeHtml } from "./escape";
import { selectBone, getActiveSkeleton } from "../tools/skeleton-tool";
import { getRootMeshes, getChildren } from "../tools/parenting";
import { getModifiers, removeModifier, toggleModifier, updateModifierParam, applyModifier } from "../tools/modifiers";
import { setActiveLayer, toggleLayerVisibility, deleteLayer, getMeshesOnLayer } from "../tools/layers";
import { removeLight, updateLightParam, selectLight } from "../tools/lighting";
import { getBoundingDimensions } from "../tools/measure";
import type { Modifier } from "../state";
import { refreshWeightOverlay, hasWeightData } from "../tools/weight-paint";
import { getActiveClip, getKeyframeEasing } from "../tools/animation-tool";
import { placeModel, deleteFromLibrary, removeMapInstance } from "../tools/map-editor";
import type { ModelMetadata } from "../storage/metadata-store";
import { PALETTE } from "../tools/primitives";

// Callbacks to avoid circular dependencies
let _scrubCallback: ((frame: number) => void) | null = null;
export function registerScrubCallback(cb: (frame: number) => void): void {
  _scrubCallback = cb;
}

let _cacheTransformCallback: ((inputs: HTMLInputElement[]) => void) | null = null;
export function registerCacheTransformCallback(cb: (inputs: HTMLInputElement[]) => void): void {
  _cacheTransformCallback = cb;
}

export function updateHierarchy(): void {
  const el = E("sList");
  el.innerHTML = "";

  function addMeshItem(m: import("@babylonjs/core").AbstractMesh, depth: number): void {
    const d = document.createElement("div");
    d.className = "sitem" + (state.selectedMeshes.includes(m) ? " sel" : "");
    d.style.paddingLeft = (8 + depth * 16) + "px";
    const col = getAlbedoColor(m.material)?.toHexString() ?? "#5b7fff";
    const indent = depth > 0 ? '<span style="color:var(--t4);margin-right:4px;font-size:8px;">└</span>' : "";
    d.innerHTML = `<div class="cd" style="background:${col}"></div>${indent}<span>${escapeHtml(m.name)}</span>
      <button class="dl">✕</button>`;
    d.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("dl")) return;
      selectMesh(m, e.ctrlKey || e.metaKey);
    });
    const delBtn = d.querySelector<HTMLElement>(".dl")!;
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteOne(m.uniqueId);
    });
    // Long press for multi-select on mobile
    let lt: ReturnType<typeof setTimeout>;
    d.addEventListener("touchstart", () => { lt = setTimeout(() => selectMesh(m, true), 500); }, { passive: true });
    d.addEventListener("touchend", () => clearTimeout(lt), { passive: true });
    d.addEventListener("touchmove", () => clearTimeout(lt), { passive: true });
    el.appendChild(d);

    // Recurse into children
    for (const child of getChildren(m)) {
      addMeshItem(child, depth + 1);
    }
  }

  for (const root of getRootMeshes()) {
    addMeshItem(root, 0);
  }
}

export function updateProperties(): void {
  updateTransform();
  updateDimensions();
  updateMaterial();
  updateMorphUI();
  updateModifierUI();
}

export function updateDimensions(): void {
  const el = E("dimensionsDisplay");
  const txt = E("dimText");
  if (!state.selectedMeshes.length) {
    el.style.display = "none";
    return;
  }
  const m = lastSelected()!;
  const dims = getBoundingDimensions(m);
  if (!dims) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  txt.innerHTML = `W: ${dims.w.toFixed(3)} m &nbsp; H: ${dims.h.toFixed(3)} m &nbsp; D: ${dims.d.toFixed(3)} m`;
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
  const inputs = Array.from(el.querySelectorAll<HTMLInputElement>(".pi"));
  // Save before-state for undo
  let beforePos = m.position.clone();
  let beforeRot = m.rotation.clone();
  let beforeScl = m.scaling.clone();

  inputs.forEach((inp) => {
    inp.addEventListener("focus", () => {
      beforePos = m.position.clone();
      beforeRot = m.rotation.clone();
      beforeScl = m.scaling.clone();
    });
    inp.addEventListener("input", () => {
      const [g, a] = inp.dataset.b!.split("_") as [string, "x" | "y" | "z"];
      const v = parseFloat(inp.value) || 0;
      if (g === "pos") m.position[a] = v;
      else if (g === "rot") m.rotation[a] = rad(v);
      else if (g === "scl") m.scaling[a] = v;
    });
    inp.addEventListener("blur", () => {
      const afterPos = m.position.clone();
      const afterRot = m.rotation.clone();
      const afterScl = m.scaling.clone();
      if (beforePos.equals(afterPos) && beforeRot.equals(afterRot) && beforeScl.equals(afterScl)) return;
      const bp = beforePos.clone(), br = beforeRot.clone(), bs = beforeScl.clone();
      const ap = afterPos, ar = afterRot, as_ = afterScl;
      const mesh = m;
      state.history.push({
        label: "Transform",
        undo() { mesh.position.copyFrom(bp); mesh.rotation.copyFrom(br); mesh.scaling.copyFrom(bs); updateTransform(); },
        redo() { mesh.position.copyFrom(ap); mesh.rotation.copyFrom(ar); mesh.scaling.copyFrom(as_); updateTransform(); },
      });
    });
  });

  // Cache inputs for render loop live updates
  _cacheTransformCallback?.(inputs);
}

export function updateModifierUI(): void {
  const el = E("modList");
  const m = lastSelected();
  if (!m) {
    el.innerHTML = '<div class="empty">モディファイアなし</div>';
    return;
  }
  const mods = getModifiers(m);
  if (mods.length === 0) {
    el.innerHTML = '<div class="empty">モディファイアなし</div>';
    return;
  }
  el.innerHTML = "";
  for (const mod of mods) {
    const row = document.createElement("div");
    row.style.cssText = "border:1px solid var(--bg3);border-radius:4px;padding:4px 6px;margin-bottom:4px;font-size:10px;";

    // Header: type + toggle + apply + delete
    const hdr = document.createElement("div");
    hdr.style.cssText = "display:flex;align-items:center;gap:4px;margin-bottom:3px;";
    hdr.innerHTML = `<span style="flex:1;color:${mod.enabled ? "var(--ac)" : "var(--t4)"};font-weight:600;">${modLabel(mod)}</span>`;

    const togBtn = document.createElement("button");
    togBtn.className = "abtn";
    togBtn.style.cssText = "padding:1px 4px;font-size:9px;min-width:0;";
    togBtn.textContent = mod.enabled ? "ON" : "OFF";
    togBtn.addEventListener("click", () => { toggleModifier(m, mod.id); updateModifierUI(); });
    hdr.appendChild(togBtn);

    const appBtn = document.createElement("button");
    appBtn.className = "abtn pri";
    appBtn.style.cssText = "padding:1px 4px;font-size:9px;min-width:0;";
    appBtn.textContent = "Apply";
    appBtn.addEventListener("click", () => { applyModifier(m, mod.id); updateModifierUI(); });
    hdr.appendChild(appBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "abtn dan";
    delBtn.style.cssText = "padding:1px 4px;font-size:9px;min-width:0;";
    delBtn.textContent = "\u2715";
    delBtn.addEventListener("click", () => { removeModifier(m, mod.id); updateModifierUI(); });
    hdr.appendChild(delBtn);

    row.appendChild(hdr);

    // Params
    const params = document.createElement("div");
    params.style.cssText = "display:flex;flex-direction:column;gap:2px;";
    buildModParams(params, m, mod);
    row.appendChild(params);

    el.appendChild(row);
  }
}

function modLabel(mod: Modifier): string {
  switch (mod.type) {
    case "subdivision": return "Subdivision (L" + mod.level + ")";
    case "mirror": return "Mirror (" + mod.axis.toUpperCase() + ")";
    case "array": return "Array (\u00d7" + mod.count + ")";
  }
}

function buildModParams(el: HTMLElement, mesh: import("@babylonjs/core").AbstractMesh, mod: Modifier): void {
  switch (mod.type) {
    case "subdivision":
      el.innerHTML = modSlider("Level", mod.level, 1, 2, 1);
      el.querySelector("input")?.addEventListener("input", function () {
        updateModifierParam(mesh, mod.id, { level: +this.value });
        el.querySelector("span.mv")!.textContent = this.value;
        updateModifierUI();
      });
      break;
    case "mirror": {
      const axes = ["x", "y", "z"] as const;
      el.innerHTML = `<div style="display:flex;gap:3px;">${axes.map((a) =>
        `<button class="abtn${mod.axis === a ? " on" : ""}" data-a="${a}" style="flex:1;padding:1px;font-size:9px;min-width:0;">${a.toUpperCase()}</button>`
      ).join("")}</div>`;
      el.querySelectorAll<HTMLElement>("button").forEach((btn) =>
        btn.addEventListener("click", () => {
          updateModifierParam(mesh, mod.id, { axis: btn.dataset.a });
          updateModifierUI();
        })
      );
      break;
    }
    case "array":
      el.innerHTML = modSlider("Count", mod.count, 2, 10, 1) +
        modSlider("Offset X", mod.offsetX, -5, 5, 0.1) +
        modSlider("Offset Y", mod.offsetY, -5, 5, 0.1) +
        modSlider("Offset Z", mod.offsetZ, -5, 5, 0.1);
      {
        const inputs = el.querySelectorAll<HTMLInputElement>("input");
        const keys = ["count", "offsetX", "offsetY", "offsetZ"] as const;
        inputs.forEach((inp, i) => {
          inp.addEventListener("input", function () {
            updateModifierParam(mesh, mod.id, { [keys[i]!]: +this.value });
            inp.previousElementSibling!.querySelector("span.mv")!.textContent =
              keys[i] === "count" ? this.value : (+this.value).toFixed(1);
          });
        });
      }
      break;
  }
}

function modSlider(label: string, val: number, min: number, max: number, step: number): string {
  const display = step >= 1 ? String(val) : val.toFixed(1);
  return `<div class="sr" style="margin:0;"><label style="font-size:9px;">${label} <span class="mv">${display}</span></label>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${val}"></div>`;
}

function v3h(pf: string, v: { x: number; y: number; z: number }): string {
  const label = pf === "pos" ? "Position" : pf === "rot" ? "Rotation" : "Scale";
  return (["x", "y", "z"] as const)
    .map(
      (a) =>
        `<div class="pr"><span class="pl ${a}">${a.toUpperCase()}</span><input type="number" step="0.1" class="pi" data-b="${pf}_${a}" value="${v[a].toFixed(3)}" aria-label="${label} ${a.toUpperCase()}"></div>`
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
  const albedo = getAlbedoColor(m.material);
  if (!albedo) {
    el.innerHTML = '<div class="empty">No material</div>';
    return;
  }
  const mt = m.material as PBRMaterial;
  const metallic = mt.metallic ?? 0;
  const roughness = mt.roughness ?? 0.5;
  const alpha = mt.alpha != null ? mt.alpha : 1;
  const emissiveHex = mt.emissiveColor?.toHexString() ?? "#000000";
  const emissiveInt = mt.emissiveIntensity ?? 0;
  const ccInt = mt.clearCoat?.intensity ?? 0;
  const ccRough = mt.clearCoat?.roughness ?? 0;
  const sheenInt = mt.sheen?.intensity ?? 0;
  const sheenColor = mt.sheen?.color?.toHexString() ?? "#ffffff";
  const transInt = mt.subSurface?.refractionIntensity ?? 0;
  const ior = mt.subSurface?.indexOfRefraction ?? 1.5;
  const isUnlit = mt.unlit ?? false;

  el.innerHTML = `
    <div class="pg"><div class="pgt">Albedo</div>
      <div class="cgrid">${PALETTE.map((c) => `<div class="csw" style="background:${c}" data-col="${c}"></div>`).join("")}</div>
      <div class="pr" style="margin-top:6px"><span class="pl" style="font-size:10px">Color</span>
        <input type="color" value="${albedo.toHexString()}" id="matColorPicker" aria-label="Albedo color"
          style="flex:1;min-height:26px;border:none;cursor:pointer;background:var(--bg2);border-radius:3px;padding:0;"></div>
    </div>
    <div class="pg"><div class="pgt">PBR</div>
      <div class="sr"><label>Metallic <span id="mtV">${metallic.toFixed(2)}</span></label>
        <input type="range" min="0" max="1" step=".01" value="${metallic}" id="matMetallic" aria-label="Metallic"></div>
      <div class="sr"><label>Roughness <span id="rgV">${roughness.toFixed(2)}</span></label>
        <input type="range" min="0" max="1" step=".01" value="${roughness}" id="matRoughness" aria-label="Roughness"></div>
      <div class="sr"><label>Alpha <span id="alV">${alpha.toFixed(2)}</span></label>
        <input type="range" min="0" max="1" step=".05" value="${alpha}" id="matAlpha" aria-label="Alpha"></div>
    </div>
    <div class="pg"><div class="pgt">Emissive</div>
      <div class="pr"><span class="pl" style="font-size:10px">Color</span>
        <input type="color" value="${emissiveHex}" id="matEmissiveColor" aria-label="Emissive color"
          style="flex:1;min-height:22px;border:none;cursor:pointer;background:var(--bg2);border-radius:3px;padding:0;"></div>
      <div class="sr"><label>Intensity <span id="eiV">${emissiveInt.toFixed(2)}</span></label>
        <input type="range" min="0" max="5" step=".1" value="${emissiveInt}" id="matEmissiveInt" aria-label="Emissive intensity"></div>
    </div>
    <div class="pg"><div class="pgt">Clear Coat</div>
      <div class="sr"><label>Intensity <span id="ccIntV">${ccInt.toFixed(2)}</span></label>
        <input type="range" min="0" max="1" step=".01" value="${ccInt}" id="matCCInt" aria-label="Clear coat intensity"></div>
      <div class="sr"><label>Roughness <span id="ccRoughV">${ccRough.toFixed(2)}</span></label>
        <input type="range" min="0" max="1" step=".01" value="${ccRough}" id="matCCRough" aria-label="Clear coat roughness"></div>
    </div>
    <div class="pg"><div class="pgt">Sheen</div>
      <div class="sr"><label>Intensity <span id="sheenIntV">${sheenInt.toFixed(2)}</span></label>
        <input type="range" min="0" max="1" step=".01" value="${sheenInt}" id="matSheenInt" aria-label="Sheen intensity"></div>
      <div class="pr"><span class="pl" style="font-size:10px">Color</span>
        <input type="color" value="${sheenColor}" id="matSheenColor" aria-label="Sheen color"
          style="flex:1;min-height:22px;border:none;cursor:pointer;background:var(--bg2);border-radius:3px;padding:0;"></div>
    </div>
    <div class="pg"><div class="pgt">Transmission</div>
      <div class="sr"><label>Intensity <span id="transIntV">${transInt.toFixed(2)}</span></label>
        <input type="range" min="0" max="1" step=".01" value="${transInt}" id="matTransInt" aria-label="Transmission intensity"></div>
      <div class="sr"><label>IOR <span id="iorV">${ior.toFixed(2)}</span></label>
        <input type="range" min="1" max="2.5" step=".01" value="${ior}" id="matIOR" aria-label="Index of refraction"></div>
      <div style="font-size:9px;color:var(--t4);padding:2px 0;">Glass 1.5 · Water 1.33 · Diamond 2.42</div>
    </div>
    <div class="pg"><div class="pgt">Textures</div>
      <div id="texSlots"></div>
    </div>
    <div class="pg"><div class="pgt">Display</div>
      <div class="pr"><span class="pl" style="font-size:10px;color:var(--t3)">Wireframe</span>
        <input type="checkbox" ${mt.wireframe ? "checked" : ""} id="matWire" aria-label="Wireframe" style="margin-left:auto"></div>
      <div class="pr"><span class="pl" style="font-size:10px;color:var(--t3)">Unlit</span>
        <input type="checkbox" ${isUnlit ? "checked" : ""} id="matUnlit" aria-label="Unlit" style="margin-left:auto"></div>
    </div>`;

  // Attach events
  el.querySelectorAll<HTMLElement>(".csw").forEach((sw) =>
    sw.addEventListener("click", () => setColor(sw.dataset.col!))
  );
  el.querySelector<HTMLInputElement>("#matColorPicker")?.addEventListener("change", function () {
    setColor(this.value);
  });

  // Undo-tracked material slider helper
  function trackSlider(
    id: string, displayId: string,
    get: (mat: PBRMaterial) => number,
    set: (mat: PBRMaterial, v: number) => void,
  ): void {
    const inp = el.querySelector<HTMLInputElement>("#" + id);
    if (!inp) return;
    let before = 0;
    inp.addEventListener("pointerdown", () => {
      const sel = lastSelected();
      if (sel?.material) before = get(sel.material as PBRMaterial);
    });
    inp.addEventListener("input", function () {
      const sel = lastSelected(); if (!sel?.material) return;
      const v = +this.value;
      if (isNaN(v)) return;
      set(sel.material as PBRMaterial, v);
      E(displayId).textContent = v.toFixed(2);
    });
    inp.addEventListener("change", function () {
      const sel = lastSelected(); if (!sel?.material) return;
      const after = +this.value;
      if (isNaN(after) || before === after) return;
      const mesh = sel, b = before, a = after;
      state.history.push({
        label: "Material",
        undo() { set(mesh.material as PBRMaterial, b); updateMaterial(); },
        redo() { set(mesh.material as PBRMaterial, a); updateMaterial(); },
      });
    });
  }

  trackSlider("matMetallic", "mtV", (m) => m.metallic ?? 0, (m, v) => { m.metallic = v; });
  trackSlider("matRoughness", "rgV", (m) => m.roughness ?? 0.5, (m, v) => { m.roughness = v; });
  trackSlider("matAlpha", "alV", (m) => m.alpha, (m, v) => { m.alpha = v; });
  trackSlider("matEmissiveInt", "eiV", (m) => m.emissiveIntensity ?? 0, (m, v) => { m.emissiveIntensity = v; });
  trackSlider("matCCInt", "ccIntV",
    (m) => m.clearCoat?.intensity ?? 0,
    (m, v) => { m.clearCoat.isEnabled = v > 0; m.clearCoat.intensity = v; });
  trackSlider("matCCRough", "ccRoughV",
    (m) => m.clearCoat?.roughness ?? 0,
    (m, v) => { m.clearCoat.roughness = v; });
  trackSlider("matSheenInt", "sheenIntV",
    (m) => m.sheen?.intensity ?? 0,
    (m, v) => { m.sheen.isEnabled = v > 0; m.sheen.intensity = v; });
  trackSlider("matTransInt", "transIntV",
    (m) => m.subSurface?.refractionIntensity ?? 0,
    (m, v) => { m.subSurface.isRefractionEnabled = v > 0; m.subSurface.refractionIntensity = v; });
  trackSlider("matIOR", "iorV",
    (m) => m.subSurface?.indexOfRefraction ?? 1.5,
    (m, v) => { m.subSurface.indexOfRefraction = v; });

  // Emissive color with undo
  {
    const inp = el.querySelector<HTMLInputElement>("#matEmissiveColor");
    if (inp) {
      let beforeHex = "";
      inp.addEventListener("focus", () => {
        const sel = lastSelected();
        if (sel?.material) beforeHex = (sel.material as PBRMaterial).emissiveColor?.toHexString() ?? "#000000";
      });
      inp.addEventListener("change", function () {
        const sel = lastSelected(); if (!sel?.material) return;
        (sel.material as PBRMaterial).emissiveColor = Color3.FromHexString(this.value);
        const mesh = sel, b = beforeHex, a = this.value;
        state.history.push({
          label: "Emissive Color",
          undo() { (mesh.material as PBRMaterial).emissiveColor = Color3.FromHexString(b); updateMaterial(); },
          redo() { (mesh.material as PBRMaterial).emissiveColor = Color3.FromHexString(a); updateMaterial(); },
        });
      });
    }
  }
  // Sheen color with undo
  {
    const inp = el.querySelector<HTMLInputElement>("#matSheenColor");
    if (inp) {
      let beforeHex = "";
      inp.addEventListener("focus", () => {
        const sel = lastSelected();
        if (sel?.material) beforeHex = (sel.material as PBRMaterial).sheen?.color?.toHexString() ?? "#ffffff";
      });
      inp.addEventListener("change", function () {
        const sel = lastSelected(); if (!sel?.material) return;
        (sel.material as PBRMaterial).sheen.color = Color3.FromHexString(this.value);
        const mesh = sel, b = beforeHex, a = this.value;
        state.history.push({
          label: "Sheen Color",
          undo() { (mesh.material as PBRMaterial).sheen.color = Color3.FromHexString(b); updateMaterial(); },
          redo() { (mesh.material as PBRMaterial).sheen.color = Color3.FromHexString(a); updateMaterial(); },
        });
      });
    }
  }
  // Wireframe with undo
  el.querySelector<HTMLInputElement>("#matWire")?.addEventListener("change", function () {
    const sel = lastSelected(); if (!sel?.material) return;
    const mat = sel.material as PBRMaterial;
    const before = !this.checked; // was opposite before change
    mat.wireframe = this.checked;
    const mesh = sel, b = before, a = this.checked;
    state.history.push({
      label: "Wireframe",
      undo() { (mesh.material as PBRMaterial).wireframe = b; updateMaterial(); },
      redo() { (mesh.material as PBRMaterial).wireframe = a; updateMaterial(); },
    });
  });
  // Unlit with undo
  el.querySelector<HTMLInputElement>("#matUnlit")?.addEventListener("change", function () {
    const sel = lastSelected(); if (!sel?.material) return;
    const mat = sel.material as PBRMaterial;
    const before = !this.checked;
    mat.unlit = this.checked;
    const mesh = sel, b = before, a = this.checked;
    state.history.push({
      label: "Unlit",
      undo() { (mesh.material as PBRMaterial).unlit = b; updateMaterial(); },
      redo() { (mesh.material as PBRMaterial).unlit = a; updateMaterial(); },
    });
  });

  // Texture slots
  const texInfo = getTextureInfo(m);
  const slotsEl = el.querySelector<HTMLElement>("#texSlots")!;
  const SLOT_LABELS: { slot: TextureSlot; label: string }[] = [
    { slot: "albedo", label: "Albedo" },
    { slot: "normal", label: "Normal" },
    { slot: "metallic", label: "Metal/Rough" },
    { slot: "ao", label: "AO" },
    { slot: "emissive", label: "Emissive" },
  ];
  for (const { slot, label } of SLOT_LABELS) {
    const info = texInfo[slot];
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:4px;font-size:10px;padding:2px 0;";
    row.innerHTML = `<span style="min-width:60px;color:var(--t3)">${label}</span>
      <span style="flex:1;color:var(--t4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${info ? info.name : "\u2014"}</span>`;
    const impBtn = document.createElement("button");
    impBtn.className = "abtn";
    impBtn.style.cssText = "padding:1px 5px;font-size:9px;min-width:0;";
    impBtn.textContent = "+";
    impBtn.title = "Import " + label;
    impBtn.addEventListener("click", () => {
      importTextureForSlot(m, slot);
    });
    row.appendChild(impBtn);
    if (info) {
      const clrBtn = document.createElement("button");
      clrBtn.className = "abtn dan";
      clrBtn.style.cssText = "padding:1px 5px;font-size:9px;min-width:0;";
      clrBtn.textContent = "\u2715";
      clrBtn.title = "Clear " + label;
      clrBtn.addEventListener("click", () => {
        clearTextureSlot(m, slot);
        updateMaterial();
      });
      row.appendChild(clrBtn);
    }
    slotsEl.appendChild(row);
  }
}

function setColor(hex: string): void {
  if (!state.selectedMeshes.length) return;
  // Apply to all selected meshes
  const targets = state.selectedMeshes.filter(m => m.material && "albedoColor" in m.material);
  if (!targets.length) return;
  const prevColors = targets.map(m => ({
    mesh: m,
    hex: (m.material as PBRMaterial).albedoColor?.toHexString() ?? "#ffffff",
  }));
  const color = Color3.FromHexString(hex);
  for (const m of targets) (m.material as PBRMaterial).albedoColor = color.clone();
  updateHierarchy();

  const newHex = hex;
  state.history.push({
    label: "Color",
    undo() { for (const p of prevColors) (p.mesh.material as PBRMaterial).albedoColor = Color3.FromHexString(p.hex); updateHierarchy(); },
    redo() { const c = Color3.FromHexString(newHex); for (const p of prevColors) (p.mesh.material as PBRMaterial).albedoColor = c.clone(); updateHierarchy(); },
  });
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
    div.innerHTML = `<span style="color:var(--ac);font-size:10px;">●</span><span>${escapeHtml(bd.name)}</span>`;
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
      <div><span style="color:var(--t4)">Name:</span> ${escapeHtml(bd.name)}</div>
      <div><span style="color:var(--t4)">Parent:</span> ${escapeHtml(parentName)}</div>
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
  // Sync easing dropdown to current keyframe
  const easingSel = document.getElementById("kfEasing") as HTMLSelectElement | null;
  if (easingSel) easingSel.value = getKeyframeEasing();
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
    const idx = parseInt(select.value, 10);
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
      void placeModel(meta.id, meta.name)
        .then(() => updateMapInstances())
        .catch(() => status("\u26a0 \u914d\u7f6e\u306b\u5931\u6557"))
        .finally(() => { placeBtn.disabled = false; });
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
      }).catch(() => {
        status("\u26a0 \u524a\u9664\u306b\u5931\u6557");
      }).finally(() => { delBtn.disabled = false; });
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

// ── Layer UI ──

export function updateLayerUI(): void {
  const el = E("layerList");
  el.innerHTML = "";
  for (const layer of state.layers) {
    const count = getMeshesOnLayer(layer.id).length;
    const isActive = layer.id === state.activeLayerId;
    const row = document.createElement("div");
    row.className = "sitem" + (isActive ? " sel" : "");
    row.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;";

    // Visibility toggle
    const eyeBtn = document.createElement("button");
    eyeBtn.style.cssText = "background:none;border:none;color:var(--t3);cursor:pointer;font-size:11px;padding:0 2px;";
    eyeBtn.textContent = layer.visible ? "\u{1F441}" : "\u25CB";
    eyeBtn.title = layer.visible ? "Hide" : "Show";
    eyeBtn.setAttribute("aria-label", (layer.visible ? "Hide" : "Show") + " layer " + layer.name);
    eyeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLayerVisibility(layer.id);
      updateLayerUI();
    });
    row.appendChild(eyeBtn);

    // Name + count
    const nameSpan = document.createElement("span");
    nameSpan.style.cssText = "flex:1;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    nameSpan.textContent = layer.name;
    row.appendChild(nameSpan);

    const countSpan = document.createElement("span");
    countSpan.style.cssText = "font-size:9px;color:var(--t4);min-width:18px;text-align:right;";
    countSpan.textContent = String(count);
    row.appendChild(countSpan);

    // Delete button (only if more than 1 layer)
    if (state.layers.length > 1) {
      const delBtn = document.createElement("button");
      delBtn.className = "dl";
      delBtn.textContent = "\u2715";
      delBtn.style.cssText = "font-size:9px;";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteLayer(layer.id);
        updateLayerUI();
      });
      row.appendChild(delBtn);
    }

    // Click to set active
    row.addEventListener("click", () => {
      setActiveLayer(layer.id);
      updateLayerUI();
    });

    el.appendChild(row);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ── Light UI ──
export function updateLightUI(): void {
  const el = E("lightList");
  if (state.lightMap.size === 0) {
    el.innerHTML = '<div class="empty">ライトなし</div>';
    return;
  }
  el.innerHTML = "";
  for (const [id, data] of state.lightMap) {
    const isSel = state.selectedLightId === id;
    const row = document.createElement("div");
    row.className = "sitem" + (isSel ? " sel" : "");
    row.innerHTML = `<div class="cd" style="background:${data.color};border-radius:50%;"></div>
      <span style="font-size:10px;">${data.type === "point" ? "Point" : "Spot"} ${id.split("_")[1]}</span>
      <button class="dl" style="margin-left:auto;">✕</button>`;
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("dl")) return;
      selectLight(id);
      updateLightUI();
    });
    row.querySelector(".dl")!.addEventListener("click", (e) => {
      e.stopPropagation();
      removeLight(id);
      updateLightUI();
    });
    el.appendChild(row);

    // Show properties for selected light
    if (isSel) {
      const props = document.createElement("div");
      props.style.cssText = "padding:6px 8px;background:var(--bg2);border-radius:3px;margin-top:4px;";
      props.innerHTML = `
        <div class="pr" style="margin-bottom:4px;"><span class="pl" style="font-size:9px;">Color</span>
          <input type="color" value="${data.color}" data-lid="${id}" data-lk="color"
            style="flex:1;min-height:22px;border:none;cursor:pointer;background:var(--bg3);border-radius:3px;padding:0;"></div>
        <div class="pr" style="margin-bottom:4px;"><span class="pl" style="font-size:9px;">Intensity</span>
          <input type="range" min="0" max="5" step="0.1" value="${data.intensity}" data-lid="${id}" data-lk="intensity"
            style="flex:1;"></div>
        <div class="pr" style="margin-bottom:4px;"><span class="pl" style="font-size:9px;">Range</span>
          <input type="range" min="1" max="50" step="1" value="${data.range}" data-lid="${id}" data-lk="range"
            style="flex:1;"></div>
        ${data.type === "spot" ? `<div class="pr" style="margin-bottom:4px;"><span class="pl" style="font-size:9px;">Angle</span>
          <input type="range" min="10" max="120" step="1" value="${data.angle ?? 45}" data-lid="${id}" data-lk="angle"
            style="flex:1;"></div>` : ""}
        <div class="pr" style="margin-bottom:2px;"><span class="pl x" style="font-size:9px;">X</span>
          <input type="number" step="0.5" value="${data.light.position.x.toFixed(2)}" data-lid="${id}" data-lk="posX"
            style="flex:1;background:var(--bg3);color:var(--t1);border:1px solid var(--bd);border-radius:3px;padding:2px 4px;font-size:9px;"></div>
        <div class="pr" style="margin-bottom:2px;"><span class="pl y" style="font-size:9px;">Y</span>
          <input type="number" step="0.5" value="${data.light.position.y.toFixed(2)}" data-lid="${id}" data-lk="posY"
            style="flex:1;background:var(--bg3);color:var(--t1);border:1px solid var(--bd);border-radius:3px;padding:2px 4px;font-size:9px;"></div>
        <div class="pr"><span class="pl z" style="font-size:9px;">Z</span>
          <input type="number" step="0.5" value="${data.light.position.z.toFixed(2)}" data-lid="${id}" data-lk="posZ"
            style="flex:1;background:var(--bg3);color:var(--t1);border:1px solid var(--bd);border-radius:3px;padding:2px 4px;font-size:9px;"></div>`;

      // Bind all inputs
      props.querySelectorAll<HTMLInputElement>("input").forEach((inp) => {
        inp.addEventListener("input", () => {
          const lid = inp.dataset.lid!;
          const lk = inp.dataset.lk!;
          const v = inp.type === "color" ? inp.value : +inp.value;
          updateLightParam(lid, lk, v);
        });
      });
      el.appendChild(props);
    }
  }
}
