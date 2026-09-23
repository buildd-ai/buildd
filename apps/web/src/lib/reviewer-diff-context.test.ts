/**
 * The full-review prompt must tell the reviewer (a) which branch the PR merges
 * into, with a diff recipe against THAT branch, and (b) the artifacts the
 * reviewed task's workers produced.
 *
 * (a) Without a base ref, reviewers rebuilt the diff themselves and routinely
 *     diffed against `main` on PRs that target `dev`, reviewing a diff the PR
 *     never had.
 * (b) The artifacts lookup compared `artifacts.workerId` to the TASK id. An
 *     artifact's `workerId` is a worker id, so the predicate could never match
 *     and the "Task Artifacts" section never rendered.
 *
 * Real schema + real drizzle, with the rendered SQL read back through
 * PgDialect: mocking the predicate builders would hide exactly the bug (b) was.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();
function render(where: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(where as SQL);
  return { sql: q.sql, params: q.params };
}

let workersFindManyArgs: any[] = [];
let artifactsFindManyArgs: any[] = [];
let workerRows: Array<{ id: string }> = [];
let artifactRows: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: {
        findMany: mock(async (args: any) => {
          workersFindManyArgs.push(args);
          return workerRows;
        }),
      },
      artifacts: {
        findMany: mock(async (args: any) => {
          artifactsFindManyArgs.push(args);
          return artifactRows;
        }),
      },
    },
  },
}));

let githubCalls: string[] = [];
let githubApiImpl: (path: string) => Promise<unknown> = () =>
  Promise.reject(new Error('unmocked githubApi call'));
mock.module('@/lib/github', () => ({
  githubApi: (_installationId: number, path: string) => {
    githubCalls.push(path);
    return githubApiImpl(path);
  },
}));

import { buildReviewerContext } from './reviewer';

const HEAD = 'a'.repeat(40);
const BASE = {
  originalTaskId: 'task-under-review',
  originalTask: { title: 'Add a thing', description: 'Do the thing.', pathManifest: null },
  prNumber: 42,
  prUrl: 'https://github.com/org/repo/pull/42',
  headSha: HEAD,
  installationId: 1,
  repoFullName: 'org/repo',
  prFiles: [
    { filename: 'src/a.ts', additions: 3, deletions: 1, status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' },
  ] as any,
  prBody: null,
};

beforeEach(() => {
  workersFindManyArgs = [];
  artifactsFindManyArgs = [];
  workerRows = [];
  artifactRows = [];
  githubCalls = [];
  githubApiImpl = () => Promise.reject(new Error('unmocked githubApi call'));
});

describe('buildReviewerContext — base ref and diff recipe (V5)', () => {
  it('names the base branch and diffs against it, not main', async () => {
    const out = await buildReviewerContext({ ...BASE, baseRef: 'dev' });

    expect(out).toContain('Base branch: `dev`');
    expect(out).toContain(`git diff origin/dev...${HEAD}`);
    expect(out).not.toMatch(/git diff origin\/main/);
    // Supplied by the caller, so no extra GitHub read.
    expect(githubCalls).toEqual([]);
  });

  it('reads the base ref from the PR when the caller did not supply one', async () => {
    githubApiImpl = async (path) => {
      if (path === '/repos/org/repo/pulls/42') return { body: null, base: { ref: 'release-x' } };
      throw new Error(`unexpected ${path}`);
    };
    const out = await buildReviewerContext({ ...BASE, prBody: undefined });

    expect(out).toContain('Base branch: `release-x`');
    expect(out).toContain(`git diff origin/release-x...${HEAD}`);
    // One PR read serves both the lede and the base ref.
    expect(githubCalls).toEqual(['/repos/org/repo/pulls/42']);
  });

  it('does not guess a base when it cannot be read', async () => {
    githubApiImpl = async () => {
      throw new Error('GitHub 502');
    };
    const out = await buildReviewerContext({ ...BASE });

    expect(out).toContain('Base branch: unknown');
    expect(out).toContain('gh pr view 42');
    expect(out).not.toMatch(/git diff origin\/main/);
  });

  it('treats a base ref with shell or markdown metacharacters as unknown', async () => {
    for (const bad of ['dev`; echo hi #', 'x$(id)', 'a;b', '-upload-pack=x', 'a..b']) {
      const out = await buildReviewerContext({ ...BASE, baseRef: bad });
      expect(out).toContain('Base branch: unknown');
      expect(out).not.toContain(bad);
    }
  });

  it('treats an unsafe base ref read from GitHub as unknown', async () => {
    githubApiImpl = async () => ({ body: null, base: { ref: 'dev`$(id)`' } });
    const out = await buildReviewerContext({ ...BASE, prBody: undefined });
    expect(out).toContain('Base branch: unknown');
    expect(out).not.toContain('$(id)');
  });

  it('still accepts ordinary slashed, dotted and dashed branch names', async () => {
    const out = await buildReviewerContext({ ...BASE, baseRef: 'release/v1.2-rc_1' });
    expect(out).toContain('Base branch: `release/v1.2-rc_1`');
  });

  it('only calls the file list a summary when a file list is rendered', async () => {
    const withFiles = await buildReviewerContext({ ...BASE, baseRef: 'dev' });
    expect(withFiles).toContain('The file list below is a summary');
    const noFiles = await buildReviewerContext({ ...BASE, baseRef: 'dev', prFiles: [] as any });
    expect(noFiles).not.toContain('The file list below is a summary');
    expect(noFiles).toContain(`git diff origin/dev...${HEAD}`);
  });
});

describe('buildReviewerContext — task artifacts (V6)', () => {
  it('looks artifacts up by the reviewed task\'s WORKER ids, not the task id', async () => {
    workerRows = [{ id: 'worker-1' }, { id: 'worker-2' }];
    artifactRows = [
      { id: 'art-1', title: 'Design note', type: 'content', content: 'Why we did it', storageKey: null },
    ];

    const out = await buildReviewerContext({ ...BASE, baseRef: 'dev' });

    // Workers are found by task id...
    expect(workersFindManyArgs).toHaveLength(1);
    const w = render(workersFindManyArgs[0].where);
    expect(w.sql).toContain('"workers"."task_id" = $1');
    expect(w.params).toEqual(['task-under-review']);

    // ...and artifacts by those workers' ids. The task id must never be
    // compared to artifacts.worker_id.
    expect(artifactsFindManyArgs).toHaveLength(1);
    const a = render(artifactsFindManyArgs[0].where);
    expect(a.sql).toContain('"artifacts"."worker_id" in');
    expect(a.params).toEqual(['worker-1', 'worker-2']);
    expect(a.params).not.toContain('task-under-review');

    expect(out).toContain('## Task Artifacts');
    expect(out).toContain('[content] Design note');
  });

  it('skips the artifacts read when the task has no workers', async () => {
    workerRows = [];
    const out = await buildReviewerContext({ ...BASE, baseRef: 'dev' });

    expect(artifactsFindManyArgs).toHaveLength(0);
    expect(out).not.toContain('## Task Artifacts');
  });
});
