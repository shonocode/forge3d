import { state, E, status } from "../state";
import type { AnimChannel, BoneTrack, KeyframeData, MorphKeyframe, MorphTrack } from "../state";
import { getActiveClip, interpolateTrack, scrubToFrame } from "./animation-tool";
import { autoTangentsFor } from "./bezier";
import { evalMorphTrack } from "./morph-track";

// ── Graph Editor (V2 — Bezier handle editing) ─────────────────
//
// Visualizes the currently selected bone's animation curves and lets
// the user edit per-channel cubic Bezier tangents by dragging handle
// dots. Falls back to the easing-driven straight-line interpolation
// for keys without tangents, preserving V1 behavior for un-converted
// clips.
//
// Layout per visible channel:
//
//       ●─────●                  ●            ●─────●
//      /       \                /│\          /
//     ◆         \              ◆ │ ◆        ◆           ◆
//      \         \              \│/                      \
//       \         ●─────●        ●          ●─────────────●
//
//   ◆ = keyframe         ● = tangent handle endpoint
//
// Hit zones (canvas-space, in priority order — checked top to bottom
// on pointerdown):
//   1. Handle endpoints (drag → edit tangent for that channel/end)
//   2. Keyframe centers (drag → move the key in time AND value on that
//      channel; one undo entry per drag — F-M7)
//   3. Background (click → scrub to frame, V1 behavior)
//
// Convert-to-Bezier UX: the "B" button below the channel toggles
// (added by the panel) converts the keyframe at `state.currentFrame`
// (if any) to Bezier mode for every visible channel, seeding tangents
// from neighbors via `autoTangentsFor` so the curve looks identical
// before the user starts dragging.
//
// Coordinate spaces:
//   - "data space" = (frame, value). Each visible channel has its
//     own Y range; the Y axis is auto-scaled per render. The X axis
//     is shared across channels (frame).
//   - "canvas space" = (px, py). frameToPx / valueToPy convert.
//   - Tangents are stored as deltas in DATA space, not canvas, so a
//     change in zoom or value range doesn't mutate the saved data.
//
// Why two coordinate spaces matter for drag: we get pointer events in
// canvas space, but tangents live in data space. The conversion is
// non-trivial because the Y range depends on which channels are
// visible (the channel being dragged is always in range by construction,
// so it's safe to use the cached `lo`/`hi` from the last render).

interface Channel {
  id: AnimChannel;
  label: string;
  color: string;
  pick: (kf: KeyframeData) => number;
  /** Write a new value into the keyframe for this channel. Used when
   *  drag-to-edit is added in a later iteration; unused now but
   *  centralized to avoid touching every call site later. */
  set: (kf: KeyframeData, value: number) => void;
}

const CHANNELS: readonly Channel[] = [
  { id: "px", label: "Pos X", color: "#e74c3c", pick: (k) => k.position.x, set: (k, v) => { k.position.x = v; } },
  { id: "py", label: "Pos Y", color: "#2ecc71", pick: (k) => k.position.y, set: (k, v) => { k.position.y = v; } },
  { id: "pz", label: "Pos Z", color: "#3498db", pick: (k) => k.position.z, set: (k, v) => { k.position.z = v; } },
  { id: "rx", label: "Rot X", color: "#ff9999", pick: (k) => k.rotation.x, set: (k, v) => { k.rotation.x = v; } },
  { id: "ry", label: "Rot Y", color: "#99ff99", pick: (k) => k.rotation.y, set: (k, v) => { k.rotation.y = v; } },
  { id: "rz", label: "Rot Z", color: "#99ccff", pick: (k) => k.rotation.z, set: (k, v) => { k.rotation.z = v; } },
];

const _visibleChannels = new Set<AnimChannel>(["rx", "ry", "rz"]);

let _canvas: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;
let _channelBar: HTMLElement | null = null;
let _infoEl: HTMLElement | null = null;

/**
 * Cached render-space metadata used by the click + drag handlers.
 * Rebuilt every render so hit-testing always reflects what's on
 * screen even after zoom / clip / channel toggle changes.
 */
interface HandleHit {
  /** Keyframe being edited */
  kf: KeyframeData;
  /** Which channel the tangent belongs to */
  channel: AnimChannel;
  /** "in" or "out" side of the keyframe */
  side: "in" | "out";
  /** Pixel position of the handle endpoint (for hit testing) */
  px: number;
  py: number;
}
let _handleHits: HandleHit[] = [];

/** Keyframe-dot hit target (kept separate from handles — lower priority). */
interface KeyHit {
  kf: KeyframeData;
  channel: AnimChannel;
  px: number;
  py: number;
}
let _keyHits: KeyHit[] = [];

