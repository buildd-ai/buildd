/**
 * The connector gateway's rules: a verbatim MCP pass-through that holds the
 * provider credential server-side and decides every call. Pure; the db half is
 * connector-gateway-store.ts and the HTTP half is app/api/mcp/c/[connectorId].
 *
 * The provider's tools stay native: names, descriptions and input schemas are
 * forwarded byte-for-byte. Buildd does two things only:
 *   1. `tools/list`: drop tools above the run's ceiling (role ceiling,
 *      unattended cap, admin deny list, a forbidding team rule). Never rewrite.
 *   2. `tools/call`: decide against live state. A denial is an MCP tool result
 *      with `isError: true` and a structured `{code, …, nextSteps}`, so the
 *      model reads it and can ask for access (`request_capability`).
 *
 * A tool's risk comes from the provider's own MCP annotations, overridden by
 * an admin's per-connector lists, and fails closed: a tool not annotated
 * read-only is a write (an admin verb is admin), so a read-only run never sees
 * or calls a mutation (Axiom monitors/dashboards/notifiers, Vercel project
 * settings, deploys) whatever scopes the provider's OAuth grant carries.
 *
 * Spec: docs/specs/capability-requests.md §Connector gateway.
 */
import { createHash } from 'crypto';
import { isLiveWorkerStatus, isOpenTaskStatus } from '@buildd/shared';
import {
  CAPABILITY_RISKS,
  classifyToolRisk,
  effectivePolicy,
  riskAtLeast,
  type CapabilityRisk,
  type PolicyRule,
} from './capability-grants';

// ── Which connectors go through the gateway ──────────────────────────────────

/**
 * Catalog providers whose connectors are always brokered. Other connectors
 * keep today's direct mount unless BUILDD_CONNECTOR_GATEWAY=all.
 */
export const GATEWAY_PROVIDERS: ReadonlySet<string> = new Set(['axiom', 'vercel']);

export type GatewayMode = 'off' | 'providers' | 'all';

export function gatewayMode(env: Record<string, string | undefined> = process.env): GatewayMode {
  const v = (env.BUILDD_CONNECTOR_GATEWAY ?? '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return 'off';
  if (v === 'all') return 'all';
  return 'providers';
}

/**
 * Is this connector mounted through the gateway? Only remote connectors with a
 * stored credential: stdio runs on the runner, `none` has nothing to broker,
 * assertion mode mints per run.
 */
export function usesGateway(
  c: { transport: string; authMode: string },
  providerSlug: string | null,
  mode: GatewayMode = gatewayMode(),
): boolean {
  if (mode === 'off') return false;
  if (c.transport !== 'http' || (c.authMode !== 'oauth' && c.authMode !== 'header')) return false;
  return mode === 'all' || (!!providerSlug && GATEWAY_PROVIDERS.has(providerSlug));
}

/** The path the runner prefixes with its own buildd origin. */
export const gatewayPath = (connectorId: string) => `/api/mcp/c/${connectorId}`;

// ── Tool classification ──────────────────────────────────────────────────────

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** An admin's per-connector corrections, from `connectors.discoveredMetadata.toolPolicy`. */
export interface ToolOverrides {
  readOnlyTools: ReadonlySet<string>;
  denyTools: ReadonlySet<string>;
}

export const NO_OVERRIDES: ToolOverrides = { readOnlyTools: new Set(), denyTools: new Set() };

export function readToolOverrides(discoveredMetadata: unknown): ToolOverrides {
  const p = (discoveredMetadata as { toolPolicy?: unknown } | null | undefined)?.toolPolicy as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return NO_OVERRIDES;
  const names = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 160) : []);
  return { readOnlyTools: names(p.readOnlyTools), denyTools: names(p.denyTools) };
}

const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MAX_OVERRIDE_NAMES = 200;

/** Validate an admin's `toolPolicy` edit. Exact names only: `*` is never a wildcard. Null when malformed. */
export function parseToolPolicy(v: unknown): { readOnlyTools: string[]; denyTools: string[] } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'readOnlyTools' && k !== 'denyTools') return null;
  const list = (x: unknown): string[] | null => {
    if (x === undefined) return [];
    if (!Array.isArray(x) || x.length > MAX_OVERRIDE_NAMES) return null;
    if (!x.every(n => typeof n === 'string' && TOOL_NAME_RE.test(n))) return null;
    return [...new Set(x as string[])].sort();
  };
  const readOnlyTools = list(o.readOnlyTools);
  const denyTools = list(o.denyTools);
  if (!readOnlyTools || !denyTools) return null;
  return { readOnlyTools, denyTools };
}

