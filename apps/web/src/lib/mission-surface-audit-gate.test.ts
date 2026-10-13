import { beforeEach, describe, expect, it, mock } from 'bun:test';

let waiverNotes: Array<{ authorType: string; body: string | null; actorLabel?: string | null; createdAt?: Date }> = [];
let repoRow: any = { githubRepo: { fullName: 'acme/app', installation: { installationId: 7 } } };

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missionNotes: { findMany: async () => waiverNotes },
      workspaces: { findFirst: async () => repoRow },
      tasks: { findMany: async () => [] },
    },
  },
}));

const mockGithubApi = mock(async (_installationId: number, _path: string): Promise<unknown> => []);
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

const { evaluateSurfaceAuditGate, loadSurfaceAuditWaiver } = await import('./mission-surface-audit-gate');

const UI_FILE = 'apps/web/src/components/Card.tsx';

function builder(prNumber: number | null, extra: Record<string, unknown> = {}) {
  return {
    id: `t-${prNumber}`,
    title: 'Build it',
    status: 'completed',
    taskClass: 'work',
    workspaceId: 'ws-1',
    pathManifest: ['**'],
    workers: prNumber == null ? [] : [{ prNumber }],
    ...extra,
  };
}

function diffOf(...files: string[]) {
  mockGithubApi.mockImplementation(async () => files.map(filename => ({ filename })));
}

describe('evaluateSurfaceAuditGate', () => {
  beforeEach(() => {
    waiverNotes = [];
    repoRow = { githubRepo: { fullName: 'acme/app', installation: { installationId: 7 } } };
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation(async () => []);
  });

  it('requires an audit when a merged PR changed UI files even though the manifest was advisory', async () => {
    diffOf(UI_FILE, 'apps/web/src/lib/util.ts');
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate).toMatchObject({ required: true, source: 'diff', uiPaths: [UI_FILE] });
    expect(mockGithubApi.mock.calls[0][1]).toContain('/repos/acme/app/pulls/10/files');
  });

  it('requires an audit from declared paths alone when the task has no PR to read, without reading GitHub', async () => {
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(null, { pathManifest: [UI_FILE] })]);
    expect(gate).toMatchObject({ required: true, source: 'manifest', uiPaths: [UI_FILE] });
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('does not touch a backend-only mission', async () => {
    diffOf('apps/web/src/lib/util.ts', 'apps/web/src/app/api/tasks/route.ts', 'packages/core/db/schema.ts');
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate).toMatchObject({ required: false, why: 'no_ui_change' });
  });

  it('ignores tests, stories, snapshots and docs under a UI directory', async () => {
    diffOf(
      'apps/web/src/components/Card.test.tsx',
      'apps/web/src/components/Card.stories.tsx',
      'apps/web/src/components/__snapshots__/Card.snap',
      'apps/web/src/app/README.md',
    );
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate.required).toBe(false);
  });

  it('counts a file that was renamed out of a UI directory', async () => {
    mockGithubApi.mockImplementation(async () => [{ filename: 'apps/web/src/lib/Card.tsx', previous_filename: UI_FILE }]);
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate.required).toBe(true);
  });

  it('is cleared by a completed audit task, found by role or by title', async () => {
    diffOf(UI_FILE);
    const byTitle = { id: 'a', title: '[surface audit] Some mission', status: 'completed', taskClass: 'work', workers: [] };
    const byRole = { id: 'b', title: 'Look at it', status: 'completed', taskClass: 'work', roleSlug: 'visual-auditor', workers: [] };
    for (const audit of [byTitle, byRole]) {
      const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10), audit]);
      expect(gate).toMatchObject({ required: false, why: 'has_audit' });
    }
  });

  it('an audit that has not finished does not clear it', async () => {
    diffOf(UI_FILE);
    const pending = { id: 'a', title: '[surface audit] Some mission', status: 'pending', taskClass: 'work', workers: [] };
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10), pending]);
    expect(gate.required).toBe(true);
  });

  it('is cleared by a recorded human waiver', async () => {
    diffOf(UI_FILE);
    waiverNotes = [{ authorType: 'user', body: 'Copy-only change, reviewed by hand' }];
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate).toMatchObject({ required: false, why: 'waived' });
  });

  it('is not cleared by a waiver note an agent or the engine wrote, or an empty one', async () => {
    diffOf(UI_FILE);
    waiverNotes = [
      { authorType: 'agent', body: 'skip it' },
      { authorType: 'system', body: 'skip it' },
      { authorType: 'user', body: '   ' },
    ];
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate.required).toBe(true);
  });

  it('respects autoSurfaceAudit=false', async () => {
    diffOf(UI_FILE);
    const gate = await evaluateSurfaceAuditGate({ id: 'm1', autoSurfaceAudit: false }, [builder(10)]);
    expect(gate).toMatchObject({ required: false, why: 'opted_out' });
  });

  it('only looks at finished builder work; a cancelled task that touched UI is not a delivery', async () => {
    diffOf(UI_FILE);
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10, { status: 'failed' })]);
    expect(gate.required).toBe(false);
  });

  it('fails open when the diff cannot be read', async () => {
    mockGithubApi.mockImplementation(async () => { throw new Error('rate limited'); });
    const orig = console.error;
    console.error = () => {};
    try {
      const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
      expect(gate).toMatchObject({ required: false, why: 'not_checkable' });
    } finally {
      console.error = orig;
    }
  });

  it('fails open when the workspace has no linked repo', async () => {
    repoRow = { githubRepo: null };
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate).toMatchObject({ required: false, why: 'not_checkable' });
  });

  it('a task with no PR contributes nothing', async () => {
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(null)]);
    expect(gate).toMatchObject({ required: false, why: 'no_ui_change' });
  });
});

