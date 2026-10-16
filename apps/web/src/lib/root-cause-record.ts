/**
 * Root causes: one record per cause per team (`root_causes`), written by the
 * detection buildd already runs and read through the platform-owner API.
 *
 * Two writers:
 *   - The worker outcome path. A failed run whose error is an auth failure on
 *     its runner records a runner/provider cause; a completed run is the
 *     capability check that clears causes on that runner and provider.
 *   - The failure-pattern sweep. Each pattern it detects records a platform
 *     cause for the workspace's team, classified by the rule that found it.
 *
 * Classification reads structured fields only: the error class, the runner
 * account's `authType` / `managedRunner`, the sweep rule. Never error text,
 * never a model call. A cause clears only when a run on the affected
 * capability succeeds after the cause was last seen (`restores`); a repeat of
 * the same cause after that reopens the same record.
 *
 * The record holds classification, not operator state: no severity, paging,
 * acknowledgement, fix task or verdict. The pure parts are tested directly;
 * `createDbRootCausePort` is the only part that touches Postgres.
 */
import { classifyAuthErrorSeverity } from '@buildd/core/auth-error-classifier';
import type {
  RootCauseCapability,
  RootCauseCapabilityKind,
  RootCauseClassification,
  RootCauseRecord,
} from '@buildd/shared';

/** Newest task ids kept on a record. */
export const MAX_ROOT_CAUSE_TASK_IDS = 200;

// ── Classification (pure) ────────────────────────────────────────────────────

/** The structured class of a run's failure, as far as root causes care. */
export type RunnerErrorClass = 'auth_failure';

/**
 * The run's error as a structured class, from the shared auth classifier the
 * claim breaker and credential health already use. Classification below reads
 * only this class, never the text.
 */
export function runnerErrorClass(error: string | null | undefined): RunnerErrorClass | null {
  if (!error?.trim()) return null;
  return classifyAuthErrorSeverity(error) === 'none' ? null : 'auth_failure';
}

/** The runner account fields that decide who holds a credential. */
export interface RunnerFacts {
  id: string;
  authType: 'api' | 'oauth';
  managedRunner: boolean;
  hostRunner: boolean;
  createdByUserId: string | null;
}

/**
 * An auth failure on a runner. A hosted runner runs on a team provider key, so
 * its failure is that key's and never a sign-in. A self-hosted `api` runner's
 * key was refused. Only a self-hosted `oauth` runner has a subscription
 * sign-in that can expire. Who acts on each (`hostRunner`, `createdByUserId`)
 * is the projection's business, not the classification's.
 */
export function classifyRunnerFailure(
  errorClass: RunnerErrorClass,
  runner: Pick<RunnerFacts, 'authType' | 'managedRunner'>,
): { classification: RootCauseClassification; kind: RootCauseCapabilityKind } {
  void errorClass; // the only class today; a new one gets its own branch here
  if (runner.managedRunner) return { classification: 'api_key_rejected', kind: 'provider' };
  if (runner.authType === 'oauth') return { classification: 'credential_expired', kind: 'runner' };
  return { classification: 'api_key_rejected', kind: 'runner' };
}

/**
 * Sweep rules whose subject is buildd's own machinery (stuck gates, retry
 * lineage, path claims, provider attribution): no one on the team holds the
 * fix. Every other rule (repeated failures, a failure-rate spike, unmet output)
 * says work is failing without establishing why, so it is `unknown`.
 */
const PLATFORM_RULES: ReadonlySet<string> = new Set([
  'retry_fork',
  'lineage_multi_pr',
  'stranded_gate',
  'path_overlap_stall',
  'provider_attribution_mismatch',
]);

export function classifyPattern(rule: string): RootCauseClassification {
  return PLATFORM_RULES.has(rule) ? 'platform_managed' : 'unknown';
}

// ── Observations (pure) ──────────────────────────────────────────────────────

