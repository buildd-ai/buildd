import { describe, it, expect } from 'bun:test';
import {
  buildWorkspaceStateContext,
  type WorkspaceStateQuerier,
  type SiblingMission,
  type HeldClaim,
  type OpenPR,
  type InitiativeBrief,
} from './workspace-state-context';

// ── Stub data ─────────────────────────────────────────────────────────────────

const MISSION_ID = 'mission-aaa';
const WORKSPACE_ID = 'ws-111';
const TEAM_ID = 'team-222';
const INIT_ID = 'init-333';

function makeQuerier(overrides: Partial<WorkspaceStateQuerier> = {}): WorkspaceStateQuerier & {
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {
    getSiblingMissions: 0,
    getHeldClaims: 0,
    getOpenPRs: 0,
    getInitiativeBrief: 0,
    getBudgetLine: 0,
  };
  return {
    async getSiblingMissions() {
      calls.getSiblingMissions++;
      return [];
    },
    async getHeldClaims() {
      calls.getHeldClaims++;
      return [];
    },
    async getOpenPRs() {
      calls.getOpenPRs++;
      return [];
    },
    async getInitiativeBrief() {
      calls.getInitiativeBrief++;
      return null;
    },
    async getBudgetLine() {
      calls.getBudgetLine++;
      return null;
    },
    ...overrides,
    calls,
  };
}

const base = { missionId: MISSION_ID, workspaceId: WORKSPACE_ID, teamId: TEAM_ID };

// ── Cause: task_completed ─────────────────────────────────────────────────────

describe('cause: task_completed', () => {
  it('renders what-landed section with task + PR', async () => {
    const q = makeQuerier();
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'task_completed',
      causeData: { taskTitle: 'Fix auth bug', prNumber: 42, pathsReleased: ['src/auth/'] },
      querier: q,
    });
    expect(out).toContain('What landed');
    expect(out).toContain('Fix auth bug');
    expect(out).toContain('PR #42');
    expect(out).toContain('src/auth/');
  });

  it('renders unblocked tasks', async () => {
    const q = makeQuerier();
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'task_completed',
      causeData: { taskTitle: 'Done', unblockedTaskIds: ['task-xyz'] },
      querier: q,
    });
    expect(out).toContain('Unblocked');
    expect(out).toContain('task-xyz');
  });

  it('does NOT render sibling missions, held claims, initiative, or budget', async () => {
    const q = makeQuerier({
      async getSiblingMissions() { q.calls.getSiblingMissions++; return [{ id: 'x', title: 'Other', status: 'active', isHeld: false, pacingMode: 'eager', progress: 50 }]; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'task_completed',
      causeData: { taskTitle: 'Done' },
      querier: q,
    });
    expect(out).not.toContain('Sibling missions');
    expect(out).not.toContain('Held path claims');
    expect(out).not.toContain('initiative');
    expect(out).not.toContain('Budget');
  });

  it('makes zero querier calls for task_completed', async () => {
    const q = makeQuerier();
    await buildWorkspaceStateContext({
      ...base,
      cause: 'task_completed',
      causeData: { taskTitle: 'Done' },
      querier: q,
    });
    expect(q.calls.getSiblingMissions).toBe(0);
    expect(q.calls.getHeldClaims).toBe(0);
    expect(q.calls.getOpenPRs).toBe(0);
    expect(q.calls.getInitiativeBrief).toBe(0);
    expect(q.calls.getBudgetLine).toBe(0);
  });
});

// ── Cause: pr_merged ──────────────────────────────────────────────────────────

describe('cause: pr_merged', () => {
  it('renders what-landed with PR number when no taskTitle', async () => {
    const q = makeQuerier();
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'pr_merged',
      causeData: { prNumber: 99, pathsReleased: ['apps/web/'] },
      querier: q,
    });
    expect(out).toContain('What landed');
    expect(out).toContain('PR #99');
    expect(out).toContain('apps/web/');
  });

  it('does NOT render sibling missions, held claims, initiative', async () => {
    const q = makeQuerier();
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'pr_merged',
      causeData: { prNumber: 5 },
      querier: q,
    });
    expect(out).not.toContain('Sibling missions');
    expect(out).not.toContain('Held path claims');
  });
});

