import { describe, it, expect } from 'bun:test';
import { buildFailureGroups, classifyFailure, type FailedWorkerInput } from './health-failure-groups';

const T0 = Date.parse('2026-10-05T12:00:00Z');
const at = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000).toISOString();

function worker(over: Partial<FailedWorkerInput> & { workerId: string }): FailedWorkerInput {
  return {
    taskId: `task-${over.workerId}`,
    taskTitle: `Task ${over.workerId}`,
    workspaceName: 'ws-a',
    error: 'TypeError: cannot read properties of undefined',
    exitCause: 'code_failure',
    completedAt: at(10),
    ...over,
  };
}

describe('classifyFailure', () => {
  it('names known platform causes in plain words', () => {
    expect(classifyFailure("You've hit your session limit · resets 3pm (UTC)", 'code_failure')).toMatchObject({ kind: 'platform', key: 'platform:usage_limit' });
    expect(classifyFailure('Provision failed [provision]: exit 128: error: could not lock config file', 'infra_failure')).toMatchObject({ kind: 'platform', key: 'platform:provision' });
    expect(classifyFailure(null, 'budget_limited')).toMatchObject({ kind: 'platform', key: 'platform:budget' });
    expect(classifyFailure(null, 'never_started')).toMatchObject({ kind: 'platform', key: 'platform:never_started' });
  });

  it('treats a person stopping the work as stopped, not a failure to fix', () => {
    expect(classifyFailure('Aborted by user', 'task_cancelled')).toMatchObject({ kind: 'stopped' });
  });

  it('falls back to the normalized error signature for work failures', () => {
    const a = classifyFailure('Error at /tmp/abc123/file.ts:42', 'code_failure');
    const b = classifyFailure('Error at /tmp/zzz999/file.ts:7', 'code_failure');
    expect(a.kind).toBe('work');
    expect(a.key).toBe(b.key);
  });

  it('labels never contain internal snake_case exit-cause names', () => {
    for (const cause of ['budget_limited', 'infra_failure', 'never_started', 'silent_start', 'sandbox_mount_gap', 'server_refused', 'output_unmet', 'needs_input', 'task_cancelled'] as const) {
      expect(classifyFailure(null, cause).label).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
});

describe('buildFailureGroups', () => {
  it('merges every variant of a platform cause into one group', () => {
    const view = buildFailureGroups({
      failures: [
        worker({ workerId: 'w1', error: "You've hit your session limit · resets 3pm (UTC)" }),
        worker({ workerId: 'w2', error: "You've hit your session limit · resets 9am (UTC)" }),
        worker({ workerId: 'w3', error: 'usage limit reached for this seat' }),
      ],
      traces: [],
    });
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]).toMatchObject({ key: 'platform:usage_limit', kind: 'platform', count: 3 });
  });

  it('counts each worker once even when it appears twice in the input', () => {
    const view = buildFailureGroups({
      failures: [worker({ workerId: 'w1' }), worker({ workerId: 'w1' }), worker({ workerId: 'w2' })],
      traces: [],
    });
    expect(view.totalFailedWorkers).toBe(2);
    expect(view.groups[0].count).toBe(2);
  });

  it('attaches trace patterns as evidence under the group their worker is in, counting workers not occurrences', () => {
    const view = buildFailureGroups({
      failures: [
        worker({ workerId: 'w1', error: 'Provision failed [provision]: exit 1', exitCause: 'infra_failure' }),
        worker({ workerId: 'w2', error: 'Provision failed [provision]: exit 2', exitCause: 'infra_failure' }),
        worker({ workerId: 'w3' }),
      ],
      traces: [
        { workerId: 'w1', pattern: 'git_error' },
        { workerId: 'w1', pattern: 'git_error' },
        { workerId: 'w2', pattern: 'git_error' },
        { workerId: 'w3', pattern: 'bash_nonzero_exit' },
        { workerId: 'w-not-failed', pattern: 'no_such_file' },
      ],
    });
    const provision = view.groups.find(g => g.key === 'platform:provision')!;
    expect(provision.patterns).toEqual([{ pattern: 'git_error', workers: 2 }]);
    const work = view.groups.find(g => g.kind === 'work')!;
    expect(work.patterns).toEqual([{ pattern: 'bash_nonzero_exit', workers: 1 }]);
    expect(view.groups.flatMap(g => g.patterns.map(p => p.pattern))).not.toContain('no_such_file');
  });

  it('ranks groups by workers, then most recent, and lists workspaces and tasks', () => {
    const view = buildFailureGroups({
      failures: [
        worker({ workerId: 'w1', error: 'boom A', workspaceName: 'ws-a', completedAt: at(50) }),
        worker({ workerId: 'w2', error: 'boom B', workspaceName: 'ws-b', completedAt: at(5) }),
        worker({ workerId: 'w3', error: 'boom B', workspaceName: 'ws-c', taskId: 'task-w2', completedAt: at(1) }),
      ],
      traces: [],
    });
    expect(view.groups.map(g => g.count)).toEqual([2, 1]);
    const top = view.groups[0];
    expect(top.workspaces.sort()).toEqual(['ws-b', 'ws-c']);
    expect(top.tasks).toEqual([{ taskId: 'task-w2', title: 'Task w2', failedWorkers: 2 }]);
    expect(top.lastSeen).toBe(at(1));
    expect(top.firstSeen).toBe(at(5));
  });

  it('keeps stopped work out of the failure counts', () => {
    const view = buildFailureGroups({
      failures: [worker({ workerId: 'w1', error: 'Aborted by user', exitCause: 'task_cancelled' }), worker({ workerId: 'w2' })],
      traces: [],
    });
    expect(view.totalFailedWorkers).toBe(1);
    expect(view.stopped).toBe(1);
    expect(view.groups.every(g => g.kind !== 'stopped')).toBe(true);
  });

  it('splits counts between platform and work causes', () => {
    const view = buildFailureGroups({
      failures: [
        worker({ workerId: 'w1', exitCause: 'budget_limited', error: null }),
        worker({ workerId: 'w2' }),
        worker({ workerId: 'w3' }),
      ],
      traces: [],
    });
    expect(view).toMatchObject({ platformFailures: 1, workFailures: 2, totalFailedWorkers: 3 });
  });

  it('is empty, not broken, with no failures', () => {
    expect(buildFailureGroups({ failures: [], traces: [] })).toMatchObject({ groups: [], totalFailedWorkers: 0, stopped: 0 });
  });
});
