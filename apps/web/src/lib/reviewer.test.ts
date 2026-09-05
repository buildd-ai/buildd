import { describe, it, expect, mock } from 'bun:test';

let insertedTask: Record<string, unknown> | undefined;
let insertedMissionNote: Record<string, unknown> | undefined;

// Configurable per-test fixtures for supersedeReviewerTaskOnMerge.
let reviewerTaskFindFirstResult: any = null;
let taskUpdateReturning: any[] = [];
let workerUpdateCalls: Array<{ set: any }> = [];

function whereResult(rows: any[]) {
  const p = Promise.resolve(rows) as Promise<any[]> & { returning: () => Promise<any[]> };
  p.returning = () => Promise.resolve(rows);
  return p;
}

const mockAppendPrActivity = mock(() => Promise.resolve({ action: 'created' } as any));

// reviewer.ts imports @buildd/core/db at the top level — stub the whole thing
// so these pure-function tests don't need a database connection.
mock.module('@buildd/core/db', () => ({
  db: {
    insert: mock((table: string) => ({
      values: mock((values: Record<string, unknown>) => {
        if (table === 'missionNotes') {
          insertedMissionNote = values;
        } else {
          insertedTask = values;
        }
        return { returning: mock(() => Promise.resolve([{ id: 'task-1' }])) };
      }),
    })),
    update: mock((table: string) => ({
      set: mock((values: Record<string, unknown>) => {
        if (table === 'workers') workerUpdateCalls.push({ set: values });
        return { where: mock(() => whereResult(taskUpdateReturning)) };
      }),
    })),
    query: {
      artifacts: { findMany: mock(() => Promise.resolve([])) },
      tasks: { findFirst: mock(() => Promise.resolve(reviewerTaskFindFirstResult)) },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: 'tasks',
  workers: 'workers',
  missionNotes: 'missionNotes',
  artifacts: 'artifacts',
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b }),
  and: (...args: any[]) => args,
  inArray: (a: any, b: any) => ({ a, b }),
  desc: (a: any) => ({ desc: a }),
}));

mock.module('@/lib/pr-activity-comment', () => ({
  appendPrActivity: mockAppendPrActivity,
}));

import {
  buildReviewerContext,
  createReviewerTask,
  preflightEscalationCheck,
  isSchemaTouchingFile,
  renderManifestGuidance,
  supersedeReviewerTaskOnMerge,
} from './reviewer';
import { resolvePolicy } from './merge-policy';
import type { MergePolicy } from '@buildd/shared';

describe('createReviewerTask', () => {
  it('inherits the original task backend', async () => {
    insertedTask = undefined;

    await createReviewerTask({
      workspaceId: 'ws-1',
      originalTaskId: 'original-1',
      originalTask: {
        title: 'Codex change',
        description: 'Change made with Codex',
        backend: 'codex',
        missionId: null,
      },
      worker: { branch: 'buildd/original' },
      prNumber: 42,
      prUrl: 'https://github.com/buildd-ai/buildd/pull/42',
      headSha: 'abc123',
      reviewerRole: 'reviewer',
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
    });

    expect(insertedTask?.backend).toBe('codex');
  });

  it('stores a review callback on the task so the verdict can be pushed back', async () => {
    insertedTask = undefined;

    await createReviewerTask({
      workspaceId: 'ws-1',
      originalTaskId: 'original-3',
      originalTask: { title: 'Adopted PR', description: null, backend: 'claude', missionId: null },
      worker: { branch: 'fix/spinner' },
      prNumber: 44,
      prUrl: 'https://github.com/buildd-ai/buildd/pull/44',
      headSha: 'ghi789',
      reviewerRole: 'reviewer',
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
      reviewCallback: { url: 'https://example.test/hook', on: 'merge' },
    });

    expect((insertedTask?.context as any).reviewCallback).toEqual({
      url: 'https://example.test/hook',
      on: 'merge',
    });
  });

  it('leaves no callback key on the context when none was requested', async () => {
    insertedTask = undefined;

    await createReviewerTask({
      workspaceId: 'ws-1',
      originalTaskId: 'original-4',
      originalTask: { title: 'Plain review', description: null, backend: 'claude', missionId: null },
      worker: { branch: 'buildd/plain' },
      prNumber: 45,
      prUrl: 'https://github.com/buildd-ai/buildd/pull/45',
      headSha: 'jkl012',
      reviewerRole: 'reviewer',
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
    });

    expect((insertedTask?.context as any).reviewCallback).toBeUndefined();
  });

  it('never asks the reviewer to find a file named "**" in the diff', async () => {
    insertedTask = undefined;

    await createReviewerTask({
      workspaceId: 'ws-1',
      originalTaskId: 'original-2',
      originalTask: {
        title: 'Mission task with no declared scope',
        description: 'Filed by the organizer without a pathManifest',
        backend: 'claude',
        missionId: 'mission-1',
        // The mission-task default in POST /api/tasks — "scope not declared".
        pathManifest: ['**'],
      },
      worker: { branch: 'buildd/original-2' },
      prNumber: 43,
      prUrl: 'https://github.com/buildd-ai/buildd/pull/43',
      headSha: 'def456',
      reviewerRole: 'reviewer',
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
    });

    const description = insertedTask?.description as string;
    expect(description).not.toContain('- **');
    expect(description).toContain('declared no file scope');
  });
});

