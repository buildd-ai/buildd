/**
 * A pending access request holds the run (rules; the db half is
 * capability-hold-store.ts).
 *
 * `request_capability` used to answer `pending_approval` with "keep working and
 * ask again", and nothing stopped the run: the agent finished, the request
 * closed as "the task ended", and the person never got to decide. Now:
 *
 *  - While this worker has a request a person has not answered, `complete_task`
 *    is refused (400 `capability_request_pending`). The refusal names the three
 *    ways out: wait (keep doing independent work, ask again), withdraw the
 *    request (`withdraw_capability_request`), or complete with
 *    `structuredOutput.blockedByCapability { requestId }`.
 *  - A request older than the team's wait window (default 4 h) is expired by
 *    the server (`expired`, decidedBy `system`, reason `wait_window_elapsed`),
 *    never closed as "task ended", and the worker is told so it can complete
 *    with `blockedByCapability`.
 *  - A completion whose worker has a request that was never granted (denied,
 *    expired unanswered, withdrawn, revoked before a grant, or granted but
 *    unusable) must name it in `blockedByCapability` or
 *    `proceededWithout { requestId, whatIsMissing }`; the summary then leads
 *    with it. A request that was granted and usable needs nothing.
 *  - A worker with no request completes as before.
 *
 * Pure: no db, no clock. Spec: docs/specs/capability-requests.md → Holding the run.
 */
import type { BlockedByCapability, ProceededWithout } from '@buildd/shared';

/** The team's wait window before an unanswered request expires. */
export const DEFAULT_ACCESS_WAIT_WINDOW_SECONDS = 4 * 60 * 60;
export const MIN_ACCESS_WAIT_WINDOW_SECONDS = 5 * 60;
export const MAX_ACCESS_WAIT_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/** The team's setting, clamped; null or an invalid value is the default. */
export function waitWindowMs(teamSetting: number | null | undefined): number {
  const s = typeof teamSetting === 'number' && Number.isFinite(teamSetting) ? Math.round(teamSetting) : DEFAULT_ACCESS_WAIT_WINDOW_SECONDS;
  return Math.min(MAX_ACCESS_WAIT_WINDOW_SECONDS, Math.max(MIN_ACCESS_WAIT_WINDOW_SECONDS, s)) * 1000;
}

/** How a request the server closed without a grant ended (`decisionReason` on an `expired` row). */
export const CLOSE_REASONS = {
  /** Nobody answered within the team's wait window. */
  waitWindowElapsed: 'wait_window_elapsed',
  /** The agent withdrew it (`withdraw_capability_request`). */
  withdrawn: 'withdrawn',
  /** The agent completed with `blockedByCapability` naming it while it was still pending. */
  agentStoppedWaiting: 'agent_stopped_waiting',
} as const;

/** The grant row fields the hold reads. */
export interface HeldRequestRow {
  id: string;
  capability: string;
  provider: string;
  risk: string;
  tool: string | null;
  resource: string | null;
  status: 'pending' | 'granted' | 'denied' | 'revoked' | 'expired';
  decidedBy: 'policy' | 'human' | 'system' | 'agent' | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  requestedAt: Date;
  expiresAt: Date | null;
}

/**
 * Where a request stands for the completion:
 *   pending     waiting on a person, inside the wait window: holds the run
 *   overdue     pending past the window: the server expires it now
 *   held        granted and usable (live, or lapsed after a grant): nothing to declare
 *   ungranted   never granted, or granted but unusable: must be declared
 */
export type RequestStanding = 'pending' | 'overdue' | 'held' | 'ungranted';

/** Was this row ever a usable grant? Denied never; expired/revoked only if a person or policy granted it first. */
export function wasEverGranted(r: Pick<HeldRequestRow, 'status' | 'decidedBy' | 'decidedAt' | 'decisionReason'>): boolean {
  if (r.status === 'granted') return true;
  if (r.status === 'denied' || r.status === 'pending') return false;
  // expired or revoked: a lease that lapsed or was taken back after a grant was
  // decided by policy or a person; a close without a grant is system's or the agent's.
  return (r.decidedBy === 'policy' || r.decidedBy === 'human') && r.decidedAt != null
    && !Object.values(CLOSE_REASONS).includes(r.decisionReason as never)
    && r.decisionReason !== 'task_terminal' && r.decisionReason !== 'worker_not_live' && r.decisionReason !== 'role_changed';
}