// task e7285dc4: the gate asks the visual impact classifier, not path prefixes,
// ignores rows whose paths are not the mission's own work, and follows the policy.
describe('evaluateSurfaceAuditGate — evidence the classifier reads', () => {
  const PAGE = 'apps/web/src/app/app/(protected)/tasks/page.tsx';
  const patchedDiff = (files: Array<{ filename: string; patch?: string }>) =>
    mockGithubApi.mockImplementation(async () => files);

  beforeEach(() => {
    waiverNotes = [];
    repoRow = { githubRepo: { fullName: 'acme/app', installation: { installationId: 7 } } };
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation(async () => []);
  });

  it("ignores a completed trunk-refresh task: its manifest widened to trunk's diff and its PR is trunk's", async () => {
    const refresh = builder(20, { id: 'refresh', title: 'chore(mission): merge dev into the mission branch', pathManifest: [UI_FILE, PAGE] });
    const byContext = builder(21, { id: 'refresh2', title: 'Refresh', context: { refreshTrunk: 'dev' }, pathManifest: [UI_FILE] });
    diffOf(UI_FILE);
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10, { pathManifest: ['packages/core/x.ts'] }), refresh, byContext]);
    const read = mockGithubApi.mock.calls.map(c => c[1]);
    expect(read.some(p => p.includes('/pulls/20/') || p.includes('/pulls/21/'))).toBe(false);
    // The builder's own PR (mocked to return UI_FILE) is still read.
    expect(read.some(p => p.includes('/pulls/10/'))).toBe(true);
    expect(gate).toMatchObject({ required: true, uiPaths: [UI_FILE] });
  });

  it('a mission whose only UI evidence came from a trunk refresh needs no audit', async () => {
    const refresh = builder(20, { id: 'refresh', title: 'chore(mission): merge dev into feature', pathManifest: [UI_FILE] });
    patchedDiff([{ filename: 'packages/core/x.ts', patch: '+export const x = 1;' }]);
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10), refresh]);
    expect(gate.required).toBe(false);
  });

  it('ignores the mission-PR bookkeeping row, even one stored as work', async () => {
    const ship = builder(30, { id: 'ship', title: 'Ship mission: Something', taskClass: 'work', pathManifest: [UI_FILE] });
    const shipBk = builder(31, { id: 'ship2', title: 'Ship mission: Something', taskClass: 'bookkeeping', pathManifest: [UI_FILE] });
    patchedDiff([{ filename: UI_FILE, patch: '+<div className="x">hi</div>' }]);
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [ship, shipBk]);
    expect(gate.required).toBe(false);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('a UI-directory change the classifier proves inert (comments, types) needs no audit, and says why', async () => {
    patchedDiff([
      { filename: UI_FILE, patch: '@@ -1,2 +1,2 @@\n-// old note\n+// new note\n' },
      { filename: 'apps/web/src/components/types.tsx', patch: '+export type Foo = { a: string };' },
    ]);
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate).toMatchObject({ required: false, why: 'no_render_impact' });
    if (gate.required) throw new Error('unreachable');
    expect(gate.assessment).toMatchObject({ recordKind: 'applicability', verdict: 'not_applicable', basis: 'rule' });
    expect(gate.assessment?.evidence.diffRead).toBe(true);
    expect(gate.assessment?.evidence.noRenderFiles).toBe(2);
  });

  it('server-only code under a UI directory needs no audit', async () => {
    patchedDiff([{ filename: 'apps/web/src/app/app/actions.ts', patch: "+'use server';\n+export async function go() {}" }]);
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate.required).toBe(false);
  });

  it('the diff outranks a declared manifest when every PR was read', async () => {
    patchedDiff([{ filename: 'packages/core/x.ts', patch: '+export const x = 1;' }]);
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10, { pathManifest: [UI_FILE] })]);
    expect(gate.required).toBe(false);
  });

  it('a changed route screen still owes an audit (protected), naming only the files that can render', async () => {
    patchedDiff([
      { filename: PAGE, patch: '-    <section className="p-2">\n+    <section className="p-4">' },
      { filename: UI_FILE, patch: '+// comment only' },
    ]);
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate).toMatchObject({ required: true, source: 'diff', uiPaths: [PAGE], policy: 'automatic', waiverAllowed: true });
    if (!gate.required) throw new Error('unreachable');
    expect(gate.assessment?.reasons.map(r => r.code)).toEqual(['protected_screen']);
  });

  it('a query-only screen is ambiguous, and with no model here it fails safe to an audit', async () => {
    patchedDiff([{ filename: PAGE, patch: '+  const rows = await db.query.tasks.findMany({ where: sqlWhere(x) });' }]);
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate).toMatchObject({ required: true, uiPaths: [PAGE] });
    if (!gate.required) throw new Error('unreachable');
    expect(gate.assessment).toMatchObject({ basis: 'fail_safe', reasons: [{ code: 'head_unknown' }] });
  });

  it('falls back to the declared manifest when the PR cannot be read', async () => {
    mockGithubApi.mockImplementation(async () => { throw new Error('rate limited'); });
    const orig = console.error;
    console.error = () => {};
    try {
      const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10, { pathManifest: [UI_FILE] })]);
      expect(gate).toMatchObject({ required: true, source: 'manifest', uiPaths: [UI_FILE] });
    } finally {
      console.error = orig;
    }
  });
});

