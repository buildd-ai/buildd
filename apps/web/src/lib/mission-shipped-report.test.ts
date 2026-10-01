import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Mock state ──
let mission: any;
let workspace: any;
let taskRows: any[];
let authorTask: any;
let workerRows: any[];
let repoRow: any;
let shotRows: any[];
let githubFiles: Record<number, any>;
let githubCalls: string[];
const upserts: any[] = [];

mock.module('@buildd/core/db/schema', () => ({
  artifacts: { workspaceId: 'artifacts.workspace_id', key: 'artifacts.key' },
  githubRepos: { id: 'github_repos.id' },
  missions: { id: 'missions.id' },
  tasks: { id: 'tasks.id', missionId: 'tasks.mission_id' },
  workers: { taskId: 'workers.task_id' },
  workspaces: { id: 'workspaces.id' },
}));

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ op: 'eq', args }),
  inArray: (...args: any[]) => ({ op: 'inArray', args }),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: () => Promise.resolve(mission) },
      workspaces: { findFirst: () => Promise.resolve(workspace) },
      tasks: {
        findMany: () => Promise.resolve(taskRows),
        findFirst: () => Promise.resolve(authorTask),
      },
      workers: { findMany: () => Promise.resolve(workerRows) },
      githubRepos: { findFirst: () => Promise.resolve(repoRow) },
    },
    insert: () => ({
      values: (v: any) => ({
        onConflictDoUpdate: (conflict: any) => {
          upserts.push({ values: v, conflict });
          return Promise.resolve();
        },
      }),
    }),
  },
}));

mock.module('@/lib/github', () => ({
  githubApi: (_installationId: number, path: string) => {
    githubCalls.push(path);
    const n = Number(/pulls\/(\d+)\/files/.exec(path)?.[1]);
    const res = githubFiles[n];
    return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
  },
}));

mock.module('@/lib/visual-review-query', () => ({
  visualShotsQuery: () => Promise.resolve(shotRows),
}));

mock.module('@/lib/mission-repo-workspace', () => ({
  resolveMissionRepoWorkspaceId: () => Promise.resolve({ workspaceId: null }),
}));

import {
  SHIPPED_MAX_PRS,
  SHIPPED_PR_FILES_PER_PAGE,
  loadShippedHeroPool,
  shippedArtifactKey,
  storeMissionShippedReport,
  storeMissionShippedReportSafely,
} from './mission-shipped-report';

const GOOD_LEDE = 'On a phone, the home screen now opens on what needs you. Checked at phone and desktop width.';
const completedAt = new Date('2026-01-02T00:00:00.000Z');

function work(id: string, pathManifest: string[] | null = null, status = 'completed') {
  return { id, title: `Work ${id}`, status, mode: 'execution', taskClass: 'work', kind: 'engineering', category: null, creationSource: 'orchestrator', pathManifest };
}

function screenshot(id: string, route: string, viewport: 'mobile' | 'desktop', verdict = 'ok') {
  return {
    id, type: 'screenshot', workerId: 'w1', title: `${id}.png`, createdAt: new Date('2026-01-01T00:00:00Z'),
    metadata: { qa: { runKey: 'run-1', route, viewport, finding: 'fine', verdict } },
  };
}

function authored(shipped: unknown, extra: Record<string, unknown> = {}) {
  authorTask = { missionId: 'm1', result: { summary: 'done', structuredOutput: { shipped }, ...extra } };
}

function stored() {
  expect(upserts).toHaveLength(1);
  return upserts[0].values.metadata.shipped;
}

beforeEach(() => {
  mission = { id: 'm1', title: 'Make home calmer', workspaceId: 'ws1' };
  workspace = { dataClass: 'standard', githubRepoId: 'repo1' };
  taskRows = [work('t1', ['apps/web/src/components/Card.tsx'])];
  authorTask = null;
  workerRows = [{ prNumber: 11, mergedAt: new Date() }];
  repoRow = { fullName: 'org/repo', installation: { installationId: 7 } };
  shotRows = [];
  githubFiles = { 11: [{ filename: 'apps/web/src/components/Card.tsx' }] };
  githubCalls = [];
  upserts.length = 0;
});

