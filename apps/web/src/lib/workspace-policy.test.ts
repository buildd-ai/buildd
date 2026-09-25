import { describe, it, expect } from 'bun:test';
import {
  detectRiskClassPaths,
  effectivePathsForClass,
  detectAllRiskClasses,
  resolveEffectivePolicyForPR,
  buildPolicyIntentSentence,
  buildPolicyClassPaths,
  guessRiskClass,
  findUncoveredRiskPaths,
  applyPolicyConfigToMergePolicy,
  getClassAction,
  PRESET_ACTIONS,
} from './workspace-policy';
import type { WorkspacePolicyConfig, RiskClassEntry } from './workspace-policy';
import type { MergePolicy } from '@buildd/shared';

// ── Sample file listings ──────────────────────────────────────────────────────

const DRIZZLE_REPO_FILES = [
  'packages/core/db/schema.ts',
  'packages/core/drizzle/0001_initial.sql',
  'packages/core/drizzle/0002_add_users.sql',
  'packages/core/drizzle/meta/_journal.json',
  '.github/workflows/build.yml',
  '.github/workflows/deploy.yml',
  'bun.lockb',
  'package.json',
  'apps/web/src/lib/auth/session.ts',
  'apps/web/src/lib/auth/middleware.ts',
  'packages/shared/src/types.ts',
  'packages/shared/src/api.ts',
  'apps/web/src/lib/task.ts',
  'vercel.json',
];

const PRISMA_REPO_FILES = [
  'prisma/schema.prisma',
  'prisma/migrations/20240101_initial/migration.sql',
  'prisma/migrations/20240102_add_users/migration.sql',
  '.github/workflows/ci.yml',
  'bun.lockb',
  'package.json',
  'src/lib/auth/index.ts',
];

// ── detectRiskClassPaths ──────────────────────────────────────────────────────

describe('detectRiskClassPaths', () => {
  // AC-1: drizzle repo → detects migration dir
  it('AC-1: detects drizzle migration paths', () => {
    const paths = detectRiskClassPaths(DRIZZLE_REPO_FILES, 'destructive_schema_change');
    // Should find the drizzle/ directory (and/or the schema.ts)
    const coversSchema = paths.some((p) => 'packages/core/db/schema.ts'.startsWith(p) || p === 'packages/core/db/schema.ts');
    const coversMigrations = paths.some((p) => 'packages/core/drizzle/0001_initial.sql'.startsWith(p));
    expect(coversSchema || coversMigrations).toBe(true);
  });

  // AC-2: prisma repo → detects prisma migration paths
  it('AC-2: detects prisma migration paths', () => {
    const paths = detectRiskClassPaths(PRISMA_REPO_FILES, 'destructive_schema_change');
    const coversMigrations = paths.some((p) =>
      'prisma/migrations/20240101_initial/migration.sql'.startsWith(p) || p.includes('prisma'),
    );
    expect(coversMigrations).toBe(true);
  });

  it('detects CI/deploy config paths', () => {
    const paths = detectRiskClassPaths(DRIZZLE_REPO_FILES, 'ci_deploy_config');
    expect(paths.some((p) => '.github/workflows/build.yml'.startsWith(p) || p.includes('.github'))).toBe(true);
    expect(paths.some((p) => 'vercel.json'.startsWith(p) || p === 'vercel.json')).toBe(true);
  });

  it('detects auth paths', () => {
    const paths = detectRiskClassPaths(DRIZZLE_REPO_FILES, 'auth_and_secrets');
    expect(paths.some((p) => 'apps/web/src/lib/auth/session.ts'.startsWith(p))).toBe(true);
  });

  it('detects lockfiles as dependency_bump', () => {
    const paths = detectRiskClassPaths(DRIZZLE_REPO_FILES, 'dependency_bump');
    expect(paths.some((p) => 'bun.lockb'.startsWith(p) || p === 'bun.lockb')).toBe(true);
  });

  it('detects shared types as public_api_contract', () => {
    const paths = detectRiskClassPaths(DRIZZLE_REPO_FILES, 'public_api_contract');
    expect(paths.some((p) => 'packages/shared/src/types.ts'.startsWith(p))).toBe(true);
  });

  it('returns empty array when class has no matching files', () => {
    const simple = ['apps/web/src/lib/task.ts', 'apps/web/src/components/Button.tsx'];
    expect(detectRiskClassPaths(simple, 'destructive_schema_change')).toEqual([]);
  });
});

