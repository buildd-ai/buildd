'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { ActionQueueItem, DiscrepancyDirection } from '@/lib/action-queue';

interface WaitingOnYouDiscrepancyCardProps {
  item: ActionQueueItem;
}

type Mode = 'idle' | 'accepting' | 'flipping' | 'error';

const DIRECTION_LABEL: Record<DiscrepancyDirection, string> = {
  contradicted: 'Contradicted · needs your call',
  spec_ahead: 'Spec ahead · unbuilt work',
  code_ahead: 'Code ahead · doc fix',
};

function ageLabel(hours: number | null | undefined): string | null {
  if (hours == null) return null;
  const days = Math.floor(hours / 24);
  if (days <= 0) return 'today';
  return days === 1 ? '1 day old' : `${days} days old`;
}

const PRIMARY_BTN =
  'inline-flex items-center min-h-11 md:min-h-0 text-[12px] font-medium text-white bg-accent hover:bg-accent/90 transition-colors rounded-md px-2.5 py-1.5 whitespace-nowrap disabled:opacity-60';
const SECONDARY_BTN =
  'inline-flex items-center min-h-11 md:min-h-0 text-[12px] font-medium text-text-secondary hover:text-text-primary border border-border rounded-md px-2.5 py-1.5 whitespace-nowrap disabled:opacity-60';

/**
 * DISCREPANCY card for Home (docs/design/spec-conformance.md §12).
 *
 * ── One card per spec doc ──
 * The card is a group: every open ledger row sharing a spec path and a
 * direction. A stale document fails every assertion in it at once, so the
 * per-assertion card rendered the same doc fix four times and crowded out
 * everything else in the queue. The assertion ids are still all here, one tap
 * away, because the count is the summary and the list is the evidence.
 *
 * ── The CTA set per direction ──
 * Derived from server state, never from what looks tidy — the same discipline
 * docs/specs/action-queue-card-state.md I-1 applies to rendered text. Each
 * direction gets exactly the actions §8 says are valid for it:
 *
 *  - `code_ahead`  — Dispatch doc fix (primary), Accept (secondary). §8: "the
 *    only valid actions on a code_ahead row are accept or a docs-only
 *    follow-up task." Promote is absent because the promotion rule forbids it
 *    (and must keep forbidding it); flip direction is absent because
 *    `adjudicate_discrepancy`'s flip is "the only path off `contradicted`"
 *    (§13) and would be rejected here — a CTA the server refuses is the dead
 *    button this file already learned not to render.
 *  - `spec_ahead`  — Promote (primary, or the minted mission's link), Accept.
 *  - `contradicted` — Flip direction, Accept. Unchanged.
 *
 * A group with a doc fix actively running renders no buttons at all: it is
 * agent-handled (chip FIXING_SPEC), and the only thing left to do is read the
 * task. The rows still close mechanically on the next checker re-run — never
 * because that task said it was done.
 *
 * Once that task has COMPLETED, the card names the real blocker instead of
 * assuming completion means merged (a task can finish its session with a PR
 * still open for review):
 *   - PR still open — "Doc fix PR open" and a link to it. No re-run claim:
 *     nothing has changed on the branch this checker reads, so nothing is
 *     "awaiting" yet.
 *   - PR merged, not yet rechecked — "awaiting the conformance re-run", which
 *     is now actually true rather than assumed. This gets NO decision CTA:
 *     the wait is bounded, not stuck. The next checker run either resolves
 *     the row or (see the next bullet) finds it still open and releases the
 *     claim. Offering Accept here would let a human launder a pending
 *     automatic re-run into an "accepted" row before the checker ever ran —
 *     exactly the pattern this card exists to prevent.
 *   - PR merged AND rechecked since (lib/action-queue.ts's isDocFixClaimStale
 *     compares the row's own last_checked_at against the merge time) and the
 *     row is STILL open — the fix demonstrably didn't close it. The claim
 *     releases (buildDiscrepancyItems) and the group falls out of `inFlight`.
 *     When every open row on the path is held that way the group carries
 *     `mergedDocFixTaskId`: the card links the merged fix and
 *     offers Accept only. No Dispatch doc fix — the doc already landed, so the
 *     row is held open by its assertions, and a second docs-only task would
 *     reproduce the same result (the dispatch route refuses it with
 *     `doc_fix_already_merged`). Only the owner can move it now. If some row
 *     on the path was never attempted, Dispatch stays and covers only those.
 * In every other completed sub-state — PR still open, or a merge lifecycle
 * that is simply unknown (isDocFixClaimStale can never fire without a known
 * merge timestamp to compare against, so that claim would otherwise sit
 * agent-handled forever) — Accept stays available as the one last-resort
 * exit. Closure is still the checker's word, so the card cannot say the
 * finding is settled, but a docs PR that was never merged, or one whose
 * lifecycle this card cannot observe, would otherwise leave no action
 * reachable at all: the finding would be parked by accident instead of by a
 * decision. Accept is the action §8 allows on the row in any state, and it
 * records a reason.
 *
 * All three mutations call the §13 REST routes that back the equivalent MCP
 * actions, so there is exactly one mutation path whether a human taps here or
 * an agent calls the MCP tool directly. Accept and flip are per-row by
 * contract, so a grouped card applies them across the group one row at a time
 * rather than teaching those routes a second, group-shaped vocabulary.
 */
