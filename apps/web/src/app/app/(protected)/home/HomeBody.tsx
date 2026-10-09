'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { homeAttentionCopy, type HomeAttentionItem } from '@/lib/home-needs-you';
import { admitWaitingTasks } from '@/lib/home-attention';
import { publishHomeAttentionCount } from '@/lib/home-attention-store';
import { useHideNeedsInputBannerOnPhone } from '@/lib/needs-input-hidden';
import { useNeedsInput } from '@/components/needs-input-context';
import { needsInputTaskHref } from '@/components/NeedsInputBanner';
import { DecisionCard } from './DecisionCard';
import type { HomeShippedMission } from './NeedsYouStack';
import { shippedDurationFacts, shippedSummaryHref } from './NeedsYouStack';
import { DeliveryMilestones } from './DeliveryMilestones';
import type { DeliveryCounts, MissionDelivery } from '@/lib/delivery-projection';

/** Desktop: Moving left, Agents over Landed right. Phone: Agents, Moving, Landed. */
const BODY_GRID = {
  split: "grid gap-x-8 gap-y-8 [grid-template-areas:'agents'_'moving'_'landed'] min-[900px]:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)] min-[900px]:grid-rows-[auto_1fr] min-[900px]:[grid-template-areas:'moving_agents'_'moving_landed']",
  side: "grid gap-x-8 gap-y-8 [grid-template-areas:'agents'_'landed'] min-[900px]:grid-cols-2 min-[900px]:[grid-template-areas:'agents_landed']",
  single: 'flex flex-col gap-8',
} as const;

/** "7 more missions are waiting on capacity or another mission." */
export function quietMissionsLine(n: number): string {
  return n === 1 ? '1 more mission is waiting on capacity or another mission.' : `${n} more missions are waiting on capacity or another mission.`;
}

