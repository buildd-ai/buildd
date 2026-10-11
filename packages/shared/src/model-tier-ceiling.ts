// ============================================================================
// MODEL TIER CEILINGS — enforceable maximum tier per team/workspace/member
// ============================================================================
//
// A ceiling is the most expensive model tier a run may use. It is not the
// chat composer's "new chats start at" default (teams.chatDefaultTier), which
// only seeds a new conversation, and it is not a dollar budget: a daily $ cap
// limits how much is spent, a ceiling limits which class of model is allowed
// to spend it. Both apply; neither implies the other.
//
// Layers, all optional, all "at most" — the effective maximum is the LOWEST
// tier any applicable layer names (most restrictive wins):
//
//   team           teams.model_tier_ceilings.team            admin-written
//   workspace      teams.model_tier_ceilings.workspaces[id]  admin-written
//   member_admin   team_members.model_tier_ceilings.admin     admin-written, the member cannot lift it
//   member_self    team_members.model_tier_ceilings.self      the member's own, only lowers
//
// Each layer may cap `all` surfaces and/or one surface (`agent` = coding
// agents / task runs, `chat` = chat turns and server inference). A surface's
// cap is the lower of `all` and its own key.
//
// The member layers only apply when the server knows which person a run is
// for. Unidentified automation (a bare API key, a schedule with no creator)
// gets the team and workspace layers only: a personal cap is never reported as
// enforced when there is no person to enforce it for.
//
// No layer set → no ceiling → routing is exactly what it was before ceilings.
//
// Isomorphic (no DB, no SDK) so the settings UI, the task-creation route, the
// claim route and the chat turn all evaluate one rule. The DB half is
// packages/core/model-tier-ceiling-store.ts; the spend-band check on concrete
// model ids is packages/core/model-tier-ceiling.ts. Contract:
// docs/specs/model-tier-ceilings.md.

export type CeilingTier = 'premium-plus' | 'premium' | 'standard' | 'budget';

/** Cheapest to most expensive. A ceiling allows its own tier and everything left of it. */
export const CEILING_TIER_ORDER: readonly CeilingTier[] = ['budget', 'standard', 'premium', 'premium-plus'];

export type CeilingSurface = 'agent' | 'chat';
export const CEILING_SURFACES: readonly CeilingSurface[] = ['agent', 'chat'];

export type CeilingSource = 'team' | 'workspace' | 'member_admin' | 'member_self';

/** A layer's caps. `all` covers both surfaces; a surface key narrows it further. */
export interface SurfaceCeilings {
  all?: CeilingTier;
  agent?: CeilingTier;
  chat?: CeilingTier;
}

export interface CeilingAuditEntry {
  at: string;
  /** users.id of the person who made the change. */
  by: string;
  /** Which layer changed: 'team', 'workspace:<id>', 'member_admin', 'member_self', 'over_cap_auto'. */
  layer: string;
  before: SurfaceCeilings | string | null;
  after: SurfaceCeilings | string | null;
}

/** `teams.model_tier_ceilings`. */
export interface TeamTierCeilingPolicy {
  team?: SurfaceCeilings;
  /** Keyed by workspaces.id; only workspaces of this team are accepted on write. */
  workspaces?: Record<string, SurfaceCeilings>;
  /**
   * What happens when an AUTOMATIC tier choice (the router's kind×complexity
   * matrix, a routing experiment, a pool arm) lands above the ceiling.
   * `downgrade` (default): serve the ceiling tier instead and record why.
   * `deny`: hold the run with policy_denied, the same as an explicit pin.
   * An explicit request (task tier, model pin, role model, chat pin) is never
   * downgraded: it is always denied.
   */
  overCapAuto?: 'downgrade' | 'deny';
  /**
   * Set (before the member row) whenever any member of the team has a member
   * layer. Lets a claim skip resolving the requester — a walk up the task's
   * parents — for the many teams with no personal caps. Never cleared by a
   * member write; a stale `true` only costs that lookup.
   */
  membersCapped?: boolean;
  /** Newest last, at most CEILING_AUDIT_LIMIT entries. */
  audit?: CeilingAuditEntry[];
}

/** `team_members.model_tier_ceilings`. */
export interface MemberTierCeilings {
  /** Set by a team admin; the member cannot raise or clear it. */
  admin?: SurfaceCeilings;
  /** Set by the member; can only make their own runs cheaper. */
  self?: SurfaceCeilings;
  audit?: CeilingAuditEntry[];
}

