/**
 * Controls for the `surface` group's tabs: Material, Morph, Scene, Map
 * (ADR-014). Ported from the old screen's static markup + `src/ui/panels.ts`
 * (`updateMaterial`, the map/light panels) and `src/tools/morph.ts`
 * (`updateMorphUI`) — those built DOM by id; here each section reads
 * `state` through `useForge` and calls the same `src/tools/**` /
 * `src/viewport/**` functions the old bindings did, so behaviour (undo
 * entries, status messages) matches.
 *
 * Section id → old screen mapping (`TAB_SECTIONS` in `guide.ts`):
 *  - mat: alb (Albedo), pbr (Metallic/Roughness/Alpha), emi (Emissive —
 *    also carries Clear Coat / Sheen / Transmission, which have no section
 *    of their own; they sat directly below Emissive in the old DOM), tex
 *    (Textures — also carries AO/Normal bake, the procedural-material
 *    panel, and Display Wireframe/Unlit, none of which have a section
 *    either; they sat directly below Textures in the old DOM).
 *  - morph: mt (Morph Targets, including shape-key drivers).
 *  - scene: li (Lights), env (Environment, including the Reference-image
 *    import button), shd (Shadows).
 *  - map: lib (Model Library), inst (Scene Instances), lay (Layout).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { state, status, type AnimChannel } from "../../state";
import { store } from "../../store";
import { useForge } from "../use-forge";

import { getAlbedoColor } from "../../materials/pbr-helpers";
import { PALETTE } from "../../tools/primitives";
import {
  getTextureInfo,
  importTextureForSlot,
  clearTextureSlot,
  type TextureSlot,
} from "../../tools/texture-import";
import {
  getProceduralPreset,
  applyProceduralGraph,
  bakeProceduralToMesh,
  clearProceduralGraph,
} from "../../materials/procedural-material";
import { makePresetGraph, type ProcPresetKind, type PresetParams } from "../../materials/procedural-graph";

import { addMorph, captureMorph, deleteMorphTarget, setMorphInfluence } from "../../tools/morph";
import { findDriver, type MorphDriver } from "../../tools/morph-driver";
import { getActiveSkeleton } from "../../tools/skeleton-tool";

import { addLight, removeLight, selectLight, updateLightParam } from "../../tools/lighting";
import type { LightData } from "../../state";
import {
  ENV_PRESETS,
  setEnvironmentPreset,
  loadCustomHDRI,
  setEnvironmentIntensity,
  toggleSkybox,
} from "../../viewport/environment";
import { importReferenceImage } from "../../tools/reference-image";
import { setShadowEnabled, setShadowQuality } from "../../viewport/shadows";

import {
  loadModelLibrary,
  deleteFromLibrary,
  placeModel,
  removeMapInstance,
  exportSceneLayout,
  importSceneLayout,
  clearAllMapInstances,
} from "../../tools/map-editor";
import type { ModelMetadata } from "../../storage/metadata-store";
import { selectMesh } from "../../tools/selection";

// ───────────────────────── shared helpers ─────────────────────────

function useSelectedMesh(): AbstractMesh | null {
  return useForge((s) => s.selectedMeshes[s.selectedMeshes.length - 1] ?? null);
}

/**
 * Render `children` only when a mesh is selected and has an
 * albedo-carrying material, otherwise the old screen's two-tier empty
 * message ("メッシュを選択" / "No material" — `updateMaterial` in
 * `src/ui/panels.ts`).
 */
function WithMaterial({ children }: { children: (mesh: AbstractMesh, mat: PBRMaterial) => ReactNode }) {
  const mesh = useSelectedMesh();
  if (!mesh) return <div className="empty">メッシュを選択</div>;
  if (!getAlbedoColor(mesh.material)) return <div className="empty">No material</div>;
  return <>{children(mesh, mesh.material as PBRMaterial)}</>;
}

/**
 * One undo-tracked material slider. Ported from `trackSlider` in
 * `src/ui/panels.ts` (`updateMaterial`): drag updates the value live,
 * releasing records one undo step comparing before/after.
 */