export function requestStanding(r: HeldRequestRow, ctx: { now: Date; windowMs: number; unusable: (r: HeldRequestRow) => string | null }): RequestStanding {
  if (r.status === 'pending') return r.requestedAt.getTime() + ctx.windowMs <= ctx.now.getTime() ? 'overdue' : 'pending';
  if (wasEverGranted(r)) return ctx.unusable(r) ? 'ungranted' : 'held';
  return 'ungranted';
}

// ── structuredOutput fields ──────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Parsed<T> = { ok: true; value: T[] } | { ok: false; error: string };

function parseDeclarations<T extends { requestId: string; whatIsMissing?: string }>(
  structuredOutput: unknown, field: 'blockedByCapability' | 'proceededWithout', requireWhat: boolean,
): Parsed<T> | null {
  if (!structuredOutput || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) return null;
  const raw = (structuredOutput as Record<string, unknown>)[field];
  if (raw === undefined || raw === null) return null;
  const shape = `structuredOutput.${field} is { requestId${requireWhat ? ', whatIsMissing' : ', whatIsMissing?'} } (or a list of them)`;
  const list = Array.isArray(raw) ? raw : [raw];
  const out: T[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: shape };
    const b = item as Record<string, unknown>;
    if (typeof b.requestId !== 'string' || !UUID_RE.test(b.requestId)) return { ok: false, error: `${shape}: requestId is the request id request_capability returned (grant.id)` };
    const what = typeof b.whatIsMissing === 'string' ? b.whatIsMissing.trim().slice(0, 1000) : '';
    if (requireWhat && !what) return { ok: false, error: `${shape}: whatIsMissing says what the result lacks, in a sentence` };
    out.push({ requestId: b.requestId.toLowerCase(), ...(what ? { whatIsMissing: what } : {}) } as T);
  }
  if (out.length === 0) return { ok: false, error: shape };
  return { ok: true, value: out };
}

/** null = absent. */
export function parseBlockedByCapability(structuredOutput: unknown): Parsed<BlockedByCapability> | null {
  return parseDeclarations<BlockedByCapability>(structuredOutput, 'blockedByCapability', false);
}

/** null = absent. */
export function parseProceededWithout(structuredOutput: unknown): Parsed<ProceededWithout> | null {
  return parseDeclarations<ProceededWithout>(structuredOutput, 'proceededWithout', true);
}

// ── the verdict ──────────────────────────────────────────────────────────────

export type HoldRefusalCode =
  | 'invalid_capability_outcome'
  | 'capability_request_pending'
  | 'capability_request_unknown'
  | 'capability_held'
  | 'capability_outcome_unreported';

export interface HoldPass {
  kind: 'pass';
  /** Pending rows past the wait window: expire them (`wait_window_elapsed`). */
  expire: string[];
  /** Pending rows the agent named in blockedByCapability: close them (`agent_stopped_waiting`). */
  stopWaiting: string[];
  /** The declarations as recorded, with the request's outcome filled in. */
  blockedByCapability: BlockedByCapability[] | null;
  proceededWithout: ProceededWithout[] | null;
  /** The line the task summary leads with, or null when nothing was declared. */
  summaryLead: string | null;
}

export interface HoldRefusal {
  kind: 'refuse';
  code: HoldRefusalCode;
  error: string;
  hint: string;
  /** For `capability_request_pending`: the three ways out, for the agent. */
  options?: string[];
  requestIds?: string[];
}

export type HoldVerdict = HoldPass | HoldRefusal;

export interface HoldInput {
  rows: readonly HeldRequestRow[];
  structuredOutput: unknown;
  now: Date;
  windowMs: number;
  /** A granted row that cannot be spent: the reason code (e.g. `query_role_unconfigured`), else null. */
  unusable: (r: HeldRequestRow) => string | null;
  /** The ask in plain words ("Read Neon"), for the refusal and the summary. */
  ask: (r: HeldRequestRow) => string;
}

export const THREE_WAYS_OUT = [
  'wait: keep doing work that does not need it and call request_capability again with the same ask (it returns the same request and its status); a decision also reaches you as a message',
  'withdraw: call withdraw_capability_request { requestId } if you no longer need it, then complete with structuredOutput.proceededWithout { requestId, whatIsMissing }',
  'give up on it: complete with structuredOutput.blockedByCapability { requestId, whatIsMissing }; the request closes and the result says what is missing',
] as const;

