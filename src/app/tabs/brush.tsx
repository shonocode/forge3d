/**
 * Sculpt and Paint tab controls (ADR-014 port). Old markup: `tb-sculpt` /
 * `tb-paint` in the pre-React screen; brush mode buttons came from
 * `buildBrushButtons` (src/ui/builders.ts), the rest from bindings in
 * src/ui/bindings.ts and the layer list from `updatePaintLayersUI`
 * (src/tools/texture-paint.ts).
 *
 * `sculptConfig` / `paintConfig` are plain fields on the state singleton —
 * writing them directly does not tell the store anything, so every writer
 * here calls `store.notify()` itself (see src/store.ts's note on writes the
 * fingerprint does not see).
 */
import type { ReactNode } from "react";
import { state, status, isMobile } from "../../state";
import { store } from "../../store";
import { BRUSHES, clearSculptMask, setBrush } from "../../tools/sculpt";
import { lastSelected } from "../../tools/selection";
import {
  addPaintLayer,
  clearPaintTexture,
  compositePaintLayers,
  getBrushImageName,
  loadBrushImage,
  removePaintLayer,
} from "../../tools/texture-paint";
import { LAYER_BLENDS, type LayerBlend } from "../../tools/paint-layers";
import type { PaintChannel } from "../../tools/paint-channels";
import { useForge } from "../use-forge";
import "./brush.css";

/** A `.sr` slider bound to a `number`; commits on every drag tick (the config it writes is cheap to re-read next stroke). */
function BrushSlider({
  text,
  value,
  min,
  max,
  step,
  ariaLabel,
  format = String,
  onChange,
}: {
  text: string;
  value: number;
  min: number;
  max: number;
  step: number;
  ariaLabel?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="sr">
      <label>
        {text} <span>{format(value)}</span>
      </label>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={ariaLabel ?? text} onChange={(e) => onChange(+e.target.value)} />
    </div>
  );
}

// ── Sculpt ───────────────────────────────────────────────────────────────

function SculptBrushSection() {
  const cfg = useForge((s) => s.sculptConfig);
  const set = (patch: Partial<typeof cfg>): void => {
    Object.assign(state.sculptConfig, patch);
    store.notify();
  };
  return (
    <>
      <BrushSlider text="Size" value={cfg.radius} min={0.1} max={3} step={0.05} ariaLabel="Brush size" onChange={(v) => set({ radius: v })} />
      <BrushSlider text="Strength" value={cfg.strength} min={0.005} max={0.2} step={0.005} ariaLabel="Brush strength" onChange={(v) => set({ strength: v })} />
      <BrushSlider text="Falloff" value={cfg.falloff} min={0.5} max={4} step={0.1} ariaLabel="Brush falloff" onChange={(v) => set({ falloff: v })} />
    </>
  );
}

function TouchModifierRow() {
  const mods = useForge((s) => s.touchModifiers);
  const setMod = (key: "ctrl" | "shift"): void => {
    const on = !state.touchModifiers[key];
    state.touchModifiers.ctrl = false;
    state.touchModifiers.shift = false;
    if (on) state.touchModifiers[key] = true;
    store.notify();
  };
  return (
    <div className="touch-mod-row">
      <button type="button" className={"abtn touch-mod" + (mods.ctrl ? " on" : "")} onClick={() => setMod("ctrl")}>
        ⇅ Invert
      </button>
      <button type="button" className={"abtn touch-mod" + (mods.shift ? " on" : "")} onClick={() => setMod("shift")}>
        〜 Smooth
      </button>
      <div className="touch-mod-hint">Invert/Smoothトグルでモード切替</div>
    </div>
  );
}

function BrushModeSection() {
  const brush = useForge((s) => s.sculptConfig.brush);
  return (
    <>
      {BRUSHES.map((b) => (
        <button key={b.id} type="button" className={"abtn bon" + (brush === b.id ? " on" : "")} aria-pressed={brush === b.id} onClick={() => setBrush(b.id)}>
          {b.label}
        </button>
      ))}
      {isMobile() && <TouchModifierRow />}
    </>
  );
}

