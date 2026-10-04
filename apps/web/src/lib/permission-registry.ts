/**
 * The team permission registry, pure half: the named permissions, their
 * default roles and key floors, and the synchronous checks over them.
 *
 * No runtime imports at all, so a pure policy module, a test that mocks the
 * schema, or a client component can ask `roleHas` without loading the db.
 * The async, db-backed half (`can`, `teamIdsWhere`) lives in permissions.ts,
 * which re-exports everything here — import from there unless you need to
 * stay db-free.
 */
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

export const OWNER_ADMIN = ['owner', 'admin'] as const satisfies readonly TeamRole[];
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
export function effectiveRoles(_teamId: string | null, permission: Permission): readonly TeamRole[] {
  return PERMISSIONS[permission].defaultRoles;
}

/** Internal to the registry and permissions.ts. */
export function holds(roles: readonly TeamRole[], role: unknown): boolean {
  return isTeamRole(role) && roles.includes(role);
}

/** Internal to the registry and permissions.ts. */
export function keyHolds(minKeyLevel: ApiKeyLevel | null, level: unknown): boolean {
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