/** Why a never-granted request ended, as the outcome word on the declaration. */
export function requestOutcome(r: HeldRequestRow, unusable: string | null): { outcome: string; reason: string | null } {
  if (unusable) return { outcome: unusable, reason: null };
  if (r.status === 'denied') return { outcome: 'denied', reason: r.decisionReason };
  if (r.status === 'revoked') return { outcome: 'revoked', reason: r.decisionReason };
  if (r.status === 'expired') {
    if (r.decisionReason === CLOSE_REASONS.withdrawn) return { outcome: 'withdrawn', reason: null };
    if (r.decisionReason === CLOSE_REASONS.agentStoppedWaiting) return { outcome: 'abandoned', reason: null };
    return { outcome: 'expired', reason: r.decisionReason };
  }
  // pending (named by the agent before it was decided): it is being closed now.
  return { outcome: 'abandoned', reason: null };
}

const OUTCOME_WORDS: Record<string, string> = {
  denied: 'refused by a person',
  revoked: 'revoked',
  expired: 'not answered within the wait window',
  withdrawn: 'withdrawn',
  abandoned: 'not answered before the run finished',
  query_role_unconfigured: 'granted, but no read-only query role is configured on this deployment',
};

export function outcomeWords(outcome: string): string {
  return OUTCOME_WORDS[outcome] ?? outcome.replace(/_/g, ' ');
}

/**
 * The one decision: hold, refuse for a malformed or missing declaration, or
 * pass with the side effects the store applies.
 */
export function completionHoldVerdict(input: HoldInput): HoldVerdict {
  const { rows, now, windowMs, unusable, ask } = input;
  if (rows.length === 0 && !hasDeclaration(input.structuredOutput)) {
    return { kind: 'pass', expire: [], stopWaiting: [], blockedByCapability: null, proceededWithout: null, summaryLead: null };
  }
  const blocked = parseBlockedByCapability(input.structuredOutput);
  if (blocked && !blocked.ok) return refuse('invalid_capability_outcome', blocked.error);
  const proceeded = parseProceededWithout(input.structuredOutput);
  if (proceeded && !proceeded.ok) return refuse('invalid_capability_outcome', proceeded.error);
  const blockedIds = new Set((blocked?.ok ? blocked.value : []).map(b => b.requestId));
  const proceededIds = new Set((proceeded?.ok ? proceeded.value : []).map(p => p.requestId));
  const byId = new Map(rows.map(r => [r.id, r]));

  for (const id of [...blockedIds, ...proceededIds]) {
    if (!byId.has(id)) {
      return refuse('capability_request_unknown', `requestId ${id} is not a capability request this worker made. Use the id request_capability returned (grant.id).`);
    }
  }

  const standing = new Map<string, RequestStanding>();
  for (const r of rows) standing.set(r.id, requestStanding(r, { now, windowMs, unusable }));

  // A held (usable) grant is not a blocker: use it.
  for (const id of [...blockedIds, ...proceededIds]) {
    const r = byId.get(id)!;
    if (standing.get(id) === 'held') {
      const live = r.status === 'granted';
      return refuse('capability_held', `Request ${id} (${ask(r)}) ${live ? 'is granted and live: use it' : 'was granted and usable while it lasted'}; it is not something you proceeded without. Drop it from ${blockedIds.has(id) ? 'blockedByCapability' : 'proceededWithout'}.`, 'use_capability');
    }
  }

  // Pending inside the window and not given up on: hold the run.
  const pendingOpen = rows.filter(r => standing.get(r.id) === 'pending' && !blockedIds.has(r.id));
  if (pendingOpen.length > 0) {
    const what = pendingOpen.map(r => `${ask(r)} (request ${r.id})`).join('; ');
    return {
      kind: 'refuse', code: 'capability_request_pending', hint: 'wait_or_withdraw_or_blockedByCapability',
      error: `Completion is held: a person has not answered your access request for ${what}. Three ways out: (1) ${THREE_WAYS_OUT[0]}; (2) ${THREE_WAYS_OUT[1]}; (3) ${THREE_WAYS_OUT[2]}.`,
      options: [...THREE_WAYS_OUT], requestIds: pendingOpen.map(r => r.id),
    };
  }

  // Everything that was never granted (or cannot be used) must be declared.
  const undeclared = rows.filter(r => (standing.get(r.id) === 'ungranted' || standing.get(r.id) === 'overdue') && !blockedIds.has(r.id) && !proceededIds.has(r.id));
  if (undeclared.length > 0) {
    const what = undeclared.map(r => `${ask(r)} (request ${r.id}: ${outcomeWords(requestOutcome(r, standing.get(r.id) === 'overdue' ? null : unusable(r)).outcome)})`).join('; ');
    return {
      kind: 'refuse', code: 'capability_outcome_unreported', hint: 'blockedByCapability_or_proceededWithout',
      error: `You asked for access you did not get: ${what}. Say what that did to the result: complete with structuredOutput.blockedByCapability { requestId, whatIsMissing } if the work could not be done without it, or structuredOutput.proceededWithout { requestId, whatIsMissing } if you finished anyway. Never report it as done without one of them.`,
      requestIds: undeclared.map(r => r.id),
    };
  }

  const expire = rows.filter(r => standing.get(r.id) === 'overdue').map(r => r.id);
  const stopWaiting = rows.filter(r => standing.get(r.id) === 'pending' && blockedIds.has(r.id)).map(r => r.id);
  const fill = <T extends BlockedByCapability | ProceededWithout>(d: T): T => {
    const r = byId.get(d.requestId)!;
    const o = requestOutcome(standing.get(r.id) === 'overdue' ? { ...r, status: 'expired', decisionReason: CLOSE_REASONS.waitWindowElapsed } : r, standing.get(r.id) === 'overdue' ? null : unusable(r));
    return { ...d, outcome: o.outcome, reason: o.reason };
  };
  const blockedOut = blocked?.ok ? blocked.value.map(fill) : null;
  const proceededOut = proceeded?.ok ? proceeded.value.map(fill) : null;
  const leads: string[] = [];
  for (const b of blockedOut ?? []) leads.push(`Blocked: ${ask(byId.get(b.requestId)!)} was ${outcomeWords(b.outcome!)}${b.reason ? ` ("${b.reason}")` : ''}.${b.whatIsMissing ? ` ${b.whatIsMissing}` : ''}`);
  for (const p of proceededOut ?? []) leads.push(`Proceeded without ${ask(byId.get(p.requestId)!)} (${outcomeWords(p.outcome!)}${p.reason ? `: "${p.reason}"` : ''}): ${p.whatIsMissing}`);
  return { kind: 'pass', expire, stopWaiting, blockedByCapability: blockedOut, proceededWithout: proceededOut, summaryLead: leads.length ? leads.join('\n') : null };
}

