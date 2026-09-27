/**
 * Which waiting tasks' questions are open on screen right now (the chat's
 * question sheet or docked pane). The global "…needs your input" banner skips
 * them: it would otherwise sit on top of the sheet answering that very question.
 *
 * A tiny external store rather than state in NeedsInputProvider: the question
 * card mounts deep inside the chat, and the banner lives in the layout, so a
 * module-level set with ref counts is the whole contract. Client-only in
 * practice — nothing holds a task during a server render.
 */
import { useEffect, useSyncExternalStore } from 'react';

const counts = new Map<string, number>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish() {
  snapshot = new Set(counts.keys());
  for (const l of listeners) l();
}

/** Hide the banner for `taskId` until the returned release is called (idempotent). */
export function hideNeedsInputFor(taskId: string): () => void {
  counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (counts.get(taskId) ?? 1) - 1;
    if (n > 0) counts.set(taskId, n);
    else counts.delete(taskId);
    publish();
  };
}

export function hiddenNeedsInputSnapshot(): ReadonlySet<string> {
  return snapshot;
}

export function subscribeHiddenNeedsInput(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The task ids whose question is open on screen. */
export function useHiddenNeedsInput(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeHiddenNeedsInput, hiddenNeedsInputSnapshot, hiddenNeedsInputSnapshot);
}

/** While mounted (and `taskId` is set), the banner skips this task's question. */
export function useHideNeedsInputWhileOpen(taskId: string | null | undefined): void {
  useEffect(() => (taskId ? hideNeedsInputFor(taskId) : undefined), [taskId]);
}

// ── Phone suppression ───────────────────────────────────────────────────────
// The phone chat canvas in needs-you mood says what waits on the viewer in its
// hero and copper row; the banner above it would only repeat it, in a third
// accent colour. While a surface holds this, the banner hides below md.

let phoneHolds = 0;
let allHolds = 0;

/** Hide the banner on a phone until the returned release is called (idempotent, counted). */
export function hideNeedsInputBannerOnPhone(): () => void {
  phoneHolds += 1;
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    phoneHolds = Math.max(0, phoneHolds - 1);
    publish();
  };
}

export function phoneBannerHiddenSnapshot(): boolean {
  return phoneHolds > 0;
}

/** Whether the banner should hide on a phone right now. */
export function usePhoneBannerHidden(): boolean {
  return useSyncExternalStore(subscribeHiddenNeedsInput, phoneBannerHiddenSnapshot, phoneBannerHiddenSnapshot);
}

/** While mounted and `active`, the banner hides on a phone. */
export function useHideNeedsInputBannerOnPhone(active: boolean): void {
  useEffect(() => (active ? hideNeedsInputBannerOnPhone() : undefined), [active]);
}

// ── Suppression at every width ──────────────────────────────────────────────
// The summoned chat canvas sits over the page behind a scrim; the banner lives
// in the layout's own stack and would paint above it, bright. While the canvas
// is up, the banner hides.

/** Hide the banner at every width until the returned release is called (idempotent, counted). */
export function hideNeedsInputBanner(): () => void {
  allHolds += 1;
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    allHolds = Math.max(0, allHolds - 1);
    publish();
  };
}

export function bannerHiddenSnapshot(): boolean {
  return allHolds > 0;
}

/** Whether the banner should hide everywhere right now. */
export function useBannerHidden(): boolean {
  return useSyncExternalStore(subscribeHiddenNeedsInput, bannerHiddenSnapshot, bannerHiddenSnapshot);
}

/** While mounted and `active`, the banner hides at every width. */
export function useHideNeedsInputBanner(active: boolean): void {
  useEffect(() => (active ? hideNeedsInputBanner() : undefined), [active]);
}

/** The waiting tasks the banner may name: the hidden ones dropped, order kept. */
export function bannerTasks<T extends { id: string }>(tasks: readonly T[], hidden: ReadonlySet<string>): readonly T[] {
  if (hidden.size === 0) return tasks;
  return tasks.filter(t => !hidden.has(t.id));
}