export const CEILING_AUDIT_LIMIT = 20;

export function isCeilingTier(v: unknown): v is CeilingTier {
  return typeof v === 'string' && (CEILING_TIER_ORDER as readonly string[]).includes(v);
}

export function isCeilingSurface(v: unknown): v is CeilingSurface {
  return v === 'agent' || v === 'chat';
}

export function tierRank(t: CeilingTier): number {
  return CEILING_TIER_ORDER.indexOf(t);
}

/** True when `tier` is at or below `max`. A null max allows everything. */
export function tierWithin(tier: CeilingTier, max: CeilingTier | null | undefined): boolean {
  return !max || tierRank(tier) <= tierRank(max);
}

/** The cheaper of two tiers; null/undefined is "no cap". */
export function lowerTier(a: CeilingTier | null | undefined, b: CeilingTier | null | undefined): CeilingTier | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return tierRank(a) <= tierRank(b) ? a : b;
}

/** A layer's cap on one surface: the lower of `all` and the surface's own key. */
export function capForSurface(caps: SurfaceCeilings | null | undefined, surface: CeilingSurface): CeilingTier | null {
  if (!caps) return null;
  return lowerTier(isCeilingTier(caps.all) ? caps.all : null, isCeilingTier(caps[surface]) ? caps[surface] : null);
}

/**
 * Validate a caps object from a request body. Unknown keys and unknown tiers
 * are errors, not silently dropped: a typo in a ceiling must not save as "no
 * ceiling". `null` for a key clears it. Returns the cleaned object (empty
 * object = no caps in this layer).
 */
export function parseSurfaceCeilings(raw: unknown): { ok: true; value: SurfaceCeilings } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'ceilings must be an object like { all?, agent?, chat? }' };
  const out: SurfaceCeilings = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k !== 'all' && k !== 'agent' && k !== 'chat') return { ok: false, error: `unknown ceiling key "${k}" (use all, agent or chat)` };
    if (v === null || v === undefined) continue;
    if (!isCeilingTier(v)) return { ok: false, error: `"${k}" must be one of ${CEILING_TIER_ORDER.join(', ')} or null` };
    out[k] = v;
  }
  return { ok: true, value: out };
}

export function isEmptyCeilings(c: SurfaceCeilings | null | undefined): boolean {
  return !c || (!c.all && !c.agent && !c.chat);
}

export interface CeilingLayer {
  source: CeilingSource;
  /** The workspace id for `workspace`, the user id for member layers. */
  scope?: string;
  tier: CeilingTier;
}

export interface TierCeiling {
  surface: CeilingSurface;
  /** The effective maximum, or null when no applicable layer caps this surface. */
  max: CeilingTier | null;
  /** The layer that sets `max` (the first, in team→workspace→admin→self order, at that tier). */
  binding: CeilingLayer | null;
  /** Every applicable layer that caps this surface. */
  layers: CeilingLayer[];
  /** Whether a person was identified, i.e. whether the member layers were considered. */
  identified: boolean;
  overCapAuto: 'downgrade' | 'deny';
}

export interface CeilingInputs {
  team?: TeamTierCeilingPolicy | null;
  workspaceId?: string | null;
  /** The person the run is for; null for unidentified automation. */
  userId?: string | null;
  /** That person's row in this team. Ignored when userId is null. */
  member?: MemberTierCeilings | null;
}

/** The effective ceiling for one surface: most restrictive applicable layer wins. */
export function resolveTierCeiling(inputs: CeilingInputs, surface: CeilingSurface): TierCeiling {
  const layers: CeilingLayer[] = [];
  const push = (source: CeilingSource, caps: SurfaceCeilings | null | undefined, scope?: string) => {
    const tier = capForSurface(caps, surface);
    if (tier) layers.push({ source, tier, ...(scope ? { scope } : {}) });
  };
  const policy = inputs.team ?? null;
  push('team', policy?.team);
  if (inputs.workspaceId) push('workspace', policy?.workspaces?.[inputs.workspaceId], inputs.workspaceId);
  const identified = !!inputs.userId;
  if (identified) {
    push('member_admin', inputs.member?.admin, inputs.userId!);
    push('member_self', inputs.member?.self, inputs.userId!);
  }
  let binding: CeilingLayer | null = null;
  for (const l of layers) if (!binding || tierRank(l.tier) < tierRank(binding.tier)) binding = l;
  return {
    surface,
    max: binding?.tier ?? null,
    binding,
    layers,
    identified,
    overCapAuto: policy?.overCapAuto === 'deny' ? 'deny' : 'downgrade',
  };
}

