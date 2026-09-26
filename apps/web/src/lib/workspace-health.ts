/**
 * Workspace health — which legacy settings a workspace still carries, and the
 * one existing action that fixes each.
 *
 * Pure: no db, no fetch. The config page loads the row and renders whatever this
 * returns; an empty list means nothing to show. Client-safe (imported by the
 * health card for the policy sheet), so keep runtime imports to pure modules.
 */

import { isSystemWorkspace } from '@buildd/shared';
import type { WorkspacePolicyConfig, WorkspacePolicyPreset, RiskClassName, RiskClassAction } from '@buildd/shared';
import { PRESET_ACTIONS, effectivePathsForClass } from './workspace-policy';

/** `warning` = legacy, should be fixed. `action` = an offer, not a problem. */
export type HealthSeverity = 'warning' | 'action' | 'info';

export type HealthActionKind = 'review-policy' | 'move-team';

export interface HealthItem {
  id: 'policy' | 'team-placement' | 'system-workspace';
  severity: HealthSeverity;
  label: string;
  /** One-line consequence of taking the action, when it is not obvious. */
  note?: string;
  action: { kind: HealthActionKind; label: string } | null;
}

export interface WorkspaceHealthInput {
  name: string;
  repo: string | null;
  configStatus: string;
  accessMode: string;
  gitConfig: Record<string, unknown> | null;
  /** How many teams the viewing user belongs to. */
  userTeamCount: number;
}

/**
 * Pre-`policyConfig` merge settings: the `autoMerge*` rails. `autoMergeOnGreenCI`
 * is the current field and does not count. The hand-written path fields
 * (`autoMergeDenyPaths`, `escalateToPaths`) are no longer part of this rule: the
 * API refuses them and the merge gate only keeps a one-release read fallback.
 */
export function hasLegacyMergeFields(gitConfig: Record<string, unknown> | null | undefined): boolean {
  if (!gitConfig) return false;
  if (typeof gitConfig.autoMergePR === 'boolean') return true;
  return typeof gitConfig.autoMergeMaxLines === 'number';
}

/**
 * A system workspace (`__` prefix, the same predicate the rest of the app uses
 * to hide `__coordination`) with no repo exists to run orchestration. It has no
 * repo to scan and is created `open` on purpose, so the other rules do not apply.
 */
function isOrchestrationWorkspace(input: WorkspaceHealthInput): boolean {
  return isSystemWorkspace(input.name) && !input.repo;
}

export function checkWorkspaceHealth(input: WorkspaceHealthInput): HealthItem[] {
  if (isOrchestrationWorkspace(input)) {
    return [{
      id: 'system-workspace',
      severity: 'info',
      label: 'System workspace for orchestration — no repo by design',
      action: null,
    }];
  }

  const items: HealthItem[] = [];
  const hasPolicy = !!input.gitConfig?.policyConfig;
  const unconfirmed = input.configStatus !== 'admin_confirmed';
  const legacy = hasLegacyMergeFields(input.gitConfig) && !hasPolicy;

  // One line covers both: the same review-and-apply flow fixes either.
  if (unconfirmed || legacy) {
    items.push({
      id: 'policy',
      severity: 'warning',
      label: legacy
        ? 'Uses legacy merge settings instead of a risk-class policy'
        : 'Merge policy has not been reviewed',
      action: { kind: 'review-policy', label: 'Review proposed policy' },
    });
  }

  if (input.userTeamCount > 1) {
    items.push({
      id: 'team-placement',
      severity: 'action',
      label: 'Move this workspace to another of your teams',
      action: { kind: 'move-team', label: 'Move to team…' },
    });
  }

  return items;
}

// ── Proposed-policy presentation ─────────────────────────────────────────────

const CLASS_LABELS: Record<RiskClassName, string> = {
  destructive_schema_change: 'Destructive schema changes',
  ci_deploy_config: 'CI and deploy config',
  auth_and_secrets: 'Auth and secrets',
  dependency_bump: 'Dependency bumps',
  public_api_contract: 'Public API contract',
};

const ACTION_LABELS: Record<RiskClassAction, string> = {
  human: 'Human review',
  'agent-review': 'Agent review',
  auto: 'Auto-merge',
};

export interface PolicyClassRow {
  name: RiskClassName;
  label: string;
  action: RiskClassAction;
  actionLabel: string;
  paths: string[];
}

/** A proposed policy as readable rows: class, what happens to a PR touching it, and where. */
export function describePolicyConfig(config: WorkspacePolicyConfig): PolicyClassRow[] {
  return config.riskClasses.map((entry) => {
    const action = PRESET_ACTIONS[config.preset]?.[entry.name] ?? 'human';
    return {
      name: entry.name,
      label: CLASS_LABELS[entry.name] ?? entry.name,
      action,
      actionLabel: ACTION_LABELS[action],
      paths: effectivePathsForClass(entry),
    };
  });
}

// ── Re-scan diff ─────────────────────────────────────────────────────────────

export interface PolicyClassDiff extends PolicyClassRow {
  added: string[];
  removed: string[];
  unchanged: string[];
}

export interface PolicyConfigDiff {
  /** Classes in the proposal first (proposal order), then classes only the current policy had. */
  classes: PolicyClassDiff[];
  presetChange: { from: WorkspacePolicyPreset; to: WorkspacePolicyPreset } | null;
  hasChanges: boolean;
}

/**
 * What applying a re-scan would change, per risk class. `current` paths are
 * everything stored (a legacy `userPaths` entry included), because applying
 * replaces the whole policyConfig — a stored path the proposal lacks is removed.
 * With no current policy every proposed path reads as added.
 */
export function diffPolicyConfig(
  current: WorkspacePolicyConfig | null | undefined,
  proposed: WorkspacePolicyConfig,
): PolicyConfigDiff {
  const storedPaths = new Map<RiskClassName, string[]>();
  for (const entry of current?.riskClasses ?? []) {
    storedPaths.set(entry.name, [...new Set([...(entry.detectedPaths ?? []), ...(entry.userPaths ?? [])])]);
  }

  const proposedRows = describePolicyConfig(proposed);
  const onlyCurrent = (current?.riskClasses ?? []).filter(
    (e) => !proposed.riskClasses.some((p) => p.name === e.name),
  );
  // Classes that disappear are rendered with the proposal's preset action — that
  // is the policy that will be in force after applying.
  const currentOnlyRows = describePolicyConfig({ ...proposed, riskClasses: onlyCurrent }).map((row) => ({ ...row, paths: [] }));

  const classes = [...proposedRows, ...currentOnlyRows].map((row) => {
    const before = storedPaths.get(row.name) ?? [];
    const after = row.paths;
    return {
      ...row,
      added: after.filter((p) => !before.includes(p)),
      removed: before.filter((p) => !after.includes(p)),
      unchanged: after.filter((p) => before.includes(p)),
    };
  });

  const presetChange = current && current.preset !== proposed.preset
    ? { from: current.preset, to: proposed.preset }
    : null;

  return {
    classes,
    presetChange,
    hasChanges: !current || !!presetChange || classes.some((c) => c.added.length > 0 || c.removed.length > 0),
  };
}
