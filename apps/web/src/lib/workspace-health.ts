/**
 * Workspace health — which legacy settings a workspace still carries, and the
 * one existing action that fixes each.
 *
 * Pure: no db, no fetch. The config page loads the row and renders whatever this
 * returns; an empty list means nothing to show. Client-safe (imported by the
 * health card for the policy sheet), so keep runtime imports to pure modules.
 */

import { isSystemWorkspace } from '@buildd/shared';
import type { WorkspacePolicyConfig, RiskClassName, RiskClassAction } from '@buildd/shared';
import { PRESET_ACTIONS, effectivePathsForClass } from './workspace-policy';

/** `warning` = legacy, should be fixed. `action` = an offer, not a problem. */
export type HealthSeverity = 'warning' | 'action' | 'info';

export type HealthActionKind = 'review-policy' | 'restrict-access' | 'move-team';

export interface HealthItem {
  id: 'policy' | 'access-open' | 'team-placement' | 'system-workspace';
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
 * Pre-`policyConfig` merge settings: the `autoMerge*` rails and hand-typed
 * `escalateToPaths`. `autoMergeOnGreenCI` is the current field and does not count.
 */
export function hasLegacyMergeFields(gitConfig: Record<string, unknown> | null | undefined): boolean {
  if (!gitConfig) return false;
  if (typeof gitConfig.autoMergePR === 'boolean') return true;
  if (typeof gitConfig.autoMergeMaxLines === 'number') return true;
  if (Array.isArray(gitConfig.autoMergeDenyPaths) && gitConfig.autoMergeDenyPaths.length > 0) return true;
  const escalate = (gitConfig.mergePolicy as { agentReview?: { escalateToPaths?: unknown } } | undefined)
    ?.agentReview?.escalateToPaths;
  return Array.isArray(escalate) && escalate.length > 0;
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

  if (input.accessMode === 'open') {
    items.push({
      id: 'access-open',
      severity: 'warning',
      label: 'Open access — any signed-in user can view and work in this workspace',
      note: 'Only members of this workspace’s team keep access.',
      action: { kind: 'restrict-access', label: 'Restrict to team members' },
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