/** Where a requested tier came from. Only `auto` may ever be downgraded. */
export type TierRequestOrigin =
  | 'task_tier'
  | 'model_pin'
  | 'role_model'
  | 'chat_pin'
  | 'request_tier'
  | 'auto';

export interface PolicyDeniedError {
  error: 'policy_denied';
  code: 'tier_above_ceiling' | 'model_above_ceiling';
  message: string;
  surface: CeilingSurface;
  requested: { tier: CeilingTier; origin: TierRequestOrigin; model?: string };
  maxTier: CeilingTier;
  binding: CeilingLayer;
  /** What the caller can do about it, in one sentence. */
  remedy: string;
}

const SOURCE_NAME: Record<CeilingSource, string> = {
  team: "the team's maximum",
  workspace: "this workspace's maximum",
  member_admin: 'the maximum a team admin set for you',
  member_self: 'your personal maximum',
};

const SURFACE_NAME: Record<CeilingSurface, string> = { agent: 'coding agents', chat: 'chat' };

/** One sentence naming the effective ceiling and who set it, for settings and error copy. */
export function explainTierCeiling(c: TierCeiling): string {
  if (!c.max || !c.binding) {
    return c.identified
      ? `No tier maximum applies to ${SURFACE_NAME[c.surface]}.`
      : `No team or workspace tier maximum applies to ${SURFACE_NAME[c.surface]}; personal maximums need a known person and are not applied here.`;
  }
  const tail = c.identified ? '' : ' Personal maximums need a known person and are not applied to this request.';
  return `${SURFACE_NAME[c.surface][0].toUpperCase()}${SURFACE_NAME[c.surface].slice(1)} can use up to ${c.max}, set by ${SOURCE_NAME[c.binding.source]}.${tail}`;
}

export function policyDenied(args: {
  ceiling: TierCeiling;
  tier: CeilingTier;
  origin: TierRequestOrigin;
  model?: string;
  code?: PolicyDeniedError['code'];
}): PolicyDeniedError {
  const { ceiling } = args;
  const max = ceiling.max!;
  const binding = ceiling.binding!;
  const what = args.model ? `model ${args.model} (${args.tier} spend band)` : `tier ${args.tier}`;
  const remedy = binding.source === 'member_self'
    ? `Choose ${max} or lower, or raise your personal maximum in Settings > Model tiers.`
    : `Choose ${max} or lower, or ask a team admin to raise ${SOURCE_NAME[binding.source].replace('your', 'the')}.`;
  return {
    error: 'policy_denied',
    code: args.code ?? (args.model ? 'model_above_ceiling' : 'tier_above_ceiling'),
    message: `${what} is above ${SOURCE_NAME[binding.source]} for ${SURFACE_NAME[ceiling.surface]} (${max}).`,
    surface: ceiling.surface,
    requested: { tier: args.tier, origin: args.origin, ...(args.model ? { model: args.model } : {}) },
    maxTier: max,
    binding,
    remedy,
  };
}

export type CeilingVerdict =
  | { ok: true; tier: CeilingTier; downgradedFrom?: CeilingTier }
  | { ok: false; denied: PolicyDeniedError };

/**
 * Hold `tier` against the ceiling. Explicit requests are allowed or denied,
 * never changed. An `auto` request above the ceiling is downgraded to it
 * unless the team chose `overCapAuto: 'deny'`. Nothing is ever raised.
 */
export function enforceTierCeiling(args: {
  ceiling: TierCeiling;
  tier: CeilingTier;
  origin: TierRequestOrigin;
  model?: string;
}): CeilingVerdict {
  const { ceiling, tier } = args;
  if (tierWithin(tier, ceiling.max)) return { ok: true, tier };
  if (args.origin === 'auto' && ceiling.overCapAuto === 'downgrade' && !args.model) {
    return { ok: true, tier: ceiling.max!, downgradedFrom: tier };
  }
  return { ok: false, denied: policyDenied(args) };
}

/** Append an audit entry, keeping the newest CEILING_AUDIT_LIMIT. */
export function appendCeilingAudit(list: CeilingAuditEntry[] | undefined, entry: CeilingAuditEntry): CeilingAuditEntry[] {
  return [...(list ?? []), entry].slice(-CEILING_AUDIT_LIMIT);
}
