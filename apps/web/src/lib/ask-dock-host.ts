/**
 * Where a docked SideSheet goes while Ask is docked open (Navigation R-21).
 *
 * Ask and SideSheet both dock right; side by side they would leave the page
 * about 450px at 1440. So while Ask is docked open, the chat canvas publishes
 * a host element inside its column and SideSheet renders into it, stacked over
 * the conversation, instead of as a second fixed panel. Null otherwise.
 *
 * A module-level store, like lib/side-sheet-stack.ts: the canvas lives in the
 * layout and sheets mount deep in pages.
 */
import { useSyncExternalStore } from 'react';

let host: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setAskDockHost(el: HTMLElement | null): void {
  if (host === el) return;
  host = el;
  for (const l of listeners) l();
}

export function getAskDockHost(): HTMLElement | null {
  return host;
}

export function subscribeAskDockHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAskDockHost(): HTMLElement | null {
  return useSyncExternalStore(subscribeAskDockHost, getAskDockHost, () => null);
}
