/**
 * Runner pins: a `runner:<name>` entry in a task's requiredCapabilities says
 * only that runner may claim it (create_task `runner`).
 *
 * A runner is known by three strings, and a pin may use any of them:
 *   - its key, the `runner` its claim sends (its localUiUrl, e.g.
 *     `http://100.64.0.1:8766` or `headless://<host>`), shown second in each
 *     list_runners row;
 *   - its hostname (`environment.labels.hostname`), the name workers report;
 *   - its account name, the label list_runners leads each row with.
 * The claim used to compare the pin with the key alone, so a pin by the name a
 * person actually sees matched nothing and the task was never claimed.
 */

const PIN_PREFIX = 'runner:';

/** The runner a task is pinned to, or null for an unpinned task. */
export function pinnedRunnerOf(requiredCapabilities: unknown): string | null {
  if (!Array.isArray(requiredCapabilities)) return null;
  const entry = requiredCapabilities.find((c): c is string => typeof c === 'string' && c.startsWith(PIN_PREFIX));
  const name = entry?.slice(PIN_PREFIX.length).trim();
  return name ? name : null;
}

export interface RunnerPinIdentity {
  /** The runner key: the claim's `runner`, a heartbeat's localUiUrl. */
  key?: string | null;
  hostname?: string | null;
  accountName?: string | null;
}

/** Every string a pin may name this runner by. */
export function runnerPinNames(r: RunnerPinIdentity): string[] {
  const names = [r.key, r.hostname, r.accountName]
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(v => v.length > 0 && v !== 'Unknown');
  return [...new Set(names)];
}

/** Whether a pin names this runner. Case-insensitive: hostnames are. */
export function runnerMatchesPin(pin: string, r: RunnerPinIdentity): boolean {
  const want = pin.trim().toLowerCase();
  return !!want && runnerPinNames(r).some(n => n.toLowerCase() === want);
}

/** A row of GET /api/workers/active (`activeLocalUis`), as far as pins read it. */
export interface ActiveRunnerRow {
  localUiUrl?: unknown;
  accountName?: unknown;
  environment?: unknown;
}

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function runnerRowIdentity(row: ActiveRunnerRow): RunnerPinIdentity {
  const labels = (row.environment as { labels?: { hostname?: unknown } } | null | undefined)?.labels;
  return { key: s(row.localUiUrl), hostname: s(labels?.hostname), accountName: s(row.accountName) };
}

/**
 * The string list_runners tells a person to pin this runner by: its hostname
 * when no other listed runner shares it, else its key (always unique).
 */
export function runnerPinLabel(row: ActiveRunnerRow, all: readonly ActiveRunnerRow[]): string {
  const { key, hostname } = runnerRowIdentity(row);
  if (hostname) {
    const shared = all.filter(r => runnerRowIdentity(r).hostname?.toLowerCase() === hostname.toLowerCase()).length;
    if (shared <= 1) return hostname;
  }
  return key ?? hostname ?? 'runner';
}

/**
 * Why create_task refuses a pin, or null when a listed runner answers to it.
 * A pin nothing answers to would queue a task no runner can ever claim.
 */
export function runnerPinRefusal(pin: string, rows: readonly ActiveRunnerRow[]): string | null {
  if (rows.some(r => runnerMatchesPin(pin, runnerRowIdentity(r)))) return null;
  if (rows.length === 0) {
    return `runner "${pin}" matches no runner: none is online for this token to check it against. Start the runner, then file the task again (list_runners shows the name to pin by).`;
  }
  const valid = [...new Set(rows.map(r => runnerPinLabel(r, rows)))];
  return `runner "${pin}" matches no online runner, so nothing could ever claim the task. Pin by one of: ${valid.map(v => `"${v}"`).join(', ')} (list_runners shows each as "pin:"; a runner's account name or key also works).`;
}