function JustShipped({ m, timeZone }: { m: HomeShippedMission; timeZone?: string | null }) {
  const at = new Date(m.completedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
  const facts = [[m.prs, m.prs === 1 ? 'PR merged' : 'PRs merged'] as const, ...shippedDurationFacts(m)].slice(0, 3);
  return <section data-testid="just-shipped" aria-labelledby="home-shipped-h" className="mb-8">
    <h2 id="home-shipped-h" className="section-label mb-2">Just shipped</h2>
    <Link href={shippedSummaryHref(m.href)} className="group flex min-h-11 flex-wrap items-baseline gap-x-3 gap-y-1 border-y border-border-default py-2.5">
      <span aria-hidden="true" className="text-status-success">✓</span>
      <span className="min-w-0 flex-1 text-body font-medium text-text-primary group-hover:underline">{m.title}</span>
      <dl className="flex flex-wrap gap-x-3 font-mono text-meta text-text-muted">
        <div className="flex gap-1"><dt className="sr-only">shipped</dt><dd>{at}</dd></div>
        {m.criteria && <div className="flex gap-1"><dt className="sr-only">criteria</dt><dd>{m.criteria.passed}/{m.criteria.total} criteria</dd></div>}
        {facts.map(([value, label]) => <div key={label} className="flex gap-1"><dd>{value}</dd><dt>{label}</dt></div>)}
      </dl>
      <span className="text-meta text-text-secondary">Read summary →</span>
    </Link>
  </section>;
}

/**
 * Home at every width: the headline, the one list of decisions (derived from
 * lib/action-queue.ts via deriveHomeAttention), what just shipped, then
 * Agents, Moving toward delivery and Landed this week. The headline count is
 * the list's length; phones stack the cards, wider screens set them side by side.
 */
export function HomeBody({ agents = null, landed = null, items: serverItems, ask, counts, milestones, quietMissions, shipped, setup = null, runnerConnected, timeZone, aside = null, lead = null, foot = null }: {
  items: HomeAttentionItem[]; ask: ReactNode;
  /** The Agents panel and Landed this week (null when nothing landed): after the decisions, Moving between them. */
  agents?: ReactNode; landed?: ReactNode;
  /** The getting-started checklist and chat setup while they apply: a new team's next step. */
  setup?: ReactNode;
  /** Beside the headline on wide screens (the clock, + Mission). */
  aside?: ReactNode;
  /** Above the cards (initiative chips) and below them (overflow notes). */
  lead?: ReactNode; foot?: ReactNode;
  /** false when the team has no runner: there is no fleet to be working without you. */
  runnerConnected?: boolean;
  /** The count contracts (lib/delivery-projection.ts `deliveryCounts`). */
  counts: DeliveryCounts;
  /** 2–3 missions moving toward delivery (`selectHomeMilestones`). */
  milestones: MissionDelivery[];
  /** Open missions waiting on capacity or another mission: named, never listed. */
  quietMissions: number;
  shipped: HomeShippedMission[]; timeZone?: string | null;
}) {
  const [done, setDone] = useState<Record<string, string>>({});
  // Optimism covers only this snapshot. Fresh server truth wins after every refresh.
  useEffect(() => { setDone({}); }, [serverItems]);
  // One list of what needs you: every task the global banner would name is in
  // it, so the banner steps aside on a phone instead of naming a second list.
  const { tasks: waiting } = useNeedsInput();
  const items = useMemo(() => admitWaitingTasks(serverItems, waiting, needsInputTaskHref), [serverItems, waiting]);
  useHideNeedsInputBannerOnPhone(true);
  const open = items.filter(i => !done[i.key]);
  const copy = homeAttentionCopy(open, { runnerConnected });
  useEffect(() => { publishHomeAttentionCount(copy.count); }, [copy.count]);
  // Systemic causes first: one problem behind many tasks is not a per-task decision.
  const ordered = [...items.filter(i => i.systemic), ...items.filter(i => !i.systemic)];
  const m = shipped[0];
  const agentsCount = `${counts.liveAgents} agent${counts.liveAgents === 1 ? '' : 's'} working`;
  const layout: keyof typeof BODY_GRID = milestones.length > 0
    ? (agents || landed ? 'split' : 'single')
    : agents && landed ? 'side' : 'single';
  return <div data-testid="home" className="text-text-primary">
    <header className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        <p data-testid="home-counts" className="mb-3 text-body text-text-muted">{agentsCount}{counts.slots.total > 0 ? ` · ${counts.slots.used}/${counts.slots.total} slots` : ''} · {counts.openMissions} open mission{counts.openMissions === 1 ? '' : 's'}</p>
        {copy.count === 0 && !setup
          ? <><h1 className="sr-only">Home</h1><p data-testid="home-all-clear" role="status" className="flex flex-wrap items-baseline gap-x-2 border-b border-border-default py-3 font-voice text-lede"><span aria-hidden="true" className="font-bold text-status-success">✓</span>All clear.<span className="font-convo text-meta text-text-muted">Buildd will ask if a decision comes up.</span></p></>
          : <><h1 data-testid="home-headline" className="font-voice text-display font-medium normal-case tracking-normal">{copy.headline}</h1>
            <p data-testid="home-subline" className="mt-2 font-voice text-lede italic text-text-secondary">{copy.subline}</p></>}
      </div>
      {aside}
    </header>
    {ask}
    {setup}
    {(items.length > 0 || lead) && <section data-testid="home-waiting-on-you" aria-labelledby="home-needs-you-h" className="mb-8">
      <div className="mb-3 flex items-center justify-between"><h2 id="home-needs-you-h" className="section-label">Needs you</h2><span data-testid="needs-you-count" className="text-meta text-text-muted">{copy.count} open</span></div>
      {lead}
      {items.length > 0 && <div data-testid="needs-you-cards" className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr))]">{ordered.map(item => done[item.key] ? <p key={item.key} className="flex gap-2 border-b border-border-default py-3 text-body"><i className="mt-1 h-2 w-2 shrink-0 bg-status-success" /><Link href={item.href}>{done[item.key]} · {item.title}</Link></p> : <DecisionCard key={item.key} item={item} onDone={(key, label) => setDone(prev => ({ ...prev, [key]: label }))} />)}</div>}
      {quietMissions > 0 && items.length > 0 && <p data-testid="home-quiet-missions" className="mt-3 text-meta text-text-muted">{quietMissionsLine(quietMissions)}</p>}
      {foot}
    </section>}
    {m && <JustShipped m={m} timeZone={timeZone} />}
    <div data-testid="home-body" data-layout={layout} className={BODY_GRID[layout]}>
      {agents}
      {milestones.length > 0 && <div style={{ gridArea: 'moving' }} className="min-w-0"><DeliveryMilestones missions={milestones} openMissions={counts.openMissions} /></div>}
      {landed}
    </div>
    <Link href="/app/tasks" className="mt-8 inline-flex min-h-11 items-center text-body text-text-secondary">See everything in motion in Activity →</Link>
  </div>;
}
