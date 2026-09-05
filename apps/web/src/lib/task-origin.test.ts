import { describe, it, expect } from 'bun:test';
import { deriveTaskOrigin, type TaskOriginRow } from './task-origin';

// Illustrative IDs only — never real task/worker ids (public repo).
const WORKER_ID = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';
const SCHEDULE_ID = '00000000-0000-4000-8000-000000000003';
const PARENT_ID = '00000000-0000-4000-8000-000000000004';
const MISSION_ID = '00000000-0000-4000-8000-000000000005';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000006';
const RELEASE_ID = '00000000-0000-4000-8000-000000000007';
const CREATOR_TASK_ID = '00000000-0000-4000-8000-000000000008';

/** A row with every provenance column null — the "nothing recorded" baseline. */
const bare: TaskOriginRow = {
  creationSource: null,
  createdByWorkerId: null,
  createdByAccountId: null,
  scheduleId: null,
  parentTaskId: null,
  missionId: null,
  workspaceId: WORKSPACE_ID,
  ciRetryPrNumber: null,
  reviewerRetryPrNumber: null,
  conflictRetryPrNumber: null,
  taskClass: 'work',
  context: null,
};

function line(o: { actor: string | null; parts: string[] }): string {
  return [o.actor, ...o.parts].filter(Boolean).join(' · ');
}

describe('deriveTaskOrigin — agent-created via worker', () => {
  const origin = deriveTaskOrigin(
    {
      ...bare,
      creationSource: 'orchestrator',
      createdByWorkerId: WORKER_ID,
      missionId: MISSION_ID,
      scheduleId: SCHEDULE_ID,
      taskClass: 'bookkeeping',
      context: { cycleNumber: 4, scheduleName: 'mission heartbeat' },
    },
    {
      creatorRoleSlug: 'organizer',
      creatorWorkerTaskId: CREATOR_TASK_ID,
      missionTitle: 'Checkout rewrite',
      scheduleName: 'mission heartbeat',
    },
  );

  it('names the actor from the creating worker role, not the title', () => {
    expect(origin.actor).toBe('Organizer agent');
    expect(origin.mechanism).toBe('orchestrator');
  });

  it('renders the design line: actor · mechanism with cycle', () => {
    expect(line(origin)).toBe('Organizer agent · mission heartbeat cycle 4');
  });

  it('links the worker run, the mission and the schedule', () => {
    expect(origin.links.map(l => l.key)).toEqual(['worker', 'mission', 'schedule']);
    expect(origin.links.find(l => l.key === 'worker')?.href).toBe(`/app/tasks/${CREATOR_TASK_ID}`);
    expect(origin.links.find(l => l.key === 'mission')?.href).toBe(`/app/missions/${MISSION_ID}`);
    expect(origin.links.find(l => l.key === 'mission')?.label).toBe('Checkout rewrite');
    expect(origin.links.find(l => l.key === 'schedule')?.href).toBe(`/app/workspaces/${WORKSPACE_ID}/schedules`);
  });

  it('is not empty', () => {
    expect(origin.isEmpty).toBe(false);
  });
});

describe('deriveTaskOrigin — schedule-created', () => {
  const origin = deriveTaskOrigin(
    { ...bare, creationSource: 'schedule', scheduleId: SCHEDULE_ID, context: { scheduleName: 'nightly docs sweep' } },
    { scheduleName: 'nightly docs sweep' },
  );

  it('makes the schedule the actor', () => {
    expect(origin.mechanism).toBe('schedule');
    expect(line(origin)).toBe('Schedule · nightly docs sweep');
  });

  it('links the schedule only', () => {
    expect(origin.links.map(l => l.key)).toEqual(['schedule']);
  });

  it('falls back to the context scheduleName when no resolved name is supplied', () => {
    const o = deriveTaskOrigin({
      ...bare,
      creationSource: 'schedule',
      scheduleId: SCHEDULE_ID,
      context: { scheduleName: 'nightly docs sweep' },
    });
    expect(line(o)).toBe('Schedule · nightly docs sweep');
  });
});

describe('deriveTaskOrigin — human via dashboard', () => {
  it('renders "You · dashboard" with no links for the viewer', () => {
    const origin = deriveTaskOrigin(
      { ...bare, creationSource: 'dashboard', createdByAccountId: ACCOUNT_ID },
      { isSelf: true, actorName: 'Max' },
    );
    expect(origin.mechanism).toBe('human');
    expect(line(origin)).toBe('You · dashboard');
    expect(origin.links).toEqual([]);
    expect(origin.isEmpty).toBe(false);
  });

  it('names a teammate when the creator is not the viewer', () => {
    const origin = deriveTaskOrigin(
      { ...bare, creationSource: 'dashboard', createdByAccountId: ACCOUNT_ID },
      { isSelf: false, actorName: 'Ada' },
    );
    expect(line(origin)).toBe('Ada · dashboard');
  });

  it('degrades to a generic teammate when the name is unresolved', () => {
    const origin = deriveTaskOrigin({ ...bare, creationSource: 'dashboard', createdByAccountId: ACCOUNT_ID });
    expect(line(origin)).toBe('A teammate · dashboard');
  });
});

