import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// Only the DB handle and storage are mocked. drizzle-orm and the schema stay
// real so the loader's predicates can be rendered to SQL and asserted: a
// mocked db returns rows whatever the WHERE says.
const mockArtifactsFindMany = mock((_args: any) => Promise.resolve([] as any[]));
const mockTasksFindFirst = mock((_args: any) => Promise.resolve(null as any));
const mockTasksFindMany = mock((_args: any) => Promise.resolve([] as any[]));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      artifacts: { findMany: mockArtifactsFindMany },
      tasks: { findFirst: mockTasksFindFirst, findMany: mockTasksFindMany },
    },
  },
}));
const mockObjectExists = mock((_key: string) => Promise.resolve(true));
mock.module('@/lib/storage', () => ({ objectExists: mockObjectExists }));

const {
  evaluateVisualAuditEvidence,
  formatVisualEvidenceRejection,
  loadVisualAuditEvidence,
  parseQaMeta,
  mintedByUploadUrl,
  eligibleFixTaskIds,
} = await import('./visual-audit-evidence');

const dialect = new PgDialect();
const render = (where: any) => {
  const q = dialect.sqlToQuery(where);
  return { sql: q.sql, params: q.params };
};

const FIX = '11111111-2222-4333-8444-555555555555';

function shot(id: string, qa: Record<string, unknown> | null, storageKey: string | null = `artifacts/ws-1/${id}/s.png`) {
  return { id, storageKey, metadata: qa ? { qa, filename: 's.png' } : { filename: 's.png' } };
}
const qa = (route: string, viewport: string, extra: Record<string, unknown> = {}) => ({
  runKey: 'run-1', route, viewport, finding: 'Header and list render; no overflow.', verdict: 'ok', ...extra,
});

describe('parseQaMeta', () => {
  it('reads a well-formed qa block', () => {
    expect(parseQaMeta({ qa: qa('/app/missions', 'mobile') })).toMatchObject({ route: '/app/missions', viewport: 'mobile', verdict: 'ok' });
  });
  it('rejects unknown viewports and verdicts, and non-objects', () => {
    expect(parseQaMeta({ qa: qa('/app/missions', 'tablet') })).toBeNull();
    expect(parseQaMeta({ qa: qa('/app/missions', 'mobile', { verdict: 'great' }) })).toBeNull();
    expect(parseQaMeta({ qa: 'x' })).toBeNull();
    expect(parseQaMeta(null)).toBeNull();
    expect(parseQaMeta({ qa: { ...qa('/x', 'mobile'), route: 'no-slash' } })).toBeNull();
  });
});

