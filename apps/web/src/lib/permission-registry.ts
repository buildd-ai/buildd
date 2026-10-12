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
  /** Team roles that hold this permission, the same in every team. */
  defaultRoles: readonly TeamRole[];
  /** Lowest API-key level that holds it; `null` = session only, no key may. */
  minKeyLevel: ApiKeyLevel | null;
}

export const OWNER_ADMIN = ['owner', 'admin'] as const satisfies readonly TeamRole[];
const OWNER_ONLY = ['owner'] as const satisfies readonly TeamRole[];
const EVERY_ROLE = ['owner', 'admin', 'member'] as const satisfies readonly TeamRole[];

/**
 * Each entry reproduces the rule its call sites apply today — see the
 * inventory in docs/specs/team-permissions.md for file:line per entry. Odd
 * rules are reproduced, not fixed; the spec flags them.
 *
 * Only team-scoped decisions belong here. buildd's own platform machinery
 * (experiments, the raw decision ledger, decision shadows, per-feature
 * inference modes, chat retro) is gated on the platform operator
 * (platform-operator.ts, platform-admin.ts), never on a team role: a team
 * owner is not an operator.
 */
export const PERMISSIONS = {
  // ── Team membership ──────────────────────────────────────────────────────
  manage_team_members: {
    description: 'Add, invite and remove team members (admins cannot remove an owner).',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
  },
  assign_team_owner: {
    description: 'Make someone an owner, demote or remove an owner, or transfer ownership.',
    defaultRoles: OWNER_ONLY,
    minKeyLevel: null,
  },
  assign_team_roles: {
    description: 'Move a member between member and admin (never to or from owner).',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
  },
  // ── Team settings ────────────────────────────────────────────────────────
  manage_team_settings: {
    description: 'Edit team name, slug, provider routing, coding policy, chat budgets and default tier, credential policy, task estimates and timezone.',
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
  view_team_usage: {
    description: "See every member's spend, team insights and the team admin layout of Home.",
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
  },
  manage_billing: {
    description: "Start a paid plan, change seats and open the team's Stripe billing portal.",
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
  },
  manage_team_notifications: {
    description: "Change the team's notification settings (Pushover, notify webhook).",
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
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
  manage_team_credentials: {
    description: 'Write or delete a team-wide or workspace-wide agent credential (any other secret, and workspace Claude/Codex credentials).',
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
  create_workspace: {
    description: 'Create a workspace in the team.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
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
  delegate_schedule_access: {
    description: "Set or clear a schedule's delegation: which other workspaces of the team its tasks may read analytics from or file tasks in.",
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
  approve_specs: {
    description: 'Submit a Living Spec revision for review and approve it (a person only; a workspace can also name delegated approvers).',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: null,
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
  manage_agent_roles: {
    description: 'Create, edit and delete agent roles and their workspace overrides, including operator grants, MCP servers, required env vars and connectors.',
    defaultRoles: OWNER_ADMIN,
    minKeyLevel: 'admin',
  },
  create_personal_roles: {
    description: 'Create agent roles for yourself, edit and delete your own, and share them with the team.',
    defaultRoles: EVERY_ROLE,
    minKeyLevel: 'worker',
  },
} as const satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);
}

export function isApiKeyLevel(value: unknown): value is ApiKeyLevel {
  return typeof value === 'string' && (API_KEY_LEVELS as readonly string[]).includes(value);
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
 * Whether a team role holds `permission`. Pure, so client components can ask
 * too. The mapping is fixed: every team gets the registry defaults. An unknown
 * or missing role holds nothing.
 */
export function roleHas(role: TeamRole | string | null | undefined, permission: Permission): boolean {
  return holds(PERMISSIONS[permission].defaultRoles, role);
}

/** Whether an API key of `level` holds `permission`. Unknown levels hold nothing. */
export function keyLevelHas(level: string | null | undefined, permission: Permission): boolean {
  return keyHolds(PERMISSIONS[permission].minKeyLevel, level);
}

// ── Agent capabilities ────────────────────────────────────────────────────────
//
// The team permissions above say what a HUMAN team role may do. Agent
// capabilities say what a task running under an agent ROLE (a workspaceSkills
// row with isRole) may do on the platform's behalf. Same idiom: a named
// registry, the roles that hold each by default, a set nothing grants
// implicitly, and pure checks. Kept apart from PERMISSIONS on purpose: an
// agent role is not a team role, and neither may ever stand in for the other.
//
// Deployment authority is split in two tiers. `standard` is what a normal
// Platform Operator gets: read deployments, deploy, and USE an approved
// credential server-side without seeing it. `elevated` is changing or reading
// the credential itself; no role holds it by default, and only an explicit
// workspace grant confers it (operator-capability.ts).

export type AgentCapabilityTier = 'standard' | 'elevated';

export interface AgentCapabilityDef {
  description: string;
  tier: AgentCapabilityTier;
}

export const AGENT_CAPABILITIES = {
  'deployments:read': {
    description: 'Read deployment state, history and redacted logs for an allowed target.',
    tier: 'standard',
  },
  'deployments:write': {
    description: 'Run a deploy, secret-put or config update against an allowed provider/project/environment.',
    tier: 'standard',
  },
  'deployment_secrets:use': {
    description: 'Have the server use an approved credential reference for an allowed deploy. The agent never receives the plaintext.',
    tier: 'standard',
  },
  'deployment_secrets:manage': {
    description: 'Create, rotate or delete a deployment credential.',
    tier: 'elevated',
  },
  'secrets:reveal': {
    description: 'Read a stored credential in plaintext.',
    tier: 'elevated',
  },
} as const satisfies Record<string, AgentCapabilityDef>;

export type AgentCapability = keyof typeof AGENT_CAPABILITIES;

export const AGENT_CAPABILITY_NAMES = Object.keys(AGENT_CAPABILITIES) as AgentCapability[];

/** Capabilities no role holds by default and no team default can grant: only an explicit workspace grant. */
export const ELEVATED_AGENT_CAPABILITIES: ReadonlySet<AgentCapability> = new Set(
  AGENT_CAPABILITY_NAMES.filter(c => AGENT_CAPABILITIES[c].tier === 'elevated'),
);

/** The built-in Platform Operator role slug. */
export const OPERATOR_ROLE_SLUG = 'operator';

/**
 * Role slug -> the capabilities it may hold. A role absent here holds none,
 * whatever its row's metadata says, so builder, reviewer and every team's own
 * roles gain nothing from this registry. Listing a capability here is a
 * ceiling, not a grant: the workspace must still enable the role
 * (operator-capability.ts). Elevated capabilities are listed only so an
 * explicit workspace grant can reach them; they are never on by default.
 */
export const ROLE_CAPABILITY_CEILINGS: Readonly<Record<string, readonly AgentCapability[]>> = {
  [OPERATOR_ROLE_SLUG]: AGENT_CAPABILITY_NAMES,
};

/** The capabilities a role holds once enabled, before any narrowing: its ceiling minus the elevated ones. */
export function defaultRoleCapabilities(roleSlug: string | null | undefined): AgentCapability[] {
  const ceiling = roleSlug ? ROLE_CAPABILITY_CEILINGS[roleSlug] ?? [] : [];
  return ceiling.filter(c => !ELEVATED_AGENT_CAPABILITIES.has(c));
}

export function isAgentCapability(value: unknown): value is AgentCapability {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_CAPABILITIES, value);
}

/** Whether `roleSlug` may ever hold `capability` (its ceiling). Unknown roles may hold nothing. */
export function roleMayHold(roleSlug: string | null | undefined, capability: AgentCapability): boolean {
  return !!roleSlug && (ROLE_CAPABILITY_CEILINGS[roleSlug] ?? []).includes(capability);
}
