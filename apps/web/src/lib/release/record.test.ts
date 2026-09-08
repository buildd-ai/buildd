import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { recordAndDispatchRelease, type RecordAndDispatchParams } from './record';

/**
 * Render a real drizzle predicate to SQL + params.
 *
 * These are genuine SQL objects (drizzle is NOT mocked in this file, on
 * purpose), so they are cyclic and cannot be JSON.stringify'd. Rendering them
 * is also strictly better: it asserts the column names and bound values the
 * database will actually see, rather than the shape of a stub.
 */
const dialect = new PgDialect();
function renderSql(condition: unknown): string {
  const { sql, params } = dialect.sqlToQuery(condition as any);
  return `${sql} :: ${JSON.stringify(params)}`;
}

// The db is stubbed rather than mock.module'd so the predicates stay
// observable: a mocked `db` whose where() ignores its argument makes every
// scoping bug invisible, which is how the (workspace, head_sha) dedup went
// untested in the first place.
function stubDb(over: {
  existingInFlight?: { id: string } | null;
  insertReturns?: string;
} = {}) {
  const calls = {
    findFirstWhere: [] as any[],
    inserted: [] as any[],
    onConflict: [] as any[],
    updates: [] as Array<{ values: any; where: any }>,
  };
  const db: any = {
    query: {
      releases: {
        findFirst: (args: any) => {
          calls.findFirstWhere.push(args?.where);
          return Promise.resolve(over.existingInFlight ?? undefined);
        },
      },
    },
    insert: () => ({
      values: (v: any) => {
        calls.inserted.push(v);
        const chain: any = {
          onConflictDoUpdate: (c: any) => {
            calls.onConflict.push(c);
            return { returning: () => Promise.resolve([{ id: over.insertReturns ?? 'rel-1' }]) };
          },
          returning: () => Promise.resolve([{ id: over.insertReturns ?? 'rel-1' }]),
        };
        return chain;
      },
    }),
    update: () => ({
      set: (values: any) => ({
        where: (where: any) => {
          calls.updates.push({ values, where });
          return Promise.resolve([]);
        },
      }),
    }),
  };
  return { db, calls };
}

const params = (over: Partial<RecordAndDispatchParams> = {}): RecordAndDispatchParams => ({
  workspaceId: 'ws-1',
  archetype: 'gated',
  installationId: 42,
  owner: 'acme',
  name: 'app',
  repoFullName: 'acme/app',
  workflowFile: 'release.yml',
  ref: 'dev',
  prodBranch: 'main',
  inputs: { force: 'false' },
  triggeredBy: 'auto',
  ...over,
});

const okPreflight = mock(() =>
  Promise.resolve({
    ref: 'dev',
    prodBranch: 'main',
    aheadBy: 3,
    shippableCommits: [],
    refHeadSha: 'head-sha',
    previousSha: 'prev-sha',
    ciState: 'passing' as const,
    failingChecks: [],
  }),
);

const okDispatch = mock(() =>
  Promise.resolve({
    dispatched: true,
    workflowFile: 'release.yml',
    ref: 'dev',
    inputs: {},
    runId: 7,
    runUrl: 'https://gh/runs/7',
    runsUrl: 'https://gh/workflows/release.yml',
  }),
);