export type ToolClass = CapabilityRisk | 'denied';

/**
 * A native tool's risk. In order: an admin deny wins; a destructive hint is
 * admin; an admin's read-only mark or the provider's `readOnlyHint` is read,
 * unless the name is an admin verb (a contradiction fails closed); anything
 * else, including no annotations at all, is a write (admin for admin verbs).
 */
export function classifyNativeTool(name: string, annotations: ToolAnnotations | null | undefined, overrides: ToolOverrides = NO_OVERRIDES): ToolClass {
  if (overrides.denyTools.has(name)) return 'denied';
  const byName = classifyToolRisk(name);
  if (annotations?.destructiveHint === true) return 'admin';
  if (overrides.readOnlyTools.has(name)) return 'read';
  if (annotations?.readOnlyHint === true) return byName === 'admin' ? 'admin' : 'read';
  return byName === 'admin' ? 'admin' : 'write';
}

// ── Run context ──────────────────────────────────────────────────────────────

/** Read from a role row's `metadata.connectorCeiling`; absent = write (today's behaviour for a mounted connector). */
export function readRoleCeiling(metadata: unknown): CapabilityRisk {
  const v = (metadata as { connectorCeiling?: unknown } | null | undefined)?.connectorCeiling;
  return typeof v === 'string' && (CAPABILITY_RISKS as readonly string[]).includes(v) ? (v as CapabilityRisk) : 'write';
}

/** The ceiling an unattended (scheduled or sentinel) run never exceeds, whatever its role or grants. */
export const UNATTENDED_CEILING: CapabilityRisk = 'query';

/** Calls per worker per minute, per connector. Unattended runs get less. */
export const RATE_LIMITS = { attended: 60, unattended: 20 } as const;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 90_000;

export type CredentialState = 'ok' | 'missing' | 'dead';

/** Every live fact a gateway decision reads. Loaded fresh per request; nothing cached from claim time. */
export interface GatewayRun {
  teamId: string;
  workspaceId: string;
  taskId: string;
  workerId: string;
  roleSlug: string | null;
  taskStatus: string;
  workerStatus: string;
  unattended: boolean;
  roleCeiling: CapabilityRisk;
  /** The task's role lists this connector in connectorRefs. */
  roleMounts: boolean;
  connector: {
    id: string;
    provider: string;
    /** Owned by the task's team, or shared to it. */
    visible: boolean;
    enabledInWorkspace: boolean;
    blocked: boolean;
    credential: CredentialState;
  };
  rules: readonly PolicyRule[];
}

export function effectiveCeiling(run: Pick<GatewayRun, 'roleCeiling' | 'unattended'>): CapabilityRisk {
  if (run.unattended && riskAtLeast(run.roleCeiling, UNATTENDED_CEILING)) return UNATTENDED_CEILING;
  return run.roleCeiling;
}

export type ConnectorRefusal =
  | 'task_terminal' | 'worker_not_live' | 'connector_gone' | 'catalog_blocked'
  | 'disabled_in_workspace' | 'need_connection' | 'credential_dead' | 'no_role';

/** May this run reach the connector at all (any method)? */
export function connectorRefusal(run: GatewayRun): ConnectorRefusal | null {
  if (!isOpenTaskStatus(run.taskStatus)) return 'task_terminal';
  if (!isLiveWorkerStatus(run.workerStatus)) return 'worker_not_live';
  if (!run.connector.visible) return 'connector_gone';
  if (run.connector.blocked) return 'catalog_blocked';
  if (!run.connector.enabledInWorkspace) return 'disabled_in_workspace';
  if (!run.roleSlug) return 'no_role';
  if (run.connector.credential === 'missing') return 'need_connection';
  if (run.connector.credential === 'dead') return 'credential_dead';
  return null;
}

function forbiddenByPolicy(run: GatewayRun, cls: CapabilityRisk): boolean {
  return effectivePolicy(run.rules, {
    provider: run.connector.provider, risk: cls, workspaceId: run.workspaceId,
    roleSlug: run.roleSlug, environment: null, resource: null,
  }, run.roleMounts).effect === 'forbidden';
}

