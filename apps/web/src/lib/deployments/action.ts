/**
 * A deployment action: an operation on one provider/project/environment,
 * run by buildd with a stored credential the caller names by reference and
 * never sees (docs/specs/deployment-actions.md).
 *
 *   caller -> { provider, project, environment, credentialRef, operation, params }
 *   buildd -> authorize -> audit 'started' -> resolve credential -> adapter
 *          -> audit settled -> redacted result
 *
 * Two principals:
 * - `operator`: a task running under an agent role. Every capability the
 *   operation needs is checked against the role's grant in the task's
 *   workspace (operator-capability.ts). No admin key, no reveal.
 * - `admin`: a human's admin API key, the escape hatch. Not grant-checked
 *   (the same key can already manage the credential), but audited the same way.
 *
 * Orchestration only; storage and the provider call are injected, so the
 * ordering (no credential read before the audit row exists, no credential
 * read on a denial) is testable without a database.
 */
import { authorizeAgent, type AgentDenyReason, type DeploymentTarget, type OperatorGrant } from '../operator-capability';
import type { AgentCapability } from '../permission-registry';
import type { CloudflareCredential, FetchLike } from '../cloudflare-credential-shared';
import { cloudflareScriptName, parseCloudflareParams, runCloudflareOperation, type CloudflareOperation } from './cloudflare';

export const DEPLOYMENT_PROVIDERS = ['cloudflare'] as const;
export type DeploymentProvider = (typeof DEPLOYMENT_PROVIDERS)[number];

/**
 * What each operation needs. Every operation uses the credential, so every
 * one needs `deployment_secrets:use` on top of read or write.
 */
export const DEPLOYMENT_OPERATIONS: Record<CloudflareOperation, { capabilities: readonly AgentCapability[]; summary: string }> = {
  status: { capabilities: ['deployments:read', 'deployment_secrets:use'], summary: 'latest deployment, secret names, workers.dev URL' },
  put_secret: { capabilities: ['deployments:write', 'deployment_secrets:use'], summary: 'set one Worker secret (value never echoed)' },
  upload_worker: { capabilities: ['deployments:write', 'deployment_secrets:use'], summary: 'upload a built module Worker; secrets are kept' },
  ensure_bucket: { capabilities: ['deployments:write', 'deployment_secrets:use'], summary: 'create the project\'s R2 bucket if missing, set lifecycle rules' },
};
export type DeploymentOperation = keyof typeof DEPLOYMENT_OPERATIONS;
export const DEPLOYMENT_OPERATION_NAMES = Object.keys(DEPLOYMENT_OPERATIONS) as DeploymentOperation[];

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface DeploymentRequest {
  provider: DeploymentProvider;
  project: string;
  environment: string;
  credentialRef: string;
  operation: DeploymentOperation;
  params: unknown;
}

/** Validate a request body. Target values are lower-cased, matching how scope compares them. */
export function parseDeploymentRequest(raw: unknown): { ok: true; request: DeploymentRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'body must be an object' };
  const r = raw as Record<string, unknown>;
  const field = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim().toLowerCase() : '');
  const provider = field('provider');
  if (!(DEPLOYMENT_PROVIDERS as readonly string[]).includes(provider)) {
    return { ok: false, error: `provider must be one of: ${DEPLOYMENT_PROVIDERS.join(', ')}` };
  }
  for (const k of ['project', 'environment', 'credentialRef']) {
    if (!SLUG_RE.test(field(k))) return { ok: false, error: `${k} is required (lowercase letters, digits, dashes)` };
  }
  const operation = typeof r.operation === 'string' ? r.operation : '';
  if (!(DEPLOYMENT_OPERATION_NAMES as string[]).includes(operation)) {
    return { ok: false, error: `operation must be one of: ${DEPLOYMENT_OPERATION_NAMES.join(', ')}` };
  }
  return {
    ok: true,
    request: {
      provider: provider as DeploymentProvider,
      project: field('project'),
      environment: field('environment'),
      credentialRef: field('credentialRef'),
      operation: operation as DeploymentOperation,
      params: r.params ?? {},
    },
  };
}

export type DeploymentPrincipal =
  | { kind: 'operator'; grant: OperatorGrant; teamId: string; accountId: string; taskId: string; workerId: string }
  | { kind: 'admin'; teamId: string; accountId: string; workspaceId: string };

/** One audit row, as written. No field takes a credential value. */
export interface DeploymentAuditInput {
  teamId: string;
  workspaceId: string | null;
  taskId: string | null;
  workerId: string | null;
  accountId: string | null;
  principal: 'operator' | 'admin';
  roleSlug: string | null;
  operation: string;
  capabilities: string[];
  elevated: boolean;
  provider: string | null;
  project: string | null;
  environment: string | null;
  credentialRef: string | null;
  outcome: 'started' | 'denied' | 'succeeded' | 'failed';
  reason: string | null;
  result: Record<string, unknown> | null;
}

