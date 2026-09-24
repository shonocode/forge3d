/**
 * Wire the store to what changes outside React (ADR-014): the undo history,
 * and — once a frame — a fingerprint of the editor state, to catch the writes
 * that report nothing. Called once by the app's entry after the scene exists.
 */
import { fingerprint, type FingerprintSource, type ForgeStore } from "../store";

/** The one hook this needs from a Babylon scene. */
export interface FrameSource {
  onAfterRenderObservable: {
    add(cb: () => void): unknown;
    remove(observer: unknown): boolean;
  };
}

/** What `connectStore` reads: the fingerprinted state and its history. */
export interface ConnectSource extends FingerprintSource {
  history: FingerprintSource["history"] & { subscribe(cb: () => void): () => void };
}

/** Start feeding `forge`; returns the function that stops. */
export function connectStore(forge: ForgeStore, source: ConnectSource, frames: FrameSource): () => void {
  const offHistory = source.history.subscribe(() => forge.notify());
  forge.poll(fingerprint(source));
  const observer = frames.onAfterRenderObservable.add(() => forge.poll(fingerprint(source)));
  return () => {
    offHistory();
    frames.onAfterRenderObservable.remove(observer);
  };
}