describe('storeMissionShippedReport', () => {
  it('upserts one artifact keyed by mission, carrying the record as metadata', async () => {
    shotRows = [screenshot('s-m', '/app/home', 'mobile'), screenshot('s-d', '/app/home', 'desktop')];
    authored({ lede: GOOD_LEDE, heroShots: ['s-d'] });

    const record = await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });

    expect(upserts).toHaveLength(1);
    const { values, conflict } = upserts[0];
    expect(values).toMatchObject({
      workspaceId: 'ws1',
      key: shippedArtifactKey('m1'),
      type: 'report',
      missionId: 'm1',
      metadata: { kind: 'mission_shipped_report' },
    });
    expect(shippedArtifactKey('m1')).toBe('mission-shipped-m1');
    expect(conflict.target).toHaveLength(2);
    expect(conflict.set.metadata.shipped).toEqual(record);
    expect(record).toMatchObject({
      version: 1,
      lede: GOOD_LEDE,
      origin: 'author',
      authorTaskId: 'a1',
      changeType: 'frontend',
      completedAt: completedAt.toISOString(),
    });
    expect(record!.heroShots.map(s => s.artifactId)).toEqual(['s-d']);
  });

  it('computes changeType from the merged PRs files, not the manifests', async () => {
    taskRows = [work('t1', ['apps/web/src/components/Card.tsx'])];
    githubFiles = { 11: [{ filename: 'packages/core/db/schema.ts' }] };
    authored({ lede: GOOD_LEDE });
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(stored().changeType).toBe('backend');
    expect(githubCalls[0]).toBe('/repos/org/repo/pulls/11/files?per_page=100');
  });

  it('PR files unavailable: falls back to declared manifests', async () => {
    githubFiles = { 11: new Error('boom') };
    taskRows = [work('t1', ['apps/web/src/components/Card.tsx', 'packages/core/db/schema.ts'])];
    authored({ lede: GOOD_LEDE });
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(stored().changeType).toBe('both');
  });

  it('PR files unavailable and only sentinel manifests: changeType is null', async () => {
    githubFiles = { 11: null };
    taskRows = [work('t1', ['**'])];
    authored({ lede: GOOD_LEDE });
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(stored().changeType).toBeNull();
  });

  it('no merged PR recorded: falls back to manifests, and makes no GitHub call', async () => {
    workerRows = [{ prNumber: 11, mergedAt: null }, { prNumber: null, mergedAt: new Date() }];
    authored({ lede: GOOD_LEDE });
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(githubCalls).toHaveLength(0);
    expect(stored().changeType).toBe('frontend');
  });

  it('asks GitHub for no more files per page than it will return (100)', () => {
    // GitHub caps pulls/{n}/files at 100 per page; asking for more silently gets 100.
    expect(SHIPPED_PR_FILES_PER_PAGE).toBe(100);
  });

  it('a PR with a full page of files may have more: not classified from the partial list', async () => {
    // First page all backend; a UI file could be on page two. The manifest says UI.
    githubFiles = {
      11: Array.from({ length: SHIPPED_PR_FILES_PER_PAGE }, (_, i) => ({ filename: `packages/core/f${i}.ts` })),
    };
    taskRows = [work('t1', ['apps/web/src/components/Card.tsx'])];
    authored({ lede: GOOD_LEDE });
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(stored().changeType).toBe('frontend');
  });

  it('a mission with no tasks still stores a record: no change type, no GitHub call', async () => {
    taskRows = [];
    workerRows = [];
    authored({ lede: GOOD_LEDE });
    const record = await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(githubCalls).toHaveLength(0);
    expect(record).toMatchObject({ changeType: null, lede: GOOD_LEDE, origin: 'author', heroShots: [] });
    expect(upserts).toHaveLength(1);
  });

  it('a failed deliverable with no merged PR adds nothing: its declared manifest is not counted', async () => {
    githubFiles = { 11: new Error('boom') };
    taskRows = [
      work('t1', ['packages/core/db/schema.ts']),
      work('t2', ['apps/web/src/components/Card.tsx'], 'failed'),
    ];
    authored({ lede: GOOD_LEDE });
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(stored().changeType).toBe('backend');
  });

  it('re-completion overwrites the one record rather than adding a second', async () => {
    authored({ lede: GOOD_LEDE });
    const later = new Date('2026-02-03T00:00:00.000Z');
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    await storeMissionShippedReport('m1', { authorTaskId: 'a2', origin: 'auto', completedAt: later });
    expect(upserts).toHaveLength(2);
    // Same (workspace, key) both times, so the unique index turns the second into an update.
    expect(upserts[0].values.key).toBe(upserts[1].values.key);
    expect(upserts[1].conflict.set.metadata.shipped).toMatchObject({ authorTaskId: 'a2', completedAt: later.toISOString() });
  });

  it('reads at most the capped number of PRs', async () => {
    workerRows = Array.from({ length: SHIPPED_MAX_PRS + 5 }, (_, i) => ({ prNumber: i + 1, mergedAt: new Date() }));
    githubFiles = Object.fromEntries(workerRows.map(r => [r.prNumber, [{ filename: 'packages/core/x.ts' }]]));
    await storeMissionShippedReport('m1', { authorTaskId: null, origin: 'auto', completedAt });
    expect(githubCalls).toHaveLength(SHIPPED_MAX_PRS);
  });

  it('no shots: stores the record with no hero shots', async () => {
    authored({ lede: GOOD_LEDE, heroShots: ['ghost'] });
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(stored().heroShots).toEqual([]);
    expect(stored().lede).toBe(GOOD_LEDE);
  });

  it('hero ids outside the pool (unknown, or flagged as an issue) are dropped', async () => {
    shotRows = [screenshot('s-ok', '/app/home', 'mobile'), screenshot('s-bad', '/app/tasks', 'mobile', 'issue')];
    authored({ lede: GOOD_LEDE, heroShots: ['s-bad', 'ghost', 's-ok'] });
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(stored().heroShots.map((s: any) => s.artifactId)).toEqual(['s-ok']);
  });

  it('author missing: no lede, origin no_author, server-picked shots', async () => {
    shotRows = [screenshot('s-d', '/app/home', 'desktop'), screenshot('s-m', '/app/home', 'mobile')];
    await storeMissionShippedReport('m1', { authorTaskId: null, origin: 'auto', completedAt });
    expect(stored()).toMatchObject({ lede: null, origin: 'no_author', authorTaskId: null });
    expect(stored().heroShots.map((s: any) => s.artifactId)).toEqual(['s-m', 's-d']);
  });

  it('fallback-only author: its output is not an outcome, so the record has no lede', async () => {
    authored({ lede: GOOD_LEDE }, { summarySource: 'fallback' });
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(stored()).toMatchObject({ lede: null, origin: 'no_author', authorTaskId: 'a1' });
  });

  it('an author task from another mission is not trusted', async () => {
    authorTask = { missionId: 'other', result: { structuredOutput: { shipped: { lede: GOOD_LEDE } } } };
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(stored().lede).toBeNull();
  });

  it('manual: no lede and no author task read, mechanical facts only', async () => {
    authored({ lede: GOOD_LEDE });
    await storeMissionShippedReport('m1', { authorTaskId: null, origin: 'manual', completedAt });
    expect(stored()).toMatchObject({ origin: 'manual', lede: null, authorTaskId: null, changeType: 'frontend' });
    expect(upserts[0].values.content).toContain('Completed by hand.');
  });

  it('lede fails the check: stored without it, and the completion is not affected', async () => {
    authored({ lede: 'Fixed ProviderOnboardingCard in apps/web/src/components.', offPlan: ['x'] });
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(stored()).toMatchObject({ lede: null, origin: 'no_author', offPlan: [] });
  });

  it('sensitive workspace: no lede and no off-plan, only change type and shot ids', async () => {
    workspace = { dataClass: 'sensitive', githubRepoId: 'repo1' };
    shotRows = [screenshot('s-m', '/app/home', 'mobile')];
    authored({ lede: GOOD_LEDE, offPlan: ['Something was cut.'] });
    await storeMissionShippedReport('m1', { authorTaskId: 'a1', origin: 'auto', completedAt });
    expect(stored()).toMatchObject({ lede: null, offPlan: [], changeType: 'frontend' });
    expect(stored().heroShots.map((s: any) => s.artifactId)).toEqual(['s-m']);
    expect(JSON.stringify(upserts[0].values)).not.toContain(GOOD_LEDE);
  });

  it('stores nothing when the mission or its workspace cannot be found', async () => {
    mission = null;
    expect(await storeMissionShippedReport('m1', { authorTaskId: null, origin: 'auto', completedAt })).toBeNull();
    mission = { id: 'm1', title: 'x', workspaceId: null };
    expect(await storeMissionShippedReport('m1', { authorTaskId: null, origin: 'auto', completedAt })).toBeNull();
    expect(upserts).toHaveLength(0);
  });
});

describe('storeMissionShippedReportSafely', () => {
  it('never throws into the caller', async () => {
    mission = undefined;
    workspace = undefined;
    const original = console.error;
    console.error = () => {};
    try {
      taskRows = undefined as any; // makes the store throw after the mission check
      mission = { id: 'm1', title: 'x', workspaceId: 'ws1' };
      workspace = { dataClass: 'standard', githubRepoId: null };
      await expect(storeMissionShippedReportSafely('m1', { authorTaskId: null, origin: 'auto', completedAt })).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }
  });
});

describe('loadShippedHeroPool', () => {
  it('returns the latest run without issue shots', async () => {
    shotRows = [screenshot('a', '/app/home', 'mobile'), screenshot('b', '/app/tasks', 'mobile', 'issue')];
    expect((await loadShippedHeroPool('m1')).map(s => s.artifactId)).toEqual(['a']);
  });
});
