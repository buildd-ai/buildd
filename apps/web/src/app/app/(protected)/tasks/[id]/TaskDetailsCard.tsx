import Link from 'next/link';

export interface DetailsTaskLink {
  id: string;
  title: string;
  href: string;
}

/**
 * Details, open on the page above Run (Navigation: one place per task, R-9;
 * design 6356e80d `phone-task-running`): what the task fixes (its criteria
 * and the spec, by name), what it waits on and what it blocks (by name), and
 * its attempt. A row with nothing to say is left out.
 */
export default function TaskDetailsCard({ fixes, waitsOn, blocks, attempt }: {
  fixes: { criteria: string[]; title: string; href: string | null } | null;
  waitsOn: DetailsTaskLink[];
  blocks: DetailsTaskLink[];
  /** `1`, or `2 · 14m` once the task has a time to show. */
  attempt: string;
}) {
  return (
    <section aria-label="Details" data-testid="task-details-card" className="card mb-4 px-4 py-3 md:px-6 md:py-4">
      <h2 className="pb-2 text-meta text-text-muted">Details</h2>
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] md:grid-cols-[90px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-body">
        {fixes && (
          <div className="contents" data-testid="task-fixes">
            <dt className="text-text-muted">Fixes</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">
              {fixes.criteria.map(c => (
                <span key={c} className="mr-1.5 inline-block rounded-[4px] border border-border-default px-1.5 font-mono text-chip text-text-muted">{c}</span>
              ))}
              {fixes.href ? <Link href={fixes.href} className="text-accent-text hover:underline">{fixes.title}</Link> : <span>{fixes.title}</span>}
            </dd>
          </div>
        )}
        {waitsOn.length > 0 && (
          <div className="contents" data-testid="task-waits-on">
            <dt className="text-text-muted">Waits on</dt>
            <dd className="min-w-0"><TaskLinks tasks={waitsOn} /></dd>
          </div>
        )}
        {blocks.length > 0 && (
          <div className="contents" data-testid="task-unblocked">
            <dt className="text-text-muted">Blocks</dt>
            <dd className="min-w-0"><TaskLinks tasks={blocks} /></dd>
          </div>
        )}
        <dt className="text-text-muted">Attempt</dt><dd className="min-w-0 tabular-nums">{attempt}</dd>
      </dl>
    </section>
  );
}

function TaskLinks({ tasks }: { tasks: DetailsTaskLink[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {tasks.map(t => (
        <li key={t.id} className="min-w-0 [overflow-wrap:anywhere]">
          <Link href={t.href} className="text-accent-text hover:underline">{t.title}</Link>
        </li>
      ))}
    </ul>
  );
}
