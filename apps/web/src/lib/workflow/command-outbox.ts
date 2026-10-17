/**
 * Door commands the control plane never answered (docs/specs/workflow-kernel-library.md §3, AC-35):
 * kept by their idempotency key (`workflow_command_outbox`) and re-submitted by the kernel floor until
 * the control plane answers.
 *
 * A door that cannot reach the control plane for its whole budget answers `ControlPlaneUnavailableError`
 * (kernel-client.ts). For most doors that is enough: a person or a sweep asks again. Some commands are
 * reported once and have no other re-sender (an attempt's end, a reviewer's verdict, GitHub's one green
 * webhook): those are parked here, with the key the door already used, and the floor re-submits them.
 *
 * Exactly once: every re-submission carries the door's own key, so the command ledger
 * (`workflow_commands`, command-ledger.ts) applies it at most once and answers a repeat with what it did.
 * A parked command whose earlier submission may have reached the control plane (`prior_unknown`) is
 * asked about with the ledger's word first: done there is settled as replayed, and it is never run on
 * the web host without that word.
 *
 * Order: the command is re-submitted as it was. The reducer judges it against the delivery as it is
 * when it lands, so a verdict or an end that a newer head, round or attempt has overtaken is answered
 * `stale` or `rejected` and settled, never applied.
 *
 * Who drains: the floor (kernel-floor.ts). On the control plane it applies the row itself through the
 * same reach check and ledger as a request (`applyCommandRequest`), with no network in between, so a
 * web host that could not reach it costs nothing more. On the web host (shadow, or the liveness
 * fallback) it re-submits through the one client, which sends it to the control plane in own mode.
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { Exec } from './kernel';
import { kernelHost } from './kernel-host';
import { COMMAND_LEASE_MS, COMMAND_RETENTION_DAYS, postgresCommandLedger, type CommandLedger } from './command-ledger';
import {
  COMMAND_API_VERSION, applyCommandRequest, commandProblem, runKernelOp,
  type CommandRequest, type CommandServerDeps, type KernelOp, type KernelOps, type KernelPrincipal,
} from './command-api';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/**
 * Whether a door's command is parked when the control plane does not answer. A record over every op,
 * so a new op does not type-check until someone decides: parked only when nothing else re-sends it.
 */
export const PARK_ON_UNAVAILABLE: Record<KernelOp, boolean> = {
  // A person or an agent asked and got the 503: they ask again, and the landing sweep re-drives an approved PR.
  land: false,
  apply_recommendation: false,
  policy_merge: false,
  request_review: false,
  request_ci_retry: false,
  record_supersession: false,
  abandon: false,
  // The floor imports a PR it does not know (reconcile.ts), and re-drains effects on its own.
  open_delivery: false,
  drain: false,
  mission_epoch: false,
  mission_scope: false,
  // The runner reports an attempt's end once; the floor re-sends an owner's end, never a repair's or a review's.
  attempt_ended: true,
  // The red-PR sweep reads a red head again on its own tick.
  observe_ci_failure: false,
  // GitHub sends the check_suite success once.
  observe_ci_green: true,
  // The runner reports a reviewer's verdict once, in its completion PATCH.
  record_review_verdict: true,
  adopt_review_verdict: true,
  // Never: the claim it revalidates is rolled back to pending when unanswered and claimed afresh on the
  // next poll, under a new key. Re-sending the old one would claim a fix for a claim that moved on.
  claim_fix: false,
};

export const shouldPark = (op: KernelOp): boolean => PARK_ON_UNAVAILABLE[op] === true;

/** Re-submissions before a parked command is given up (`dead`, logged): two days of hourly floors. */
export const PARKED_MAX_ATTEMPTS = 48;
/**
 * How long a pass holds the rows it took. A pass works them one after another, so the lease covers a
 * whole worst-case pass (every row waiting out a web-host re-submission's budget) with room to spare:
 * a second pass never takes a row over while the first is still re-submitting it.
 */
export const PARKED_LEASE_MS = 10 * 60_000;
/** Rows one pass takes. Sequential: a control plane that is still down stops the pass at the first. */
export const PARKED_BATCH = 20;
/** A web-host re-submission's budget (the control plane answers a parked command in one request); never more than a door's. */
export const PARKED_SUBMIT_BUDGET_MS = 10_000;

export interface ParkedRow {
  key: string;
  op: string;
  input: Record<string, unknown>;
  principal: KernelPrincipal;
  priorUnknown: boolean;
  attempt: number;
}

