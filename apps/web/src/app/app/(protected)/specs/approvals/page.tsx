import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { approvalInboxView, otherDraftsView, type InboxRow } from '@/lib/specs/approval-inbox-view';
import { SPEC_APPROVAL_INBOX_PATH, SPEC_REVIEW_ALL_PATH } from '@/lib/specs/approval-inbox';
import { foldedLine } from '@/lib/specs/folded-revisions';
import { rowRevisionLine } from '@/lib/specs/approval-row-line';
import SpecApprovalRequest from '@/components/SpecApprovalRequest';
import SpecShippedLine from '@/components/SpecShippedLine';
import Card from '@/components/ui/Card';
import SpecQuestion from '@/components/SpecQuestion';
import Chip from '@/components/ui/Chip';
import { TIER_CHIP, TIER_WORD } from '@/lib/specs/risk-tier-view';
import Disclosure from '@/components/ui/Disclosure';
import Lede from '@/components/ui/Lede';

export const dynamic = 'force-dynamic';

/**
 * Awaiting your approval (Living Spec b7fc9316 R-1 to R-6): every spec
 * revision waiting on the signed-in person, one row each. A row opens onto
 * what the confirm page shows and carries its own Approve, pinned to the
 * revision, version and content hash rendered here. Approving several at once
 * is the Review all page (R-24), linked from here, where each still goes
 * under its own request.
 */
export default async function SpecApprovalsPage() {
  const user = await getCurrentUser();
  if (!user) redirect(`/app/auth/signin?callbackUrl=${encodeURIComponent(SPEC_APPROVAL_INBOX_PATH)}`);
  const [rows, other] = await Promise.all([approvalInboxView(user.id), otherDraftsView(user.id)]);
  const n = rows.length;
  const judgement = rows.filter((r) => r.risk.level === 'judgement');
  const lowRisk = rows.filter((r) => r.risk.level !== 'judgement');
  return (
    <main className="px-4 pt-[4.5rem] pb-24 md:px-8 md:pt-8 md:pb-10">
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-heading font-semibold text-text-primary">Awaiting your approval</h1>
        <Lede className="max-w-none!">
          <span data-testid="spec-approvals-lede">
            {n === 0
              ? 'Nothing waits for your approval.'
              : `${n} spec ${n === 1 ? 'revision waits' : 'revisions wait'} for you. Read each one and approve it on its own.`}
            {n > 1 ? (
              <>
                {' '}
                <Link href={SPEC_REVIEW_ALL_PATH} className="text-accent-text underline-offset-2 hover:underline" data-testid="spec-approvals-review-all">Review all {n} on one page</Link>
              </>
            ) : null}
          </span>
        </Lede>
        {judgement.length > 0 ? (
          <ul className="flex flex-col gap-3" data-testid="spec-approvals-list">
            {judgement.map((r) => <li key={r.specId}><InboxRowCard row={r} open={n === 1} /></li>)}
          </ul>
        ) : null}
        {lowRisk.length > 0 ? (
          <div data-testid="spec-approvals-low-risk">
            <Disclosure summary={`${lowRisk.length} low-risk ${lowRisk.length === 1 ? 'revision' : 'revisions'}: wording and notes only`} defaultOpen={judgement.length === 0}>
              <p className="pt-2 text-meta text-text-muted">No criterion, credential, permission or approval wording changed. Each still needs its own Approve.</p>
              <ul className="flex flex-col gap-3 pt-3">
                {lowRisk.map((r) => <li key={r.specId}><InboxRowCard row={r} open={n === 1} /></li>)}
              </ul>
            </Disclosure>
          </div>
        ) : null}
        {other.length > 0 ? (
          <div data-testid="spec-approvals-other-lane"><Disclosure summary="Other drafts" count={other.length}>
            <p className="pb-2 text-meta text-text-muted">Charters, experiments and snapshots. Nothing waits on these: they never block a build or a merge.</p>
            <ul className="flex flex-col gap-2" data-testid="spec-approvals-other-list">
              {other.map((r) => (
                <li key={r.specId} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="spec-approvals-other-row" data-spec-id={r.specId}>
                  <Link href={`/app/specs/${encodeURIComponent(r.specId)}`} className="inline-flex min-h-11 items-center text-body text-text-primary underline-offset-2 hover:underline [overflow-wrap:anywhere] md:min-h-0">{r.title}</Link>
                  <Chip tone="muted" data-testid="spec-approvals-kind">{r.kind}</Chip>
                  <span className="text-meta text-text-muted">{r.workspaceName} · revision {r.headRevision}</span>
                </li>
              ))}
            </ul>
          </Disclosure></div>
        ) : null}
      </div>
    </main>
  );
}

function InboxRowCard({ row, open }: { row: InboxRow; open: boolean }) {
  const view = row.view;
  const gate = view?.state === 'ready' ? view.gate : null;
  return (
    <Card className="flex flex-col gap-2" data-testid="spec-approvals-row" data-spec-id={row.specId}>
      <Link href={`/app/specs/${encodeURIComponent(row.specId)}`} className="inline-flex min-h-11 items-center self-start text-title font-semibold text-text-primary underline-offset-2 hover:underline [overflow-wrap:anywhere] md:min-h-0">
        {row.title}
      </Link>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="spec-approvals-badges">
        <Chip tone={TIER_CHIP[row.tier]} data-testid="spec-approvals-tier" title={row.tierReasons.join(' ')}>{TIER_WORD[row.tier]}</Chip>
        <Chip tone="muted" data-testid="spec-approvals-kind">{row.kind}</Chip>
        <Chip tone={row.risk.level === 'judgement' ? 'warning' : 'muted'} data-testid="spec-approvals-risk" data-risk={row.risk.level}>
          {row.risk.level === 'judgement' ? 'needs judgement' : 'low-risk'}
        </Chip>
        {gate ? (
          <Chip tone={gate.passed ? (gate.warnings.length ? 'warning' : 'success') : 'error'} data-testid="spec-approvals-gate">
            {gate.passed ? (gate.warnings.length ? 'gate passed, warnings' : 'gate passed') : 'gate refused'}
          </Chip>
        ) : null}
      </div>
      {row.question ? <SpecQuestion question={row.question} /> : null}
      <p className="text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="spec-approvals-line">
        {row.workspaceName} · {rowRevisionLine(row)} · by {row.author}
      </p>
      {row.risk.level === 'judgement' && row.risk.reasons.length ? (
        <p className="text-meta text-text-secondary [overflow-wrap:anywhere]" data-testid="spec-approvals-risk-reasons">{row.risk.reasons.join(' · ')}</p>
      ) : null}
      {foldedLine(row.foldedRevisions) ? <p className="text-meta text-text-muted" data-testid="spec-approvals-folded">{foldedLine(row.foldedRevisions)}</p> : null}
      {row.coverage ? <p className="text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="spec-approvals-coverage">{row.coverage}</p> : null}
      {row.changeSummary ? <p className="text-body text-text-primary [overflow-wrap:anywhere]">{row.changeSummary}</p> : null}
      <SpecShippedLine shipped={row.shipped} />
      {view ? (
        <Disclosure summary={`Review revision ${row.headRevision}`} defaultOpen={open}>
          <div className="pt-2">
            <SpecApprovalRequest specId={row.specId} view={view} showTitle={false} />
          </div>
        </Disclosure>
      ) : (
        <Link href={`/app/specs/${encodeURIComponent(row.specId)}`} className="inline-flex min-h-11 items-center text-body text-accent-text underline-offset-2 hover:underline md:min-h-0">
          Open the spec to review it
        </Link>
      )}
    </Card>
  );
}
