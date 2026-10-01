import { describe, it, expect } from 'bun:test';
import {
  labelDecisionOutcomes,
  normalizeTouchLabel,
  type OutcomeJoinInput,
} from '../orchestration-outcomes';

/**
 * Outcome labelling for orchestration decisions (§5a/§5b/§6): the pure join.
 * Every outcome is one of observed / censored / missing / not_applicable, so a
 * readout can never count an unknown as a safe start.
 */

const WS = '00000000-0000-4000-8000-0000000000aa';
const OTHER_WS = '00000000-0000-4000-8000-0000000000bb';
const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';
const D = (over: Record<string, unknown> = {}) => ({
  id: 'd1', taskId: T1, workspaceId: WS, prNumber: null, headSha: null, baseRef: null,
  createdAt: new Date('2026-09-01T00:00:00Z'), ...over,
});
const at = (iso: string) => new Date(iso);

function input(over: Partial<OutcomeJoinInput> = {}): OutcomeJoinInput {
  return {
    decisions: [D()],
    tasks: [{ id: T1, workspaceId: WS, status: 'completed' }],
    labels: [{ taskId: T1, workerId: 'w1', workerStatus: 'completed', touchedPaths: ['a.ts', 'b.ts'], truncated: false, prNumber: 7, headSha: 'h1', baseRef: 'dev', recordedAt: at('2026-09-02T00:00:00Z') }],
    prs: [{ taskId: T1, workspaceId: WS, prNumber: 7, headSha: 'h1', baseRef: 'dev', mergedAt: at('2026-09-03T00:00:00Z'), lifecycle: 'merged' }],
    conflictTasks: [],
    gateEvents: [],
    ...over,
  };
}

describe('normalizeTouchLabel', () => {
  it('dedupes, drops blanks and the repo-wide sentinel, and flags the 500 cap as truncated', () => {
    expect(normalizeTouchLabel(['a', 'a', ' ', '**', 'b'])).toEqual({ paths: ['a', 'b'], truncated: false });
    const many = Array.from({ length: 500 }, (_, i) => `f${i}`);
    expect(normalizeTouchLabel(many).truncated).toBe(true);
  });
});

