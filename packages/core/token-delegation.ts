/**
 * Schedule delegation: an explicit, auditable grant that lets the tasks one
 * schedule spawns reach a few other workspaces of the same team.
 *
 * A per-task token (lib/task-token.ts) is confined to its own task's
 * workspace. A scheduled analysis job (a weekly review that lives in one
 * workspace and judges what happened in another) needs a little more: read
 * that workspace's analytics, and file a follow-up there. Making the task
 * token admin, or handing it a runner key, would give it everything. A
 * delegation gives it exactly the listed capabilities on exactly the listed
 * workspaces, and nothing else:
 *
 *  - `analytics:read`: the workspace's read-only analytics (decision ledger,
 *    decision and coordination stats, the gate ledger and failure analytics)
 *    and its name in workspace resolution. No task bodies, secrets, memory,
 *    repo access or config.
 *  - `tasks:create`: file a task there through the normal create path (its
 *    dedupe, gates and ledger all apply). A mission link and dependencies
 *    only when the mission and every dependency belong to that same
 *    workspace; no other mutation.
 *
 * Two places carry a grant, never the task's context (a task's context is
 * written by whoever files it, so a grant there could be forged by any task
 * token):
 *  - a schedule row: set by a team admin, for every task the schedule spawns;
 *  - a task row (`tasks.delegation`): set by a person who reaches each target,
 *    when filing the task or with update_task before it is claimed, or by a
 *    person approving the task's own `tasks:create` capability request. A
 *    continuation or retry of the task copies it.
 * Either way only workspaces of the owner's own team that the granting
 * principal can itself reach, recorded with who granted it and when. It is
 * read on every request, so editing or clearing it takes effect immediately,
 * and it can never exceed the reach of the account that minted the task token.
 */

export const SCHEDULE_DELEGATION_CAPABILITIES = ['analytics:read', 'tasks:create'] as const;
export type ScheduleDelegationCapability = (typeof SCHEDULE_DELEGATION_CAPABILITIES)[number];

/** A schedule names only a few target workspaces; a long list is a sign of a wrong tool. */
export const SCHEDULE_DELEGATION_MAX_GRANTS = 5;

export interface ScheduleDelegationGrant {
  workspaceId: string;
  capabilities: ScheduleDelegationCapability[];
}

export interface ScheduleDelegation {
  grants: ScheduleDelegationGrant[];
  /** Who set this grant: a session user, or an admin API account. */
  grantedByUserId: string | null;
  grantedByAccountId: string | null;
  /** ISO timestamp. */
  grantedAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isScheduleDelegationCapability(value: unknown): value is ScheduleDelegationCapability {
  return typeof value === 'string' && (SCHEDULE_DELEGATION_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Parse the `delegation` body of a schedule write. `null` clears the grant.
 * Returns the grants only; who granted it and when are stamped by the route.
 * Unknown capabilities and malformed ids are refused, never dropped.
 */
export function parseScheduleDelegationInput(
  input: unknown,
  ownWorkspaceId: string,
  owner: 'schedule' | 'task' = 'schedule',
): { ok: true; grants: ScheduleDelegationGrant[] | null } | { ok: false; error: string } {
  if (input === null) return { ok: true, grants: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'delegation must be an object { grants: [{ workspaceId, capabilities }] } or null' };
  }
  const extra = Object.keys(input).filter(k => k !== 'grants');
  if (extra.length) return { ok: false, error: `delegation has unknown field(s): ${extra.join(', ')}` };
  const raw = (input as { grants?: unknown }).grants;
  if (!Array.isArray(raw)) return { ok: false, error: 'delegation.grants must be an array' };
  if (raw.length === 0) return { ok: true, grants: null };
  if (raw.length > SCHEDULE_DELEGATION_MAX_GRANTS) {
    return { ok: false, error: `delegation.grants may name at most ${SCHEDULE_DELEGATION_MAX_GRANTS} workspaces` };
  }
  const seen = new Set<string>();
  const grants: ScheduleDelegationGrant[] = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return { ok: false, error: 'each grant must be { workspaceId, capabilities }' };
    const { workspaceId, capabilities, ...rest } = g as { workspaceId?: unknown; capabilities?: unknown };
    if (Object.keys(rest).length) return { ok: false, error: `grant has unknown field(s): ${Object.keys(rest).join(', ')}` };
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
      return { ok: false, error: 'grant.workspaceId must be a workspace UUID' };
    }
    if (workspaceId === ownWorkspaceId) {
      return {
        ok: false,
        error: owner === 'schedule'
          ? "a grant may not name the schedule's own workspace: its tasks already reach it"
          : "a grant may not name the task's own workspace: its token already reaches it",
      };
    }
    if (seen.has(workspaceId)) return { ok: false, error: `workspace ${workspaceId} is granted twice` };
    seen.add(workspaceId);
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      return { ok: false, error: `grant.capabilities must be a non-empty array of: ${SCHEDULE_DELEGATION_CAPABILITIES.join(', ')}` };
    }
    const bad = capabilities.filter(c => !isScheduleDelegationCapability(c));
    if (bad.length) {
      return { ok: false, error: `unknown capability ${bad.map(String).join(', ')}; allowed: ${SCHEDULE_DELEGATION_CAPABILITIES.join(', ')}` };
    }
    grants.push({ workspaceId, capabilities: [...new Set(capabilities as ScheduleDelegationCapability[])] });
  }
  return { ok: true, grants };
}