export function WaitingOnYouDiscrepancyCard({ item }: WaitingOnYouDiscrepancyCardProps) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('idle');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [reason, setReason] = useState('');
  const [newDirection, setNewDirection] = useState<'spec_ahead' | 'code_ahead'>('spec_ahead');

  if (!item.discrepancyId) return null;

  const rowIds = item.discrepancyIds?.length ? item.discrepancyIds : [item.discrepancyId];
  const assertionIds = item.assertionIds?.length
    ? item.assertionIds
    : item.assertionId
      ? [item.assertionId]
      : [];

  async function adjudicateAll(body: Record<string, unknown>) {
    setBusy(true);
    setErrorMsg('');
    try {
      for (const rowId of rowIds) {
        const res = await fetch(`/api/discrepancies/${rowId}/adjudicate`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not update the discrepancy');
      }
      setMode('idle');
      router.refresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error');
      setMode('error');
    } finally {
      setBusy(false);
    }
  }

  // One task for the whole spec path. The route re-derives the group from the
  // row's own spec path and claims it atomically, so a double-tap — or a
  // sibling row tapped a second later — attaches to the task that already
  // exists instead of filing another.
  async function dispatchDocFix() {
    setBusy(true);
    setErrorMsg('');
    try {
      const res = await fetch(`/api/discrepancies/${item.discrepancyId}/dispatch-doc-fix`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not dispatch the doc fix');
      setMode('idle');
      router.refresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error');
      setMode('error');
    } finally {
      setBusy(false);
    }
  }

  // Two-step, mirroring the promote_discrepancy MCP action exactly (mint a
  // mission through the same POST /api/missions primitive, then link it back
  // onto the row) — see packages/core/mcp-tools.ts's promote_discrepancy.
  async function promote() {
    setBusy(true);
    setErrorMsg('');
    try {
      const missionRes = await fetch('/api/missions', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Spec discrepancy: ${item.assertionId} in ${item.specPath}`,
          description:
            `Promoted from discrepancy ledger row ${item.discrepancyId} ` +
            `(docs/design/spec-conformance.md §13).\n\n` +
            `Spec: ${item.specPath}\nAssertion: ${item.assertionId}\nDirection: ${item.direction}`,
          workspaceId: item.workspaceId,
        }),
      });
      const mission = await missionRes.json().catch(() => ({}));
      if (!missionRes.ok) throw new Error(mission.error || 'Could not create the mission');

      const linkRes = await fetch(`/api/discrepancies/${item.discrepancyId}/promote`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId: mission.id }),
      });
      const linked = await linkRes.json().catch(() => ({}));
      if (!linkRes.ok) throw new Error(linked.error || 'Mission created but could not be linked to the row');

      setMode('idle');
      router.refresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error');
      setMode('error');
    } finally {
      setBusy(false);
    }
  }

  const direction = item.direction ?? 'code_ahead';
  const age = ageLabel(item.cardAgeHours);
  const claimCount = assertionIds.length || rowIds.length;
  const inFlight = Boolean(item.docFixTaskId);
  // The fix has been written and the rows are waiting on the checker. Nothing
  // is running any more, so the card owes the human an exit again — see the
  // note on Accept at the top of this file.
  const docFixShipped = inFlight && item.docFixTaskStatus === 'completed';
  // A completed task's PR may not have merged yet — completion just means the
  // agent's session ended, not that the fix landed (workers.mergedAt is the
  // authoritative merge signal). Only a KNOWN-unmerged PR gets the "PR open"
  // copy; an unknown lifecycle (older rows, or the caller not supplying it)
  // falls back to the existing "awaiting the conformance re-run" reading
  // rather than asserting something the server never confirmed.
  const docFixPrOpen = docFixShipped && item.docFixPrLifecycleStatus != null && item.docFixPrLifecycleStatus !== 'merged';
  // A KNOWN merge is a bounded wait, not a stuck one: the next checker run
  // either resolves the row or (isDocFixClaimStale, lib/action-queue.ts)
  // finds it still open and releases the claim back to the live CTA set. So
  // this substate gets no decision CTA at all — Accept here would let a human
  // launder a pending automatic re-run into an "accepted" row before the
  // checker ever ran. An UNKNOWN lifecycle has no such backstop (staleness
  // requires a known merge timestamp to compare against) and keeps Accept as
  // the last-resort exit below.
  const docFixPrMerged = docFixShipped && item.docFixPrLifecycleStatus === 'merged';
  // A doc fix merged and the re-run still finds the gap: the owner's call now,
  // never a second dispatch (see the header note).
  const mergedFixTaskId = !inFlight ? item.mergedDocFixTaskId ?? null : null;
  const accent = inFlight ? 'text-text-muted' : 'text-status-warning';

  return (
    <div
      className={
        inFlight
          ? 'border-l-2 border-text-muted bg-surface-2 rounded-r-[10px] px-4 py-3'
          : 'border-l-2 border-status-warning bg-status-warning/5 rounded-r-[10px] px-4 py-3'
      }
    >
      <div className="min-w-0">
        {/* Separated by gap, not "·" glyphs: a glyph leading an item wraps
            onto the next line alone on a narrow card. */}
        <div className="flex items-center gap-x-3 gap-y-0.5 mb-0.5 flex-wrap">
          <span className={`text-[11px] font-mono font-medium ${accent} tracking-wide uppercase`}>
            {inFlight ? 'Doc fix' : 'Discrepancy'}
          </span>
          <span className="text-[11px] text-text-muted">{DIRECTION_LABEL[direction]}</span>
          {age && <span className="text-[11px] text-text-muted">{age}</span>}
        </div>

        {/* The spec path is the identity of this card — it wraps rather than
            truncating. At 393pt a truncated doc path is unidentifiable, which
            is the whole failure the Home mobile work already fixed once. */}
        <div className="text-[13px] font-medium text-text-primary [overflow-wrap:anywhere] min-w-0 mb-1">
          {item.specPath}
        </div>

        {claimCount > 0 && (
          <details className="mb-2">
            <summary className="inline-flex items-center min-h-11 md:min-h-0 text-[12px] text-text-secondary cursor-pointer list-none marker:content-none">
              <span className="underline decoration-dotted underline-offset-2">
                {claimCount} claim{claimCount === 1 ? '' : 's'}
              </span>
            </summary>
            <ul className="mt-1 space-y-0.5">
              {assertionIds.map((a) => (
                <li key={a} className="text-[11px] text-text-secondary font-mono [overflow-wrap:anywhere]">
                  {a}
                </li>
              ))}
            </ul>
          </details>
        )}

        {inFlight && (
          <Link
            href={`/app/tasks/${item.docFixTaskId}`}
            className="inline-flex items-center min-h-11 md:min-h-0 text-[12px] font-medium text-accent-text hover:underline"
          >
            {docFixPrOpen
              ? 'Doc fix PR open. Merge it to continue →'
              : docFixShipped
                ? 'Doc fix shipped. Waiting on the conformance re-run →'
                : 'Fix in flight →'}
          </Link>
        )}

        {/* The decision is the Accept button below; this link only opens the
            task, so it says so rather than naming the decision. */}
        {mergedFixTaskId && (
          <div>
            <p className="text-[12px] text-text-secondary">Doc fix merged. The gap is still open.</p>
            <Link
              href={`/app/tasks/${mergedFixTaskId}`}
              className="inline-flex items-center min-h-11 md:min-h-0 text-[12px] font-medium text-accent-text hover:underline"
            >
              Open the doc-fix task →
            </Link>
          </div>
        )}
      </div>

      {(!inFlight || (docFixShipped && !docFixPrMerged)) && mode === 'idle' && (
        <div className={`flex items-center gap-2 flex-wrap${docFixShipped || mergedFixTaskId ? ' mt-2' : ''}`}>
          {!inFlight && !mergedFixTaskId && direction === 'code_ahead' && (
            <button type="button" onClick={dispatchDocFix} disabled={busy} className={PRIMARY_BTN}>
              {busy ? 'Dispatching…' : 'Dispatch doc fix'}
            </button>
          )}
          {inFlight ? null : item.promotedMissionId ? (
            <Link
              href={`/app/missions/${item.promotedMissionId}`}
              className="inline-flex items-center min-h-11 md:min-h-0 text-[12px] font-medium text-accent-text hover:underline whitespace-nowrap"
            >
              View mission →
            </Link>
          ) : direction === 'spec_ahead' ? (
            <button type="button" onClick={promote} disabled={busy} className={PRIMARY_BTN}>
              {busy ? 'Promoting…' : 'Promote'}
            </button>
          ) : null}
          {!inFlight && direction === 'contradicted' && (
            <button
              type="button"
              onClick={() => setMode('flipping')}
              disabled={busy}
              className={SECONDARY_BTN}
            >
              Flip direction
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode('accepting')}
            disabled={busy}
            className={SECONDARY_BTN}
          >
            Accept
          </button>
        </div>
      )}

      {mode === 'accepting' && (
        <div className="mt-2 pt-2 border-t border-status-warning/20 space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              claimCount === 1
                ? 'Reason for accepting (required)…'
                : `Reason for accepting all ${claimCount} claims (required)…`
            }
            rows={2}
            className="w-full px-2.5 py-1.5 rounded-sm bg-surface-1 border border-border-default text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => { setMode('idle'); setReason(''); }}
              className="text-[12px] font-medium text-text-muted hover:text-text-secondary transition-colors px-2 py-0.5 border border-border-default rounded"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !reason.trim()}
              onClick={() => adjudicateAll({ action: 'accept', reason: reason.trim() })}
              className="text-[12px] font-medium text-white bg-status-warning hover:bg-status-warning/90 transition-colors rounded-md px-2.5 py-1 disabled:opacity-60"
            >
              {busy ? 'Accepting…' : 'Confirm accept'}
            </button>
          </div>
        </div>
      )}

      {mode === 'flipping' && (
        <div className="mt-2 pt-2 border-t border-status-warning/20 space-y-2">
          <div className="flex items-center gap-3 text-[12px] text-text-secondary">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`flip-${item.subjectKey}`}
                checked={newDirection === 'spec_ahead'}
                onChange={() => setNewDirection('spec_ahead')}
              />
              Spec ahead
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`flip-${item.subjectKey}`}
                checked={newDirection === 'code_ahead'}
                onChange={() => setNewDirection('code_ahead')}
              />
              Code ahead
            </label>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="text-[12px] font-medium text-text-muted hover:text-text-secondary transition-colors px-2 py-0.5 border border-border-default rounded"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => adjudicateAll({ action: 'flip_direction', newDirection })}
              className="text-[12px] font-medium text-white bg-status-warning hover:bg-status-warning/90 transition-colors rounded-md px-2.5 py-1 disabled:opacity-60"
            >
              {busy ? 'Updating…' : 'Confirm flip'}
            </button>
          </div>
        </div>
      )}

      {mode === 'error' && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-status-error min-w-0">{errorMsg}</span>
          <button
            type="button"
            onClick={() => setMode('idle')}
            className="text-[11px] text-text-muted hover:text-text-secondary underline flex-shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
