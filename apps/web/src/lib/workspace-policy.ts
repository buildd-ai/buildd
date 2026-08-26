/**
 * Workspace policy — semantic risk class detection and resolution.
 *
 * Replaces hand-authored path globs (`escalateToPaths`) with:
 *   1. A preset tier (cautious / balanced / autonomous) chosen by the user.
 *   2. Auto-detected paths per semantic class (never user-typed).
 *   3. Intent-readable prompts for the reviewer agent.
 *
 * The `policyConfig` field in WorkspaceGitConfig is the entry point.
 */

import type { MergePolicy } from '@buildd/shared';
import type { WorkspacePolicyPreset, RiskClassName, RiskClassAction, RiskClassEntry, WorkspacePolicyConfig } from '@buildd/shared';

export type { WorkspacePolicyPreset, RiskClassName, RiskClassAction, RiskClassEntry, WorkspacePolicyConfig };

// ── Preset behavior table ────────────────────────────────────────────────────

/**
 * For each preset, the escalation action for each risk class.
 *
 * cautious:    schema → human, ci/auth → human, deps → agent-review, api → human
 * balanced:    schema → human, ci/auth → agent-review, deps → auto, api → agent-review
 * autonomous:  schema → agent-review, all others → auto (except auth → agent-review)
 */
export const PRESET_ACTIONS: Record<WorkspacePolicyPreset, Record<RiskClassName, RiskClassAction>> = {
  cautious: {
    destructive_schema_change: 'human',
    ci_deploy_config: 'human',
    auth_and_secrets: 'human',
    dependency_bump: 'agent-review',
    public_api_contract: 'human',
  },
  balanced: {
    destructive_schema_change: 'human',
    ci_deploy_config: 'agent-review',
    auth_and_secrets: 'agent-review',
    dependency_bump: 'auto',
    public_api_contract: 'agent-review',
  },
  autonomous: {
    destructive_schema_change: 'agent-review',
    ci_deploy_config: 'auto',
    auth_and_secrets: 'agent-review',
    dependency_bump: 'auto',
    public_api_contract: 'auto',
  },
};

/** Get the escalation action for a risk class in a given preset. */
export function getClassAction(preset: WorkspacePolicyPreset, className: RiskClassName): RiskClassAction {
  return PRESET_ACTIONS[preset][className];
}

// ── Path detection ────────────────────────────────────────────────────────────

/**
 * Regex tests that classify a file path into a risk class.
 *
 * Detection strategy: find the DIRECTORIES that satisfy each class, then
 * deduplicate to directory prefixes so the stored list stays compact.
 */
const CLASS_MATCHERS: Record<RiskClassName, RegExp[]> = {
  destructive_schema_change: [
    // Drizzle: any directory named "drizzle" that contains numbered SQL migrations
    /(?:^|\/)drizzle\/\d+_/,
    // Prisma: prisma/migrations
    /(?:^|\/)prisma\/migrations?\//,
    // Alembic
    /(?:^|\/)alembic\/versions?\//,
    // Generic: a "migrations" dir with SQL files
    /(?:^|\/)migrations?\/[^/]+\.sql$/,
    // Schema source files (ORM definitions)
    /(?:^|\/)(?:db\/schema|models\/schema|prisma\/schema)\.(?:ts|js|prisma)$/,
  ],
  ci_deploy_config: [
    /^\.github\/workflows\//,
    /^\.github\/actions\//,
    /^\.circleci\//,
    /^\.gitlab-ci\.ya?ml$/,
    /^Jenkinsfile/,
    /(?:^|\/)vercel\.json$/,
    /(?:^|\/)netlify\.toml$/,
    /(?:^|\/)Dockerfile(?:\.\w+)?$/,
    /(?:^|\/)docker-compose(?:\.override)?\.ya?ml$/,
    /(?:^|\/)railway\.toml$/,
    /(?:^|\/)fly\.toml$/,
    /(?:^|\/)render\.ya?ml$/,
  ],
  auth_and_secrets: [
    // Auth directories
    /(?:^|\/)(?:lib|src)\/auth(?:\/|$)/,
    /(?:^|\/)(?:lib|src)\/authentication(?:\/|$)/,
    /(?:^|\/)middleware\.(?:ts|js)$/,
    // Env schema files (typed env loaders)
    /(?:^|\/)(?:env|config)\.(?:schema|types?)\.(?:ts|js)$/,
    /(?:^|\/)(?:src|lib)\/env(?:\.ts|\.js|\/)/,
    // Secret loaders
    /(?:^|\/)(?:secrets?|credentials?)\/[^/]+\.(?:ts|js)$/,
  ],
  dependency_bump: [
    // Lockfiles
    /(?:^|\/)(?:package-lock|yarn\.lock|bun\.lockb|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock)$/,
    // Manifest (coarser — only match at root or workspace root)
    /^package\.json$/,
  ],
  public_api_contract: [
    // OpenAPI / Swagger specs
    /(?:^|\/)openapi(?:\.v\d+)?\.(?:ya?ml|json)$/,
    /(?:^|\/)swagger(?:\.v\d+)?\.(?:ya?ml|json)$/,
    // Shared type packages (mono-repo convention)
    /^packages\/shared\/src\//,
    /^packages\/types\/src\//,
    /^packages\/api-types\/src\//,
    // Public-surface type roots
    /(?:^|\/)types\/(?:api|public|shared)\//,
  ],
};

