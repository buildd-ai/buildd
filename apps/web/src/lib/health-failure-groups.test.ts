import { describe, it, expect } from 'bun:test';
import { buildFailureGroups, classifyFailure, type FailedWorkerInput, type IncidentStateInput } from './health-failure-groups';

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
        worker({ workerId: 'w1', error: 'boom A', exitCause: 'infra_failure', workspaceName: 'ws-a', completedAt: at(50) }),
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

  // A claim-time model substitution lands on nearly every claimed worker and
  // the run continues on the fallback model, so listing it under a failure
  // cause reads as the cause when it is only background.
  it('does not list a model substitution as seen in a failure', () => {
    const view = buildFailureGroups({
      failures: [worker({ workerId: 'w1' })],
      traces: [
        { workerId: 'w1', pattern: 'dispatch_model_rejected' },
        { workerId: 'w1', pattern: 'git_error' },
      ],
    });
    expect(view.groups[0].patterns.map(p => p.pattern)).toEqual(['git_error']);
  });

  it('is empty, not broken, with no failures', () => {
    expect(buildFailureGroups({ failures: [], traces: [] })).toMatchObject({ groups: [], totalFailedWorkers: 0, stopped: 0 });
  });
});

// An outside reader's Failures: only what failed, each cause a sentence buildd
// wrote. Raw error text is evidence inside the expanded row, never the label.
describe('Failures for an outside reader', () => {
  it('does not count a fix or review buildd stopped because the PR already merged', () => {
    const view = buildFailureGroups({
      failures: [
        worker({ workerId: 'w1', error: 'Superseded — review cancelled · already merged', exitCause: 'condition_unmet' }),
        worker({ workerId: 'w2', error: 'Superseded — fix cancelled · already merged', exitCause: 'condition_unmet' }),
        worker({ workerId: 'w3', error: 'Superseded — fix cancelled · already approved', exitCause: 'condition_unmet' }),
        worker({ workerId: 'w4', error: 'Superseded — retry cancelled · work landed', exitCause: 'condition_unmet' }),
        worker({ workerId: 'w5' }),
      ],
      traces: [],
    });
    expect(view.landed).toBe(4);
    expect(view.totalFailedWorkers).toBe(1);
    expect(view.groups.map(g => g.count)).toEqual([1]);
    expect(JSON.stringify(view.groups)).not.toMatch(/Superseded|already merged/);
  });

  it('counts a retry stopped because its task was cancelled as stopped, not failed', () => {
    const view = buildFailureGroups({
      failures: [worker({ workerId: 'w1', error: 'Superseded — retry cancelled · task cancelled', exitCause: 'condition_unmet' })],
      traces: [],
    });
    expect(view).toMatchObject({ stopped: 1, totalFailedWorkers: 0, groups: [] });
  });

  const KNOWN: Array<[string, string | null, string]> = [
    ['Task has no confirmed outcome — the session ended without the agent calling complete_task to report its status. This is a long tail', 'output_unmet', 'work:output_unmet'],
    ['Task has 3 commit(s) on branch but no pull request or artifact. Use create_pr to open one', 'code_failure', 'work:output_unmet'],
    ['No PR was created and no commits were made. Agent\'s final report: done', 'code_failure', 'work:output_unmet'],
    ['Claude Agent SDK returned an error result', 'code_failure', 'work:agent_error'],
    ['Review task completed without structuredOutput.verdict: the verdict was returned as prose and dropped', 'code_failure', 'work:review_no_verdict'],
    ['Stale worker expired (no update for 30+ minutes)', 'infra_failure', 'platform:stale'],
    ['No Codex credential configured. Connect a ChatGPT / OpenAI account in Settings → Credentials before running Codex tasks.', 'code_failure', 'work:codex_credential'],
    ['Codex credential expired: token past expiry. Reconnect your ChatGPT / OpenAI account in Settings → Credentials.', 'code_failure', 'work:codex_credential'],
    ['Invalid API key · Please run /login', 'code_failure', 'work:model_login'],
    ['Released interactive MCP claim so the background runner can pick up the task.', 'code_failure', 'stopped:by_person'],
  ];

  it('maps the failures buildd knows to its own sentence', () => {
    for (const [error, exitCause, key] of KNOWN) {
      expect(classifyFailure(error, exitCause).key).toBe(key);
    }
  });

  it('points a missing Codex login at Settings › Models, not a page that no longer exists', () => {
    const cause = classifyFailure('No Codex credential configured. Connect a ChatGPT / OpenAI account in Settings → Credentials before running Codex tasks.', 'code_failure');
    expect(cause.hint).toContain('Settings › Models');
    expect(`${cause.label} ${cause.hint}`).not.toContain('Credentials');
  });

  it('names an unmapped failure by its cause category, keeping the raw text for the expanded row', () => {
    const raw = 'TypeError: cannot read properties of undefined (reading \'foo\') at <anonymous>:12';
    const view = buildFailureGroups({
      failures: [
        worker({ workerId: 'w1', error: raw }),
        worker({ workerId: 'w2', error: 'ENOENT: no such file or directory, open /tmp/x/package.json' }),
      ],
      traces: [],
    });
    expect(view.groups).toHaveLength(1);
    const g = view.groups[0];
    expect(g.label).toBe("The agent hit an error it couldn't recover from");
    expect(g.sampleError).toBe('ENOENT: no such file or directory, open /tmp/x/package.json');
    expect(g.variants).toHaveLength(2);
  });

  it('never labels a row with raw error text: no placeholders, no ids, no cut-off words', () => {
    const errors = [
      ...KNOWN.map(([e, c]) => [e, c] as const),
      ['Credential lookup failed for secret 0b5e9a12-77aa-4c1e-9d0b-1f2e3d4c5b6a while refreshing the token for this team', null] as const,
      ['x'.repeat(200), 'code_failure'] as const,
      [null, null] as const,
      ['Something odd', 'reassigned'] as const,
      ['Something odd', 'condition_unmet'] as const,
    ];
    for (const [error, exitCause] of errors) {
      const { label, hint } = classifyFailure(error, exitCause);
      for (const text of [label, hint ?? '']) {
        expect(text).not.toMatch(/<[a-z]+>|…|[0-9a-f]{8}-[0-9a-f]{4}|[a-z]+_[a-z]+|→/);
      }
      expect(label).toMatch(/^[A-Z]/);
    }
  });
});