function SymmetrySection() {
  const cfg = useForge((s) => s.sculptConfig);
  const axes: { key: "symX" | "symY" | "symZ"; label: string }[] = [
    { key: "symX", label: "X" },
    { key: "symY", label: "Y" },
    { key: "symZ", label: "Z" },
  ];
  return (
    <div className="sym-row">
      {axes.map((a) => (
        <label key={a.key}>
          <input
            type="checkbox"
            checked={cfg[a.key]}
            onChange={(e) => {
              state.sculptConfig[a.key] = e.target.checked;
              store.notify();
            }}
          />
          {a.label}
        </label>
      ))}
    </div>
  );
}

function DyntopoSection() {
  const cfg = useForge((s) => s.sculptConfig);
  return (
    <>
      <label className="pr">
        <input
          type="checkbox"
          checked={cfg.dyntopo}
          onChange={(e) => {
            state.sculptConfig.dyntopo = e.target.checked;
            store.notify();
          }}
        />
        <span>適応的細分化（ストローク中に分割）</span>
      </label>
      <BrushSlider
        text="Detail"
        value={cfg.detail}
        min={0.02}
        max={0.5}
        step={0.01}
        format={(v) => v.toFixed(2)}
        ariaLabel="Dyntopo detail size"
        onChange={(v) => {
          state.sculptConfig.detail = v;
          store.notify();
        }}
      />
      <button
        type="button"
        className="abtn"
        onClick={() => {
          const m = lastSelected();
          if (m) clearSculptMask(m);
        }}
      >
        ▦ Clear Mask
      </button>
    </>
  );
}

// ── Paint ────────────────────────────────────────────────────────────────

function PaintBrushSection() {
  const cfg = useForge((s) => s.paintConfig);
  const set = (patch: Partial<typeof cfg>): void => {
    Object.assign(state.paintConfig, patch);
    store.notify();
  };
  return (
    <>
      <div className="pr">
        <span className="pl">Channel</span>
        <select
          className="pi"
          aria-label="Paint channel"
          value={cfg.channel}
          onChange={(e) => {
            const ch = e.target.value as PaintChannel;
            state.paintConfig.channel = ch;
            status(ch === "albedo" ? "Paint: Albedo (色)" : `Paint: ${ch} — 色の明るさが値になる (白=1 / 黒=0)`);
          }}
        >
          <option value="albedo">Albedo</option>
          <option value="roughness">Roughness</option>
          <option value="metallic">Metallic</option>
        </select>
      </div>
      <div className="pr">
        <span className="pl">Color</span>
        <input className="paint-color" type="color" aria-label="Paint color" value={cfg.color} onChange={(e) => set({ color: e.target.value })} />
      </div>
      <BrushSlider text="Size" value={cfg.size} min={2} max={80} step={1} ariaLabel="Paint brush size" onChange={(v) => set({ size: v })} />
      <BrushSlider text="Opacity" value={cfg.opacity} min={0.05} max={1} step={0.05} format={(v) => v.toFixed(2)} ariaLabel="Paint opacity" onChange={(v) => set({ opacity: v })} />
      <BrushSlider text="Hardness" value={cfg.hardness} min={0} max={1} step={0.05} format={(v) => v.toFixed(2)} ariaLabel="Brush hardness" onChange={(v) => set({ hardness: v })} />
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>
          Eraser
        </span>
        <input type="checkbox" aria-label="Eraser mode" checked={cfg.eraser} style={{ marginLeft: "auto" }} onChange={(e) => set({ eraser: e.target.checked })} />
      </div>
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>
          Resolution
        </span>
        <select
          className="pi"
          aria-label="Paint texture resolution"
          style={{ marginLeft: "auto", fontSize: 10 }}
          value={cfg.resolution}
          onChange={(e) => set({ resolution: Number(e.target.value) as 512 | 1024 | 2048 })}
        >
          <option value={512}>512</option>
          <option value={1024}>1024</option>
          <option value={2048}>2048</option>
        </select>
      </div>
    </>
  );
}

