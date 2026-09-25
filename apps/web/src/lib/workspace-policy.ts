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
import type { MigrationSafety } from '@/lib/migration-safety';
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
 * How a matcher's hits are stored.
 *
 *   - `dir`:  the regex's first capture group is the matched directory
 *             (ending in `/`). Stored as that prefix so future files in the
 *             same directory are covered. Never widened to the parent — a
 *             `lib/auth/` hit must not become `lib/`.
 *   - `file`: the file path itself is stored, verbatim. A single-file hit
 *             (`middleware.ts`, `vercel.json`, `db/schema.ts`) collapsed to
 *             its parent would put every sibling behind the class — one
 *             middleware file would escalate the whole app.
 */
type ClassMatcher = { kind: 'dir' | 'file'; rx: RegExp };

const dir = (rx: RegExp): ClassMatcher => ({ kind: 'dir', rx });
const file = (rx: RegExp): ClassMatcher => ({ kind: 'file', rx });

/** Regex tests that classify a file path into a risk class. */
const CLASS_MATCHERS: Record<RiskClassName, ClassMatcher[]> = {
  destructive_schema_change: [
    // Drizzle: any directory named "drizzle" that contains numbered SQL migrations
    dir(/^((?:.*\/)?drizzle\/)\d+_/),
    // Prisma: prisma/migrations
    dir(/^((?:.*\/)?prisma\/migrations?\/)/),
    // Alembic
    dir(/^((?:.*\/)?alembic\/versions?\/)/),
    // Generic: a "migrations" dir with SQL files
    dir(/^((?:.*\/)?migrations?\/)[^/]+\.sql$/),
    // Schema source files (ORM definitions)
    file(/(?:^|\/)(?:db\/schema|models\/schema|prisma\/schema)\.(?:ts|js|prisma)$/),
  ],
  ci_deploy_config: [
    dir(/^(\.github\/workflows\/)/),
    dir(/^(\.github\/actions\/)/),
    dir(/^(\.circleci\/)/),
    file(/^\.gitlab-ci\.ya?ml$/),
    file(/^Jenkinsfile/),
    file(/(?:^|\/)vercel\.json$/),
    file(/(?:^|\/)netlify\.toml$/),
    file(/(?:^|\/)Dockerfile(?:\.\w+)?$/),
    file(/(?:^|\/)docker-compose(?:\.override)?\.ya?ml$/),
    file(/(?:^|\/)railway\.toml$/),
    file(/(?:^|\/)fly\.toml$/),
    file(/(?:^|\/)render\.ya?ml$/),
  ],
  auth_and_secrets: [
    // Auth directories
    dir(/^((?:.*\/)?(?:lib|src)\/auth\/)/),
    dir(/^((?:.*\/)?(?:lib|src)\/authentication\/)/),
    file(/(?:^|\/)(?:lib|src)\/auth(?:entication)?$/),
    file(/(?:^|\/)middleware\.(?:ts|js)$/),
    // Env schema files (typed env loaders)
    file(/(?:^|\/)(?:env|config)\.(?:schema|types?)\.(?:ts|js)$/),
    file(/(?:^|\/)(?:src|lib)\/env\.(?:ts|js)$/),
    dir(/^((?:.*\/)?(?:src|lib)\/env\/)/),
    // Secret loaders
    dir(/^((?:.*\/)?(?:secrets?|credentials?)\/)[^/]+\.(?:ts|js)$/),
  ],
  dependency_bump: [
    // Lockfiles
    file(
      /(?:^|\/)(?:package-lock\.json|yarn\.lock|bun\.lockb?|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock)$/,
    ),
    // Manifest (coarser — only match at root)
    file(/^package\.json$/),
  ],
  public_api_contract: [
    // OpenAPI / Swagger specs
    file(/(?:^|\/)openapi(?:\.v\d+)?\.(?:ya?ml|json)$/),
    file(/(?:^|\/)swagger(?:\.v\d+)?\.(?:ya?ml|json)$/),
    // Shared type packages (mono-repo convention)
    dir(/^(packages\/shared\/src\/)/),
    dir(/^(packages\/types\/src\/)/),
    dir(/^(packages\/api-types\/src\/)/),
    // Public-surface type roots
    dir(/^((?:.*\/)?types\/(?:api|public|shared)\/)/),
  ],
};