export interface DeploymentDeps {
  /** Insert one row; returns its id. A throw refuses the action. */
  recordAudit(row: DeploymentAuditInput): Promise<string>;
  /** Settle a 'started' row. Best-effort. */
  settleAudit(id: string, outcome: 'succeeded' | 'failed', reason: string | null, result: Record<string, unknown> | null): Promise<void>;
  /** The team's credential for this provider and reference, or null. */
  resolveCredential(teamId: string, provider: DeploymentProvider, credentialRef: string): Promise<CloudflareCredential | null>;
  fetchImpl?: FetchLike;
}

export interface DeploymentResponse {
  status: number;
  body: Record<string, unknown>;
}

const DENY_MESSAGES: Record<AgentDenyReason, string> = {
  role_not_capable: 'This task\'s role cannot run deployments. Only a role with a deployment capability (the Platform Operator) can.',
  not_enabled: 'The Platform Operator is not enabled for this workspace.',
  capability_not_granted: 'The Operator grant in this workspace does not include this capability.',
  provider_required: 'Name a provider.',
  project_required: 'Name a project.',
  environment_required: 'Name an environment.',
  credential_ref_required: 'Name a credential reference.',
  provider_not_allowed: 'This provider is outside the workspace\'s Operator scope.',
  project_not_allowed: 'This project is outside the workspace\'s Operator scope.',
  environment_not_allowed: 'This environment is outside the workspace\'s Operator scope.',
  credential_ref_not_allowed: 'This credential reference is outside the workspace\'s Operator scope.',
};

export async function runDeploymentAction(
  principal: DeploymentPrincipal,
  rawBody: unknown,
  deps: DeploymentDeps,
): Promise<DeploymentResponse> {
  const parsed = parseDeploymentRequest(rawBody);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const req = parsed.request;
  const capabilities = [...DEPLOYMENT_OPERATIONS[req.operation].capabilities];
  const target: DeploymentTarget = { provider: req.provider, project: req.project, environment: req.environment, credentialRef: req.credentialRef };

  const workspaceId = principal.kind === 'operator' ? principal.grant.workspaceId : principal.workspaceId;
  const base = {
    teamId: principal.teamId,
    workspaceId,
    taskId: principal.kind === 'operator' ? principal.taskId : null,
    workerId: principal.kind === 'operator' ? principal.workerId : null,
    accountId: principal.accountId,
    principal: principal.kind,
    roleSlug: principal.kind === 'operator' ? principal.grant.roleSlug : null,
    operation: req.operation,
    capabilities,
    elevated: false,
    provider: req.provider,
    project: req.project,
    environment: req.environment,
    credentialRef: req.credentialRef,
  };

  if (principal.kind === 'operator') {
    for (const capability of capabilities) {
      const decision = authorizeAgent(principal.grant, capability, target);
      if (!decision.allowed) {
        // A denial is audited too, but never blocks on it: the answer is no either way.
        await deps.recordAudit({ ...base, outcome: 'denied', reason: `${capability}:${decision.reason}`, result: null }).catch(() => undefined);
        return { status: 403, body: { error: DENY_MESSAGES[decision.reason], reason: decision.reason, capability } };
      }
    }
  }

  const script = cloudflareScriptName(req.project, req.environment);
  const params = parseCloudflareParams(req.operation, req.params, script);
  if (!params.ok) return { status: 400, body: { error: params.error } };

  let auditId: string;
  try {
    auditId = await deps.recordAudit({ ...base, outcome: 'started', reason: null, result: null });
  } catch (err) {
    console.error('[deployments] audit write failed; refusing:', err instanceof Error ? err.message : err);
    return { status: 503, body: { error: 'The deployment audit trail is unavailable, so nothing was run. Try again.' } };
  }

  const cred = await deps.resolveCredential(principal.teamId, req.provider, req.credentialRef).catch(() => null);
  if (!cred) {
    await deps.settleAudit(auditId, 'failed', 'credential_not_found', null).catch(() => undefined);
    return { status: 404, body: { error: `No ${req.provider} credential with reference "${req.credentialRef}" is stored for this team.`, auditId } };
  }

  let outcome: Awaited<ReturnType<typeof runCloudflareOperation>>;
  try {
    outcome = await runCloudflareOperation(params, script, cred, deps.fetchImpl);
  } catch (err) {
    // A network throw can carry the request URL (which holds the account id); keep it out of the reply.
    console.error('[deployments] provider call threw:', err instanceof Error ? err.name : 'unknown');
    outcome = { ok: false, status: 502, error: `${req.provider} ${req.operation} failed: provider unreachable` };
  }

  const identity = { provider: req.provider, project: req.project, environment: req.environment, credentialRef: req.credentialRef };
  if (!outcome.ok) {
    await deps.settleAudit(auditId, 'failed', outcome.error, null).catch(() => undefined);
    return { status: outcome.status, body: { error: outcome.error, auditId, target: identity, operation: req.operation } };
  }
  await deps.settleAudit(auditId, 'succeeded', null, outcome.result).catch(() => undefined);
  return { status: 200, body: { ok: true, auditId, target: identity, operation: req.operation, result: outcome.result } };
}