type J = Record<string, unknown>;
const rowsOf = (r: { rows?: unknown[] }) => (r.rows ?? []) as J[];
const parseJson = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

export interface CommandOutbox {
  /** Keep an unanswered command; true when it is (now) pending. A settled key is left as it is. */
  park(p: { key: string; op: KernelOp; input: unknown; principal: KernelPrincipal; priorUnknown: boolean; why: string }): Promise<boolean>;
  /** Lease up to `limit` due rows for this pass. */
  claimDue(limit: number): Promise<ParkedRow[]>;
  /** Answered: done, with what the answer said. Only for the pass that holds the row. */
  settle(row: ParkedRow, outcome: string): Promise<boolean>;
  /** Not answered (or not yet): due again after `delayMs`. */
  retry(row: ParkedRow, p: { error: string; delayMs: number; priorUnknown?: boolean; refund?: boolean }): Promise<boolean>;
  /** Given up: `dead`, with why. */
  bury(row: ParkedRow, error: string): Promise<boolean>;
  /** Drops settled and given-up rows past retention. */
  prune(): Promise<number>;
}

export function postgresCommandOutbox(exec: Exec = dbExec): CommandOutbox {
  const held = (row: ParkedRow) => sql`idempotency_key = ${row.key}::text AND status = 'pending' AND attempt_count = ${row.attempt}::int`;
  return {
    async park(p) {
      const rows = rowsOf(await exec(sql`-- workflow:command_park
INSERT INTO workflow_command_outbox (idempotency_key, op, command_input, principal, prior_unknown, last_error)
VALUES (${p.key}::text, ${p.op}::text, ${JSON.stringify(p.input ?? {})}::jsonb, ${JSON.stringify(p.principal)}::jsonb, ${p.priorUnknown}::boolean, ${p.why}::text)
ON CONFLICT (idempotency_key) DO UPDATE SET
  prior_unknown = workflow_command_outbox.prior_unknown OR EXCLUDED.prior_unknown,
  last_error = EXCLUDED.last_error, updated_at = now()
WHERE workflow_command_outbox.status = 'pending'
RETURNING 1 AS ok`));
      return rows.length > 0;
    },
    async claimDue(limit) {
      const leaseSecs = PARKED_LEASE_MS / 1000;
      const rows = rowsOf(await exec(sql`-- workflow:command_park_claim
UPDATE workflow_command_outbox o
SET lease_until = clock_timestamp() + make_interval(secs => ${leaseSecs}::double precision), attempt_count = o.attempt_count + 1, updated_at = now()
WHERE o.idempotency_key IN (
  SELECT idempotency_key FROM workflow_command_outbox
  WHERE status = 'pending' AND not_before <= now() AND (lease_until IS NULL OR lease_until < clock_timestamp())
  ORDER BY not_before, created_at
  LIMIT ${limit}::int
  FOR UPDATE SKIP LOCKED
) AND o.status = 'pending' AND (o.lease_until IS NULL OR o.lease_until < clock_timestamp())
RETURNING o.idempotency_key, o.op, o.command_input, o.principal, o.prior_unknown, o.attempt_count`));
      return rows.map((r) => ({
        key: String(r.idempotency_key), op: String(r.op),
        input: parseJson(r.command_input) as Record<string, unknown>, principal: parseJson(r.principal) as KernelPrincipal,
        priorUnknown: r.prior_unknown === true, attempt: Number(r.attempt_count),
      })).sort((a, b) => a.key.localeCompare(b.key));
    },
    async settle(row, outcome) {
      const rows = rowsOf(await exec(sql`-- workflow:command_park_settle
UPDATE workflow_command_outbox SET status = 'done', outcome = ${outcome}::text, lease_until = NULL, completed_at = now(), updated_at = now()
WHERE ${held(row)} RETURNING 1 AS ok`));
      return rows.length > 0;
    },
    async retry(row, p) {
      const delaySecs = Math.max(0, p.delayMs) / 1000;
      const rows = rowsOf(await exec(sql`-- workflow:command_park_retry
UPDATE workflow_command_outbox SET lease_until = NULL, last_error = ${p.error.slice(0, 2000)}::text,
  not_before = now() + make_interval(secs => ${delaySecs}::double precision),
  prior_unknown = prior_unknown OR ${p.priorUnknown === true}::boolean,
  attempt_count = attempt_count - ${p.refund === true ? 1 : 0}::int, updated_at = now()
WHERE ${held(row)} RETURNING 1 AS ok`));
      return rows.length > 0;
    },
    async bury(row, error) {
      const rows = rowsOf(await exec(sql`-- workflow:command_park_bury
UPDATE workflow_command_outbox SET status = 'dead', outcome = 'given_up', last_error = ${error.slice(0, 2000)}::text, lease_until = NULL, completed_at = now(), updated_at = now()
WHERE ${held(row)} RETURNING 1 AS ok`));
      return rows.length > 0;
    },
    async prune() {
      const rows = rowsOf(await exec(sql`-- workflow:command_park_prune
DELETE FROM workflow_command_outbox WHERE status IN ('done', 'dead') AND completed_at < now() - make_interval(days => ${COMMAND_RETENTION_DAYS}::int) RETURNING 1 AS gone`));
      return rows.length;
    },
  };
}

