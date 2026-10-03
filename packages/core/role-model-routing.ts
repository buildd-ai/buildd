/**
 * How a task's role feeds model selection — shared by the claim route (the
 * decision) and the create-time routing preview (its echo), so the two cannot
 * drift. Pure: no DB access.
 *
 * Precedence (docs/specs/model-routing-and-tiers.md, "Claim-time model
 * resolution"; knowledge-base: buildd/design/role-routing.md §4):
 *   1. `context.model` pin
 *   2. `tasks.tier`
 *   3. the role's `model` when it is an exact model id
 *   4. `kind × complexity` matrix, then the role's `model` as a floor
 *
 * An inferred role (`context.roleInferred`) contributes nothing to the model —
 * not a pin, not a floor (role-routing.md §4.1).
 */

import type { Tier as RouterTier } from './model-router';
import { TIERS, type Tier } from './model-tier-defaults';
import { EXPLICIT_ROLE_SLUGS } from '@buildd/shared';

/** Role `model` values that are tier vocabulary, not an exact model id. */
export const ROLE_MODEL_ALIASES: ReadonlySet<string> = new Set<string>([
  'haiku', 'sonnet', 'opus', 'inherit', ...TIERS,
]);

/** True when a role's `model` pins an exact model id rather than naming a tier. */
export function isExactRoleModel(model: string | null | undefined): model is string {
  return !!model && !ROLE_MODEL_ALIASES.has(model);
}

/** Registry tier a role floor stands for, or null for `inherit`/unset/exact id. */
export function roleFloorTier(model: string | null | undefined): Tier | null {
  if (!model || isExactRoleModel(model)) return null;
  if (model === 'opus') return 'premium';
  if (model === 'sonnet') return 'standard';
  if (model === 'haiku') return 'budget';
  return (TIERS as readonly string[]).includes(model) ? (model as Tier) : null;
}

export interface RoleModelRow {
  slug: string;
  model: string | null;
  workspaceId: string | null;
  teamId?: string | null;
}

/**
 * The role row that governs a task: the task workspace's override row, else
 * the team default (`workspaceId IS NULL`) of the task's team. Same resolution
 * as `checkConnectorRouting` (claim/connector-gate.ts). A row overriding the
 * slug in ANY OTHER workspace is never used — the claim route once keyed
 * floors by slug across all of a runner's workspaces, so two workspaces
 * overriding the same slug could swap floors.
 */
export function pickRoleRowForTask<R extends RoleModelRow>(
  rows: readonly R[],
  task: { roleSlug: string | null | undefined; workspaceId: string; teamId: string | null | undefined },
): R | null {
  if (!task.roleSlug) return null;
  const bySlug = rows.filter(r => r.slug === task.roleSlug);
  const override = bySlug.find(r => r.workspaceId === task.workspaceId);
  if (override) return override;
  if (!task.teamId) return null;
  return bySlug.find(r => r.workspaceId === null && r.teamId === task.teamId) ?? null;
}

/**
 * How many roles a later role inference could choose between for a task in
 * `workspaceId` — role-routing.md §2/§3's candidate rule, minus the per-task
 * filters: the effective row per slug (workspace override wins), not an
 * explicit slug, not `routing.disabled`, and with `routing.whenToUse` text.
 * Rows are expected to be enabled roles of the task's team.
 */
export function countRoleInferenceCandidates(
  rows: readonly (RoleModelRow & { metadata?: unknown })[],
  workspaceId: string,
): number {
  const effective = new Map<string, RoleModelRow & { metadata?: unknown }>();
  for (const r of rows) {
    if (r.workspaceId !== null && r.workspaceId !== workspaceId) continue;
    if (!effective.has(r.slug) || r.workspaceId === workspaceId) effective.set(r.slug, r);
  }
  let n = 0;
  for (const r of effective.values()) {
    if (EXPLICIT_ROLE_SLUGS.includes(r.slug)) continue;
    const routing = (r.metadata as { routing?: { whenToUse?: unknown; disabled?: unknown } } | null | undefined)?.routing;
    if (!routing || routing.disabled === true) continue;
    if (typeof routing.whenToUse === 'string' && routing.whenToUse.trim()) n++;
  }
  return n;
}

export interface ClaimModelInputsArgs {
  /** `readModelPin(context)` — the caller's model pin, if any. */
  pin: string | null;
  /** `tasks.tier`. */
  taskTier: Tier | null | undefined;
  /** The resolved role row's `model` (null when the task has no role). */
  roleModel: string | null;
  /** `context.roleInferred` present — the role was inferred, not stated. */
  roleInferred: boolean;
}

export interface ClaimModelInputs {
  /** The role model that participates in routing — null for an inferred role. */
  roleModel: string | null;
  /** Passed to `resolveEffectiveModel` as `explicitModel`. */
  explicitModel: string | null;
  /** Passed to `resolveEffectiveModel` as `roleFloor` (router vocabulary). */
  routerRoleFloor: RouterTier | 'inherit' | null;
  /**
   * The registry tier to use when `tasks.tier` is unset, overriding the
   * router's alias. Only set for a `premium-plus` floor: the router tops out
   * at `opus` → `premium`, so without this a premium-plus role silently ran
   * at premium.
   */
  roleTierOverride: Tier | null;
}

export function resolveClaimModelInputs(args: ClaimModelInputsArgs): ClaimModelInputs {
  const roleModel = args.roleInferred ? null : args.roleModel;
  const exact = isExactRoleModel(roleModel);
  const floor = roleFloorTier(roleModel);
  const routerRoleFloor: RouterTier | 'inherit' | null =
    floor === 'premium-plus' || floor === 'premium' ? 'opus'
    : floor === 'standard' ? 'sonnet'
    : floor === 'budget' ? 'haiku'
    : roleModel === 'inherit' ? 'inherit'
    : null;
  return {
    roleModel,
    // An explicit tasks.tier outranks the role's exact id (role-routing.md §4.3).
    explicitModel: args.pin ?? (exact && !args.taskTier ? roleModel : null),
    routerRoleFloor,
    roleTierOverride: floor === 'premium-plus' && !args.taskTier ? 'premium-plus' : null,
  };
}
