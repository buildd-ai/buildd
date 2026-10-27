'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useOptimisticApprove } from '@/components/useOptimisticApprove';
import SpecReplacedChoice, { approvalResultText, retireChoice, type ApprovalRetirementReply } from '@/components/SpecReplacedChoice';
import Lede from '@/components/ui/Lede';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import SpecReviewChanges from '@/components/SpecReviewChanges';
import SpecRevisionPanes from '@/components/SpecRevisionPanes';
import SpecRepoChecksFetch from '@/components/SpecRepoChecksFetch';
import SpecExplanationCheck from '@/components/SpecExplanationCheck';
import type { ApprovalRequestView } from '@/lib/specs/approval-view';
import { needsPasskey, withPasskey } from '@/lib/passkeys/client';
import { PASSKEY_SETTINGS_PATH } from '@/lib/passkeys/paths';

/** What shows while a team's passkey prompt is open (R-20). */
const ASKING = { tone: 'info' as const, text: 'Confirm with your passkey.' };

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
 * a later one opens on the changes. The specs the revision replaces are
 * listed above Approve, "Retire it" checked as the link's choice says (R-77).
 *
 * Without a token it is one row of the Awaiting your approval inbox (Living
 * Spec b7fc9316 R-2 to R-5): the same view, and an Approve pinned to the
 * revision, version and content hash it was rendered with, sent to
 * POST /api/specs/[specId]/approve/inbox. When the spec moved since, the page
 * reloads so the row shows the new head.
 *
 * One decision on one screen (b7fc9316 R-14 to R-19): the author's
 * explanation and its coverage check lead, each change opening in place to its
 * exact words; the change list, gate and full text follow; one Approve sits in
 * a bar that stays in view (above the phone tab bar) while the person reads.
 * Approve waits until the explanation covers every change, or the person has
 * opened each change it does not cover.
 */
export default function SpecApprovalRequest({ specId, token, view, showTitle = true }: { specId: string; token?: string; view: ApprovalRequestView; showTitle?: boolean }) {
  const revision = view.state === 'ready' ? view.revision : 0;
  const replacing = view.state === 'ready' ? view.replacing ?? [] : [];
  const [checked, setChecked] = useState<Set<string>>(() => new Set(replacing.filter((r) => r.checked).map((r) => r.id)));
  const toggle = (id: string) => setChecked((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const router = useRouter();
  const inbox = token === undefined;
  const approvedText = `Approved revision ${view.state === 'ready' ? view.revision : ''}.`;
  const [reason, setReason] = useState('');
  const refused = view.state === 'ready' && !view.gate.passed;
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const toggleOpen = (key: string) => setOpened((o) => { const n = new Set(o); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  // R-18: what still has to be opened before Approve; none when the explanation covers everything.
  const coverage = view.state === 'ready' ? view.coverage : null;
  const unopened = coverage && !coverage.passed ? coverage.notExplained.filter((i) => !opened.has(i.key)).length : 0;
  const passkey = view.state === 'ready' && view.passkey;
  const { shown: result, retry, approve } = useOptimisticApprove(async (update) => {
    const override = refused ? { overrideReason: reason.trim() } : {};
    const retire = retireChoice(replacing, checked);
    // R-20: a team that requires a passkey answers the first press with
    // presence_required; withPasskey runs the prompt and sends again.
    const { res, body } = await withPasskey((presence) => (inbox && view.state === 'ready'
      ? fetch(`/api/specs/${encodeURIComponent(specId)}/approve/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...view.pin, ...(replacing.length ? { retire } : {}), ...override, ...(presence ? { presence } : {}) }),
      })
      : fetch(`/api/specs/${encodeURIComponent(specId)}/approve/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: token, retire, ...override, ...(presence ? { presence } : {}) }),
      })), { onAsk: () => update(ASKING) });
    if (res?.ok) return approvalResultText(revision, body.retirements as ApprovalRetirementReply[] | undefined);
    if (needsPasskey(body)) return { tone: 'warn', text: body.error ?? 'Add a passkey to approve.', action: { label: 'Add a passkey', href: PASSKEY_SETTINGS_PATH } };
    // An inbox row that moved under the person: show the new head.
    if (inbox && body.code === 'stale') router.refresh();
    return { tone: body.code === 'request_stale' || body.code === 'request_expired' || body.code === 'stale' ? 'warn' : 'err', text: body.error ?? 'Approval failed. Try again.' };
  }, approvedText, inbox ? () => router.refresh() : undefined, passkey ? ASKING : undefined);

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

  const needsReason = refused && reason.trim().length < MIN_REASON;
  return (
    <div className="flex flex-col gap-4" data-testid="spec-approval-decision">
      {heading}
      <Lede>
        {view.replaces ? `Revision ${view.revision} replaces revision ${view.replaces}.` : 'Nothing is approved yet.'}
      </Lede>
      {coverage ? (
        <SpecExplanationCheck explanation={view.explanation} coverage={coverage} sectionWords={view.sectionWords} opened={opened} onToggle={toggleOpen} />
      ) : null}
      {view.changes ? (
        <section aria-label="Every change" className="flex flex-col gap-2 border-t border-border-default pt-4">
          <h2 className="text-title font-semibold text-text-primary">Every change</h2>
          <SpecReviewChanges {...view.changes} />
        </section>
      ) : null}
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
      {(!result || retry) ? <SpecReplacedChoice options={replacing} checked={checked} onToggle={toggle} /> : null}
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
      {/* R-14: the one Approve, in a bar that sticks to the bottom of the view
          (above the phone tab bar) for as long as this revision is on screen. */}
      <div
        className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 flex flex-col gap-2 border-t border-border-default bg-surface-1 px-4 py-3 md:bottom-0 md:mx-0 md:flex-row md:items-center md:justify-between md:gap-4 md:px-0"
        data-testid="spec-approval-bar"
      >
        {result ? <Notice tone={result.tone} action={result.action} data-testid="spec-approval-result">{result.text}</Notice> : null}
        {!result || retry ? (
          <>
            <p className="text-meta text-text-secondary [overflow-wrap:anywhere]" data-testid="spec-approval-bar-status">
              {unopened > 0
                ? `Open the ${unopened === 1 ? 'change' : `${unopened} changes`} marked Not explained to approve.`
                : needsReason
                  ? 'Give an override reason of at least 10 characters to approve.'
                  : coverage ? coverage.line : `Revision ${view.revision}`}
            </p>
            <div className="shrink-0">
              <PrimaryAction onClick={approve} disabled={needsReason || unopened > 0} fullWidthOnMobile data-testid="spec-approval-approve">
                {refused ? `Override and approve revision ${view.revision}` : replacing.some((r) => checked.has(r.id)) ? 'Approve and retire' : `Approve revision ${view.revision}`}
              </PrimaryAction>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
