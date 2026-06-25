import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { escapeHtml } from "./escape";
import {
  makePresetGraph,
  type ProcPresetKind,
  type PresetParams,
} from "../materials/procedural-graph";
import {
  applyProceduralGraph,
  bakeProceduralToMesh,
  clearProceduralGraph,
  getProceduralPreset,
} from "../materials/procedural-material";

/**
 * Procedural-material UI section for the Material tab. MVP: pick a preset
 * (Noise / Checker / Gradient), tweak its parameters live, and bake the result
 * to the mesh's PBR albedo (which then exports in glTF). The full node-graph
 * canvas editor is a later iteration — the preset graphs are real
 * {@link ProceduralGraph}s, so that work can drive the same core.
 */

interface PresetState {
  kind: ProcPresetKind;
  params: Required<
    Pick<
      PresetParams,
      "scale" | "contrast" | "seed" | "colorA" | "colorB" | "axis" | "roughness" | "normal" | "normalStrength"
    >
  >;
}

const DEFAULT_STATE: PresetState = {
  kind: "noise",
  params: {
    scale: 8,
    contrast: 1.5,
    seed: 0,
    colorA: "#202020",
    colorB: "#d8d8d8",
    axis: 0,
    roughness: false,
    normal: false,
    normalStrength: 1,
  },
};

function readState(mesh: AbstractMesh): PresetState {
  const stored = getProceduralPreset(mesh) as PresetState | null;
  if (stored && stored.kind && stored.params) {
    return { kind: stored.kind, params: { ...DEFAULT_STATE.params, ...stored.params } };
  }
  return { kind: DEFAULT_STATE.kind, params: { ...DEFAULT_STATE.params } };
}

const PRESETS: { kind: ProcPresetKind; label: string }[] = [
  { kind: "noise", label: "Noise" },
  { kind: "voronoi", label: "Voronoi" },
  { kind: "brick", label: "Brick" },
  { kind: "checker", label: "Checker" },
  { kind: "gradient", label: "Gradient" },
];

/** Presets whose float pattern feeds the colour ramp via a Contrast control. */
const HAS_CONTRAST = new Set<ProcPresetKind>(["noise", "voronoi", "brick"]);