// ── Draining ────────────────────────────────────────────────────────────────

/** What one re-submission came to. */
export type Resubmitted =
  | { kind: 'answered'; outcome: string }
  /** Not answered; `unreachable` stops the pass (the control plane is still down for everything after it). */
  | { kind: 'unanswered'; error: string; priorUnknown?: boolean; unreachable?: boolean; delayMs?: number }
  /** Refused (auth, reach, shape): asking again cannot change the answer. */
  | { kind: 'refused'; error: string };

/** The kernel's own answer inside an op's result: `applied`, `duplicate`, `stale`, `rejected`, or the door's shape. */
export function outcomeOf(result: unknown): string {
  const r = result as { result?: unknown; handled?: unknown } | null;
  if (r && typeof r.result === 'string') return r.result;
  const inner = (r?.result as { result?: unknown } | null | undefined)?.result;
  if (typeof inner === 'string') return inner;
  if (r && r.handled === false) return 'not_handled';
  return 'answered';
}

/** A retry delay for the n-th attempt: soon at first, then once a floor period. */
export const parkedRetryDelayMs = (attempt: number): number => Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 60 * 60_000);

/** On the control plane: the row through the same reach check, installation and ledger as a request. */
export async function resubmitOnControlPlane(row: ParkedRow, server: CommandServerDeps = {}): Promise<Resubmitted> {
  const cmd = { v: COMMAND_API_VERSION, op: row.op, input: row.input, principal: row.principal, idempotencyKey: row.key };
  const problem = commandProblem(cmd);
  if (problem) return { kind: 'refused', error: `malformed: ${problem}` };
  const res = await applyCommandRequest(cmd as unknown as CommandRequest, server);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && body) return { kind: 'answered', outcome: body.replayed === true ? `replayed:${outcomeOf(body.result)}` : outcomeOf(body.result) };
  const code = String(body?.code ?? '');
  const error = `answered ${res.status}${code ? ` ${code}` : ''}${body?.error ? `: ${String(body.error)}` : ''}`;
  // Not this host after all (the mode moved), still running elsewhere, or the database blinked: ask again.
  if (res.status === 409 || res.status === 429 || res.status >= 500) return { kind: 'unanswered', error };
  return { kind: 'refused', error };
}

