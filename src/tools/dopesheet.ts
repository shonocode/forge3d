import { state, E, status } from "../state";
import type { MorphTrack, KeyframeData, MorphKeyframe } from "../state";
import { getActiveClip, scrubToFrame } from "./animation-tool";
import { selectBone, getActiveSkeleton } from "./skeleton-tool";
import { retimeKeys } from "./key-retime";
import { drawGraphEditor } from "./graph-editor";

// ── Dopesheet ────────────────────────────────────────────────
//
// Multi-row, all-bones-in-one-glance keyframe view. Complements the
// per-bone graph editor: where the graph shows *value over time* for a
// single track, the dopesheet shows *timing across all tracks* so you
// can verify limb synchronization (e.g., "fist contacts at frame 12
// while torso twists at frame 10–14").
//
// Layout:
//   ┌─────────┬───────────────────────────────────────────────┐
//   │ Bone A  │  ◆       ◆     ◆                              │
//   │ Bone B  │      ◆   ◆ ◆      ◆                           │
//   │ Bone C  │                ◆   ◆     ◆◆                   │
//   └─────────┴───────────────────────────────────────────────┘
//   (labels gutter)         (timeline canvas area)
//
// Each row corresponds to a bone with at least one keyframe in the
// active clip. Empty bones are skipped so the panel stays compact.
//
// Interactions (F-M7):
//   - Click a row's label gutter → select that bone
//   - Click a keyframe diamond → select bone + scrub to that frame,
//     and make it the (single) selected key
//   - Shift+click a diamond → toggle it in the multi-selection
//   - Drag a diamond horizontally → retime the selected keys (rigid
//     move, ghost preview while dragging, one compound undo on drop;
//     an unselected key at a destination frame is overwritten)
//   - Click empty timeline → scrub + clear the key selection
//
// Yellow vertical playhead tracks `state.currentFrame` and refreshes
// on the same hooks as the graph editor (see panels.ts / bindings.ts).

/** Pixel width of the label gutter on the left. Tuned to fit a short
 *  bone name at 9 px monospace without truncation in most cases. */
const LABEL_GUTTER = 70;

/** Vertical space per bone row. Picked to fit a diamond comfortably
 *  without forcing the panel to be huge for skeletons with many bones. */
const ROW_HEIGHT = 14;

/** Diamond half-extent in pixels — slightly larger than the graph
 *  editor's keyframe dots so they read as a distinct shape. */
const DIAMOND_R = 4;

/** Pixel slop for keyframe hit-testing. Wider than `DIAMOND_R` so
 *  touch / coarse-pointer use can reliably hit a key without precise
 *  aiming. */
const HIT_TOLERANCE = 6;

/** Pointer must travel this many px before a press becomes a drag —
 *  below it, release is treated as a click (select / scrub). */
const DRAG_THRESHOLD = 3;

let _canvas: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;
let _info: HTMLElement | null = null;

/** Cached row metadata from the last render — needed for hit-testing
 *  in the pointer handlers. Rebuilt every `drawDopesheet`. Bone rows carry a
 *  boneId; morph rows carry the track reference instead. */
interface RowHit {
  boneId: string | null;
  morphTrack: MorphTrack | null;
  y0: number;
  y1: number;
}
let _rowHits: RowHit[] = [];

/** Stable identity for a row across renders (selection bookkeeping). */
function rowKeyOf(row: RowHit): string {
  return row.boneId
    ? "b:" + row.boneId
    : "m:" + row.morphTrack!.meshUniqueId + ":" + row.morphTrack!.targetIndex;
}

/**
 * Selected keys as `"<rowKey>@<frame>"` ids. Multi-row selections are
 * allowed (Shift+click across rows) and drag moves them all rigidly.
 */
let _selectedKeys = new Set<string>();

const keyId = (rowKey: string, frame: number): string => rowKey + "@" + frame;

/** In-progress drag state (null when idle). */
let _drag: {
  rowKey: string;
  grabFrame: number;
  startX: number;
  startY: number;
  moved: boolean;
  /** Current preview delta in frames (already globally clamped). */
  delta: number;
  shift: boolean;
} | null = null;

/**
 * Hook fired after keys were retimed (drag drop / undo / redo) so the UI
 * layer can refresh the keyframe list + both timeline views. Registered
 * from bindings to avoid an import cycle with panels.ts.
 */
