/**
 * Personal agent credentials on a host claim (provider parity, slice 5).
 *
 * A team that has explicitly set `teams.credential_policy` lets the person a
 * task is for (its requester, `resolveTaskRequesterUserId`) run it on their own
 * API key. This module decides, per claimed task, whether that happens, and
 * attaches the key in the wire shape the runner already reads.
 *
 * ## The safety property
 *
 * A credential row with `user_id` set reaches ONLY a task whose requester is
 * that user, and only when the team's policy is `personal_first` or
 * `personal_only`. The resolver (`@buildd/core/providers/resolve`) can only
 * return such a row through `user_id = requester` (in SQL and again in JS);
 * this module adds no other path to one.
 *
 * ## Decisions
 *
 * | team policy           | outcome                                                                         |
 * |-----------------------|---------------------------------------------------------------------------------|
 * | NULL                  | `legacy`: nothing read, nothing written. The claim is byte-identical to before. |
 * | `team`                | `legacy`, plus a `credentialDecision` marker (no secret).                       |
 * | `personal_first`      | requester's own key ⇒ `personal`; otherwise `legacy` (team credentials).        |
 * | `personal_only`       | requester's own key ⇒ `personal`; otherwise `refuse` (`no_personal_credential`). |
 *
 * Under `personal`, `withhold` and `refuse` no team model credential (Anthropic
 * key, seat, Claude/Codex credential, endpoint, pre-refresh list) is attached
 * for the worker; MCP and role secrets are not model credentials and still go.
 *
 * ## Limits, deliberately
 *
 * - **Runner feature.** A personal key is delivered only to a runner that
 *   declares `PERSONAL_CREDENTIAL_RUNNER_FEATURE`. Older runners cache
 *   `serverApiKey` per TEAM and reuse it for later workers of that team whose
 *   claim carried none, which would hand one person's key to another person's
 *   task. A runner that declares the feature keeps a `scope: personal` (or
 *   `none`) credential out of that cache (apps/runner/src/workers.ts
 *   startFromClaim). A runner without the feature never receives one: under
 *   `personal_first` it gets the team credentials, under `personal_only` the
 *   task is deferred for a runner that can take it.
 * - **API keys only.** Anthropic for Claude tasks, OpenAI for Codex tasks.
 *   Personal subscription seats are pending in the registry; personal
 *   endpoints are not a registry scope.
 * - **Cloud claims** never carry a model credential: cloud egress
 *   (`/api/runner/model-endpoint`) resolves the route per run with the same
 *   requester rule. Here `personal_only` only checks that egress would find a
 *   personal route, and defers the task when it would not.
 * - **Interactive sessions** (claim_task from a person's own session) run on
 *   that person's machine: `personal_only` withholds team model credentials
 *   instead of refusing.
 */
import type { ClaimCredentialDecision, ClaimTasksResponse } from '@buildd/shared';
import {
  NO_PERSONAL_CREDENTIAL,
  PERSONAL_CREDENTIAL_RUNNER_FEATURE,
  surfacePolicy,
  type CredentialPolicy,
  type ProviderId,
  type TeamPolicyColumns,
} from '@buildd/core/providers';
import type { ProviderCredentialResult, ResolveProviderCredentialInput } from '@buildd/core/providers/resolve';
import type { RequesterTaskFields } from '@buildd/core/task-requester';

export { PERSONAL_CREDENTIAL_RUNNER_FEATURE };

export type AgentCredentialSurface = 'agent-claude' | 'agent-codex';

export type PersonalCredentialDecision =
  /** Today's claim. `marker` is set only when the team has a policy. */
  | { kind: 'legacy'; marker?: ClaimCredentialDecision }
  /** The requester's own key; the only model credential for this worker. */
  | { kind: 'personal'; provider: ProviderId; value: string; marker: ClaimCredentialDecision }
  /** No model credential at all (an interactive session under personal_only). */
  | { kind: 'withhold'; marker: ClaimCredentialDecision }
  /** Do not claim: the policy needs a personal key this claim cannot deliver. */
  | { kind: 'refuse'; detail: { cause: PersonalRefusalCause; policy: CredentialPolicy; surface: AgentCredentialSurface } };