/**
 * Given a full repo file listing, return the deduplicated directory prefixes
 * that satisfy the given risk class.
 *
 * Returns prefixes rather than individual file paths so the stored list stays
 * compact and covers future files in the same directories.
 */
export function detectRiskClassPaths(files: string[], className: RiskClassName): string[] {
  const matchers = CLASS_MATCHERS[className];
  const matchedFiles = files.filter((f) => matchers.some((rx) => rx.test(f)));
  if (matchedFiles.length === 0) return [];

  // Deduplicate: for each matched file, find the deepest common directory prefix
  // that covers all files of this class. We use a simple approach: collect all
  // matched paths, extract directory prefixes (depth ≤ 3), and keep the most
  // specific ones that cover everything.
  const prefixes = new Set<string>();
  for (const file of matchedFiles) {
    const parts = file.split('/');
    // For single-component files (e.g. "Dockerfile"), use the file itself
    if (parts.length === 1) {
      prefixes.add(file);
      continue;
    }
    // Prefer the first 2-3 path components as the "prefix"
    const depth = Math.min(parts.length - 1, 3);
    prefixes.add(parts.slice(0, depth).join('/') + '/');
  }

  // Remove redundant prefixes (where one is a prefix of another)
  const sorted = [...prefixes].sort();
  const deduped: string[] = [];
  for (const p of sorted) {
    if (!deduped.some((prev) => p.startsWith(prev))) {
      deduped.push(p);
    }
  }
  return deduped;
}

/** Detect all risk classes in one pass over the file listing. */
export function detectAllRiskClasses(files: string[]): RiskClassEntry[] {
  const classNames: RiskClassName[] = [
    'destructive_schema_change',
    'ci_deploy_config',
    'auth_and_secrets',
    'dependency_bump',
    'public_api_contract',
  ];
  return classNames.map((name) => ({
    name,
    detectedPaths: detectRiskClassPaths(files, name),
  }));
}

// ── Policy resolution (per-PR) ────────────────────────────────────────────────

/** Get all effective paths for a risk class (detected + user overrides). */
export function effectivePathsForClass(entry: RiskClassEntry): string[] {
  return [...entry.detectedPaths, ...(entry.userPaths ?? [])];
}

/** Check whether a file path is covered by a risk class entry. */
function fileCoveredByClass(filePath: string, entry: RiskClassEntry): boolean {
  const paths = effectivePathsForClass(entry);
  return paths.some((p) => {
    // Exact match
    if (filePath === p) return true;
    // Directory prefix (with or without trailing slash)
    const prefix = p.endsWith('/') ? p : p + '/';
    if (filePath.startsWith(prefix)) return true;
    return false;
  });
}

export interface PRPolicyMatch {
  action: RiskClassAction;
  matchedClass: RiskClassName;
  matchedFile: string;
  reason: string;
}

/**
 * Resolve the most restrictive policy action for a PR given its file list.
 *
 * Returns the most restrictive match, or null if no risk class is triggered
 * (meaning the PR is unclassified → fall back to the base MergePolicy tier).
 *
 * Priority: human > agent-review > auto.
 */
export function resolveEffectivePolicyForPR(
  policyConfig: WorkspacePolicyConfig,
  prFiles: string[],
): PRPolicyMatch | null {
  const priority: Record<RiskClassAction, number> = {
    human: 2,
    'agent-review': 1,
    auto: 0,
  };

  let best: PRPolicyMatch | null = null;

  for (const entry of policyConfig.riskClasses) {
    const action = getClassAction(policyConfig.preset, entry.name);
    if (action === 'auto') continue; // no escalation — skip

    for (const file of prFiles) {
      if (fileCoveredByClass(file, entry)) {
        const candidate: PRPolicyMatch = {
          action,
          matchedClass: entry.name,
          matchedFile: file,
          reason: `${entry.name.replace(/_/g, ' ')} (${file}) → ${action}`,
        };
        if (!best || priority[action] > priority[best.action]) {
          best = candidate;
        }
        if (action === 'human') return best; // can't go higher
        break; // one hit per class is enough
      }
    }
  }

  return best;
}

