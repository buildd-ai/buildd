/**
 * Home's NEEDS YOU column: the owner's asks as a card stack — a mission that
 * just shipped (its result), parked questions with one-tap answers, held
 * missions with Arm — then the rest of the action queue (merge, review,
 * decide, …) as `children`, which page.tsx renders from lib/action-queue.ts.
 */
import Link from 'next/link';
import { Children, type ReactNode } from 'react';
import { shortDuration } from '@/lib/mission-list-card';
import { HeldMissionCard, QuestionCard, type HomeHeldMission, type HomeQuestion } from './NeedsYouCards';

export interface HomeShippedMission {
  id: string;
  title: string;
  href: string;
  completedAt: string;
  prs: number;
  fixes: number;
  durationMs: number | null;
  criteria: { passed: number; total: number } | null;
}

function hhmm(iso: string, tz?: string | null): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}) });
}

function ShippedCard({ m, timeZone }: { m: HomeShippedMission; timeZone?: string | null }) {
  const facts: Array<[string | number, string]> = [
    [m.prs, m.prs === 1 ? 'PR merged' : 'PRs merged'],
    [shortDuration(m.durationMs), 'wall clock'],
    [m.fixes, m.fixes === 1 ? 'auto-fix' : 'auto-fixes'],
  ];
  return (
    <article data-testid="needs-you-card" data-kind="shipped" className="card border-l-[6px] border-l-status-success px-4 py-4 md:px-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-status-success">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 bg-status-success" />
          Shipped · {hhmm(m.completedAt, timeZone)}
        </span>
        {m.criteria && (
          <span className="border border-border-default px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase text-text-secondary">
            {m.criteria.passed}/{m.criteria.total} criteria
          </span>
        )}
      </div>
      <h3 className="truncate font-mono text-[15px] font-semibold text-text-primary">{m.title}</h3>
      <dl className="mt-3.5 grid grid-cols-3 gap-3 border-t border-border-default pt-3.5">
        {facts.map(([v, k]) => (
          <div key={k}>
            <dt className="sr-only">{k}</dt>
            <dd className="font-mono text-[22px] font-semibold leading-none text-text-primary">{v}</dd>
            <dd className="mt-1.5 font-mono text-[11px] uppercase tracking-[1px] text-text-muted">{k}</dd>
          </div>
        ))}
      </dl>
      <Link href={m.href} className="mt-3.5 inline-flex min-h-11 items-center border-2 border-border-strong px-3.5 font-mono text-[12.5px] font-semibold text-text-primary hover:bg-surface-3 md:min-h-9">
        Read summary
      </Link>
    </article>
  );
}

export function NeedsYouStack({
  count,
  questions,
  held,
  shipped,
  timeZone,
  children,
}: {
  count: number;
  questions: readonly HomeQuestion[];
  held: readonly HomeHeldMission[];
  shipped: readonly HomeShippedMission[];
  timeZone?: string | null;
  children?: ReactNode;
}) {
  // page.tsx passes `{cond && <…/>}` children, so "no children" arrives as
  // `[false, false]` — truthy. `Children.toArray` drops false/null/undefined,
  // which is the question that matters: will anything render under the heading?
  const hasChildren = Children.toArray(children).length > 0;
  const empty = questions.length === 0 && held.length === 0 && shipped.length === 0 && !hasChildren;
  return (
    <section data-testid="home-waiting-on-you" className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="section-label text-text-muted">{shipped.length > 0 ? 'Results & needs you' : 'Needs you'}</span>
        {count > 0 && (
          <span data-testid="needs-you-count" className="grid h-7 min-w-7 place-items-center bg-primary px-1.5 font-mono text-[13px] font-bold text-white">
            {count}
          </span>
        )}
      </div>
      <div className="space-y-4">
        {shipped.map(m => <ShippedCard key={m.id} m={m} timeZone={timeZone} />)}
        {questions.map(q => <QuestionCard key={q.workerId} q={q} />)}
        {held.map(m => <HeldMissionCard key={m.id} m={m} />)}
        {children}
        {empty && (
          <p className="font-mono text-[13px] text-text-muted">Nothing waiting on you.</p>
        )}
      </div>
    </section>
  );
}
