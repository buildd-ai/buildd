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
    expect(gate).toEqual({ required: true, source: 'diff', uiPaths: [UI_FILE] });
    expect(mockGithubApi.mock.calls[0][1]).toContain('/repos/acme/app/pulls/10/files');
  });

  it('requires an audit from declared paths alone, without reading GitHub', async () => {
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10, { pathManifest: [UI_FILE] })]);
    expect(gate).toEqual({ required: true, source: 'manifest', uiPaths: [UI_FILE] });
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('does not touch a backend-only mission', async () => {
    diffOf('apps/web/src/lib/util.ts', 'apps/web/src/app/api/tasks/route.ts', 'packages/core/db/schema.ts');
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate).toEqual({ required: false, why: 'no_ui_change' });
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
      expect(gate).toEqual({ required: false, why: 'has_audit' });
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
    expect(gate).toEqual({ required: false, why: 'waived' });
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
    expect(gate).toEqual({ required: false, why: 'opted_out' });
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
      expect(gate).toEqual({ required: false, why: 'not_checkable' });
    } finally {
      console.error = orig;
    }
  });

  it('fails open when the workspace has no linked repo', async () => {
    repoRow = { githubRepo: null };
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(10)]);
    expect(gate).toEqual({ required: false, why: 'not_checkable' });
  });

  it('a task with no PR contributes nothing', async () => {
    const gate = await evaluateSurfaceAuditGate({ id: 'm1' }, [builder(null)]);
    expect(gate).toEqual({ required: false, why: 'no_ui_change' });
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
