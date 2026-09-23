/**
 * Gate-ledger wiring on POST /api/tasks.
 *
 * Deliberately a separate file from `route.test.ts`: that file pins the route's
 * BEHAVIOUR, and this task was explicitly not allowed to change any of it. What
 * is pinned here is that each gate writes exactly one row, with the right
 * outcome, and that the ledger going down changes nothing the caller sees.
 *
 * The real `@/lib/gate-ledger` runs — only the core writer underneath it is
 * stubbed — so the caller-origin resolution and the fire-and-forget behaviour
 * are exercised rather than mocked away.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { gateFrictionSignature } from '@buildd/core/gate-friction-signature';

interface Recorded {
  gate: string;
  surface: string;
  outcome: string;
  reason: string;
  workspaceId?: string | null;
  missionId?: string | null;
  taskId?: string | null;
  callerOrigin?: string | null;
  detail?: Record<string, unknown> | null;
}

let recorded: Recorded[] = [];
let ledgerShouldReject = false;

mock.module('@buildd/core/gate-events', () => ({
  GATE_SLUGS: {
    TASK_PARAM_VOCABULARY: 'task_param_vocabulary',
    PROSE_GATE: 'prose_gate',
    FRICTION_DEDUPE: 'friction_dedupe',
    SUBJECT_DEDUPE: 'subject_dedupe',
    FILE_ANYWAY: 'file_anyway',
    MANIFEST_REQUIRED: 'manifest_required',
    KIND_ABSENT: 'kind_absent',
  },
  gateFrictionSignature,
  recordGateEvent: async (input: Recorded) => {
    if (ledgerShouldReject) throw new Error('gate_events is unreachable');
    recorded.push(input);
    return 'row-1';
  },
  recordOrCoalesceDeferral: async (input: Recorded) => {
    if (ledgerShouldReject) throw new Error('gate_events is unreachable');
    recorded.push(input);
    return 'row-1';
  },
}));

// ── Route dependencies ────────────────────────────────────────────────────────

const WS = 'ws-1';
const MISSION = 'm-1';

const mockAccount = { id: 'acct-1', name: 'test', teamId: 'team-1', level: 'admin' };

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => null }));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async (key: string | null) => (key ? mockAccount : null),
}));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: async () => [],
}));
mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: async () => [WS],
  verifyAccountWorkspaceAccess: async () => true,
}));
mock.module('@/lib/workspace-resolver', () => ({
  resolveWorkspace: async () => ({ id: WS }),
  autoResolveAccountWorkspace: async () => ({ workspaceId: WS }),
}));
mock.module('@/lib/task-service', () => ({
  resolveCreatorContext: async () => ({
    createdByAccountId: 'acct-1',
    createdByWorkerId: null,
    creationSource: 'mcp',
    parentTaskId: null,
  }),
}));
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: async () => {} }));
mock.module('@/lib/required-connectors', () => ({
  validateRequiredConnectors: async () => ({ ok: true, value: null }),
}));
mock.module('@/lib/mission-surface-audit', () => ({ ensureMissionSurfaceAudit: async () => {} }));
mock.module('@/lib/pr-state-refresh', () => ({ refreshStaleWorkersForWorkspaces: async () => {} }));
mock.module('@buildd/core/spec-discrepancy-intake', () => ({ findIntakeWarnings: async () => [] }));
mock.module('@/lib/mission-feed', () => ({
  resolveFeedActor: async () => ({ kind: 'mcp', id: 'acct-1', label: 'acct' }),
  postMissionFeedEvent: async () => {},
}));
mock.module('@/lib/mission-loop', () => ({ reopenCompletedMission: async () => ({ reopened: false }) }));
mock.module('@/lib/criteria-escalation', () => ({ resolveCriteriaEscalation: async () => ({ cleared: false }) }));
mock.module('@/lib/pusher', () => ({
  triggerEvent: async () => {},
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { TASK_CREATED: 'task:created' },
}));

// Subject-anchor observation: no anchor and no match unless a test says so.
let subjectObservation: any = { anchor: null, match: null, taskValues: {} };
mock.module('@/lib/subject-anchor-observer', () => ({
  prepareSubjectFiling: async () => subjectObservation,
  recordSubjectMatchObserved: async () => {},
}));
mock.module('@/lib/subject-intake', () => ({
  intakeSubject: async (input: any) => {
    const task = await input.repository.createTask({ id: 'task-new', subjectDedupeScope: 'none' });
    return { task, outcome: { action: 'created', taskId: task.id } };
  },
}));
mock.module('@/lib/subject-intake-db', () => ({
  createSubjectIntakeRepository: (createTaskRow: any) => ({ createTask: createTaskRow }),
}));

let workspaceRow: any = { id: WS, name: 'buildd', teamId: 'team-1', repo: 'owner/buildd', gitConfig: {} };
let missionRow: any = { defaultOutputRequirement: null, defaultBackend: null, startAt: null, workingBranch: null, integrationBranchEnabled: false };
let insertedTask: any = null;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: async () => workspaceRow, findMany: async () => [workspaceRow] },
      tasks: { findFirst: async () => null, findMany: async () => [] },
      missions: { findFirst: async () => missionRow },
      workspaceSkills: { findFirst: async () => null },
    },
    insert: () => ({
      values: (row: any) => ({
        returning: async () => {
          insertedTask = { ...row, id: row.id ?? 'task-new', missionId: row.missionId ?? null, title: row.title, taskClass: row.taskClass, pathManifest: row.pathManifest ?? null };
          return [insertedTask];
        },
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));

// Neither `drizzle-orm` nor the schema is mocked: both evaluate fine without a
// database (the schema module only builds table descriptors), and stubbing them
// means hand-maintaining a list of every table any transitively-imported module
// happens to name. Only the CLIENT above is replaced.

const { POST } = await import('./route');

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/tasks', {
    method: 'POST',
    headers: new Headers({ authorization: 'Bearer bld_test', 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

/** The route fires ledger writes without awaiting them. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function eventsFor(gate: string): Recorded[] {
  return recorded.filter(e => e.gate === gate);
}

beforeEach(() => {
  recorded = [];
  ledgerShouldReject = false;
  insertedTask = null;
  subjectObservation = { anchor: null, match: null, taskValues: {} };
  workspaceRow = { id: WS, name: 'buildd', teamId: 'team-1', repo: 'owner/buildd', gitConfig: {} };
  missionRow = { defaultOutputRequirement: null, defaultBackend: null, startAt: null, workingBranch: null, integrationBranchEnabled: false };
  process.env.NODE_ENV = 'test';
});

describe('POST /api/tasks — gate ledger wiring', () => {
  it('records the manifest gate once, as a rejection, without changing the 400', async () => {
    const res = await POST(post({
      workspaceId: WS,
      title: 'Do a thing',
      description: 'x',
      missionId: MISSION,
      outputRequirement: 'pr_required',
    }));
    await settle();

    expect(res.status).toBe(400);
    const events = eventsFor('manifest_required');
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('rejected');
    expect(events[0].surface).toBe('POST /api/tasks');
    expect(events[0].workspaceId).toBe(WS);
    expect(events[0].missionId).toBe(MISSION);
    // The sentinel default is the filer declaring nothing, which reads
    // differently from a filer who wrote '**' on purpose.
    expect(events[0].detail?.manifest).toBe('wildcard');
  });

  it('records an out-of-vocabulary param once, resolving the workspace by name', async () => {
    const res = await POST(post({ workspaceId: 'buildd', title: 'x', kind: 'nonsense' }));
    await settle();

    expect(res.status).toBe(400);
    const events = eventsFor('task_param_vocabulary');
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('rejected');
    expect(events[0].detail?.param).toBe('kind');
    // Resolved in the background rather than left null — an unattributable row
    // is invisible to every scoped aggregation.
    expect(events[0].workspaceId).toBe(WS);
  });

  // ── frictionSignature on the 400 body ───────────────────────────────────────
  // A gate refusal never becomes a worker failure, so get_failure_analytics has
  // nothing to hand back — the 400 body itself is the only place an agent can
  // get a stable dedupe key for the friction report it's about to file.

  it('carries a frictionSignature on the manifest-required 400, matching (gate, reason)', async () => {
    const res = await POST(post({
      workspaceId: WS,
      title: 'Do a thing',
      description: 'x',
      missionId: MISSION,
      outputRequirement: 'pr_required',
    }));
    await settle();

    expect(res.status).toBe(400);
    const body = await res.json();
    const events = eventsFor('manifest_required');
    expect(body.frictionSignature).toBe(gateFrictionSignature('manifest_required', events[0].reason));
    expect(body.frictionSignature).toMatch(/^gate:manifest_required_[a-z0-9_]*[0-9a-f]{6}$/);
  });

  it('the same refusal from two different callers produces the identical frictionSignature', async () => {
    const req = () => post({
      workspaceId: WS,
      title: 'Do a thing',
      description: 'x',
      missionId: MISSION,
      outputRequirement: 'pr_required',
    });

    const first = await (await POST(req())).json();
    const second = await (await POST(req())).json();

    expect(first.frictionSignature).toBe(second.frictionSignature);
  });

  it('carries a frictionSignature on the out-of-vocabulary 400', async () => {
    const res = await POST(post({ workspaceId: 'buildd', title: 'x', kind: 'nonsense' }));
    await settle();

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.frictionSignature).toMatch(/^gate:task_param_vocabulary_[a-z0-9_]*[0-9a-f]{6}$/);
  });

  it('records the prose-gate lint as WARNED, not rejected, on a task that was created', async () => {
    const res = await POST(post({
      workspaceId: WS,
      title: 'Follow-up',
      description: 'Gated on task 11111111-2222-4333-8444-555555555555 merging.',
    }));
    await settle();

    expect(res.status).toBe(200);
    const events = eventsFor('prose_gate');
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('warned');
    expect(events[0].workspaceId).toBe(WS);
    expect(events[0].taskId).toBe('task-new');
  });

  it('does not record the prose gate when the description declares no gate', async () => {
    await POST(post({ workspaceId: WS, title: 'Plain', description: 'Nothing special here.' }));
    await settle();
    expect(eventsFor('prose_gate')).toHaveLength(0);
  });

  it('records a fileAnywayReason override as BYPASSED — the false-positive signal', async () => {
    subjectObservation = {
      anchor: { keyType: 'pr_generation', keyHash: 'h' },
      match: { taskId: 'task-existing', title: 'Existing', description: 'd', outcome: 'attach', keyType: 'pr_generation' },
      taskValues: {},
    };

    const res = await POST(post({
      workspaceId: WS,
      title: 'Same subject, different work',
      description: 'x',
      fileAnywayReason: 'the match is a different concern on the same PR generation',
    }));
    await settle();

    // The filing went through — the bypass is not a refusal.
    expect(res.status).toBe(200);
    const events = eventsFor('subject_dedupe');
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('bypassed');
    expect(events[0].taskId).toBe('task-existing');
    expect(events[0].detail?.keyType).toBe('pr_generation');
  });

  it('records the same match as REJECTED when nothing bypassed it', async () => {
    subjectObservation = {
      anchor: { keyType: 'pr_generation', keyHash: 'h' },
      match: { taskId: 'task-existing', title: 'Existing', description: 'd', outcome: 'attach', keyType: 'pr_generation' },
      taskValues: {},
    };

    const res = await POST(post({ workspaceId: WS, title: 'Dup', description: 'x' }));
    await settle();

    expect(res.status).toBe(200);
    expect((await res.json()).deduplicated).toBe(true);
    const events = eventsFor('subject_dedupe');
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('rejected');
  });

  // ── Advisory kind gate (mission-legibility.md Rule K2-13/K2-14) ───────────

  it('AC-15 (rejection): a mission task with no kind is WARNED, never 400ed', async () => {
    // `kind` is meaningful on every task, so a hard gate would fire on all of
    // them — including the `[friction]` filing an agent makes while already
    // failing, which is the caller least able to absorb a rejection and retry.
    const res = await POST(post({
      workspaceId: WS,
      title: '[friction] create_pr returned 409',
      description: 'Filed mid-failure.',
      missionId: MISSION,
    }));
    await settle();

    expect(res.status).toBe(200);
    const events = eventsFor('kind_absent');
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('warned');
    expect(events[0].surface).toBe('POST /api/tasks');
    expect(events[0].missionId).toBe(MISSION);
  });

  it('says nothing when the filer declared a kind', async () => {
    const res = await POST(post({
      workspaceId: WS, title: 'x', description: 'y', missionId: MISSION, kind: 'engineering',
    }));
    await settle();
    expect(res.status).toBe(200);
    expect(eventsFor('kind_absent')).toHaveLength(0);
  });

  it('says nothing for a task outside any mission', async () => {
    // The measurement this gate exists for is about mission legibility; a
    // standalone task has no rail to render unlabelled on.
    const res = await POST(post({ workspaceId: WS, title: 'x', description: 'y' }));
    await settle();
    expect(res.status).toBe(200);
    expect(eventsFor('kind_absent')).toHaveLength(0);
  });

  it('leaves the response untouched when the ledger itself is down', async () => {
    ledgerShouldReject = true;

    const refused = await POST(post({
      workspaceId: WS,
      title: 'x',
      description: 'y',
      missionId: MISSION,
      outputRequirement: 'pr_required',
    }));
    await settle();
    expect(refused.status).toBe(400);

    const created = await POST(post({ workspaceId: WS, title: 'Fine', description: 'Gated on task merging.' }));
    await settle();
    expect(created.status).toBe(200);

    expect(recorded).toHaveLength(0);
  });
});