describe('deriveTaskOrigin — CI retry', () => {
  const origin = deriveTaskOrigin(
    {
      ...bare,
      creationSource: 'webhook',
      parentTaskId: PARENT_ID,
      taskClass: 'attempt',
      ciRetryPrNumber: 1204,
      context: {
        iteration: 2,
        maxIterations: 3,
        ciRunUrl: 'https://github.com/acme/app/actions/runs/9',
        failureContext: { errorType: 'ci_failure', summary: 'typecheck failed' },
      },
    },
    { parentTaskTitle: 'Add checkout guard', repoFullName: 'acme/app' },
  );

  it('renders the design line: retry clause · PR + reason', () => {
    expect(origin.mechanism).toBe('ci_retry');
    expect(line(origin)).toBe('CI retry #2 of 3 · PR #1204 check_suite failed');
  });

  it('links the parent task, the PR and the CI run', () => {
    expect(origin.links.map(l => l.key)).toEqual(['parentTask', 'pr', 'run']);
    expect(origin.links.find(l => l.key === 'parentTask')?.href).toBe(`/app/tasks/${PARENT_ID}`);
    expect(origin.links.find(l => l.key === 'pr')?.href).toBe('https://github.com/acme/app/pull/1204');
    expect(origin.links.find(l => l.key === 'run')?.href).toBe('https://github.com/acme/app/actions/runs/9');
  });

  it('drops the "#n of m" clause when the iteration counters are absent', () => {
    const o = deriveTaskOrigin({ ...bare, creationSource: 'webhook', ciRetryPrNumber: 1204, taskClass: 'attempt' });
    expect(line(o)).toBe('CI retry · PR #1204 check_suite failed');
  });
});

describe('deriveTaskOrigin — reviewer retry', () => {
  it('names the reviewer mechanism and its PR', () => {
    const origin = deriveTaskOrigin({
      ...bare,
      creationSource: 'api',
      parentTaskId: PARENT_ID,
      taskClass: 'attempt',
      reviewerRetryPrNumber: 77,
      context: {
        iteration: 1,
        maxIterations: 3,
        prUrl: 'https://github.com/acme/app/pull/77',
        failureContext: { errorType: 'reviewer_request_changes' },
      },
    });
    expect(origin.mechanism).toBe('reviewer_retry');
    expect(line(origin)).toBe('Reviewer retry #1 of 3 · PR #77 reviewer requested changes');
    expect(origin.links.find(l => l.key === 'pr')?.href).toBe('https://github.com/acme/app/pull/77');
  });
});

describe('deriveTaskOrigin — conflict retry', () => {
  it('reads the conflict-specific iteration counters', () => {
    const origin = deriveTaskOrigin({
      ...bare,
      creationSource: 'conflict',
      parentTaskId: PARENT_ID,
      taskClass: 'attempt',
      conflictRetryPrNumber: 88,
      context: {
        conflictIteration: 1,
        maxConflictIterations: 3,
        failureContext: { errorType: 'merge_conflict' },
      },
    });
    expect(origin.mechanism).toBe('conflict_retry');
    expect(line(origin)).toBe('Conflict retry #1 of 3 · PR #88 merge conflict');
  });
});

describe('deriveTaskOrigin — mechanism and actor are separate axes', () => {
  it('keeps the mechanism from creationSource when an agent actor is also known', () => {
    const origin = deriveTaskOrigin(
      { ...bare, creationSource: 'mcp', createdByWorkerId: WORKER_ID },
      { creatorRoleSlug: 'builder', creatorWorkerTaskId: CREATOR_TASK_ID },
    );
    expect(origin.mechanism).toBe('mcp');
    expect(line(origin)).toBe('Builder agent · MCP');
    expect(origin.links.map(l => l.key)).toEqual(['worker']);
  });

  it('reports api as the mechanism for an API-created task', () => {
    const origin = deriveTaskOrigin(
      { ...bare, creationSource: 'api', createdByAccountId: ACCOUNT_ID },
      { actorName: 'ci-runner' },
    );
    expect(origin.mechanism).toBe('api');
    expect(line(origin)).toBe('ci-runner · API');
  });

  it('classifies an attempt row from taskClass when the retry columns are empty', () => {
    const origin = deriveTaskOrigin({ ...bare, taskClass: 'attempt', parentTaskId: PARENT_ID });
    expect(origin.mechanism).toBe('attempt');
    expect(line(origin)).toBe('retry attempt');
    expect(origin.links.map(l => l.key)).toEqual(['parentTask']);
  });
});

describe('deriveTaskOrigin — no provenance at all', () => {
  const origin = deriveTaskOrigin(bare);

  it('reports empty rather than inventing an origin', () => {
    expect(origin.isEmpty).toBe(true);
    expect(origin.actor).toBeNull();
    expect(origin.parts).toEqual([]);
    expect(origin.links).toEqual([]);
    expect(origin.mechanism).toBe('unknown');
  });

  it('never reads the title', () => {
    const withTitle = deriveTaskOrigin({ ...bare, title: '[CI Retry #2] Add checkout guard' } as TaskOriginRow);
    expect(withTitle.isEmpty).toBe(true);
  });
});

describe('deriveTaskOrigin — shipped release (U7, spec §10.3 badge)', () => {
  it('carries a Shipped in <release> row when a healthy release is attributed', () => {
    const origin = deriveTaskOrigin(
      { ...bare, creationSource: 'dashboard', createdByAccountId: ACCOUNT_ID },
      { isSelf: true, shippedRelease: { releaseId: RELEASE_ID, label: 'v0.194.0' } },
    );
    expect(origin.shipped).toEqual({ label: 'v0.194.0', href: `/app/releases/${RELEASE_ID}` });
  });

  it('shows the release even when the origin clause itself is empty', () => {
    const origin = deriveTaskOrigin(bare, { shippedRelease: { releaseId: RELEASE_ID, label: null } });
    expect(origin.isEmpty).toBe(true);
    expect(origin.shipped).toEqual({ label: 'a release', href: `/app/releases/${RELEASE_ID}` });
  });

  it('is null when nothing is attributed', () => {
    expect(deriveTaskOrigin(bare).shipped).toBeNull();
  });
});