// ── detectAllRiskClasses ──────────────────────────────────────────────────────

describe('detectAllRiskClasses', () => {
  it('returns all 5 classes', () => {
    const classes = detectAllRiskClasses(DRIZZLE_REPO_FILES);
    expect(classes).toHaveLength(5);
    const names = classes.map((c) => c.name);
    expect(names).toContain('destructive_schema_change');
    expect(names).toContain('ci_deploy_config');
    expect(names).toContain('auth_and_secrets');
    expect(names).toContain('dependency_bump');
    expect(names).toContain('public_api_contract');
  });

  it('populates detectedPaths for matched classes', () => {
    const classes = detectAllRiskClasses(DRIZZLE_REPO_FILES);
    const schemaClass = classes.find((c) => c.name === 'destructive_schema_change')!;
    expect(schemaClass.detectedPaths.length).toBeGreaterThan(0);
  });

  it('returns empty detectedPaths for unmatched classes', () => {
    const simple = ['apps/web/src/lib/task.ts'];
    const classes = detectAllRiskClasses(simple);
    expect(classes.every((c) => c.detectedPaths.length === 0)).toBe(true);
  });
});

// ── PRESET_ACTIONS ────────────────────────────────────────────────────────────

describe('PRESET_ACTIONS', () => {
  it('cautious: schema → human', () => {
    expect(PRESET_ACTIONS.cautious.destructive_schema_change).toBe('human');
  });
  it('cautious: dependency_bump → agent-review', () => {
    expect(PRESET_ACTIONS.cautious.dependency_bump).toBe('agent-review');
  });
  it('balanced: schema → human', () => {
    expect(PRESET_ACTIONS.balanced.destructive_schema_change).toBe('human');
  });
  it('balanced: ci_deploy_config → agent-review', () => {
    expect(PRESET_ACTIONS.balanced.ci_deploy_config).toBe('agent-review');
  });
  it('balanced: dependency_bump → auto', () => {
    expect(PRESET_ACTIONS.balanced.dependency_bump).toBe('auto');
  });
  it('autonomous: schema → agent-review', () => {
    expect(PRESET_ACTIONS.autonomous.destructive_schema_change).toBe('agent-review');
  });
});

// ── resolveEffectivePolicyForPR ───────────────────────────────────────────────

const BALANCED_POLICY: WorkspacePolicyConfig = {
  preset: 'balanced',
  reviewerRole: 'reviewer',
  riskClasses: [
    { name: 'destructive_schema_change', detectedPaths: ['packages/core/drizzle/', 'packages/core/db/'] },
    { name: 'ci_deploy_config', detectedPaths: ['.github/workflows/'] },
    { name: 'auth_and_secrets', detectedPaths: ['apps/web/src/lib/auth/'] },
    { name: 'dependency_bump', detectedPaths: ['bun.lockb', 'package.json'] },
    { name: 'public_api_contract', detectedPaths: ['packages/shared/src/'] },
  ],
};

