/**
 * The selected mesh's modifier stack: add (with a line on each kind), and per
 * entry ON/OFF, Apply, remove, and its parameters. Sliders re-run the stack
 * when let go, so a heavy modifier does not stall the drag.
 */
import { useState } from "react";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { MODIFIER_TYPES, type Modifier, type ModifierType } from "../state";
import { addModifier, applyModifier, getModifiers, removeModifier, toggleModifier, updateModifierParam } from "../tools/modifiers";
import { MODIFIER_HELP } from "./guide/guide";
import { useForge } from "./use-forge";

function label(mod: Modifier): string {
  switch (mod.type) {
    case "subdivision": return `Subdivision (L${mod.level}${mod.mode === "catmull-clark" ? "" : " Simple"})`;
    case "mirror": return `Mirror (${mod.axis.toUpperCase()})`;
    case "array": return `Array (×${mod.count})`;
    case "solidify": return `Solidify (${mod.thickness.toFixed(2)})`;
    case "decimate": return `Decimate (${Math.round(mod.ratio * 100)}%)`;
    case "smooth": return `Smooth (×${mod.repeat})`;
    case "triangulate": return "Triangulate";
    case "weld": return "Weld";
  }
}

function Slider({ mesh, mod, k, text, min, max, step }: { mesh: AbstractMesh; mod: Modifier; k: string; text: string; min: number; max: number; step: number }) {
  const value = (mod as unknown as Record<string, number>)[k]!;
  const [draft, setDraft] = useState<number | null>(null);
  const digits = step >= 1 ? 0 : Math.max(1, Math.ceil(-Math.log10(step)));
  const commit = (): void => {
    if (draft !== null && draft !== value) updateModifierParam(mesh, mod.id, { [k]: draft });
    setDraft(null);
  };
  const v = draft ?? value;
  return (
    <div className="sr">
      <label>
        {text} <span>{v.toFixed(digits)}</span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        aria-label={text}
        onChange={(e) => setDraft(+e.target.value)}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </div>
  );
}

function Choice({ mesh, mod, k, options }: { mesh: AbstractMesh; mod: Modifier; k: string; options: [string, string][] }) {
  const cur = (mod as unknown as Record<string, unknown>)[k];
  return (
    <div className="choice-row" role="group">
      {options.map(([value, text]) => (
        <button key={value} type="button" className={"abtn" + (cur === value ? " bon on" : "")} aria-pressed={cur === value} onClick={() => updateModifierParam(mesh, mod.id, { [k]: value })}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Params({ mesh, mod }: { mesh: AbstractMesh; mod: Modifier }) {
  switch (mod.type) {
    case "subdivision":
      return (
        <>
          <Choice mesh={mesh} mod={mod} k="mode" options={[["catmull-clark", "丸く"], ["simple", "割るだけ"]]} />
          <Slider mesh={mesh} mod={mod} k="level" text="Level" min={1} max={3} step={1} />
        </>
      );
    case "mirror":
      return <Choice mesh={mesh} mod={mod} k="axis" options={[["x", "X"], ["y", "Y"], ["z", "Z"]]} />;
    case "array":
      return (
        <>
          <Slider mesh={mesh} mod={mod} k="count" text="Count" min={2} max={10} step={1} />
          <Slider mesh={mesh} mod={mod} k="offsetX" text="Offset X" min={-5} max={5} step={0.1} />
          <Slider mesh={mesh} mod={mod} k="offsetY" text="Offset Y" min={-5} max={5} step={0.1} />
          <Slider mesh={mesh} mod={mod} k="offsetZ" text="Offset Z" min={-5} max={5} step={0.1} />
        </>
      );
    case "solidify":
      return <Slider mesh={mesh} mod={mod} k="thickness" text="Thickness" min={-0.5} max={0.5} step={0.01} />;
    case "decimate":
      return <Slider mesh={mesh} mod={mod} k="ratio" text="Ratio" min={0.05} max={1} step={0.05} />;
    case "smooth":
      return (
        <>
          <Slider mesh={mesh} mod={mod} k="factor" text="Factor" min={0} max={1} step={0.05} />
          <Slider mesh={mesh} mod={mod} k="repeat" text="Repeat" min={1} max={20} step={1} />
        </>
      );
    case "triangulate":
      return <Choice mesh={mesh} mod={mod} k="quadMethod" options={[["beauty", "Beauty"], ["fixed", "Fixed"], ["shortEdge", "短い対角"]]} />;
    case "weld":
      return <Slider mesh={mesh} mod={mod} k="distance" text="Distance" min={0} max={0.1} step={0.001} />;
  }
}

export function ModifierPanel() {
  const mesh = useForge((s) => s.selectedMeshes[s.selectedMeshes.length - 1] ?? null);
  const mods = useForge(() => (mesh ? [...getModifiers(mesh)] : []));
  if (!mesh) return <div className="empty">メッシュを選択</div>;
  return (
    <>
      {mods.length === 0 && <div className="empty">モディファイアなし</div>}
      {mods.map((mod) => (
        <div key={mod.id} className="mod-entry" data-enabled={mod.enabled}>
          <div className="mod-head">
            <span className="mod-name">{label(mod)}</span>
            <button type="button" className="mod-btn" onClick={() => toggleModifier(mesh, mod.id)}>{mod.enabled ? "ON" : "OFF"}</button>
            <button type="button" className="mod-btn pri" onClick={() => applyModifier(mesh, mod.id)}>Apply</button>
            <button type="button" className="mod-btn dan" aria-label="外す" onClick={() => removeModifier(mesh, mod.id)}>✕</button>
          </div>
          <div className="mod-hint">{MODIFIER_HELP[mod.type].one}</div>
          <Params mesh={mesh} mod={mod} />
        </div>
      ))}
      <select
        className="pi mod-add"
        value=""
        aria-label="モディファイアを追加"
        onChange={(e) => {
          const t = e.target.value as ModifierType;
          if (t) addModifier(mesh, t);
        }}
      >
        <option value="">＋ モディファイアを追加…</option>
        {MODIFIER_TYPES.map((t) => (
          <option key={t} value={t}>
            {MODIFIER_HELP[t].name} — {MODIFIER_HELP[t].one}
          </option>
        ))}
      </select>
    </>
  );
}
