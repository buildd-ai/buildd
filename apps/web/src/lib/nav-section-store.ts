/**
 * Which nav destination owns the open page, when its path alone cannot say.
 * A mission's task lives at `/app/tasks/<id>`, the same path as a loose task,
 * yet it belongs to Missions (spec d25d923d "Navigation: one place per task"):
 * the task page claims Missions while it is mounted, and the side rail and the
 * phone tab bar mark that instead of what the path would pick.
 *
 * Same shape as needs-input-hidden.ts: a module-level list of holds, the most
 * recent one wins. Client-only in practice; nothing holds during a server render.
 */
import { useLayoutEffect, useSyncExternalStore } from 'react';

const holds: { href: string }[] = [];
let snapshot: string | null = null;
const listeners = new Set<() => void>();

function publish() {
  snapshot = holds.length > 0 ? holds[holds.length - 1].href : null;
  for (const l of listeners) l();
}

/** Mark `href` as the open page's nav destination until the returned release is called (idempotent). */
export function claimNavSection(href: string): () => void {
  const hold = { href };
  holds.push(hold);
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const i = holds.indexOf(hold);
    if (i >= 0) holds.splice(i, 1);
    publish();
  };
}

export function navSectionSnapshot(): string | null {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The nav href the open page claimed, or null to go by the path. */
export function useNavSection(): string | null {
  return useSyncExternalStore(subscribe, navSectionSnapshot, () => null);
}

/** While mounted (and `href` is set), the nav marks `href`. Layout effect: no frame with the wrong mark on a client navigation. */
export function useClaimNavSection(href: string | null | undefined): void {
  useLayoutEffect(() => (href ? claimNavSection(href) : undefined), [href]);
}