// ── Cause: conflict_escalation ───────────────────────────────────────────────

describe('cause: conflict_escalation', () => {
  it('renders blocking claim with taskId and cross-mission note', async () => {
    const q = makeQuerier();
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'conflict_escalation',
      causeData: {
        blockingTaskId: 'task-blocker-abc',
        blockingTaskTitle: 'Schema migration',
        blockingMissionId: 'mission-other',
        blockingPaths: ['src/db/'],
        waiterQueuePosition: 2,
      },
      querier: q,
    });
    expect(out).toContain('Blocking claim');
    expect(out).toContain('task-blocker-abc');
    expect(out).toContain('Schema migration');
    expect(out).toContain('different mission');
    expect(out).toContain('mission-other');
    expect(out).toContain('src/db/');
    expect(out).toContain('2');
  });

  it('renders same-mission note when blockingMissionId is null', async () => {
    const q = makeQuerier();
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'conflict_escalation',
      causeData: {
        blockingTaskId: 'task-same',
        blockingMissionId: null,
        blockingPaths: ['src/auth/'],
      },
      querier: q,
    });
    expect(out).toContain('same mission');
    expect(out).toContain('dependsOn');
  });

  it('does NOT render sibling missions, held claims', async () => {
    const q = makeQuerier();
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'conflict_escalation',
      causeData: { blockingTaskId: 'task-abc' },
      querier: q,
    });
    expect(out).not.toContain('Sibling missions');
    expect(out).not.toContain('Held path claims');
    expect(q.calls.getSiblingMissions).toBe(0);
    expect(q.calls.getHeldClaims).toBe(0);
  });
});

// ── Cause: claim_409 ──────────────────────────────────────────────────────────

describe('cause: claim_409', () => {
  it('renders blocking claim (same as conflict_escalation)', async () => {
    const q = makeQuerier();
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'claim_409',
      causeData: { blockingTaskId: 'task-blocker-xyz', blockingPaths: ['src/lib/'] },
      querier: q,
    });
    expect(out).toContain('Blocking claim');
    expect(out).toContain('task-blocker-xyz');
  });
});

// ── Cause: mission_evaluate ───────────────────────────────────────────────────

