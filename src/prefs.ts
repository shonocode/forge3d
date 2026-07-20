/**
 * Preferences persistence — tool settings survive page reloads.
 *
 * Previously only the snap config persisted; brush settings, Auto-Key,
 * viewport shading and environment reset every session, which is especially
 * painful on tablets. Saved to localStorage as one JSON blob, applied on
 * startup (after the UI is built, so the controls can be synced), and written
 * back on change (polled cheaply) + on page hide.
 */

import { state } from "./state";
import type { ViewportMode } from "./state";
import { setViewportMode } from "./viewport/shading";
import { setEnvironmentPreset } from "./viewport/environment";

const PREFS_KEY = "forge3d_prefs_v1";

interface Prefs {
  sculpt: typeof state.sculptConfig;
  paint: typeof state.paintConfig;
  weight: typeof state.weightConfig;
  autoKey: boolean;
  viewportMode?: string;
  envPreset?: string;
  poseRotationSpace?: "local" | "world";
  onionSkin?: { enabled: boolean; offset: number };
}

function collectPrefs(): Prefs {
  const shadeBtn = document.querySelector<HTMLElement>(".shade-btn.on");
  const envSel = document.getElementById("envPreset") as HTMLSelectElement | null;
  return {
    sculpt: { ...state.sculptConfig },
    paint: { ...state.paintConfig },
    weight: { ...state.weightConfig },
    autoKey: state.autoKey,
    poseRotationSpace: state.poseRotationSpace,
    onionSkin: { ...state.onionSkin },
    ...(shadeBtn?.dataset.mode ? { viewportMode: shadeBtn.dataset.mode } : {}),
    ...(envSel?.value ? { envPreset: envSel.value } : {}),
  };
}

function applyPrefs(p: Prefs): void {
  if (p.sculpt) Object.assign(state.sculptConfig, p.sculpt);
  if (p.paint) Object.assign(state.paintConfig, p.paint);
  if (p.weight) Object.assign(state.weightConfig, p.weight);
  if (typeof p.autoKey === "boolean") state.autoKey = p.autoKey;
  if (p.poseRotationSpace === "local" || p.poseRotationSpace === "world") {
    state.poseRotationSpace = p.poseRotationSpace;
  }
  if (p.onionSkin && typeof p.onionSkin.enabled === "boolean") {
    state.onionSkin.enabled = p.onionSkin.enabled;
    if (typeof p.onionSkin.offset === "number") {
      state.onionSkin.offset = Math.max(1, Math.min(20, p.onionSkin.offset));
    }
  }
  if (p.viewportMode) {
    try {
      setViewportMode(p.viewportMode as ViewportMode);
      document.querySelectorAll<HTMLElement>(".shade-btn").forEach((b) =>
        b.classList.toggle("on", b.dataset.mode === p.viewportMode),
      );
    } catch { /* mode may not exist in a newer build */ }
  }
  if (p.envPreset) {
    const envSel = document.getElementById("envPreset") as HTMLSelectElement | null;
    if (envSel && [...envSel.options].some((o) => o.value === p.envPreset)) {
      envSel.value = p.envPreset;
      try { setEnvironmentPreset(p.envPreset); } catch { /* keep default env */ }
    }
  }
  syncControls();
}

/** Push restored state values back into the DOM controls. */
function syncControls(): void {
  const num = (id: string, v: number, dispId?: string, digits?: number) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = String(v);
    if (dispId) {
      const d = document.getElementById(dispId);
      if (d) d.textContent = digits !== undefined ? v.toFixed(digits) : String(v);
    }
  };
  const chk = (id: string, v: boolean) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.checked = v;
  };

  const s = state.sculptConfig;
  num("brushSize", s.radius, "bsV");
  num("brushStr", s.strength, "btV");
  num("brushFall", s.falloff, "bfV");
  chk("dyntopo", s.dyntopo);
  num("dyntopoDetail", s.detail, "dtV", 2);
  chk("symX", s.symX);
  chk("symY", s.symY);
  chk("symZ", s.symZ);

  const p = state.paintConfig;
  const color = document.getElementById("paintColor") as HTMLInputElement | null;
  if (color) color.value = p.color;
  num("paintSize", p.size, "psV");
  num("paintOpacity", p.opacity, "poV", 2);
  num("paintHardness", p.hardness ?? 0.7, "phV", 2);
  chk("paintEraser", p.eraser);
  const res = document.getElementById("paintRes") as HTMLSelectElement | null;
  if (res) res.value = String(p.resolution ?? 1024);
  const pch = document.getElementById("paintChannel") as HTMLSelectElement | null;
  if (pch) pch.value = p.channel ?? "albedo";

  const wcfg = state.weightConfig;
  num("weightRadius", wcfg.radius, "wrV");
  num("weightStr", wcfg.strength, "wsV");
  num("weightFall", wcfg.falloff, "wfV");

  chk("autoKey", state.autoKey);
  chk("poseLocalAxes", state.poseRotationSpace === "local");
  chk("onionSkin", state.onionSkin.enabled);
  num("onionOffset", state.onionSkin.offset, "onionOffV");
}

function save(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(collectPrefs()));
  } catch { /* storage full / private mode — non-fatal */ }
}

/**
 * Restore saved prefs and start persisting changes. Call once at startup,
 * AFTER the UI is built and the viewport is initialized (both the DOM
 * controls and the scene must exist for apply/sync to land).
 */
export function initPrefs(): void {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) applyPrefs(JSON.parse(raw) as Prefs);
  } catch { /* corrupt blob — ignore, defaults win */ }

  let last = JSON.stringify(collectPrefs());
  setInterval(() => {
    const cur = JSON.stringify(collectPrefs());
    if (cur !== last) {
      last = cur;
      try { localStorage.setItem(PREFS_KEY, cur); } catch { /* ignore */ }
    }
  }, 3000);
  window.addEventListener("pagehide", save);
}
