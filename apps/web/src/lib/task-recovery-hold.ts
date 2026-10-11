/**
 * Credential holds (failure-incident-recovery §18.3): the one writer that
 * parks a task whose worker died on a rejected credential, and releases it.
 *
 * An auth failure is the credential's, not the work's. With no other backend
 * to fail over to, the task goes back to `pending` behind a `startAt` floor
 * (the existing deferral every claim honours) and `context.credentialHold`
 * says why. It keeps `resumeBranch`, so the retry resumes the same branch and
 * PR. The floor is the next probe (15 min, 1 h, 4 h); after the third auth
 * failure the hold is exhausted and only a healthy credential or an operator
 * releases it. The task is never `failed` for it.
 *
 * Release goes through `releaseCredentialHolds`: from the credential write
 * path (`requeueAuthFailedTasks`), and from the `infrastructure_failure`
 * incident's `release_hold` repair once the credential checks healthy.
 *
 * The planners and `taskRecoverySentence` are pure; DB access is lazy.
 */

export const CREDENTIAL_HOLD_PROBE_MINUTES = [15, 60, 240] as const;
/** Auth failures per episode before the hold is exhausted. */
export const CREDENTIAL_HOLD_BUDGET = 3;
/** An exhausted hold's floor: far enough that only a release starts the task. */
export const CREDENTIAL_HOLD_EXHAUSTED_DAYS = 7;

export interface CredentialHold {
  /** `secret:<id>` for a credential Buildd holds; `account:<id>` for a runner's own login. */
  credentialKey: string;
  /** A team-wide credential every workspace of the team uses. */
  shared: boolean;
  /** Plain words for the credential ("the Claude login on runner account X"). */
  label: string;
  /** This hold's failure. Health after it means the credential recovered. */
  since: string;
  /** The episode's first failure on this credential. */
  firstHeldAt: string;
  /** Auth failures this episode, this one included. */
  attempts: number;
  /** When the floor lifts on its own (the next probe). */
  probeAt: string;
  exhausted: boolean;
  /** Set by a release: the floor was cleared and the task woken. */
  releasedAt?: string;
  releasedBy?: string;
  lastWorkerId?: string;
}

export interface CredentialIdentity {
  credentialKey: string;
  shared: boolean;
  label: string;
}

const addMinutes = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

export function readCredentialHold(context: unknown): CredentialHold | null {
  const h = (context as { credentialHold?: unknown } | null | undefined)?.credentialHold as CredentialHold | undefined;
  return h && typeof h === 'object' && typeof h.credentialKey === 'string' && typeof h.since === 'string' ? h : null;
}

/** Held now: carries a hold no release has lifted. */
export function isActivelyHeld(context: unknown): boolean {
  const h = readCredentialHold(context);
  return !!h && !h.releasedAt;
}

/**
 * Pure. The task row a credential hold writes: `pending`, the probe floor,
 * the hold, and the branch to resume. A prior hold on the same credential
 * continues the episode (attempts + 1); another credential starts a new one.
 */
export function planCredentialHold(input: {
  context: Record<string, unknown> | null | undefined;
  credential: CredentialIdentity;
  now: string;
  workerId?: string | null;
  branch?: string | null;
  lastCommitSha?: string | null;
  error?: string | null;
}): { startAt: Date; context: Record<string, unknown>; hold: CredentialHold } {
  const ctx = { ...(input.context ?? {}) };
  const prior = readCredentialHold(ctx);
  const sameEpisode = !!prior && prior.credentialKey === input.credential.credentialKey;
  const attempts = sameEpisode ? prior!.attempts + 1 : 1;
  const exhausted = attempts >= CREDENTIAL_HOLD_BUDGET;
  const probeAt = exhausted
    ? addMinutes(input.now, CREDENTIAL_HOLD_EXHAUSTED_DAYS * 24 * 60)
    : addMinutes(input.now, CREDENTIAL_HOLD_PROBE_MINUTES[attempts - 1] ?? CREDENTIAL_HOLD_PROBE_MINUTES[CREDENTIAL_HOLD_PROBE_MINUTES.length - 1]);
  const hold: CredentialHold = {
    ...input.credential,
    since: input.now,
    firstHeldAt: sameEpisode ? prior!.firstHeldAt : input.now,
    attempts,
    probeAt,
    exhausted,
    ...(input.workerId ? { lastWorkerId: input.workerId } : {}),
  };
  return {
    startAt: new Date(probeAt),
    hold,
    context: {
      ...ctx,
      credentialHold: hold,
      ...(input.branch ? { resumeBranch: input.branch } : {}),
      ...(input.branch && input.lastCommitSha ? { lastCommitSha: input.lastCommitSha } : {}),
      ...(input.workerId ? { previousWorkerId: input.workerId } : {}),
      failureContext: { summary: (input.error ?? 'The backend credential was rejected').slice(0, 300), errorType: 'auth_failure' },
    },
  };
}

/** Pure. The context a release leaves: the hold stays as history, marked released. */
export function releasedHoldContext(context: Record<string, unknown>, now: string, by: string): Record<string, unknown> {
  const h = readCredentialHold(context);
  if (!h || h.releasedAt) return context;
  return { ...context, credentialHold: { ...h, releasedAt: now, releasedBy: by } };
}