describe('cause: mission_evaluate', () => {
  it('renders sibling missions with progress and isHeld flag', async () => {
    const siblings: SiblingMission[] = [
      { id: 'ms-1', title: 'Build dashboard', status: 'active', isHeld: false, pacingMode: 'eager', progress: 65 },
      { id: 'ms-2', title: 'Fix API bugs', status: 'active', isHeld: true, pacingMode: 'paced', progress: 30 },
    ];
    const q = makeQuerier({
      async getSiblingMissions() { q.calls.getSiblingMissions++; return siblings; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'mission_evaluate',
      querier: q,
    });
    expect(out).toContain('Sibling missions');
    expect(out).toContain('Build dashboard');
    expect(out).toContain('65%');
    expect(out).toContain('Fix API bugs');
    expect(out).toContain('HELD');
    expect(out).toContain('paced');
  });

  it('renders held path claims with taskId and mission', async () => {
    const claims: HeldClaim[] = [
      {
        path: 'src/db/',
        taskId: 'task-claim-abc',
        taskTitle: 'Schema migration',
        missionId: 'mission-other',
        claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago
      },
    ];
    const q = makeQuerier({
      async getHeldClaims() { q.calls.getHeldClaims++; return claims; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'mission_evaluate',
      querier: q,
    });
    expect(out).toContain('Held path claims');
    expect(out).toContain('src/db/');
    expect(out).toContain('task-claim-abc');
    expect(out).toContain('Schema migration');
    expect(out).toContain('mission-other');
  });

  it('renders sibling with overlapping claim showing holder taskId and mission', async () => {
    const claims: HeldClaim[] = [
      {
        path: 'packages/core/db/schema.ts',
        taskId: 'task-holder-999',
        taskTitle: 'DB schema refactor',
        missionId: 'mission-sibling-111',
        claimedAt: new Date(Date.now() - 30 * 60 * 1000), // 30m ago
      },
    ];
    const siblings: SiblingMission[] = [
      { id: 'mission-sibling-111', title: 'Sibling refactor', status: 'active', isHeld: false, pacingMode: 'eager', progress: 20 },
    ];
    const q = makeQuerier({
      async getHeldClaims() { q.calls.getHeldClaims++; return claims; },
      async getSiblingMissions() { q.calls.getSiblingMissions++; return siblings; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'mission_evaluate',
      querier: q,
    });
    expect(out).toContain('task-holder-999');
    expect(out).toContain('mission-sibling-111');
  });

  it('renders parent initiative with KPI state', async () => {
    const brief: InitiativeBrief = {
      id: INIT_ID,
      title: 'Q3 Platform',
      status: 'active',
      progress: 45,
      description: null,
      kpiSummary: 'KPIs: 1/2 met',
    };
    const q = makeQuerier({
      async getInitiativeBrief() { q.calls.getInitiativeBrief++; return brief; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      initiativeId: INIT_ID,
      cause: 'mission_evaluate',
      querier: q,
    });
    expect(out).toContain('Q3 Platform');
    expect(out).toContain('45%');
    expect(out).toContain('KPIs: 1/2 met');
  });

  it('omits initiative section when mission has no initiativeId', async () => {
    const q = makeQuerier();
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'mission_evaluate',
      querier: q,
    });
    expect(out).not.toContain('Parent initiative');
    expect(q.calls.getInitiativeBrief).toBe(0);
  });

  it('renders budget line', async () => {
    const q = makeQuerier({
      async getBudgetLine() { q.calls.getBudgetLine++; return 'monthly: 67% used, ~5d to depletion'; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'mission_evaluate',
      querier: q,
    });
    expect(out).toContain('Budget');
    expect(out).toContain('67%');
  });

  it('makes exactly one call per querier method (no N+1)', async () => {
    const q = makeQuerier();
    await buildWorkspaceStateContext({
      ...base,
      initiativeId: INIT_ID,
      cause: 'mission_evaluate',
      querier: q,
    });
    expect(q.calls.getSiblingMissions).toBe(1);
    expect(q.calls.getHeldClaims).toBe(1);
    expect(q.calls.getOpenPRs).toBe(1);
    expect(q.calls.getInitiativeBrief).toBe(1);
    expect(q.calls.getBudgetLine).toBe(1);
  });
});

// ── Cause: first_decomposition ────────────────────────────────────────────────

describe('cause: first_decomposition', () => {
  it('renders the same sections as mission_evaluate', async () => {
    const siblings: SiblingMission[] = [
      { id: 'ms-x', title: 'Active sib', status: 'active', isHeld: false, pacingMode: 'eager', progress: 10 },
    ];
    const q = makeQuerier({
      async getSiblingMissions() { q.calls.getSiblingMissions++; return siblings; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'first_decomposition',
      querier: q,
    });
    expect(out).toContain('Sibling missions');
    expect(out).toContain('Active sib');
    expect(q.calls.getSiblingMissions).toBe(1);
    expect(q.calls.getHeldClaims).toBe(1);
  });
});

// ── Cause: fallback ───────────────────────────────────────────────────────────

describe('cause: fallback', () => {
  it('renders sibling missions and held claims', async () => {
    const siblings: SiblingMission[] = [
      { id: 'ms-1', title: 'Other mission', status: 'active', isHeld: false, pacingMode: 'eager', progress: 50 },
    ];
    const q = makeQuerier({
      async getSiblingMissions() { q.calls.getSiblingMissions++; return siblings; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'fallback',
      querier: q,
    });
    expect(out).toContain('Sibling missions');
    expect(out).toContain('Other mission');
  });

  it('omits initiative and budget in fallback', async () => {
    const q = makeQuerier({
      async getBudgetLine() { q.calls.getBudgetLine++; return 'monthly: 90% used'; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      initiativeId: INIT_ID,
      cause: 'fallback',
      querier: q,
    });
    expect(out).not.toContain('Parent initiative');
    expect(out).not.toContain('Budget');
    expect(q.calls.getInitiativeBrief).toBe(0);
    expect(q.calls.getBudgetLine).toBe(0);
  });
});

// ── Degradation: every source throwing ───────────────────────────────────────

describe('degradation: all data sources throwing', () => {
  it('still returns a valid (non-empty) string when queriers throw', async () => {
    const throwingQuerier: WorkspaceStateQuerier = {
      getSiblingMissions: async () => { throw new Error('DB down'); },
      getHeldClaims: async () => { throw new Error('DB down'); },
      getOpenPRs: async () => { throw new Error('DB down'); },
      getInitiativeBrief: async () => { throw new Error('DB down'); },
      getBudgetLine: async () => { throw new Error('DB down'); },
    };
    const out = await buildWorkspaceStateContext({
      ...base,
      initiativeId: INIT_ID,
      cause: 'mission_evaluate',
      querier: throwingQuerier,
    });
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('Workspace Situational Awareness');
  });

  it('degraded task_completed still returns header', async () => {
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'task_completed',
      causeData: {},
      querier: makeQuerier(),
    });
    expect(typeof out).toBe('string');
    expect(out).toContain('Workspace Situational Awareness');
  });
});

// ── Character budget enforcement ──────────────────────────────────────────────

describe('character budget enforcement', () => {
  it('truncates oversized sibling mission titles', async () => {
    const hugeTitle = 'A'.repeat(500);
    const siblings: SiblingMission[] = Array.from({ length: 10 }, (_, i) => ({
      id: `ms-${i}`,
      title: `${hugeTitle} ${i}`,
      status: 'active',
      isHeld: false,
      pacingMode: 'eager',
      progress: i * 10,
    }));
    const q = makeQuerier({
      async getSiblingMissions() { q.calls.getSiblingMissions++; return siblings; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'mission_evaluate',
      querier: q,
    });
    // Sibling section must be bounded
    const siblingSection = out.split('###').find(s => s.startsWith(' Sibling'));
    expect(siblingSection).toBeDefined();
    if (siblingSection) {
      expect(siblingSection.length).toBeLessThanOrEqual(700);
    }
  });

  it('caps held claims to at most 10 paths shown', async () => {
    const manyClaims: HeldClaim[] = Array.from({ length: 20 }, (_, i) => ({
      path: `src/module-${i}/index.ts`,
      taskId: `task-${i}`,
      taskTitle: `Task ${i}`,
      missionId: null,
      claimedAt: new Date(Date.now() - i * 60000),
    }));
    const q = makeQuerier({
      async getHeldClaims() { q.calls.getHeldClaims++; return manyClaims; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'mission_evaluate',
      querier: q,
    });
    expect(out).toContain('Held path claims');
    // Should show at most 10 paths
    const matches = (out.match(/src\/module-/g) || []).length;
    expect(matches).toBeLessThanOrEqual(10);
  });
});

// ── Claim age visible for stale claims ───────────────────────────────────────

describe('stale claim visibility', () => {
  it('shows claim age so stale rows are visually obvious', async () => {
    const claims: HeldClaim[] = [
      {
        path: 'src/lib/',
        taskId: 'task-old',
        taskTitle: null,
        missionId: null,
        claimedAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3h ago
      },
    ];
    const q = makeQuerier({
      async getHeldClaims() { q.calls.getHeldClaims++; return claims; },
    });
    const out = await buildWorkspaceStateContext({
      ...base,
      cause: 'mission_evaluate',
      querier: q,
    });
    expect(out).toMatch(/3h ago|2h ago/); // time rendering
  });
});
