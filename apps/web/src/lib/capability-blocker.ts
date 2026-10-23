/**
 * `structuredOutput.blockedByCapability`: the only way a run reports "I could
 * not meet this requirement because I lack a capability" (rules; the db half
 * is capability-blocker-store.ts).
 *
 * A free-text "the sandbox has no X" used to go straight to a person as a
 * waiver, though buildd has a governed path for exactly that ask
 * (request_capability: a budget-capped, revocable grant a person approves).
 * So the structured claim is accepted only when this worker actually asked:
 *
 * - no resolve_capability / request_capability call for the need → refused,
 *   naming the call to make;
 * - the ask is pending_approval → refused: not a blocker, keep working and ask
 *   again (the existing request_capability contract);
 * - the ask was granted (existing / auto_granted, or a live grant) → refused:
 *   use it;
 * - resolve_capability shows a provider that serves it, but nothing was
 *   requested → refused: request it;
 * - a real "no" (denied, forbidden, unavailable, need_connection, need_reauth,
 *   unhealthy, revoked, expired, or nothing serves it) → accepted. With a
 *   request row it routes to that request; with none it files one
 *   `[capability]` task per need and workspace.
 *
 * It never routes to a review waiver. Pure: no db, no clock.
 */
import type { BlockedByCapability } from '@buildd/shared';

/** One resolve_capability / request_capability call this worker made, from agent_capability_decisions. */
export interface CapabilityCallRecord {
  call: 'request' | 'resolve';
  /** request: the parsed ask (`axiom:read`, `model.inference`, `tasks:create`); resolve: the category searched, or `<provider>:<access>`. */
  capability: string | null;
  provider: string | null;
  /** request: the resolution kind; resolve: `served` | `none`. */
  outcome: string;
  /** resolve: providers that serve it here. */
  providers?: string[];
  grantId: string | null;
  at: Date;
}

/** This worker's capability_grants row, read fresh (a pending ask may have been decided since). */
export interface CapabilityRequestRow {
  id: string;
  capability: string;
  provider: string;
  status: 'pending' | 'granted' | 'denied' | 'revoked' | 'expired';
  requestedAt: Date;
}

export type BlockerDecision =
  | { accept: true; outcome: string; routedTo: 'capability_request'; requestId: string }
  | { accept: true; outcome: string; routedTo: 'capability_task' }
  | { accept: false; code: BlockerRefusalCode; error: string; hint: string };

export type BlockerRefusalCode =
  | 'invalid_blocker'
  | 'capability_not_asked'
  | 'capability_not_requested'
  | 'capability_pending_approval'
  | 'capability_held'
  | 'capability_request_unknown';

/** Outcomes that are a real "no" from request_capability; anything else is not a blocker. */
const BLOCKING_OUTCOMES = new Set(['denied', 'forbidden', 'unavailable', 'need_connection', 'need_reauth', 'unhealthy']);
const HELD_OUTCOMES = new Set(['existing', 'auto_granted']);
const SLUG_RE = /^[a-z0-9][a-z0-9.:_-]{0,79}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** null = absent; otherwise the parsed claim or why it is malformed. */
export function parseBlockedByCapability(structuredOutput: unknown):
  | null
  | { ok: true; value: BlockedByCapability }
  | { ok: false; error: string } {
  if (!structuredOutput || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) return null;
  const raw = (structuredOutput as Record<string, unknown>).blockedByCapability;
  if (raw === undefined || raw === null) return null;
  const shape = 'structuredOutput.blockedByCapability is { need, provider?, access?: "read" | "write", triedPath, requestId? }';
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: shape };
  const b = raw as Record<string, unknown>;
  const need = typeof b.need === 'string' ? b.need.trim().toLowerCase() : '';
  if (!SLUG_RE.test(need)) return { ok: false, error: `${shape}: need is what you lacked, e.g. "model.inference", "axiom", "axiom:read" or "observability:query"` };
  const triedPath = typeof b.triedPath === 'string' ? b.triedPath.trim() : '';
  if (!triedPath) return { ok: false, error: `${shape}: triedPath says what you tried, in a sentence or two` };
  let provider: string | undefined;
  if (b.provider !== undefined && b.provider !== null) {
    provider = typeof b.provider === 'string' ? b.provider.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(provider)) return { ok: false, error: `${shape}: provider is a catalog slug` };
  }
  let access: 'read' | 'write' | undefined;
  if (b.access !== undefined && b.access !== null) {
    if (b.access !== 'read' && b.access !== 'write') return { ok: false, error: `${shape}: access is read or write` };
    access = b.access;
  }
  let requestId: string | undefined;
  if (b.requestId !== undefined && b.requestId !== null) {
    if (typeof b.requestId !== 'string' || !UUID_RE.test(b.requestId)) return { ok: false, error: `${shape}: requestId is the grant id request_capability returned` };
    requestId = b.requestId.toLowerCase();
  }
  return {
    ok: true,
    value: { need, triedPath: triedPath.slice(0, 2000), ...(provider ? { provider } : {}), ...(access ? { access } : {}), ...(requestId ? { requestId } : {}) },
  };
}

