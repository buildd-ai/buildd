'use client';

/**
 * `?state=home-cards`: Home with a busy fleet, the same tree at every width:
 * eight decisions, Just shipped, Agents, Moving toward delivery and Landed.
 * `&data=one` is one decision; `&data=empty` is a team with a runner, nothing
 * moving, nothing shipped and nothing to decide. The CI clone has no live
 * runner or queue, so this is where both are seen populated. Invented data.
 */
import { useEffect, useState } from 'react';
import { AgentsPanel } from '../../(protected)/home/AgentsPanel';
import { LandedThisWeek, type LandedMission } from '../../(protected)/home/LandedThisWeek';
import { HomeBody } from '../../(protected)/home/HomeBody';
import { deriveHomeAttention } from '@/lib/home-attention';
import type { ActionQueueItem } from '@/lib/action-queue';
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
  href: '#', open: true, inAudit: 1, executing: true, milestones: {} as MissionDelivery['milestones'], focus: null, visual: null, tasks: [], ...m,
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
const PR = (n: number) => `https://github.com/example/project/pull/${n}`;
const REVIEW = (n: number, title: string, decision: string, reason: string, machineStatus: string | null): ActionQueueItem => ({
  subjectKey: `r${n}`, chip: 'REVIEW', prNumber: n, workspaceId: 'ws', taskTitle: title, prUrl: PR(n), machineStatus,
  humanReview: { label: 'Review on GitHub', decision, reason, blockers: [{ kind: 'migration', text: 'packages/core/drizzle/' }] },
} as ActionQueueItem);
const QUEUE: ActionQueueItem[] = [
  { subjectKey: 'm', chip: 'MERGE', prNumber: 41, workspaceId: 'ws', taskTitle: 'feat(search): trigram index on titles', prUrl: PR(41), approvedSha: 'abc',
    mergeAdvice: { prNumber: 41, workspaceId: 'ws', token: null, unavailable: null, advice: { decision: 'merge_now', source: 'rule', reasonCode: 'blocked', line: 'Safe to merge as-is: checks green, review approved this commit.', recorded: true, model: null, at: new Date(NOW - H).toISOString(), stale: null } } } as ActionQueueItem,
  { subjectKey: 'f', chip: 'BLOCKED', prNumber: 42, workspaceId: 'ws', taskTitle: 'fix(billing): prorate seat changes mid-cycle', prUrl: PR(42), ciGate: { kind: 'blocked' } } as ActionQueueItem,
  REVIEW(43, 'feat(db): add the seats table', 'Protected migration paths changed.', 'Protected migration paths changed. The migration adds a table and backfills it from accounts; the reviewer could not verify the backfill is idempotent.', 'CI running'),
  REVIEW(44, 'refactor(auth): one session loader', 'Touches the auth boundary.', 'Touches the auth boundary. Session lookups now go through one loader; the reviewer wants a person to confirm the cookie path.', null),
  REVIEW(45, 'chore(ci): split the unit job', 'Changes a gating workflow.', 'Changes a gating workflow. The unit job splits in two; branch protection names the old job.', 'CI passed'),
  REVIEW(46, 'feat(runner): arm64 build', 'Adds a release artifact.', 'Adds a release artifact. A new arm64 binary is published on release.', null),
];
const STRANDS = [
  { id: 'st1', title: 'Quarantine flaky tests' },
  { id: 'st2', title: 'Docs: runner install on Windows' },
].map(({ id, title }) => ({ view: { id, title, href: '#' }, model: { strand: { missionId: id, quietMs: 5 * H, blockedReason: null } } }));
const DECISIONS = deriveHomeAttention({ queue: QUEUE, missions: STRANDS as never, questions: [], held: [], isActionable: () => true });
const ONE = deriveHomeAttention({ queue: QUEUE.slice(0, 1), missions: [], questions: [], held: [], isActionable: () => true });
const COUNTS: DeliveryCounts = { openMissions: 11, executingMissions: 3, liveAgents: 3, slots: { used: 3, total: 4 } };
const COUNTS_EMPTY: DeliveryCounts = { openMissions: 0, executingMissions: 0, liveAgents: 0, slots: { used: 0, total: 4 } };

export default function HomeCardsFixture() {
  const [data, setData] = useState<string | null>(null);
  useEffect(() => { setData(new URLSearchParams(window.location.search).get('data')); }, []);
  const empty = data === 'empty';
  const items = empty ? [] : data === 'one' ? ONE : DECISIONS;
  const agents = <AgentsPanel model={empty ? AGENTS_IDLE : AGENTS} occupancy={empty ? QUIET_DAY : BUSY_DAY} idle={empty ? [] : IDLE} />;
  const milestones = empty ? [] : MILESTONES;
  const counts = empty ? COUNTS_EMPTY : COUNTS;
  const landed = empty ? null : <LandedThisWeek missions={LANDED} timeZone="UTC" />;
  return (
    <main data-testid="home-cards-fixture" className="mx-auto min-h-screen max-w-[1320px] px-4 pb-20 pt-6 md:px-8 md:pb-8 md:pt-8">
      <HomeBody items={items} ask={null} agents={agents} landed={landed} counts={counts} milestones={milestones} quietMissions={empty ? 0 : 7} shipped={empty ? [] : SHIPPED} runnerConnected timeZone="UTC" />
    </main>
  );
}
