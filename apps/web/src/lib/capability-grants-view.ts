/**
 * How a capability request, a grant and a provider's state read to a person:
 * Settings → Connected apps → Agent access, and the Needs You card. Client-safe
 * and pure (no server imports): the rules live in capability-grants.ts, the
 * state comes from the API, and nothing here decides anything. A label never
 * says more than the backend did: "Connected" only for a live credential,
 * "Approved" only for a granted row.
 *
 * Spec: docs/specs/capability-requests.md → Showing and deciding.
 */
import { CONNECTOR_CATALOG, connectorHostKey, type ConnectorClientSupport } from './connector-catalog';

export type AccessRisk = 'read' | 'query' | 'write' | 'admin';
export type AccessStatus = 'pending' | 'granted' | 'denied' | 'revoked' | 'expired';
export type AccessEffect = 'auto_grant' | 'ask_human' | 'forbidden';

/** A request or grant as GET /api/agent-capabilities/requests returns it. */
export interface AccessRequestView {
  id: string;
  status: AccessStatus;
  capability: string;
  provider: string;
  risk: AccessRisk;
  tool: string | null;
  resource: string | null;
  environment: string | null;
  workspaceId: string;
  taskId: string;
  roleSlug: string | null;
  decidedBy: 'policy' | 'human' | 'system' | null;
  ttlSeconds: number;
  expiresAt: string | null;
  revokedAt: string | null;
  reason?: string | null;
  decisionReason?: string | null;
  requestedAt?: string | null;
  decidedAt?: string | null;
  taskTitle?: string | null;
  workspaceName?: string | null;
  decidedByName?: string | null;
}

export const RISK_LABEL: Record<AccessRisk, string> = { read: 'Read', query: 'Query', write: 'Write', admin: 'Admin' };
const RISK_VERB: Record<AccessRisk, string> = { read: 'Read', query: 'Query', write: 'Write to', admin: 'Administer' };

export const EFFECT_LABEL: Record<AccessEffect, string> = {
  auto_grant: 'Allow automatically',
  ask_human: 'Ask a person',
  forbidden: 'Never allow',
};

/** The effects a rule may set for a risk: writes and admin always need a person (the API refuses auto_grant). */
export function effectsFor(risk: AccessRisk): AccessEffect[] {
  return risk === 'write' || risk === 'admin' ? ['ask_human', 'forbidden'] : ['auto_grant', 'ask_human', 'forbidden'];
}

/** What happens with no team rule, in the words of capability-grants.ts `defaultEffect`. */
export function defaultEffectText(risk: AccessRisk): string {
  return risk === 'write' || risk === 'admin' ? 'Ask a person' : 'Allow if the agent uses it';
}

/**
 * One provider's policy on one line, for the folded row: only what differs
 * from the default, else "Defaults".
 */
export function policySummary(rules: readonly { risk: AccessRisk; effect: AccessEffect }[]): string {
  const order: AccessRisk[] = ['read', 'query', 'write', 'admin'];
  const set = [...rules].sort((a, b) => order.indexOf(a.risk) - order.indexOf(b.risk));
  return set.length === 0 ? 'Defaults' : set.map(r => `${RISK_LABEL[r.risk]}: ${EFFECT_LABEL[r.effect].toLowerCase()}`).join(' · ');
}

/** The provider's display name: the catalog's, else the slug as written. */
export function providerName(slug: string): string {
  if (slug === 'openrouter') return 'OpenRouter';
  if (slug === 'litellm') return 'LiteLLM';
  return CONNECTOR_CATALOG.find(e => e.slug === slug)?.name ?? slug;
}

/** "1 hour", "30 minutes", "1 day". Rounds down to the unit a person reads. */
export function formatLease(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) return plural(seconds / 86_400, 'day');
  if (seconds >= 3_600) return plural(Math.floor(seconds / 3_600), 'hour');
  return plural(Math.max(1, Math.floor(seconds / 60)), 'minute');
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** What the agent asked to do, and where: "Query Axiom · logs · production". */
export function accessAsk(r: Pick<AccessRequestView, 'risk' | 'provider' | 'tool' | 'resource' | 'environment' | 'capability'>): string {
  const what = r.capability === 'model.inference' ? `Use ${providerName(r.provider)} models` : `${RISK_VERB[r.risk]} ${providerName(r.provider)}`;
  return [what, r.tool, r.resource, r.environment].filter(Boolean).join(' · ');
}

/** Who asked, where: the task (else its role), then the workspace. */
export function accessWho(r: Pick<AccessRequestView, 'taskTitle' | 'roleSlug' | 'workspaceName'>): string {
  const who = r.taskTitle?.trim() || (r.roleSlug ? `A ${r.roleSlug} agent` : 'An agent');
  return r.workspaceName ? `${who} in ${r.workspaceName}` : who;
}

function until(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return `${formatLease(Math.max(60, Math.floor(ms / 1000)))} left`;
}

/**
 * One line on where a request stands and who decided it: the audit a person
 * reads. Expired and denied say what to do next.
 */