/** Does a call or request row ask for this need? By the ask itself, or by the provider named on either side. */
export function matchesNeed(claim: Pick<BlockedByCapability, 'need' | 'provider'>, capability: string | null, provider: string | null): boolean {
  const need = claim.need;
  if (capability && capability === need) return true;
  if (provider && (provider === claim.provider || provider === need)) return true;
  // `axiom:read` names the provider before the colon; a category does not, and only matches itself.
  if (provider && need.includes(':') && need.split(':')[0] === provider) return true;
  return false;
}

/** The exact call that would answer this need. */
export function capabilityCallFor(claim: Pick<BlockedByCapability, 'need' | 'provider' | 'access'>): string {
  if (claim.need === 'model.inference') {
    return 'request_capability { capability: "model.inference", provider: "openrouter" | "litellm", models: ["<exact model id>"], budget: { … } }';
  }
  const provider = claim.provider ?? (/^[a-z0-9][a-z0-9-]*$/.test(claim.need) ? claim.need : null)
    ?? (claim.need.includes(':') && !isCategory(claim.need) ? claim.need.split(':')[0] : null);
  const access = claim.access ?? (claim.need.endsWith(':write') ? 'write' : 'read');
  if (provider) return `request_capability { provider: "${provider}", access: "${access}" }`;
  return `resolve_capability { capability: "${claim.need}" }, then request_capability { provider: "<a provider it lists>", access: "${access}" }`;
}

const CATEGORY_DOMAINS = new Set(['observability', 'deployment', 'database', 'analytics', 'work_tracking', 'docs', 'source_control']);
function isCategory(need: string): boolean {
  return CATEGORY_DOMAINS.has(need.split(':')[0]);
}

function refuse(code: BlockerRefusalCode, error: string, hint = 'request_capability'): BlockerDecision {
  return { accept: false, code, error, hint };
}

const PENDING_ERROR = (id: string | null) =>
  `Your capability request${id ? ` ${id}` : ''} is pending_approval: a person on your team decides it. That is not a blocker. ` +
  'Keep working on everything else, then call request_capability again with the same ask (it returns the same request) until the outcome is existing. ' +
  'Do not end the run on it and do not ask_human for the same access.';

