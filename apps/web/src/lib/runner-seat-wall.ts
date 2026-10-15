/**
 * Whose Claude limit is this? A runner-scoped wall (task e68327a1).
 *
 * Several host runners can share one runner account (one bld_ key), each
 * running Claude on its own machine's login (`claude login`, or
 * CLAUDE_CODE_OAUTH_TOKEN set on that machine). When one of those logins hits
 * its session or weekly limit, the limit is that machine's, not the account's
 * or the team's: the other runners' logins are fine. Recording it on the
 * account flag or as a team-wide provider pause held every Claude task for
 * every runner until the reset, which for a weekly limit is days.
 *
 * So a wall is scoped to the runner that hit it, by a seat key, only when all
 * of these hold:
 *
 * - it is a Claude subscription wall (session, weekly or extra-usage text),
 *   not an API rate limit or a Codex wall;
 * - it is not tenant work (that has its own tenant budget) and not a cloud
 *   run (cloud egress never uses a machine login);
 * - the worker names the runner that ran it (`workers.runner`, the id every
 *   runner already sends on claim);
 * - that runner's heartbeat says its agents use the machine's own login
 *   (`modelAuthSource` machine_login or machine_token);
 * - the team stores no Claude model credential this run could have been
 *   handed instead (an Anthropic key, a server-side OAuth token or a managed
 *   Claude credential), and the team's agent model endpoint does not carry
 *   Claude. Those are pools every runner draws on, so their walls stay shared.
 *
 * Anything else, including any lookup failure, answers "shared": today's
 * account-wide and team-wide behaviour. The key is a hash of the runner id: no
 * credential and no login is read, stored or sent.
 */
import { createHash } from 'crypto';
import { INTERACTIVE_RUNNER, UNVERIFIED_INTERACTIVE_RUNNER } from './interactive-session';
import { NON_RUNNER_EXECUTOR_IDS } from './executor';
import {
  CLAUDE_SESSION_LIMIT_PATTERN,
  CLAUDE_WEEKLY_LIMIT_PATTERN,
} from '@buildd/core/budget-error-classifier';

/** Runner ids that do not name one runner process. */
const NOT_A_RUNNER_ID = new Set<string>([
  'runner', // the runner client's default when it was given no id
  INTERACTIVE_RUNNER,
  UNVERIFIED_INTERACTIVE_RUNNER,
  ...NON_RUNNER_EXECUTOR_IDS,
]);

/**
 * The seat key for a runner id, or null when the caller is not one named
 * runner. Opaque on purpose: the runner id can be a host name or a URL.
 */