let _keysRetimedHandler: (() => void) | null = null;

/** Register the callback fired after a dopesheet retime lands. */
export function setKeysRetimedHandler(fn: () => void): void {
  _keysRetimedHandler = fn;
}

/**
 * One-time setup: caches DOM refs and installs the pointer handlers.
 * Idempotent.
 */
export function initDopesheet(): void {
  if (_canvas) return;
  _canvas = E("dopeCanvas") as HTMLCanvasElement;
  _ctx = _canvas.getContext("2d");
  _info = E("dopeInfo");

  _canvas.addEventListener("pointerdown", onPointerDown);
  _canvas.addEventListener("pointermove", onPointerMove);
  _canvas.addEventListener("pointerup", onPointerUp);
  _canvas.addEventListener("pointercancel", onPointerUp);
}

/**
 * Re-render the dopesheet. Cheap (no allocations in the inner loops),
 * so it's safe to call on every playback tick.
 */
export function drawDopesheet(): void {
  if (!_canvas || !_ctx) return;

  // Match backing size to CSS box every frame so the panel stays crisp
  // when the side panel resizes. Same approach as the graph editor.
  const rect = _canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  if (_canvas.width !== w) _canvas.width = w;
  if (_canvas.height !== h) _canvas.height = h;

  const ctx = _ctx;
  ctx.clearRect(0, 0, w, h);
  _rowHits = [];

  const clip = getActiveClip();
  if (!clip) { drawEmpty(ctx, w, h, "アクティブなクリップがありません"); return; }

  // Bone display order: walk the active skeleton's bones array so the
  // dopesheet order matches the Bone Hierarchy panel. This makes the
  // "row above me" mental model match across the two panels. Bones
  // without keyframes in this clip are still shown (so the user can
  // tell *which* bones haven't been keyed yet).
  const skel = getActiveSkeleton();
  const morphTracks = clip.morphTracks ?? [];
  const boneRows = skel ? skel.bones : [];
  if (boneRows.length === 0 && morphTracks.length === 0) {
    drawEmpty(ctx, w, h, "ボーンがありません");
    return;
  }

  const trackByBoneId = new Map(clip.tracks.map((t) => [t.boneId, t]));
  const rows = boneRows; // ordered as in the hierarchy

  const timelineX0 = LABEL_GUTTER;
  const timelineW = w - LABEL_GUTTER;

  // Grid: same 10/30 frame interval as the graph editor so timing
  // reads consistently across the two views.
  for (let f = 0; f <= clip.maxFrames; f += 10) {
    const px = timelineX0 + Math.floor((f / clip.maxFrames) * timelineW) + 0.5;
    ctx.strokeStyle = f % 30 === 0 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }

  // Gutter separator — gives the label column a visual boundary.
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.beginPath();
  ctx.moveTo(timelineX0 + 0.5, 0);
  ctx.lineTo(timelineX0 + 0.5, h);
  ctx.stroke();

  ctx.font = "9px monospace";
  ctx.textBaseline = "middle";

  const dragging = _drag && _drag.moved && _drag.delta !== 0;

  /** Draw one row's keys with selection highlight + drag ghosts. */
  const drawKeys = (
    rowKey: string,
    keyframes: ReadonlyArray<{ frame: number }>,
    yCenter: number,
    fill: string,
    stroke: string
  ): void => {
    for (const kf of keyframes) {
      const selected = _selectedKeys.has(keyId(rowKey, kf.frame));
      const px = timelineX0 + (kf.frame / clip.maxFrames) * timelineW;
      if (selected) {
        ctx.fillStyle = "#ff9f2a";
        ctx.strokeStyle = "#ffffff";
      } else {
        ctx.fillStyle = fill;
        ctx.strokeStyle = stroke;
      }
      ctx.lineWidth = 1;
      drawDiamond(ctx, px, yCenter);

      // Ghost preview at the drop position while dragging.
      if (dragging && selected) {
        const gf = kf.frame + _drag!.delta;
        const gx = timelineX0 + (gf / clip.maxFrames) * timelineW;
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = "#ff9f2a";
        ctx.strokeStyle = "#ffffff";
        drawDiamond(ctx, gx, yCenter);
        ctx.restore();
      }
    }
  };

  rows.forEach((bone, i) => {
    const y0 = i * ROW_HEIGHT;
    const y1 = y0 + ROW_HEIGHT;
    const yCenter = y0 + ROW_HEIGHT / 2;
    const isSelected = bone.id === state.selectedBoneId;

    // Alternating row tint for readability when scanning many bones.
    if (i % 2 === 1) {
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(0, y0, w, ROW_HEIGHT);
    }
    if (isSelected) {
      ctx.fillStyle = "rgba(255, 200, 0, 0.12)";
      ctx.fillRect(0, y0, w, ROW_HEIGHT);
    }

    // Bone label — truncate by clipping rather than substr so the
    // exact bone name remains available if we ever add hover tooltips.
    ctx.save();
    ctx.beginPath();
    ctx.rect(2, y0, LABEL_GUTTER - 4, ROW_HEIGHT);
    ctx.clip();
    ctx.fillStyle = isSelected ? "#ffcc44" : "rgba(255,255,255,0.7)";
    ctx.textAlign = "left";
    ctx.fillText(bone.name, 4, yCenter);
    ctx.restore();

    // Keyframe diamonds. Base color: yellow when row is selected
    // (matches the row tint), else neutral; individually selected keys
    // render orange with a white outline.
    const track = trackByBoneId.get(bone.id);
    if (track) {
      drawKeys(
        "b:" + bone.id,
        track.keyframes,
        yCenter,
        isSelected ? "#ffcc44" : "rgba(220,220,220,0.85)",
        isSelected ? "#ffaa00" : "rgba(120,120,120,1)"
      );
    }

    _rowHits.push({ boneId: bone.id, morphTrack: null, y0, y1 });
  });

  // Morph lanes — appended below the bone rows, teal to read as a
  // different channel type at a glance.
  morphTracks.forEach((track, mi) => {
    const i = rows.length + mi;
    const y0 = i * ROW_HEIGHT;
    const yCenter = y0 + ROW_HEIGHT / 2;

    if (i % 2 === 1) {
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(0, y0, w, ROW_HEIGHT);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(2, y0, LABEL_GUTTER - 4, ROW_HEIGHT);
    ctx.clip();
    ctx.fillStyle = "rgba(80,220,200,0.9)";
    ctx.textAlign = "left";
    ctx.fillText("◆" + track.targetName, 4, yCenter);
    ctx.restore();

    drawKeys(
      "m:" + track.meshUniqueId + ":" + track.targetIndex,
      track.keyframes,
      yCenter,
      "rgba(80,220,200,0.85)",
      "rgba(30,140,125,1)"
    );

    _rowHits.push({ boneId: null, morphTrack: track, y0, y1: y0 + ROW_HEIGHT });
  });

  // Playhead — yellow, full-height. Matches the graph editor color so
  // the two panels are visually linked.
  const playPx = timelineX0 + Math.floor((state.currentFrame / clip.maxFrames) * timelineW) + 0.5;
  ctx.strokeStyle = "#ffff00";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(playPx, 0);
  ctx.lineTo(playPx, h);
  ctx.stroke();

  if (_info) {
    const totalKeys =
      clip.tracks.reduce((n, t) => n + t.keyframes.length, 0) +
      morphTracks.reduce((n, t) => n + t.keyframes.length, 0);
    const morphNote = morphTracks.length ? ` · ${morphTracks.length} morphs` : "";
    const selNote = _selectedKeys.size ? ` · ${_selectedKeys.size} selected` : "";
    const dragNote = dragging ? ` · Δ${_drag!.delta > 0 ? "+" : ""}${_drag!.delta}f` : "";
    _info.textContent = `${rows.length} bones${morphNote} · ${clip.tracks.length} tracks · ${totalKeys} keys${selNote}${dragNote} · Frame ${state.currentFrame}/${clip.maxFrames}`;
  }
}

// ── Drawing helpers ──

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - DIAMOND_R);
  ctx.lineTo(x + DIAMOND_R, y);
  ctx.lineTo(x, y + DIAMOND_R);
  ctx.lineTo(x - DIAMOND_R, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawEmpty(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string): void {
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(msg, w / 2, h / 2);
}

// ── Pointer handling ──

/** Keyframes for a row from the CURRENT clip (empty when gone). */
function keyframesOfRow(row: RowHit): Array<{ frame: number }> {
  const clip = getActiveClip();
  if (!clip) return [];
  if (row.morphTrack) return row.morphTrack.keyframes;
  return clip.tracks.find((t) => t.boneId === row.boneId)?.keyframes ?? [];
}

/** The key frame under pixel-x on a row, or null. */
function keyFrameAtX(row: RowHit, x: number, rectW: number): number | null {
  const clip = getActiveClip();
  if (!clip) return null;
  const timelineX0 = LABEL_GUTTER;
  const timelineW = rectW - LABEL_GUTTER;
  let best: { frame: number; dist: number } | null = null;
  for (const kf of keyframesOfRow(row)) {
    const keyPx = timelineX0 + (kf.frame / clip.maxFrames) * timelineW;
    const d = Math.abs(keyPx - x);
    if (d <= HIT_TOLERANCE && (!best || d < best.dist)) best = { frame: kf.frame, dist: d };
  }
  return best ? best.frame : null;
}

function onPointerDown(e: PointerEvent): void {
  if (!_canvas) return;
  const clip = getActiveClip();
  if (!clip) return;

  const rect = _canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const row = _rowHits.find((r) => y >= r.y0 && y < r.y1);
  if (!row) return;

  if (x < LABEL_GUTTER) {
    // Label gutter — select the bone (morph rows have no selection
    // concept; the gutter click is a no-op for them).
    if (row.boneId) selectBone(row.boneId);
    drawDopesheet();
    return;
  }

  const hitFrame = keyFrameAtX(row, x, rect.width);
  if (hitFrame === null) {
    // Empty timeline: treated as a click on pointerup-equivalent —
    // scrub immediately (V1 behavior) and clear the key selection.
    const timelineW = rect.width - LABEL_GUTTER;
    const frameAtX = ((x - LABEL_GUTTER) / timelineW) * clip.maxFrames;
    if (row.boneId) selectBone(row.boneId);
    _selectedKeys.clear();
    scrubToFrame(Math.max(0, Math.min(clip.maxFrames, Math.round(frameAtX))));
    drawDopesheet();
    return;
  }

  const rowKey = rowKeyOf(row);
  const id = keyId(rowKey, hitFrame);

  if (e.shiftKey) {
    // Shift+click: toggle membership, never starts a drag.
    if (_selectedKeys.has(id)) _selectedKeys.delete(id);
    else _selectedKeys.add(id);
    if (row.boneId) selectBone(row.boneId);
    drawDopesheet();
    return;
  }

  // Plain press on a key: make it the selection anchor. If it's already
  // part of a multi-selection, keep the set (dragging moves them all).
  if (!_selectedKeys.has(id)) {
    _selectedKeys = new Set([id]);
  }
  if (row.boneId) selectBone(row.boneId);

  _drag = { rowKey, grabFrame: hitFrame, startX: x, startY: y, moved: false, delta: 0, shift: false };
  _canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
  drawDopesheet();
}

/** Resolve the selection into per-track frame sets against the live clip. */
function collectSelection(): Array<{
  rowKey: string;
  track: { keyframes: KeyframeData[] } | null;
  morph: MorphTrack | null;
  frames: Set<number>;
}> {
  const clip = getActiveClip();
  if (!clip) return [];
  const byRow = new Map<string, Set<number>>();
  for (const id of _selectedKeys) {
    const at = id.lastIndexOf("@");
    const rowKey = id.slice(0, at);
    const frame = Number(id.slice(at + 1));
    let set = byRow.get(rowKey);
    if (!set) { set = new Set(); byRow.set(rowKey, set); }
    set.add(frame);
  }
  const out: ReturnType<typeof collectSelection> = [];
  for (const [rowKey, frames] of byRow) {
    if (rowKey.startsWith("b:")) {
      const boneId = rowKey.slice(2);
      const track = clip.tracks.find((t) => t.boneId === boneId) ?? null;
      if (track) out.push({ rowKey, track, morph: null, frames });
    } else {
      const [uid, tIdx] = rowKey.slice(2).split(":");
      const morph = (clip.morphTracks ?? []).find(
        (t) => t.meshUniqueId === Number(uid) && t.targetIndex === Number(tIdx)
      ) ?? null;
      if (morph) out.push({ rowKey, track: null, morph, frames });
    }
  }
  return out;
}

/** Globally clamp a requested delta so every selected key stays in range. */
function clampDeltaToSelection(delta: number, maxFrames: number): number {
  let d = Math.round(delta);
  for (const sel of collectSelection()) {
    for (const f of sel.frames) {
      if (f + d < 0) d = -f;
      if (f + d > maxFrames) d = maxFrames - f;
    }
  }
  return d;
}

function onPointerMove(e: PointerEvent): void {
  if (!_drag || !_canvas) return;
  const clip = getActiveClip();
  if (!clip) return;
  const rect = _canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;

  if (!_drag.moved && Math.abs(x - _drag.startX) < DRAG_THRESHOLD) return;
  _drag.moved = true;

  const timelineW = rect.width - LABEL_GUTTER;
  const framesPerPx = clip.maxFrames / timelineW;
  _drag.delta = clampDeltaToSelection((x - _drag.startX) * framesPerPx, clip.maxFrames);
  drawDopesheet();
}

function onPointerUp(e: PointerEvent): void {
  if (!_canvas || !_drag) return;
  try { _canvas.releasePointerCapture(e.pointerId); } catch { /* may not own */ }
  const drag = _drag;
  _drag = null;

  const clip = getActiveClip();
  if (!clip) return;

  if (!drag.moved || drag.delta === 0) {
    // Plain click on a key: scrub to it (classic dopesheet behavior).
    scrubToFrame(drag.grabFrame);
    drawDopesheet();
    return;
  }

  applyRetime(drag.delta);
}

/**
 * Commit a drag: retime every selected key by `delta` frames with one
 * compound undo entry. Selected key ids are rewritten to the new frames
 * so the selection survives the move.
 */
function applyRetime(delta: number): void {
  const clip = getActiveClip();
  if (!clip) return;
  const selection = collectSelection();
  if (selection.length === 0) return;

  // Snapshots for undo — deep clones (retimeKeys mutates key objects).
  const affected = selection.map((sel) => {
    const keysRef: Array<{ frame: number }> = sel.track ? sel.track.keyframes : sel.morph!.keyframes;
    return { sel, keysRef, before: structuredClone(keysRef) };
  });

  const newSelection = new Set<string>();
  let removedTotal = 0;
  for (const { sel } of affected) {
    if (sel.track) {
      const r = retimeKeys(sel.track.keyframes as KeyframeData[], sel.frames, delta, clip.maxFrames);
      sel.track.keyframes.splice(0, sel.track.keyframes.length, ...r.keys);
      removedTotal += r.removed.length;
      for (const f of sel.frames) newSelection.add(keyId(sel.rowKey, f + r.appliedDelta));
    } else if (sel.morph) {
      const r = retimeKeys(sel.morph.keyframes as MorphKeyframe[], sel.frames, delta, clip.maxFrames);
      sel.morph.keyframes.splice(0, sel.morph.keyframes.length, ...r.keys);
      removedTotal += r.removed.length;
      for (const f of sel.frames) newSelection.add(keyId(sel.rowKey, f + r.appliedDelta));
    }
  }
  _selectedKeys = newSelection;

  const after = affected.map(({ keysRef }) => structuredClone(keysRef));

  const refresh = (): void => {
    scrubToFrame(state.currentFrame); // re-pose with the new timing
    drawDopesheet();
    drawGraphEditor();
    _keysRetimedHandler?.();
  };

  state.history.push({
    label: "Retime Keys",
    undo() {
      for (const { keysRef, before } of affected) {
        keysRef.splice(0, keysRef.length, ...structuredClone(before));
      }
      _selectedKeys.clear();
      refresh();
    },
    redo() {
      affected.forEach(({ keysRef }, i) => {
        keysRef.splice(0, keysRef.length, ...structuredClone(after[i]!));
      });
      _selectedKeys.clear();
      refresh();
    },
  });

  const n = _selectedKeys.size;
  status(
    `Keys moved ${delta > 0 ? "+" : ""}${delta}f (${n} key${n === 1 ? "" : "s"}` +
    (removedTotal ? `, ${removedTotal} overwritten)` : ")")
  );
  refresh();
}
