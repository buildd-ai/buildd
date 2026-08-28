/**
 * Cron cadence, and the windows derived from it.
 *
 * A periodic sweep that looks N minutes ahead but runs every M minutes misses
 * everything falling in (N, M]. That is not hypothetical: the credential sweep
 * in /api/cron/codex-token-refresh looked 10 minutes ahead while its cron ran
 * every 4 hours, so a token was only ever picked up *after* it had already
 * expired — and because the route sat on a Vercel-native cron that does not fire
 * in this project, in practice it was not picked up at all.
 *
 * So the window is derived from the declared cadence rather than hand-typed.
 * `cron-manifest.json` is the single source of truth for every /api/cron/*
 * trigger (docs/specs/external-cron-triggers.md); the constant below mirrors the
 * entries this code reasons about, and cron-cadence.test.ts fails if the two
 * drift. Tighten the schedule in the manifest — to `* * * * *`, say — and every
 * derived window follows automatically.
 */

/** Mirrors cron-manifest.json. Pinned by cron-cadence.test.ts. */
export const CRON_SCHEDULES = {
  'codex-token-refresh': '0 */4 * * *',
  'connector-block-notify': '*/5 * * * *',
} as const;

/** A sweep must cover its own poll interval, plus margin for a late tick. */
export const LOOKAHEAD_SAFETY_FACTOR = 1.25;

/** Ops override — retune the window without a deploy. */
const LOOKAHEAD_ENV = 'MCP_REFRESH_LOOKAHEAD_MINUTES';

/**
 * Minutes between firings of a 5-field cron expression.
 *
 * Deliberately narrow: it handles the forms the manifest actually uses and
 * throws on anything else. A silently wrong interval mis-sizes every derived
 * window, which is exactly the failure this module exists to prevent — so an
 * unrecognised expression must be loud, not approximated.
 */
export function cronIntervalMinutes(expr: string): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Unsupported cron expression: "${expr}"`);
  const [minute, hour, dom, month, dow] = parts;

  if (dom !== '*' || month !== '*') {
    throw new Error(`Unsupported cron expression (day/month restricted): "${expr}"`);
  }

  const step = (field: string): number | null => {
    if (field === '*') return 1;
    const m = /^\*\/(\d+)$/.exec(field);
    return m ? Number(m[1]) : null;
  };

  const minuteStep = step(minute);
  const hourStep = step(hour);

  // Sub-hourly: `*/n * * * *` or `* * * * *`.
  if (minuteStep !== null) {
    if (hourStep !== 1) {
      throw new Error(`Unsupported cron expression (minute step with hour restriction): "${expr}"`);
    }
    return minuteStep;
  }

  // A fixed minute means at most hourly. Anything other than a bare number is
  // a list or range we will not guess at.
  if (!/^\d+$/.test(minute)) throw new Error(`Unsupported cron expression: "${expr}"`);

  if (hourStep !== null) return hourStep * 60;          // `0 * * * *`, `0 */4 * * *`
  if (!/^\d+$/.test(hour)) throw new Error(`Unsupported cron expression: "${expr}"`);

  return dow === '*' ? 24 * 60 : 7 * 24 * 60;           // daily vs weekly
}

/**
 * How far ahead the credential sweep should look, in minutes.
 *
 * Defaults to one full poll interval plus margin; `MCP_REFRESH_LOOKAHEAD_MINUTES`
 * overrides. A junk or non-positive override is ignored rather than honoured —
 * collapsing this window is the original bug.
 */
export function sweepLookaheadMinutes(
  schedule: string = CRON_SCHEDULES['codex-token-refresh'],
): number {
  const override = Number(process.env[LOOKAHEAD_ENV]);
  if (Number.isFinite(override) && override > 0) return override;
  return Math.ceil(cronIntervalMinutes(schedule) * LOOKAHEAD_SAFETY_FACTOR);
}