function MatSlider({
  mesh,
  text,
  min,
  max,
  step,
  get,
  set,
}: {
  mesh: AbstractMesh;
  text: string;
  min: number;
  max: number;
  step: number;
  get: (m: PBRMaterial) => number;
  set: (m: PBRMaterial, v: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const mat = mesh.material as PBRMaterial;
  const value = draft ?? get(mat);
  return (
    <div className="sr">
      <label>
        {text} <span>{value.toFixed(2)}</span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={text}
        onPointerDown={() => setBefore(get(mesh.material as PBRMaterial))}
        onChange={(e) => {
          const v = +e.target.value;
          if (Number.isNaN(v)) return;
          set(mesh.material as PBRMaterial, v);
          setDraft(v);
        }}
        onPointerUp={() => {
          setDraft(null);
          const b = before;
          setBefore(null);
          if (b === null) return;
          const after = get(mesh.material as PBRMaterial);
          if (b === after) return;
          state.history.push({
            label: "Material",
            undo() {
              set(mesh.material as PBRMaterial, b);
            },
            redo() {
              set(mesh.material as PBRMaterial, after);
            },
          });
        }}
      />
    </div>
  );
}

/**
 * One undo-tracked material colour field. Ported from the "Emissive
 * color" / "Sheen color" blocks in `updateMaterial`: focus captures the
 * before value, change (picker closed) commits and pushes one undo step.
 */
function MatColor({
  mesh,
  text,
  label,
  get,
  set,
}: {
  mesh: AbstractMesh;
  text: string;
  label: string;
  get: (m: PBRMaterial) => string;
  set: (m: PBRMaterial, v: string) => void;
}) {
  const [before, setBefore] = useState<string | null>(null);
  const mat = mesh.material as PBRMaterial;
  return (
    <div className="pr">
      <span className="pl" style={{ fontSize: 10 }}>
        {text}
      </span>
      <input
        type="color"
        value={get(mat)}
        aria-label={label}
        style={{ marginLeft: "auto" }}
        onFocus={() => setBefore(get(mesh.material as PBRMaterial))}
        onChange={(e) => {
          const v = e.target.value;
          const b = before;
          set(mesh.material as PBRMaterial, v);
          setBefore(null);
          if (b === null || b === v) return;
          state.history.push({
            label: text,
            undo() {
              set(mesh.material as PBRMaterial, b);
            },
            redo() {
              set(mesh.material as PBRMaterial, v);
            },
          });
        }}
      />
    </div>
  );
}

// ───────────────────────── Material: Albedo ─────────────────────────

/**
 * Set albedo on every selected mesh with an `albedoColor` material, one
 * undo entry for all of them. Copied from the non-exported `setColor` in
 * `src/ui/panels.ts` (`updateMaterial`) — the outliner colour-dot refresh
 * it did (`updateHierarchy()`) has no equivalent here since `LeftPanel`
 * does not draw one.
 */
function setAlbedoColor(hex: string): void {
  if (!state.selectedMeshes.length) return;
  const targets = state.selectedMeshes.filter((m) => m.material && "albedoColor" in m.material);
  if (!targets.length) return;
  const prevColors = targets.map((m) => ({
    mesh: m,
    hex: (m.material as PBRMaterial).albedoColor?.toHexString() ?? "#ffffff",
  }));
  const color = Color3.FromHexString(hex);
  for (const m of targets) (m.material as PBRMaterial).albedoColor = color.clone();
  const newHex = hex;
  state.history.push({
    label: "Color",
    undo() {
      for (const p of prevColors) (p.mesh.material as PBRMaterial).albedoColor = Color3.FromHexString(p.hex);
    },
    redo() {
      const c = Color3.FromHexString(newHex);
      for (const p of prevColors) (p.mesh.material as PBRMaterial).albedoColor = c.clone();
    },
  });
}

function AlbedoSection() {
  return (
    <WithMaterial>
      {(_mesh, mat) => (
        <>
          <div className="cgrid">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className="csw"
                style={{ background: c }}
                aria-label={"Albedo " + c}
                onClick={() => setAlbedoColor(c)}
              />
            ))}
          </div>
          <div className="pr" style={{ marginTop: 6 }}>
            <span className="pl" style={{ fontSize: 10 }}>
              Color
            </span>
            <input
              type="color"
              value={mat.albedoColor?.toHexString() ?? "#ffffff"}
              aria-label="Albedo color"
              style={{ flex: 1, minHeight: 26, border: "none", cursor: "pointer" }}
              onChange={(e) => setAlbedoColor(e.target.value)}
            />
          </div>
        </>
      )}
    </WithMaterial>
  );
}

// ───────────────────────── Material: PBR ─────────────────────────

function PbrSection() {
  return (
    <WithMaterial>
      {(mesh) => (
        <>
          <MatSlider mesh={mesh} text="Metallic" min={0} max={1} step={0.01} get={(m) => m.metallic ?? 0} set={(m, v) => (m.metallic = v)} />
          <MatSlider mesh={mesh} text="Roughness" min={0} max={1} step={0.01} get={(m) => m.roughness ?? 0.5} set={(m, v) => (m.roughness = v)} />
          <MatSlider mesh={mesh} text="Alpha" min={0} max={1} step={0.05} get={(m) => m.alpha} set={(m, v) => (m.alpha = v)} />
        </>
      )}
    </WithMaterial>
  );
}

// ─────────── Material: Emissive (+ Clear Coat / Sheen / Transmission) ───────────

