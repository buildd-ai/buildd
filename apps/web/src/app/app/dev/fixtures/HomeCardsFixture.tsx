'use client';

/**
 * `?state=home-cards`: Home's lower half with a busy fleet — phone Home
 * (Just shipped, Agents, Moving toward delivery, Landed) under md, the desktop
 * columns from md up. `&data=empty` is a team with a runner, nothing moving and
 * nothing shipped. The CI clone has no live runner, so this is where the Agents
 * panel is seen populated. Invented data.
 */
import { useEffect, useState } from 'react';
import { AgentsPanel } from '../../(protected)/home/AgentsPanel';
import { DeliveryMilestones } from '../../(protected)/home/DeliveryMilestones';
import { LandedThisWeek, type LandedMission } from '../../(protected)/home/LandedThisWeek';
import { MobileHome } from '../../(protected)/home/MobileHome';
import type { HomeShippedMission } from '../../(protected)/home/NeedsYouStack';
import type { DeliveryCounts, MissionDelivery } from '@/lib/delivery-projection';
import type { OccupancySeries } from '@/lib/fleet-occupancy';
import type { AgentsModel } from '@/lib/home-agents';
import type { IdleStretch } from '@/lib/idle-while-queued';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 9, 15, 0);

const AGENTS: AgentsModel = {
  busy: 3, total: 4, squares: ['busy', 'waiting', 'busy', 'free'],
  lines: [
    { key: 'a', taskId: 'a', name: 'fix(billing): prorate seat changes mid-cycle', rest: '', missionId: 'm1', mission: 'Subscription seats: per-member billing with prorated changes', href: '#', waiting: false, elapsedMs: 74 * 60_000 },
    { key: 'b', taskId: 'b', name: 'feat(search)', rest: 'trigram index on titles', missionId: 'm2', mission: 'Typo-tolerant search', href: '#', waiting: true, elapsedMs: 22 * 60_000 },
    { key: 'c', taskId: 'c', name: 'chore(ci): split the unit job', rest: '', missionId: null, mission: null, href: '#', waiting: false, elapsedMs: 9 * 60_000 },
  ],
};
const AGENTS_IDLE: AgentsModel = { busy: 0, total: 4, squares: ['free', 'free', 'free', 'free'], lines: [] };

function series(levels: number[]): OccupancySeries {
  const bucketMs = 24 * H / levels.length;
  const from = NOW - 24 * H;
  const lvl = (v: number) => ({ avg: v, peak: Math.ceil(v) });
  return {
    windowKey: '24h' as OccupancySeries['windowKey'],
    window: { from, to: NOW },
    bucketMs,
    buckets: levels.map((v, i) => ({ t: from + i * bucketMs, runner: lvl(v), sessions: lvl(0) })),
    summary: { runner: { avg: levels.reduce((a, b) => a + b, 0) / levels.length, peak: Math.max(...levels) }, sessions: lvl(0) },
  };
}
const BUSY_DAY = series([1, 1, 0, 0, 0, 0, 0, 1, 2, 3, 4, 4, 3, 2, 0, 0, 2, 3, 4, 4, 3, 3, 2, 3].flatMap(v => [v, v, v, v]));
const QUIET_DAY = series(Array.from({ length: 96 }, () => 0));
const IDLE: IdleStretch[] = [{ from: NOW - 10 * H, to: NOW - 8 * H, waited: 3 }];

const mission = (m: Pick<MissionDelivery, 'id' | 'title' | 'kind' | 'landed' | 'total' | 'repairRounds' | 'evidence' | 'next' | 'exception'>): MissionDelivery => ({
  href: '#', open: true, inAudit: 1, executing: true, milestones: {} as MissionDelivery['milestones'], focus: null, tasks: [], ...m,
});
const MILESTONES: MissionDelivery[] = [
  mission({ id: 'm3', title: 'First-run checklist', kind: 'landing', landed: 4, total: 4, repairRounds: 0, evidence: 'Every task landed on the mission branch.', next: 'The mission PR merges to trunk', exception: { tone: 'info', text: 'All tasks done, not yet on trunk' } }),
  mission({ id: 'm2', title: 'Typo-tolerant search across missions, tasks and memory, with ranking that prefers recent work', kind: 'audit', landed: 2, total: 5, repairRounds: 0, evidence: 'Trigram index has a PR open; review and CI have not both passed on its latest revision.', next: 'Trigram index lands', exception: null }),
  mission({ id: 'm1', title: 'Subscription seats: per-member billing with prorated changes', kind: 'repair', landed: 6, total: 11, repairRounds: 2, evidence: 'CI failed on Prorate seat changes. An automatic fix is running (round 2).', next: 'Prorate seat changes goes back to audit', exception: null }),
];
const LANDED: LandedMission[] = [
  { id: 'l1', title: 'Refined UI: quieter tokens, shared components, mission pages and chat on one visual language', href: '#', completedAt: new Date(NOW - 8 * H).toISOString(), prs: 9 },
  { id: 'l2', title: 'Runner on arm64', href: '#', completedAt: new Date(NOW - 50 * H).toISOString(), prs: 2 },
];
const SHIPPED: HomeShippedMission[] = [
  { id: 's1', title: 'Refined UI: quieter tokens, shared components, mission pages and chat on one visual language', href: '#', completedAt: new Date(NOW - 8 * H).toISOString(), prs: 9, fixes: 1, durationMs: 46 * H, activeMs: 5 * H + 20 * 60_000, criteria: { passed: 4, total: 4 } },
];
const COUNTS: DeliveryCounts = { openMissions: 11, executingMissions: 3, liveAgents: 3, slots: { used: 3, total: 4 } };
const COUNTS_EMPTY: DeliveryCounts = { openMissions: 0, executingMissions: 0, liveAgents: 0, slots: { used: 0, total: 4 } };

export default function HomeCardsFixture() {
  const [empty, setEmpty] = useState(false);
  useEffect(() => { setEmpty(new URLSearchParams(window.location.search).get('data') === 'empty'); }, []);
  const agents = <AgentsPanel model={empty ? AGENTS_IDLE : AGENTS} occupancy={empty ? QUIET_DAY : BUSY_DAY} idle={empty ? [] : IDLE} />;
  const milestones = empty ? [] : MILESTONES;
  const counts = empty ? COUNTS_EMPTY : COUNTS;
  const landed = <LandedThisWeek missions={empty ? [] : LANDED} timeZone="UTC" />;
  return (
    <main data-testid="home-cards-fixture" className="min-h-screen px-4 pb-20 pt-6 md:px-8 md:pb-8 md:pt-8">
      <MobileHome items={[]} ask={null} agents={agents} landed={landed} counts={counts} milestones={milestones} quietMissions={empty ? 0 : 2} shipped={empty ? [] : SHIPPED} runnerConnected timeZone="UTC" />
      <div className="hidden md:grid md:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)] md:gap-x-14 md:gap-y-7" style={{ gridTemplateAreas: '"moving agents" "moving landed"' }}>
        <div style={{ gridArea: 'moving' }}><DeliveryMilestones missions={milestones} openMissions={counts.openMissions} /></div>
        {agents}
        {landed}
      </div>
    </main>
  );
}
