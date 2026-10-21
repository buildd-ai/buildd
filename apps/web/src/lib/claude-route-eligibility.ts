/**
 * Which Claude route is open to queued work, from signals that already exist
 * (spec 97b1bd0b AC-6, R-11). Local login readiness (an online `oauth` runner)
 * and managed-key readiness (the team's Anthropic API key row) are separate
 * eligibility signals: an unavailable managed key is a blocker only when no
 * local login can take the work.
 *
 * Pure and DB-free: it is imported by a client component. It reports; it
 * withholds nothing and does not own scheduling policy.
 */
import { isRunnerOnline, type RunnerHeartbeat } from './runner-heartbeats-shared';

export type ClaudeRouteState = 'eligible' | 'blocked' | 'unknown';

export interface ClaudeRouteEligibility {
  state: ClaudeRouteState;
  /** Routes that can take Claude work right now. */
  eligibleVia: Array<'local_login' | 'managed_key'>;
  localLogin: 'ready' | 'none';
  managedKey: 'ready' | 'unavailable' | 'not_configured';
  /** One line, no secrets. */
  summary: string;
}

/** The claim scheduler's newest recorded decision for Claude work, when one exists. */
export interface RouteDecision { state: 'blocked' | 'stale' | 'unknown'; kind: string | null }

interface CredentialLike { purpose: string; healthStatus: string }

const MANAGED_KEY_PURPOSES = new Set(['anthropic_api_key', 'inference_key']);

export function resolveClaudeRoute(
  runners: readonly Pick<RunnerHeartbeat, 'lastHeartbeatAt' | 'authType'>[],
  credentials: readonly CredentialLike[],
  now: number,
  /** Authoritative scheduler decision; without a fresh credential refusal nothing is called blocked. */
  decision?: RouteDecision | null,
): ClaudeRouteEligibility {
  const online = runners.filter(r => isRunnerOnline(r.lastHeartbeatAt, now));
  const localLogin = online.some(r => r.authType === 'oauth') ? 'ready' : 'none';
  const keys = credentials.filter(c => MANAGED_KEY_PURPOSES.has(c.purpose));
  const managedKey = keys.length === 0
    ? 'not_configured'
    : keys.some(k => k.healthStatus === 'healthy' || k.healthStatus === 'unknown') ? 'ready' : 'unavailable';

  const eligibleVia: ClaudeRouteEligibility['eligibleVia'] = [];
  if (localLogin === 'ready') eligibleVia.push('local_login');
  if (managedKey === 'ready') eligibleVia.push('managed_key');

  const keyWord = managedKey === 'unavailable' ? 'managed API key unavailable'
    : managedKey === 'not_configured' ? 'no managed API key' : 'managed API key ready';
  if (eligibleVia.length > 0) {
    const via = localLogin === 'ready' ? 'local login' : 'managed API key';
    return {
      state: 'eligible', eligibleVia, localLogin, managedKey,
      summary: localLogin === 'ready' && managedKey !== 'ready'
        ? `Claude work is eligible via a runner's local login; ${keyWord}, which does not block it`
        : `Claude work is eligible via ${via}`,
    };
  }
  if (online.length === 0 && managedKey === 'not_configured') {
    return { state: 'unknown', eligibleVia, localLogin, managedKey, summary: 'Claude route unknown: no runner online and no managed API key' };
  }
  const inferred = `no local login online, ${keyWord}`;
  if (decision?.state === 'blocked' && decision.kind === 'credential_unavailable') {
    return { state: 'blocked', eligibleVia, localLogin, managedKey, summary: `Claude work has no open route: ${inferred} (claim scheduler refused it)` };
  }
  return {
    state: 'unknown', eligibleVia, localLogin, managedKey,
    summary: `Claude route not confirmed by the claim scheduler: ${inferred} (inferred from heartbeats and stored keys)`,
  };
}