function hasDeclaration(structuredOutput: unknown): boolean {
  if (!structuredOutput || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) return false;
  const o = structuredOutput as Record<string, unknown>;
  return (o.blockedByCapability !== undefined && o.blockedByCapability !== null) || (o.proceededWithout !== undefined && o.proceededWithout !== null);
}

function refuse(code: HoldRefusalCode, error: string, hint = 'request_capability'): HoldRefusal {
  return { kind: 'refuse', code, error, hint };
}

/** The summary with the declaration first: a reader sees what is missing before anything else. */
export function leadSummary(lead: string | null, summary: unknown): string | undefined {
  if (!lead) return typeof summary === 'string' ? summary : undefined;
  return typeof summary === 'string' && summary.trim() ? `${lead}\n\n${summary}` : lead;
}

// ── messages to the worker ───────────────────────────────────────────────────

/** The marker a queued notice carries, so a redelivery never stacks two. */
export const accessNoticeMarker = (requestId: string, kind: string) => `[access ${kind} ${requestId}]`;

/** What the waiting worker is told when a person or the clock decides its request. */
export function accessDecisionNotice(
  r: Pick<HeldRequestRow, 'id' | 'capability'>,
  decision: 'approved' | 'denied' | 'expired',
  opts: { ask: string; reason?: string | null; windowMs?: number; spendWith?: string | null },
): string {
  const marker = accessNoticeMarker(r.id, decision);
  const why = opts.reason?.trim() ? ` Reason given: "${opts.reason.trim()}".` : '';
  switch (decision) {
    case 'approved':
      return `${marker} Your access request for ${opts.ask} was approved; the grant is live for this run.${opts.spendWith ? ` Use it now: ${opts.spendWith}.` : ' Use it now.'} Then finish the work that was waiting on it.`;
    case 'denied':
      return `${marker} Your access request for ${opts.ask} was refused by a person.${why} Do not ask again for the same thing on this run. Finish what you can, then complete with structuredOutput.blockedByCapability { requestId: "${r.id}", whatIsMissing } if the work needed it, or structuredOutput.proceededWithout { requestId: "${r.id}", whatIsMissing } if you finished without it.`;
    case 'expired': {
      const hours = opts.windowMs ? Math.round(opts.windowMs / 36e5 * 10) / 10 : null;
      return `${marker} Your access request for ${opts.ask} expired: nobody answered it within the team's wait window${hours ? ` (${hours} h)` : ''}. Complete now with structuredOutput.blockedByCapability { requestId: "${r.id}", whatIsMissing } naming what the result lacks, or structuredOutput.proceededWithout { requestId: "${r.id}", whatIsMissing } if you finished without it.`;
    }
  }
}
