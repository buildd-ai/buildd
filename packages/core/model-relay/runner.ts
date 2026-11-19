/**
 * The team's `local_runner` pick and the one call every relay consumer makes
 * (docs/specs/local-runner-provider.md §2.3, §4.3, §7): read the pick, check
 * the pinned runner is online and advertises the model, enqueue, nudge, wait.
 *
 * `runRelayJob` is the only way an embed or a chat reaches a runner. It writes
 * no row when the runner is offline or does not list the model (AC-13), it
 * never throws (E-8), and it has no other provider to turn to: a failure is a
 * typed outcome the caller degrades on (lexical-only, or a chat refusal),
 * never a paid call.
 */
import { sql } from 'drizzle-orm';
import {
  parseLocalModelsAdvert,
  parseLocalRunnerConfig,
  runnerOnlineNow,
  type LocalModelAdvert,
  type LocalModelCapability,
  type LocalModelsAdvert,
  type RelayAwaitOutcome,
  type RelayErrorCode,
  type RelayJobKind,
  type RelayJobPayload,
  type RelayJobSurface,
} from '@buildd/shared';
import { awaitRelayJob, enqueueRelayJob, type RelayExec } from './jobs';

type J = Record<string, unknown>;
const rowsOf = (r: { rows?: unknown[] }) => (r.rows ?? []) as J[];
const parseJson = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};

let defaultExec: RelayExec | null = null;
async function dbExec(q: Parameters<RelayExec>[0]): Promise<{ rows?: unknown[] }> {
  if (!defaultExec) {
    const { db } = await import('../db/index');
    defaultExec = (query) => db.execute(query) as unknown as Promise<{ rows?: unknown[] }>;
  }
  return defaultExec(q);
}

/** The pinned runner's heartbeat row, as far as the relay needs it. */
export interface RelayRunner {
  id: string;
  accountId: string;
  lastHeartbeatAt: string | Date;
  presenceConnected: boolean | null;
  localModels: LocalModelsAdvert | null;
}

/** What a team chose for `local_runner`, across the three places it is stored (§2.2). */
export interface LocalRunnerPick {
  teamId: string;
  /** The stored `teams.local_runner.runnerId`. */
  runnerId: string | null;
  chatModel: string | null;
  /** Set when `teams.embedding_provider = 'local_runner'`. */
  embeddingModel: string | null;
  /** `teams.provider_assignments.chat = 'local_runner'`. */
  chatAssigned: boolean;
  /** The pinned runner's row. Null: no pick, the row is gone, or it is not this team's. */
  runner: RelayRunner | null;
}

/** True when the team routes embeddings or chat to its runner: the runner is then a relay host. */
export function pickUsesRelay(pick: LocalRunnerPick | null): boolean {
  return !!pick && !!pick.runnerId && (pick.embeddingModel !== null || (pick.chatAssigned && pick.chatModel !== null));
}

/** The pick as the `teams` columns hold it, without the runner's row. */
function pickFromTeamRow(teamId: string, teamRow: J): LocalRunnerPick {
  const config = parseLocalRunnerConfig(parseJson(teamRow.local_runner));
  const assignments = parseJson(teamRow.provider_assignments) as { chat?: unknown } | null;
  return {
    teamId,
    runnerId: config?.runnerId ?? null,
    chatModel: config?.chatModel ?? null,
    embeddingModel: teamRow.embedding_provider === 'local_runner' && typeof teamRow.embedding_model === 'string' && teamRow.embedding_model
      ? teamRow.embedding_model : null,
    chatAssigned: assignments?.chat === 'local_runner',
    runner: null,
  };
}

/**
 * What a heartbeat answers a runner that advertises local models (§2.3,
 * §6.3): its own heartbeat id, which it echoes as `runnerId` on every relay
 * call, and whether its team pins it as the relay host. One statement.
 */