/**
 * Given a full repo file listing, return the paths that satisfy the given
 * risk class: directory prefixes (ending in `/`) for directory-form matchers,
 * exact file paths for file-form matchers.
 *
 * Deduplication: a prefix inside another kept prefix is dropped, and a file
 * already covered by a kept prefix is dropped.
 */
export function detectRiskClassPaths(files: string[], className: RiskClassName): string[] {
  const matchers = CLASS_MATCHERS[className];
  const dirs = new Set<string>();
  const exact = new Set<string>();
  for (const f of files) {
    for (const m of matchers) {
      const hit = m.rx.exec(f);
      if (!hit) continue;
      if (m.kind === 'dir' && hit[1]) dirs.add(hit[1]);
      else exact.add(f);
      break;
    }
  }

  const keptDirs: string[] = [];
  for (const d of [...dirs].sort()) {
    if (!keptDirs.some((prev) => d.startsWith(prev))) keptDirs.push(d);
  }
  const keptFiles = [...exact].filter((f) => !keptDirs.some((d) => f.startsWith(d)));
  return [...keptDirs, ...keptFiles].sort();
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

/**
 * Get all effective paths for a risk class (detected + user overrides).
 *
 * `detectedPaths` is required by the type but this config is jsonb, and
 * `PATCH /api/workspaces/[id]` accepts a hand-authored `gitConfig.policyConfig`
 * that TypeScript never sees. An unguarded spread over a missing array threw
 * inside `preflightEscalationCheck`, whose caller catches and returns "no
 * reviewer dispatched" — which the webhook then follows into the auto-merge
 * path. A crashing escalation gate must not read as an absent one.
 */
export function effectivePathsForClass(entry: RiskClassEntry): string[] {
  return [...(entry.detectedPaths ?? []), ...(entry.userPaths ?? [])];
}

/**
 * Whether a stored path entry covers a PR file.
 *
 * An entry ending in `/` is a directory prefix; anything else is an exact
 * file path. Detected entries follow that rule strictly — detection emits a
 * trailing `/` for every directory it stores, and a file entry must not
 * cover a same-named directory.
 *
 * `userPaths` are hand-authored or migrated from legacy `escalateToPaths`,
 * which were matched as prefixes and were often written without the slash
 * (`src/auth`). They keep the old reading: exact, or a directory prefix.
 */
function pathEntryCovers(entry: string, filePath: string, lenientDir: boolean): boolean {
  if (entry.endsWith('/')) return filePath.startsWith(entry);
  if (filePath === entry) return true;
  return lenientDir && filePath.startsWith(entry + '/');
}

/** Check whether a file path is covered by a risk class entry. */
function fileCoveredByClass(filePath: string, entry: RiskClassEntry): boolean {
  return (
    (entry.detectedPaths ?? []).some((p) => pathEntryCovers(p, filePath, false)) ||
    (entry.userPaths ?? []).some((p) => pathEntryCovers(p, filePath, true))
  );
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
 *
 * `destructive_schema_change` is decided by the operation-class classifier,
 * not by path: an EXPAND verdict (additive-only SQL, or schema.ts with no
 * generated migration) means the class does not fire. Without a verdict the
 * class falls back to its path match, so a missing inspection fails closed.
 */
export function resolveEffectivePolicyForPR(
  policyConfig: WorkspacePolicyConfig,
  prFiles: string[],
  migrationSafety?: MigrationSafety,
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
    if (entry.name === 'destructive_schema_change' && migrationSafety?.safe) continue;

    for (const file of prFiles) {
      if (fileCoveredByClass(file, entry)) {
        const detail =
          entry.name === 'destructive_schema_change' && migrationSafety && !migrationSafety.safe
            ? `${file}: ${migrationSafety.reason}`
            : file;
        const candidate: PRPolicyMatch = {
          action,
          matchedClass: entry.name,
          matchedFile: detail,
          reason: `${entry.name.replace(/_/g, ' ')} (${detail}) → ${action}`,
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
  for (const [name, matchers] of Object.entries(CLASS_MATCHERS) as [RiskClassName, ClassMatcher[]][]) {
    if (matchers.some((m) => m.rx.test(path))) return name;
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
  migrationSafety?: MigrationSafety,
): MergePolicy {
  if (!policyConfig || policyConfig.riskClasses.length === 0) return base;

  const match = resolveEffectivePolicyForPR(policyConfig, prFileNames, migrationSafety);
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