// ── renderManifestGuidance ───────────────────────────────────────────────────

describe('renderManifestGuidance', () => {
  it('lists concrete manifest entries and keeps the completeness doctrine', () => {
    const { doctrine, section } = renderManifestGuidance([
      'apps/web/src/lib/reviewer.ts',
      'packages/core/path-overlap.ts',
    ]);
    expect(section).toContain('## Expected Path Manifest (files this PR should touch)');
    expect(section).toContain('- apps/web/src/lib/reviewer.ts');
    expect(section).toContain('- packages/core/path-overlap.ts');
    expect(doctrine).toContain('Every file in pathManifest must be present in the diff');
  });

  it('renders the advisory form for the repo-wide sentinel', () => {
    const { doctrine, section } = renderManifestGuidance(['**']);
    // Must not render the sentinel as if it were a file to look for.
    expect(section).not.toContain('- **');
    expect(section).toContain('declared no file scope');
    expect(section).toContain('cannot be used as a completeness check');
    // The completeness doctrine is vacuous here and must be withdrawn.
    expect(doctrine).not.toContain('Every file in pathManifest must be present in the diff');
    expect(doctrine).toContain('no declared manifest');
  });

  it('treats a manifest that merely contains the sentinel as undeclared', () => {
    // check_path_claim extends a manifest in place, so '**' can ride along with
    // concrete paths. The manifest is still not a completeness contract.
    const { doctrine, section } = renderManifestGuidance(['**', 'apps/web/src/lib/foo.ts']);
    expect(section).not.toContain('- **');
    expect(section).toContain('declared no file scope');
    expect(doctrine).not.toContain('Every file in pathManifest must be present in the diff');
  });

  it('renders the undeclared form for a missing or empty manifest', () => {
    for (const manifest of [null, undefined, []] as Array<string[] | null | undefined>) {
      const { doctrine, section } = renderManifestGuidance(manifest);
      expect(section).toContain('## Expected Path Manifest');
      expect(section).toContain('No pathManifest declared for this task');
      expect(doctrine).not.toContain('Every file in pathManifest must be present in the diff');
    }
  });
});

// ── isSchemaTouchingFile ─────────────────────────────────────────────────────

describe('isSchemaTouchingFile', () => {
  it('detects drizzle SQL migration files', () => {
    expect(isSchemaTouchingFile('drizzle/0001_initial.sql')).toBe(true);
    expect(isSchemaTouchingFile('packages/core/drizzle/0042_add_merge_policy.sql')).toBe(true);
  });

  it('detects schema.ts', () => {
    expect(isSchemaTouchingFile('packages/core/db/schema.ts')).toBe(true);
  });

  it('does not flag unrelated files', () => {
    expect(isSchemaTouchingFile('apps/web/src/lib/merge-policy.ts')).toBe(false);
    expect(isSchemaTouchingFile('packages/core/db/seed.ts')).toBe(false);
    expect(isSchemaTouchingFile('drizzle/meta/0001_snapshot.json')).toBe(false);
    expect(isSchemaTouchingFile('apps/web/src/app/api/github/webhook/route.ts')).toBe(false);
  });
});

// ── preflightEscalationCheck ─────────────────────────────────────────────────

const agentReviewPolicy: MergePolicy = {
  tier: 'agent-review',
  agentReview: {
    reviewerRole: 'reviewer',
    escalateToPaths: ['apps/web/src/lib/auth/', 'packages/core/db/'],
    maxConfidenceThreshold: 0.6,
  },
};

