import { describe, it, expect, mock } from 'bun:test';

let insertedTask: Record<string, unknown> | undefined;

// reviewer.ts imports @buildd/core/db at the top level — stub the whole thing
// so these pure-function tests don't need a database connection.
mock.module('@buildd/core/db', () => ({
  db: {
    insert: mock(() => ({
      values: mock((values: Record<string, unknown>) => {
        insertedTask = values;
        return { returning: mock(() => Promise.resolve([{ id: 'task-1' }])) };
      }),
    })),
    query: {
      artifacts: { findMany: mock(() => Promise.resolve([])) },
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
}));

import { createReviewerTask, preflightEscalationCheck, isSchemaTouchingFile } from './reviewer';
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
// These four cases are the canonical unit test table from docs/design/merge-policy.md §10.

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