describe('evaluateVisualAuditEvidence', () => {
  const all = (ids: string[]) => new Set(ids);

  it('passes when every required route has a finding at both viewports', () => {
    const shots = [
      shot('a', qa('/app/missions', 'mobile')),
      shot('b', qa('/app/missions', 'desktop')),
    ];
    const v = evaluateVisualAuditEvidence({ requiredRoutes: ['/app/missions'], shots, uploadedIds: all(['a', 'b']), linkedFixTaskIds: new Set() });
    expect(v.ok).toBe(true);
  });

  it('names each missing route × viewport', () => {
    const shots = [shot('a', qa('/app/missions', 'mobile'))];
    const v = evaluateVisualAuditEvidence({ requiredRoutes: ['/app/missions', '/app/tasks'], shots, uploadedIds: all(['a']), linkedFixTaskIds: new Set() });
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['/app/missions @ desktop', '/app/tasks @ mobile', '/app/tasks @ desktop']);
  });

  it('a shot with an empty finding does not count', () => {
    const shots = [
      shot('a', qa('/app/missions', 'mobile', { finding: '   ' })),
      shot('b', qa('/app/missions', 'desktop')),
    ];
    const v = evaluateVisualAuditEvidence({ requiredRoutes: ['/app/missions'], shots, uploadedIds: all(['a', 'b']), linkedFixTaskIds: new Set() });
    expect(v.missing).toEqual(['/app/missions @ mobile']);
    expect(v.emptyFindings).toEqual(['a']);
  });

  it('a row whose object never landed in storage does not count', () => {
    const shots = [shot('a', qa('/app/missions', 'mobile')), shot('b', qa('/app/missions', 'desktop'))];
    const v = evaluateVisualAuditEvidence({ requiredRoutes: ['/app/missions'], shots, uploadedIds: all(['b']), linkedFixTaskIds: new Set() });
    expect(v.missing).toEqual(['/app/missions @ mobile']);
    expect(v.notUploaded).toEqual(['a']);
  });

  it('a shot without qa metadata does not count', () => {
    const shots = [shot('a', null), shot('b', qa('/app/missions', 'desktop'))];
    const v = evaluateVisualAuditEvidence({ requiredRoutes: ['/app/missions'], shots, uploadedIds: all(['a', 'b']), linkedFixTaskIds: new Set() });
    expect(v.missing).toEqual(['/app/missions @ mobile']);
  });

  it('every issue needs a linked fix task', () => {
    const shots = [
      shot('a', qa('/app/missions', 'mobile', { verdict: 'issue' })),
      shot('b', qa('/app/missions', 'desktop', { verdict: 'issue', fixTaskId: FIX })),
    ];
    const unlinked = evaluateVisualAuditEvidence({ requiredRoutes: ['/app/missions'], shots, uploadedIds: all(['a', 'b']), linkedFixTaskIds: new Set([FIX]) });
    expect(unlinked.ok).toBe(false);
    expect(unlinked.missing).toEqual([]);
    expect(unlinked.unlinkedIssues).toEqual(['a']);

    // A fixTaskId that doesn't resolve to a task in the mission is no link.
    const dangling = evaluateVisualAuditEvidence({ requiredRoutes: ['/app/missions'], shots: [shots[1]], uploadedIds: all(['b']), linkedFixTaskIds: new Set() });
    expect(dangling.unlinkedIssues).toEqual(['b']);
  });

  it('unsure needs no fix task (it goes to a question)', () => {
    const shots = [
      shot('a', qa('/app/missions', 'mobile', { verdict: 'unsure' })),
      shot('b', qa('/app/missions', 'desktop')),
    ];
    expect(evaluateVisualAuditEvidence({ requiredRoutes: ['/app/missions'], shots, uploadedIds: all(['a', 'b']), linkedFixTaskIds: new Set() }).ok).toBe(true);
  });

  it('a concrete URL satisfies its :param pattern', () => {
    const shots = [
      shot('a', qa('/app/tasks/abc-123', 'mobile')),
      shot('b', qa('/app/tasks/:id', 'desktop')),
    ];
    expect(evaluateVisualAuditEvidence({ requiredRoutes: ['/app/tasks/:id'], shots, uploadedIds: all(['a', 'b']), linkedFixTaskIds: new Set() }).ok).toBe(true);
    // ...but not a deeper path.
    const deeper = [shot('c', qa('/app/tasks/abc/edit', 'mobile')), shots[1]];
    expect(evaluateVisualAuditEvidence({ requiredRoutes: ['/app/tasks/:id'], shots: deeper, uploadedIds: all(['c', 'b']), linkedFixTaskIds: new Set() }).missing).toEqual(['/app/tasks/:id @ mobile']);
  });

  it('with no derived routes, still demands at least one route at both viewports', () => {
    const none = evaluateVisualAuditEvidence({ requiredRoutes: [], shots: [], uploadedIds: new Set(), linkedFixTaskIds: new Set() });
    expect(none.ok).toBe(false);
    expect(none.missing.length).toBeGreaterThan(0);

    const half = evaluateVisualAuditEvidence({ requiredRoutes: [], shots: [shot('a', qa('/app/x', 'mobile'))], uploadedIds: all(['a']), linkedFixTaskIds: new Set() });
    expect(half.missing).toEqual(['/app/x @ desktop']);

    const full = evaluateVisualAuditEvidence({
      requiredRoutes: [],
      shots: [shot('a', qa('/app/x', 'mobile')), shot('b', qa('/app/x', 'desktop'))],
      uploadedIds: all(['a', 'b']),
      linkedFixTaskIds: new Set(),
    });
    expect(full.ok).toBe(true);
  });
});

describe('formatVisualEvidenceRejection', () => {
  it('says what is missing and how to fix it', () => {
    const msg = formatVisualEvidenceRejection({
      ok: false,
      requiredRoutes: ['/app/tasks'],
      missing: ['/app/tasks @ mobile'],
      emptyFindings: ['a'],
      notUploaded: ['b'],
      unlinkedIssues: ['c'],
    });
    expect(msg).toContain('/app/tasks @ mobile');
    expect(msg).toContain('upload_artifact');
    expect(msg).toContain('finding');
    expect(msg).toContain('fixTaskId');
    expect(msg).toContain('a');
    expect(msg).toContain('c');
  });

  it('caps a long list', () => {
    const missing = Array.from({ length: 60 }, (_, i) => `/r${i} @ mobile`);
    const msg = formatVisualEvidenceRejection({ ok: false, requiredRoutes: [], missing, emptyFindings: [], notUploaded: [], unlinkedIssues: [] });
    expect(msg).toContain('/r0 @ mobile');
    expect(msg).not.toContain('/r59 @ mobile');
    expect(msg).toContain('more');
  });
});

