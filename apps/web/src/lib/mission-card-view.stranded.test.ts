/**
 * The card's chip comes from the same predicate as the action it offers, and
 * reads the same as `explain` over the same rows. Fixtures are illustrative;
 * their shapes are the two missions the owner hit on the mobile Home cards.
 */
import { describe, expect, it } from 'bun:test';
import { OPEN_TASK_STATUSES } from '@buildd/shared';
import {
  buildMissionCardView,
  cardLocalStrand,
  ownerUnmergedPrs,
  summarizeMissionForCard,
  type MissionCardTaskRow,
} from './mission-card-view';
import { buildMissionListCard, type ListMissionRow } from './mission-list-card';
import { deriveMissionStateView, missionNeedsYou } from './mission-state-view';
import { continueOnRunnerBlockedReason } from './local-strand';
import { unmetDependencyIds, unmetDependencyPrs, type DependencyRow } from './mission-helpers';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000);

function card(row: ListMissionRow) {
  const summary = summarizeMissionForCard(row, { now: NOW });
  const view = buildMissionCardView(row, { from: 'home', now: NOW, summary });
  return { summary, view, model: buildMissionListCard(row, view, summary, { now: NOW }) };
}

const prDone = (id: string, pr: number, over: Partial<MissionCardTaskRow> = {}): MissionCardTaskRow => ({
  id, title: `feat: ${id}`, status: 'completed', taskClass: 'work', mode: 'execution', createdAt: ago(300),
  workers: [{ status: 'completed', startedAt: ago(290), completedAt: ago(200), updatedAt: ago(200), prNumber: pr, prUrl: `https://example.invalid/pr/${pr}`, prLifecycleStatus: 'ci_green' }],
  ...over,
});

const reviewer = (id: string, parent: string, status = 'pending'): MissionCardTaskRow => ({
  id, title: `[reviewer] PR for ${parent}`, status, taskClass: 'attempt', parentTaskId: parent, createdAt: ago(120), workers: [],
});

describe('dependency-blocked mission, its blocking PRs in the review flow', () => {
  const row: ListMissionRow = {
    id: 'm-deps', title: 'Example onboarding mission', status: 'active', executor: 'runner', workspaceId: 'ws',
    tasks: [
      prDone('a', 3319),
      prDone('b', 3317),
      reviewer('ra', 'a', 'in_progress'),
      reviewer('rb', 'b'),
      { id: 'spec', title: 'docs: promote the design to a spec', status: 'pending', taskClass: 'work', mode: 'execution', createdAt: ago(300), dependsOn: ['a', 'b'], workers: [] },
    ],
  };

  it('is not NEEDS YOU: nothing on it is the owner’s to do', () => {
    const { summary, model } = card(row);
    expect(missionNeedsYou(summary.state)).toBe(false);
    expect(model.status.label).not.toBe('Needs you');
    expect(model.ask).toBeNull();
  });

  it('names what it waits on, and does not say "Dispatch a worker"', () => {
    const { summary } = card(row);
    expect(summary.state.kind).toBe('waiting');
    expect(summary.state.nextAction).toBe('Nothing to do yet. Unblocks when #3319 and #3317 merge.');
    expect(summary.state.situation.headline).toBe('1 task is waiting on #3319 and #3317 to merge.');
  });

  it('a PR with a reviewer on it is not the owner’s to merge', () => {
    expect(ownerUnmergedPrs(row.tasks!, NOW)).toEqual([]);
  });
});

describe('the same mission, one blocking PR green with nobody on it', () => {
  const row: ListMissionRow = {
    id: 'm-deps2', title: 'Example', status: 'active', workspaceId: 'ws',
    tasks: [
      prDone('a', 3319),
      reviewer('ra', 'a', 'in_progress'),
      prDone('b', 3317),
      { id: 'spec', title: 'docs: spec', status: 'pending', taskClass: 'work', mode: 'execution', createdAt: ago(300), dependsOn: ['a', 'b'], workers: [] },
    ],
  };

  it('NEEDS YOU, and the action the card offers is that merge — the same predicate', () => {
    const { summary, model } = card(row);
    expect(missionNeedsYou(summary.state)).toBe(true);
    expect(summary.state.kind).toBe('awaiting_merge');
    expect(summary.state.waitingOn?.kind === 'merge' && summary.state.waitingOn.prNumbers).toEqual([3317]);
    expect(model.ask?.label).toMatch(/^Merge: feat: b/);
  });
});

describe('stranded local mission: a reviewer nobody will claim', () => {
  const row: ListMissionRow = {
    id: 'm-local', title: 'Example local mission', status: 'active', executor: 'local', workspaceId: 'ws',
    tasks: [prDone('fix', 3318), reviewer('rv', 'fix')],
  };

  it('reads STRANDED with the runner CTA, not "merge the PR"', () => {
    const { summary, model } = card(row);
    expect(summary.state.chip.label).toBe('STRANDED');
    expect(model.status.label).toBe('Stranded');
    expect(model.strand).toMatchObject({ taskId: 'rv', blockedReason: null });
    expect(summary.state.situation.headline).toBe('Stranded: no local session for 2h. Continue on a runner?');
  });
});

describe('card and explain agree on the same rows', () => {
  // `explain` builds its input from the same shared readers and adds a
  // completion decision. Rebuild that input here, from the same rows, and
  // compare: kind, headline and next action must match the card.
  const cases: Array<[string, ListMissionRow]> = [
    ['dependency-blocked', {
      id: 'x1', title: 'x', status: 'active', workspaceId: 'ws',
      tasks: [prDone('a', 1, {}), reviewer('ra', 'a'), { id: 's', title: 's', status: 'pending', taskClass: 'work', createdAt: ago(300), dependsOn: ['a'], workers: [] }],
    }],
    ['stranded', {
      id: 'x2', title: 'x', status: 'active', executor: 'local', workspaceId: 'ws',
      tasks: [{ id: 's', title: 's', status: 'pending', taskClass: 'work', createdAt: ago(300), workers: [] }],
    }],
  ];

  for (const [name, row] of cases) {
    it(name, () => {
      const { summary } = card(row);
      const tasks = row.tasks!;
      const byId = new Map<string, DependencyRow>(tasks.map(t => [t.id, t as DependencyRow]));
      const open = tasks.filter(t => t.taskClass === 'work' && (OPEN_TASK_STATUSES as readonly string[]).includes(t.status));
      const strand = cardLocalStrand(row, NOW);
      const explainView = deriveMissionStateView({
        status: row.status, isHeld: false, executor: row.executor ?? null, activeAgents: 0, health: 'NOMINAL',
        completion: { ok: false, code: 'pending_deliverables', reason: 'open', pendingDeliverables: open.length, pendingByStatus: { pending: open.length } },
        openTasks: open.map(t => ({ id: t.id, status: t.status, title: t.title, waitingOnTaskIds: unmetDependencyIds(t, byId), waitingOnPrs: unmetDependencyPrs(t, byId) })),
        localStrand: strand ? { ...strand, flipBlockedReason: continueOnRunnerBlockedReason({ status: row.status, workspaceId: row.workspaceId }) } : null,
        unmergedPrs: ownerUnmergedPrs(tasks, NOW),
      });
      expect(explainView.kind).toBe(summary.state.kind);
      expect(explainView.situation.headline).toBe(summary.state.situation.headline);
      expect(explainView.nextAction).toBe(summary.state.nextAction);
      expect(missionNeedsYou(explainView)).toBe(missionNeedsYou(summary.state));
    });
  }
});