/**
 * Is the tool listed to this run? Filtered by ceiling, never by grant: a tool
 * the run could be granted is listed, and calling it early answers with a
 * structured `capability_not_granted` the model can act on. Stable for the
 * session, so no runtime needs `tools/list_changed`.
 */
export function toolVisible(cls: ToolClass, run: GatewayRun): boolean {
  if (cls === 'denied') return false;
  if (!riskAtLeast(effectiveCeiling(run), cls)) return false;
  return !forbiddenByPolicy(run, cls);
}

export type CallRefusal =
  | ConnectorRefusal
  | 'tool_denied_by_admin' | 'role_ceiling' | 'unattended_ceiling' | 'policy_forbidden'
  | 'capability_not_granted' | 'rate_limited' | 'replayed_call' | 'gateway_unavailable';

export type CallDecision =
  | { allowed: true; basis: 'role_mount' | 'grant'; grantId: string | null }
  | { allowed: false; code: CallRefusal; grantReason?: string };

/** The grant check, injected so the rules stay pure (store: authorizeConnectorToolUse). */
export type GrantCheck = () => Promise<{ allowed: true; grantId: string } | { allowed: false; reasonCode: string }>;

/**
 * Decide one `tools/call`. A role-mounted connector covers reads and queries;
 * a write or admin call, or any call on a connector the role does not mount,
 * needs a live task grant that covers the exact tool, risk, resource and
 * environment (checked by `checkGrantUse`, fresh). Nothing lifts the ceiling.
 */
export async function decideToolCall(cls: ToolClass, run: GatewayRun, grant: GrantCheck): Promise<CallDecision> {
  const refusal = connectorRefusal(run);
  if (refusal) return { allowed: false, code: refusal };
  if (cls === 'denied') return { allowed: false, code: 'tool_denied_by_admin' };
  if (!riskAtLeast(effectiveCeiling(run), cls)) {
    return { allowed: false, code: run.unattended && riskAtLeast(run.roleCeiling, cls) ? 'unattended_ceiling' : 'role_ceiling' };
  }
  if (forbiddenByPolicy(run, cls)) return { allowed: false, code: 'policy_forbidden' };
  if (run.roleMounts && (cls === 'read' || cls === 'query')) return { allowed: true, basis: 'role_mount', grantId: null };
  const g = await grant();
  if (g.allowed) return { allowed: true, basis: 'grant', grantId: g.grantId };
  return { allowed: false, code: 'capability_not_granted', grantReason: g.reasonCode };
}

// ── Arguments, replay, audit labels ──────────────────────────────────────────

const ENV_KEYS = ['environment', 'env', 'target'];
const RESOURCE_KEYS = ['resource', 'projectId', 'project', 'dataset', 'datasetName'];

function firstString(args: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * The resource and environment a call names, read from well-known argument
 * keys only. Used to match a grant that names them; a grant that names one
 * and a call that does not give it exactly is refused (`checkGrantUse`).
 */
export function callScope(args: unknown): { resource: string | null; environment: string | null } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { resource: null, environment: null };
  const a = args as Record<string, unknown>;
  const env = firstString(a, ENV_KEYS);
  return { resource: firstString(a, RESOURCE_KEYS), environment: env ? env.toLowerCase() : null };
}

/** Stable JSON (sorted keys) so the same arguments hash the same. */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

export const argsHash = (args: unknown) => createHash('sha256').update(stable(args ?? null)).digest('hex').slice(0, 32);

/**
 * One key per write: the same worker, MCP session, JSON-RPC id, tool and
 * arguments. A second write with the same key is a replay and is refused, so
 * a retried or captured request can never execute a mutation twice.
 */
export function callKey(p: { workerId: string; sessionId: string | null; rpcId: unknown; tool: string; argsHash: string }): string {
  return createHash('sha256').update([p.workerId, p.sessionId ?? '', stable(p.rpcId ?? null), p.tool, p.argsHash].join('\u0000')).digest('hex');
}

export const toolResource = (connectorId: string, tool: string) => `connector:${connectorId}/${tool.slice(0, 160)}`;

// ── Denials the model can act on ─────────────────────────────────────────────