export function runnerSeatKey(runner: string | null | undefined): string | null {
  const id = (runner ?? '').trim();
  if (!id || NOT_A_RUNNER_ID.has(id)) return null;
  return `runner:${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

/** Claude subscription walls: what a machine login can run into. */
const MACHINE_LOGIN_WALL_PATTERNS: readonly string[] = [
  CLAUDE_SESSION_LIMIT_PATTERN,
  'session limit',
  CLAUDE_WEEKLY_LIMIT_PATTERN,
  'weekly limit',
  'out of extra usage',
];

export function isMachineLoginWallError(error?: string | null): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return MACHINE_LOGIN_WALL_PATTERNS.some(p => lower.includes(p));
}

export type HeartbeatModelAuthSource = 'machine_token' | 'machine_login' | 'api_key' | 'none';

export interface RunnerSeatWallInput {
  /** The backend this run used (claimedBackendOf). */
  backend: string | null | undefined;
  error: string | null | undefined;
  /** workers.runner */
  runner: string | null | undefined;
  /** workers.claimedByCloud */
  claimedByCloud: boolean | null | undefined;
  tenantId: string | null | undefined;
  accountId: string;
  teamId: string | null | undefined;
  workspaceId: string | null | undefined;
}

export interface RunnerSeatWallDeps {
  /** The runner's last reported model auth, or null when it reported none. */
  heartbeatModelAuthSource: (accountId: string, runner: string) => Promise<HeartbeatModelAuthSource | null>;
  /** True when the team stores a Claude model credential this account and workspace can be handed. */
  teamClaudeCredentialVisible: (scope: { teamId: string; accountId: string; workspaceId: string }) => Promise<boolean>;
  /** True when the team's agent model endpoint wins the Claude route. */
  teamEndpointWins: (scope: { teamId: string; accountId: string; workspaceId: string }) => Promise<boolean>;
}

export interface RunnerSeatWallDecision {
  /** Set: the wall holds only this runner. Null: the wall is shared. */
  seatKey: string | null;
  /** Why, for the log line. */
  reason: string;
}

const MACHINE_SOURCES: ReadonlySet<string> = new Set(['machine_login', 'machine_token']);

async function defaultHeartbeatModelAuthSource(accountId: string, runner: string): Promise<HeartbeatModelAuthSource | null> {
  const { db } = await import('@buildd/core/db');
  const { workerHeartbeats } = await import('@buildd/core/db/schema');
  const { and, eq } = await import('drizzle-orm');
  const { sqlWhere } = await import('@buildd/core/db/relational-sql');
  const row = await db.query.workerHeartbeats.findFirst({
    where: sqlWhere(and(eq(workerHeartbeats.accountId, accountId), eq(workerHeartbeats.localUiUrl, runner))),
    columns: { modelAuthSource: true },
  });
  return (row?.modelAuthSource as HeartbeatModelAuthSource | null | undefined) ?? null;
}

async function defaultTeamClaudeCredentialVisible(scope: { teamId: string; accountId: string; workspaceId: string }): Promise<boolean> {
  const { db } = await import('@buildd/core/db');
  const { secrets } = await import('@buildd/core/db/schema');
  const { eq, isNull, or } = await import('drizzle-orm');
  const { sqlWhere } = await import('@buildd/core/db/relational-sql');
  const { teamCredentialWhere } = await import('@buildd/core/secrets/team-scope');
  const { agentKeyPurposes } = await import('@buildd/core/providers/agent-keys');
  // Same scoping the claim uses to hand credentials out: team-wide, this
  // account, this workspace; personal rows are excluded by teamCredentialWhere.
  const rows = await db.query.secrets.findMany({
    where: sqlWhere(teamCredentialWhere(
      { teamId: scope.teamId, purpose: [...agentKeyPurposes('anthropic'), 'oauth_token', 'claude_credential'] },
      or(isNull(secrets.accountId), eq(secrets.accountId, scope.accountId)),
      or(isNull(secrets.workspaceId), eq(secrets.workspaceId, scope.workspaceId)),
    )),
    columns: { id: true, healthStatus: true },
  });
  return (rows ?? []).some(r => r.healthStatus !== 'revoked');
}

async function defaultTeamEndpointWins(scope: { teamId: string; accountId: string; workspaceId: string }): Promise<boolean> {
  const { resolveAgentModelRoute } = await import('@buildd/core/agent-endpoint');
  const decision = await resolveAgentModelRoute({ ...scope, backend: 'claude' });
  return decision?.winner === 'endpoint';
}

const DEFAULT_DEPS: RunnerSeatWallDeps = {
  heartbeatModelAuthSource: (a, r) => defaultHeartbeatModelAuthSource(a, r),
  teamClaudeCredentialVisible: (s) => defaultTeamClaudeCredentialVisible(s),
  teamEndpointWins: (s) => defaultTeamEndpointWins(s),
};

/** Decide whether a recorded wall belongs to one runner's own login. Never throws. */
export async function resolveRunnerSeatWallKey(
  input: RunnerSeatWallInput,
  deps: RunnerSeatWallDeps = DEFAULT_DEPS,
): Promise<RunnerSeatWallDecision> {
  const shared = (reason: string): RunnerSeatWallDecision => ({ seatKey: null, reason });
  if ((input.backend || 'claude') !== 'claude') return shared('not a Claude wall');
  if (!isMachineLoginWallError(input.error)) return shared('not a subscription session or weekly limit');
  if (input.tenantId) return shared('tenant work: the tenant budget is the wall');
  if (input.claimedByCloud) return shared('cloud run: no machine login');
  if (!input.teamId || !input.workspaceId) return shared('no team or workspace');
  const runner = (input.runner ?? '').trim();
  const seatKey = runnerSeatKey(runner);
  if (!seatKey) return shared('the worker names no runner');
  const scope = { teamId: input.teamId, accountId: input.accountId, workspaceId: input.workspaceId };
  try {
    const source = await deps.heartbeatModelAuthSource(input.accountId, runner);
    if (!source || !MACHINE_SOURCES.has(source)) {
      return shared(`runner model auth is ${source ?? 'not reported'}, not its own machine login`);
    }
    if (await deps.teamClaudeCredentialVisible(scope)) return shared('the team stores a Claude credential every runner may use');
    if (await deps.teamEndpointWins(scope)) return shared("the team's agent model endpoint carries Claude");
  } catch (err) {
    console.warn('[runner-seat-wall] lookup failed; keeping the wall shared:', err);
    return shared('lookup failed');
  }
  return { seatKey, reason: "the runner's own machine login" };
}