describe('resolveEffectivePolicyForPR', () => {
  // AC-3: tier selection alone produces working policy
  it('escalates schema change to human', () => {
    const match = resolveEffectivePolicyForPR(BALANCED_POLICY, [
      'packages/core/drizzle/0002_add_column.sql',
      'packages/core/db/schema.ts',
    ]);
    expect(match?.action).toBe('human');
    expect(match?.matchedClass).toBe('destructive_schema_change');
  });

  it('does not escalate the schema class when the migration classifier says EXPAND', () => {
    const match = resolveEffectivePolicyForPR(
      BALANCED_POLICY,
      ['packages/core/drizzle/0002_add_column.sql', 'packages/core/db/schema.ts'],
      { safe: true, operationClass: 'EXPAND' },
    );
    expect(match).toBeNull();
  });

  it('escalates the schema class when the migration classifier says CONTRACT', () => {
    const match = resolveEffectivePolicyForPR(
      BALANCED_POLICY,
      ['packages/core/drizzle/0002_drop.sql'],
      { safe: false, operationClass: 'CONTRACT', reason: 'drops column tasks.legacy' },
    );
    expect(match?.action).toBe('human');
    expect(match?.matchedClass).toBe('destructive_schema_change');
    expect(match?.reason).toContain('drops column tasks.legacy');
  });

  it('an EXPAND verdict does not suppress other risk classes', () => {
    const match = resolveEffectivePolicyForPR(
      BALANCED_POLICY,
      ['packages/core/drizzle/0002_add.sql', '.github/workflows/ci.yml'],
      { safe: true, operationClass: 'EXPAND' },
    );
    expect(match?.matchedClass).toBe('ci_deploy_config');
  });

  it('escalates CI config to agent-review', () => {
    const match = resolveEffectivePolicyForPR(BALANCED_POLICY, [
      '.github/workflows/deploy.yml',
    ]);
    expect(match?.action).toBe('agent-review');
    expect(match?.matchedClass).toBe('ci_deploy_config');
  });

  it('returns null for pure source code (no escalation)', () => {
    const match = resolveEffectivePolicyForPR(BALANCED_POLICY, [
      'apps/web/src/lib/task.ts',
      'apps/web/src/components/Button.tsx',
    ]);
    expect(match).toBeNull();
  });

  it('picks human over agent-review when both match', () => {
    const match = resolveEffectivePolicyForPR(BALANCED_POLICY, [
      'packages/core/drizzle/0002.sql', // human
      '.github/workflows/ci.yml',       // agent-review
    ]);
    expect(match?.action).toBe('human');
  });

  it('returns null when dependency_bump is auto in balanced', () => {
    const match = resolveEffectivePolicyForPR(BALANCED_POLICY, ['bun.lockb']);
    expect(match).toBeNull();
  });

  // Hand-written userPaths are no longer read: paths come from the repo scan.
  it('ignores a stored userPaths entry', () => {
    const policy: WorkspacePolicyConfig = {
      ...BALANCED_POLICY,
      riskClasses: [
        {
          name: 'ci_deploy_config',
          detectedPaths: [],
          userPaths: ['deploy/custom-script.sh'],
        },
      ],
    };
    const match = resolveEffectivePolicyForPR(policy, ['deploy/custom-script.sh']);
    expect(match).toBeNull();
  });
});

// ── buildPolicyIntentSentence ─────────────────────────────────────────────────

describe('buildPolicyIntentSentence', () => {
  // AC-5: reviewer prompt contains intent sentence, not glob list
  it('generates an intent sentence with no paths', () => {
    const sentence = buildPolicyIntentSentence(BALANCED_POLICY);
    expect(sentence).toContain('Balanced');
    expect(sentence).toContain('destructive schema changes');
    expect(sentence).toContain('human review required');
    expect(sentence).toContain('agent-review required');
    expect(sentence).toContain('auto-merge');
    // Must NOT contain raw path globs
    expect(sentence).not.toContain('packages/core/drizzle');
    expect(sentence).not.toContain('.github/workflows');
  });

  it('mentions all classes with their actions', () => {
    const sentence = buildPolicyIntentSentence(BALANCED_POLICY);
    expect(sentence).toContain('CI/deploy config changes');
    expect(sentence).toContain('auth/secrets changes');
    expect(sentence).toContain('dependency bumps');
    expect(sentence).toContain('public API contract changes');
  });
});