/**
 * Read a stored delegation defensively: anything malformed grants nothing.
 * The route validates on write; this guards a hand-edited or legacy row.
 */
export function readScheduleDelegation(value: unknown): ScheduleDelegationGrant[] {
  if (!value || typeof value !== 'object') return [];
  const grants = (value as { grants?: unknown }).grants;
  if (!Array.isArray(grants)) return [];
  const out: ScheduleDelegationGrant[] = [];
  for (const g of grants.slice(0, SCHEDULE_DELEGATION_MAX_GRANTS)) {
    if (!g || typeof g !== 'object') continue;
    const { workspaceId, capabilities } = g as { workspaceId?: unknown; capabilities?: unknown };
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId) || !Array.isArray(capabilities)) continue;
    const caps = capabilities.filter(isScheduleDelegationCapability);
    if (caps.length) out.push({ workspaceId, capabilities: caps });
  }
  return out;
}

/** Does this set of grants give `capability` on `workspaceId`? */
export function delegationAllows(
  grants: readonly ScheduleDelegationGrant[] | null | undefined,
  workspaceId: string | null | undefined,
  capability: ScheduleDelegationCapability,
): boolean {
  if (!grants || !workspaceId) return false;
  return grants.some(g => g.workspaceId === workspaceId && g.capabilities.includes(capability));
}

// ── Task delegation ──────────────────────────────────────────────────────────

/** A task's own grant: a schedule delegation, plus where it came from. */
export interface TaskDelegation extends ScheduleDelegation {
  /** Set when copied from the task this one continues or retries. */
  inheritedFromTaskId?: string | null;
  /** The approved `tasks:create` capability requests that added grants. */
  capabilityGrantIds?: string[];
}

/**
 * Union two grant lists: one entry per workspace, capabilities merged. Never
 * longer than SCHEDULE_DELEGATION_MAX_GRANTS: a grant that would overflow is
 * reported as `overflow` instead of dropped silently.
 */
export function mergeDelegationGrants(
  base: readonly ScheduleDelegationGrant[],
  add: readonly ScheduleDelegationGrant[],
): { grants: ScheduleDelegationGrant[]; overflow: string[] } {
  const out = base.map(g => ({ workspaceId: g.workspaceId, capabilities: [...g.capabilities] }));
  const overflow: string[] = [];
  for (const g of add) {
    const hit = out.find(o => o.workspaceId === g.workspaceId);
    if (hit) {
      hit.capabilities = [...new Set([...hit.capabilities, ...g.capabilities])];
    } else if (out.length >= SCHEDULE_DELEGATION_MAX_GRANTS) {
      overflow.push(g.workspaceId);
    } else {
      out.push({ workspaceId: g.workspaceId, capabilities: [...new Set(g.capabilities)] });
    }
  }
  return { grants: out, overflow };
}

/** Drop one capability on one workspace; a grant left with none is removed. */
export function removeDelegationCapability(
  grants: readonly ScheduleDelegationGrant[],
  workspaceId: string,
  capability: ScheduleDelegationCapability,
): ScheduleDelegationGrant[] {
  return grants
    .map(g => g.workspaceId === workspaceId ? { ...g, capabilities: g.capabilities.filter(c => c !== capability) } : g)
    .filter(g => g.capabilities.length > 0);
}