export async function relayHostForRunner(
  accountId: string,
  localUiUrl: string,
  exec: RelayExec = dbExec,
): Promise<{ heartbeatId: string; host: boolean } | null> {
  const row = rowsOf(await exec(sql`-- relay:host
SELECT h.id, t.id AS team_id, t.local_runner, t.embedding_provider, t.embedding_model, t.provider_assignments
FROM worker_heartbeats h
JOIN accounts a ON a.id = h.account_id
JOIN teams t ON t.id = a.team_id
WHERE h.account_id = ${accountId}::uuid AND h.local_ui_url = ${localUiUrl}`))[0];
  if (!row) return null;
  const heartbeatId = String(row.id);
  const pick = pickFromTeamRow(String(row.team_id), row);
  return { heartbeatId, host: pickUsesRelay(pick) && pick.runnerId === heartbeatId.toLowerCase() };
}

/**
 * A runner's heartbeat row, only when its account belongs to `teamId`. A
 * runner of another team (or a row that is gone) reads as null (§2.2, AC-2).
 */
export async function findTeamRunner(teamId: string, runnerId: string, exec: RelayExec = dbExec): Promise<RelayRunner | null> {
  const hb = rowsOf(await exec(sql`-- relay:pick_runner
SELECT h.id, h.account_id, h.last_heartbeat_at, h.presence_connected, h.local_models
FROM worker_heartbeats h
JOIN accounts a ON a.id = h.account_id
WHERE h.id = ${runnerId}::uuid AND a.team_id = ${teamId}::uuid`))[0];
  if (!hb) return null;
  return {
    id: String(hb.id),
    accountId: String(hb.account_id),
    lastHeartbeatAt: hb.last_heartbeat_at as string | Date,
    presenceConnected: hb.presence_connected == null ? null : hb.presence_connected === true,
    localModels: parseLocalModelsAdvert(parseJson(hb.local_models)),
  };
}

/**
 * The team's pick with its runner's row, read fresh (no cache: "is it online"
 * must be true now). The runner is joined through `accounts.team_id`, so a
 * `runnerId` of another team reads as no runner (§2.2). Null: no such team.
 */
export async function loadLocalRunnerPick(teamId: string, exec: RelayExec = dbExec): Promise<LocalRunnerPick | null> {
  const teamRow = rowsOf(await exec(sql`-- relay:pick_team
SELECT local_runner, embedding_provider, embedding_model, provider_assignments FROM teams WHERE id = ${teamId}::uuid`))[0];
  if (!teamRow) return null;
  const pick = pickFromTeamRow(teamId, teamRow);
  if (!pick.runnerId) return pick;
  pick.runner = await findTeamRunner(teamId, pick.runnerId, exec);
  return pick;
}

export type RelayAvailability =
  | { ok: true; runner: RelayRunner; model: LocalModelAdvert }
  | { ok: false; code: Extract<RelayErrorCode, 'runner_offline' | 'model_missing'>; message: string; runnerId: string | null };

/** The model's line in the runner's last advert, when it has the capability asked for. */
export function advertisedModel(runner: RelayRunner | null, model: string, capability: LocalModelCapability): LocalModelAdvert | null {
  return runner?.localModels?.models.find(m => m.name === model && m.capabilities.includes(capability)) ?? null;
}

/**
 * The fast-fail before any row is written (§4.3, AC-13): the pinned runner is
 * online by `runnerOnlineNow`, the predicate the runner list uses, and its
 * last advert lists the model. A runner that is online but not claiming is
 * caught by the job's deadline instead.
 */
export function relayAvailability(pick: LocalRunnerPick | null, model: string, capability: LocalModelCapability, now: number = Date.now()): RelayAvailability {
  const runnerId = pick?.runnerId ?? null;
  if (!pick || !runnerId) return { ok: false, code: 'runner_offline', message: 'No runner is chosen for the local runner provider.', runnerId };
  if (!pick.runner) return { ok: false, code: 'runner_offline', message: `The chosen runner (${runnerId}) is gone; pick a runner again in Settings › Providers.`, runnerId };
  if (!runnerOnlineNow(pick.runner.lastHeartbeatAt, pick.runner.presenceConnected, now)) {
    return { ok: false, code: 'runner_offline', message: `The chosen runner (${runnerId}) is offline.`, runnerId };
  }
  const advert = advertisedModel(pick.runner, model, capability);
  if (!advert) return { ok: false, code: 'model_missing', message: `The chosen runner (${runnerId}) does not serve ${model}.`, runnerId };
  return { ok: true, runner: pick.runner, model: advert };
}

