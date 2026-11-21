/**
 * The connector gateway's policy decision point (PDP).
 *
 * The gateway route (app/api/mcp/c/[connectorId]) is the policy enforcement
 * point: it authenticates the run, classifies the tool, rate-limits, enforces
 * the answer (forward or refuse) and audits it. Whether one `tools/call` may go
 * ahead is asked of a `PolicyDecisionPoint`, in the PARC shape most policy
 * engines use (Cedar, OPA, an IdP's agent gateway):
 *
 *   decide({ principal, action, resource, context }) → { effect, reason, policyId? }
 *
 * Two implementations, picked by server env (no per-team column yet):
 *   - `builtin` (default): buildd's own rules, `decideToolCall` in
 *     connector-gateway.ts: run liveness, admin deny list, role and unattended
 *     ceilings, team capability policy, role mount, then a live task grant.
 *   - `cedar`: the built-in first, then Cedar policies (connector-pdp-cedar.ts)
 *     that must also permit. Cedar narrows; it never lifts a ceiling, revives a
 *     dead credential or stands in for a grant, because the facts behind those
 *     (grants, liveness) are buildd's own state, not something a policy author
 *     should be able to switch off.
 *
 * Any failure to build or ask the PDP throws; the gateway turns that into
 * `gateway_unavailable` and sends nothing (fail closed).
 */
import type { AgentPrincipal } from './agent-capabilities/principal';
import {
  decideToolCall,
  type CallDecision,
  type CallRefusal,
  type GatewayRun,
  type GrantCheck,
  type ToolClass,
} from './connector-gateway';

// ── Request ──────────────────────────────────────────────────────────────────

/** Who is acting: one live agent run (worker on a task), never the person behind it. */
export interface PolicyPrincipal extends Pick<AgentPrincipal, 'kind' | 'via' | 'workerId' | 'taskId' | 'workspaceId' | 'teamId' | 'accountId'> {
  roleSlug: string | null;
  unattended: boolean;
}

/** What it wants to do: call one tool, at the risk the gateway classified it as. */
export interface PolicyAction {
  name: 'tools/call';
  risk: ToolClass;
}

/** What it is acting on: one native tool of one connector, and the scope its arguments name. */
export interface PolicyResource {
  kind: 'connector_tool';
  connectorId: string;
  provider: string;
  tool: string;
  scope: { resource: string | null; environment: string | null };
}

export interface PolicyContext {
  /** Every live fact the gateway loaded for this request. */
  run: GatewayRun;
  /** The task-grant check, asked lazily (only when the rules leave the call open). */
  grant: GrantCheck;
  /** In a chain (`allOf`), the allow an earlier PDP gave. */
  prior?: PolicyDecision;
}

export interface PolicyRequest {
  principal: PolicyPrincipal;
  action: PolicyAction;
  resource: PolicyResource;
  context: PolicyContext;
}

// ── Decision ─────────────────────────────────────────────────────────────────

/** Why an allow: a role mount, a task grant, or (a PDP with no grants of its own) a permitting policy. */
export type AllowBasis = 'role_mount' | 'grant' | 'policy';

export type PolicyDecision =
  | { effect: 'allow'; reason: AllowBasis; grantId?: string | null; policyId?: string }
  | { effect: 'deny'; reason: CallRefusal; grantReason?: string; policyId?: string };

type AllowDecision = Extract<PolicyDecision, { effect: 'allow' }>;

export interface PolicyDecisionPoint {
  readonly id: string;
  decide(req: PolicyRequest): Promise<PolicyDecision>;
}

export function toolCallRequest(p: {
  principal: Pick<AgentPrincipal, 'kind' | 'via' | 'workerId' | 'taskId' | 'workspaceId' | 'teamId' | 'accountId'>;
  run: GatewayRun;
  tool: string;
  risk: ToolClass;
  scope: { resource: string | null; environment: string | null };
  grant: GrantCheck;
}): PolicyRequest {
  const { kind, via, workerId, taskId, workspaceId, teamId, accountId } = p.principal;
  return {
    principal: { kind, via, workerId, taskId, workspaceId, teamId, accountId, roleSlug: p.run.roleSlug, unattended: p.run.unattended },
    action: { name: 'tools/call', risk: p.risk },
    resource: { kind: 'connector_tool', connectorId: p.run.connector.id, provider: p.run.connector.provider, tool: p.tool, scope: p.scope },
    context: { run: p.run, grant: p.grant },
  };
}

