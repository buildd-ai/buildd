'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { homeAttentionCopy, type HomeAttentionItem } from '@/lib/home-needs-you';
import { admitWaitingTasks } from '@/lib/home-attention';
import { publishHomeAttentionCount } from '@/lib/home-attention-store';
import { useHideNeedsInputBanner } from '@/lib/needs-input-hidden';
import { useNeedsInput } from '@/components/needs-input-context';
import { needsInputTaskHref } from '@/components/NeedsInputBanner';
import { DecisionCard } from './DecisionCard';
import { NeedsYouRows, PolicyDigests } from './NeedsYouRows';
import { layoutNeedsYou } from './needs-you-layout';
import { DeliveryMilestones } from './DeliveryMilestones';
import type { DeliveryCounts, MissionDelivery } from '@/lib/delivery-projection';

/** Desktop: Moving left, Agents over Landed right. Phone: Agents, Moving, Landed. */
const BODY_GRID = {
  split: "grid gap-x-8 gap-y-8 [grid-template-areas:'agents'_'moving'_'landed'] min-[900px]:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)] min-[900px]:grid-rows-[auto_1fr] min-[900px]:[grid-template-areas:'moving_agents'_'moving_landed']",
  side: "grid gap-x-8 gap-y-8 [grid-template-areas:'agents'_'landed'] min-[900px]:grid-cols-2 min-[900px]:[grid-template-areas:'agents_landed']",
  single: 'flex flex-col gap-8',
} as const;

/** "Also in progress: 2 reviews wait on a repair or checks." */
export function inProgressLine(n: number): string {
  return n === 1 ? 'Also in progress: 1 review waits on a repair or checks.' : `Also in progress: ${n} reviews wait on a repair or checks.`;
}

/** Card columns by how many there are, so a row of cards never leaves a hole. */
const CARD_COLS = ['', '', 'md:grid-cols-2', 'min-[1100px]:grid-cols-3'] as const;

/** "7 more missions are waiting on capacity or another mission." */
export function quietMissionsLine(n: number): string {
  return n === 1 ? '1 more mission is waiting on capacity or another mission.' : `${n} more missions are waiting on capacity or another mission.`;
}

/**
 * Home at every width: the headline, the one list of decisions (derived from
 * lib/action-queue.ts via deriveHomeAttention), one quiet line naming what
 * else is moving (with the way to Activity), then Agents, Moving toward
 * delivery and Landed this week. The headline count is the list's length and
 * the number every nav badge shows. At most three decisions get the L3 card
 * (side by side on wide screens, stacked on phones); the rest are hairline
 * rows with one text action, grouped where they ask the same thing. Nothing here repeats another section: no counts line
 * (Agents and Moving carry them), no Just shipped (Landed lists it first).
 */
export function HomeBody({ agents = null, landed = null, items: serverItems, ask, counts, milestones, quietMissions, inProgress = 0, setup = null, runnerConnected, lead = null, foot = null }: {
  items: HomeAttentionItem[]; ask: ReactNode;
  /** Human reviews held back while Buildd still repairs or checks their PRs (`deriveHomeNeedsYou`). */
  inProgress?: number;
  /** The Agents panel and Landed this week (null when nothing landed): after the decisions, Moving between them. */
  agents?: ReactNode; landed?: ReactNode;
  /** The getting-started checklist and chat setup while they apply: a new team's next step. */
  setup?: ReactNode;
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
}) {
  const [done, setDone] = useState<Record<string, string>>({});
  // Optimism covers only this snapshot. Fresh server truth wins after every refresh.
  useEffect(() => { setDone({}); }, [serverItems]);
  // One list of what needs you: every task the global banner would name is in
  // it, so the banner steps aside on Home (every width) instead of naming a second list.
  const { tasks: waiting } = useNeedsInput();
  const items = useMemo(() => admitWaitingTasks(serverItems, waiting, needsInputTaskHref), [serverItems, waiting]);
  useHideNeedsInputBanner(true);
  const open = items.filter(i => !done[i.key]);
  const copy = homeAttentionCopy(open, { runnerConnected });
  useEffect(() => { publishHomeAttentionCount(copy.count); }, [copy.count]);
  // A few decisions get the card; the rest are rows (systemic, failing, oldest first).
  const { cards, rows, digests } = layoutNeedsYou(items);
  const doneLine = (item: HomeAttentionItem) => <p key={item.key} className="flex gap-2 border-b border-border-default py-3 text-body"><i className="mt-1 h-2 w-2 shrink-0 bg-status-success" /><Link href={item.href}>{done[item.key]} · {item.title}</Link></p>;
  const layout: keyof typeof BODY_GRID = milestones.length > 0
    ? (agents || landed ? 'split' : 'single')
    : agents && landed ? 'side' : 'single';
  return <div data-testid="home" className="text-text-primary">
    <header className="mb-6">
      <div className="min-w-0">
        {copy.count === 0 && !setup
          ? <><h1 className="sr-only">Home</h1><p data-testid="home-all-clear" role="status" className="flex flex-wrap items-baseline gap-x-2 border-b border-border-default py-3 font-voice text-lede"><span aria-hidden="true" className="font-bold text-status-success">✓</span>All clear.<span className="font-convo text-meta text-text-muted">Buildd will ask if a decision comes up.</span></p></>
          : <><h1 data-testid="home-headline" className="font-voice text-display font-medium normal-case tracking-normal">{copy.headline}</h1>
            <p data-testid="home-subline" className="mt-2 font-voice text-lede italic text-text-secondary">{copy.subline}</p></>}
      </div>
    </header>
    {ask}
    {setup}
    {(items.length > 0 || lead) && <section data-testid="home-waiting-on-you" aria-labelledby="home-needs-you-h" className="mb-8">
      {/* The headline is this section's visible header and count. */}
      <h2 id="home-needs-you-h" className="sr-only">Needs you</h2>
      {lead}
      {cards.length > 0 && <div data-testid="needs-you-cards" className={`grid gap-4 ${CARD_COLS[cards.length]}`}>{cards.map(item => done[item.key] ? doneLine(item) : <DecisionCard key={item.key} item={item} onDone={(key, label) => setDone(prev => ({ ...prev, [key]: label }))} />)}</div>}
      {digests.length > 0 && <PolicyDigests digests={digests} />}
      {rows.length > 0 && <NeedsYouRows rows={rows} />}
      {foot}
    </section>}
    {/* What is not listed, and where it is: one line, the only Activity link on Home. */}
    <p data-testid="home-also" className="mb-8 text-meta text-text-muted">
      {inProgress > 0 && <>{inProgressLine(inProgress)}{' '}</>}
      {quietMissions > 0 ? quietMissionsLine(quietMissions) : inProgress > 0 ? '' : 'Everything else in motion is in Activity.'}{' '}
      <Link href="/app/tasks" className="inline-flex min-h-11 items-center text-text-secondary hover:text-text-primary md:min-h-0">Activity →</Link>
    </p>
    <div data-testid="home-body" data-layout={layout} className={BODY_GRID[layout]}>
      {agents}
      {milestones.length > 0 && <div style={{ gridArea: 'moving' }} className="min-w-0"><DeliveryMilestones missions={milestones} openMissions={counts.openMissions} /></div>}
      {landed}
    </div>
  </div>;
}