/**
 * The delegation a continuation or retry of `parent` carries: the same grants
 * and the same audit (who granted, when), marked with where it came from. Null
 * when the parent has none. Only the server's own continuation and retry paths
 * call this; a caller filing a child task never inherits anything.
 */
export function inheritTaskDelegation(parent: { id: string; delegation?: unknown } | null | undefined): TaskDelegation | null {
  if (!parent?.delegation) return null;
  const grants = readScheduleDelegation(parent.delegation);
  if (!grants.length) return null;
  const d = parent.delegation as Partial<TaskDelegation>;
  return {
    grants,
    grantedByUserId: typeof d.grantedByUserId === 'string' ? d.grantedByUserId : null,
    grantedByAccountId: typeof d.grantedByAccountId === 'string' ? d.grantedByAccountId : null,
    grantedAt: typeof d.grantedAt === 'string' ? d.grantedAt : new Date().toISOString(),
    inheritedFromTaskId: parent.id,
    ...(Array.isArray(d.capabilityGrantIds) ? { capabilityGrantIds: d.capabilityGrantIds.filter(x => typeof x === 'string') } : {}),
  };
}

// ── Declared filing targets ──────────────────────────────────────────────────
//
// A task may declare, when it is filed, the other workspaces it will file
// tasks in (`filingTargets`). A declaration is a need, never a grant: it is
// what the claim pre-flight checks the token against, so a task that will
// need tasks:create somewhere is held before any agent turn instead of
// discovering the wall mid-run. Being a need, it is harmless where a caller
// writes it (context): forging one can only hold your own task.

export const FILING_TARGETS_CONTEXT_KEY = 'filingTargets';

export function parseFilingTargets(input: unknown): { ok: true; targets: string[] } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, targets: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'filingTargets must be an array of workspace UUIDs' };
  if (input.length > SCHEDULE_DELEGATION_MAX_GRANTS) {
    return { ok: false, error: `filingTargets may name at most ${SCHEDULE_DELEGATION_MAX_GRANTS} workspaces` };
  }
  for (const t of input) {
    if (typeof t !== 'string' || !UUID_RE.test(t)) return { ok: false, error: 'filingTargets must be workspace UUIDs' };
  }
  return { ok: true, targets: [...new Set(input as string[])] };
}

/** Read declared filing targets defensively from a task's context. */
export function readFilingTargets(context: unknown): string[] {
  if (!context || typeof context !== 'object') return [];
  const raw = (context as Record<string, unknown>)[FILING_TARGETS_CONTEXT_KEY];
  const parsed = parseFilingTargets(raw);
  return parsed.ok ? parsed.targets : [];
}

// ── Claim pre-flight ─────────────────────────────────────────────────────────

/**
 * Why a task's cross-workspace needs are not covered by the token its worker
 * would get:
 *  - `not_granted`: it declares a filing target no delegation grants
 *    tasks:create on;
 *  - `cross_team`: a grant names a workspace outside the task's team (a token
 *    never carries that, whatever the row says);
 *  - `out_of_token_reach`: the claiming account (which mints the token) does
 *    not itself reach the target, so the delegated call would be refused.
 */
export type DelegationGapReason = 'not_granted' | 'cross_team' | 'out_of_token_reach';

export interface DelegationGap {
  workspaceId: string;
  capability: ScheduleDelegationCapability;
  reason: DelegationGapReason;
}

/**
 * Compare what a task needs against what its token will carry. Pure: the
 * caller supplies each target's team and whether the claiming account reaches
 * it for a capability. Empty = the run can start.
 */
export function findDelegationGaps(input: {
  /** Every grant the token would load: the task's own and its schedule's. */
  grants: readonly ScheduleDelegationGrant[];
  filingTargets: readonly string[];
  ownTeamId: string | null;
  teamOf: (workspaceId: string) => string | null | undefined;
  accountReaches: (workspaceId: string, capability: ScheduleDelegationCapability) => boolean;
}): DelegationGap[] {
  const gaps: DelegationGap[] = [];
  for (const target of input.filingTargets) {
    if (!delegationAllows(input.grants, target, 'tasks:create')) {
      gaps.push({ workspaceId: target, capability: 'tasks:create', reason: 'not_granted' });
    }
  }
  for (const g of input.grants) {
    for (const capability of g.capabilities) {
      if (!input.ownTeamId || input.teamOf(g.workspaceId) !== input.ownTeamId) {
        gaps.push({ workspaceId: g.workspaceId, capability, reason: 'cross_team' });
      } else if (!input.accountReaches(g.workspaceId, capability)) {
        gaps.push({ workspaceId: g.workspaceId, capability, reason: 'out_of_token_reach' });
      }
    }
  }
  return gaps;
}

