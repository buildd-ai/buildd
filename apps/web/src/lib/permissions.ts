/**
 * Named team permissions — the one place that decides who may do what in a team.
 *
 * Every team-scoped permission decision is a lookup in `PERMISSIONS` below:
 * which team roles hold it by default, and the minimum API-key level that holds
 * it (or `null` when no API key may). Call sites ask by name:
 *
 *   roleHas(role, 'manage_team_members')          // pure, UI that knows the role
 *   await can(caller, 'manage_team_members', id)  // routes: session OR API key
 *
 * Resolution runs through `effectiveRoles`, which today returns the registry's
 * `defaultRoles` and nothing else. The inventory these defaults reproduce lives
 * in docs/specs/team-permissions.md — a default here that disagrees with the
 * call site it names is a behaviour change, not a cleanup.
 *
 * Deliberately not here: workspace reach (`verifyWorkspaceAccess`,
 * `verifyAccountWorkspaceAccess`) — whether the caller can see a workspace at
 * all — and token-scope route policy (`token-route-policy.ts`), which decides
 * which routes a scoped token may call. Both run before a permission check.
 *
 * Imports no app module at runtime: team-access.ts builds its admin-tier
 * helpers on this file, and many route tests replace team-access wholesale.
 * The schema is a namespace import for the same reason: route tests mock it
 * with only the tables they touch, and a named import of a table the mock
 * leaves out fails at link time even for a route that only calls `roleHas`.
 */
import { cache } from 'react';
import { db } from '@buildd/core/db';
import * as schema from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

export type TeamRole = 'owner' | 'admin' | 'member';
export type ApiKeyLevel = 'trigger' | 'worker' | 'admin';

export const TEAM_ROLES: readonly TeamRole[] = ['owner', 'admin', 'member'];
export const API_KEY_LEVELS: readonly ApiKeyLevel[] = ['trigger', 'worker', 'admin'];

const LEVEL_RANK: Record<ApiKeyLevel, number> = { trigger: 1, worker: 2, admin: 3 };

/**
 * The principal behind a request. A session resolves to its user; an API key
 * resolves to its account, whose reach is its own team only.
 */
export type TeamScopeCaller =
  | { kind: 'user'; userId: string }
  | { kind: 'account'; accountId: string; teamId: string; level: string | null | undefined };

export interface PermissionDef {
  description: string;
  /** Team roles that hold this permission unless a team says otherwise. */
  defaultRoles: readonly TeamRole[];
  /** Lowest API-key level that holds it; `null` = session only, no key may. */
  minKeyLevel: ApiKeyLevel | null;
}

const OWNER_ADMIN = ['owner', 'admin'] as const satisfies readonly TeamRole[];
const OWNER_ONLY = ['owner'] as const satisfies readonly TeamRole[];

/**
 * Each entry reproduces the rule its call sites apply today — see the
 * inventory in docs/specs/team-permissions.md for file:line per entry. Odd
 * rules are reproduced, not fixed; the spec flags them.
 */