const NEXT_STEPS: Record<CallRefusal, string> = {
  task_terminal: 'This task has ended; provider tools are closed to it.',
  worker_not_live: 'This agent run is no longer live; provider tools are closed to it.',
  connector_gone: 'This connector is no longer available to this workspace.',
  catalog_blocked: "This provider is blocked by your team's connector policy. A team admin can unblock it in Settings → MCP connectors.",
  disabled_in_workspace: 'This connector is disabled in this workspace. A workspace admin can enable it.',
  no_role: 'Provider tools are only available to a task with a role.',
  need_connection: 'This connector has not been connected yet. A team admin connects it in Settings → MCP connectors.',
  credential_dead: 'The connection to this provider has to be renewed. A team admin reconnects it in Settings → MCP connectors; carry on with other work meanwhile.',
  tool_denied_by_admin: 'A team admin has turned this tool off for this connector.',
  role_ceiling: "This tool changes things at the provider and this task's role is limited to reading. Do not retry; if the change is needed, say so in a note.",
  unattended_ceiling: 'Scheduled and sentinel runs may only read from providers. Do not retry; file a task for a person-supervised run if a change is needed.',
  policy_forbidden: 'Team capability policy forbids this access.',
  capability_not_granted: 'Ask for it with request_capability (capability, provider, and this exact tool). Writes need a person to approve; keep working on other things meanwhile.',
  rate_limited: 'Too many provider calls in the last minute. Wait before calling again.',
  replayed_call: 'This exact write was already sent once in this session; it was not sent again.',
  gateway_unavailable: 'buildd could not check this call right now, so it was not sent. Try again shortly.',
};

/** A JSON-RPC result carrying an MCP tool error. Never a credential, never the provider's raw error. */
export function deniedToolResult(rpcId: unknown, code: CallRefusal, extra: Record<string, unknown> = {}) {
  const body = { code, ...extra, nextSteps: [NEXT_STEPS[code]] };
  return {
    jsonrpc: '2.0' as const,
    id: rpcId ?? null,
    result: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true, structuredContent: body },
  };
}

/** Upstream outcomes, as tool errors the model can read. */
export function upstreamToolError(rpcId: unknown, code: 'reconnect_required' | 'provider_unreachable' | 'provider_timeout' | 'response_too_large') {
  const text: Record<typeof code, string> = {
    reconnect_required: 'The provider no longer accepts the saved connection. A team admin reconnects it in Settings → MCP connectors; carry on with other work meanwhile.',
    provider_unreachable: 'The provider could not be reached. A read can be retried shortly; a write may or may not have happened, so check before retrying.',
    provider_timeout: 'The provider did not answer in time. A read can be retried; a write may or may not have happened, so check before retrying.',
    response_too_large: 'The provider answer was too large to return. Narrow the request.',
  };
  const body = { code, nextSteps: [text[code]] };
  return { jsonrpc: '2.0' as const, id: rpcId ?? null, result: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true, structuredContent: body } };
}

// ── JSON-RPC surface ─────────────────────────────────────────────────────────

/** Methods forwarded. Anything else is refused (fail closed on surface the gateway does not understand). */
const FORWARDED_METHODS = new Set([
  'initialize', 'ping', 'tools/list', 'tools/call',
  'resources/list', 'resources/read', 'resources/templates/list',
  'prompts/list', 'prompts/get', 'completion/complete', 'logging/setLevel',
]);

export function methodAllowed(method: unknown): boolean {
  if (typeof method !== 'string') return false;
  return FORWARDED_METHODS.has(method) || method.startsWith('notifications/');
}

export interface NativeTool { name: string; annotations?: ToolAnnotations; [k: string]: unknown }

/**
 * Filter a `tools/list` result in place of nothing else: the kept entries are
 * the provider's own objects, untouched. Returns the filtered result and the
 * class of every tool seen (for the call-time cache).
 */
export function filterToolsList(result: unknown, run: GatewayRun, overrides: ToolOverrides): { result: unknown; classes: Map<string, ToolClass> } {
  const classes = new Map<string, ToolClass>();
  const r = result as { tools?: unknown } | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.tools)) return { result, classes };
  const kept: unknown[] = [];
  for (const t of r.tools as NativeTool[]) {
    if (!t || typeof t.name !== 'string') continue;
    const cls = classifyNativeTool(t.name, t.annotations, overrides);
    classes.set(t.name, cls);
    if (toolVisible(cls, run)) kept.push(t);
  }
  return { result: { ...r, tools: kept }, classes };
}