/** The gateway's own decision shape (what it enforces and writes to the audit row). */
export function toCallDecision(d: PolicyDecision): CallDecision {
  const policy = d.policyId ? { policyId: d.policyId } : {};
  if (d.effect === 'allow') return { allowed: true, basis: d.reason, grantId: d.grantId ?? null, ...policy };
  return { allowed: false, code: d.reason, ...(d.grantReason ? { grantReason: d.grantReason } : {}), ...policy };
}

// ── Implementations ──────────────────────────────────────────────────────────

/** buildd's own rules, unchanged: `decideToolCall` behind the PDP interface. */
export const builtinPdp: PolicyDecisionPoint = {
  id: 'builtin',
  async decide(req) {
    const d = await decideToolCall(req.action.risk, req.context.run, req.context.grant);
    if (d.allowed) return { effect: 'allow', reason: d.basis, grantId: d.grantId };
    return { effect: 'deny', reason: d.code, ...(d.grantReason ? { grantReason: d.grantReason } : {}) };
  },
};

/**
 * Every PDP must allow, in order; the first deny is the answer and later PDPs
 * are not asked. An allow keeps the first PDP's basis and grant (what the
 * audit row records) and the last policy id that permitted it. Each PDP sees
 * the allow before it as `context.prior`.
 */
export function allOf(...pdps: PolicyDecisionPoint[]): PolicyDecisionPoint {
  return {
    id: pdps.map(p => p.id).join('+'),
    async decide(req) {
      const [first, ...rest] = pdps;
      if (!first) throw new Error('allOf needs at least one PDP');
      const d0 = await first.decide(req);
      if (d0.effect === 'deny') return d0;
      let acc: AllowDecision = d0;
      for (const pdp of rest) {
        const d = await pdp.decide({ ...req, context: { ...req.context, prior: acc } });
        if (d.effect === 'deny') return d;
        if (d.policyId) acc = { ...acc, policyId: d.policyId };
      }
      return acc;
    },
  };
}

// ── Selection ────────────────────────────────────────────────────────────────

export type PdpMode = 'builtin' | 'cedar';

/** `BUILDD_CONNECTOR_PDP`: unset or `builtin` (default), or `cedar`. Anything else throws (fail closed). */
export function pdpMode(env: Record<string, string | undefined> = process.env): PdpMode {
  const v = (env.BUILDD_CONNECTOR_PDP ?? '').trim().toLowerCase();
  if (v === '' || v === 'builtin') return 'builtin';
  if (v === 'cedar') return 'cedar';
  throw new Error('BUILDD_CONNECTOR_PDP must be "builtin" or "cedar"');
}

let compiled: { text: string; pdp: PolicyDecisionPoint } | null = null;

/**
 * The PDP the gateway asks, from server env. Cedar mode reads its policy set
 * from `BUILDD_CONNECTOR_CEDAR_POLICIES` (Cedar text) and compiles it once per
 * text; the WASM engine is loaded only in that mode.
 */
export async function connectorPdp(env: Record<string, string | undefined> = process.env): Promise<PolicyDecisionPoint> {
  if (pdpMode(env) === 'builtin') return builtinPdp;
  const text = env.BUILDD_CONNECTOR_CEDAR_POLICIES;
  if (!text?.trim()) throw new Error('BUILDD_CONNECTOR_PDP=cedar needs BUILDD_CONNECTOR_CEDAR_POLICIES');
  if (compiled?.text === text) return compiled.pdp;
  const { cedarPdp } = await import('./connector-pdp-cedar');
  const pdp = allOf(builtinPdp, cedarPdp(text));
  compiled = { text, pdp };
  return pdp;
}