export const PERMISSIONS = {
  // ── Team membership ──────────────────────────────────────────────────────
  manage_team_members: {
    description: 'Add, invite and remove team members (admins cannot remove an owner).',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
  },
  assign_team_owner: {
    description: "Change a member's role, or add a member as owner.",
    defaultRoles: OWNER_ONLY,
    minKeyLevel: null,
  },
  // ── Team settings ────────────────────────────────────────────────────────
  manage_team_settings: {
    description: 'Edit team name, slug, AI features, chat budgets, key policy and timezone.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
  },
  delete_team: {
    description: 'Delete a (non-personal) team.',
    defaultRoles: OWNER_ONLY,
    minKeyLevel: null,
  },
  seed_team_timezone: {
    description: "A user's own timezone change also seeds the timezone of teams they own.",
    defaultRoles: OWNER_ONLY,
    minKeyLevel: null,
  },
  manage_chat_retro: {
    description: 'See and change chat retro settings.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  view_team_usage: {
    description: "See every member's spend and the operator view of Home.",
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
  },
  // ── API keys and runners ─────────────────────────────────────────────────
  manage_team_keys: {
    description: 'Regenerate API keys, flag host-runner keys, and mint or approve admin-level keys and admin scopes.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
  },
  // ── Model access and spend ───────────────────────────────────────────────
  manage_team_model_keys: {
    description: 'Manage the team model key in secrets.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  manage_inference_providers: {
    description: 'Manage team inference keys, OpenRouter link, agent endpoint and LiteLLM gateway.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
  },
  manage_model_tiers: {
    description: 'Change which model backs a tier, and model traffic pools.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  manage_ai_budget: {
    description: "Set an app account's daily AI budget.",
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  use_chat_admin_tools: {
    description: 'Chat may offer admin-group tools (always confirm-first).',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
  },
  // ── Workspaces ───────────────────────────────────────────────────────────
  manage_workspace_settings: {
    description: 'Edit workspace config, git/merge policy, access mode, data class, connector gate and webhook.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  delete_workspace: {
    description: 'Delete a workspace.',
    defaultRoles: OWNER_ONLY,
    minKeyLevel: null,
  },
  migrate_workspace: {
    description: 'Move a workspace between teams (admin of both teams).',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  manage_github_installation: {
    description: 'Manage a GitHub App installation owned by the team (its installer may too).',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
  },
  review_memory: {
    description: 'Promote, dismiss or re-verify workspace memories.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  // ── Work in flight ───────────────────────────────────────────────────────
  steer_workers: {
    description: 'Send instructions to a running worker.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  force_reassign_task: {
    description: 'Force-reassign a task held by another worker.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'trigger',
  },
  manage_releases: {
    description: 'Read release preflight and trigger a release.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  // ── Team infrastructure ──────────────────────────────────────────────────
  manage_connectors: {
    description: 'Create, share and transfer connectors.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  manage_evidence_backends: {
    description: 'Create, edit, verify and delete evidence storage backends.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  run_experiments: {
    description: 'Create, start, pause and conclude experiments; see admin-only ones.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
} as const satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);
}

export function isApiKeyLevel(value: unknown): value is ApiKeyLevel {
  return typeof value === 'string' && (API_KEY_LEVELS as readonly string[]).includes(value);
}

/**
 * The team roles that hold `permission` in `teamId`.
 *
 * The seam for per-team overrides: a later mission reads a team's stored
 * grants here. Today there is no storage, so every team gets the defaults and
 * `teamId` is unused. Kept synchronous and pure until that storage exists.
 */
function effectiveRoles(_teamId: string | null, permission: Permission): readonly TeamRole[] {
  return PERMISSIONS[permission].defaultRoles;
}

function holds(roles: readonly TeamRole[], role: unknown): boolean {
  return isTeamRole(role) && roles.includes(role);
}

function keyHolds(minKeyLevel: ApiKeyLevel | null, level: unknown): boolean {
  return minKeyLevel !== null && isApiKeyLevel(level) && LEVEL_RANK[level] >= LEVEL_RANK[minKeyLevel];
}

/**
 * Whether a team role holds `permission`, by default. Pure — for UI that
 * already has the role in hand. An unknown or missing role holds nothing.
 */
export function roleHas(role: TeamRole | string | null | undefined, permission: Permission): boolean {
  return holds(effectiveRoles(null, permission), role);
}

/** Whether an API key of `level` holds `permission`. Unknown levels hold nothing. */
export function keyLevelHas(level: string | null | undefined, permission: Permission): boolean {
  return keyHolds(PERMISSIONS[permission].minKeyLevel, level);
}

/**
 * Every team the user belongs to, with their role in it. The user's personal
 * team (slug = personal-{userId}) counts as owned even without a teamMembers
 * row, mirroring getUserTeamIds' fallback.
 *
 * Cached per-request via React cache() (primitive arg).
 */
export const getUserTeamRoles = cache(async (userId: string): Promise<Map<string, TeamRole | string>> => {
  const [memberships, personalTeam] = await Promise.all([
    db.query.teamMembers.findMany({
      where: eq(schema.teamMembers.userId, userId),
      columns: { teamId: true, role: true },
    }),
    db.query.teams.findFirst({
      where: eq(schema.teams.slug, `personal-${userId}`),
      columns: { id: true },
    }),
  ]);
  const roles = new Map<string, TeamRole | string>(memberships.map(m => [m.teamId, m.role]));
  if (personalTeam) roles.set(personalTeam.id, 'owner');
  return roles;
});

/** A role grant plus key floor, the shape every check below resolves to. */
type Grant = { roles: (teamId: string) => readonly TeamRole[]; minKeyLevel: ApiKeyLevel | null };

/**
 * Scoped tokens carry `scopes`, not a level. Callers map them to a level
 * before asking (e.g. an `admin` scope → 'admin'), as the memory review route
 * does today; `can` reads only `level`.
 */

async function teamIdsGranted(caller: TeamScopeCaller, grant: Grant): Promise<string[]> {
  if (caller.kind === 'account') {
    return keyHolds(grant.minKeyLevel, caller.level) ? [caller.teamId] : [];
  }
  const roles = await getUserTeamRoles(caller.userId);
  return [...roles].filter(([teamId, role]) => holds(grant.roles(teamId), role)).map(([teamId]) => teamId);
}

function grantFor(permission: Permission): Grant {
  return { roles: teamId => effectiveRoles(teamId, permission), minKeyLevel: PERMISSIONS[permission].minKeyLevel };
}

/**
 * The teams in which the caller holds `permission`: for a session, teams whose
 * role grants it; for an API key, the key's own team when its level does,
 * otherwise none.
 */
export async function teamIdsWhere(caller: TeamScopeCaller, permission: Permission): Promise<string[]> {
  return teamIdsGranted(caller, grantFor(permission));
}

/** Whether the caller holds `permission` in `teamId`. Fails closed. */
export async function can(caller: TeamScopeCaller, permission: Permission, teamId: string): Promise<boolean> {
  if (!teamId) return false;
  return (await teamIdsWhere(caller, permission)).includes(teamId);
}

/**
 * The pre-registry "admin tier": owner/admin role, or an admin-level key of the
 * team. team-access's getCallerAdminTeamIds / canCallerAdminTeam resolve
 * through this until their call sites move to a named permission.
 */
export const ADMIN_TIER: Grant = { roles: () => OWNER_ADMIN, minKeyLevel: 'admin' };

export async function teamIdsWithAdminTier(caller: TeamScopeCaller): Promise<string[]> {
  return teamIdsGranted(caller, ADMIN_TIER);
}