export type PersonalRefusalCause =
  /** The task has no requester (schedule, webhook, cron work). */
  | 'no_requester'
  /** The requester has stored no key for this backend's provider. */
  | 'requester_has_no_key'
  /** The requester has a key, but this runner cannot be trusted with it yet. */
  | 'runner_lacks_feature';

export interface PersonalCredentialInput {
  task: RequesterTaskFields & { id: string; backend?: string | null };
  teamId: string;
  workspaceId: string;
  accountId: string;
  runnerFeatures: unknown;
  cloud: boolean;
  interactive: boolean;
}

export interface PersonalCredentialDeps {
  loadTeam: (teamId: string) => Promise<TeamPolicyColumns | null>;
  requesterOf: (task: RequesterTaskFields & object) => Promise<string | null>;
  resolve: (input: ResolveProviderCredentialInput) => Promise<ProviderCredentialResult>;
}

/** The surface and the personal API-key provider a task's backend runs on. */
export function agentSurfaceFor(backend: string | null | undefined): { surface: AgentCredentialSurface; provider: ProviderId } {
  return backend === 'codex'
    ? { surface: 'agent-codex', provider: 'openai' }
    : { surface: 'agent-claude', provider: 'anthropic' };
}

export function runnerSupportsPersonalCredentials(runnerFeatures: unknown): boolean {
  return Array.isArray(runnerFeatures) && runnerFeatures.includes(PERSONAL_CREDENTIAL_RUNNER_FEATURE);
}

const defaultDeps: PersonalCredentialDeps = {
  loadTeam: async (teamId) => {
    const [{ db }, { teams }, { eq }] = await Promise.all([
      import('@buildd/core/db'),
      import('@buildd/core/db/schema'),
      import('drizzle-orm'),
    ]);
    const row = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { credentialPolicy: true },
    });
    return row ?? null;
  },
  requesterOf: async (task) => (await import('@buildd/core/task-requester')).requesterOf(task),
  resolve: async (input) => (await import('@buildd/core/providers/resolve')).resolveProviderCredential(input),
};

/** The default deps with the team-policy read memoized: one read per team per claim request. */
export function perRequestPersonalCredentialDeps(): PersonalCredentialDeps {
  const teams = new Map<string, Promise<TeamPolicyColumns | null>>();
  return {
    ...defaultDeps,
    loadTeam: (teamId) => {
      let p = teams.get(teamId);
      if (!p) {
        p = defaultDeps.loadTeam(teamId);
        teams.set(teamId, p);
      }
      return p;
    },
  };
}

/**
 * Decide one claimed task's model credential. Never throws: a lookup failure
 * reads as "no policy" (legacy) when the team's policy cannot be read, and as
 * "no personal key" once it is known (so `personal_only` refuses rather than
 * falling back to team keys).
 */