describe('labelDecisionOutcomes', () => {
  it('a completed, merged task with no conflict signals is observed-clean on every outcome', () => {
    const [o] = labelDecisionOutcomes(input());
    expect(o.decisionId).toBe('d1');
    expect(o.task).toEqual({ status: 'observed', value: 'completed' });
    expect(o.touched).toEqual({ status: 'observed', value: { paths: ['a.ts', 'b.ts'], landed: true, failed: false, truncated: false } });
    expect(o.conflictCreated).toEqual({ status: 'observed', value: false, count: 0, joinKey: 'pr' });
    expect(o.collision).toEqual({ status: 'observed', value: false, count: 0 });
    expect(o.mergeBaseRefusal).toEqual({ status: 'observed', value: false, count: 0, joinKey: 'pr' });
    expect(o.risk).toEqual({ status: 'observed', value: false });
  });

  it('joins conflict-retry tasks by PR, scoped to the workspace and the decision window', () => {
    const [o] = labelDecisionOutcomes(input({
      conflictTasks: [
        { id: 'c1', workspaceId: WS, prNumber: 7, headSha: 'h1', createdAt: at('2026-09-02T12:00:00Z') },
        { id: 'c2', workspaceId: OTHER_WS, prNumber: 7, headSha: 'h1', createdAt: at('2026-09-02T12:00:00Z') },
        { id: 'c3', workspaceId: WS, prNumber: 7, headSha: 'h1', createdAt: at('2026-08-01T00:00:00Z') },
        { id: 'c4', workspaceId: WS, prNumber: 8, headSha: 'h1', createdAt: at('2026-09-02T12:00:00Z') },
      ],
    }));
    expect(o.conflictCreated).toEqual({ status: 'observed', value: true, count: 1, joinKey: 'pr' });
    expect(o.risk).toEqual({ status: 'observed', value: true });
  });

  it('pins to the head when the decision recorded one', () => {
    const [o] = labelDecisionOutcomes(input({
      decisions: [D({ prNumber: 7, headSha: 'h1' })],
      conflictTasks: [
        { id: 'c1', workspaceId: WS, prNumber: 7, headSha: 'h2', createdAt: at('2026-09-02T12:00:00Z') },
      ],
      gateEvents: [
        { gate: 'merge_base_freshness', outcome: 'rejected', workspaceId: WS, taskId: T1, occurredAt: at('2026-09-02T12:00:00Z'), detail: { prNumber: 7, headSha: 'h1', baseRef: 'dev' } },
        { gate: 'merge_base_freshness', outcome: 'rejected', workspaceId: WS, taskId: T1, occurredAt: at('2026-09-02T12:00:00Z'), detail: { prNumber: 7, headSha: 'h9', baseRef: 'dev' } },
      ],
    }));
    expect(o.conflictCreated).toEqual({ status: 'observed', value: false, count: 0, joinKey: 'pr_head' });
    expect(o.mergeBaseRefusal).toEqual({ status: 'observed', value: true, count: 1, joinKey: 'pr_head' });
  });

  it('a pinned base ref excludes refusals recorded against another base', () => {
    const [o] = labelDecisionOutcomes(input({
      decisions: [D({ prNumber: 7, baseRef: 'mission/x' })],
      gateEvents: [
        { gate: 'merge_base_freshness', outcome: 'rejected', workspaceId: WS, taskId: T1, occurredAt: at('2026-09-02T12:00:00Z'), detail: { prNumber: 7, headSha: 'h1', baseRef: 'dev' } },
      ],
    }));
    expect(o.mergeBaseRefusal).toMatchObject({ status: 'observed', value: false, count: 0 });
  });

  it('counts path collisions where the task was blocked or was the blocker, but not other gates', () => {
    const [o] = labelDecisionOutcomes(input({
      gateEvents: [
        { gate: 'path_claim', outcome: 'deferred', workspaceId: WS, taskId: T1, occurredAt: at('2026-09-02T00:00:00Z'), detail: { blockingTaskId: T2 } },
        { gate: 'path_claim', outcome: 'deferred', workspaceId: WS, taskId: T2, occurredAt: at('2026-09-02T00:00:00Z'), detail: { blockingTaskId: T1 } },
        { gate: 'path_claim', outcome: 'accepted', workspaceId: WS, taskId: T1, occurredAt: at('2026-09-02T00:00:00Z'), detail: {} },
        { gate: 'path_claim', outcome: 'deferred', workspaceId: OTHER_WS, taskId: T1, occurredAt: at('2026-09-02T00:00:00Z'), detail: {} },
        { gate: 'prose_gate', outcome: 'deferred', workspaceId: WS, taskId: T1, occurredAt: at('2026-09-02T00:00:00Z'), detail: {} },
      ],
    }));
    expect(o.collision).toEqual({ status: 'observed', value: true, count: 2 });
  });

  it('a held (still pending) task is censored, never a safe start', () => {
    const [o] = labelDecisionOutcomes(input({ tasks: [{ id: T1, workspaceId: WS, status: 'pending' }], labels: [], prs: [] }));
    expect(o.task).toEqual({ status: 'censored', reason: 'open' });
    expect(o.touched).toEqual({ status: 'censored', reason: 'open' });
    expect(o.collision).toEqual({ status: 'censored', reason: 'open' });
    expect(o.conflictCreated).toEqual({ status: 'censored', reason: 'open' });
    expect(o.risk).toEqual({ status: 'censored', reason: 'open' });
  });

  it('a cancelled task is censored, even with a clean ledger', () => {
    const [o] = labelDecisionOutcomes(input({ tasks: [{ id: T1, workspaceId: WS, status: 'cancelled' }], labels: [], prs: [] }));
    expect(o.risk).toEqual({ status: 'censored', reason: 'cancelled' });
    expect(o.touched).toEqual({ status: 'censored', reason: 'cancelled' });
  });

  it('a failed task keeps its observed edits, flagged failed, and has no PR outcomes', () => {
    const [o] = labelDecisionOutcomes(input({
      tasks: [{ id: T1, workspaceId: WS, status: 'failed' }],
      labels: [{ taskId: T1, workerId: 'w1', workerStatus: 'failed', touchedPaths: ['a.ts'], truncated: false, prNumber: null, headSha: null, baseRef: null, recordedAt: at('2026-09-02T00:00:00Z') }],
      prs: [],
    }));
    expect(o.task).toEqual({ status: 'observed', value: 'failed' });
    expect(o.touched).toEqual({ status: 'observed', value: { paths: ['a.ts'], landed: false, failed: true, truncated: false } });
    expect(o.conflictCreated).toEqual({ status: 'not_applicable', reason: 'no_pr' });
    expect(o.mergeBaseRefusal).toEqual({ status: 'not_applicable', reason: 'no_pr' });
    expect(o.collision).toEqual({ status: 'observed', value: false, count: 0 });
    expect(o.risk).toEqual({ status: 'observed', value: false });
  });

  it('a terminal task with no persisted observation has a MISSING touched label, not an empty one', () => {
    const [o] = labelDecisionOutcomes(input({ labels: [] }));
    expect(o.touched).toEqual({ status: 'missing', reason: 'no_terminal_observation' });
  });

  it('a deleted task is missing on every outcome', () => {
    const [o] = labelDecisionOutcomes(input({ tasks: [] }));
    expect(o.task).toEqual({ status: 'missing', reason: 'task_not_found' });
    expect(o.risk).toEqual({ status: 'missing', reason: 'task_not_found' });
  });

  it('a decision with no task id is missing, not joined to anything', () => {
    const [o] = labelDecisionOutcomes(input({ decisions: [D({ taskId: null })] }));
    expect(o.task).toEqual({ status: 'missing', reason: 'no_task' });
  });

  it('an open PR censors the PR outcomes but not the observed edits', () => {
    const [o] = labelDecisionOutcomes(input({
      prs: [{ taskId: T1, workspaceId: WS, prNumber: 7, headSha: 'h1', baseRef: 'dev', mergedAt: null, lifecycle: 'ci_green' }],
    }));
    expect(o.touched).toMatchObject({ status: 'observed', value: { landed: false } });
    expect(o.conflictCreated).toEqual({ status: 'censored', reason: 'pr_open' });
    expect(o.mergeBaseRefusal).toEqual({ status: 'censored', reason: 'pr_open' });
    expect(o.risk).toEqual({ status: 'censored', reason: 'pr_open' });
  });

  it('an observed bad outcome wins the composite even while another outcome is censored', () => {
    const [o] = labelDecisionOutcomes(input({
      prs: [{ taskId: T1, workspaceId: WS, prNumber: 7, headSha: 'h1', baseRef: 'dev', mergedAt: null, lifecycle: 'conflict' }],
      gateEvents: [{ gate: 'path_claim', outcome: 'deferred', workspaceId: WS, taskId: T1, occurredAt: at('2026-09-02T00:00:00Z'), detail: {} }],
    }));
    expect(o.risk).toEqual({ status: 'observed', value: true });
  });

  it('unions every worker session label of the task (a retry chain)', () => {
    const [o] = labelDecisionOutcomes(input({
      labels: [
        { taskId: T1, workerId: 'w1', workerStatus: 'failed', touchedPaths: ['a.ts'], truncated: false, prNumber: null, headSha: null, baseRef: null, recordedAt: at('2026-09-02T00:00:00Z') },
        { taskId: T1, workerId: 'w2', workerStatus: 'completed', touchedPaths: ['b.ts', 'a.ts'], truncated: true, prNumber: 7, headSha: 'h1', baseRef: 'dev', recordedAt: at('2026-09-02T06:00:00Z') },
      ],
    }));
    expect(o.touched).toEqual({ status: 'observed', value: { paths: ['a.ts', 'b.ts'], landed: true, failed: false, truncated: true } });
  });

  it('a task from another workspace is never joined', () => {
    const [o] = labelDecisionOutcomes(input({ tasks: [{ id: T1, workspaceId: OTHER_WS, status: 'completed' }] }));
    expect(o.task).toEqual({ status: 'missing', reason: 'task_not_found' });
  });
});
