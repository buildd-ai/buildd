/**
 * Native `history.pushState` / `replaceState` under the Next App Router.
 *
 * The App Router patches both so a native write reaches `useSearchParams`
 * without a server render (ACTION_RESTORE; see
 * `missions/[id]/TaskSheet.next-history.test.ts`). The patch has a loop guard:
 * a write whose `data` carries Next's own `__NA` / `_N` markers is passed
 * straight through, unsynced. `window.history.state` always carries them, so
 * `pushState(history.state, …)` changes the address bar but not
 * `useSearchParams` — and the router's next commit writes its stale canonical
 * URL back over it.
 *
 * `nativeHistoryData` returns the caller's own keys only. The patch then copies
 * Next's internal tree in itself (`copyNextJsInternalHistoryState`).
 */

const NEXT_INTERNAL_KEYS = new Set(['__NA', '_N', '__PRIVATE_NEXTJS_INTERNALS_TREE']);

export function nativeHistoryData(state: unknown): Record<string, unknown> {
  if (state == null || typeof state !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
    if (!NEXT_INTERNAL_KEYS.has(k)) out[k] = v;
  }
  return out;
}