/**
 * Multi-selection of key dots as (keyframe, channel) pairs (F-M7 拡張).
 * Shift+click toggles membership; dragging any selected dot moves the
 * whole set rigidly (shared Δframe, shared Δvalue per pair's channel).
 * Cleared whenever a track snapshot is restored (undo/redo) because the
 * keyframe object identities change.
 */
let _selectedPairs = new Map<KeyframeData, Set<AnimChannel>>();

function isPairSelected(kf: KeyframeData, ch: AnimChannel): boolean {
  return _selectedPairs.get(kf)?.has(ch) ?? false;
}

function togglePair(kf: KeyframeData, ch: AnimChannel): void {
  let set = _selectedPairs.get(kf);
  if (set?.has(ch)) {
    set.delete(ch);
    if (set.size === 0) _selectedPairs.delete(kf);
  } else {
    if (!set) { set = new Set(); _selectedPairs.set(kf, set); }
    set.add(ch);
  }
}

function selectedPairCount(): number {
  let n = 0;
  for (const set of _selectedPairs.values()) n += set.size;
  return n;
}

/**
 * In-progress keyframe drag (time + value). `offsetFrame`/`offsetValue`
 * are the pointer's initial data-space offset from the key, so the key
 * follows the pointer without an initial jump when grabbed off-center.
 * `frames0` / `values0` snapshot every selected pair at drag start so the
 * rigid move is re-derived from a stable baseline each tick.
 */
let _dragKey: {
  kf: KeyframeData;
  channel: AnimChannel;
  track: BoneTrack;
  before: KeyframeData[];
  moved: boolean;
  offsetFrame: number;
  offsetValue: number;
  frames0: Map<KeyframeData, number>;
  values0: Map<KeyframeData, Map<AnimChannel, number>>;
} | null = null;

/**
 * Hook fired after a key drag lands (or is undone) so the UI layer can
 * refresh the keyframe list + dopesheet. Registered from bindings to
 * avoid an import cycle with panels.ts / dopesheet.ts.
 */
let _keyEditedHandler: (() => void) | null = null;

/** Register the callback fired after a graph-editor key edit lands. */
export function setKeyEditedHandler(fn: () => void): void {
  _keyEditedHandler = fn;
}

/**
 * Cached data → canvas mapping from the last render, used to convert
 * pixel deltas into data-space deltas during drag without re-deriving
 * the Y range.
 */
let _lastMapping: { w: number; h: number; lo: number; hi: number; maxFrames: number } | null = null;

/** Currently dragged handle, or null if no drag in progress. */
let _dragging: HandleHit | null = null;

// ── Morph curve mode (F-M5 拡張) ──
//
// The "Morphs" toolbar toggle flips the editor from the selected bone's
// channels to the active clip's morph influence curves (fixed 0–1 axis,
// teal palette — matching the dopesheet's morph lanes). Keys drag in time
// and value (clamped to [0,1]); tangents don't apply (morph keys are
// easing-interpolated only).
let _morphMode = false;

interface MorphKeyHit {
  track: MorphTrack;
  kf: MorphKeyframe;
  px: number;
  py: number;
}
let _morphKeyHits: MorphKeyHit[] = [];

/** Tangent-handle hit target for morph keys (Bezier 補間, F-M5 拡張). */
interface MorphHandleHit {
  kf: MorphKeyframe;
  side: "in" | "out";
  px: number;
  py: number;
}
let _morphHandleHits: MorphHandleHit[] = [];
let _dragMorphHandle: MorphHandleHit | null = null;

let _dragMorph: {
  track: MorphTrack;
  kf: MorphKeyframe;
  before: MorphKeyframe[];
  moved: boolean;
  offsetFrame: number;
  offsetValue: number;
} | null = null;

/** Teal shades keyed by track index — same family as the dopesheet lanes. */
function morphColor(i: number): string {
  const l = 45 + ((i * 12) % 30);
  return `hsl(172, 65%, ${l}%)`;
}

const HIT_RADIUS = 6;
const HANDLE_DOT_RADIUS = 3;

