import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isMissionIntegrationBranch,
  protectedBaseBranches,
  hasBuildProof,
  evaluateModelApproveBound,
  BUILD_PROOF_CHECK_TOKENS,
} from './auto-merge-bound';

// ── isMissionIntegrationBranch ────────────────────────────────────────────────

describe('isMissionIntegrationBranch', () => {
  it('accepts a mission integration branch', () => {
    expect(isMissionIntegrationBranch('mission/checkout-rewrite')).toBe(true);
    expect(isMissionIntegrationBranch('mission/team/nested-slug')).toBe(true);
  });

  it('rejects trunk branches', () => {
    expect(isMissionIntegrationBranch('dev')).toBe(false);
    expect(isMissionIntegrationBranch('main')).toBe(false);
    expect(isMissionIntegrationBranch('master')).toBe(false);
  });

  it('rejects a bare prefix and near-miss names', () => {
    // 'mission/' with nothing after it is not a branch; 'missionary' and
    // 'x/mission/y' must not pass a prefix test by accident.
    expect(isMissionIntegrationBranch('mission/')).toBe(false);
    expect(isMissionIntegrationBranch('mission')).toBe(false);
    expect(isMissionIntegrationBranch('missionary/foo')).toBe(false);
    expect(isMissionIntegrationBranch('feat/mission/foo')).toBe(false);
  });

  it('rejects an absent base ref', () => {
    expect(isMissionIntegrationBranch(null)).toBe(false);
    expect(isMissionIntegrationBranch(undefined)).toBe(false);
    expect(isMissionIntegrationBranch('')).toBe(false);
  });
});

// ── protectedBaseBranches ─────────────────────────────────────────────────────

describe('protectedBaseBranches', () => {
  it('includes main even when nothing is configured', () => {
    expect(protectedBaseBranches({})).toEqual(['main']);
  });

  it('includes the workspace target/default branch and the prod branch', () => {
    const branches = protectedBaseBranches({
      gitConfig: { targetBranch: 'dev', defaultBranch: 'dev' },
      releaseConfig: { prodBranch: 'production' },
    });
    expect(branches).toContain('main');
    expect(branches).toContain('dev');
    expect(branches).toContain('production');
    // de-duplicated: targetBranch and defaultBranch are both 'dev'
    expect(branches.filter((b) => b === 'dev')).toHaveLength(1);
  });
});

// ── hasBuildProof ─────────────────────────────────────────────────────────────

describe('hasBuildProof', () => {
  it('accepts a completed successful build check', () => {
    expect(
      hasBuildProof([{ name: 'build', status: 'completed', conclusion: 'success' }]),
    ).toEqual({ permitted: true });
  });

  it('rejects zero check runs — no runs is not the same as green', () => {
    const result = hasBuildProof([]);
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('no build/test check reported');
  });

  it('rejects a PR whose only build check was skipped', () => {
    const result = hasBuildProof([
      { name: 'build', status: 'completed', conclusion: 'skipped' },
      { name: 'integration tests', status: 'completed', conclusion: 'skipped' },
    ]);
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('successful conclusion');
  });

  it('rejects when unrelated checks succeeded but no build/test check ran', () => {
    const result = hasBuildProof([
      { name: 'Vercel Preview', status: 'completed', conclusion: 'success' },
      { name: 'no-prod-data', status: 'completed', conclusion: 'success' },
    ]);
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('no build/test check reported');
  });

  it('rejects a build check that is still running', () => {
    const result = hasBuildProof([{ name: 'build', status: 'in_progress', conclusion: null }]);
    expect(result.permitted).toBe(false);
  });

  it('exports the token list the CI-completeness warning also uses', () => {
    expect(BUILD_PROOF_CHECK_TOKENS).toContain('build');
    expect(BUILD_PROOF_CHECK_TOKENS).toContain('test');
  });
});

// ── evaluateModelApproveBound ─────────────────────────────────────────────────

const GREEN = [{ name: 'build', status: 'completed', conclusion: 'success' }];
const ORDINARY_FILES = [{ filename: 'apps/web/src/lib/foo.ts' }];
const TRUNK = ['main', 'dev', 'production'];