/** One sighting of a cause; the store folds sightings with the same team and key. */
export interface RootCauseObservation {
  key: string;
  teamId: string;
  capability: RootCauseCapability;
  classification: RootCauseClassification;
  taskIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export function runnerFailureObservation(input: {
  teamId: string;
  runner: RunnerFacts;
  provider: string;
  errorClass: RunnerErrorClass;
  taskId: string | null;
  at: string;
}): RootCauseObservation {
  const { classification, kind } = classifyRunnerFailure(input.errorClass, input.runner);
  return {
    key: `credential:${input.runner.id}:${input.provider}`,
    teamId: input.teamId,
    capability: { kind, runnerId: input.runner.id, provider: input.provider, component: null, workspaceId: null },
    classification,
    taskIds: input.taskId ? [input.taskId] : [],
    firstSeenAt: input.at,
    lastSeenAt: input.at,
  };
}

export function patternObservation(input: {
  teamId: string;
  workspaceId: string;
  rule: string;
  taskIds: readonly string[];
  firstObservedAt: string;
  lastObservedAt: string;
}): RootCauseObservation {
  return {
    key: `pattern:${input.rule}:${input.workspaceId}`,
    teamId: input.teamId,
    capability: { kind: 'platform', runnerId: null, provider: null, component: input.rule, workspaceId: input.workspaceId },
    classification: classifyPattern(input.rule),
    taskIds: [...input.taskIds],
    firstSeenAt: input.firstObservedAt,
    lastSeenAt: input.lastObservedAt,
  };
}

/** Newest first, deduplicated, capped. */
function mergeTaskIds(newer: readonly string[], older: readonly string[]): string[] {
  return [...new Set([...newer, ...older])].slice(0, MAX_ROOT_CAUSE_TASK_IDS);
}

/**
 * Folds a sighting into the stored record (or starts one). The pure twin of
 * the store's upsert. A sighting from after a verified restore reopens the
 * record; one from before it (a late report) leaves it restored.
 */
export function foldObservation(prior: RootCauseRecord | null, obs: RootCauseObservation): RootCauseRecord {
  if (!prior) {
    return {
      key: obs.key, teamId: obs.teamId, capability: obs.capability, classification: obs.classification,
      affectedTaskIds: mergeTaskIds(obs.taskIds, []), firstSeenAt: obs.firstSeenAt, lastSeenAt: obs.lastSeenAt,
      verifiedRestoredAt: null,
    };
  }
  const restored = prior.verifiedRestoredAt;
  return {
    ...prior,
    capability: obs.capability,
    classification: obs.classification,
    affectedTaskIds: mergeTaskIds(obs.taskIds, prior.affectedTaskIds),
    firstSeenAt: obs.firstSeenAt < prior.firstSeenAt ? obs.firstSeenAt : prior.firstSeenAt,
    lastSeenAt: obs.lastSeenAt > prior.lastSeenAt ? obs.lastSeenAt : prior.lastSeenAt,
    verifiedRestoredAt: restored && obs.lastSeenAt <= restored ? restored : null,
  };
}

// ── Capability checks (pure) ─────────────────────────────────────────────────

/**
 * A run that succeeded: proof that its runner, its provider and its workspace
 * work at `at`. The only thing that clears a root cause.
 */
export interface CapabilityCheck {
  teamId: string;
  runnerId: string | null;
  provider: string;
  workspaceId: string | null;
  at: string;
}

/**
 * Does this passing check verify the cause restored? Only an active cause last
 * seen before the check, and only on the capability that broke: the same
 * runner and provider for a credential, the same workspace for a platform
 * cause. A success elsewhere proves nothing about it.
 */
export function restores(record: RootCauseRecord, check: CapabilityCheck): boolean {
  if (record.verifiedRestoredAt || record.teamId !== check.teamId || record.lastSeenAt >= check.at) return false;
  const cap = record.capability;
  if (cap.kind === 'platform') return !!cap.workspaceId && cap.workspaceId === check.workspaceId;
  return !!cap.runnerId && cap.runnerId === check.runnerId && cap.provider === check.provider;
}

// ── Store port ───────────────────────────────────────────────────────────────

export interface RootCauseStorePort {
  upsert(obs: RootCauseObservation): Promise<void>;
  /** Marks every record the check restores (see `restores`); returns how many. */
  verifyRestored(check: CapabilityCheck): Promise<number>;
}

/** What the outcome path needs to read; DB-backed by default. */
export interface OutcomeFactsPort {
  /** The task's team, workspace and agent backend. */
  task(taskId: string): Promise<{ teamId: string; workspaceId: string; provider: string } | null>;
  runner(accountId: string): Promise<RunnerFacts | null>;
}

/**
 * The worker outcome path: a failed run with an auth failure records its
 * runner's cause; a completed run verifies its runner, provider and workspace.
 * Any other outcome does nothing.
 */
export async function recordRootCauseForOutcome(
  input: { taskId: string | null; accountId: string | null; status: string; error: string | null | undefined; at?: string },
  deps?: { store?: RootCauseStorePort; facts?: OutcomeFactsPort },
): Promise<void> {
  if (!input.taskId || (input.status !== 'failed' && input.status !== 'completed')) return;
  const errorClass = input.status === 'failed' ? runnerErrorClass(input.error) : null;
  if (input.status === 'failed' && (!errorClass || !input.accountId)) return;

  const facts = deps?.facts ?? dbOutcomeFacts;
  const task = await facts.task(input.taskId);
  if (!task) return;
  const store = deps?.store ?? dbRootCauseStore;
  const at = input.at ?? new Date().toISOString();

  if (input.status === 'completed') {
    await store.verifyRestored({ teamId: task.teamId, runnerId: input.accountId, provider: task.provider, workspaceId: task.workspaceId, at });
    return;
  }
  const runner = await facts.runner(input.accountId!);
  if (!runner) return;
  await store.upsert(runnerFailureObservation({ teamId: task.teamId, runner, provider: task.provider, errorClass: errorClass!, taskId: input.taskId, at }));
}

/** A detected sweep pattern, reduced to what a root cause reads. */
export interface PatternSighting {
  rule: string;
  workspaceId: string | null;
  taskIds: readonly string[];
  firstObservedAt: string;
  lastObservedAt: string;
}

/**
 * The sweep path: one platform cause per detected pattern, on the team that
 * owns the workspace. A pattern with no workspace (the sweep watching itself)
 * has no team and records nothing.
 */
export async function recordPatternRootCauses(
  workspaceId: string,
  sightings: readonly PatternSighting[],
  deps: { store: RootCauseStorePort; teamOfWorkspace(workspaceId: string): Promise<string | null> },
): Promise<number> {
  const scoped = sightings.filter(s => s.workspaceId === workspaceId);
  if (scoped.length === 0) return 0;
  const teamId = await deps.teamOfWorkspace(workspaceId);
  if (!teamId) return 0;
  for (const s of scoped) {
    await deps.store.upsert(patternObservation({ teamId, workspaceId, rule: s.rule, taskIds: s.taskIds, firstObservedAt: s.firstObservedAt, lastObservedAt: s.lastObservedAt }));
  }
  return scoped.length;
}

// ── Postgres ─────────────────────────────────────────────────────────────────

const dbOutcomeFacts: OutcomeFactsPort = {
  async task(taskId) {
    const { db } = await import('@buildd/core/db');
    const { tasks, workspaces } = await import('@buildd/core/db/schema');
    const { eq } = await import('drizzle-orm');
    const [row] = await db
      .select({ teamId: workspaces.teamId, workspaceId: tasks.workspaceId, backend: tasks.backend })
      .from(tasks)
      .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!row?.teamId) return null;
    return { teamId: row.teamId, workspaceId: row.workspaceId, provider: row.backend ?? 'claude' };
  },
  async runner(accountId) {
    const { db } = await import('@buildd/core/db');
    const { accounts } = await import('@buildd/core/db/schema');
    const { eq } = await import('drizzle-orm');
    const [row] = await db
      .select({ id: accounts.id, authType: accounts.authType, managedRunner: accounts.managedRunner, hostRunner: accounts.hostRunner, createdByUserId: accounts.createdByUserId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return row ?? null;
  },
};

export async function dbTeamOfWorkspace(workspaceId: string): Promise<string | null> {
  const { db } = await import('@buildd/core/db');
  const { workspaces } = await import('@buildd/core/db/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row?.teamId ?? null;
}

/**
 * Postgres-backed store. Upsert is one INSERT … ON CONFLICT (team_id, key),
 * so concurrent sightings converge without a transaction; its SET clause is
 * `foldObservation` in SQL. Verify is one UPDATE whose WHERE is `restores`.
 */
export async function createDbRootCausePort(): Promise<RootCauseStorePort> {
  const { db } = await import('@buildd/core/db');
  const { rootCauses } = await import('@buildd/core/db/schema');
  const { and, eq, isNull, lt, or, sql } = await import('drizzle-orm');
  return {
    async upsert(obs) {
      const taskIds = obs.taskIds.slice(0, MAX_ROOT_CAUSE_TASK_IDS);
      await db
        .insert(rootCauses)
        .values({
          teamId: obs.teamId,
          key: obs.key,
          capabilityKind: obs.capability.kind,
          runnerId: obs.capability.runnerId,
          provider: obs.capability.provider,
          component: obs.capability.component,
          workspaceId: obs.capability.workspaceId,
          classification: obs.classification,
          affectedTaskIds: taskIds,
          firstSeenAt: new Date(obs.firstSeenAt),
          lastSeenAt: new Date(obs.lastSeenAt),
        })
        .onConflictDoUpdate({
          target: [rootCauses.teamId, rootCauses.key],
          set: {
            capabilityKind: sql`excluded.capability_kind`,
            runnerId: sql`excluded.runner_id`,
            provider: sql`excluded.provider`,
            component: sql`excluded.component`,
            workspaceId: sql`excluded.workspace_id`,
            classification: sql`excluded.classification`,
            affectedTaskIds: sql`(excluded.affected_task_ids || ARRAY(SELECT t FROM unnest(${rootCauses.affectedTaskIds}) AS t WHERE NOT (t = ANY(excluded.affected_task_ids))))[1:${sql.raw(String(MAX_ROOT_CAUSE_TASK_IDS))}]`,
            firstSeenAt: sql`LEAST(${rootCauses.firstSeenAt}, excluded.first_seen_at)`,
            lastSeenAt: sql`GREATEST(${rootCauses.lastSeenAt}, excluded.last_seen_at)`,
            verifiedRestoredAt: sql`CASE WHEN ${rootCauses.verifiedRestoredAt} IS NOT NULL AND excluded.last_seen_at <= ${rootCauses.verifiedRestoredAt} THEN ${rootCauses.verifiedRestoredAt} ELSE NULL END`,
            updatedAt: sql`now()`,
          },
        });
    },
    async verifyRestored(check) {
      const at = new Date(check.at);
      const onRunner = check.runnerId
        ? and(sql`${rootCauses.capabilityKind} IN ('runner', 'provider')`, eq(rootCauses.runnerId, check.runnerId), eq(rootCauses.provider, check.provider))
        : undefined;
      const onWorkspace = check.workspaceId
        ? and(eq(rootCauses.capabilityKind, 'platform'), eq(rootCauses.workspaceId, check.workspaceId))
        : undefined;
      const capability = or(onRunner, onWorkspace);
      if (!capability) return 0;
      const rows = await db
        .update(rootCauses)
        .set({ verifiedRestoredAt: at, updatedAt: at })
        .where(and(eq(rootCauses.teamId, check.teamId), isNull(rootCauses.verifiedRestoredAt), lt(rootCauses.lastSeenAt, at), capability))
        .returning({ id: rootCauses.id });
      return rows.length;
    },
  };
}

/** The Postgres store, built on first use. */
export const dbRootCauseStore: RootCauseStorePort = {
  async upsert(obs) { await (await createDbRootCausePort()).upsert(obs); },
  async verifyRestored(check) { return (await createDbRootCausePort()).verifyRestored(check); },
};

export function toRootCauseRecord(row: {
  key: string; teamId: string; capabilityKind: RootCauseCapabilityKind; runnerId: string | null; provider: string | null;
  component: string | null; workspaceId: string | null; classification: RootCauseClassification; affectedTaskIds: string[];
  firstSeenAt: Date; lastSeenAt: Date; verifiedRestoredAt: Date | null;
}): RootCauseRecord {
  return {
    key: row.key,
    teamId: row.teamId,
    capability: { kind: row.capabilityKind, runnerId: row.runnerId, provider: row.provider, component: row.component, workspaceId: row.workspaceId },
    classification: row.classification,
    affectedTaskIds: row.affectedTaskIds,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    verifiedRestoredAt: row.verifiedRestoredAt?.toISOString() ?? null,
  };
}

/**
 * Every record still active, plus those restored since `since`, newest first.
 * `teamIds` null reads every team.
 */
export async function listRootCauses(opts: { teamIds: string[] | null; since: Date; limit: number }): Promise<RootCauseRecord[]> {
  const { db } = await import('@buildd/core/db');
  const { rootCauses } = await import('@buildd/core/db/schema');
  const { and, desc, gte, inArray, isNull, or } = await import('drizzle-orm');
  if (opts.teamIds && opts.teamIds.length === 0) return [];
  const rows = await db
    .select()
    .from(rootCauses)
    .where(and(
      opts.teamIds ? inArray(rootCauses.teamId, opts.teamIds) : undefined,
      or(isNull(rootCauses.verifiedRestoredAt), gte(rootCauses.verifiedRestoredAt, opts.since)),
    ))
    .orderBy(desc(rootCauses.lastSeenAt))
    .limit(opts.limit);
  return rows.map(toRootCauseRecord);
}