/** Pure. The one plain sentence a task surface shows for a hold (§18.6); null when not held. */
export function taskRecoverySentence(context: unknown, formatTime: (iso: string) => string = iso => iso.slice(11, 16)): string | null {
  const h = readCredentialHold(context);
  if (!h || h.releasedAt) return null;
  if (h.exhausted) return `Waiting for ${h.label} to be reconnected; the operator has been told.`;
  return `Waiting for a healthy credential (${h.label}); Buildd retries at ${formatTime(h.probeAt)}.`;
}

// ── DB ──────────────────────────────────────────────────────────────────────

/**
 * Which credential a failed session ran on. A runner on its own subscription
 * login (`authType: 'oauth'`) used that login; anything else used the team's
 * stored credential for the backend, when there is one.
 */
export async function resolveCredentialIdentity(input: {
  accountId: string;
  accountName?: string | null;
  authType?: string | null;
  teamId: string | null;
  workspaceId: string | null;
  backend: string | null;
}): Promise<CredentialIdentity> {
  const runnerLogin: CredentialIdentity = {
    credentialKey: `account:${input.accountId}`,
    shared: false,
    label: `the ${input.backend === 'codex' ? 'Codex' : 'Claude'} login on runner ${input.accountName ? `"${input.accountName}"` : `account ${input.accountId.slice(0, 8)}`}`,
  };
  if (input.authType === 'oauth' || !input.teamId) return runnerLogin;
  try {
    const [{ db }, { secrets }, { and, eq }, { getActiveClaudeSecretId }] = await Promise.all([
      import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('./credential-health'),
    ]);
    let secretId: string | null = null;
    if (input.backend === 'codex') {
      const row = await db.query.secrets.findFirst({
        where: and(eq(secrets.teamId, input.teamId), eq(secrets.purpose, 'codex_credential')),
        columns: { id: true },
      });
      secretId = row?.id ?? null;
    } else {
      secretId = await getActiveClaudeSecretId(input.teamId, input.workspaceId);
    }
    if (!secretId) return runnerLogin;
    const row = await db.query.secrets.findFirst({ where: eq(secrets.id, secretId), columns: { id: true, workspaceId: true, accountId: true } });
    const shared = !!row && !row.workspaceId && !row.accountId;
    return {
      credentialKey: `secret:${secretId}`,
      shared,
      label: `the team's ${input.backend === 'codex' ? 'Codex' : 'Claude'} credential`,
    };
  } catch {
    return runnerLogin;
  }
}

/**
 * Hold a task for its credential: `pending` behind the probe floor, never on
 * a cancelled task. Wakes at the probe so the floor lifting is delivered.
 */
export async function holdTaskForCredential(input: {
  taskId: string;
  context: Record<string, unknown> | null | undefined;
  credential: CredentialIdentity;
  workerId?: string | null;
  branch?: string | null;
  lastCommitSha?: string | null;
  error?: string | null;
  now?: string;
}): Promise<CredentialHold | null> {
  const [{ db }, { tasks }, { and, eq, not }, { wakeTask }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('./dispatch-authority'),
  ]);
  const now = input.now ?? new Date().toISOString();
  const plan = planCredentialHold({ ...input, now });
  const updated = await db
    .update(tasks)
    .set({
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
      expiresAt: null,
      startAt: plan.startAt,
      context: plan.context,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, input.taskId), not(eq(tasks.status, 'cancelled'))))
    .returning({ id: tasks.id });
  if (!updated?.length) return null;
  // An exhausted hold waits for a release, not a clock.
  if (!plan.hold.exhausted) await wakeTask(input.taskId, 'task.requeued', { notBefore: plan.startAt });
  return plan.hold;
}

/**
 * Release held tasks: clear the floor, stamp the release, wake them as
 * `credential.restored`. Only `pending` rows whose hold is still active are
 * touched; select by task ids and/or credential key (team-bounded). Returns
 * the released ids. Idempotent: a released hold is skipped.
 */
export async function releaseCredentialHolds(input: {
  taskIds?: readonly string[];
  credentialKey?: string;
  teamId?: string;
  by: string;
  now?: string;
}): Promise<string[]> {
  const [{ db }, { tasks, workspaces }, { and, eq, inArray, sql }, { wakeTasks }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('./dispatch-authority'),
  ]);
  if (!input.taskIds?.length && !input.credentialKey && !input.teamId) return [];
  const now = input.now ?? new Date().toISOString();
  const conds = [eq(tasks.status, 'pending'), sql`${tasks.context} ? 'credentialHold'`];
  if (input.taskIds?.length) conds.push(inArray(tasks.id, [...input.taskIds]));
  if (input.credentialKey) conds.push(sql`${tasks.context}->'credentialHold'->>'credentialKey' = ${input.credentialKey}`);
  const rows = input.teamId
    ? await db.select({ id: tasks.id, context: tasks.context }).from(tasks)
      .innerJoin(workspaces, eq(tasks.workspaceId, workspaces.id))
      .where(and(eq(workspaces.teamId, input.teamId), ...conds)).limit(200)
    : await db.select({ id: tasks.id, context: tasks.context }).from(tasks).where(and(...conds)).limit(200);

  const released: string[] = [];
  for (const r of rows) {
    const ctx = (r.context ?? {}) as Record<string, unknown>;
    if (!isActivelyHeld(ctx)) continue;
    const done = await db
      .update(tasks)
      .set({ startAt: null, context: releasedHoldContext(ctx, now, input.by), updatedAt: new Date() })
      .where(and(eq(tasks.id, r.id), eq(tasks.status, 'pending')))
      .returning({ id: tasks.id });
    if (done?.length) released.push(r.id);
  }
  if (released.length) await wakeTasks(released, 'credential.restored');
  return released;
}
