/**
 * Shared bits for the rig group (Bone / Weight / Anim tabs — ADR-014).
 *
 * Most of the fields this group ports have no undo in the old screen either
 * (`src/ui/bindings.ts`): IK/Aim/Limit targets, brush configs, bone display —
 * they write straight into `state` on every keystroke/drag. These two
 * components keep that behavior while giving the field its own draft so the
 * digits typed survive re-renders that happen mid-edit (same trick as
 * `transform-fields.tsx`'s `Field`).
 *
 * Cross-component reactivity: the store (`src/store.ts`) only re-renders on
 * undo-history pushes, `status()` calls, and a per-frame fingerprint that
 * does not cover bone selection / current frame / IK constraints (see
 * `src/app/boot.ts`'s fixed `extra` hook, which this group cannot extend
 * without editing an existing file). So every handler here that changes
 * something another section reads calls {@link notifyRig} — a thin wrapper
 * over `store.notify()` — explicitly.
 */
import { useState, type CSSProperties } from "react";
import { store } from "../../store";

/** Call after any mutation another rig section's render might depend on. */
export function notifyRig(): void {
  store.notify();
}

const rowStyle: CSSProperties = { display: "flex", gap: 4, alignItems: "center" };

/**
 * One numeric field with a draft so typed digits don't get clobbered by a
 * re-render mid-edit. `value`/`onChange` are the live source of truth —
 * there is no separate commit step, matching the old screen's IK/Aim/Limit
 * inputs (every keystroke writes straight through, no undo entry).
 */
export function NumField({
  ariaLabel,
  axisLabel,
  value,
  onChange,
  step = 0.1,
  digits = 3,
  width,
}: {
  ariaLabel: string;
  axisLabel?: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  digits?: number;
  width?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = value.toFixed(digits);
  return (
    <div className="sr" style={rowStyle}>
      {axisLabel && <label style={{ fontSize: 9, width: 14 }}>{axisLabel}</label>}
      <input
        className="pi"
        type="number"
        step={step}
        aria-label={ariaLabel}
        style={width ? { width, fontSize: 10 } : { flex: 1, fontSize: 10 }}
        value={draft ?? shown}
        onFocus={() => setDraft(shown)}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}

/**
 * A range slider with a live label, written straight through on every drag
 * step (no commit-on-release) — the old screen's `bindSlider` did the same
 * for brush/display configs that don't recompute anything expensive.
 */
export function LiveSlider({
  label,
  ariaLabel,
  value,
  min,
  max,
  step,
  digits = 2,
  onChange,
  title,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits?: number;
  onChange: (v: number) => void;
  title?: string;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const v = draft ?? value;
  return (
    <div className="sr" title={title}>
      <label>
        {label} <span>{v.toFixed(digits)}</span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        aria-label={ariaLabel}
        onChange={(e) => {
          const n = +e.target.value;
          setDraft(n);
          onChange(n);
        }}
        onPointerUp={() => setDraft(null)}
        onKeyUp={() => setDraft(null)}
      />
    </div>
  );
}

/** The old screen's `.empty` placeholder. */
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** A `.pg`/`.pgt` mini-panel inside a section — groups related controls with a title. */
export function SubPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pg">
      <div className="pgt">{title}</div>
      {children}
    </div>
  );
}