function EmissiveSection() {
  return (
    <WithMaterial>
      {(mesh) => (
        <>
          <MatColor
            mesh={mesh}
            text="Color"
            label="Emissive color"
            get={(m) => m.emissiveColor?.toHexString() ?? "#000000"}
            set={(m, v) => (m.emissiveColor = Color3.FromHexString(v))}
          />
          <MatSlider mesh={mesh} text="Intensity" min={0} max={5} step={0.1} get={(m) => m.emissiveIntensity ?? 0} set={(m, v) => (m.emissiveIntensity = v)} />

          <div className="pgt" style={{ marginTop: 10 }}>
            Clear Coat
          </div>
          <MatSlider
            mesh={mesh}
            text="Intensity"
            min={0}
            max={1}
            step={0.01}
            get={(m) => m.clearCoat?.intensity ?? 0}
            set={(m, v) => {
              m.clearCoat.isEnabled = v > 0;
              m.clearCoat.intensity = v;
            }}
          />
          <MatSlider mesh={mesh} text="Roughness" min={0} max={1} step={0.01} get={(m) => m.clearCoat?.roughness ?? 0} set={(m, v) => (m.clearCoat.roughness = v)} />

          <div className="pgt" style={{ marginTop: 10 }}>
            Sheen
          </div>
          <MatSlider
            mesh={mesh}
            text="Intensity"
            min={0}
            max={1}
            step={0.01}
            get={(m) => m.sheen?.intensity ?? 0}
            set={(m, v) => {
              m.sheen.isEnabled = v > 0;
              m.sheen.intensity = v;
            }}
          />
          <MatColor mesh={mesh} text="Color" label="Sheen color" get={(m) => m.sheen?.color?.toHexString() ?? "#ffffff"} set={(m, v) => (m.sheen.color = Color3.FromHexString(v))} />

          <div className="pgt" style={{ marginTop: 10 }}>
            Transmission
          </div>
          <MatSlider
            mesh={mesh}
            text="Intensity"
            min={0}
            max={1}
            step={0.01}
            get={(m) => m.subSurface?.refractionIntensity ?? 0}
            set={(m, v) => {
              m.subSurface.isRefractionEnabled = v > 0;
              m.subSurface.refractionIntensity = v;
            }}
          />
          <MatSlider mesh={mesh} text="IOR" min={1} max={2.5} step={0.01} get={(m) => m.subSurface?.indexOfRefraction ?? 1.5} set={(m, v) => (m.subSurface.indexOfRefraction = v)} />
          <div style={{ fontSize: 9, color: "var(--t4)", padding: "2px 0" }}>Glass 1.5 · Water 1.33 · Diamond 2.42</div>
        </>
      )}
    </WithMaterial>
  );
}

// ─────── Material: Textures (+ AO/Normal bake, Procedural, Display) ───────

const TEX_SLOTS: { slot: TextureSlot; label: string }[] = [
  { slot: "albedo", label: "Albedo" },
  { slot: "normal", label: "Normal" },
  { slot: "metallic", label: "Metal/Rough" },
  { slot: "ao", label: "AO" },
  { slot: "emissive", label: "Emissive" },
];