function BrushImageSection() {
  const cfg = useForge((s) => s.paintConfig);
  // Re-rendered on any store notify (subscribed above), which loadBrushImage
  // triggers via status() — so reading the module-level name here picks up
  // a freshly loaded image without extra local state.
  const name = getBrushImageName();
  return (
    <>
      <button type="button" className="abtn" onClick={() => loadBrushImage()}>
        📂 Load Image
      </button>
      <div className="brush-img-name">{name || "— 画像なし —"}</div>
      <div className="pr">
        <span className="pl" style={{ fontSize: 10, color: "var(--t3)" }}>
          Mode
        </span>
        <select
          className="pi"
          aria-label="Brush image mode"
          style={{ marginLeft: "auto", fontSize: 10 }}
          value={cfg.brushMode}
          onChange={(e) => {
            const mode = e.target.value as typeof cfg.brushMode;
            state.paintConfig.brushMode = mode;
            store.notify();
            if (mode !== "round" && !getBrushImageName()) status("⚠ 先に 📂 Load Image でブラシ画像を読み込む (それまで Round で描画)");
          }}
        >
          <option value="round">Round</option>
          <option value="stamp">Stamp</option>
          <option value="stencil">Stencil</option>
        </select>
      </div>
      <BrushSlider
        text="Stencil Scale"
        value={cfg.stencilScale}
        min={0.25}
        max={4}
        step={0.25}
        format={(v) => v.toFixed(2)}
        ariaLabel="Stencil tile scale"
        onChange={(v) => {
          state.paintConfig.stencilScale = v;
          store.notify();
        }}
      />
    </>
  );
}

function LayersSection() {
  const mesh = useForge((s) => s.selectedMeshes[s.selectedMeshes.length - 1] ?? null);
  const stack = mesh ? state.paintLayersMap.get(mesh.uniqueId) : undefined;
  if (!mesh || !stack) {
    return <div className="empty">ペイント開始で Base レイヤーが作られる</div>;
  }
  const m = mesh;
  return (
    <>
      <div className="play-list" role="list" aria-label="Paint layers">
        {[...stack.layers]
          .map((layer, idx) => ({ layer, idx }))
          .reverse()
          .map(({ layer, idx }) => {
            const active = idx === stack.active;
            return (
              <div
                key={idx}
                role="listitem"
                className={"play-row" + (active ? " sel" : "")}
                onClick={() => {
                  stack.active = idx;
                  store.notify();
                }}
              >
                <input
                  type="checkbox"
                  aria-label={`${layer.name} を表示`}
                  checked={layer.visible}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    layer.visible = e.target.checked;
                    compositePaintLayers(m.uniqueId);
                    store.notify();
                  }}
                />
                <span className="play-name">{layer.name}</span>
                <select
                  className="pi play-blend"
                  aria-label={`${layer.name} のブレンドモード`}
                  value={layer.blend}
                  disabled={layer.isBase}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    layer.blend = e.target.value as LayerBlend;
                    compositePaintLayers(m.uniqueId);
                    store.notify();
                  }}
                >
                  {LAYER_BLENDS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <input
                  type="range"
                  className="play-op"
                  aria-label={`${layer.name} の不透明度`}
                  min={0}
                  max={1}
                  step={0.05}
                  value={layer.opacity}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    layer.opacity = +e.target.value;
                    compositePaintLayers(m.uniqueId);
                    store.notify();
                  }}
                />
                {!layer.isBase && (
                  <button
                    type="button"
                    className="abtn dan play-del"
                    aria-label={`${layer.name} を削除`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removePaintLayer(m, idx);
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
      </div>
      <button
        type="button"
        className="abtn"
        onClick={() => {
          const sel = lastSelected();
          if (!sel) {
            status("⚠ メッシュを選択");
            return;
          }
          addPaintLayer(sel);
        }}
      >
        + Add Layer
      </button>
    </>
  );
}

function PaintActionsSection() {
  return (
    <button
      type="button"
      className="abtn"
      onClick={() => {
        const m = lastSelected();
        if (m) clearPaintTexture(m);
      }}
    >
      Clear Paint
    </button>
  );
}

/** Sculpt tab: {@link TAB_SECTIONS}'s `br` / `bm` / `sym` / `dyn` (see src/app/guide/guide.ts). `io` belongs to another group. */
export const sculptControls: Record<string, () => ReactNode> = {
  br: () => <SculptBrushSection />,
  bm: () => <BrushModeSection />,
  sym: () => <SymmetrySection />,
  dyn: () => <DyntopoSection />,
};

/** Paint tab: {@link TAB_SECTIONS}'s `pb` / `bi` / `pl` / `pa`. `io` belongs to another group. */
export const paintControls: Record<string, () => ReactNode> = {
  pb: () => <PaintBrushSection />,
  bi: () => <BrushImageSection />,
  pl: () => <LayersSection />,
  pa: () => <PaintActionsSection />,
};

