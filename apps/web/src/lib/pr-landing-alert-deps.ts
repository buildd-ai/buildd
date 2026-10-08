/**
 * Database- and channel-bound pieces of the landing alert. State lives on the
 * PR's owning task at `context.landing`, next to the marker (a marker write
 * merges with `||`, so these keys survive it):
 *
 *   pagedKeys  – dedupe keys already paged
 *   observed   – named clocks (ISO), first-seen times the alert policy compares against now
 *   progress   – { fp, since }: the current landing-progress fingerprint and when it became current
 *   actions    – signed-link nonces → { status: 'claimed' | 'done', ... }
 *
 * Every write is one atomic UPDATE ... WHERE ... RETURNING (neon-http has no
 * interactive transactions), exactly like `escalateConflictExhaustion`.
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { notifyTeamOf } from '@/lib/notify';
import { alertOnLanding, type LandingAlertDeps, type LandingAlertInput } from '@/lib/pr-landing-alert';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

async function readLanding(taskId: string): Promise<Record<string, unknown>> {
  const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { context: true } });
  const ctx = row?.context as unknown;
  return isObj(ctx) && isObj(ctx.landing) ? ctx.landing : {};
}

/** Atomically add `key` to `landing.pagedKeys`; true only for the caller whose UPDATE matched. */
export async function claimPageKey(taskId: string, key: string): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), '{landing}', COALESCE(${tasks.context}->'landing', '{}'::jsonb) || jsonb_build_object('pagedKeys', COALESCE(${tasks.context}->'landing'->'pagedKeys', '[]'::jsonb) || jsonb_build_array(${key}::text)), true)`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        sql`NOT (COALESCE(${tasks.context}->'landing'->'pagedKeys', '[]'::jsonb) @> jsonb_build_array(${key}::text))`,
      ),
    )
    .returning({ id: tasks.id });
  return rows.length > 0;
}

export async function observeClock(taskId: string, key: string, nowIso: string, startIfAbsent: boolean): Promise<string | null> {
  const read = async () => {
    const observed = (await readLanding(taskId)).observed;
    const v = isObj(observed) ? observed[key] : null;
    return typeof v === 'string' ? v : null;
  };
  const existing = await read();
  if (existing || !startIfAbsent) return existing;
  await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), '{landing}', COALESCE(${tasks.context}->'landing', '{}'::jsonb) || jsonb_build_object('observed', COALESCE(${tasks.context}->'landing'->'observed', '{}'::jsonb) || jsonb_build_object(${key}::text, ${nowIso}::text)), true)`,
    })
    .where(and(eq(tasks.id, taskId), sql`(${tasks.context}->'landing'->'observed'->>${key}) IS NULL`));
  // A concurrent first observer may have won; its time is the clock.
  return (await read()) ?? nowIso;
}

/** Record `fingerprint` as the current landing state; returns when it became current. */
export async function markProgress(taskId: string, fingerprint: string, nowIso: string): Promise<string> {
  await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), '{landing}', COALESCE(${tasks.context}->'landing', '{}'::jsonb) || jsonb_build_object('progress', jsonb_build_object('fp', ${fingerprint}::text, 'since', ${nowIso}::text)), true)`,
    })
    .where(and(eq(tasks.id, taskId), sql`(${tasks.context}->'landing'->'progress'->>'fp') IS DISTINCT FROM ${fingerprint}::text`));
  const progress = (await readLanding(taskId)).progress;
  // A concurrent caller with another fingerprint may have just written: either way the state moved now.
  return isObj(progress) && progress.fp === fingerprint && typeof progress.since === 'string' ? progress.since : nowIso;
}

async function readLiveHead(input: LandingAlertInput): Promise<string | null> {
  if (!input.installationId) return null;
  const { githubApi } = await import('@/lib/github');
  const pr = (await githubApi(input.installationId, `/repos/${input.repoFullName}/pulls/${input.prNumber}`)) as { head?: { sha?: string } } | null;
  return pr?.head?.sha ?? null;
}

async function lastReviewAt(workspaceId: string, prNumber: number): Promise<number | null> {
  const { readReviewApprovedAt } = await import('@/lib/pr-landing-clock');
  return readReviewApprovedAt(workspaceId, prNumber);
}

export async function hasPagedHead(taskId: string, prefix: string): Promise<boolean> {
  const keys = (await readLanding(taskId)).pagedKeys;
  return Array.isArray(keys) && keys.some((k) => typeof k === 'string' && k.startsWith(prefix));
}

export interface ActionRecord {
  status: 'claimed' | 'done';
  at: string;
  action?: string;
  result?: Record<string, unknown>;
}

export async function readActionRecord(taskId: string, nonce: string): Promise<ActionRecord | null> {
  const actions = (await readLanding(taskId)).actions;
  const rec = isObj(actions) ? actions[nonce] : null;
  return isObj(rec) && (rec.status === 'claimed' || rec.status === 'done') ? (rec as unknown as ActionRecord) : null;
}

/** Single use: true for exactly one caller per nonce. */
export async function claimActionNonce(taskId: string, nonce: string, record: ActionRecord): Promise<boolean> {
  const json = JSON.stringify(record);
  const rows = await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), '{landing}', COALESCE(${tasks.context}->'landing', '{}'::jsonb) || jsonb_build_object('actions', COALESCE(${tasks.context}->'landing'->'actions', '{}'::jsonb) || jsonb_build_object(${nonce}::text, ${json}::jsonb)), true)`,
    })
    .where(and(eq(tasks.id, taskId), sql`(${tasks.context}->'landing'->'actions'->${nonce}) IS NULL`))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/** Overwrite a claimed nonce's record (to mark it done with its result). */
export async function settleActionNonce(taskId: string, nonce: string, record: ActionRecord): Promise<void> {
  const json = JSON.stringify(record);
  await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), '{landing}', COALESCE(${tasks.context}->'landing', '{}'::jsonb) || jsonb_build_object('actions', COALESCE(${tasks.context}->'landing'->'actions', '{}'::jsonb) || jsonb_build_object(${nonce}::text, ${json}::jsonb)), true)`,
    })
    .where(eq(tasks.id, taskId));
}

/** Free a claimed nonce after the action failed, so the person can tap again. */
export async function releaseActionNonce(taskId: string, nonce: string): Promise<void> {
  await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(${tasks.context}, '{landing,actions}', (${tasks.context}->'landing'->'actions') - ${nonce}::text, true)`,
    })
    .where(and(eq(tasks.id, taskId), sql`(${tasks.context}->'landing'->'actions'->${nonce}) IS NOT NULL`));
}

/** A person asked for another go: restart the treadmill budget without touching the dedupe keys. */
export async function resetRefreshBudget(taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ context: sql`jsonb_set(${tasks.context}, '{landing,refreshCount}', '0'::jsonb, true)` })
    .where(and(eq(tasks.id, taskId), sql`(${tasks.context}->'landing'->'refreshCount') IS NOT NULL`));
}

export const landingAlertDeps: LandingAlertDeps = {
  now: () => Date.now(),
  observe: observeClock,
  markProgress,
  lastReviewAt,
  readLiveHead,
  hasPagedHead,
  claimKey: claimPageKey,
  send: (subject, payload) => notifyTeamOf(subject, 'needsAttention', payload),
  appUrl: () => process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev',
};

export const raiseLandingAlert = (input: LandingAlertInput): Promise<void> => alertOnLanding(input, landingAlertDeps);