const GAP_TEXT: Record<DelegationGapReason, string> = {
  not_granted: 'it declares it will file tasks there, but no delegation grants tasks:create on it',
  cross_team: 'its delegation names a workspace outside its team, which a token never carries',
  out_of_token_reach: 'the runner account that would mint its token does not itself reach that workspace',
};

/** One plain sentence per gap, for the claim refusal and the gate ledger. */
export function describeDelegationGaps(gaps: readonly DelegationGap[]): string {
  return gaps
    .map(g => `${g.capability} on workspace ${g.workspaceId}: ${GAP_TEXT[g.reason]}`)
    .join('; ');
}

// ── Explicit read outcomes ───────────────────────────────────────────────────
//
// A review that could not reach its evidence must never read as one that found
// nothing. Every analytics read a reviewer makes resolves to exactly one of
// these, and only OK and NO_DATA are evidence about the data at all.

export type AnalyticsReadStatus = 'OK' | 'NO_DATA' | 'FORBIDDEN' | 'UNAUTHORIZED' | 'TOOL_UNAVAILABLE';

/** OK or NO_DATA: the read reached the data. Anything else says nothing about it. */
export function isEvidenceStatus(status: AnalyticsReadStatus): boolean {
  return status === 'OK' || status === 'NO_DATA';
}

/**
 * Classify a failed read from its error text (`API error: <status> - <body>`,
 * as the MCP api() wrapper throws, or the workspace-resolution refusal).
 *  - 401: no valid principal at all (expired, revoked or wrong token);
 *  - 403, and the deliberate "not found" a scoped route answers for a
 *    workspace outside the caller's reach: FORBIDDEN;
 *  - anything else (5xx, network, timeout, an unknown shape): TOOL_UNAVAILABLE.
 */
export function classifyAnalyticsReadFailure(error: unknown): Exclude<AnalyticsReadStatus, 'OK' | 'NO_DATA'> {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  const status = /API error:\s*(\d{3})/.exec(msg)?.[1];
  if (status === '401') return 'UNAUTHORIZED';
  if (status === '403') return 'FORBIDDEN';
  if (status === '404' && /workspace/i.test(msg)) return 'FORBIDDEN';
  if (/Could not resolve workspace/i.test(msg)) return 'FORBIDDEN';
  return 'TOOL_UNAVAILABLE';
}

const STATUS_MEANING: Record<Exclude<AnalyticsReadStatus, 'OK' | 'NO_DATA'>, string> = {
  FORBIDDEN: 'the caller is authenticated but not allowed to read this workspace (for a scheduled task: the schedule has no delegation granting analytics:read on it)',
  UNAUTHORIZED: 'the token was not accepted at all (expired, revoked, or its minting key changed)',
  TOOL_UNAVAILABLE: 'the read failed for a reason unrelated to access (server error, timeout, or the store was unreachable)',
};

/**
 * The body a reviewer gets back when a read fails: a status first, and a
 * plain instruction that the result is not evidence of zero rows.
 */
export function analyticsReadFailure(error: unknown, subject: string) {
  const status = classifyAnalyticsReadFailure(error);
  return {
    status,
    evidence: false,
    subject,
    meaning: STATUS_MEANING[status],
    instruction: 'This read did not reach the data. Report it as a blind spot; never as "no issues" or "insufficient sample".',
    error: (error instanceof Error ? error.message : String(error ?? '')).slice(0, 300),
  };
}

/** The same failure as one plain line a model reads first: status, meaning, instruction, then the raw error. */
export function formatAnalyticsReadFailure(error: unknown, subject: string): string {
  const f = analyticsReadFailure(error, subject);
  return `${f.status}: ${subject} was not read: ${f.meaning}. ${f.instruction}\n${f.error}`;
}