const agentReviewNoEscalatePaths: MergePolicy = {
  tier: 'agent-review',
  agentReview: {
    reviewerRole: 'reviewer',
  },
};

describe('preflightEscalationCheck', () => {
  it('escalates for a PR touching drizzle SQL migration', () => {
    const files = [
      { filename: 'apps/web/src/lib/reviewer.ts' },
      { filename: 'drizzle/0042_add_column.sql' },
    ];
    const result = preflightEscalationCheck(files, agentReviewPolicy);
    expect(result.shouldEscalate).toBe(true);
    expect((result as any).reason).toBe('could not inspect generated SQL migration');
  });

  it('escalates for a PR touching packages/core/db/schema.ts', () => {
    const files = [
      { filename: 'packages/core/db/schema.ts' },
    ];
    const result = preflightEscalationCheck(files, agentReviewPolicy);
    expect(result.shouldEscalate).toBe(true);
  });

  it('escalates when a file matches escalateToPaths', () => {
    const files = [
      { filename: 'apps/web/src/lib/auth/session.ts' },
      { filename: 'apps/web/src/components/Button.tsx' },
    ];
    const result = preflightEscalationCheck(files, agentReviewPolicy);
    expect(result.shouldEscalate).toBe(true);
    expect((result as any).reason).toMatch(/apps\/web\/src\/lib\/auth\/session\.ts/);
  });

  it('does not escalate for a normal PR with no schema or deny paths', () => {
    const files = [
      { filename: 'apps/web/src/lib/reviewer.ts' },
      { filename: 'apps/web/src/lib/merge-policy.ts' },
    ];
    const result = preflightEscalationCheck(files, agentReviewPolicy);
    expect(result.shouldEscalate).toBe(false);
  });

  it('does not escalate when escalateToPaths is absent', () => {
    const files = [
      { filename: 'apps/web/src/lib/reviewer.ts' },
    ];
    const result = preflightEscalationCheck(files, agentReviewNoEscalatePaths);
    expect(result.shouldEscalate).toBe(false);
  });

  it('does not escalate for drizzle meta/snapshot files (noise)', () => {
    // meta files are not SQL — isSchemaTouchingFile correctly excludes them
    const files = [
      { filename: 'packages/core/drizzle/meta/0001_snapshot.json' },
    ];
    const result = preflightEscalationCheck(files, agentReviewPolicy);
    expect(result.shouldEscalate).toBe(false);
  });

  it('does not escalate additive generated SQL when no other deny path matches', () => {
    const files = [
      { filename: 'packages/core/db/schema.ts' },
      { filename: 'packages/core/drizzle/0094_add_summary.sql' },
    ];
    const result = preflightEscalationCheck(
      files,
      agentReviewNoEscalatePaths,
      { safe: true },
    );
    expect(result.shouldEscalate).toBe(false);
  });

  it('surfaces the destructive classifier reason', () => {
    const files = [{ filename: 'packages/core/drizzle/0094_drop_legacy.sql' }];
    const result = preflightEscalationCheck(
      files,
      agentReviewNoEscalatePaths,
      { safe: false, reason: 'drops column missions.legacy_mode' },
    );
    expect(result).toEqual({
      shouldEscalate: true,
      reason: 'drops column missions.legacy_mode',
    });
  });
});

// ── resolvePolicy — spec §10 named cases ────────────────────────────────────
// These cases cover the canonical resolution chain from docs/design/merge-policy.md §10.

describe('resolvePolicy', () => {
  it('returns auto-threshold when workspace has auto-threshold mergePolicy', () => {
    const policy = resolvePolicy({ gitConfig: { mergePolicy: { tier: 'auto-threshold' } } as any });
    expect(policy.tier).toBe('auto-threshold');
  });

  it('returns human when workspace has human mergePolicy', () => {
    const policy = resolvePolicy({ gitConfig: { mergePolicy: { tier: 'human' } } as any });
    expect(policy.tier).toBe('human');
  });

  it('mission mergePolicy overrides workspace policy', () => {
    const policy = resolvePolicy(
      { gitConfig: { mergePolicy: { tier: 'auto-threshold' } } as any },
      { mergePolicy: { tier: 'human' } },
    );
    expect(policy.tier).toBe('human');
  });

  it('pre-flight escalation guard returns escalate for schema-touching PRs', () => {
    const schemaPolicy: MergePolicy = {
      tier: 'agent-review',
      agentReview: { reviewerRole: 'reviewer' },
    };
    const files = [{ filename: 'packages/core/db/schema.ts' }];
    const result = preflightEscalationCheck(files, schemaPolicy);
    expect(result.shouldEscalate).toBe(true);
  });
});

