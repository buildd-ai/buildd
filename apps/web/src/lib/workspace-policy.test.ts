import { describe, it, expect } from 'bun:test';
import {
  detectRiskClassPaths,
  detectAllRiskClasses,
  resolveEffectivePolicyForPR,
  buildPolicyIntentSentence,
  buildPolicyClassPaths,
  guessRiskClass,
  findUncoveredRiskPaths,
  inferPolicyConfigFromLegacy,
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

  it('respects userPaths additions', () => {
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
    expect(match?.action).toBe('agent-review');
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

// ── inferPolicyConfigFromLegacy ───────────────────────────────────────────────

describe('inferPolicyConfigFromLegacy', () => {
  // AC-6: existing config migrates with no loss of coverage
  it('classifies legacy escalateToPaths into classes', () => {
    const legacy = ['.github/workflows/', 'packages/core/drizzle/', 'packages/core/db/schema.ts'];
    const config = inferPolicyConfigFromLegacy(legacy, 'reviewer');
    expect(config.preset).toBe('balanced');
    const classNames = config.riskClasses.map((c) => c.name);
    expect(classNames).toContain('destructive_schema_change');
    expect(classNames).toContain('ci_deploy_config');
  });

  it('preserves all paths in userPaths', () => {
    const legacy = ['.github/workflows/', 'packages/core/drizzle/'];
    const config = inferPolicyConfigFromLegacy(legacy, 'reviewer');
    const ci = config.riskClasses.find((c) => c.name === 'ci_deploy_config');
    expect(ci?.userPaths).toContain('.github/workflows/');
    const schema = config.riskClasses.find((c) => c.name === 'destructive_schema_change');
    expect(schema?.userPaths).toContain('packages/core/drizzle/');
  });

  it('accepts a custom preset', () => {
    const config = inferPolicyConfigFromLegacy(['.github/workflows/'], 'reviewer', 'cautious');
    expect(config.preset).toBe('cautious');
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