export function initGraphEditor(): void {
  if (_canvas) return;

  _canvas = E("graphCanvas") as HTMLCanvasElement;
  _ctx = _canvas.getContext("2d");
  _channelBar = E("graphChannels");
  _infoEl = E("graphInfo");

  if (_channelBar) {
    _channelBar.innerHTML = "";
    for (const ch of CHANNELS) {
      const btn = document.createElement("button");
      btn.className = "abtn" + (_visibleChannels.has(ch.id) ? " on" : "");
      btn.style.cssText = `font-size:9px;padding:1px 6px;border-left:3px solid ${ch.color}`;
      btn.textContent = ch.label;
      btn.dataset.ch = ch.id;
      btn.addEventListener("click", () => {
        if (_visibleChannels.has(ch.id)) {
          _visibleChannels.delete(ch.id);
          btn.classList.remove("on");
        } else {
          _visibleChannels.add(ch.id);
          btn.classList.add("on");
        }
        drawGraphEditor();
      });
      _channelBar.appendChild(btn);
    }

    // Morph curve mode toggle — teal to match the dopesheet's morph lanes.
    const morphBtn = document.createElement("button");
    morphBtn.className = "abtn";
    morphBtn.style.cssText = "font-size:9px;padding:1px 6px;border-left:3px solid hsl(172,65%,50%)";
    morphBtn.textContent = "Morphs";
    morphBtn.title = "モーフ (表情) の influence カーブを表示・編集";
    morphBtn.addEventListener("click", () => {
      _morphMode = !_morphMode;
      morphBtn.classList.toggle("on", _morphMode);
      drawGraphEditor();
    });
    _channelBar.appendChild(morphBtn);

    // "Convert to Bezier" button — appended after channel toggles.
    // Lives in the same toolbar to keep the curve-editing affordances
    // visually grouped (channel selection + curve-mode in one row).
    const bezBtn = document.createElement("button");
    bezBtn.className = "abtn";
    bezBtn.style.cssText = "font-size:9px;padding:1px 6px;margin-left:auto";
    bezBtn.textContent = "→ Bezier";
    bezBtn.title = "Convert the current-frame keyframe to Bezier on all visible channels";
    bezBtn.addEventListener("click", () => convertCurrentKeyframeToBezier());
    _channelBar.appendChild(bezBtn);
  }

  // Pointer events — pointerdown decides whether this is a handle
  // drag (high-priority hit) or a scrub click (background). The
  // distinction matters because clicks while over a handle should NOT
  // scrub the playhead; that would yank the timeline mid-edit.
  _canvas.addEventListener("pointerdown", onPointerDown);
  _canvas.addEventListener("pointermove", onPointerMove);
  _canvas.addEventListener("pointerup", onPointerUp);
  _canvas.addEventListener("pointercancel", onPointerUp);
}

