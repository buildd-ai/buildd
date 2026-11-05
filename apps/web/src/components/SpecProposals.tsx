import Link from 'next/link';
import Card from '@/components/ui/Card';
import { ago } from '@/lib/specs/index-view';
import type { ProposalRow } from '@/lib/specs/proposal-row';

/**
 * Proposals (Living Spec b7fc9316 R-35): drafts an agent wrote that nobody
 * asked for. Not an approval: nothing here waits on you. A mission that
 * selects one, or a task that pins it, moves it to the approval inbox.
 */
export default function SpecProposals({ proposals, now }: { proposals: ProposalRow[]; now?: number }) {
  if (proposals.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="spec-proposals-h" data-testid="spec-proposals">
      <div>
        <h2 id="spec-proposals-h" className="text-title font-semibold text-text-primary">Proposals</h2>
        <p className="text-meta text-text-muted">Drafts an agent wrote unasked. They wait for a mission to select them or a task to pin them; until then they are not in your approvals.</p>
      </div>
      <ul className="flex flex-col gap-2">
        {proposals.map((p) => (
          <li key={p.specId}>
            <Card as={Link} href={`/app/specs/${p.specId}`} interactive padding="sm" className="flex min-h-11 flex-col gap-0.5" data-testid="spec-proposal">
              <span className="text-body font-semibold text-text-primary [overflow-wrap:anywhere]">{p.title}</span>
              <span className="text-meta text-text-muted [overflow-wrap:anywhere]">
                {p.taskTitle ? `Written by “${p.taskTitle}”, ` : 'Written by a task, '}{ago(p.proposedAt, now)}
              </span>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
