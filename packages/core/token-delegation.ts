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
 *    dedupe, gates and ledger all apply). No mission link, no dependencies,
 *    and no other mutation.
 *
 * The grant lives on the schedule row, never on the task: a task's context is
 * written by whoever files it, so a grant there could be forged by any task
 * token. Only a team admin may set it, and only for workspaces of the
 * schedule's own team that the granting principal can itself reach; it
 * records who granted it and when. It is read on every request, so editing or
 * clearing it takes effect immediately, and it can never exceed the reach of
 * the account that minted the task token.
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
      return { ok: false, error: "a grant may not name the schedule's own workspace: its tasks already reach it" };
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