export function accessStatusLine(r: AccessRequestView, now: Date = new Date()): string {
  const by = r.decidedByName?.trim();
  const why = r.decisionReason?.trim();
  switch (r.status) {
    case 'pending':
      return `Waiting for a person · asks for ${formatLease(r.ttlSeconds)}`;
    case 'granted': {
      const left = until(r.expiresAt, now);
      const who = r.decidedBy === 'policy' ? 'Allowed by team policy' : by ? `Approved by ${by}` : 'Approved';
      return [who, left].filter(Boolean).join(' · ');
    }
    case 'denied':
      return [by ? `Denied by ${by}` : 'Denied', why].filter(Boolean).join(': ') + '. The agent can\'t ask again on this run.';
    case 'revoked':
      return `${by ? `Revoked by ${by}` : 'Revoked'}. The agent's next call is refused.`;
    case 'expired':
      return r.decidedBy === 'system' && why
        ? `Closed: ${EXPIRED_WHY[why] ?? why}. The agent can ask again from a new run.`
        : 'The lease ran out. The agent can ask again if it still needs it.';
  }
}

const EXPIRED_WHY: Record<string, string> = {
  task_terminal: 'the task ended',
  worker_not_live: 'the agent run stopped',
  role_changed: "the task's agent changed",
};

/** The approve button's words: the lease is part of the decision. */
export function approveLabel(ttlSeconds: number): string {
  return `Approve for ${formatLease(ttlSeconds)}`;
}

/**
 * Lease choices an approver can pick: the request's own, and the shorter
 * standard ones. Approval can only narrow (capability-grants.ts `approvalTtl`).
 */
export function leaseChoices(requested: number): number[] {
  const out = new Set<number>([requested]);
  for (const s of [15 * 60, 60 * 60, 4 * 60 * 60]) if (s < requested) out.add(s);
  return [...out].sort((a, b) => a - b);
}

/** The decide route's answer as one line for the person who clicked. */
export function decisionResultText(decision: 'approve' | 'deny' | 'revoke', status: number, body: { error?: string; message?: string; alreadyDecided?: boolean; grant?: { status?: string } }): { ok: boolean; text: string } {
  if (status >= 200 && status < 300) {
    const verb = decision === 'approve' ? 'Approved' : decision === 'deny' ? 'Denied' : 'Revoked';
    return { ok: true, text: body.alreadyDecided ? `Already ${verb.toLowerCase()}.` : `${verb}.` };
  }
  if (status === 403) return { ok: false, text: body.message || 'Only a team admin can decide access requests.' };
  if (status === 404) return { ok: false, text: 'This request no longer exists.' };
  if (status === 409 && body.grant?.status) return { ok: false, text: `Someone already decided: this request is ${body.grant.status}.` };
  return { ok: false, text: body.error || body.message || 'Could not save the decision.' };
}

// ── Provider state on a catalog card ────────────────────────────────────────

export interface InstalledConnector {
  id: string;
  url: string;
  authMode: 'none' | 'header' | 'oauth';
  status: 'connected' | 'expired' | 'not_connected';
  shared?: boolean;
}

export type ProviderStateKind = 'needs_client_approval' | 'not_installed' | 'connect' | 'set_key' | 'reconnect' | 'connected' | 'no_auth';

export interface ProviderState {
  kind: ProviderStateKind;
  /** The pill: what is true now. */
  label: string;
  tone: 'ok' | 'act' | 'q';
  /** The one next step for an admin, or null when there is none to take here. */
  action: { kind: 'install' | 'connect' | 'set_key'; label: string; connectorId?: string } | null;
}

/**
 * A catalog entry's real state for this team: the installed connector on the
 * same host (the catalog policy's matching key) and its credential. A provider
 * that has not approved buildd as a client offers no Connect at all: the only
 * honest next step is the provider's review, so the card links there instead.
 */
export function providerState(entry: { url: string; authMode: 'none' | 'header' | 'oauth'; clientSupport?: ConnectorClientSupport }, installed: readonly InstalledConnector[]): ProviderState {
  const host = connectorHostKey(entry.url);
  const c = installed.find(i => !i.shared && connectorHostKey(i.url) === host) ?? installed.find(i => connectorHostKey(i.url) === host) ?? null;
  if (c && (c.authMode === 'none')) return { kind: 'no_auth', label: 'Installed', tone: 'ok', action: null };
  if (c && c.status === 'connected') return { kind: 'connected', label: 'Connected', tone: 'ok', action: null };
  if (entry.clientSupport?.status === 'needs_approved_client') {
    return { kind: 'needs_client_approval', label: 'Client approval needed', tone: 'q', action: null };
  }
  if (!c) return { kind: 'not_installed', label: 'Not installed', tone: 'q', action: { kind: 'install', label: 'Install' } };
  if (c.shared) return { kind: c.status === 'expired' ? 'reconnect' : 'connect', label: c.status === 'expired' ? 'Expired' : 'Not connected', tone: c.status === 'expired' ? 'act' : 'q', action: null };
  if (c.status === 'expired') return { kind: 'reconnect', label: 'Expired', tone: 'act', action: { kind: 'connect', label: 'Reconnect', connectorId: c.id } };
  if (c.authMode === 'header') return { kind: 'set_key', label: 'Not connected', tone: 'q', action: { kind: 'set_key', label: 'Set key', connectorId: c.id } };
  return { kind: 'connect', label: 'Not connected', tone: 'q', action: { kind: 'connect', label: 'Connect', connectorId: c.id } };
}
