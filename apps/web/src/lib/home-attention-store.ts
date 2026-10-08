'use client';
import { useSyncExternalStore } from 'react';
let count: number | null = null;
const listeners = new Set<() => void>();
export function publishHomeAttentionCount(next: number | null) {
  count = next;
  for (const listener of listeners) listener();
}
export function useHomeAttentionCount() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => count, () => null);
}