describe('loadVisualAuditEvidence', () => {
  const WORKER = 'aaaaaaaa-0000-4000-8000-000000000001';
  const TASK = 'aaaaaaaa-0000-4000-8000-000000000002';
  const DEP = 'aaaaaaaa-0000-4000-8000-000000000003';
  const MISSION = 'aaaaaaaa-0000-4000-8000-000000000004';

  beforeEach(() => {
    mockArtifactsFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockObjectExists.mockReset();
    mockObjectExists.mockResolvedValue(true);
  });

  function setup() {
    mockTasksFindFirst.mockResolvedValue({
      dependsOn: [DEP],
      context: { visualQa: { requiredRoutes: ['/app/home'] } },
    });
    mockTasksFindMany
      // dependency manifests
      .mockResolvedValueOnce([{ pathManifest: ['apps/web/src/app/app/(protected)/missions/page.tsx', '**'] }])
      // linked fix tasks
      .mockResolvedValueOnce([{ id: FIX, title: '[surface fix] /app/missions: overflow', status: 'pending', createdAt: new Date() }]);
    mockArtifactsFindMany.mockResolvedValue([
      shot('a', qa('/app/missions', 'mobile')),
      shot('b', qa('/app/missions', 'desktop', { verdict: 'issue', fixTaskId: FIX })),
      shot('c', qa('/app/home', 'mobile')),
      shot('d', qa('/app/home', 'desktop'), null),
    ]);
  }

  it('derives required routes from dependsOn manifests plus a frozen context list', async () => {
    setup();
    const v = await loadVisualAuditEvidence({ workerId: WORKER, taskId: TASK, missionId: MISSION, workspaceId: 'ws-1' });
    expect(v.requiredRoutes).toEqual(['/app/home', '/app/missions']);
    // d has no storage key → not uploaded → /app/home @ desktop missing.
    expect(v.missing).toEqual(['/app/home @ desktop']);
    expect(v.notUploaded).toEqual(['d']);
    expect(v.unlinkedIssues).toEqual([]);
  });

  it('counts only screenshots written by THIS worker', async () => {
    setup();
    await loadVisualAuditEvidence({ workerId: WORKER, taskId: TASK, missionId: MISSION, workspaceId: 'ws-1' });
    const { sql, params } = render(mockArtifactsFindMany.mock.calls[0][0].where);
    expect(sql).toBe('("artifacts"."worker_id" = $1 and "artifacts"."type" = $2)');
    expect(params).toEqual([WORKER, 'screenshot']);
    // No mission-artifact OR arm: a sibling's screenshot must never count.
    expect(sql).not.toContain('mission_id');
  });

  it('only accepts fix tasks in the same mission and workspace', async () => {
    setup();
    await loadVisualAuditEvidence({ workerId: WORKER, taskId: TASK, missionId: MISSION, workspaceId: 'ws-1' });
    const { sql, params } = render(mockTasksFindMany.mock.calls[1][0].where);
    expect(sql).toBe('("tasks"."id" in ($1) and "tasks"."mission_id" = $2 and "tasks"."workspace_id" = $3)');
    expect(params).toEqual([FIX, MISSION, 'ws-1']);
  });

  it('HEADs every candidate object and fails closed when storage errors', async () => {
    setup();
    mockObjectExists.mockImplementation((key: string) =>
      key.includes('/a/') ? Promise.reject(new Error('r2 down')) : Promise.resolve(true),
    );
    const v = await loadVisualAuditEvidence({ workerId: WORKER, taskId: TASK, missionId: MISSION, workspaceId: 'ws-1' });
    expect(mockObjectExists).toHaveBeenCalledTimes(3);
    expect(v.notUploaded.sort()).toEqual(['a', 'd']);
    expect(v.missing).toContain('/app/missions @ mobile');
  });

  // Reusing one stored object: create_artifact accepts any storageKey under the
  // workspace prefix and stamps workerId = this worker, so without the minted
  // check one upload could back every route × viewport row.
  it('a row pointing at another artifact\'s object does not count, and is not HEADed', async () => {
    mockTasksFindFirst.mockResolvedValue({ dependsOn: [], context: { visualQa: { requiredRoutes: ['/app/home'] } } });
    mockArtifactsFindMany.mockResolvedValue([
      shot('a', qa('/app/home', 'mobile')),
      // Same object as 'a', recorded as the desktop shot.
      shot('b', qa('/app/home', 'desktop'), 'artifacts/ws-1/a/s.png'),
    ]);
    const v = await loadVisualAuditEvidence({ workerId: WORKER, taskId: TASK, missionId: MISSION, workspaceId: 'ws-1' });
    expect(mockObjectExists).toHaveBeenCalledTimes(1);
    expect(v.notUploaded).toEqual(['b']);
    expect(v.missing).toEqual(['/app/home @ desktop']);
    expect(v.ok).toBe(false);
  });

  it('an issue linked to the audit itself or to a finished builder dependency is unlinked', async () => {
    mockTasksFindFirst.mockResolvedValue({ dependsOn: [DEP], context: {} });
    mockTasksFindMany
      .mockResolvedValueOnce([{ pathManifest: [] }])
      .mockResolvedValueOnce([
        { id: TASK, title: '[surface fix] self', status: 'in_progress', createdAt: new Date() },
        { id: DEP, title: 'Build the missions page', status: 'completed', createdAt: new Date(0) },
      ]);
    mockArtifactsFindMany.mockResolvedValue([
      shot('a', qa('/app/x', 'mobile', { verdict: 'issue', fixTaskId: TASK })),
      shot('b', qa('/app/x', 'desktop', { verdict: 'issue', fixTaskId: DEP })),
    ]);
    const v = await loadVisualAuditEvidence({
      workerId: WORKER, taskId: TASK, missionId: MISSION, workspaceId: 'ws-1', workerStartedAt: new Date(1_000),
    });
    expect(v.unlinkedIssues.sort()).toEqual(['a', 'b']);
    expect(v.ok).toBe(false);
  });

  it('skips the fix-task query when no issue carries a well-formed id', async () => {
    mockTasksFindFirst.mockResolvedValue({ dependsOn: [], context: {} });
    mockArtifactsFindMany.mockResolvedValue([shot('a', qa('/app/x', 'mobile', { verdict: 'issue', fixTaskId: 'not-a-uuid' }))]);
    const v = await loadVisualAuditEvidence({ workerId: WORKER, taskId: TASK, missionId: MISSION, workspaceId: 'ws-1' });
    expect(mockTasksFindMany).not.toHaveBeenCalled();
    expect(v.unlinkedIssues).toEqual(['a']);
  });
});

