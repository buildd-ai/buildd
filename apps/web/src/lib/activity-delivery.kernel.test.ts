/**
 * 7105282e (#5211): a kernel-owned delivery's revision card reads the kernel's rounds and
 * attempt ledger, never the reviewer and repair task rows. One current verdict (the round at
 * the current head), older rounds folded into one line, repairs as the ledger ended them, and
 * one round number: the kernel's.
 */
import { describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { buildActivityNow, buildTaskDeliveryDetails, type ActivityTaskInput, type EvidenceEntry, type KernelEvidenceInput } from './activity-delivery';
import { projectMissionDelivery } from './delivery-projection';

const NOW = Date.parse('2026-10-19T00:30:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const sha = (n: number) => `${String(n).padStart(2, '0')}${'a'.repeat(38)}`;
const HEAD = sha(11);
const PR_URL = 'https://github.com/example/project/pull/5';

type Round = KernelEvidenceInput['rounds'][number];
type Attempt = KernelEvidenceInput['ledger'][number];

const round = (n: number, over: Partial<Round> = {}): Round => ({
  id: `r${n}`, round: n, headSha: sha(n), kind: 'full', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', failureCount: 0, reviewerTaskId: `rev${n}`, ...over,
});
const ciFix = (n: number, over: Partial<Attempt> = {}): Attempt => ({
  id: `a${n}`, family: 'ci', attemptNo: n, mode: 'agent', boundHeadSha: sha(n), triggerReason: 'ci_failed', taskId: `fix${n}`,
  status: 'cancelled', outcome: null, maxAttempts: 3, reportedShas: [], ...over,
});

/** Rounds 1-10 decided, round 11 queued at the current head; four CI fixes bound to heads since left. */
function kernel(over: Partial<KernelEvidenceInput> = {}): KernelEvidenceInput {
  const rounds = [
    ...Array.from({ length: 10 }, (_, i) => round(i + 1, i % 3 === 1 ? { verdict: 'request_changes', effectiveVerdict: 'request_changes' } : {})),
    round(11, { status: 'queued', verdict: null, effectiveVerdict: null, headSha: HEAD }),
  ];
  return {
    state: 'AWAITING_REVIEW', stateReason: null, prNumber: 5, headSha: HEAD, prState: 'ci_passed',
    rounds, ledger: [1, 2, 3, 4].map((n) => ciFix(n)), approvedCurrentHead: false, approvalBasis: null, ...over,
  };
}

/** The root and its legacy attempt rows: seven reviewer runs, all approving, three at the current head. */
function rows(k: KernelEvidenceInput | null): ActivityTaskInput[] {
  const root: ActivityTaskInput = {
    id: 'root', title: 'perf: a live update re-renders only its region', status: 'completed', taskClass: 'work', missionId: null,
    createdAt: ago(600), updatedAt: ago(5), kernel: k,
    workers: [{ status: 'completed', prUrl: PR_URL, prNumber: 5, prLifecycleStatus: 'ci_green', lastCommitSha: HEAD, startedAt: ago(600), completedAt: ago(550), updatedAt: ago(5) }],
  };
  const reviewers = Array.from({ length: 7 }, (_, i): ActivityTaskInput => ({
    id: `rv${i}`, title: '[reviewer] PR #5', status: 'completed', taskClass: 'attempt', parentTaskId: 'root', missionId: null,
    createdAt: ago(500 - i * 10), updatedAt: ago(490 - i * 10), workers: [{ status: 'completed', startedAt: ago(500 - i * 10) }],
    review: { verdict: 'approve', headSha: i >= 4 ? HEAD : sha(i + 1) },
  }));
  const repairs = [1, 2, 3, 4].map((n): ActivityTaskInput => ({
    id: `fix${n}`, title: `[builder · after CI #${n}] perf`, status: 'in_progress', taskClass: 'attempt', parentTaskId: 'root', missionId: null,
    createdAt: ago(450 - n * 10), updatedAt: ago(440 - n * 10), workers: [{ status: 'completed', startedAt: ago(450 - n * 10), lastCommitSha: sha(n + 1) }],
  }));
  return [root, ...reviewers, ...repairs];
}

function nowRow(k: KernelEvidenceInput | null) {
  const n = buildActivityNow({ tasks: rows(k), missions: [], rules, now: NOW });
  const row = n.groups.flatMap((g) => g.rows).find((r) => r.id === 'root');
  expect(row).toBeTruthy();
  return row!;
}

const revisions = (ev: EvidenceEntry[]) => ev.filter((e): e is Extract<EvidenceEntry, { type: 'revision' }> => e.type === 'revision');
const repairsOf = (ev: EvidenceEntry[]) => ev.filter((e): e is Extract<EvidenceEntry, { type: 'repair' }> => e.type === 'repair');

describe('a kernel-owned delivery: one current verdict, from the kernel', () => {
  it('the current card reads the queued round at the head as awaiting review, never a reviewer row\'s approval', () => {
    const row = nowRow(kernel());
    const cur = revisions(row.evidence).find((e) => e.current)!;
    expect(cur).toBeTruthy();
    const review = cur.gates.filter((g) => g.name.startsWith('Code review'));
    expect(review).toHaveLength(1);
    expect(review[0].name).toBe('Code review');
    expect(review[0].result).toBe('awaiting review');
    expect(review[0].result).not.toBe('passed');
    // Review and CI did not both pass: the line says so, as the landing status does.
    expect(row.line).not.toContain('Review and CI passed');
    expect(row.line).toContain('have not both passed');
  });

  it('older rounds fold into one line; there is one revision card, the current head\'s', () => {
    const row = nowRow(kernel());
    expect(revisions(row.evidence)).toHaveLength(1);
    const earlier = row.evidence.filter((e) => e.type === 'earlier');
    expect(earlier).toHaveLength(1);
    expect(earlier[0]).toMatchObject({ type: 'earlier', rounds: 10 });
    expect((earlier[0] as { line: string }).line).toMatch(/^Rounds 1–10: /);
  });

  it('one round number, the kernel\'s: the card carries round 11, repairs carry none, no "Code review k"', () => {
    const row = nowRow(kernel());
    const cur = revisions(row.evidence).find((e) => e.current)!;
    expect(cur.round).toBe(11);
    expect(cur.kernel).toBe(true);
    expect(repairsOf(row.evidence).every((r) => r.round === null)).toBe(true);
    expect(cur.gates.some((g) => /Code review \d/.test(g.name))).toBe(false);
  });

  it('CI repairs whose bound head was left read as superseded, from the ledger, not their task rows', () => {
    const row = nowRow(kernel());
    const reps = repairsOf(row.evidence);
    expect(reps).toHaveLength(4);
    expect(reps.every((r) => r.status === 'superseded')).toBe(true);
    expect(reps.every((r) => r.reason === 'ci')).toBe(true);
  });

  it('a repair the ledger ended with no change reads ended; one still running at the head reads running', () => {
    const k = kernel({ ledger: [ciFix(1, { status: 'ended', outcome: 'noop', boundHeadSha: HEAD }), ciFix(2, { status: 'running', boundHeadSha: HEAD })] });
    expect(repairsOf(nowRow(k).evidence).map((r) => r.status)).toEqual(['running', 'ended']);
  });

  it('approved at the head with CI green: the card says passed, and the line says both passed', () => {
    const rounds = [...kernel().rounds.slice(0, 10), round(11, { headSha: HEAD })];
    const row = nowRow(kernel({ rounds, approvedCurrentHead: true }));
    const cur = revisions(row.evidence).find((e) => e.current)!;
    expect(cur.gates.map((g) => [g.name, g.result])).toEqual([['Code review', 'passed'], ['CI', 'passed']]);
    expect(row.line).toContain('Review and CI passed on its latest revision');
  });

  it('an approval carried to the head by a branch update counts as passed and names its round', () => {
    const rounds = kernel().rounds.slice(0, 10).concat(round(11, { headSha: sha(12) }));
    const row = nowRow(kernel({ rounds, approvedCurrentHead: true }));
    const cur = revisions(row.evidence).find((e) => e.current)!;
    expect(cur.round).toBe(11);
    expect(cur.gates[0]).toMatchObject({ name: 'Code review', result: 'passed' });
    expect(cur.gates[0].why).toContain('branch update');
  });

  it('without a kernel delivery the legacy cards stand', () => {
    const row = nowRow(null);
    expect(revisions(row.evidence).length).toBeGreaterThan(1);
    expect(row.evidence.some((e) => e.type === 'earlier')).toBe(false);
  });

  it('mission detail\'s drawer reads the same kernel evidence', () => {
    const tasks = rows(kernel()).map((t) => ({ ...t, missionId: 'm', missionTitle: 'M' }));
    const mission = projectMissionDelivery({ id: 'm', title: 'M', status: 'active', href: '/app/missions/m', tasks }, rules);
    const details = buildTaskDeliveryDetails({ tasks, mission, rules });
    const ev = details.root.evidence;
    expect(revisions(ev)).toHaveLength(1);
    expect(revisions(ev)[0]).toMatchObject({ current: true, round: 11 });
    expect(details.root.stages.audit).toContain('Code review awaiting review');
  });

  it('a superseded PR: the drawer\'s Deliver stage reads Merged in #N, never closed without merging', () => {
    const k = kernel({ state: 'SUPERSEDED', prState: 'closed', supersededBy: { prNumber: 5408, url: 'https://github.com/example/project/pull/5408', reason: 'r' } });
    const tasks = rows(k).map((t) => (t.id === 'root'
      ? { ...t, missionId: 'm', missionTitle: 'M', workers: [{ ...t.workers[0], prLifecycleStatus: 'closed', supersededByPrNumber: 5408 }] }
      : { ...t, missionId: 'm', missionTitle: 'M' }));
    const mission = projectMissionDelivery({ id: 'm', title: 'M', status: 'active', href: '/app/missions/m', tasks }, rules);
    const details = buildTaskDeliveryDetails({ tasks, mission, rules });
    expect(details.root.stages.land).toBe('Merged in #5408');
  });
});
