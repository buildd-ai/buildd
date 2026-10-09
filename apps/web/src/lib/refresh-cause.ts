/**
 * The words for why a branch refresh did not land, for every surface that
 * reports one (landing ledger, auto-merge ledger, the landing page).
 *
 * A refresh result carries a failure class (legacy update-branch path) and/or
 * a reason (the raw GitHub error, or the workflow kernel's escalation detail).
 * The kernel path has no class at all, so rendering only the class turned every
 * kernel outcome into "(unknown)" while the real cause sat unread. Pure: no
 * imports beyond types, so any door can use it without pulling in the db.
 */

import type { BranchUpdateFailure } from '@/lib/pr-branch-update';

const MAX_REASON = 300;

export function refreshCause(res: { refreshFailure?: BranchUpdateFailure | null; refreshReason?: string | null }): string {
  const raw = res.refreshReason?.trim();
  const reason = raw ? (raw.length > MAX_REASON ? `${raw.slice(0, MAX_REASON)}…` : raw) : null;
  const failure = res.refreshFailure ?? null;
  if (failure && reason) return `${failure}: ${reason}`;
  if (reason) return reason;
  if (failure) return failure === 'unknown' ? 'unknown, no error text recorded' : failure;
  return 'no cause recorded';
}
