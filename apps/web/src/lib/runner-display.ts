/**
 * How a runner is named wherever one is shown: home's fleet, the mission
 * Board and Lanes, and the task page's fact sheet. One resolver, so no surface
 * prints a raw `http://…` URL or an avatar that reads "H".
 *
 * A runner claims with `workers.runner = <its localUiUrl>`, and heartbeats are
 * unique per (account, localUiUrl). The heartbeat's `environment.labels` carry
 * the hostname and machine; without a heartbeat the name is parsed from the
 * URL's host (`http://atlas.local:8766` → `atlas`).
 *
 * Pure and client-safe. `lib/runner-heartbeats.ts` loads the heartbeat rows.
 */

export interface RunnerHeartbeatLike {
  accountId?: string | null;
  localUiUrl: string;
  environment?: { labels?: Record<string, string> | null } | null;
}

export interface RunnerWorkerLike {
  runner?: string | null;
  localUiUrl?: string | null;
  accountId?: string | null;
}

export interface RunnerDisplay {
  name: string;
  /** One-letter avatar. */
  initial: string;
  /** "macOS · arm64", "Mac Studio"; null without a heartbeat. */
  machineLabel: string | null;
}

/** "atlas" from `http://atlas.local:8766`; a bare name passes through. */
export function runnerNameFromUrl(url: string): string {
  const host = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/:?#]/)[0] ?? url;
  if (/^\d+(\.\d+){3}$/.test(host)) return host;
  return host.split('.')[0] || url;
}

/** First letter or digit of the resolved name (a URL is resolved first). */
export function runnerInitial(nameOrUrl: string): string {
  const name = /:\/\//.test(nameOrUrl) ? runnerNameFromUrl(nameOrUrl) : nameOrUrl;
  return (name.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
}

const OS_NAME: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

/** A heartbeat's own identity: hostname label, else the URL host. */
export function runnerIdentity(hb: Pick<RunnerHeartbeatLike, 'localUiUrl' | 'environment'>): { name: string; machine: string | null } {
  const labels = hb.environment?.labels ?? {};
  const name = labels.hostname || runnerNameFromUrl(hb.localUiUrl);
  const machine = labels.machine
    || [labels.os ? OS_NAME[labels.os] ?? labels.os : null, labels.arch].filter(Boolean).join(' · ')
    || null;
  return { name, machine };
}

/** The key a worker joins its runner's heartbeat on. */
export function runnerKey(w: RunnerWorkerLike): string | null {
  return w.localUiUrl || w.runner || null;
}

/**
 * The heartbeat a worker ran under: same URL, and the same account when the
 * worker names one (a `localhost` URL is shared by every team's runners).
 */
export function matchRunnerHeartbeat<H extends RunnerHeartbeatLike>(
  w: RunnerWorkerLike,
  heartbeats: readonly H[] | undefined,
): H | null {
  const key = runnerKey(w);
  if (!key || !heartbeats?.length) return null;
  return heartbeats.find(h => h.localUiUrl === key && (!w.accountId || h.accountId === w.accountId)) ?? null;
}

export function resolveRunnerDisplay(w: RunnerWorkerLike, heartbeats?: readonly RunnerHeartbeatLike[]): RunnerDisplay | null {
  const key = runnerKey(w);
  if (!key) return null;
  const hb = matchRunnerHeartbeat(w, heartbeats);
  const { name, machine } = hb ? runnerIdentity(hb) : { name: runnerNameFromUrl(key), machine: null };
  return { name, initial: runnerInitial(name), machineLabel: machine };
}

/**
 * The accounts whose heartbeats can name these workers' runners: one per
 * worker that names both a runner and an account (an account-less worker can
 * never be matched safely, so it adds nothing).
 */
export function heartbeatAccountIds(workers: readonly RunnerWorkerLike[]): string[] {
  const ids = new Set<string>();
  for (const w of workers) if (runnerKey(w) && w.accountId) ids.add(w.accountId);
  return [...ids];
}

/** `resolveRunnerDisplay` bound to one set of heartbeats. */
export function runnerDisplayResolver(heartbeats?: readonly RunnerHeartbeatLike[]) {
  return (w: RunnerWorkerLike) => resolveRunnerDisplay(w, heartbeats);
}