// ── supersedeReviewerTaskOnMerge (AC-4) ─────────────────────────────────────
// A human merging a PR directly must cancel any still-pending or still-running
// reviewer task for it, rather than letting the reviewer run against an
// already-merged PR.

function resetSupersedeFixtures() {
  insertedMissionNote = undefined;
  reviewerTaskFindFirstResult = null;
  taskUpdateReturning = [];
  workerUpdateCalls = [];
  mockAppendPrActivity.mockClear();
}

describe('supersedeReviewerTaskOnMerge', () => {
  it('cancels a PENDING reviewer task with no live worker', async () => {
    resetSupersedeFixtures();
    reviewerTaskFindFirstResult = { id: 'reviewer-task-1', missionId: 'mission-1', workers: [] };
    taskUpdateReturning = [{ id: 'reviewer-task-1' }];

    const result = await supersedeReviewerTaskOnMerge({
      originalTaskId: 'task-1',
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 2029,
    });

    expect(result).toEqual({ superseded: true, reviewerTaskId: 'reviewer-task-1' });
    expect(workerUpdateCalls).toHaveLength(0); // no live worker → nothing to interrupt
    expect(insertedMissionNote?.type).toBe('reviewer_superseded');
    expect(mockAppendPrActivity).toHaveBeenCalledTimes(1);
  });

  it('interrupts the live worker when the reviewer task is RUNNING', async () => {
    resetSupersedeFixtures();
    reviewerTaskFindFirstResult = {
      id: 'reviewer-task-2',
      missionId: 'mission-1',
      workers: [{ id: 'worker-9', status: 'running' }],
    };
    taskUpdateReturning = [{ id: 'reviewer-task-2' }];

    const result = await supersedeReviewerTaskOnMerge({
      originalTaskId: 'task-2',
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 3001,
    });

    expect(result.superseded).toBe(true);
    expect(workerUpdateCalls).toHaveLength(1);
    expect(workerUpdateCalls[0].set.status).toBe('failed');
    expect(workerUpdateCalls[0].set.exitCause).toBe('condition_unmet');
  });

  it('is a no-op when no reviewer task exists for the merged PR', async () => {
    resetSupersedeFixtures();
    reviewerTaskFindFirstResult = null;

    const result = await supersedeReviewerTaskOnMerge({
      originalTaskId: 'task-3',
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 4002,
    });

    expect(result).toEqual({ superseded: false, reviewerTaskId: null });
    expect(insertedMissionNote).toBeUndefined();
    expect(mockAppendPrActivity).not.toHaveBeenCalled();
  });

  it('does not record a supersession when the cancel write loses its CAS race', async () => {
    resetSupersedeFixtures();
    reviewerTaskFindFirstResult = { id: 'reviewer-task-4', missionId: 'mission-1', workers: [] };
    // Simulates another writer (e.g. the reviewer completing concurrently)
    // already moved the task out of a cancellable status.
    taskUpdateReturning = [];

    const result = await supersedeReviewerTaskOnMerge({
      originalTaskId: 'task-4',
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 5003,
    });

    expect(result).toEqual({ superseded: false, reviewerTaskId: null });
    expect(insertedMissionNote).toBeUndefined();
    expect(mockAppendPrActivity).not.toHaveBeenCalled();
  });

  it('skips the mission note when the reviewer task has no mission', async () => {
    resetSupersedeFixtures();
    reviewerTaskFindFirstResult = { id: 'reviewer-task-5', missionId: null, workers: [] };
    taskUpdateReturning = [{ id: 'reviewer-task-5' }];

    const result = await supersedeReviewerTaskOnMerge({
      originalTaskId: 'task-5',
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 6004,
    });

    expect(result.superseded).toBe(true);
    expect(insertedMissionNote).toBeUndefined();
    expect(mockAppendPrActivity).toHaveBeenCalledTimes(1);
  });
});

// ── Patch evidence (T2) ──────────────────────────────────────────────────────

