/**
 * React's view of the editor (ADR-014): read `state.ts` through a selector,
 * re-render when the store says something changed.
 *
 * The snapshot is the store's version, not the selected value — the editor's
 * state is mutated in place, so its arrays and objects keep their identity
 * across changes and could not tell React anything. The selector runs on
 * every render, so keep it to reading.
 */
import { useSyncExternalStore } from "react";
import { store as defaultStore, type ForgeStore, type StatusLine } from "../store";
import { state } from "../state";

/** The editor state as selectors see it. */
export type EditorState = typeof state;

/**
 * Read from the editor state, re-rendering whenever the store notifies.
 * `source` and `forge` are for tests; the app uses the defaults.
 */
export function useForge<T>(select: (s: EditorState) => T, source: EditorState = state, forge: ForgeStore = defaultStore): T {
  useSyncExternalStore(forge.subscribe, forge.getVersion);
  return select(source);
}

/** The last status line an action reported, or null before the first. */
export function useStatus(forge: ForgeStore = defaultStore): StatusLine | null {
  useSyncExternalStore(forge.subscribe, forge.getVersion);
  return forge.status;
}
