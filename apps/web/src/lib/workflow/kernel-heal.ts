/**
 * The fast heal for a kernel delivery whose merge or close was seen but not applied
 * (docs/specs/workflow-kernel-library.md §1, S4a). For a delivery-owned task the worker
 * columns move only in T17 / T18, so a merge the kernel did not apply (the webhook's live read
 * failed, a render recorded the fact unapplied, a dependency gate saw it from a page) must
 * reach the reducer in minutes, not on the hourly floor.
 *
 * A Redis due-queue (`buildd:due:kernel-heal`, lib/redis.ts) holds the delivery ids, scored by
 * when to look. The per-minute `/api/cron/dispatch-drain?gate=due` tick asks Redis whether any
 * are due (no Postgres touched when none are) and runs `reconcileKernelDeliveries` for exactly
 * those, with no quiet window: the same floor pass, narrowed to one delivery. A dropped ZADD
 * costs one floor interval, never the heal: the floor puts a delivery with an unapplied
 * terminal fact first (reconcile.ts `floorCandidatesSql`).
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { clearDue, countDue, delKey, getKey, listDue, markDueEarliest, setWithTtl } from '@/lib/redis';
import type { Exec } from './kernel';
import type { FloorSummary } from './seam';

export const KERNEL_HEAL_QUEUE = 'kernel-heal';
/** Long enough for a transient GitHub failure to clear; short enough that "minutes" holds. */
export const KERNEL_HEAL_DELAY_MS = 60_000;
/** A delivery still owed a heal after a pass is looked at again after this. */
export const KERNEL_HEAL_RETRY_MS = 5 * 60_000;
/** After this long the hourly floor owns it (it orders unapplied terminal facts first). */
export const KERNEL_HEAL_GIVE_UP_MS = 60 * 60_000;
const BATCH = 10;
/** The whole tick's share of a minute (dispatch-drain runs it after its own drain, in what is left). */
export const KERNEL_HEAL_BUDGET_MS = 10_000;
/** Each GitHub call the heal's reconcile makes is aborted after this. */
export const KERNEL_HEAL_READ_TIMEOUT_MS = 5_000;
/** Heals per delivery before the floor owns it (12 x 5 min: the hour the floor is the backstop for). */
export const KERNEL_HEAL_MAX_ATTEMPTS = 12;
const attemptsKey = (id: string) => `buildd:kernel-heal-attempts:${id}`;
const ATTEMPTS_TTL_SEC = 2 * 60 * 60;

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/**
 * Look at this delivery again in `delayMs`. The earliest due time wins (ZADD LT): a page
 * re-rendered every few seconds cannot keep pushing the heal back. Never throws: the floor is
 * the backstop.
 */
export async function scheduleKernelHeal(deliveryId: string, delayMs = KERNEL_HEAL_DELAY_MS, now = Date.now()): Promise<void> {
  await markDueEarliest(KERNEL_HEAL_QUEUE, deliveryId, now + delayMs).catch((err) => console.error(`[workflow] kernel heal schedule for ${deliveryId} failed:`, err));
}

/**
 * The kernel-owned delivery of a PR, by a plain SELECT (no release, no write): what a read may ask.
 * `repo_full_name` is compared exactly, as everywhere the kernel joins deliveries to facts
 * (`kernelDeliveryForPr`, the floor, `stillOwedHeal`): both are written from GitHub's own
 * `full_name`, never retyped, and the exact match uses `workflow_deliveries_pr_unique`.
 */
export async function kernelDeliveryIdOfPr(p: { workspaceId: string; repoFullName: string; prNumber: number }, exec: Exec = dbExec): Promise<string | null> {
  const r = ((await exec(sql`-- workflow:kernel_delivery_of_pr
SELECT d.id FROM workflow_deliveries d
WHERE d.workspace_id = ${p.workspaceId}::uuid AND d.repo_full_name = ${p.repoFullName}::text AND d.pr_number = ${p.prNumber}::int
  AND d.authority = 'kernel'
LIMIT 1`)).rows ?? [])[0] as { id?: string } | undefined;
  return r?.id ? String(r.id) : null;
}

/** Deliveries among `ids` that still hold a merge or close fact the reducer never applied, recent enough to retry. */
export async function stillOwedHeal(ids: string[], exec: Exec = dbExec, now = Date.now()): Promise<string[]> {
  if (ids.length === 0) return [];
  const since = new Date(now - KERNEL_HEAL_GIVE_UP_MS).toISOString();
  const rows = ((await exec(sql`-- workflow:still_owed_heal
SELECT d.id FROM workflow_deliveries d
WHERE d.id IN (SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) x)
  AND d.authority = 'kernel' AND d.state NOT IN ('MERGED', 'SUPERSEDED', 'ABANDONED')
  AND EXISTS (SELECT 1 FROM workflow_facts f
    WHERE f.workspace_id = d.workspace_id AND f.repo_full_name = d.repo_full_name AND f.pr_number = d.pr_number
      AND f.kind = 'pr_closed' AND f.applied_transition_id IS NULL
      AND f.observed_at > COALESCE(d.last_transition_at, d.created_at) AND f.observed_at >= ${since}::timestamptz)`)).rows ?? []) as Array<{ id: unknown }>;
  return rows.map((r) => String(r.id));
}