// ── Nudge ────────────────────────────────────────────────────────────────────

/** Tell the runner's account a job is queued, so it claims at once instead of on its next poll (§4.4). */
export type RelayNudge = (runner: { accountId: string; runnerId: string }, job: { id: string; kind: RelayJobKind }) => Promise<void> | void;
// Kept on globalThis: the web app registers it from its instrumentation hook,
// which the bundler may load as a separate copy of this module.
const NUDGE_KEY = Symbol.for('buildd.model-relay.nudge');
type NudgeHolder = { [NUDGE_KEY]?: RelayNudge | null };

/** Register the realtime nudge (the web app's Pusher). Absent, runners claim on their poll. */
export function setRelayNudge(fn: RelayNudge | null): void {
  (globalThis as NudgeHolder)[NUDGE_KEY] = fn;
}

function registeredNudge(): RelayNudge | null {
  return (globalThis as NudgeHolder)[NUDGE_KEY] ?? null;
}

// ── Run ──────────────────────────────────────────────────────────────────────

export interface RunRelayJobInput {
  teamId: string;
  workspaceId?: string | null;
  kind: RelayJobKind;
  surface: RelayJobSurface;
  namespace?: string | null;
  model: string;
  payload: RelayJobPayload;
  deadlineMs?: number;
  /** Chat: each new slice of partial text as the runner reports it. */
  onPartialText?: (delta: string) => void;
}

export type RunRelayJobOutcome = RelayAwaitOutcome & { runnerId: string | null };

export interface RunRelayJobDeps {
  loadPick?: (teamId: string) => Promise<LocalRunnerPick | null>;
  enqueue?: typeof enqueueRelayJob;
  wait?: typeof awaitRelayJob;
  nudge?: RelayNudge | null;
  now?: () => number;
}

/**
 * One job through the relay: fast-fail, enqueue, nudge, wait to the deadline.
 * Never throws; every failure is `{ ok: false, code }`. There is no fallback
 * here and none may be added: a team that chose its own runner is never billed
 * by another provider (§7.2).
 */
export async function runRelayJob(input: RunRelayJobInput, deps: RunRelayJobDeps = {}): Promise<RunRelayJobOutcome> {
  let runnerId: string | null = null;
  try {
    const pick = await (deps.loadPick ?? (id => loadLocalRunnerPick(id)))(input.teamId);
    runnerId = pick?.runnerId ?? null;
    const available = relayAvailability(pick, input.model, input.kind === 'embed' ? 'embedding' : 'completion', (deps.now ?? Date.now)());
    if (!available.ok) return { ok: false, code: available.code, message: available.message, runnerId };
    const queued = await (deps.enqueue ?? enqueueRelayJob)({
      teamId: input.teamId, workspaceId: input.workspaceId ?? null, runnerId: available.runner.id,
      kind: input.kind, surface: input.surface, namespace: input.namespace ?? null, model: input.model,
      payload: input.payload, deadlineMs: input.deadlineMs,
    });
    if (!queued.ok) {
      return { ok: false, code: queued.code === 'payload_too_large' ? 'payload_too_large' : 'bad_result', message: queued.message, runnerId };
    }
    const send = deps.nudge === undefined ? registeredNudge() : deps.nudge;
    if (send) {
      try {
        await send({ accountId: available.runner.accountId, runnerId: available.runner.id }, { id: queued.id, kind: input.kind });
      } catch (err) {
        console.warn('[model-relay] nudge failed; the runner claims on its next poll:', err instanceof Error ? err.message : err);
      }
    }
    const outcome = await (deps.wait ?? awaitRelayJob)(queued.id, { deadlineAt: queued.deadlineAt, onPartialText: input.onPartialText });
    return { ...outcome, runnerId };
  } catch (err) {
    return { ok: false, code: 'runner_offline', message: err instanceof Error ? err.message : String(err), runnerId };
  }
}