describe('buildPolicyClassPaths', () => {
  it('includes detected paths section', () => {
    const block = buildPolicyClassPaths(BALANCED_POLICY);
    expect(block).toContain('Workspace Policy');
    expect(block).toContain('packages/core/drizzle/');
    expect(block).toContain('.github/workflows/');
  });
});

// ── guessRiskClass ────────────────────────────────────────────────────────────

describe('guessRiskClass', () => {
  it('classifies drizzle paths', () => {
    expect(guessRiskClass('packages/core/drizzle/0001.sql')).toBe('destructive_schema_change');
  });
  it('classifies GitHub Actions', () => {
    expect(guessRiskClass('.github/workflows/build.yml')).toBe('ci_deploy_config');
  });
  it('classifies auth paths', () => {
    expect(guessRiskClass('apps/web/src/lib/auth/session.ts')).toBe('auth_and_secrets');
  });
  it('returns null for plain source files', () => {
    expect(guessRiskClass('apps/web/src/lib/task.ts')).toBeNull();
  });
});

// ── findUncoveredRiskPaths ────────────────────────────────────────────────────

describe('findUncoveredRiskPaths', () => {
  // AC-4: PR touching unclassified risk-adjacent path → reviewer proposes mapping
  it('finds risk-adjacent path not in policy', () => {
    const policy: WorkspacePolicyConfig = {
      preset: 'balanced',
      reviewerRole: 'reviewer',
      riskClasses: [
        { name: 'destructive_schema_change', detectedPaths: ['packages/core/drizzle/'] },
        // ci_deploy_config is NOT in the policy
      ],
    };
    const proposals = findUncoveredRiskPaths(policy, [
      '.github/workflows/custom-deploy.yml',
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].file).toBe('.github/workflows/custom-deploy.yml');
    expect(proposals[0].suggestedClass).toBe('ci_deploy_config');
  });

  it('ignores already-covered paths', () => {
    const proposals = findUncoveredRiskPaths(BALANCED_POLICY, [
      'packages/core/drizzle/0001.sql',
    ]);
    expect(proposals).toHaveLength(0);
  });

  it('ignores plain source files that are not risk-adjacent', () => {
    const proposals = findUncoveredRiskPaths(BALANCED_POLICY, [
      'apps/web/src/lib/task.ts',
    ]);
    expect(proposals).toHaveLength(0);
  });
});

// ── applyPolicyConfigToMergePolicy ───────────────────────────────────────────

describe('applyPolicyConfigToMergePolicy', () => {
  const basePolicyAutoThreshold: MergePolicy = { tier: 'auto-threshold', threshold: { maxLines: 800 } };
  const basePolicyAgentReview: MergePolicy = {
    tier: 'agent-review',
    agentReview: { reviewerRole: 'reviewer' },
  };

  it('upgrades auto-threshold → human when schema file matched', () => {
    const result = applyPolicyConfigToMergePolicy(
      basePolicyAutoThreshold,
      BALANCED_POLICY,
      ['packages/core/drizzle/0002.sql'],
    );
    expect(result.tier).toBe('human');
  });

  it('keeps base tier for an EXPAND-only schema PR', () => {
    const result = applyPolicyConfigToMergePolicy(
      basePolicyAutoThreshold,
      BALANCED_POLICY,
      ['packages/core/drizzle/0002.sql', 'packages/core/db/schema.ts'],
      { safe: true, operationClass: 'EXPAND' },
    );
    expect(result.tier).toBe('auto-threshold');
  });

  it('upgrades auto-threshold → agent-review for CI file', () => {
    const result = applyPolicyConfigToMergePolicy(
      basePolicyAutoThreshold,
      BALANCED_POLICY,
      ['.github/workflows/ci.yml'],
    );
    expect(result.tier).toBe('agent-review');
  });

  it('does not downgrade a more-restrictive base policy', () => {
    const result = applyPolicyConfigToMergePolicy(
      basePolicyAgentReview,
      { ...BALANCED_POLICY, preset: 'autonomous' }, // autonomous: schema → agent-review only
      ['packages/core/drizzle/0002.sql'],
    );
    // base is agent-review, match is agent-review (same level — no change)
    expect(result.tier).toBe('agent-review');
  });

  it('returns base unchanged when no risk class matches', () => {
    const result = applyPolicyConfigToMergePolicy(
      basePolicyAutoThreshold,
      BALANCED_POLICY,
      ['apps/web/src/lib/task.ts'],
    );
    expect(result.tier).toBe('auto-threshold');
  });

  it('returns base unchanged when policyConfig is null', () => {
    const result = applyPolicyConfigToMergePolicy(
      basePolicyAutoThreshold,
      null,
      ['packages/core/drizzle/0002.sql'],
    );
    expect(result.tier).toBe('auto-threshold');
  });
});