export function decideCapabilityBlocker(
  claim: BlockedByCapability,
  calls: CapabilityCallRecord[],
  requests: CapabilityRequestRow[],
): BlockerDecision {
  const call = capabilityCallFor(claim);

  if (claim.requestId) {
    const row = requests.find(r => r.id === claim.requestId);
    if (!row) {
      return refuse('capability_request_unknown', `blockedByCapability.requestId ${claim.requestId} is not a capability request this worker made. Make the request: ${call}.`);
    }
    return decideOnRow(row);
  }

  const rows = requests.filter(r => matchesNeed(claim, r.capability, r.provider))
    .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  // An open row wins over an older closed one: a pending ask is still in flight.
  const open = rows.find(r => r.status === 'pending' || r.status === 'granted');
  if (open) return decideOnRow(open);

  const asked = calls.filter(c => c.call === 'request' && matchesNeed(claim, c.capability, c.provider))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const lastAsk = asked[0];
  if (rows[0] && (!lastAsk || rows[0].requestedAt >= lastAsk.at)) return decideOnRow(rows[0]);
  if (lastAsk) {
    if (lastAsk.outcome === 'pending_approval') return refuse('capability_pending_approval', PENDING_ERROR(lastAsk.grantId), 'keep_working');
    if (HELD_OUTCOMES.has(lastAsk.outcome)) {
      return refuse('capability_held', `request_capability answered ${lastAsk.outcome} for ${claim.need}: you have it. Use it instead of reporting a blocker.`, 'use_capability');
    }
    if (BLOCKING_OUTCOMES.has(lastAsk.outcome)) return { accept: true, outcome: lastAsk.outcome, routedTo: 'capability_task' };
    return refuse('capability_not_asked', `request_capability answered ${lastAsk.outcome} for ${claim.need}, which is not a refusal. Ask again: ${call}.`);
  }

  const searched = calls.filter(c => c.call === 'resolve' && matchesNeed(claim, c.capability, c.provider))
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (searched) {
    if (searched.outcome === 'none') return { accept: true, outcome: 'none_serves', routedTo: 'capability_task' };
    const served = searched.providers?.[0];
    const access = claim.access ?? (claim.need.endsWith(':write') ? 'write' : 'read');
    return refuse('capability_not_requested',
      `resolve_capability shows ${searched.providers?.length ? searched.providers.join(', ') : 'a provider'} can serve ${claim.need} here, and you have not asked for it. ` +
      `Call ${served ? `request_capability { provider: "${served}", access: "${access}" }` : call} and report what it answers.`);
  }

  return refuse('capability_not_asked',
    `blockedByCapability is accepted only after you ask for the capability: this worker made no resolve_capability or request_capability call for ${claim.need}. ` +
    `Call ${call}. If it is auto_granted or existing, use it; if pending_approval, keep working and ask again; only a refusal (denied, forbidden, unavailable, need_connection …) is a blocker.`);
}

function decideOnRow(row: CapabilityRequestRow): BlockerDecision {
  if (row.status === 'pending') return refuse('capability_pending_approval', PENDING_ERROR(row.id), 'keep_working');
  if (row.status === 'granted') {
    return refuse('capability_held', `Capability request ${row.id} is granted: you have ${row.capability}. Use it instead of reporting a blocker.`, 'use_capability');
  }
  // denied, revoked, expired: a person (or the lease) said no; the request row is where they see it.
  return { accept: true, outcome: row.status, routedTo: 'capability_request', requestId: row.id };
}

/** Title and dedupe key of the `[capability]` task for a need nothing serves. */
export function capabilityTaskTitle(need: string): string {
  return `[capability] ${need} is not available to agents in this workspace`;
}

export function capabilityTaskBody(input: {
  claim: BlockedByCapability;
  outcome: string;
  sourceTaskId: string;
  sourceTaskTitle: string | null;
  workerId: string;
}): string {
  const { claim, outcome } = input;
  const what = outcome === 'none_serves'
    ? 'resolve_capability found nothing in this workspace that serves it.'
    : `request_capability answered **${outcome}**.`;
  return [
    `An agent run needed **${claim.need}**${claim.provider ? ` (provider ${claim.provider}${claim.access ? `, ${claim.access}` : ''})` : ''} and could not get it: ${what}`,
    '',
    `- Task: ${input.sourceTaskTitle ? `"${input.sourceTaskTitle}" ` : ''}(${input.sourceTaskId.slice(0, 8)})`,
    `- Worker: ${input.workerId.slice(0, 8)}`,
    `- What it tried: ${claim.triedPath}`,
    '',
    'To unblock agents: connect or enable a provider that serves this, or change the team policy that refuses it ' +
    '(Settings → Team → Apps). Agents then get it through request_capability.',
  ].join('\n');
}
