/**
 * Preferences persistence — tool settings survive page reloads.
 *
 * Previously only the snap config persisted; brush settings, Auto-Key,
 * viewport shading and environment reset every session, which is especially
 * painful on tablets. Saved to localStorage as one JSON blob, applied on
 * startup, and written back on change (polled cheaply) + on page hide.
 */

import { state } from "./state";
import type { ViewportMode } from "./state";
import { setViewportMode } from "./viewport/shading";
import { ENV_PRESETS, setEnvironmentPreset } from "./viewport/environment";
import { store } from "./store";

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
  return {
    sculpt: { ...state.sculptConfig },
    paint: { ...state.paintConfig },
    weight: { ...state.weightConfig },
    autoKey: state.autoKey,
    poseRotationSpace: state.poseRotationSpace,
    onionSkin: { ...state.onionSkin },
    viewportMode: state.viewportMode,
    ...(state.activeEnvPresetId ? { envPreset: state.activeEnvPresetId } : {}),
  };
}

/**
 * Apply saved prefs to the state. Everything is read from and written to
 * `state` — the screen (React, ADR-014) draws from it; until 2026-09-25 this
 * read two values off the old screen's DOM and pushed the rest back into its
 * controls by id.
 */
function applyPrefs(p: Prefs): void {
  if (p.sculpt) Object.assign(state.sculptConfig, p.sculpt);
  if (p.paint) Object.assign(state.paintConfig, p.paint);
  if (p.weight) Object.assign(state.weightConfig, p.weight);
  // The brush image itself isn't persisted — always come back in round mode
  // so a stale stamp / stencil pref can't silently paint with no image.
  state.paintConfig.brushMode = "round";
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
    try { setViewportMode(p.viewportMode as ViewportMode); } catch { /* mode may not exist in a newer build */ }
  }
  if (p.envPreset && ENV_PRESETS.some((e) => e.id === p.envPreset)) {
    try { setEnvironmentPreset(p.envPreset); } catch { /* keep default env */ }
  }
  store.notify();
}

function save(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(collectPrefs()));
  } catch { /* storage full / private mode — non-fatal */ }
}

/**
 * Restore saved prefs and start persisting changes. Call once at startup,
 * after the viewport is initialized (the scene must exist for the shading
 * and environment to land).
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