// ── Intent sentence (for reviewer context) ───────────────────────────────────

const CLASS_LABELS: Record<RiskClassName, string> = {
  destructive_schema_change: 'destructive schema changes',
  ci_deploy_config: 'CI/deploy config changes',
  auth_and_secrets: 'auth/secrets changes',
  dependency_bump: 'dependency bumps',
  public_api_contract: 'public API contract changes',
};

const ACTION_LABELS: Record<RiskClassAction, string> = {
  human: 'human review required',
  'agent-review': 'agent-review required',
  auto: 'auto-merge allowed',
};

/**
 * Build a human- and agent-readable policy intent sentence.
 *
 * Example output:
 *   "This workspace escalates: destructive schema changes → human review,
 *    CI/deploy config changes → agent-review, auth/secrets changes → agent-review.
 *    Dependency bumps and public API contract changes auto-merge when CI passes."
 */
export function buildPolicyIntentSentence(policyConfig: WorkspacePolicyConfig): string {
  const byAction: Record<RiskClassAction, string[]> = {
    human: [],
    'agent-review': [],
    auto: [],
  };

  for (const entry of policyConfig.riskClasses) {
    const action = getClassAction(policyConfig.preset, entry.name);
    byAction[action].push(CLASS_LABELS[entry.name]);
  }

  const parts: string[] = [];
  if (byAction.human.length > 0) {
    parts.push(`${byAction.human.join(', ')} → human review required`);
  }
  if (byAction['agent-review'].length > 0) {
    parts.push(`${byAction['agent-review'].join(', ')} → agent-review required`);
  }
  if (byAction.auto.length > 0) {
    parts.push(`${byAction.auto.join(', ')} → auto-merge when CI passes`);
  }

  const preset = policyConfig.preset.charAt(0).toUpperCase() + policyConfig.preset.slice(1);
  return `${preset} policy — ${parts.join('; ')}.`;
}

/**
 * Build a per-class path listing for the reviewer context.
 * Returns a markdown block showing which detected paths cover each class.
 */
export function buildPolicyClassPaths(policyConfig: WorkspacePolicyConfig): string {
  const lines: string[] = ['## Workspace Policy (semantic risk classes)'];
  lines.push('');
  lines.push(buildPolicyIntentSentence(policyConfig));
  lines.push('');
  lines.push('**Detected paths per class:**');
  for (const entry of policyConfig.riskClasses) {
    const action = getClassAction(policyConfig.preset, entry.name);
    const paths = effectivePathsForClass(entry);
    if (paths.length === 0) continue;
    lines.push(`- **${CLASS_LABELS[entry.name]}** (${ACTION_LABELS[action]}): ${paths.join(', ')}`);
  }
  return lines.join('\n');
}

// ── Self-healing: classify unknown risk-adjacent paths ────────────────────────

/** Additional broad matchers for directory-form paths (no extension). */
const BROAD_CLASS_MATCHERS: Record<RiskClassName, RegExp[]> = {
  destructive_schema_change: [
    /(?:^|\/)drizzle(?:\/|$)/,
    /(?:^|\/)prisma(?:\/|$)/,
    /(?:^|\/)alembic(?:\/|$)/,
    /(?:^|\/)migrations?(?:\/|$)/,
    /(?:^|\/)(?:db|database)\/schema/,
  ],
  ci_deploy_config: [
    /^\.github(?:\/|$)/,
    /^\.circleci(?:\/|$)/,
    /deploy|infra|terraform|k8s|helm|charts?/,
  ],
  auth_and_secrets: [
    /(?:^|\/)auth(?:\/|$)/,
    /(?:^|\/)authentication(?:\/|$)/,
    /secrets?|credentials?/,
  ],
  dependency_bump: [
    /lock(?:b|file)?$/,
    /package\.json$/,
  ],
  public_api_contract: [
    /(?:^|\/)shared(?:\/|$)/,
    /(?:^|\/)types(?:\/|$)/,
    /openapi|swagger|graphql|proto/,
  ],
};

/**
 * Guess which risk class a path might belong to based on heuristics.
 * Used to propose mappings when the reviewer encounters an uncovered path.
 * Works with both file paths and directory prefixes.
 *
 * Returns null if the path doesn't look risk-adjacent.
 */