describe('buildReviewerContext — patch evidence flag', () => {
  const PR_FILES = [
    {
      filename: 'apps/web/src/lib/foo.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch: [
        '@@ -1,4 +1,5 @@ export function foo() {',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        '+const c = 4;',
        ' return a;',
      ].join('\n'),
    },
  ];

  const BASE = {
    originalTaskId: 'original-t2',
    originalTask: {
      title: 'Patch evidence',
      description: 'A task whose PR the reviewer should be able to read',
      pathManifest: ['apps/web/src/lib/foo.ts'],
    },
    prNumber: 90,
    prUrl: 'https://github.com/buildd-ai/buildd/pull/90',
    headSha: 'sha90',
    installationId: 1,
    repoFullName: 'buildd-ai/buildd',
    prFiles: PR_FILES,
  };

  const POLICY = { preset: 'balanced' as const, riskClasses: [] };

  it('changes nothing about the prompt when the flag is off', async () => {
    const off = await buildReviewerContext({
      ...BASE,
      policyConfig: { ...POLICY, reviewerPatchEvidence: false },
    });
    const absent = await buildReviewerContext({ ...BASE, policyConfig: POLICY });

    // Absent and explicitly-false must be the same prompt: a workspace that
    // never heard of this feature gets the pre-patch reviewer verbatim.
    expect(off).toBe(absent);

    expect(off).not.toContain('__new hunk__');
    expect(off).not.toContain('## PR Diff');
    // The filename list is still exactly what it was.
    expect(off).toContain('## PR Files Changed (+2/-1)');
    expect(off).toContain('  - apps/web/src/lib/foo.ts (+2/-1) [modified]');

    // And the seam the patch splices into is byte-identical to the pre-feature
    // prompt — not merely free of patch text. An opt-in that reflows every
    // workspace's reviewer prompt by one blank line is not an opt-in, and
    // "contains no hunks" would not have caught it.
    expect(off).toContain('[modified]\n\n\n\n## Your Output');
  });

  it('injects the patch, with citation rules, when the flag is on', async () => {
    const on = await buildReviewerContext({
      ...BASE,
      policyConfig: { ...POLICY, reviewerPatchEvidence: true },
    });

    expect(on).toContain('__new hunk__');
    expect(on).toContain('2 +const b = 3;');
    expect(on).toContain('@@ ... @@ export function foo() {');
    expect(on).toContain('`path:line`');

    // Additive, not a replacement: scope and completeness are judged against
    // the filename list, and the patch may be short a file the budget dropped.
    expect(on).toContain('## PR Files Changed (+2/-1)');
  });

  it('honours a per-workspace token budget', async () => {
    const on = await buildReviewerContext({
      ...BASE,
      prFiles: [
        {
          filename: 'big.ts',
          status: 'modified',
          additions: 200,
          deletions: 0,
          patch: [
            '@@ -1,200 +1,200 @@ fn',
            ...Array.from({ length: 200 }, (_, i) => `+// line ${i} ${'x'.repeat(80)}`),
          ].join('\n'),
        },
      ],
      policyConfig: { ...POLICY, reviewerPatchEvidence: true, reviewerPatchTokenBudget: 200 },
    });

    expect(on).toContain('## Not Reviewed — Token Budget');
    expect(on).not.toContain('__new hunk__');
  });

  it('does not mistake a path inside the patch text for a changed file', async () => {
    // The self-healing policy check used to recover filenames by re-parsing the
    // rendered prompt for `- ` lines. With patch text in that prompt, any diff
    // that mentions a path would enter the changed-file list — and a PR could
    // then be made to look as if it touched the schema by *writing about* it.
    const on = await buildReviewerContext({
      ...BASE,
      prFiles: [
        {
          filename: 'docs/notes.md',
          status: 'modified',
          additions: 1,
          deletions: 0,
          // A CONTEXT line: it renders unnumbered, so it trims to `- <path>`
          // and the old re-parse would have read it as a changed file. An
          // added line renders as `2 +- <path>` and never matched.
          patch: ['@@ -1,2 +1,3 @@ notes', ' - packages/core/db/schema.ts', '+new line'].join('\n'),
        },
      ],
      policyConfig: {
        preset: 'balanced' as const,
        riskClasses: [],
        reviewerPatchEvidence: true,
      },
    });

    expect(on).toContain('   - packages/core/db/schema.ts');
    expect(on).not.toContain('Proposed Policy Additions');
  });

  it('does not re-fetch the file list the caller already supplied', async () => {
    // @/lib/github is unmocked here, so a fetch attempt fails and the context
    // falls back to the "could not fetch" text. Its absence is the assertion.
    const on = await buildReviewerContext({
      ...BASE,
      policyConfig: { ...POLICY, reviewerPatchEvidence: true },
    });
    expect(on).not.toContain('Could not fetch file list');
  });
});
