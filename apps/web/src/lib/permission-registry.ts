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
  manage_team_permissions: {
    description: 'Choose which team roles hold each permission.',
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
  manage_billing: {
    description: "Start a paid plan, change seats and open the team's Stripe billing portal.",
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

/** How the settings matrix groups permissions, in registry order. Every permission is in exactly one. */
export const PERMISSION_GROUPS: ReadonlyArray<{ title: string; permissions: readonly Permission[] }> = [
  { title: 'Team membership', permissions: ['manage_team_members', 'assign_team_owner'] },
  { title: 'Team settings', permissions: ['manage_team_settings', 'delete_team', 'manage_team_permissions', 'seed_team_timezone', 'manage_chat_retro', 'view_team_usage', 'manage_billing'] },
  { title: 'API keys and runners', permissions: ['manage_team_keys'] },
  { title: 'Model access and spend', permissions: ['manage_team_model_keys', 'manage_inference_providers', 'manage_model_tiers', 'manage_ai_budget', 'use_chat_admin_tools'] },
  { title: 'Workspaces', permissions: ['manage_workspace_settings', 'delete_workspace', 'migrate_workspace', 'manage_github_installation', 'review_memory'] },
  { title: 'Work in flight', permissions: ['steer_workers', 'force_reassign_task', 'manage_releases'] },
  { title: 'Team infrastructure', permissions: ['manage_connectors', 'manage_evidence_backends', 'run_experiments'] },
];

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);
}

export function isApiKeyLevel(value: unknown): value is ApiKeyLevel {
  return typeof value === 'string' && (API_KEY_LEVELS as readonly string[]).includes(value);
}

/**
 * A team's stored grants: permission -> the team roles that hold it. An absent
 * key means the registry default. Stored in `teams.permission_overrides`.
 */
export type PermissionOverrides = Partial<Record<Permission, readonly TeamRole[]>>;

/**
 * Permissions no team can re-grant. Owner transfer, team deletion and editing
 * the grants themselves stay with owners, so an admin can never hand themselves
 * more power; the timezone seed is a behaviour, not a grant.
 */
export const LOCKED_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'assign_team_owner',
  'delete_team',
  'manage_team_permissions',
  'seed_team_timezone',
  // Spending the team's money stays with owners and admins.
  'manage_billing',
]);

function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/** Canonical order, owner always included: the shape every override is kept in. */
function normaliseRoles(roles: readonly TeamRole[]): TeamRole[] {
  return TEAM_ROLES.filter(r => r === 'owner' || roles.includes(r));
}

function sameRoles(a: readonly TeamRole[], b: readonly TeamRole[]): boolean {
  return a.length === b.length && a.every(r => b.includes(r));
}

/**
 * The team roles that hold `permission`, given a team's overrides (`null` or
 * `{}` = defaults). Owner always holds; locked permissions ignore overrides.
 */
export function effectiveRoles(permission: Permission, overrides: PermissionOverrides | null): readonly TeamRole[] {
  const stored = overrides?.[permission];
  if (!stored || LOCKED_PERMISSIONS.has(permission)) return PERMISSIONS[permission].defaultRoles;
  return normaliseRoles(stored);
}

/**
 * Read stored overrides defensively: unknown permissions, unknown roles, locked
 * permissions and malformed values are dropped, never trusted.
 */
export function sanitizeOverrides(raw: unknown): PermissionOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PermissionOverrides = {};
  for (const [name, roles] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPermission(name) || LOCKED_PERMISSIONS.has(name) || !Array.isArray(roles)) continue;
    out[name] = roles.filter(isTeamRole);
  }
  return out;
}

/**
 * Validate a full set of overrides an owner submits. Strict, unlike
 * `sanitizeOverrides`: anything unknown or locked is an error, so a typo is
 * reported instead of silently ignored. Entries equal to the default are
 * dropped, so "reset" and "never changed" store the same thing.
 */
export function parseOverridesInput(
  raw: unknown,
): { ok: true; overrides: PermissionOverrides } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'overrides must be an object of permission -> roles' };
  }
  const out: PermissionOverrides = {};
  for (const [name, roles] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPermission(name)) return { ok: false, error: `Unknown permission: ${name}` };
    if (LOCKED_PERMISSIONS.has(name)) return { ok: false, error: `${name} is locked and cannot be changed` };
    if (!Array.isArray(roles)) return { ok: false, error: `${name}: roles must be an array` };
    const bad = roles.find(r => !isTeamRole(r));
    if (bad !== undefined) return { ok: false, error: `${name}: unknown team role ${JSON.stringify(bad)}` };
    const normalised = normaliseRoles(roles as TeamRole[]);
    if (!sameRoles(normalised, PERMISSIONS[name].defaultRoles)) out[name] = normalised;
  }
  return { ok: true, overrides: out };
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
 * Whether a team role holds `permission` in a team with these overrides. Pure,
 * so client components can ask too. `overrides` is required on purpose: pass
 * the team's (getTeamPermissionOverrides) so the answer matches the server;
 * pass `null` only where defaults are genuinely meant (a locked permission, or
 * no team in scope). An unknown or missing role holds nothing.
 */
export function roleHas(
  role: TeamRole | string | null | undefined,
  permission: Permission,
  overrides: PermissionOverrides | null,
): boolean {
  return holds(effectiveRoles(permission, overrides), role);
}

/** Whether an API key of `level` holds `permission`. Unknown levels hold nothing. */
export function keyLevelHas(level: string | null | undefined, permission: Permission): boolean {
  return keyHolds(PERMISSIONS[permission].minKeyLevel, level);
}