export function guessRiskClass(path: string): RiskClassName | null {
  // Try precise matchers first
  for (const [name, matchers] of Object.entries(CLASS_MATCHERS) as [RiskClassName, RegExp[]][]) {
    if (matchers.some((rx) => rx.test(path))) return name;
  }
  // Try broad matchers (covers directory-form paths)
  for (const [name, matchers] of Object.entries(BROAD_CLASS_MATCHERS) as [RiskClassName, RegExp[]][]) {
    if (matchers.some((rx) => rx.test(path))) return name;
  }
  return null;
}

/**
 * Find files in a PR that are risk-adjacent but not covered by any policy class.
 *
 * Returns proposed additions — the reviewer can mention these in escalation reasons
 * so the human can add them to the appropriate class.
 */
export function findUncoveredRiskPaths(
  policyConfig: WorkspacePolicyConfig,
  prFiles: string[],
): Array<{ file: string; suggestedClass: RiskClassName }> {
  const proposals: Array<{ file: string; suggestedClass: RiskClassName }> = [];
  for (const file of prFiles) {
    // Is this file already covered?
    const covered = policyConfig.riskClasses.some((entry) => fileCoveredByClass(file, entry));
    if (covered) continue;

    // Is it risk-adjacent?
    const suggestedClass = guessRiskClass(file);
    if (suggestedClass) {
      proposals.push({ file, suggestedClass });
    }
  }
  return proposals;
}

// ── Legacy migration helper ───────────────────────────────────────────────────

/**
 * Infer a WorkspacePolicyConfig from legacy hand-authored paths.
 *
 * Existing workspaces with escalateToPaths or denyPaths keep full coverage — we
 * classify their paths into risk classes and show the inferred tier for confirmation.
 * Never called on the write path; used only to propose a migration to the user.
 */
export function inferPolicyConfigFromLegacy(
  escalateToPaths: string[],
  reviewerRole: string,
  suggestedPreset: WorkspacePolicyPreset = 'balanced',
): WorkspacePolicyConfig {
  const classMap: Partial<Record<RiskClassName, Set<string>>> = {};

  for (const p of escalateToPaths) {
    const guessed = guessRiskClass(p);
    if (guessed) {
      if (!classMap[guessed]) classMap[guessed] = new Set();
      classMap[guessed]!.add(p);
    }
  }

  const riskClasses: RiskClassEntry[] = [];
  for (const [name, paths] of Object.entries(classMap) as [RiskClassName, Set<string>][]) {
    riskClasses.push({
      name,
      detectedPaths: [],
      userPaths: [...paths],
    });
  }

  return {
    preset: suggestedPreset,
    riskClasses,
    reviewerRole,
  };
}

// ── Policy integration: resolve MergePolicy for a PR ─────────────────────────

/**
 * Resolve the effective MergePolicy for a specific PR given:
 *   - The workspace policyConfig (semantic risk classes)
 *   - The PR file list
 *   - The base MergePolicy (from resolvePolicy())
 *
 * When policyConfig is set, risk-class matches override the base tier.
 * This ensures the tier is per-PR (based on what changed), not per-workspace.
 */
export function applyPolicyConfigToMergePolicy(
  base: MergePolicy,
  policyConfig: WorkspacePolicyConfig | null | undefined,
  prFileNames: string[],
): MergePolicy {
  if (!policyConfig || policyConfig.riskClasses.length === 0) return base;

  const match = resolveEffectivePolicyForPR(policyConfig, prFileNames);
  if (!match) return base; // no risk class triggered — keep base

  // Map RiskClassAction → MergePolicyTier
  const tierMap: Record<RiskClassAction, MergePolicy['tier']> = {
    human: 'human',
    'agent-review': 'agent-review',
    auto: 'auto-threshold',
  };

  const effectiveTier = tierMap[match.action];

  // Only override if the matched tier is MORE restrictive than the base
  const tierPriority: Record<MergePolicy['tier'], number> = {
    human: 2,
    'agent-review': 1,
    'auto-threshold': 0,
  };
  if (tierPriority[effectiveTier] <= tierPriority[base.tier]) return base;

  // Build the effective policy
  const reviewerRole = policyConfig.reviewerRole ?? base.agentReview?.reviewerRole ?? 'reviewer';
  return {
    ...base,
    tier: effectiveTier,
    agentReview:
      effectiveTier === 'agent-review'
        ? {
            reviewerRole,
            // escalateToPaths is empty — we use policyConfig instead
            escalateToPaths: base.agentReview?.escalateToPaths ?? [],
            maxConfidenceThreshold: base.agentReview?.maxConfidenceThreshold,
            gateCondition: base.agentReview?.gateCondition,
          }
        : base.agentReview,
    _policyMatch: match,
  } as MergePolicy & { _policyMatch: PRPolicyMatch };
}