/** Build + wire the procedural controls into `container` for `mesh`. */
export function renderProceduralControls(container: HTMLElement, mesh: AbstractMesh): void {
  const st = readState(mesh);
  const hasProc = getProceduralPreset(mesh) != null;

  const presetBtns = PRESETS.map(
    (p) =>
      `<button class="abtn${p.kind === st.kind ? " on" : ""}" data-preset="${p.kind}" style="flex:1;font-size:10px;min-width:0">${p.label}</button>`
  ).join("");

  container.innerHTML = `
    <div class="pgt">Procedural</div>
    <div style="display:flex;gap:4px;margin-bottom:6px">${presetBtns}</div>
    <div class="sr"><label>Scale <span id="procScaleV">${st.params.scale.toFixed(1)}</span></label>
      <input type="range" min="1" max="48" step="1" value="${st.params.scale}" id="procScale" aria-label="Procedural scale"></div>
    <div class="sr" id="procContrastRow"><label>Contrast <span id="procContrastV">${st.params.contrast.toFixed(2)}</span></label>
      <input type="range" min="0.5" max="6" step="0.1" value="${st.params.contrast}" id="procContrast" aria-label="Procedural contrast"></div>
    <div class="pr"><span class="pl" style="font-size:10px">Color A</span>
      <input type="color" value="${escapeHtml(st.params.colorA)}" id="procColorA" aria-label="Procedural color A" style="margin-left:auto"></div>
    <div class="pr"><span class="pl" style="font-size:10px">Color B</span>
      <input type="color" value="${escapeHtml(st.params.colorB)}" id="procColorB" aria-label="Procedural color B" style="margin-left:auto"></div>
    <div class="pr" id="procAxisRow"><span class="pl" style="font-size:10px">Vertical</span>
      <input type="checkbox" ${st.params.axis === 1 ? "checked" : ""} id="procAxis" aria-label="Gradient vertical" style="margin-left:auto"></div>
    <div class="pr" title="Drive PBR roughness from the same pattern (bakes a metallic-roughness map that exports in glTF)"><span class="pl" style="font-size:10px">Roughness from pattern</span>
      <input type="checkbox" ${st.params.roughness ? "checked" : ""} id="procRough" aria-label="Roughness from pattern" style="margin-left:auto"></div>
    <div class="pr" title="Bake a tangent-space normal map from the pattern as a height field (PBR bump; exports in glTF)"><span class="pl" style="font-size:10px">Bump from pattern</span>
      <input type="checkbox" ${st.params.normal ? "checked" : ""} id="procNormal" aria-label="Bump from pattern" style="margin-left:auto"></div>
    <div class="sr" id="procNormalRow"><label>Bump Strength <span id="procNormalStrV">${st.params.normalStrength.toFixed(1)}</span></label>
      <input type="range" min="0.2" max="6" step="0.1" value="${st.params.normalStrength}" id="procNormalStr" aria-label="Bump strength"></div>
    <button class="abtn pri" id="procApply" style="margin-top:6px">⚡ Bake to Albedo</button>
    <button class="abtn" id="procEdit" title="Open the visual node graph editor for full control">🕸 Edit Node Graph</button>
    <button class="abtn${hasProc ? "" : " "}" id="procClear" ${hasProc ? "" : "disabled"}>Clear Procedural</button>
    <div style="font-size:9px;color:var(--t4);margin-top:4px;line-height:1.5">プリセットを焼いて albedo に適用（glTF にそのまま乗る）。Edit Node Graph で任意グラフを編集</div>`;

  const q = <T extends HTMLElement>(sel: string): T => container.querySelector<T>(sel)!;

  // Contrast only applies to Noise; axis only to Gradient — toggle visibility.
  const syncRows = (): void => {
    q("#procContrastRow").style.display = HAS_CONTRAST.has(st.kind) ? "" : "none";
    q("#procAxisRow").style.display = st.kind === "gradient" ? "" : "none";
    q("#procNormalRow").style.display = st.params.normal ? "" : "none";
  };
  syncRows();

  const graphOf = (): ReturnType<typeof makePresetGraph> => makePresetGraph(st.kind, st.params);

  // Live preview rebake (no undo) for parameter scrubbing.
  const livePreview = (): void => {
    if (getProceduralPreset(mesh) == null) return; // only live-update an applied material
    bakeProceduralToMesh(mesh, graphOf(), { ...st });
  };

  for (const btn of container.querySelectorAll<HTMLElement>("[data-preset]")) {
    btn.addEventListener("click", () => {
      st.kind = btn.dataset.preset as ProcPresetKind;
      for (const b of container.querySelectorAll<HTMLElement>("[data-preset]")) b.classList.remove("on");
      btn.classList.add("on");
      syncRows();
      livePreview();
    });
  }

  const bindRange = (id: string, vId: string, key: "scale" | "contrast", digits: number): void => {
    const inp = q<HTMLInputElement>(id);
    inp.addEventListener("input", () => {
      const v = +inp.value;
      if (Number.isNaN(v)) return;
      st.params[key] = v;
      q(vId).textContent = v.toFixed(digits);
      livePreview();
    });
  };
  bindRange("#procScale", "#procScaleV", "scale", 1);
  bindRange("#procContrast", "#procContrastV", "contrast", 2);

  q<HTMLInputElement>("#procColorA").addEventListener("input", function () {
    st.params.colorA = this.value;
    livePreview();
  });
  q<HTMLInputElement>("#procColorB").addEventListener("input", function () {
    st.params.colorB = this.value;
    livePreview();
  });
  q<HTMLInputElement>("#procAxis").addEventListener("change", function () {
    st.params.axis = this.checked ? 1 : 0;
    livePreview();
  });
  q<HTMLInputElement>("#procRough").addEventListener("change", function () {
    st.params.roughness = this.checked;
    livePreview();
  });
  q<HTMLInputElement>("#procNormal").addEventListener("change", function () {
    st.params.normal = this.checked;
    syncRows();
    livePreview();
  });
  q<HTMLInputElement>("#procNormalStr").addEventListener("input", function () {
    const v = +this.value;
    if (Number.isNaN(v)) return;
    st.params.normalStrength = v;
    q("#procNormalStrV").textContent = v.toFixed(1);
    livePreview();
  });

  q("#procApply").addEventListener("click", () => {
    applyProceduralGraph(mesh, graphOf(), { ...st });
    // Re-render so the Clear button enables.
    renderProceduralControls(container, mesh);
  });
  q("#procEdit").addEventListener("click", () => {
    void import("./node-editor").then((mod) => mod.openNodeEditor(mesh));
  });
  q("#procClear").addEventListener("click", () => {
    clearProceduralGraph(mesh);
    renderProceduralControls(container, mesh);
  });
}
