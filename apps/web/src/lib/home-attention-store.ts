'use client';
import { useSyncExternalStore } from 'react';

/**
 * Home's needs-you count, for every nav badge. Home publishes it; the last
 * value is kept for a while so a page opened directly (not via Home) still
 * shows the badge Home last showed, never a second count from another source.
 */
const KEY = 'buildd.homeAttentionCount';
const MAX_AGE_MS = 30 * 60_000;
let count: number | null = null;
let loaded = false;
const listeners = new Set<() => void>();

/** The count Home last published, or a recent one it left in storage. */
export function readHomeAttentionCount(): number | null {
  if (loaded || typeof window === 'undefined') return count;
  loaded = true;
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as { n: number; at: number } | null;
    if (saved && typeof saved.n === 'number' && Date.now() - saved.at < MAX_AGE_MS) count = saved.n;
  } catch { /* storage unavailable: no badge until Home publishes */ }
  return count;
}

export function publishHomeAttentionCount(next: number | null) {
  count = next;
  loaded = true;
  try {
    if (typeof window !== 'undefined') {
      if (next == null) window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, JSON.stringify({ n: next, at: Date.now() }));
    }
  } catch { /* storage unavailable */ }
  for (const listener of listeners) listener();
}

export function useHomeAttentionCount() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, readHomeAttentionCount, () => null);
}
