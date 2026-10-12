'use client';

import { useState } from 'react';
import Lede from '@/components/ui/Lede';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import SpecRevisionPanes from '@/components/SpecRevisionPanes';
import type { ApprovalRequestView } from '@/lib/specs/approval-view';

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
 */
export default function SpecApprovalRequest({ specId, token, view }: { specId: string; token: string; view: ApprovalRequestView }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);

  const heading = 'title' in view ? (
    <h1 className="font-voice text-2xl text-text-primary" data-testid="spec-approval-title">{view.title}</h1>
  ) : null;

  if (view.state !== 'ready') {
    const closed = CLOSED[view.state];
    return (
      <div className="flex flex-col gap-4">
        {heading}
        <Notice tone={closed.tone} data-testid="spec-approval-state">
          {view.state === 'approved' ? `Revision ${view.revision} is in force.` : closed.text}
        </Notice>
      </div>
    );
  }

  async function approve() {
    setPending(true);
    try {
      const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/approve/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: token }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (res.ok) setResult({ tone: 'ok', text: `Approved. Revision ${view.state === 'ready' ? view.revision : ''} is in force.` });
      else setResult({ tone: body.code === 'request_stale' || body.code === 'request_expired' ? 'warn' : 'err', text: body.error ?? 'Approval failed.' });
    } catch {
      setResult({ tone: 'err', text: 'Approval failed. Try again.' });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {heading}
      <Lede>
        {view.replaces ? `Revision ${view.revision} replaces revision ${view.replaces}.` : `Revision ${view.revision} is the first to be approved.`}
      </Lede>
      <SpecRevisionPanes
        body={view.body}
        hunks={view.hunks}
        omittedLines={view.omittedLines}
        sectionCount={view.sections.length}
        linesAdded={view.sections.reduce((n, x) => n + x.linesAdded, 0)}
        linesRemoved={view.sections.reduce((n, x) => n + x.linesRemoved, 0)}
        initial={view.replaces ? 'changes' : 'spec'}
      />
      {result ? (
        <Notice tone={result.tone} data-testid="spec-approval-result">{result.text}</Notice>
      ) : (
        <div>
          <PrimaryAction onClick={approve} pending={pending} fullWidthOnMobile data-testid="spec-approval-approve">
            Approve revision {view.revision}
          </PrimaryAction>
        </div>
      )}
    </div>
  );
}
