'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useOptimisticApprove } from '@/components/useOptimisticApprove';
import Lede from '@/components/ui/Lede';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import SpecReviewChanges from '@/components/SpecReviewChanges';
import SpecRevisionPanes from '@/components/SpecRevisionPanes';
import SpecRepoChecksFetch from '@/components/SpecRepoChecksFetch';
import type { ApprovalRequestView } from '@/lib/specs/approval-view';

/** The shortest reason that overrides a gate refusal (lib/specs/approval.ts MIN_OVERRIDE_REASON). */
const MIN_REASON = 10;

/** States with nothing to approve: one line each. */
const CLOSED: Record<Exclude<ApprovalRequestView['state'], 'ready'>, { tone: 'info' | 'warn' | 'ok' | 'err'; text: string }> = {
  invalid: { tone: 'err', text: 'This approval link is not valid.' },
  expired: { tone: 'warn', text: 'This approval link has expired. Ask for a new one.' },
  not_found: { tone: 'err', text: 'Spec not found.' },
  not_approver: { tone: 'warn', text: 'Only an owner, an admin or a named approver can approve this spec.' },
  stale: { tone: 'warn', text: 'The spec changed after this approval was asked for. Ask for a new link.' },
  approved: { tone: 'ok', text: 'Approved.' },
};

/**
 * The confirm step for a spec approval asked for over MCP or chat: the
 * revision itself (rendered Markdown) or what it changes (a numbered diff),
 * and one Approve action that sends the request token to
 * POST /api/specs/[specId]/approve/confirm from this signed-in session.
 * A first approval opens on the spec, since its diff is every line added;
 * a later one opens on the changes.
 *
 * Without a token it is one row of the Awaiting your approval inbox (Living
 * Spec b7fc9316 R-2 to R-5): the same view, and an Approve pinned to the
 * revision, version and content hash it was rendered with, sent to
 * POST /api/specs/[specId]/approve/inbox. When the spec moved since, the page
 * reloads so the row shows the new head.
 */
export default function SpecApprovalRequest({ specId, token, view, showTitle = true }: { specId: string; token?: string; view: ApprovalRequestView; showTitle?: boolean }) {
  const router = useRouter();
  const inbox = token === undefined;
  const approvedText = `Approved revision ${view.state === 'ready' ? view.revision : ''}.`;
  const [reason, setReason] = useState('');
  const refused = view.state === 'ready' && !view.gate.passed;
  const { shown: result, retry, approve } = useOptimisticApprove(async () => {
    const override = refused ? { overrideReason: reason.trim() } : {};
    const res = inbox && view.state === 'ready'
      ? await fetch(`/api/specs/${encodeURIComponent(specId)}/approve/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...view.pin, ...override }),
      })
      : await fetch(`/api/specs/${encodeURIComponent(specId)}/approve/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: token, ...override }),
      });
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (res.ok) return { tone: 'ok', text: approvedText };
    // An inbox row that moved under the person: show the new head.
    if (inbox && body.code === 'stale') router.refresh();
    return { tone: body.code === 'request_stale' || body.code === 'request_expired' || body.code === 'stale' ? 'warn' : 'err', text: body.error ?? 'Approval failed. Try again.' };
  }, approvedText, inbox ? () => router.refresh() : undefined);

  const heading = showTitle && 'title' in view ? (
    <h1 className="font-voice text-2xl text-text-primary" data-testid="spec-approval-title">{view.title}</h1>
  ) : null;

  if (view.state !== 'ready') {
    const closed = CLOSED[view.state];
    return (
      <div className="flex flex-col gap-4">
        {heading}
        <Notice tone={closed.tone} data-testid="spec-approval-state">
          {view.state === 'approved' ? `Revision ${view.revision} is approved.` : closed.text}
        </Notice>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {heading}
      <Lede>
        {view.replaces ? `Revision ${view.revision} replaces revision ${view.replaces}.` : 'Nothing is approved yet.'}
      </Lede>
      {view.changes ? <SpecReviewChanges {...view.changes} /> : null}
      <section className="flex flex-col gap-2" aria-label="Quality gate" data-testid="spec-approval-gate">
        {view.gate.passed && !view.gate.warnings.length ? <Notice tone="ok">Quality gate passed.</Notice> : null}
        {view.gate.refusals.length ? (
          <Notice tone="err" title="Quality gate failed" data-testid="spec-approval-refusals">
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {view.gate.refusals.map((f) => <li key={f.code} data-code={f.code} className="[overflow-wrap:anywhere]">{f.message}</li>)}
            </ul>
          </Notice>
        ) : null}
        {view.gate.warnings.length ? (
          <Notice tone="warn" title={view.gate.passed ? 'Quality gate passed, with warnings' : 'Warnings'} data-testid="spec-approval-warnings">
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {view.gate.warnings.map((f) => <li key={f.code} data-code={f.code} className="[overflow-wrap:anywhere]">{f.message}</li>)}
            </ul>
          </Notice>
        ) : null}
        {refused && (!result || retry) ? (
          <label className="flex flex-col gap-1 text-body text-text-primary">
            Override reason (recorded on the approval)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              className="border border-border-default bg-surface-1 px-2 py-1 text-body text-text-primary"
              data-testid="spec-approval-override-reason"
            />
          </label>
        ) : null}
      </section>
      {result ? <Notice tone={result.tone} data-testid="spec-approval-result">{result.text}</Notice> : null}
      {!result || retry ? (
        <div>
          <PrimaryAction onClick={approve} disabled={refused && reason.trim().length < MIN_REASON} fullWidthOnMobile data-testid="spec-approval-approve">
            {refused ? 'Override and approve' : 'Approve'} revision {view.revision}
          </PrimaryAction>
        </div>
      ) : null}
      {view.repoChecks ? <SpecRepoChecksFetch specId={specId} /> : null}
      <SpecRevisionPanes
        body={view.body}
        hunks={view.hunks}
        omittedLines={view.omittedLines}
        sectionCount={view.sections.length}
        linesAdded={view.sections.reduce((n, x) => n + x.linesAdded, 0)}
        linesRemoved={view.sections.reduce((n, x) => n + x.linesRemoved, 0)}
        initial={view.replaces ? 'changes' : 'spec'}
        attachments={view.attachments}
      />
    </div>
  );
}
