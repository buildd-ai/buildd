/**
 * Timezone resolution and rendering.
 *
 * buildd stores exactly two zones and no override chain:
 *
 *   - `users.timezone`  — derived silently from the browser. The zone a signed-in
 *     person sees their own dashboard in.
 *   - `teams.timezone`  — the team's canonical working zone. The zone used for
 *     anything emitted to a shared or external surface (PR comments, schedule
 *     defaults, mission active hours, digests) where "the viewer" is not a single
 *     known person.
 *
 * Workspaces deliberately have NO zone: a repo does not live anywhere. The one
 * legitimate per-object override already exists — `task_schedules.timezone` —
 * because a nightly job can need a fixed zone regardless of who owns it.
 *
 * Everything falls back to UTC, so a team that never sets a zone behaves exactly
 * as it did before this existed.
 */

export const DEFAULT_TIMEZONE = 'UTC';

/**
 * True when `tz` is an IANA zone this runtime can actually format in.
 *
 * Validated by construction rather than against a curated list: browsers report
 * ~400 zones (`America/Toronto`, `Europe/Zurich`, …) and a hand-maintained
 * shortlist would silently reject most real users.
 */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * First valid zone in the chain, else UTC. Pass candidates most-specific first,
 * e.g. `resolveTimezone(user.timezone, team.timezone)`.
 */
export function resolveTimezone(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    if (isValidTimezone(c)) return c;
  }
  return DEFAULT_TIMEZONE;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `Aug 29, 14:03 UTC` — a short absolute stamp in `tz`, always carrying the zone
 * so a reader in another zone is never misled. Locale-independent: assembled
 * from `formatToParts` rather than a locale format string, so the output is
 * identical on every machine and in CI.
 *
 * Falls back to a hand-rolled UTC stamp if `Intl` rejects the zone, and returns
 * `'unknown time'` for an unparseable timestamp — a bad date must never throw
 * inside a comment renderer.
 */
export function formatStamp(iso: string, tz?: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown time';

  const zone = resolveTimezone(tz);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).formatToParts(d);

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const month = get('month');
    const day = get('day');
    const hour = get('hour').padStart(2, '0');
    const minute = get('minute').padStart(2, '0');
    const name = get('timeZoneName');
    if (!month || !day || !name) throw new Error('incomplete parts');

    return `${month} ${day}, ${hour}:${minute} ${name}`;
  } catch {
    const month = MONTHS[d.getUTCMonth()];
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${month} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
  }
}
