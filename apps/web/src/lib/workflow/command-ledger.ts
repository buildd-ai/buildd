/**
 * The command API's idempotency ledger (`workflow_commands`,
 * docs/specs/workflow-kernel-library.md §3, AC-11): a caller-supplied key maps
 * to one execution and one stored answer. Postgres, never Worker memory: two
 * submissions with one key may land on two isolates, or one may land after the
 * isolate that ran the first is gone.
 *
 * Every statement is a single atomic UPDATE/INSERT ... RETURNING (the
 * neon-http driver has no interactive transactions):
 *  - `claim` inserts the key as `running`, or takes over a `running` row whose
 *    claim is older than the lease (the isolate that held it died);
 *  - `complete` stores the answer, only for the claim that still holds the key
 *    (its `claim_token`), so an isolate whose claim was taken over writes nothing;
 *  - `release` drops a claim that threw, so the same key may be tried again;
 *  - `read` answers a second caller.
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { Exec } from './kernel';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/** A claim older than this is presumed dead and may be taken over. Longer than any one command runs. */
export const COMMAND_LEASE_MS = 120_000;
/** Completed keys are kept this long; a retry after that is a new command. */
export const COMMAND_RETENTION_DAYS = 7;

export interface StoredAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface LedgerRow {
  key: string;
  op: string;
  principal: string;
  requestHash: string;
  status: 'running' | 'done';
  response: StoredAnswer | null;
  claimedAt: string;
}

export interface CommandLedger {
  /** True when this caller now holds the key and must run the command. */
  claim(p: { key: string; op: string; principal: string; requestHash: string; host: string; token: string }): Promise<boolean>;
  complete(p: { key: string; token: string; response: StoredAnswer; deliveryId: string | null; deliveryVersion: number | null }): Promise<boolean>;
  release(p: { key: string; token: string }): Promise<void>;
  read(key: string): Promise<LedgerRow | null>;
  /** Drops keys past retention; the floor calls it. */
  prune(): Promise<number>;
}

type J = Record<string, unknown>;
const rowsOf = (r: { rows?: unknown[] }) => (r.rows ?? []) as J[];
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export function postgresCommandLedger(exec: Exec = dbExec): CommandLedger {
  return {
    async claim(p) {
      const leaseSecs = COMMAND_LEASE_MS / 1000;
      const rows = rowsOf(await exec(sql`-- workflow:command_claim
WITH ins AS (
  INSERT INTO workflow_commands (idempotency_key, op, principal, request_hash, status, host, claim_token)
  VALUES (${p.key}::text, ${p.op}::text, ${p.principal}::text, ${p.requestHash}::text, 'running', ${p.host}::text, ${p.token}::text)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING 1 AS ok
), takeover AS (
  UPDATE workflow_commands SET claimed_at = clock_timestamp(), host = ${p.host}::text, claim_token = ${p.token}::text
  WHERE idempotency_key = ${p.key}::text AND status = 'running' AND request_hash = ${p.requestHash}::text
    AND claimed_at < clock_timestamp() - make_interval(secs => ${leaseSecs}::double precision)
    AND NOT EXISTS (SELECT 1 FROM ins)
  RETURNING 1 AS ok
)
SELECT ok FROM ins UNION ALL SELECT ok FROM takeover`));
      return rows.length > 0;
    },
    async complete(p) {
      const rows = rowsOf(await exec(sql`-- workflow:command_complete
UPDATE workflow_commands SET status = 'done', response = ${JSON.stringify(p.response)}::jsonb,
  delivery_id = ${p.deliveryId}::uuid, delivery_version = ${p.deliveryVersion}::bigint, completed_at = now()
WHERE idempotency_key = ${p.key}::text AND status = 'running' AND claim_token = ${p.token}::text
RETURNING 1 AS ok`));
      return rows.length > 0;
    },
    async release(p) {
      await exec(sql`-- workflow:command_release
DELETE FROM workflow_commands WHERE idempotency_key = ${p.key}::text AND status = 'running' AND claim_token = ${p.token}::text`);
    },
    async read(key) {
      const r = rowsOf(await exec(sql`-- workflow:command_read
SELECT idempotency_key, op, principal, request_hash, status, response, claimed_at FROM workflow_commands WHERE idempotency_key = ${key}::text`))[0];
      if (!r) return null;
      return {
        key: String(r.idempotency_key), op: String(r.op), principal: String(r.principal), requestHash: String(r.request_hash),
        status: r.status === 'done' ? 'done' : 'running', response: (r.response as StoredAnswer | null) ?? null, claimedAt: iso(r.claimed_at),
      };
    },
    async prune() {
      const rows = rowsOf(await exec(sql`-- workflow:command_prune
DELETE FROM workflow_commands WHERE created_at < now() - make_interval(days => ${COMMAND_RETENTION_DAYS}::int) RETURNING 1 AS gone`));
      return rows.length;
    },
  };
}