export function drawGraphEditor(): void {
  if (!_canvas || !_ctx) return;

  const rect = _canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  if (_canvas.width !== w) _canvas.width = w;
  if (_canvas.height !== h) _canvas.height = h;

  const ctx = _ctx;
  ctx.clearRect(0, 0, w, h);
  _handleHits = [];
  _keyHits = [];

  const clip = getActiveClip();
  if (!clip) {
    drawEmptyMessage(ctx, w, h, "アクティブなクリップがありません");
    updateInfo("クリップを作成してください");
    _lastMapping = null;
    return;
  }

  if (_morphMode) {
    drawMorphGraph(ctx, w, h, clip.maxFrames, clip.morphTracks ?? []);
    return;
  }

  const track = state.selectedBoneId
    ? clip.tracks.find((t) => t.boneId === state.selectedBoneId) ?? null
    : null;

  drawGrid(ctx, w, h, clip.maxFrames);

  if (!track || track.keyframes.length === 0) {
    drawEmptyMessage(ctx, w, h, track ? "キーフレームなし" : "ボーンを選択");
    drawCurrentFrameLine(ctx, w, h, state.currentFrame, clip.maxFrames);
    updateInfo(`Frame ${state.currentFrame} / ${clip.maxFrames}`);
    _lastMapping = null;
    return;
  }

  const { yMin, yMax } = computeYRange(track);
  const yPad = (yMax - yMin) * 0.1 || 0.1;
  const lo = yMin - yPad;
  const hi = yMax + yPad;

  _lastMapping = { w, h, lo, hi, maxFrames: clip.maxFrames };

  // Curves — sample per pixel column. Bezier interpolation in
  // `interpolateTrack` makes this dynamic at zero cost to the caller.
  for (const ch of CHANNELS) {
    if (!_visibleChannels.has(ch.id)) continue;
    ctx.strokeStyle = ch.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let first = true;
    for (let px = 0; px < w; px++) {
      const frame = (px / w) * clip.maxFrames;
      const sample = interpolateTrack(track, frame);
      if (!sample) continue;
      const v = ch.pick(sample);
      const py = mapY(v, lo, hi, h);
      if (first) { ctx.moveTo(px, py); first = false; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Keyframe dots + handle lines for any key that has tangents on
    // this channel. Handles render *over* the curve so they're
    // clickable; their dots come last so the keyframe diamond doesn't
    // hide them.
    for (const kf of track.keyframes) {
      const kx = frameToPx(kf.frame, w, clip.maxFrames);
      const ky = mapY(ch.pick(kf), lo, hi, h);

      const tan = kf.tangents?.[ch.id];
      if (tan) {
        // In handle (typically left of key)
        const ihx = frameToPx(kf.frame + tan.in[0], w, clip.maxFrames);
        const ihy = mapY(ch.pick(kf) + tan.in[1], lo, hi, h);
        drawHandle(ctx, ch.color, kx, ky, ihx, ihy);
        _handleHits.push({ kf, channel: ch.id, side: "in", px: ihx, py: ihy });

        // Out handle (typically right of key)
        const ohx = frameToPx(kf.frame + tan.out[0], w, clip.maxFrames);
        const ohy = mapY(ch.pick(kf) + tan.out[1], lo, hi, h);
        drawHandle(ctx, ch.color, kx, ky, ohx, ohy);
        _handleHits.push({ kf, channel: ch.id, side: "out", px: ohx, py: ohy });
      }

      const isDragged = _dragKey?.kf === kf && _dragKey.channel === ch.id;
      const isSelected = isPairSelected(kf, ch.id);
      ctx.fillStyle = ch.color;
      ctx.beginPath();
      ctx.arc(kx, ky, isDragged || isSelected ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (isDragged || isSelected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      _keyHits.push({ kf, channel: ch.id, px: kx, py: ky });
    }
  }

  drawCurrentFrameLine(ctx, w, h, state.currentFrame, clip.maxFrames);

  const beziKeys = track.keyframes.filter((k) => k.tangents).length;
  updateInfo(`Frame ${state.currentFrame} / ${clip.maxFrames}  ·  ${track.keyframes.length} keys (${beziKeys} bezier)  ·  Y: ${lo.toFixed(2)}…${hi.toFixed(2)}`);
}

/** Render the morph-mode view: every morph track's 0–1 influence curve. */
function drawMorphGraph(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  maxFrames: number,
  tracks: readonly MorphTrack[],
): void {
  _morphKeyHits = [];
  _morphHandleHits = [];
  drawGrid(ctx, w, h, maxFrames);

  const lo = -0.08;
  const hi = 1.08;
  _lastMapping = { w, h, lo, hi, maxFrames };

  if (tracks.length === 0) {
    drawEmptyMessage(ctx, w, h, "モーフキーがありません (Record Morphs で作成)");
    drawCurrentFrameLine(ctx, w, h, state.currentFrame, maxFrames);
    updateInfo(`Morphs: 0 tracks · Frame ${state.currentFrame}/${maxFrames}`);
    return;
  }

  // 0 / 1 guide lines for the influence range.
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  for (const v of [0, 1]) {
    const py = Math.floor(mapY(v, lo, hi, h)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
    ctx.stroke();
  }

  let totalKeys = 0;
  tracks.forEach((track, i) => {
    if (track.keyframes.length === 0) return;
    totalKeys += track.keyframes.length;
    const color = morphColor(i);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let first = true;
    for (let px = 0; px < w; px++) {
      const v = evalMorphTrack(track, (px / w) * maxFrames);
      if (v === null) continue;
      const py = mapY(v, lo, hi, h);
      if (first) { ctx.moveTo(px, py); first = false; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    for (const kf of track.keyframes) {
      const kx = frameToPx(kf.frame, w, maxFrames);
      const ky = mapY(kf.value, lo, hi, h);

      if (kf.tangents) {
        const ihx = frameToPx(kf.frame + kf.tangents.in[0], w, maxFrames);
        const ihy = mapY(kf.value + kf.tangents.in[1], lo, hi, h);
        drawHandle(ctx, color, kx, ky, ihx, ihy);
        _morphHandleHits.push({ kf, side: "in", px: ihx, py: ihy });
        const ohx = frameToPx(kf.frame + kf.tangents.out[0], w, maxFrames);
        const ohy = mapY(kf.value + kf.tangents.out[1], lo, hi, h);
        drawHandle(ctx, color, kx, ky, ohx, ohy);
        _morphHandleHits.push({ kf, side: "out", px: ohx, py: ohy });
      }

      const isDragged = _dragMorph?.kf === kf;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(kx, ky, isDragged ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (isDragged) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      _morphKeyHits.push({ track, kf, px: kx, py: ky });
    }
  });

  drawCurrentFrameLine(ctx, w, h, state.currentFrame, maxFrames);
  updateInfo(`Morphs: ${tracks.length} tracks · ${totalKeys} keys · Frame ${state.currentFrame}/${maxFrames}`);
}

// ── Convert-to-Bezier ──

/**
 * Promote the keyframe at the current frame (if any) to Bezier mode
 * for every visible channel. Tangents are seeded via
 * `autoTangentsFor` so the visual curve doesn't jump on conversion —
 * the user gets a smooth handle to start dragging from.
 *
 * Only the keyframe whose `frame === state.currentFrame` is touched.
 * If no key sits at the playhead, status-bar feedback explains why.
 */
function convertCurrentKeyframeToBezier(): void {
  const clip = getActiveClip();
  if (!clip) { status("⚠ クリップがありません"); return; }
  if (_morphMode) {
    convertCurrentMorphKeysToBezier(clip.morphTracks ?? []);
    return;
  }
  if (!state.selectedBoneId) { status("⚠ ボーンを選択してください"); return; }
  const track = clip.tracks.find((t) => t.boneId === state.selectedBoneId);
  if (!track) { status("⚠ このボーンのトラックがありません"); return; }

  const kfIdx = track.keyframes.findIndex((k) => k.frame === state.currentFrame);
  if (kfIdx < 0) {
    status("⚠ 現在フレームにキーがありません(先にキーを打ってください)");
    return;
  }
  const kf = track.keyframes[kfIdx]!;
  const prev = kfIdx > 0 ? track.keyframes[kfIdx - 1]! : null;
  const next = kfIdx + 1 < track.keyframes.length ? track.keyframes[kfIdx + 1]! : null;

  if (!kf.tangents) kf.tangents = {};
  let converted = 0;
  for (const ch of CHANNELS) {
    if (!_visibleChannels.has(ch.id)) continue;
    if (kf.tangents[ch.id]) continue; // skip already-bezier
    kf.tangents[ch.id] = autoTangentsFor(
      prev ? prev.frame : null,
      prev ? ch.pick(prev) : 0,
      kf.frame,
      ch.pick(kf),
      next ? next.frame : null,
      next ? ch.pick(next) : 0,
    );
    converted++;
  }
  if (converted === 0) {
    status("既に全チャンネル Bezier 化されています");
  } else {
    status(`Bezier 化: ${converted} チャンネル @ frame ${state.currentFrame}`);
  }
  drawGraphEditor();
}

/**
 * Morph-mode "→ Bezier": promote every morph key sitting at the playhead
 * to Bezier, seeding tangents from its neighbors so the curve doesn't jump.
 */
function convertCurrentMorphKeysToBezier(tracks: readonly MorphTrack[]): void {
  let converted = 0;
  for (const track of tracks) {
    const idx = track.keyframes.findIndex((k) => k.frame === state.currentFrame);
    if (idx < 0) continue;
    const kf = track.keyframes[idx]!;
    if (kf.tangents) continue;
    const prev = idx > 0 ? track.keyframes[idx - 1]! : null;
    const next = idx + 1 < track.keyframes.length ? track.keyframes[idx + 1]! : null;
    kf.tangents = autoTangentsFor(
      prev ? prev.frame : null,
      prev ? prev.value : 0,
      kf.frame,
      kf.value,
      next ? next.frame : null,
      next ? next.value : 0,
    );
    converted++;
  }
  status(converted > 0
    ? `Bezier 化: ${converted} モーフキー @ frame ${state.currentFrame}`
    : "⚠ 現在フレームに未変換のモーフキーがありません");
  drawGraphEditor();
}

// ── Pointer interaction ──

function onPointerDown(e: PointerEvent): void {
  if (!_canvas) return;
  const rect = _canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (_morphMode) {
    onMorphPointerDown(e, x, y, rect.width);
    return;
  }

  // Handle hit-test first — handles are visually small but high-
  // priority targets. We pick the closest handle within the radius
  // rather than the first match so users can reliably grab the right
  // handle even when two channels' handles overlap.
  let best: { hit: HandleHit; distSq: number } | null = null;
  for (const h of _handleHits) {
    const dx = h.px - x, dy = h.py - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= HIT_RADIUS * HIT_RADIUS && (!best || d2 < best.distSq)) {
      best = { hit: h, distSq: d2 };
    }
  }

  if (best) {
    _dragging = best.hit;
    _canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  const clip = getActiveClip();
  if (!clip) return;

  // Keyframe-dot hit-test — same closest-within-radius policy as the
  // handles so overlapping channels' keys stay individually grabbable.
  let bestKey: { hit: KeyHit; distSq: number } | null = null;
  for (const k of _keyHits) {
    const dx = k.px - x, dy = k.py - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= HIT_RADIUS * HIT_RADIUS && (!bestKey || d2 < bestKey.distSq)) {
      bestKey = { hit: k, distSq: d2 };
    }
  }

  if (bestKey && _lastMapping && state.selectedBoneId) {
    const track = clip.tracks.find((t) => t.boneId === state.selectedBoneId);
    if (track) {
      if (e.shiftKey) {
        // Shift+click: toggle this dot in the multi-selection, no drag.
        togglePair(bestKey.hit.kf, bestKey.hit.channel);
        drawGraphEditor();
        e.preventDefault();
        return;
      }
      // Plain press: an unselected dot becomes the sole selection; a
      // selected dot keeps the set (the drag moves them all rigidly).
      if (!isPairSelected(bestKey.hit.kf, bestKey.hit.channel)) {
        _selectedPairs = new Map([[bestKey.hit.kf, new Set([bestKey.hit.channel])]]);
      }
      const { w, h, lo, hi, maxFrames } = _lastMapping;
      const ch = CHANNELS.find((c) => c.id === bestKey.hit.channel)!;
      const frameAtX = (x / w) * maxFrames;
      const valueAtY = lo + (1 - y / h) * (hi - lo);
      const frames0 = new Map<KeyframeData, number>();
      const values0 = new Map<KeyframeData, Map<AnimChannel, number>>();
      for (const [kf, chans] of _selectedPairs) {
        frames0.set(kf, kf.frame);
        const vals = new Map<AnimChannel, number>();
        for (const c of chans) vals.set(c, CHANNELS.find((cc) => cc.id === c)!.pick(kf));
        values0.set(kf, vals);
      }
      _dragKey = {
        kf: bestKey.hit.kf,
        channel: bestKey.hit.channel,
        track,
        before: structuredClone(track.keyframes),
        moved: false,
        offsetFrame: frameAtX - bestKey.hit.kf.frame,
        offsetValue: valueAtY - ch.pick(bestKey.hit.kf),
        frames0,
        values0,
      };
      _canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
  }

  // Background → clear the multi-selection, then V1 scrub behavior.
  _selectedPairs = new Map();
  const frame = Math.round((x / rect.width) * clip.maxFrames);
  scrubToFrame(Math.max(0, Math.min(clip.maxFrames, frame)));
  drawGraphEditor();
}

function onPointerMove(e: PointerEvent): void {
  if (_dragMorphHandle) { onMorphHandleDragMove(e); return; }
  if (_dragMorph) { onMorphDragMove(e); return; }
  if (_dragKey) { onKeyDragMove(e); return; }
  if (!_dragging || !_canvas || !_lastMapping) return;
  const rect = _canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const { w, h, lo, hi, maxFrames } = _lastMapping;

  // Convert pointer position into data-space delta from the keyframe
  // (since tangents are stored as deltas, not absolute positions).
  const frameAtX = (x / w) * maxFrames;
  const valueAtY = lo + (1 - y / h) * (hi - lo);

  const ch = CHANNELS.find((c) => c.id === _dragging!.channel)!;
  const kfValue = ch.pick(_dragging.kf);
  let dx = frameAtX - _dragging.kf.frame;
  let dy = valueAtY - kfValue;

  // Clamp to half the segment width on the appropriate side. This
  // prevents the in-handle from crossing past the previous key (or
  // out-handle past the next key), which would fold the X-cubic and
  // break monotonicity in `interpolateTrack`. We don't enforce
  // strict ≤ 1.0 like Blender's "auto-clamped" mode because the user
  // may legitimately want gentle overshoots, but we DO keep the
  // handle on the right side of the key.
  if (_dragging.side === "in" && dx > 0) dx = 0;
  if (_dragging.side === "out" && dx < 0) dx = 0;

  const tangents = _dragging.kf.tangents!;
  const tan = tangents[_dragging.channel]!;
  if (_dragging.side === "in") tan.in = [dx, dy];
  else tan.out = [dx, dy];

  drawGraphEditor();
}

function onPointerUp(e: PointerEvent): void {
  if ((_dragging || _dragKey || _dragMorph || _dragMorphHandle) && _canvas) {
    try { _canvas.releasePointerCapture(e.pointerId); } catch { /* may not own */ }
  }
  _dragging = null;

  if (_dragMorphHandle) {
    _dragMorphHandle = null;
    // Re-pose with the reshaped curve (the handle drag itself has no undo,
    // matching bone tangent edits).
    scrubToFrame(state.currentFrame);
    drawGraphEditor();
    return;
  }

  if (_dragMorph) {
    const drag = _dragMorph;
    _dragMorph = null;
    if (drag.moved) commitMorphDrag(drag);
    else drawGraphEditor();
    return;
  }

  if (_dragKey) {
    const drag = _dragKey;
    _dragKey = null;
    if (drag.moved) commitKeyDrag(drag);
    else drawGraphEditor(); // plain click on a key — just clear the highlight
  }
}

// ── Morph-mode pointer handlers ──

function onMorphPointerDown(e: PointerEvent, x: number, y: number, rectW: number): void {
  if (!_canvas || !_lastMapping) return;
  const clip = getActiveClip();
  if (!clip) return;

  // Tangent handles take priority over key dots (same order as bone mode).
  let bestHandle: { hit: MorphHandleHit; distSq: number } | null = null;
  for (const hh of _morphHandleHits) {
    const dx = hh.px - x, dy = hh.py - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= HIT_RADIUS * HIT_RADIUS && (!bestHandle || d2 < bestHandle.distSq)) {
      bestHandle = { hit: hh, distSq: d2 };
    }
  }
  if (bestHandle) {
    _dragMorphHandle = bestHandle.hit;
    _canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  let best: { hit: MorphKeyHit; distSq: number } | null = null;
  for (const k of _morphKeyHits) {
    const dx = k.px - x, dy = k.py - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= HIT_RADIUS * HIT_RADIUS && (!best || d2 < best.distSq)) {
      best = { hit: k, distSq: d2 };
    }
  }
  if (best) {
    const { w, h, lo, hi, maxFrames } = _lastMapping;
    const frameAtX = (x / w) * maxFrames;
    const valueAtY = lo + (1 - y / h) * (hi - lo);
    _dragMorph = {
      track: best.hit.track,
      kf: best.hit.kf,
      before: structuredClone(best.hit.track.keyframes),
      moved: false,
      offsetFrame: frameAtX - best.hit.kf.frame,
      offsetValue: valueAtY - best.hit.kf.value,
    };
    _canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  const frame = Math.round((x / rectW) * clip.maxFrames);
  scrubToFrame(Math.max(0, Math.min(clip.maxFrames, frame)));
  drawGraphEditor();
}

/** Live tangent edit of the grabbed morph handle (data-space deltas). */
function onMorphHandleDragMove(e: PointerEvent): void {
  if (!_dragMorphHandle || !_canvas || !_lastMapping) return;
  const rect = _canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const { w, h, lo, hi, maxFrames } = _lastMapping;

  const d = _dragMorphHandle;
  const frameAtX = (x / w) * maxFrames;
  const valueAtY = lo + (1 - y / h) * (hi - lo);
  let dx = frameAtX - d.kf.frame;
  const dy = valueAtY - d.kf.value;
  // Keep each handle on its own side of the key (prevents X-fold, same
  // rule as bone channels).
  if (d.side === "in" && dx > 0) dx = 0;
  if (d.side === "out" && dx < 0) dx = 0;

  const tan = d.kf.tangents!;
  if (d.side === "in") tan.in = [dx, dy];
  else tan.out = [dx, dy];
  drawGraphEditor();
}

/** Live time+value move of the grabbed morph key (value clamped to [0,1]). */
function onMorphDragMove(e: PointerEvent): void {
  if (!_dragMorph || !_canvas || !_lastMapping) return;
  const drag = _dragMorph;
  const rect = _canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const { w, h, lo, hi, maxFrames } = _lastMapping;

  const targetFrame = Math.round((x / w) * maxFrames - drag.offsetFrame);
  const clamped = Math.max(0, Math.min(maxFrames, targetFrame));
  // Same free-slot rule as bone keys: time moves only onto empty frames.
  if (clamped !== drag.kf.frame && !drag.track.keyframes.some((k) => k !== drag.kf && k.frame === clamped)) {
    drag.kf.frame = clamped;
    drag.track.keyframes.sort((a, b) => a.frame - b.frame);
  }

  const valueAtY = lo + (1 - y / h) * (hi - lo);
  drag.kf.value = Math.max(0, Math.min(1, valueAtY - drag.offsetValue));

  drag.moved = true;
  drawGraphEditor();
}

/** One undo per finished morph-key drag; re-poses the frame + refreshes UI. */
function commitMorphDrag(drag: NonNullable<typeof _dragMorph>): void {
  const track = drag.track;
  const after = structuredClone(track.keyframes);
  const before = drag.before;

  const restore = (snap: MorphKeyframe[]): void => {
    track.keyframes.splice(0, track.keyframes.length, ...structuredClone(snap));
    scrubToFrame(state.currentFrame);
    drawGraphEditor();
    _keyEditedHandler?.();
  };

  state.history.push({
    label: "Edit Morph Key",
    undo() { restore(before); },
    redo() { restore(after); },
  });

  status(`Morph key → frame ${drag.kf.frame}, influence ${drag.kf.value.toFixed(2)}`);
  scrubToFrame(state.currentFrame);
  drawGraphEditor();
  _keyEditedHandler?.();
}

/**
 * Live rigid move of every selected pair (no history churn). The grabbed
 * dot defines a shared Δframe / Δvalue from its drag-start baseline; time
 * shifts apply per keyframe (all channels of a kf move together in time),
 * value shifts apply per selected (kf, channel) pair.
 */
function onKeyDragMove(e: PointerEvent): void {
  if (!_dragKey || !_canvas || !_lastMapping) return;
  const drag = _dragKey;
  const rect = _canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const { w, h, lo, hi, maxFrames } = _lastMapping;

  const grabFrame0 = drag.frames0.get(drag.kf)!;
  const targetFrame = Math.round((x / w) * maxFrames - drag.offsetFrame);
  let deltaF = targetFrame - grabFrame0;
  // Clamp the shared delta so every selected key stays inside the clip.
  for (const f0 of drag.frames0.values()) {
    if (f0 + deltaF < 0) deltaF = -f0;
    if (f0 + deltaF > maxFrames) deltaF = maxFrames - f0;
  }
  // Move in time only when every destination frame is free of UNSELECTED
  // keys — silently overwriting a neighbor mid-drag would be surprising.
  // (Retiming with overwrite semantics lives in the dopesheet.)
  const destinations = new Set<number>();
  for (const f0 of drag.frames0.values()) destinations.add(f0 + deltaF);
  const blocked = drag.track.keyframes.some(
    (k) => !drag.frames0.has(k) && destinations.has(k.frame),
  );
  if (!blocked) {
    for (const [kf, f0] of drag.frames0) kf.frame = f0 + deltaF;
    drag.track.keyframes.sort((a, b) => a.frame - b.frame);
  }

  const valueAtY = lo + (1 - y / h) * (hi - lo);
  const grabValue0 = drag.values0.get(drag.kf)!.get(drag.channel)!;
  const deltaV = valueAtY - drag.offsetValue - grabValue0;
  for (const [kf, vals] of drag.values0) {
    for (const [chId, v0] of vals) {
      CHANNELS.find((c) => c.id === chId)!.set(kf, v0 + deltaV);
    }
  }

  drag.moved = true;
  drawGraphEditor();
}

/** Push one undo entry for a finished key drag and refresh the pose/UI. */
function commitKeyDrag(drag: NonNullable<typeof _dragKey>): void {
  const track = drag.track;
  const after = structuredClone(track.keyframes);
  const before = drag.before;

  const restore = (snap: KeyframeData[]): void => {
    track.keyframes.splice(0, track.keyframes.length, ...structuredClone(snap));
    // The clones invalidate every selected keyframe reference.
    _selectedPairs = new Map();
    scrubToFrame(state.currentFrame);
    drawGraphEditor();
    _keyEditedHandler?.();
  };

  const n = selectedPairCount();
  state.history.push({
    label: n > 1 ? `Edit Keys (${n})` : "Edit Key",
    undo() { restore(before); },
    redo() { restore(after); },
  });

  if (n > 1) {
    status(`${n} keys moved (rigid)`);
  } else {
    const ch = CHANNELS.find((c) => c.id === drag.channel)!;
    status(`Key → frame ${drag.kf.frame}, ${ch.label} ${ch.pick(drag.kf).toFixed(3)}`);
  }
  scrubToFrame(state.currentFrame);
  drawGraphEditor();
  _keyEditedHandler?.();
}

// ── Drawing primitives ─────────────────────────────────────

function drawHandle(ctx: CanvasRenderingContext2D, color: string, kx: number, ky: number, hx: number, hy: number): void {
  // Dashed connector line between key and handle endpoint, then a
  // solid dot at the endpoint. Dashed line distinguishes tangent
  // handles from the curve itself (which is solid).
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(kx, ky);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(hx, hy, HANDLE_DOT_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  // White ring so the handle reads as a discrete affordance even
  // against the curve of the same color.
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, maxFrames: number): void {
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let f = 0; f <= maxFrames; f += 10) {
    const px = Math.floor((f / maxFrames) * w) + 0.5;
    ctx.strokeStyle = f % 30 === 0 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

function drawCurrentFrameLine(ctx: CanvasRenderingContext2D, w: number, h: number, frame: number, maxFrames: number): void {
  const px = Math.floor((frame / maxFrames) * w) + 0.5;
  ctx.strokeStyle = "#ffff00";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.stroke();
}

function drawEmptyMessage(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string): void {
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(msg, w / 2, h / 2);
}

function computeYRange(track: BoneTrack): { yMin: number; yMax: number } {
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const kf of track.keyframes) {
    for (const ch of CHANNELS) {
      if (!_visibleChannels.has(ch.id)) continue;
      const v = ch.pick(kf);
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
      // Include tangent endpoints in the Y range so handles dragged
      // outside the keyframe value still stay visible. Without this
      // a tall handle would clip out of the canvas after drag.
      const tan = kf.tangents?.[ch.id];
      if (tan) {
        const inV = v + tan.in[1];
        const outV = v + tan.out[1];
        if (inV < yMin) yMin = inV;
        if (inV > yMax) yMax = inV;
        if (outV < yMin) yMin = outV;
        if (outV > yMax) yMax = outV;
      }
    }
  }
  if (!isFinite(yMin) || !isFinite(yMax)) { yMin = -1; yMax = 1; }
  if (yMin === yMax) { yMin -= 0.5; yMax += 0.5; }
  return { yMin, yMax };
}

function frameToPx(frame: number, w: number, maxFrames: number): number {
  return (frame / maxFrames) * w;
}

function mapY(value: number, lo: number, hi: number, h: number): number {
  const t = (value - lo) / (hi - lo);
  return h - t * h;
}

function updateInfo(msg: string): void {
  if (_infoEl) _infoEl.textContent = msg;
}
