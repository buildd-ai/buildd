/**
 * What a runner IS in the fleet, as opposed to where it can be reached.
 *
 * A long-lived host runner is one machine with N slots. A `buildd --once` run
 * (apps/runner/src/run-once.ts) is one process for one task: the cloud runner
 * (apps/cloud-runner) starts a fresh container per task, so every cloud run
 * heartbeats under its own `headless://<host>/once/<taskId>` key. Shown as
 * machines, a day of cloud runs reads as a dozen idle runners. Shown as what it
 * is, it is one elastic group (one cloud dispatcher deployment) with however
 * many runs are live right now.
 *
 * The identity travels on the heartbeat inside `environment.fleet` (a JSON
 * field, so no column), and is re-derived from the URL shape for rows written
 * by runner builds that predate it. Pure and client-safe.
 */
import { isRunnerExecutor, type RunnerExecutor } from './executor';

/** Env var the cloud dispatcher sets in the container: its deployment (Worker) name. */
export const RUNNER_GROUP_ENV = 'BUILDD_RUNNER_GROUP';

export interface RunnerFleetIdentity {
  /** `cloud` for a container run, `host` for a machine; null when unknown (a legacy row). */
  executor: RunnerExecutor | null;
  /** One run, then the process exits: a `--once` runner. */
  ephemeral: boolean;
  /** Tasks this runner can hold at once. Always 1 for an ephemeral runner. */
  concurrency: number | null;
  /** The elastic group this runner belongs to (the cloud dispatcher's name), or null. */
  group: string | null;
}

/** `headless://<host>/once/<taskId>`: the key every `--once` run heartbeats under. */
const ONCE_URL_RE = /^headless:\/\/[^/]*\/once\/[^/]+$/;
const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isOnceRunnerUrl(localUiUrl: string | null | undefined): boolean {
  return typeof localUiUrl === 'string' && ONCE_URL_RE.test(localUiUrl);
}

/** A group name as accepted anywhere: short, URL- and label-safe. Anything else is null. */
export function normalizeRunnerGroup(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return GROUP_RE.test(v) ? v : null;
}

/** What a `--once` process reports about itself, from its own env. */
export function onceFleetIdentity(env: Record<string, string | undefined>): RunnerFleetIdentity {
  const cloud = env.BUILDD_EXECUTOR === 'cloud';
  return {
    executor: cloud ? 'cloud' : 'host',
    ephemeral: true,
    concurrency: 1,
    group: cloud ? normalizeRunnerGroup(env[RUNNER_GROUP_ENV]) : null,
  };
}

/**
 * The server's reading of a reported identity: unknown shapes are dropped, not
 * trusted. Null when nothing usable was sent.
 */
export function parseFleetIdentity(raw: unknown): RunnerFleetIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const executor = isRunnerExecutor(r.executor) ? r.executor : null;
  const ephemeral = r.ephemeral === true;
  const concurrency = typeof r.concurrency === 'number' && Number.isInteger(r.concurrency) && r.concurrency > 0
    ? Math.min(r.concurrency, 1000)
    : null;
  const group = normalizeRunnerGroup(r.group);
  if (executor === null && !ephemeral && concurrency === null && group === null) return null;
  return { executor, ephemeral, concurrency: ephemeral ? 1 : concurrency, group };
}

/**
 * A heartbeat row's identity. Ephemeral is decided by the URL alone: every
 * `--once` run heartbeats under `/once/<taskId>` and nothing else does, and a
 * long-lived runner must not be able to report itself out of the fleet. For
 * an ephemeral row the reported executor and group are kept when valid; a row
 * from a build that predates them has both null.
 */
export function runnerFleetIdentity(hb: { localUiUrl: string; environment?: unknown }): RunnerFleetIdentity {
  if (!isOnceRunnerUrl(hb.localUiUrl)) return { executor: null, ephemeral: false, concurrency: null, group: null };
  const reported = parseFleetIdentity((hb.environment as { fleet?: unknown } | null | undefined)?.fleet);
  return { executor: reported?.executor ?? null, ephemeral: true, concurrency: 1, group: reported?.group ?? null };
}

/**
 * The heartbeat `environment` as the server stores it: an ephemeral run's with
 * its normalised identity, anyone else's exactly as sent minus a `fleet` key
 * (a long-lived runner does not get to describe itself as ephemeral). No
 * environment stays null, as before; the URL still marks the row ephemeral.
 */
export function storedHeartbeatEnvironment<E>(environment: E, identity: RunnerFleetIdentity): E | null {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return null;
  if (identity.ephemeral) return { ...environment, fleet: identity };
  if (!('fleet' in environment)) return environment;
  const { fleet: _dropped, ...rest } = environment as Record<string, unknown>;
  return rest as E;
}

/** True for a runner that runs one task and exits. */
export function isEphemeralRunner(hb: { localUiUrl: string; environment?: unknown }): boolean {
  return runnerFleetIdentity(hb).ephemeral;
}

/** The host part of a `headless://<host>/once/<id>` URL. */
function onceHost(localUiUrl: string): string {
  return localUiUrl.replace(/^headless:\/\//, '').split('/')[0] || 'once';
}

/**
 * The elastic group an ephemeral runner folds into, or null for a host runner
 * (which stays its own row). A reported group is the cloud dispatcher, shared
 * by every container it starts. Without one (a host `--once`, or a cloud run
 * from before groups were reported), runs fold by account and machine name, so
 * repeated runs from one place still read as one group.
 */
export function fleetGroupKey(hb: {
  accountId?: string | null;
  localUiUrl: string;
  environment?: unknown;
}): string | null {
  const id = runnerFleetIdentity(hb);
  if (!id.ephemeral) return null;
  if (id.group) return `group:${id.executor ?? 'unknown'}:${id.group}`;
  const labels = (hb.environment as { labels?: Record<string, string> | null } | null | undefined)?.labels ?? null;
  const host = (labels?.hostname || '').trim() || onceHost(hb.localUiUrl);
  return `once:${hb.accountId ?? ''}:${host}`;
}

/** "Cloudflare" for a cloud group (apps/cloud-runner is the one cloud executor), else null. */
export function executorDisplayName(executor: RunnerExecutor | null): string | null {
  return executor === 'cloud' ? 'Cloudflare' : null;
}