describe('evaluateSurfaceAuditGate — Visual Review policy', () => {
  beforeEach(() => {
    waiverNotes = [];
    repoRow = { githubRepo: { fullName: 'acme/app', installation: { installationId: 7 } } };
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation(async () => [{ filename: UI_FILE, patch: '+<div className="x" />' }]);
  });

  const withPolicy = (policy: string) => { repoRow = { ...repoRow, gitConfig: { visualReview: { policy } } }; };

  it('workspace policy off never requires an audit', async () => {
    withPolicy('off');
    const gate = await evaluateSurfaceAuditGate({ id: 'm1', workspaceId: 'ws-1' }, [builder(10)]);
    expect(gate).toMatchObject({ required: false, why: 'opted_out' });
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('ask requires it and reports the policy', async () => {
    withPolicy('ask');
    const gate = await evaluateSurfaceAuditGate({ id: 'm1', workspaceId: 'ws-1' }, [builder(10)]);
    expect(gate).toMatchObject({ required: true, policy: 'ask', waiverAllowed: true });
  });

  it('strict requires it, ignores a waiver and the legacy mission opt-out, and forbids waiving', async () => {
    withPolicy('strict');
    waiverNotes = [{ authorType: 'user', body: 'Copy-only change, reviewed by hand' }];
    const gate = await evaluateSurfaceAuditGate({ id: 'm1', workspaceId: 'ws-1', autoSurfaceAudit: false }, [builder(10)]);
    expect(gate).toMatchObject({ required: true, policy: 'strict', waiverAllowed: false });
  });

  it('a person waiver still clears it under automatic', async () => {
    waiverNotes = [{ authorType: 'user', body: 'Copy-only change, reviewed by hand' }];
    const gate = await evaluateSurfaceAuditGate({ id: 'm1', workspaceId: 'ws-1' }, [builder(10)]);
    expect(gate).toMatchObject({ required: false, why: 'waived' });
  });
});

describe('loadSurfaceAuditWaiver', () => {
  it("returns the newest person-set waiver's reason, actor and time", async () => {
    waiverNotes = [
      { authorType: 'agent', body: 'An agent tried', actorLabel: 'worker w1', createdAt: new Date('2026-10-03T00:00:00Z') },
      { authorType: 'user', body: 'Copy-only change', actorLabel: 'owner@example.com', createdAt: new Date('2026-10-02T00:00:00Z') },
      { authorType: 'mcp', body: 'Older call', actorLabel: 'account "k"', createdAt: new Date('2026-10-01T00:00:00Z') },
    ];
    expect(await loadSurfaceAuditWaiver('m1')).toEqual({
      reason: 'Copy-only change', actorLabel: 'owner@example.com', at: '2026-10-02T00:00:00.000Z',
    });
  });

  it('is null when no person waived it', async () => {
    waiverNotes = [{ authorType: 'system', body: 'x', actorLabel: 'system', createdAt: new Date() }];
    expect(await loadSurfaceAuditWaiver('m1')).toBeNull();
  });
});