/** On the web host: through the one client, which sends it to the control plane in own mode. */
export async function resubmitFromWeb(row: ParkedRow, o: { priorUnknown: boolean; deps?: import('./kernel-client').ClientDeps } = { priorUnknown: false }): Promise<Resubmitted> {
  const client = await import('./kernel-client');
  const env = o.deps?.env ?? process.env;
  const budgetMs = Math.min(PARKED_SUBMIT_BUDGET_MS, Number(env.KERNEL_DOOR_BUDGET_MS) || Infinity);
  const op = row.op as KernelOp;
  const input = row.input as KernelOps[KernelOp]['input'];
  try {
    const a = await client.submitKernelCommand(op, input, {
      principal: row.principal, idempotencyKey: row.key, priorUnknown: o.priorUnknown, withDelivery: false, budgetMs, deps: o.deps,
    });
    return { kind: 'answered', outcome: a.replayed ? `replayed:${outcomeOf(a.result)}` : outcomeOf(a.result) };
  } catch (err) {
    if (err instanceof client.ControlPlaneUnavailableError) {
      return { kind: 'unanswered', error: err.message, priorUnknown: err.outcome === 'unknown', unreachable: true };
    }
    if (client.refusedAsUnknownOp(err, op)) {
      // Release skew, the door's own rule: a control plane that predates the op applied nothing. Never after
      // an unknown outcome, though: then only the control plane's ledger may say whether it ran.
      if (o.priorUnknown) return { kind: 'unanswered', error: `the control plane does not know ${op} yet, and an earlier submission may have reached it` };
      console.error(`[workflow] SKEW: the control plane does not know ${op}; applying the parked command ${row.key} on the web host instead.`);
      return { kind: 'answered', outcome: outcomeOf(await (o.deps?.run ?? runKernelOp)(op, input)) };
    }
    if (err instanceof client.KernelCommandRefusedError) return { kind: 'refused', error: err.message };
    // The command ran and threw (on the control plane, or here in shadow): often a GitHub read; ask again.
    return { kind: 'unanswered', error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ParkedDrainSummary { claimed: number; done: number; retried: number; dead: number; pruned: number }

export interface ParkedDrainDeps {
  outbox?: CommandOutbox;
  ledger?: CommandLedger;
  host?: () => 'control-plane' | 'web';
  now?: () => number;
  /** Re-submits one row; default by host (`resubmitOnControlPlane` / `resubmitFromWeb`). */
  resubmit?: (row: ParkedRow, o: { priorUnknown: boolean }) => Promise<Resubmitted>;
  limit?: number;
}

/**
 * One floor pass over the parked commands: each due row is asked of the ledger, then re-submitted with
 * its own key, and settled once answered. Never throws per row; a control plane still down stops the
 * pass and leaves the rest for the next.
 */
export async function drainParkedCommands(deps: ParkedDrainDeps = {}): Promise<ParkedDrainSummary> {
  const outbox = deps.outbox ?? postgresCommandOutbox();
  const ledger = deps.ledger ?? postgresCommandLedger();
  const host = (deps.host ?? kernelHost)();
  const now = deps.now ?? Date.now;
  const resubmit = deps.resubmit ?? ((row: ParkedRow, o: { priorUnknown: boolean }) => (host === 'control-plane' ? resubmitOnControlPlane(row) : resubmitFromWeb(row, o)));
  const summary: ParkedDrainSummary = { claimed: 0, done: 0, retried: 0, dead: 0, pruned: 0 };
  const rows = await outbox.claimDue(deps.limit ?? PARKED_BATCH);
  summary.claimed = rows.length;
  let stopped: string | null = null;

  const later = async (row: ParkedRow, error: string, o: { priorUnknown?: boolean; delayMs?: number; refund?: boolean } = {}) => {
    if (!o.refund && row.attempt >= PARKED_MAX_ATTEMPTS) {
      console.error(`[workflow] parked ${row.op} ${row.key} given up after ${row.attempt} attempts: ${error}`);
      if (await outbox.bury(row, error)) summary.dead++;
      return;
    }
    if (await outbox.retry(row, { error, delayMs: o.delayMs ?? parkedRetryDelayMs(row.attempt), priorUnknown: o.priorUnknown, refund: o.refund })) summary.retried++;
  };

  for (const row of rows) {
    try {
      // Not sent at all: the attempt this pass took is given back, so a row waiting behind an outage
      // is never given up for attempts it did not make.
      if (stopped) { await later(row, stopped, { delayMs: parkedRetryDelayMs(1), refund: true }); continue; }
      // The ledger first: a command that did run there is settled as it ran, whatever this host is.
      const led = await ledger.read(row.key);
      if (led?.status === 'done') {
        const body = (led.response?.body ?? {}) as Record<string, unknown>;
        if (await outbox.settle(row, `replayed:${outcomeOf(body.result)}`)) summary.done++;
        continue;
      }
      if (led?.status === 'running' && now() - Date.parse(led.claimedAt) < COMMAND_LEASE_MS) {
        await later(row, 'still running on the control plane', { delayMs: parkedRetryDelayMs(1) });
        continue;
      }
      // No ledger row: nothing ran under this key (a claim that threw is released), so the earlier
      // "may have reached it" is settled as not. A running row past its lease is taken over there.
      const r = await resubmit(row, { priorUnknown: row.priorUnknown && led !== null });
      if (r.kind === 'answered') {
        if (await outbox.settle(row, r.outcome)) summary.done++;
      } else if (r.kind === 'refused') {
        console.error(`[workflow] parked ${row.op} ${row.key} refused, given up: ${r.error}`);
        if (await outbox.bury(row, r.error)) summary.dead++;
      } else {
        if (r.unreachable) stopped = r.error;
        await later(row, r.error, { priorUnknown: r.priorUnknown, delayMs: r.delayMs });
      }
    } catch (err) {
      await later(row, err instanceof Error ? err.message : String(err)).catch(() => {});
    }
  }
  summary.pruned = await outbox.prune().catch(() => 0);
  return summary;
}
