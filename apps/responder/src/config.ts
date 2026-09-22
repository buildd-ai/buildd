/**
 * Responder configuration, from the environment only.
 *
 * ── Two rules this file exists to enforce ───────────────────────────────────
 *
 * 1. **No default points at production.** Every address the responder touches
 *    is explicit. A default app URL would let a misconfigured responder probe
 *    the live claim endpoint by accident, and probing that endpoint by
 *    accident is exactly the mistake that claimed a real task during the
 *    incident triage this app comes from.
 *
 * 2. **`DATABASE_URL` is not read.** The `cron_runs` feed has its own
 *    variable, `BUILDD_RESPONDER_CRON_RUNS_URL`, so that the connection string
 *    the responder holds can be a read-only role and so that inheriting a
 *    shell's `DATABASE_URL` cannot silently hand this process write access to
 *    production. The responder's own state never goes to a database at all —
 *    see `evidence.ts`.
 *
 * The narrative credential is deliberately *whatever the host already has*.
 * The design records the reasoning: a responder-specific model secret is one
 * more thing to provision, rotate and forget, and credential rot has already
 * taken working systems down here. So `CLAUDE_CODE_OAUTH_TOKEN` (the same
 * variable the runner's backend uses) or `ANTHROPIC_API_KEY`, and if neither
 * is set the responder runs anyway with no narrative.
 */

import { homedir } from 'os';
import { join } from 'path';

export const MISSING_NOTIFY_MESSAGE =
  'No notification path configured: set PUSHOVER_USER and PUSHOVER_TOKEN ' +
  '(or PUSHOVER_TOKEN_ALERT). A responder that detects and cannot page is ' +
  'worse than no responder, because it will be trusted.';

export interface NotifyConfig {
  user: string;
  token: string;
}

/**
 * The credential used for the optional narrative. `kind` decides the header:
 * an OAuth token goes on `Authorization: Bearer` with the oauth beta flag, an
 * API key goes on `x-api-key`.
 */
export interface NarrativeCredential {
  kind: 'oauth' | 'api-key';
  token: string;
}

export interface ResponderConfig {
  /** Local, embedded state. Never the production database. */
  stateDir: string;
  /** Base URL of the platform whose claim endpoint gets probed. */
  appUrl: string;
  /** API key for the claim probe. Authenticates; cannot claim — see claim-probe.ts. */
  apiKey: string;
  /** Read-only Postgres URL for the `cron_runs` feed, or null to skip it. */
  cronRunsUrl: string | null;
  /** The runner's local HTTP base URL, or null to skip it. */
  runnerUrl: string | null;
  /** Optional viewer token if the runner's port is protected. */
  runnerToken: string | null;
  notify: NotifyConfig;
  narrative: NarrativeCredential | null;
  /** Seconds between cycles in long-lived mode. */
  intervalSeconds: number;
  /** Hours of silence after a page before the same condition may page again. */
  renotifyHours: number;
  /** How long claim samples are retained. Must cover the widest detector window. */
  sampleRetentionHours: number;
  /** Wall-clock ceiling on the optional narrative call. */
  narrativeTimeoutMs: number;
  /** Model used for the narrative, when there is a credential for one. */
  narrativeModel: string;
}

export type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required (no default — see apps/responder/README.md)`);
  return value;
}

function optional(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  // Rejected rather than defaulted: silently falling back to the default on a
  // typo means an operator who set a 30-second interval gets 300 and never
  // knows. A config error has to be loud.
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function defaultStateDir(env: Env): string {
  // BUILDD_HOME first: the rest of the fleet honours it, and every test
  // process gets its own under tmpdir().
  const base = env.BUILDD_HOME?.trim() || join(homedir(), '.buildd');
  return join(base, 'responder');
}

export function loadConfig(env: Env = process.env): ResponderConfig {
  const user = optional(env, 'PUSHOVER_USER');
  const token =
    optional(env, 'PUSHOVER_TOKEN_ALERT') ?? optional(env, 'PUSHOVER_TOKEN');
  if (!user || !token) throw new Error(MISSING_NOTIFY_MESSAGE);

  const oauth = optional(env, 'CLAUDE_CODE_OAUTH_TOKEN');
  const apiKeyCred = optional(env, 'ANTHROPIC_API_KEY');
  const narrative: NarrativeCredential | null = oauth
    ? { kind: 'oauth', token: oauth }
    : apiKeyCred
      ? { kind: 'api-key', token: apiKeyCred }
      : null;

  return {
    stateDir: optional(env, 'BUILDD_RESPONDER_STATE_DIR') ?? defaultStateDir(env),
    appUrl: required(env, 'BUILDD_RESPONDER_APP_URL').replace(/\/+$/, ''),
    apiKey: required(env, 'BUILDD_RESPONDER_API_KEY'),
    cronRunsUrl: optional(env, 'BUILDD_RESPONDER_CRON_RUNS_URL'),
    runnerUrl: optional(env, 'BUILDD_RESPONDER_RUNNER_URL')?.replace(/\/+$/, '') ?? null,
    runnerToken: optional(env, 'BUILDD_RESPONDER_RUNNER_TOKEN'),
    notify: { user, token },
    narrative,
    intervalSeconds: positiveInt(env, 'BUILDD_RESPONDER_INTERVAL_SECONDS', 60),
    // 24h, the same window apps/web/src/app/api/cron/queue-stall/route.ts uses
    // for the same purpose. One convention, not two.
    renotifyHours: positiveInt(env, 'BUILDD_RESPONDER_RENOTIFY_HOURS', 24),
    sampleRetentionHours: positiveInt(env, 'BUILDD_RESPONDER_SAMPLE_RETENTION_HOURS', 6),
    narrativeTimeoutMs: positiveInt(env, 'BUILDD_RESPONDER_NARRATIVE_TIMEOUT_MS', 20_000),
    narrativeModel: optional(env, 'BUILDD_RESPONDER_NARRATIVE_MODEL') ?? 'claude-opus-5',
  };
}
