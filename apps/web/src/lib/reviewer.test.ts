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

import {
  createReviewerTask,
  preflightEscalationCheck,
  isSchemaTouchingFile,
  renderManifestGuidance,
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