function TextureSlotRow({ mesh, slot, label }: { mesh: AbstractMesh; slot: TextureSlot; label: string }) {
  const info = getTextureInfo(mesh)[slot];
  return (
    <div className="pr" style={{ fontSize: 10 }}>
      <span style={{ minWidth: 60, color: "var(--t3)" }}>{label}</span>
      <span style={{ flex: 1, color: "var(--t4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info ? info.name : "—"}</span>
      <button
        type="button"
        className="abtn"
        style={{ padding: "1px 5px", fontSize: 9, minWidth: 0 }}
        title={"Import " + label}
        aria-label={"Import " + label + " texture"}
        onClick={() => importTextureForSlot(mesh, slot)}
      >
        +
      </button>
      {info && (
        <button
          type="button"
          className="abtn dan"
          style={{ padding: "1px 5px", fontSize: 9, minWidth: 0 }}
          title={"Clear " + label}
          aria-label={"Clear " + label + " texture"}
          onClick={() => clearTextureSlot(mesh, slot)}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function AOBakeRow({ mesh }: { mesh: AbstractMesh }) {
  const [res, setRes] = useState<256 | 512>(256);
  return (
    <div className="pr" style={{ fontSize: 10, borderTop: "1px solid var(--bd)", marginTop: 3, paddingTop: 3 }}>
      <span style={{ minWidth: 60, color: "var(--t3)" }}>AO Bake</span>
      <select aria-label="AO bake resolution" value={res} style={{ fontSize: 9, flex: 1, minWidth: 0 }} onChange={(e) => setRes(+e.target.value as 256 | 512)}>
        <option value={256}>256px</option>
        <option value={512}>512px</option>
      </select>
      <button
        type="button"
        className="abtn"
        style={{ padding: "1px 7px", fontSize: 9, minWidth: 0 }}
        title="ジオメトリのセルフオクルージョンを AO テクスチャにベイク (UV 必須、GLB では occlusionTexture として出力)"
        onClick={() => {
          void import("../../tools/bake-apply").then((mod) => mod.bakeAOToMesh(mesh, res));
        }}
      >
        🔥 Bake
      </button>
    </div>
  );
}

function NormalBakeRow({ mesh }: { mesh: AbstractMesh }) {
  const others = useForge((s) => s.allMeshes.filter((o) => o !== mesh && !o.name.startsWith("refimg_")));
  const [srcId, setSrcId] = useState("");
  const first = others[0];
  const src = others.find((o) => String(o.uniqueId) === srcId) ?? first ?? null;
  return (
    <div className="pr" style={{ fontSize: 10 }}>
      <span style={{ minWidth: 60, color: "var(--t3)" }}>Nrm Bake</span>
      {others.length === 0 ? (
        <select disabled aria-label="Normal bake source mesh" style={{ fontSize: 9, flex: 1, minWidth: 0 }}>
          <option>{"— ハイポリなし —"}</option>
        </select>
      ) : (
        <select aria-label="Normal bake source mesh" value={src ? String(src.uniqueId) : ""} style={{ fontSize: 9, flex: 1, minWidth: 0 }} onChange={(e) => setSrcId(e.target.value)}>
          {others.map((o) => (
            <option key={o.uniqueId} value={o.uniqueId}>
              {o.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="abtn"
        disabled={others.length === 0}
        style={{ padding: "1px 7px", fontSize: 9, minWidth: 0 }}
        title="選択メッシュ (ハイポリ) の法線をこのメッシュのノーマルマップにベイク (UV 必須、GLB では normalTexture として出力)"
        onClick={() => {
          if (!src) return;
          void import("../../tools/bake-apply").then((mod) => mod.bakeNormalToLowMesh(mesh, src, 512));
        }}
      >
        🔥 Bake
      </button>
    </div>
  );
}

type PresetState = {
  kind: ProcPresetKind;
  params: Required<Pick<PresetParams, "scale" | "contrast" | "seed" | "colorA" | "colorB" | "axis" | "roughness" | "normal" | "normalStrength">>;
};

const DEFAULT_PROC_STATE: PresetState = {
  kind: "noise",
  params: { scale: 8, contrast: 1.5, seed: 0, colorA: "#202020", colorB: "#d8d8d8", axis: 0, roughness: false, normal: false, normalStrength: 1 },
};

const PROC_PRESETS: { kind: ProcPresetKind; label: string }[] = [
  { kind: "noise", label: "Noise" },
  { kind: "voronoi", label: "Voronoi" },
  { kind: "brick", label: "Brick" },
  { kind: "checker", label: "Checker" },
  { kind: "gradient", label: "Gradient" },
];

/** Presets whose float pattern feeds the colour ramp via a Contrast control. */
const PROC_HAS_CONTRAST = new Set<ProcPresetKind>(["noise", "voronoi", "brick"]);

function readProcState(mesh: AbstractMesh): PresetState {
  const stored = getProceduralPreset(mesh) as PresetState | null;
  if (stored?.kind && stored.params) return { kind: stored.kind, params: { ...DEFAULT_PROC_STATE.params, ...stored.params } };
  return { kind: DEFAULT_PROC_STATE.kind, params: { ...DEFAULT_PROC_STATE.params } };
}

/**
 * Preset picker + live-preview bake, ported from `renderProceduralControls`
 * in `src/ui/procedural-panel.ts`. "Edit Node Graph" still opens that
 * module's canvas editor (out of scope here — same dynamic import as the
 * old screen used).
 */
function ProceduralSection({ mesh }: { mesh: AbstractMesh }) {
  const [st, setSt] = useState<PresetState>(() => readProcState(mesh));
  const hasProc = getProceduralPreset(mesh) != null;

  const update = (next: PresetState): void => {
    setSt(next);
    if (getProceduralPreset(mesh) != null) {
      bakeProceduralToMesh(mesh, makePresetGraph(next.kind, next.params), { ...next });
    }
  };

  return (
    <>
      <div className="pgt" style={{ marginTop: 10 }}>
        Procedural
      </div>
      <div className="choice-row" role="group" style={{ marginBottom: 6 }}>
        {PROC_PRESETS.map((p) => (
          <button
            key={p.kind}
            type="button"
            className={"abtn" + (p.kind === st.kind ? " bon on" : "")}
            aria-pressed={p.kind === st.kind}
            onClick={() => update({ ...st, kind: p.kind })}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="sr">
        <label>
          Scale <span>{st.params.scale.toFixed(1)}</span>
        </label>
        <input
          type="range"
          min={1}
          max={48}
          step={1}
          value={st.params.scale}
          aria-label="Procedural scale"
          onChange={(e) => update({ ...st, params: { ...st.params, scale: +e.target.value } })}
        />
      </div>
      {PROC_HAS_CONTRAST.has(st.kind) && (
        <div className="sr">
          <label>
            Contrast <span>{st.params.contrast.toFixed(2)}</span>
          </label>
          <input
            type="range"
            min={0.5}
            max={6}
            step={0.1}
            value={st.params.contrast}
            aria-label="Procedural contrast"
            onChange={(e) => update({ ...st, params: { ...st.params, contrast: +e.target.value } })}
          />
        </div>
      )}
      <div className="pr">
        <span className="pl" style={{ fontSize: 10 }}>
          Color A
        </span>
        <input type="color" value={st.params.colorA} aria-label="Procedural color A" style={{ marginLeft: "auto" }} onChange={(e) => update({ ...st, params: { ...st.params, colorA: e.target.value } })} />
      </div>
      <div className="pr">
        <span className="pl" style={{ fontSize: 10 }}>
          Color B
        </span>
        <input type="color" value={st.params.colorB} aria-label="Procedural color B" style={{ marginLeft: "auto" }} onChange={(e) => update({ ...st, params: { ...st.params, colorB: e.target.value } })} />
      </div>
      {st.kind === "gradient" && (
        <div className="pr">
          <span className="pl" style={{ fontSize: 10 }}>
            Vertical
          </span>
          <input
            type="checkbox"
            checked={st.params.axis === 1}
            aria-label="Gradient vertical"
            style={{ marginLeft: "auto" }}
            onChange={(e) => update({ ...st, params: { ...st.params, axis: e.target.checked ? 1 : 0 } })}
          />
        </div>
      )}
      <div className="pr" title="Drive PBR roughness from the same pattern (bakes a metallic-roughness map that exports in glTF)">
        <span className="pl" style={{ fontSize: 10 }}>
          Roughness from pattern
        </span>
        <input
          type="checkbox"
          checked={st.params.roughness}
          aria-label="Roughness from pattern"
          style={{ marginLeft: "auto" }}
          onChange={(e) => update({ ...st, params: { ...st.params, roughness: e.target.checked } })}
        />
      </div>
      <div className="pr" title="Bake a tangent-space normal map from the pattern as a height field (PBR bump; exports in glTF)">
        <span className="pl" style={{ fontSize: 10 }}>
          Bump from pattern
        </span>
        <input
          type="checkbox"
          checked={st.params.normal}
          aria-label="Bump from pattern"
          style={{ marginLeft: "auto" }}
          onChange={(e) => update({ ...st, params: { ...st.params, normal: e.target.checked } })}
        />
      </div>
      {st.params.normal && (
        <div className="sr">
          <label>
            Bump Strength <span>{st.params.normalStrength.toFixed(1)}</span>
          </label>
          <input
            type="range"
            min={0.2}
            max={6}
            step={0.1}
            value={st.params.normalStrength}
            aria-label="Bump strength"
            onChange={(e) => update({ ...st, params: { ...st.params, normalStrength: +e.target.value } })}
          />
        </div>
      )}
      <button
        type="button"
        className="abtn pri"
        style={{ marginTop: 6 }}
        onClick={() => {
          applyProceduralGraph(mesh, makePresetGraph(st.kind, st.params), { ...st });
        }}
      >
        {"⚡ Bake to Albedo"}
      </button>
      <button
        type="button"
        className="abtn"
        title="Open the visual node graph editor for full control"
        onClick={() => {
          void import("../../ui/node-editor").then((mod) => mod.openNodeEditor(mesh));
        }}
      >
        {"🕸 Edit Node Graph"}
      </button>
      <button
        type="button"
        className="abtn"
        disabled={!hasProc}
        onClick={() => {
          clearProceduralGraph(mesh);
          setSt(readProcState(mesh));
        }}
      >
        Clear Procedural
      </button>
      <div style={{ fontSize: 9, color: "var(--t4)", marginTop: 4, lineHeight: 1.5 }}>
        プリセットを焼いて albedo に適用（glTF にそのまま乗る）。Edit Node Graph で任意グラフを編集
      </div>
    </>
  );
}

function DisplaySection({ mesh, mat }: { mesh: AbstractMesh; mat: PBRMaterial }) {
  return (
    <>
      <div className="pgt" style={{ marginTop: 10 }}>
        Display
      </div>
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>
          Wireframe
        </span>
        <input
          type="checkbox"
          checked={!!mat.wireframe}
          aria-label="Wireframe"
          style={{ marginLeft: "auto" }}
          onChange={(e) => {
            const before = !e.target.checked;
            const after = e.target.checked;
            (mesh.material as PBRMaterial).wireframe = after;
            state.history.push({
              label: "Wireframe",
              undo() {
                (mesh.material as PBRMaterial).wireframe = before;
              },
              redo() {
                (mesh.material as PBRMaterial).wireframe = after;
              },
            });
          }}
        />
      </div>
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>
          Unlit
        </span>
        <input
          type="checkbox"
          checked={!!mat.unlit}
          aria-label="Unlit"
          style={{ marginLeft: "auto" }}
          onChange={(e) => {
            const before = !e.target.checked;
            const after = e.target.checked;
            (mesh.material as PBRMaterial).unlit = after;
            state.history.push({
              label: "Unlit",
              undo() {
                (mesh.material as PBRMaterial).unlit = before;
              },
              redo() {
                (mesh.material as PBRMaterial).unlit = after;
              },
            });
          }}
        />
      </div>
    </>
  );
}

function TexturesSection() {
  return (
    <WithMaterial>
      {(mesh, mat) => (
        <>
          {TEX_SLOTS.map(({ slot, label }) => (
            <TextureSlotRow key={slot} mesh={mesh} slot={slot} label={label} />
          ))}
          <AOBakeRow mesh={mesh} />
          <NormalBakeRow mesh={mesh} />
          <ProceduralSection mesh={mesh} />
          <DisplaySection mesh={mesh} mat={mat} />
        </>
      )}
    </WithMaterial>
  );
}

// ───────────────────────── Morph ─────────────────────────

const MORPH_CHANNEL_LABELS: [AnimChannel, string][] = [
  ["rx", "Rot X"],
  ["ry", "Rot Y"],
  ["rz", "Rot Z"],
  ["px", "Pos X"],
  ["py", "Pos Y"],
  ["pz", "Pos Z"],
];

/**
 * A shape-key driver row (bone channel → morph influence). Ported from the
 * driver block + `readDriverRow` in `updateMorphUI` (`src/tools/morph.ts`).
 * Every branch there ends by redrawing unconditionally; here that is
 * `store.notify()` on the branches that do not already call `status()`
 * (which notifies on its own).
 */
function MorphDriverRow({ mesh, idx }: { mesh: AbstractMesh; idx: number }) {
  const skel = getActiveSkeleton();
  if (!skel) return null;
  const drv = findDriver(state.morphDrivers, mesh.uniqueId, idx);
  const on = !!drv?.enabled;
  const boneName = drv?.boneName ?? "";
  const channel = drv?.channel ?? "rx";
  const inMin = drv?.inMin ?? 0;
  const inMax = drv?.inMax ?? 1;

  const commit = (patch: Partial<{ on: boolean; boneName: string; channel: AnimChannel; inMin: number; inMax: number }>): void => {
    const next = { on, boneName, channel, inMin, inMax, ...patch };
    const existing = findDriver(state.morphDrivers, mesh.uniqueId, idx);
    if (!next.on) {
      if (existing) {
        state.morphDrivers = state.morphDrivers.filter((d) => d !== existing);
        status("Driver 解除");
      } else {
        store.notify();
      }
      return;
    }
    if (!next.boneName) {
      status("⚠ Driver: ボーンがない — 先にスケルトンを作成");
      return;
    }
    if (existing) {
      existing.enabled = true;
      existing.boneName = next.boneName;
      existing.channel = next.channel;
      existing.inMin = next.inMin;
      existing.inMax = next.inMax;
      store.notify();
    } else {
      const created: MorphDriver = {
        enabled: true,
        meshUniqueId: mesh.uniqueId,
        targetIndex: idx,
        boneName: next.boneName,
        channel: next.channel,
        inMin: next.inMin,
        inMax: next.inMax,
      };
      state.morphDrivers.push(created);
      status(`Driver: ${next.boneName} → morph ${idx}`);
    }
  };

  return (
    <div className="sr" style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, paddingLeft: 8, color: "var(--t4)" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 2, cursor: "pointer" }} title="ボーンの姿勢チャンネルでこのモーフを駆動 (ドライバ有効中はスライダー / キーより優先)">
        <input type="checkbox" checked={on} aria-label={"Morph " + idx + " driver enabled"} onChange={(e) => commit({ on: e.target.checked })} />⚙
      </label>
      <select aria-label={"Morph " + idx + " driver bone"} value={boneName} disabled={!on} style={{ flex: 1, minWidth: 0, fontSize: 9 }} onChange={(e) => commit({ boneName: e.target.value })}>
        <option value="" disabled hidden></option>
        {skel.bones.map((b) => (
          <option key={b.id} value={b.name}>
            {b.name}
          </option>
        ))}
      </select>
      <select aria-label={"Morph " + idx + " driver channel"} value={channel} disabled={!on} style={{ width: 52, fontSize: 9 }} onChange={(e) => commit({ channel: e.target.value as AnimChannel })}>
        {MORPH_CHANNEL_LABELS.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      <input
        type="number"
        step={0.1}
        value={inMin}
        disabled={!on}
        aria-label={"Morph " + idx + " driver min"}
        title="この値で influence 0"
        style={{ width: 40, fontSize: 9 }}
        onChange={(e) => commit({ inMin: +e.target.value })}
      />
      <input
        type="number"
        step={0.1}
        value={inMax}
        disabled={!on}
        aria-label={"Morph " + idx + " driver max"}
        title="この値で influence 1"
        style={{ width: 40, fontSize: 9 }}
        onChange={(e) => commit({ inMax: +e.target.value })}
      />
    </div>
  );
}

function MorphTargetRow({ mesh, idx, target }: { mesh: AbstractMesh; idx: number; target: MorphTarget }) {
  const [draft, setDraft] = useState<number | null>(null);
  const drv = findDriver(state.morphDrivers, mesh.uniqueId, idx);
  const driven = !!drv?.enabled;
  const value = draft ?? target.influence;
  return (
    <>
      <div className="sr" style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <label style={{ flex: 1 }}>
          {target.name}
          {driven ? " ⚙" : ""} <span>{value.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          disabled={driven}
          style={{ flex: 2 }}
          aria-label={"Morph target " + target.name + " influence"}
          onChange={(e) => {
            const v = +e.target.value;
            setMorphInfluence(mesh.uniqueId, idx, v);
            setDraft(v);
          }}
          onPointerUp={() => {
            setDraft(null);
            // Auto-Key: commit a morph keyframe once the drag settles (mirrors
            // the old "change" listener firing on release, not per-tick).
            void import("../../tools/animation-tool").then((mod) => mod.notifyMorphEdited(mesh.uniqueId, idx));
          }}
        />
        <button
          type="button"
          className="abtn dan"
          style={{ padding: "1px 5px", fontSize: 9, minWidth: 0 }}
          aria-label={"Delete morph target " + target.name}
          onClick={() => deleteMorphTarget(mesh.uniqueId, idx)}
        >
          ✕
        </button>
      </div>
      <MorphDriverRow mesh={mesh} idx={idx} />
    </>
  );
}

function MorphTargetsList({ mesh }: { mesh: AbstractMesh }) {
  const d = state.morphMap.get(mesh.uniqueId);
  if (!d || d.targets.length === 0) return <div className="empty">ターゲットなし</div>;
  return (
    <>
      {d.targets.map((t, i) => (
        <MorphTargetRow key={t.name + i} mesh={mesh} idx={i} target={t} />
      ))}
    </>
  );
}

function MorphSection() {
  const mesh = useSelectedMesh();
  return (
    <>
      {mesh ? <MorphTargetsList mesh={mesh} /> : <div className="empty">メッシュを選択</div>}
      <button type="button" className="abtn" style={{ marginTop: 6 }} onClick={() => addMorph()}>
        + ターゲット有効化
      </button>
      <button type="button" className="abtn" onClick={() => captureMorph()}>
        {"📷 形状キャプチャ"}
      </button>
    </>
  );
}

// ───────────────────────── Scene: Lights ─────────────────────────

function LightProps({ id, data }: { id: string; data: LightData }) {
  return (
    <div style={{ padding: "6px 8px", background: "var(--bg2)", borderRadius: 3, marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
      <div className="pr" style={{ marginBottom: 4 }}>
        <span className="pl" style={{ fontSize: 9 }}>
          Color
        </span>
        <input type="color" value={data.color} aria-label={"Light " + id + " color"} onChange={(e) => updateLightParam(id, "color", e.target.value)} />
      </div>
      <div className="pr" style={{ marginBottom: 4 }}>
        <span className="pl" style={{ fontSize: 9 }}>
          Intensity
        </span>
        <input
          type="range"
          min={0}
          max={5}
          step={0.1}
          value={data.intensity}
          aria-label={"Light " + id + " intensity"}
          onChange={(e) => updateLightParam(id, "intensity", +e.target.value)}
        />
      </div>
      <div className="pr" style={{ marginBottom: 4 }}>
        <span className="pl" style={{ fontSize: 9 }}>
          Range
        </span>
        <input type="range" min={1} max={50} step={1} value={data.range} aria-label={"Light " + id + " range"} onChange={(e) => updateLightParam(id, "range", +e.target.value)} />
      </div>
      {data.type === "spot" && (
        <div className="pr" style={{ marginBottom: 4 }}>
          <span className="pl" style={{ fontSize: 9 }}>
            Angle
          </span>
          <input
            type="range"
            min={10}
            max={120}
            step={1}
            value={data.angle ?? 45}
            aria-label={"Light " + id + " angle"}
            onChange={(e) => updateLightParam(id, "angle", +e.target.value)}
          />
        </div>
      )}
      {(["x", "y", "z"] as const).map((axis) => (
        <div className="pr" key={axis} style={{ marginBottom: 2 }}>
          <span className={"pl " + axis} style={{ fontSize: 9 }}>
            {axis.toUpperCase()}
          </span>
          <input
            className="pi"
            type="number"
            step={0.5}
            value={data.light.position[axis]}
            aria-label={"Light " + id + " position " + axis.toUpperCase()}
            onChange={(e) => updateLightParam(id, "pos" + axis.toUpperCase(), +e.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

function LightRow({ id, data, selected }: { id: string; data: LightData; selected: boolean }) {
  return (
    <div>
      <div
        className={"sitem" + (selected ? " sel" : "")}
        role="button"
        tabIndex={0}
        onClick={() => {
          selectLight(id);
          store.notify(); // selectedLightId is not in the store's fingerprint
        }}
      >
        <div className="cd" style={{ background: data.color, borderRadius: "50%" }} />
        <span style={{ fontSize: 10 }}>
          {data.type === "point" ? "Point" : "Spot"} {id.split("_")[1]}
        </span>
        <button
          type="button"
          className="dl"
          style={{ marginLeft: "auto" }}
          aria-label={"Delete " + id}
          onClick={(e) => {
            e.stopPropagation();
            removeLight(id);
          }}
        >
          ✕
        </button>
      </div>
      {selected && <LightProps id={id} data={data} />}
    </div>
  );
}

function LightsSection() {
  const lights = useForge((s) => [...s.lightMap.entries()]);
  const selectedId = useForge((s) => s.selectedLightId);
  return (
    <>
      {lights.length === 0 ? <div className="empty">ライトなし</div> : lights.map(([id, data]) => <LightRow key={id} id={id} data={data} selected={id === selectedId} />)}
      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
        <button type="button" className="abtn" style={{ flex: 1, fontSize: 9 }} onClick={() => addLight("point")}>
          + Point
        </button>
        <button type="button" className="abtn" style={{ flex: 1, fontSize: 9 }} onClick={() => addLight("spot")}>
          + Spot
        </button>
      </div>
    </>
  );
}

// ───────────────────────── Scene: Environment ─────────────────────────

function EnvironmentSection() {
  const preset = useForge((s) => s.activeEnvPresetId);
  const intensity = useForge((s) => s.envIntensity);
  const skybox = useForge((s) => s.showSkybox);
  return (
    <>
      <div className="sr">
        <label>Preset</label>
        <select aria-label="Environment preset" value={preset === "custom" ? "" : preset} onChange={(e) => setEnvironmentPreset(e.target.value)}>
          {ENV_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <button type="button" className="abtn" onClick={() => loadCustomHDRI()}>
        Import HDRI
      </button>
      <button type="button" className="abtn" onClick={() => importReferenceImage()}>
        {"🖼 Import Reference（下絵）"}
      </button>
      <div className="sr">
        <label>
          Intensity <span>{intensity.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0}
          max={3}
          step={0.05}
          value={intensity}
          aria-label="Environment intensity"
          onChange={(e) => {
            setEnvironmentIntensity(+e.target.value);
            store.notify(); // envIntensity is not in the store's fingerprint
          }}
        />
      </div>
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>
          Skybox
        </span>
        <input
          type="checkbox"
          checked={skybox}
          aria-label="Skybox enabled"
          style={{ marginLeft: "auto" }}
          onChange={(e) => {
            toggleSkybox(e.target.checked);
            store.notify();
          }}
        />
      </div>
    </>
  );
}

// ───────────────────────── Scene: Shadows ─────────────────────────

function ShadowsSection() {
  const enabled = useForge((s) => s.shadowsEnabled);
  const quality = useForge((s) => s.shadowQuality);
  return (
    <>
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>
          Enabled
        </span>
        <input
          type="checkbox"
          checked={enabled}
          aria-label="Shadows enabled"
          style={{ marginLeft: "auto" }}
          onChange={(e) => {
            setShadowEnabled(e.target.checked);
            store.notify();
          }}
        />
      </div>
      <div className="sr">
        <label>Quality</label>
        <select
          aria-label="Shadow quality"
          value={quality}
          onChange={(e) => {
            setShadowQuality(+e.target.value as 512 | 1024 | 2048);
            store.notify();
          }}
        >
          <option value={512}>Low (512)</option>
          <option value={1024}>Medium (1024)</option>
          <option value={2048}>High (2048)</option>
        </select>
      </div>
    </>
  );
}

// ───────────────────────── Map: Model Library ─────────────────────────

/** Copied from the non-exported `formatBytes` in `src/ui/panels.ts`. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function ModelLibraryRow({ meta, onChanged }: { meta: ModelMetadata; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: "flex", gap: 6, padding: 4, borderBottom: "1px solid var(--bg3)", alignItems: "center" }}>
      {meta.thumbnail && <img src={meta.thumbnail} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 3, background: "var(--bg2)" }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: "var(--t1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta.name}</div>
        <div style={{ fontSize: 9, color: "var(--t4)" }}>{meta.size ? formatBytes(meta.size) : ""}</div>
      </div>
      <button
        type="button"
        className="abtn"
        disabled={busy}
        style={{ padding: "2px 6px", fontSize: 9, minWidth: 0 }}
        title="Place in scene"
        aria-label={"Place " + meta.name}
        onClick={() => {
          setBusy(true);
          void placeModel(meta.id, meta.name)
            .catch(() => status("⚠ 配置に失敗"))
            .finally(() => setBusy(false));
        }}
      >
        +
      </button>
      <button
        type="button"
        className="abtn dan"
        disabled={busy}
        style={{ padding: "2px 6px", fontSize: 9, minWidth: 0 }}
        title="Delete from library"
        aria-label={"Delete " + meta.name}
        onClick={() => {
          setBusy(true);
          void deleteFromLibrary(meta.id)
            .then(onChanged)
            .catch(() => status("⚠ 削除に失敗"))
            .finally(() => setBusy(false));
        }}
      >
        ✕
      </button>
    </div>
  );
}

function ModelLibrarySection() {
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const refresh = useCallback(() => {
    void loadModelLibrary().then(setModels);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return (
    <>
      {models.length === 0 ? (
        <div className="empty">Save to Libraryでモデルを保存</div>
      ) : (
        <div style={{ maxHeight: "min(200px, 35vh)", overflowY: "auto" }}>
          {models.map((meta) => (
            <ModelLibraryRow key={meta.id} meta={meta} onChanged={refresh} />
          ))}
        </div>
      )}
      <button type="button" className="abtn" style={{ marginTop: 6 }} onClick={refresh}>
        {"↻ Refresh Library"}
      </button>
    </>
  );
}

// ───────────────────────── Map: Scene Instances ─────────────────────────

function SceneInstancesSection() {
  const instances = useForge((s) => s.mapInstances);
  if (instances.length === 0) return <div className="empty">ライブラリからモデルを配置</div>;
  return (
    <div style={{ maxHeight: "min(180px, 30vh)", overflowY: "auto" }}>
      {instances.map((inst) => (
        <div
          key={inst.instanceId}
          className="sitem"
          role="button"
          tabIndex={0}
          style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
          onClick={() => {
            const mesh = state.allMeshes.find((m) => inst.meshUniqueIds.includes(m.uniqueId));
            if (mesh) selectMesh(mesh, false);
          }}
        >
          <span style={{ flex: 1, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inst.modelName}</span>
          <button
            type="button"
            className="abtn dan"
            style={{ padding: "2px 6px", fontSize: 9, minWidth: 0 }}
            aria-label={"Remove " + inst.modelName}
            onClick={(e) => {
              e.stopPropagation();
              removeMapInstance(inst.instanceId);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────── Map: Layout ─────────────────────────

function LayoutSection() {
  const [name, setName] = useState("");
  return (
    <>
      <div className="pr" style={{ marginBottom: 6 }}>
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>
          Name
        </span>
        <input className="pi" type="text" aria-label="Layout name" placeholder="Layout name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <button type="button" className="abtn pri" onClick={() => exportSceneLayout(name)}>
        {"⬇ Export Layout JSON"}
      </button>
      <button type="button" className="abtn" onClick={() => importSceneLayout()}>
        {"📂 Import Layout"}
      </button>
      <button type="button" className="abtn dan" onClick={() => clearAllMapInstances()}>
        {"✕ Clear Scene"}
      </button>
    </>
  );
}

// ───────────────────────── exports ─────────────────────────

export const matControls: Record<string, () => ReactNode> = {
  alb: () => <AlbedoSection />,
  pbr: () => <PbrSection />,
  emi: () => <EmissiveSection />,
  tex: () => <TexturesSection />,
};

export const morphControls: Record<string, () => ReactNode> = {
  mt: () => <MorphSection />,
};

export const sceneControls: Record<string, () => ReactNode> = {
  li: () => <LightsSection />,
  env: () => <EnvironmentSection />,
  shd: () => <ShadowsSection />,
};

export const mapControls: Record<string, () => ReactNode> = {
  lib: () => <ModelLibrarySection />,
  inst: () => <SceneInstancesSection />,
  lay: () => <LayoutSection />,
};