describe('effectivePathsForClass — malformed stored config', () => {
  it('does not throw when a stored risk class has no detectedPaths', () => {
    // `gitConfig.policyConfig` is jsonb and `PATCH /api/workspaces/[id]`
    // accepts a hand-authored one, so the required field can be absent at
    // runtime. The unguarded spread threw inside preflightEscalationCheck,
    // whose caller catches and reports "no reviewer dispatched" — which the
    // webhook follows into the auto-merge path. A crashing gate must not read
    // as an absent one.
    const entry = { name: 'auth_and_secrets', userPaths: ['lib/auth.ts'] } as never;

    expect(() => effectivePathsForClass(entry)).not.toThrow();
    // userPaths is no longer an effective path source.
    expect(effectivePathsForClass(entry)).toEqual([]);
  });

  it('does not throw when both path lists are absent', () => {
    const entry = { name: 'dependency_bump' } as never;
    expect(effectivePathsForClass(entry)).toEqual([]);
  });
});

// ── File-form vs directory-form detection ─────────────────────────────────────
//
// Single-file matchers used to collapse to their parent directory, so one
// `middleware.ts` put a whole app behind auth_and_secrets. File-form matches
// are stored verbatim; directory-form matches stop at the matched directory.

describe('detectRiskClassPaths — file-form matches are never collapsed', () => {
  const MONOREPO = [
    'apps/web/src/middleware.ts',
    'apps/web/src/app/page.tsx',
    'apps/web/src/components/Button.tsx',
    'apps/web/src/lib/task.ts',
  ];

  it('stores a nested middleware file as the exact file path', () => {
    expect(detectRiskClassPaths(MONOREPO, 'auth_and_secrets')).toEqual(['apps/web/src/middleware.ts']);
  });

  it('stores deploy config files exactly, not their parent directory', () => {
    const files = ['app/vercel.json', 'app/Dockerfile', 'app/src/index.ts'];
    expect(detectRiskClassPaths(files, 'ci_deploy_config')).toEqual(['app/Dockerfile', 'app/vercel.json']);
  });

  it('stores a schema source file exactly and a migrations dir as its directory', () => {
    const files = ['app/src/lib/db/schema.ts', 'app/src/lib/db/client.ts', 'packages/core/drizzle/0001_x.sql'];
    expect(detectRiskClassPaths(files, 'destructive_schema_change')).toEqual([
      'app/src/lib/db/schema.ts',
      'packages/core/drizzle/',
    ]);
  });

  it('a root-level drizzle dir is stored as drizzle/', () => {
    expect(detectRiskClassPaths(['drizzle/0001_x.sql'], 'destructive_schema_change')).toEqual(['drizzle/']);
  });

  it('workflows collapse to .github/workflows/', () => {
    expect(detectRiskClassPaths(['.github/workflows/a.yml', '.github/workflows/b.yml'], 'ci_deploy_config')).toEqual([
      '.github/workflows/',
    ]);
  });

  it('an auth directory collapses to the auth directory itself, not its parent', () => {
    const files = ['apps/web/src/lib/auth/session.ts', 'apps/web/src/lib/auth/providers/github.ts'];
    expect(detectRiskClassPaths(files, 'auth_and_secrets')).toEqual(['apps/web/src/lib/auth/']);
  });

  it('drops a file already covered by a kept directory prefix', () => {
    const files = ['apps/web/src/lib/auth/session.ts', 'apps/web/src/lib/auth/middleware.ts'];
    expect(detectRiskClassPaths(files, 'auth_and_secrets')).toEqual(['apps/web/src/lib/auth/']);
  });

  it('drops a directory prefix nested inside another kept prefix', () => {
    const files = ['db/migrations/0001.sql', 'db/migrations/migrations/0002.sql'];
    expect(detectRiskClassPaths(files, 'destructive_schema_change')).toEqual(['db/migrations/']);
  });

  it('stores env loaders and shared type roots in their own form', () => {
    expect(detectRiskClassPaths(['apps/web/src/env.ts', 'apps/api/src/env/server.ts'], 'auth_and_secrets')).toEqual([
      'apps/api/src/env/',
      'apps/web/src/env.ts',
    ]);
    expect(
      detectRiskClassPaths(['packages/shared/src/a.ts', 'packages/shared/src/deep/b.ts'], 'public_api_contract'),
    ).toEqual(['packages/shared/src/']);
  });

  it('matches package-lock.json and only the root package.json', () => {
    expect(
      detectRiskClassPaths(['package-lock.json', 'package.json', 'apps/web/package.json'], 'dependency_bump'),
    ).toEqual(['package-lock.json', 'package.json']);
  });
});