describe('recordAndDispatchRelease', () => {
  it('records the row before dispatching, so a dispatch is never unrecorded', async () => {
    const { db, calls } = stubDb();
    const order: string[] = [];
    const dispatch = mock(() => {
      order.push('dispatch');
      return okDispatch();
    });
    const insertSpy = db.insert;
    db.insert = (...a: any[]) => {
      order.push('insert');
      return insertSpy(...a);
    };

    const res = await recordAndDispatchRelease(params(), {
      db,
      preflight: okPreflight as any,
      dispatch: dispatch as any,
      attribute: mock(() => Promise.resolve({ attributed: 1, skipped: 0 })) as any,
    });

    expect(res.ok).toBe(true);
    expect(order).toEqual(['insert', 'dispatch']);
    expect(calls.inserted[0]).toMatchObject({
      workspaceId: 'ws-1',
      archetype: 'gated',
      headSha: 'head-sha',
      previousSha: 'prev-sha',
      state: 'dispatched',
      triggeredBy: 'auto',
      ciStateAtDispatch: 'passing',
      commitsAheadAtDispatch: 3,
    });
  });

  it('records a gated release under triggeredBy=auto — previously impossible', async () => {
    // For gated + workflow_dispatch, every automatic path filtered on
    // branch_merge first, so no `auto` row could ever exist and the Releases
    // page saw nothing that actually shipped.
    const { db, calls } = stubDb();
    const res = await recordAndDispatchRelease(params({ triggeredBy: 'auto' }), {
      db,
      preflight: okPreflight as any,
      dispatch: okDispatch as any,
      attribute: mock(() => Promise.resolve({ attributed: 0, skipped: 0 })) as any,
    });

    expect(res.ok).toBe(true);
    expect(calls.inserted[0].triggeredBy).toBe('auto');
    expect(calls.inserted[0].verificationStrategy).toBe('http');
  });

  it('refuses to record a release with no resolvable head sha', async () => {
    const { db, calls } = stubDb();
    const dispatch = mock(() => okDispatch());
    const res = await recordAndDispatchRelease(params(), {
      db,
      preflight: mock(() => Promise.reject(new Error('compare 404'))) as any,
      githubApi: mock(() => Promise.resolve({})) as any, // no object.sha
      dispatch: dispatch as any,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(422);
    // Nothing recorded, nothing dispatched: a row with no commit range cannot
    // be attributed, sha-verified, or matched back to its workflow run.
    expect(calls.inserted).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('falls back to the ref head when the compare yields no sha', async () => {
    const { db, calls } = stubDb();
    const res = await recordAndDispatchRelease(params(), {
      db,
      preflight: mock(() =>
        Promise.resolve({
          ref: 'dev', prodBranch: 'main', aheadBy: 0, shippableCommits: [],
          refHeadSha: undefined, previousSha: undefined, ciState: 'unknown' as const, failingChecks: [],
        }),
      ) as any,
      githubApi: mock(() => Promise.resolve({ object: { sha: 'ref-head' } })) as any,
      dispatch: okDispatch as any,
    });

    expect(res.ok).toBe(true);
    expect(calls.inserted[0].headSha).toBe('ref-head');
  });

  it('dedupes against an in-flight release for the same commit', async () => {
    const { db, calls } = stubDb({ existingInFlight: { id: 'rel-existing' } });
    const dispatch = mock(() => okDispatch());

    const res = await recordAndDispatchRelease(params(), {
      db,
      preflight: okPreflight as any,
      dispatch: dispatch as any,
    });

    expect(res).toMatchObject({ ok: true, releaseId: 'rel-existing', deduped: true });
    expect(calls.inserted).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
    // The dedup must be scoped to this workspace AND this commit AND in-flight
    // states — the mock ignores the clause, so assert its shape.
    const flat = renderSql(calls.findFirstWhere[0]);
    expect(flat).toContain('workspace_id');
    expect(flat).toContain('head_sha');
    expect(flat).toContain('"ws-1"');
    expect(flat).toContain('"head-sha"');
    expect(flat).toContain('"dispatched"');
    expect(flat).toContain('"deploying"');
  });

  it('re-arms a terminal row for the same commit instead of raising a unique violation', async () => {
    // (workspace_id, head_sha) is unique across EVERY state, but the dedup
    // check only looks at in-flight ones — so re-releasing a commit whose row
    // went healthy/failed used to hit 23505 and surface as an opaque 500.
    const { db, calls } = stubDb({ existingInFlight: null });
    const res = await recordAndDispatchRelease(params(), {
      db,
      preflight: okPreflight as any,
      dispatch: okDispatch as any,
    });

    expect(res.ok).toBe(true);
    expect(calls.onConflict).toHaveLength(1);
    // Stale lifecycle fields must not bleed into the fresh dispatch.
    expect(calls.onConflict[0].set).toMatchObject({
      runUrl: null,
      deployedAt: null,
      healthyAt: null,
      failureReason: null,
    });
  });

  it('marks the row failed when the dispatch itself throws', async () => {
    const { db, calls } = stubDb();
    const res = await recordAndDispatchRelease(params(), {
      db,
      preflight: okPreflight as any,
      dispatch: mock(() => Promise.reject(new Error('github 502'))) as any,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(502);
      expect(res.releaseId).toBe('rel-1');
    }
    const failed = calls.updates.find(u => u.values.state === 'failed');
    expect(failed).toBeDefined();
    expect(String(failed!.values.failureReason)).toContain('github 502');
    // Guarded so a workflow_run arriving first is not clobbered.
    expect(renderSql(failed!.where)).toContain('"dispatched"');
  });

  it('backfills the run url when the readback resolved one', async () => {
    const { db, calls } = stubDb();
    await recordAndDispatchRelease(params(), {
      db,
      preflight: okPreflight as any,
      dispatch: okDispatch as any,
    });
    expect(calls.updates.some(u => u.values.runUrl === 'https://gh/runs/7')).toBe(true);
  });

  it('does not record a run url when the readback found no run', async () => {
    // Storing the runs LIST url here is what made a row unmatchable by the
    // workflow_run webhook while looking like it had a run.
    const { db, calls } = stubDb();
    await recordAndDispatchRelease(params(), {
      db,
      preflight: okPreflight as any,
      dispatch: mock(() =>
        Promise.resolve({
          dispatched: true, workflowFile: 'release.yml', ref: 'dev', inputs: {},
          runsUrl: 'https://gh/workflows/release.yml',
        }),
      ) as any,
    });
    expect(calls.updates.some(u => 'runUrl' in u.values)).toBe(false);
  });

  it('awaits attribution instead of firing it into a freezing serverless instance', async () => {
    let settled = false;
    const attribute = mock(async () => {
      await new Promise(r => setTimeout(r, 5));
      settled = true;
      return { attributed: 2, skipped: 0 };
    });

    const { db } = stubDb();
    await recordAndDispatchRelease(params(), {
      db,
      preflight: okPreflight as any,
      dispatch: okDispatch as any,
      attribute: attribute as any,
    });

    expect(settled).toBe(true);
  });

  it('survives an attribution failure — the release still shipped', async () => {
    const { db } = stubDb();
    const res = await recordAndDispatchRelease(params(), {
      db,
      preflight: okPreflight as any,
      dispatch: okDispatch as any,
      attribute: mock(() => Promise.reject(new Error('stale token'))) as any,
    });
    expect(res.ok).toBe(true);
  });

  it('skips attribution when there is no commit range to walk', async () => {
    const attribute = mock(() => Promise.resolve({ attributed: 0, skipped: 0 }));
    const { db } = stubDb();
    await recordAndDispatchRelease(params(), {
      db,
      preflight: mock(() =>
        Promise.resolve({
          ref: 'dev', prodBranch: 'main', aheadBy: 0, shippableCommits: [],
          refHeadSha: 'head-sha', previousSha: undefined, ciState: 'unknown' as const, failingChecks: [],
        }),
      ) as any,
      dispatch: okDispatch as any,
      attribute: attribute as any,
    });
    expect(attribute).not.toHaveBeenCalled();
  });
});
