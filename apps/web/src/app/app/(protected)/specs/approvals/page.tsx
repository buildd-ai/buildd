import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { approvalInboxView, type InboxRow } from '@/lib/specs/approval-inbox-view';
import { SPEC_APPROVAL_INBOX_PATH } from '@/lib/specs/approval-inbox';
import SpecApprovalRequest from '@/components/SpecApprovalRequest';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import Disclosure from '@/components/ui/Disclosure';
import Lede from '@/components/ui/Lede';

export const dynamic = 'force-dynamic';

/**
 * Awaiting your approval (Living Spec b7fc9316 R-1 to R-6): every spec
 * revision waiting on the signed-in person, one row each. A row opens onto
 * what the confirm page shows and carries its own Approve, pinned to the
 * revision, version and content hash rendered here. There is no control that
 * approves several rows at once.
 */
export default async function SpecApprovalsPage() {
  const user = await getCurrentUser();
  if (!user) redirect(`/app/auth/signin?callbackUrl=${encodeURIComponent(SPEC_APPROVAL_INBOX_PATH)}`);
  const rows = await approvalInboxView(user.id);
  const n = rows.length;
  return (
    <main className="px-4 pt-[4.5rem] pb-24 md:px-8 md:pt-8 md:pb-10">
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-heading font-semibold text-text-primary">Awaiting your approval</h1>
        <Lede>
          <span data-testid="spec-approvals-lede">
            {n === 0
              ? 'Nothing waits for your approval.'
              : `${n} spec ${n === 1 ? 'revision waits' : 'revisions wait'} for you. Read each one and approve it on its own.`}
          </span>
        </Lede>
        {n > 0 ? (
          <ul className="flex flex-col gap-3" data-testid="spec-approvals-list">
            {rows.map((r) => <li key={r.specId}><InboxRowCard row={r} open={n === 1} /></li>)}
          </ul>
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
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Link href={`/app/specs/${encodeURIComponent(row.specId)}`} className="text-title font-semibold text-text-primary underline-offset-2 hover:underline [overflow-wrap:anywhere]">
          {row.title}
        </Link>
        {gate ? (
          <Chip tone={gate.passed ? (gate.warnings.length ? 'warning' : 'success') : 'error'} data-testid="spec-approvals-gate">
            {gate.passed ? (gate.warnings.length ? 'gate passed, warnings' : 'gate passed') : 'gate refused'}
          </Chip>
        ) : null}
      </div>
      <p className="text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="spec-approvals-line">
        {row.workspaceName} · revision {row.headRevision}{row.approvedRevision ? ` replaces ${row.approvedRevision}` : ', first approval'} · by {row.author}
      </p>
      {row.changeSummary ? <p className="text-body text-text-primary [overflow-wrap:anywhere]">{row.changeSummary}</p> : null}
      {view ? (
        <Disclosure summary={`Review revision ${row.headRevision}`} defaultOpen={open}>
          <div className="pt-2">
            <SpecApprovalRequest specId={row.specId} view={view} showTitle={false} />
          </div>
        </Disclosure>
      ) : (
        <Link href={`/app/specs/${encodeURIComponent(row.specId)}`} className="text-body text-accent-text underline-offset-2 hover:underline">
          Open the spec to review it
        </Link>
      )}
    </Card>
  );
}