describe('resolveEffectivePolicyForPR — exact vs prefix entries', () => {
  const policyWith = (paths: string[], userPaths?: string[]): WorkspacePolicyConfig => ({
    preset: 'balanced',
    reviewerRole: 'reviewer',
    riskClasses: [{ name: 'auth_and_secrets', detectedPaths: paths, userPaths }],
  });

  it('a file entry does not cover its sibling files', () => {
    const policy = policyWith(['apps/web/src/middleware.ts']);
    expect(resolveEffectivePolicyForPR(policy, ['apps/web/src/app/page.tsx'])).toBeNull();
  });

  it('a file entry covers exactly that file', () => {
    const policy = policyWith(['apps/web/src/middleware.ts']);
    expect(resolveEffectivePolicyForPR(policy, ['apps/web/src/middleware.ts'])?.matchedClass).toBe('auth_and_secrets');
  });

  it('a legacy stored directory entry still matches as a prefix', () => {
    const policy = policyWith(['apps/web/src/']);
    expect(resolveEffectivePolicyForPR(policy, ['apps/web/src/app/page.tsx'])?.matchedClass).toBe('auth_and_secrets');
  });

  it('a file entry does not match a longer path sharing its prefix', () => {
    const policy = policyWith(['app/Dockerfile']);
    expect(resolveEffectivePolicyForPR(policy, ['app/Dockerfile.dev'])).toBeNull();
  });

  it('a detected entry without a trailing slash is exact, not a directory', () => {
    const policy = policyWith(['apps/web/src/env']);
    expect(resolveEffectivePolicyForPR(policy, ['apps/web/src/env/server.ts'])).toBeNull();
  });

  it('a stored hand-authored userPath no longer covers anything', () => {
    const policy = policyWith([], ['apps/web/src/lib/auth']);
    expect(resolveEffectivePolicyForPR(policy, ['apps/web/src/lib/auth/session.ts'])).toBeNull();
    expect(resolveEffectivePolicyForPR(policy, ['apps/web/src/lib/auth'])).toBeNull();
  });
});