export async function decidePersonalCredential(
  input: PersonalCredentialInput,
  deps: PersonalCredentialDeps = defaultDeps,
): Promise<PersonalCredentialDecision> {
  let team: TeamPolicyColumns | null;
  try {
    team = await deps.loadTeam(input.teamId);
  } catch (err) {
    console.warn(`[claim] credential policy lookup failed for team ${input.teamId}; using team credentials:`, err);
    return { kind: 'legacy' };
  }
  const { surface, provider } = agentSurfaceFor(input.task.backend);
  const sp = surfacePolicy({ credentialPolicy: team?.credentialPolicy }, surface);
  // NULL policy: agent runs keep today's credentials, and the claim gains nothing.
  if (!sp.enforced) return { kind: 'legacy' };
  const policy = sp.policy;
  const marker = (scope: ClaimCredentialDecision['scope'], extra: Partial<ClaimCredentialDecision> = {}): ClaimCredentialDecision => ({
    surface, policy, scope, runnerLocalAllowed: true, ...extra,
  });
  if (policy === 'team') return { kind: 'legacy', marker: marker('team') };

  const refuse = (cause: PersonalRefusalCause): PersonalCredentialDecision => ({ kind: 'refuse', detail: { cause, policy, surface } });
  const fallBack = (): PersonalCredentialDecision =>
    policy === 'personal_first' ? { kind: 'legacy', marker: marker('team') } : refuse('requester_has_no_key');

  if (input.interactive) {
    // The person's own session runs it with their own login.
    return policy === 'personal_only'
      ? { kind: 'withhold', marker: marker('none') }
      : { kind: 'legacy', marker: marker('team') };
  }
  let requester: string | null = null;
  try {
    requester = await deps.requesterOf(input.task);
  } catch {
    requester = null;
  }
  if (!requester) return policy === 'personal_first' ? { kind: 'legacy', marker: marker('team') } : refuse('no_requester');

  if (input.cloud) {
    // The container carries no credential: cloud egress resolves the route
    // itself, per run, with the same requester rule. personal_first needs
    // nothing here; personal_only is held at claim when egress would find no
    // personal route, instead of failing inside a started run.
    if (policy === 'personal_first') return { kind: 'legacy' };
    try {
      const r = await deps.resolve({
        teamId: input.teamId, workspaceId: input.workspaceId, accountId: input.accountId,
        requesterUserId: requester, surface: 'cloud-egress', team: { credentialPolicy: policy },
      });
      return !r.none && r.scope === 'personal' ? { kind: 'legacy' } : refuse('requester_has_no_key');
    } catch (err) {
      console.warn(`[claim] personal credential lookup failed for task ${input.task.id}:`, err);
      return refuse('requester_has_no_key');
    }
  }

  let result: ProviderCredentialResult;
  try {
    result = await deps.resolve({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      requesterUserId: requester,
      surface,
      provider,
      team: { credentialPolicy: policy },
    });
  } catch (err) {
    console.warn(`[claim] personal credential lookup failed for task ${input.task.id}:`, err);
    return fallBack();
  }
  if (result.none || result.scope !== 'personal' || !result.credential.value) return fallBack();
  if (!runnerSupportsPersonalCredentials(input.runnerFeatures)) {
    return policy === 'personal_first' ? { kind: 'legacy', marker: marker('team') } : refuse('runner_lacks_feature');
  }
  return {
    kind: 'personal',
    provider: result.provider,
    value: result.credential.value,
    // Under personal_only a machine's own login must not displace the
    // requester's key; under personal_first the operator's machine config
    // keeps winning, as it does over team credentials today.
    marker: marker('personal', { provider: result.provider, runnerLocalAllowed: policy !== 'personal_only' }),
  };
}

/**
 * Write each claimed worker's decision onto the claim. Returns the workers
 * whose model credential is decided here (personal or withheld): every team
 * model-credential attach step must skip them.
 */
export function attachPersonalCredentials(
  claimedWorkers: ClaimTasksResponse['workers'],
  decisions: ReadonlyMap<string, PersonalCredentialDecision>,
): Set<string> {
  const owned = new Set<string>();
  for (const cw of claimedWorkers) {
    const d = decisions.get(cw.taskId);
    if (!d || d.kind === 'refuse') continue;
    const w = cw as typeof cw & { codexCredential?: unknown };
    if (d.marker) w.credentialDecision = d.marker;
    if (d.kind === 'legacy') continue;
    owned.add(cw.id);
    if (d.kind === 'personal') {
      if (d.marker.surface === 'agent-codex') {
        w.codexCredential = { credentialType: 'api_key', apiKey: d.value, expiresAt: null };
      } else {
        w.serverApiKey = d.value;
      }
      console.log(`[claim] attached the requester's own ${d.provider} key for worker ${cw.id}`);
    }
  }
  return owned;
}

export { NO_PERSONAL_CREDENTIAL };
