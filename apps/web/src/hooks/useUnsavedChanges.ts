import { useEffect, useState } from 'react';
import { formSnapshot, type DirtyOptions } from '@/lib/form-dirty';

/**
 * Tracks whether `state` differs from the last-saved snapshot.
 *
 * The first render's state is the saved baseline. After a successful save call
 * `markSaved(snapshotAtSubmit)` with the `snapshot` captured when the save
 * started, so edits typed while the request was in flight stay dirty.
 */
export function useDirtyState<T extends object>(state: T, opts: DirtyOptions<keyof T> = {}) {
  const snapshot = formSnapshot(state, opts);
  const [saved, setSaved] = useState(snapshot);
  return {
    dirty: snapshot !== saved,
    snapshot,
    markSaved: (s: string = snapshot) => setSaved(s),
  };
}

/**
 * Asks the browser to confirm closing/reloading the tab while `dirty`.
 *
 * In-app (client-side) navigation is NOT covered: the Next 16 app router has
 * no route-change blocking API. `<Link onNavigate>` can cancel a single link,
 * but not the sidebar, bottom nav, or the back button, so it is not used here.
 */
export function useWarnOnUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set to show the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
