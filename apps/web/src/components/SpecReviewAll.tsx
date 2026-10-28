'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Card from '@/components/ui/Card';
import Disclosure from '@/components/ui/Disclosure';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import SpecDiffView from '@/components/SpecDiffView';
import { approveAll, approveAllSummary, type ApproveAllItem, type ApproveAllResult, type ConfirmReply } from '@/lib/specs/approve-all';
import type { ReviewAllRow } from '@/lib/specs/review-all-view';

/** One signed request, confirmed on its own: the same endpoint a confirm link uses. */
async function confirmOne(item: ApproveAllItem): Promise<ConfirmReply> {
  const res = await fetch(`/api/specs/${encodeURIComponent(item.specId)}/approve/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request: item.request }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const OUTCOME_WORD = { approved: 'Approved', stale: 'Stale', needs_reason: 'Needs a reason', needs_passkey: 'Needs your passkey', failed: 'Not approved' } as const;

/**
 * Review all (Living Spec b7fc9316 R-24 to R-26): every revision waiting on
 * the person, each with its one-line summary and its diff one tap away, and
 * one Approve all in a bar that stays in view. Approve all sends one request
 * per revision, in order (lib/specs/approve-all.ts); it never sends one
 * request for several.
 */
export default function SpecReviewAll({ rows, initialResult = null, openSpecId = null }: {
  rows: ReviewAllRow[];
  /** Fixtures only: render as if Approve all had already run. */
  initialResult?: ApproveAllResult | null;
  /** Fixtures only: the row whose diff starts open. */
  openSpecId?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [result, setResult] = useState<ApproveAllResult | null>(initialResult);
  const items: ApproveAllItem[] = rows.flatMap((r) => (r.request ? [{ specId: r.specId, title: r.title, revision: r.headRevision, request: r.request }] : []));
  const unsigned = rows.length - items.length;
  const outcomeOf = (specId: string) => result?.outcomes.find((o) => o.item.specId === specId)?.outcome ?? null;

  async function run() {
    setBusy(true);
    setDone(0);
    let n = 0;
    const r = await approveAll(items, async (item) => {
      const reply = await confirmOne(item);
      setDone(++n);
      return reply;
    });
    setResult(r);
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3" data-testid="spec-review-all-list">
        {rows.map((r) => {
          const outcome = outcomeOf(r.specId);
          return (
            <li key={r.specId}>
              <Card className="flex flex-col gap-1" data-testid="spec-review-all-row" data-spec-id={r.specId} data-outcome={outcome ?? undefined}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <Link href={`/app/specs/${encodeURIComponent(r.specId)}`} className="inline-flex min-h-11 items-center text-title font-semibold text-text-primary underline-offset-2 hover:underline [overflow-wrap:anywhere] md:min-h-0">
                    {r.title}
                  </Link>
                  {outcome ? <span className="text-meta text-text-secondary" data-testid="spec-review-all-outcome">{OUTCOME_WORD[outcome]}</span> : null}
                </div>
                <p className="text-body text-text-primary [overflow-wrap:anywhere]" data-testid="spec-review-all-summary">
                  {r.summary ?? 'No summary was written for this revision. Open the diff to see what changes.'}
                </p>
                <p className="text-meta text-text-muted [overflow-wrap:anywhere]">
                  {r.workspaceName} · revision {r.headRevision}{r.approvedRevision ? ` replaces ${r.approvedRevision}` : ', first approval'} · by {r.author}
                  {r.diff ? ` · +${r.diff.linesAdded} −${r.diff.linesRemoved}` : ''}
                </p>
                <Disclosure summary="Show the diff" defaultOpen={openSpecId === r.specId}>
                  <div className="pt-2" data-testid="spec-review-all-diff">
                    {r.diff
                      ? <SpecDiffView hunks={r.diff.hunks} omittedLines={r.diff.omittedLines} />
                      : <p className="text-body text-text-secondary">The diff could not be read. Open the spec to review it.</p>}
                  </div>
                </Disclosure>
              </Card>
            </li>
          );
        })}
      </ul>
      {/* R-24: one Approve all, in a bar that stays in view (above the phone tab bar). */}
      <div
        className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 flex flex-col gap-2 border-t border-border-default bg-surface-1 px-4 py-3 md:bottom-0 md:mx-0 md:flex-row md:items-center md:justify-between md:gap-4 md:px-0"
        data-testid="spec-review-all-bar"
      >
        {result ? (
          <Notice tone={result.stale || result.other ? 'warn' : 'ok'} action={{ label: 'Reload', onClick: () => router.refresh() }} data-testid="spec-review-all-result">
            {approveAllSummary(result)}
          </Notice>
        ) : (
          <>
            <p className="text-meta text-text-secondary [overflow-wrap:anywhere]" data-testid="spec-review-all-status">
              {busy
                ? `Approving ${done} of ${items.length}…`
                : unsigned
                  ? 'Approval requests cannot be signed on this deployment. Approve each one from the inbox.'
                  : `Approves each of the ${items.length} revisions on its own request. One that changed since this page loaded is not approved.`}
            </p>
            <div className="shrink-0">
              <PrimaryAction onClick={run} disabled={busy || items.length === 0 || unsigned > 0} fullWidthOnMobile data-testid="spec-review-all-approve">
                {`Approve all ${items.length}`}
              </PrimaryAction>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