describe('mintedByUploadUrl', () => {
  it('accepts exactly qa/<workspace>/<row id>/<name>, the key upload-url mints for an auditor screenshot', () => {
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'qa/ws-1/a/s.png' }, 'ws-1')).toBe(true);
  });
  it('rejects a qa key naming another row, another workspace, extra depth, no name, or qa not leading', () => {
    expect(mintedByUploadUrl({ id: 'b', storageKey: 'qa/ws-1/a/s.png' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'qa/ws-2/a/s.png' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'qa/ws-1/a/x/s.png' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'qa/ws-1/a/' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'qa/ws-1/a' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'qa/ws-1/a/..' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'artifacts/ws-1/qa/a/s.png' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'sessions/ws-1/a/s.png' }, 'ws-1')).toBe(false);
  });
  it('accepts exactly artifacts/<workspace>/<row id>/<name>', () => {
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'artifacts/ws-1/a/s.png' }, 'ws-1')).toBe(true);
  });
  it('rejects another row\'s key, another workspace, other prefixes, extra depth and null', () => {
    expect(mintedByUploadUrl({ id: 'b', storageKey: 'artifacts/ws-1/a/s.png' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'artifacts/ws-2/a/s.png' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'attachments/ws-1/a/s.png' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'artifacts/ws-1/a/x/s.png' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: 'artifacts/ws-1/a/' }, 'ws-1')).toBe(false);
    expect(mintedByUploadUrl({ id: 'a', storageKey: null }, 'ws-1')).toBe(false);
  });
});

describe('eligibleFixTaskIds', () => {
  const started = new Date('2026-08-01T10:00:00.000Z');
  const before = new Date('2026-08-01T09:00:00.000Z');
  const after = new Date('2026-08-01T10:30:00.000Z');
  const opts = { auditTaskId: 'audit', workerStartedAt: started };
  const row = (id: string, status: string, createdAt: Date, title = `[surface fix] /x: ${id}`) => ({ id, title, status, createdAt });

  it('accepts an open [surface fix] task, and one created (and closed) during this run', () => {
    expect([...eligibleFixTaskIds([row('open-old', 'pending', before), row('closed-new', 'completed', after)], opts)].sort())
      .toEqual(['closed-new', 'open-old']);
  });
  // ensureMissionSurfaceAudit appends the auditor's own fix tasks to its
  // dependsOn, so being a dependency must not disqualify a fix task.
  it('accepts a fix task that has been appended to the audit\'s dependsOn', () => {
    expect([...eligibleFixTaskIds([row('fix-dep', 'pending', after)], opts)]).toEqual(['fix-dep']);
  });
  it('rejects the audit itself, non-fix titles (a builder task), and fix tasks closed before this run', () => {
    expect([...eligibleFixTaskIds([
      row('audit', 'in_progress', after),
      row('builder', 'completed', before, 'Build the page'),
      row('other', 'pending', after, 'Build the page'),
      row('stale', 'completed', before),
    ], opts)]).toEqual([]);
  });
});
