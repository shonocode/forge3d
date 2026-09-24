/**
 * The one channel through which the GUI learns that the editor changed
 * (ADR-014). The editor's state stays where it is — `state.ts`, a mutable
 * object that ~180 call sites write to directly, and the Babylon scene — and
 * this store only says **"something changed, read again"**, with a version
 * number React can subscribe to (`useSyncExternalStore`, `src/app/`).
 *
 * Three things feed it, so the writers do not all have to be found and taught
 * to call it:
 *
 * 1. the undo history — every undoable operation pushes there (`connect.ts`);
 * 2. {@link ForgeStore.setStatus} — `status()` in `state.ts`, which nearly
 *    every action calls to report itself, and whose text the GUI shows;
 * 3. {@link ForgeStore.poll} once a frame with a {@link fingerprint} of the
 *    state the GUI draws from — the catch-all for writes that report nothing
 *    (a click that changes the selection, a tool switch).
 *
 * Notifications in the same tick are merged into one (a microtask), so an
 * operation that pushes history, reports status and changes the selection
 * redraws the GUI once.
 *
 * No React and no Babylon here: `state.ts` imports this, and the parity
 * harness reaches `state.ts` through the tools.
 */

export type StatusKind = "info" | "ok" | "error";

/** The last line an action reported. */
export interface StatusLine {
  text: string;
  kind: StatusKind;
  /** Bumps with each report, so the same text twice still reads as new. */
  seq: number;
}

/** How a status text reads: `⚠` is an error, a finished save or load is a success. */
export function statusKind(text: string): StatusKind {
  if (text.startsWith("⚠")) return "error";
  if (/exported|saved|loaded|completed/i.test(text)) return "ok";
  return "info";
}

export class ForgeStore {
  private listeners = new Set<() => void>();
  private _version = 0;
  private pending = false;
  private lastFingerprint: string | null = null;
  private _status: StatusLine | null = null;

  /** Changes whenever the GUI should read again. React's snapshot. */
  get version(): number {
    return this._version;
  }

  get status(): StatusLine | null {
    return this._status;
  }

  /** Add a listener; returns the function that removes it. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** For `useSyncExternalStore`. */
  getVersion = (): number => this._version;

  /**
   * Say that something changed. Calls in the same tick become one
   * notification, delivered on a microtask.
   */
  notify(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this._version++;
      for (const l of [...this.listeners]) l();
    });
  }

  /** Record the status line and notify. */
  setStatus(text: string): void {
    this._status = { text, kind: statusKind(text), seq: (this._status?.seq ?? 0) + 1 };
    this.notify();
  }

  /**
   * Compare a fingerprint of the drawn state with the last one and notify
   * when it differs. Cheap enough for every frame; the first call only records.
   */
  poll(fp: string): void {
    if (fp === this.lastFingerprint) return;
    const first = this.lastFingerprint === null;
    this.lastFingerprint = fp;
    if (!first) this.notify();
  }
}

/** The parts of the editor state a fingerprint reads. */
export interface FingerprintSource {
  tool: string;
  selectedMeshes: ReadonlyArray<{ uniqueId: number }>;
  allMeshes: ReadonlyArray<{ uniqueId: number }>;
  editMesh: unknown;
  sculpting: boolean;
  painting: boolean;
  weightPainting: boolean;
  boneEditMode: string;
  viewportMode: string;
  history: { version: number };
}

/**
 * A string that changes when anything the GUI draws from changes: the tool,
 * the selection, the scene's meshes, which mode is on, the history. Not the
 * geometry — that changes through operations, which push history.
 */
export function fingerprint(s: FingerprintSource): string {
  return [
    s.tool,
    s.selectedMeshes.map((m) => m.uniqueId).join(","),
    s.allMeshes.map((m) => m.uniqueId).join(","),
    s.editMesh ? "E" : "-",
    s.sculpting ? "S" : "-",
    s.painting ? "P" : "-",
    s.weightPainting ? "W" : "-",
    s.boneEditMode,
    s.viewportMode,
    s.history.version,
  ].join("|");
}

/** The editor's store. Tests make their own `new ForgeStore()`. */
export const store = new ForgeStore();
