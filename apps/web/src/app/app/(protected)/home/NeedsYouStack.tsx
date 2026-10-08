/**
 * Home's NEEDS YOU column: the owner's asks as a card stack — a mission that
 * just shipped (its result), parked questions with one-tap answers, held
 * missions with Arm — then the rest of the action queue (merge, review,
 * decide, …) as `children`, which page.tsx renders from lib/action-queue.ts.
 */
import Link from 'next/link';
import { Children, type ReactNode } from 'react';
import { describeMissionDuration } from '@/lib/mission-duration';
import { HeldMissionCard, QuestionCard, type HomeHeldMission, type HomeQuestion } from './NeedsYouCards';

export interface HomeShippedMission {
  id: string;
  title: string;
  href: string;
  completedAt: string;
  prs: number;
  fixes: number;
  durationMs: number | null;
  /** Wall time agents worked; the card says it apart from the open span when they differ. */
  activeMs?: number | null;
  criteria: { passed: number; total: number } | null;
  /** The mission's latest visual review, when it had one. */
  screens?: { shots: number; ok: number; issues: number; unsure: number } | null;
}

function hhmm(iso: string, tz?: string | null): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}) });
}

/** `40m of work` + `35d open`; just the work when the two are about the same. */
export function shippedDurationFacts(m: Pick<HomeShippedMission, 'activeMs' | 'durationMs'>): Array<[string, string]> {
  if (m.durationMs == null) return [];
  const d = describeMissionDuration({ activeMs: m.activeMs === undefined ? m.durationMs : m.activeMs, openMs: m.durationMs });
  if (d.work == null) return [[d.open, 'open']];
  return d.showOpen ? [[d.work, 'of work'], [d.open, 'open']] : [[d.work, 'of work']];
}

/** "Learn more" lands on the mission page's What shipped header. */
export function shippedSummaryHref(href: string): string {
  return href.includes('#') ? href : `${href}#what-shipped`;
}

function ShippedCard({ m, timeZone }: { m: HomeShippedMission; timeZone?: string | null }) {
  // What happened, not a CI tally: "0 auto-fixes" is not an outcome.
  const screens = m.screens && m.screens.shots > 0 ? m.screens : null;
  const facts: Array<[string | number, string]> = [
    [m.prs, m.prs === 1 ? 'PR merged' : 'PRs merged'],
    ...shippedDurationFacts(m),
    ...(m.fixes > 0 ? [[m.fixes, m.fixes === 1 ? 'auto-fix' : 'auto-fixes'] as [number, string]] : []),
    ...(screens
      ? [[`${screens.ok}/${screens.shots}`, 'screens ok'] as [string, string]]
      : []),
  ];
  return (
    <article data-testid="needs-you-card" data-kind="shipped" className="card border-l-[6px] border-l-status-success px-4 py-4 md:px-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-status-success">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 bg-status-success" />
          Shipped at {hhmm(m.completedAt, timeZone)}
        </span>
        {m.criteria && (
          <span className="border border-border-default px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase text-text-secondary">
            {m.criteria.passed}/{m.criteria.total} criteria
          </span>
        )}
      </div>
      <h3 className="truncate font-mono text-[15px] font-semibold text-text-primary">{m.title}</h3>
      <dl className={`mt-3.5 grid gap-3 border-t border-border-default pt-3.5 ${facts.length > 3 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}>
        {facts.map(([v, k]) => (
          <div key={k}>
            <dt className="sr-only">{k}</dt>
            <dd className="font-mono text-[22px] font-semibold leading-none text-text-primary">{v}</dd>
            <dd className="mt-1.5 font-mono text-[11px] uppercase tracking-[1px] text-text-muted">{k}</dd>
          </div>
        ))}
      </dl>
      <Link href={shippedSummaryHref(m.href)} className="mt-3.5 inline-flex min-h-11 items-center border-2 border-border-strong px-3.5 font-mono text-[12.5px] font-semibold text-text-primary hover:bg-surface-3 md:min-h-9">
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
  // Children are not all asks: the action queue also carries IN FLIGHT cards
  // (the platform's next move, not yours). So "nothing needs you" is the count
  // — the same number as the headline and the stat — not "no children".
  // Without this the heading sat over nothing but "IN FLIGHT 1".
  const nothingNeedsYou = count === 0 && questions.length === 0 && held.length === 0;
  const empty = nothingNeedsYou && shipped.length === 0 && !hasChildren;
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
        {(empty || (nothingNeedsYou && hasChildren)) && (
          <p data-testid="needs-you-empty" className="font-mono text-[13px] text-text-muted">Nothing needs input.</p>
        )}
        {children}
      </div>
    </section>
  );
}