describe('platform causes and buildd incidents', () => {
  const incident = (over: Partial<IncidentStateInput> & { id: string }): IncidentStateInput => ({
    line: 'buildd is fixing this', resolved: false, workerIds: [], taskIds: [], lastSeenAt: at(1), ...over,
  });

  it('attaches the incident that covers a platform group, preferring one still open', () => {
    const view = buildFailureGroups({
      failures: [
        worker({ workerId: 'w1', exitCause: 'infra_failure', error: 'Stale worker expired (no update for 30+ minutes)' }),
        worker({ workerId: 'w2', exitCause: 'infra_failure', error: 'Stale worker expired (no update for 30+ minutes)' }),
      ],
      traces: [],
      incidents: [
        incident({ id: 'old', line: 'Fixed in v0.318 · retry', resolved: true, workerIds: ['w1'], lastSeenAt: at(30) }),
        incident({ id: 'live', workerIds: ['w2'] }),
        incident({ id: 'elsewhere', workerIds: ['w9'] }),
      ],
    });
    expect(view.groups[0].incident).toEqual({ id: 'live', line: 'buildd is fixing this' });
  });

  it('matches by task when the incident lists tasks, not workers', () => {
    const view = buildFailureGroups({
      failures: [worker({ workerId: 'w1', taskId: 'task-9', exitCause: 'infra_failure', error: null })],
      traces: [],
      incidents: [incident({ id: 'i1', taskIds: ['task-9'] })],
    });
    expect(view.groups[0].incident?.id).toBe('i1');
  });

  it('leaves task causes alone: they keep their what-to-do line', () => {
    const view = buildFailureGroups({
      failures: [worker({ workerId: 'w1', exitCause: 'output_unmet', error: null })],
      traces: [],
      incidents: [incident({ id: 'i1', workerIds: ['w1'] })],
    });
    expect(view.groups[0].incident).toBeUndefined();
    expect(view.groups[0].hint).toBeTruthy();
  });

  it('has no incident state when nothing covers the group', () => {
    const view = buildFailureGroups({
      failures: [worker({ workerId: 'w1', exitCause: 'infra_failure', error: null })],
      traces: [],
    });
    expect(view.groups[0].incident).toBeUndefined();
  });
});