export interface KernelHealDeps {
  /** One delivery's floor pass. Default: `reconcileKernelDeliveries` with a reader whose every GitHub call times out. */
  reconcile?: (only: string[]) => Promise<FloorSummary>;
  exec?: Exec;
  /** Wall clock for due times. */
  now?: () => number;
  /** Elapsed-time clock for the budget (defaults to Date.now). */
  clock?: () => number;
  /** The tick's budget for all heals together. */
  budgetMs?: number;
}

export interface KernelHealResult {
  due: number;
  /** Deliveries reconciled this tick (each claimed off the queue first). */
  healed: number;
  rescheduled: number;
  /** Reconciles cut off by the budget; their deliveries were already re-marked or left to the floor. */
  timedOut: number;
  /** Due deliveries not reached before the budget ran out: still queued for the next tick. */
  deferred: number;
  /** Deliveries past KERNEL_HEAL_MAX_ATTEMPTS: the floor owns them now. */
  gaveUp: number;
}

const TIMED_OUT = Symbol('timed_out');
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms)); });
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
}

async function bumpAttempts(id: string): Promise<number> {
  const n = Number((await getKey<number>(attemptsKey(id)).catch(() => undefined)) ?? 0) + 1;
  await setWithTtl(attemptsKey(id), n, ATTEMPTS_TTL_SEC).catch(() => false);
  return n;
}

async function defaultReconcile(only: string[]): Promise<FloorSummary> {
  const [{ reconcileKernelDeliveries }, { githubReader }] = await Promise.all([import('./seam'), import('./github-facts')]);
  return reconcileKernelDeliveries(
    { reader: (installationId) => githubReader(installationId, undefined, { timeoutMs: KERNEL_HEAL_READ_TIMEOUT_MS }) },
    { only, minQuietMs: 0, limit: only.length },
  );
}

/**
 * The gated tick: take what is due and reconcile each delivery now, under a hard budget.
 *
 *  - Each delivery is CLAIMED off the queue (ZREM) before its reconcile starts, so a tick killed
 *    mid-reconcile cannot bring the same id back every minute: only `stillOwedHeal` re-marks it,
 *    and only while its attempt count (KERNEL_HEAL_MAX_ATTEMPTS, kept in Redis) allows.
 *  - The budget is checked before each delivery, and each reconcile is raced against what is
 *    left of it; every GitHub call inside is aborted after KERNEL_HEAL_READ_TIMEOUT_MS. A delivery
 *    not reached stays due for the next tick.
 *
 * `null` when Redis could not answer: nothing is taken and the floor covers it.
 */
export async function runDueKernelHeals(deps: KernelHealDeps = {}): Promise<KernelHealResult | null> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const budget = deps.budgetMs ?? KERNEL_HEAL_BUDGET_MS;
  const now = deps.now?.() ?? Date.now();
  const out: KernelHealResult = { due: 0, healed: 0, rescheduled: 0, timedOut: 0, deferred: 0, gaveUp: 0 };
  const count = await countDue(KERNEL_HEAL_QUEUE, now);
  if (count === null) return null;
  if (count === 0) return out;
  const ids = await listDue(KERNEL_HEAL_QUEUE, now, BATCH);
  out.due = ids.length;
  const reconcile = deps.reconcile ?? defaultReconcile;
  const exec = deps.exec ?? dbExec;
  for (const id of ids) {
    const left = budget - (clock() - started);
    if (left <= 0) { out.deferred++; continue; }
    // Claimed before any work: from here on only the re-mark below brings it back.
    await clearDue(KERNEL_HEAL_QUEUE, id);
    const attempt = await bumpAttempts(id);
    const r = await within(reconcile([id]).catch((err) => { console.error(`[workflow] kernel heal of ${id} failed:`, err); return null; }), left);
    if (r === TIMED_OUT) out.timedOut++;
    else out.healed++;
    const owed = r === TIMED_OUT ? [id] : await stillOwedHeal([id], exec, now).catch(() => [id]);
    if (owed.length === 0) { await delKey(attemptsKey(id)).catch(() => {}); continue; }
    if (attempt >= KERNEL_HEAL_MAX_ATTEMPTS) {
      out.gaveUp++;
      console.warn(JSON.stringify({ event: 'kernel_heal_gave_up', deliveryId: id, attempts: attempt }));
      continue;
    }
    await scheduleKernelHeal(id, KERNEL_HEAL_RETRY_MS, now);
    out.rescheduled++;
  }
  return out;
}