describe('evaluateModelApproveBound', () => {
  it('permits an unattended merge into a mission integration branch', () => {
    expect(
      evaluateModelApproveBound({
        baseRef: 'mission/checkout-rewrite',
        protectedBranches: TRUNK,
        checkRuns: GREEN,
        files: ORDINARY_FILES,
      }),
    ).toEqual({ permitted: true });
  });

  it('refuses the SAME approve when the base is dev', () => {
    const result = evaluateModelApproveBound({
      baseRef: 'dev',
      protectedBranches: TRUNK,
      checkRuns: GREEN,
      files: ORDINARY_FILES,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain("base 'dev'");
    // Refused BY THE TRUNK DENY LIST, not incidentally by the mission-name test.
    expect(result.permitted === false && result.reason).toContain('protected trunk branch');
  });

  it('refuses when the base is main', () => {
    const result = evaluateModelApproveBound({
      baseRef: 'main',
      protectedBranches: TRUNK,
      checkRuns: GREEN,
      files: ORDINARY_FILES,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain("base 'main'");
    // Refused BY THE TRUNK DENY LIST, not incidentally by the mission-name test.
    expect(result.permitted === false && result.reason).toContain('protected trunk branch');
  });

  it("refuses when the base is the workspace's prodBranch", () => {
    const result = evaluateModelApproveBound({
      baseRef: 'production',
      protectedBranches: TRUNK,
      checkRuns: GREEN,
      files: ORDINARY_FILES,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain("base 'production'");
    // Refused BY THE TRUNK DENY LIST, not incidentally by the mission-name test.
    expect(result.permitted === false && result.reason).toContain('protected trunk branch');
  });

  it('refuses a non-trunk, non-mission base (no CI, no quarantine)', () => {
    const result = evaluateModelApproveBound({
      baseRef: 'feat/foo',
      protectedBranches: TRUNK,
      checkRuns: GREEN,
      files: ORDINARY_FILES,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('mission integration branch');
  });

  it('refuses when the base ref is unknown — fail closed', () => {
    const result = evaluateModelApproveBound({
      baseRef: null,
      protectedBranches: TRUNK,
      checkRuns: GREEN,
      files: ORDINARY_FILES,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('base ref is unknown');
  });

  it('refuses a migration-touching PR on a mission base', () => {
    const result = evaluateModelApproveBound({
      baseRef: 'mission/checkout-rewrite',
      protectedBranches: TRUNK,
      checkRuns: GREEN,
      files: [
        { filename: 'apps/web/src/lib/foo.ts' },
        { filename: 'packages/core/drizzle/0094_add_column.sql' },
      ],
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('0094_add_column.sql');
  });

  it('refuses a schema.ts-touching PR on a mission base', () => {
    const result = evaluateModelApproveBound({
      baseRef: 'mission/checkout-rewrite',
      protectedBranches: TRUNK,
      checkRuns: GREEN,
      files: [{ filename: 'packages/core/db/schema.ts' }],
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('schema.ts');
  });

  it('refuses when the build workflow never ran on a mission base', () => {
    const result = evaluateModelApproveBound({
      baseRef: 'mission/checkout-rewrite',
      protectedBranches: TRUNK,
      checkRuns: [],
      files: ORDINARY_FILES,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('no build/test check reported');
  });

  it('treats a protected branch as protected even if it were named mission/*', () => {
    // Defence in depth: the deny list is consulted before the positive test, so
    // a workspace whose trunk is literally called `mission/trunk` cannot inherit
    // unattended merges from the naming convention.
    const result = evaluateModelApproveBound({
      baseRef: 'mission/trunk',
      protectedBranches: ['main', 'mission/trunk'],
      checkRuns: GREEN,
      files: ORDINARY_FILES,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('protected');
  });
});

// ── the CI signal the bound depends on ───────────────────────────────────────

describe('Build & Test pull_request trigger', () => {
  // hasBuildProof can only ever pass if the workflow actually runs on the PR.
  // A base-name allowlist makes that conditional on someone remembering to add
  // each new branch convention, and an unlisted base produces zero runs — which
  // is indistinguishable from green to any check that only looks for failures.
  const workflow = readFileSync(
    join(import.meta.dir, '../../../../.github/workflows/build.yml'),
    'utf8',
  );
  const pullRequestBranches = /\n  pull_request:[\s\S]*?\n    branches:\s*(.+)\n/.exec(workflow)?.[1];

  it('runs on every PR base ref via a catch-all', () => {
    expect(pullRequestBranches).toBeDefined();
    expect(pullRequestBranches).toContain("'**'");
  });

  it('still records mission/** as an intended base', () => {
    expect(pullRequestBranches).toContain('mission/**');
  });
});
