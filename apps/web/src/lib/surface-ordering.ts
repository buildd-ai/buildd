/**
 * Surface merge ordering — Candidate 3's `mergeAfter` behaviour, built on the
 * existing open change intents rather than a second free-form dependency field
 * (docs/design/conflict-aware-orchestration.md §3).
 *
 * Opt-in twice, so the default is a no-op with no reads at all:
 *   - `gitConfig.surfaceOrdering` is 'shadow' or 'enforce' (absent/'off' = off);
 *   - at least one surface is marked `serialize: true` — a `conflictSurfaces`
 *     entry, or a `sequenceNamespaces` entry (dir + anchor + schema triggers,
 *     generated files included: a namespace is not an ordinary regenerable file).
 *
 * The decision, for one PR at one door, before any branch mutation or merge:
 *   1. read the PR's actual diff, pinned to one head and base (Step B's reader);
 *      a missing/truncated/racing read is never an empty diff — enforce defers;
 *   2. refresh this PR's intents from that diff (add, close dropped serialized
 *      surfaces, stamp the head), preserving pre-PR declarations as provisional;
 *   3. load every open intent on the PR's serialized surfaces and group them per
 *      PR — one contender per PR, however many rows (same-PR dedupe), NULL task
 *      ids included (they are still PRs), rows with no PR provisional and inert;
 *   4. order contenders by a single global key (earliest open intent, then PR
 *      number), so the wait graph is acyclic by construction: two PRs can never
 *      wait on each other, and a PR never waits on itself. A per-surface order
 *      that disagrees with the global one is reported, not obeyed;
 *   5. read each earlier contender's live PR state: a merged/closed one is a
 *      missed close event — settle it and drop it; an unreadable one defers.
 *
 * Passing that, the door reserves the surfaces (`acquireMergeSlot`) with one
 * atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE compare-and-set per surface,
 * re-checks the order, merges with the head pinned, and releases the token on
 * success or failure. A crashed door's reservation expires after a bounded TTL
 * and is reconciled against GitHub before it is reused.
 *
 * Closing a PR (`settleSurfaceIntentsOnClose`) closes its intents, drops its
 * reservations and re-drives the next contender on each surface it held — no
 * agent session waits for any of this.
 *
 * No `db.transaction()` (neon-http): every write is a single statement.
 */

import { createHash, randomUUID } from 'crypto';
import { db } from '@buildd/core/db';
import { changeIntents, surfaceReservations, workspaces } from '@buildd/core/db/schema';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { GateCallerOrigin, RecordGateEventInput } from '@buildd/core/gate-events';
import { fireRepeatGateEvent, fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import type { PrScopeRead } from '@/lib/pr-scope-reconcile';

// ── Config (pure; lives in surface-ordering-config.ts so doors can check it without loading this module) ──

export {
  resolveSurfaceOrderingMode,
  serializedSurfaceDefs,
  resolveSerializedSurfaces,
  resolveIntentSurfaces,
  type SurfaceOrderingMode,
  type SerializedSurfaceDef,
} from '@/lib/surface-ordering-config';
import { resolveSurfaceOrderingMode, serializedSurfaceDefs, resolveSerializedSurfaces } from '@/lib/surface-ordering-config';

// ── Ordering (pure) ──────────────────────────────────────────────────────────

export interface IntentRow {
  prNumber: number | null;
  taskId: string | null;
  surface: string;
  createdAt: Date;
}

export interface Contender {
  prNumber: number;
  taskId: string | null;
  /** Earliest open intent of this PR, ms. The one global ordering key. */
  createdAt: number;
  surfaces: string[];
  /** Per-surface earliest intent, ms — used only to report inversions. */
  surfaceAt: Record<string, number>;
}

export function groupContenders(rows: IntentRow[]): Contender[] {
  const byPr = new Map<number, Contender>();
  for (const r of rows) {
    if (r.prNumber === null || r.prNumber === undefined) continue; // provisional: cannot merge
    const at = new Date(r.createdAt).getTime();
    const c = byPr.get(r.prNumber) ?? { prNumber: r.prNumber, taskId: r.taskId ?? null, createdAt: at, surfaces: [], surfaceAt: {} };
    c.createdAt = Math.min(c.createdAt, at);
    if (!c.taskId && r.taskId) c.taskId = r.taskId;
    if (!c.surfaces.includes(r.surface)) c.surfaces.push(r.surface);
    c.surfaceAt[r.surface] = Math.min(c.surfaceAt[r.surface] ?? Infinity, at);
    byPr.set(r.prNumber, c);
  }
  return [...byPr.values()].sort(compareContenders);
}

/** Stable total order: earliest intent first, PR number breaks ties. */
export function compareContenders(a: Pick<Contender, 'createdAt' | 'prNumber'>, b: Pick<Contender, 'createdAt' | 'prNumber'>): number {
  return a.createdAt - b.createdAt || a.prNumber - b.prNumber;
}

export interface OrderEvaluation {
  blockers: Array<{ prNumber: number; taskId: string | null; surfaces: string[] }>;
  /** Earlier-by-global-order contenders that are LATER on some shared surface: a would-be cycle. */
  inversions: Array<{ prNumber: number; surfaces: string[] }>;
  /** Digest of the contender set this answer was computed from. */
  revision: string;
}

/**
 * Which open PRs must close before `prNumber` may merge. A PR whose own rows
 * are missing (its intent write failed) is ordered last — conservative.
 */
export function evaluateSurfaceOrder(prNumber: number, rows: IntentRow[]): OrderEvaluation {
  const contenders = groupContenders(rows);
  const self = contenders.find((c) => c.prNumber === prNumber) ?? null;
  const selfKey = self ?? { prNumber, createdAt: Number.POSITIVE_INFINITY };
  const selfSurfaces = new Set(self?.surfaces ?? rows.map((r) => r.surface));
  const blockers: OrderEvaluation['blockers'] = [];
  const inversions: OrderEvaluation['inversions'] = [];
  for (const c of contenders) {
    if (c.prNumber === prNumber) continue;
    const shared = c.surfaces.filter((s) => selfSurfaces.has(s));
    if (shared.length === 0) continue;
    if (compareContenders(c, selfKey) < 0) {
      blockers.push({ prNumber: c.prNumber, taskId: c.taskId, surfaces: shared });
      if (self) {
        const inverted = shared.filter((s) => (self.surfaceAt[s] ?? Infinity) < (c.surfaceAt[s] ?? Infinity));
        if (inverted.length) inversions.push({ prNumber: c.prNumber, surfaces: inverted });
      }
    }
  }
  const revision = createHash('sha256')
    .update(contenders.map((c) => `${c.prNumber}:${[...c.surfaces].sort().join(',')}`).join('|'))
    .digest('hex')
    .slice(0, 16);
  return { blockers, inversions, revision };
}

// ── SQL ──────────────────────────────────────────────────────────────────────

export function openIntentsOnSurfacesWhere(workspaceId: string, surfaces: string[]): SQL {
  return and(
    eq(changeIntents.workspaceId, workspaceId),
    inArray(changeIntents.surface, surfaces),
    isNull(changeIntents.closedAt),
  )!;
}

export function ownOpenIntentsWhere(workspaceId: string, prNumber: number): SQL {
  return and(
    eq(changeIntents.workspaceId, workspaceId),
    eq(changeIntents.prNumber, prNumber),
    isNull(changeIntents.closedAt),
  )!;
}

/**
 * ON CONFLICT ... DO UPDATE ... WHERE. Without `takeoverToken`, only this PR's
 * own row is replaced (a second door for the same PR, or its new head). With
 * one, the caller has already reconciled that exact expired hold against
 * GitHub: replace it only if it is still that token and still expired, so of
 * two reconcilers exactly one wins.
 */
export function reservationTakeoverWhere(takeoverToken: string | null = null): SQL {
  const samePr = sql`${surfaceReservations.prNumber} = excluded.pr_number`;
  if (!takeoverToken) return samePr;
  return sql`(${samePr} OR (${surfaceReservations.token} = ${takeoverToken}::uuid AND ${surfaceReservations.expiresAt} < now()))`;
}

export { intentInsertIfAbsentSql } from '@/lib/change-intent';
import { intentInsertIfAbsentSql } from '@/lib/change-intent';

// ── Deps ─────────────────────────────────────────────────────────────────────

export type PrLiveState = 'open' | 'merged' | 'closed';

export interface ReconcileOwnIntentsInput {
  workspaceId: string;
  prNumber: number;
  taskId: string | null;
  headSha: string;
  /** Serialized surfaces the actual diff touches. */
  actualSurfaces: string[];
  /** Every configured serialized surface — own rows on one of these not in the diff are closed. */
  serializedSurfaces: string[];
}

export interface ReservationHolder { prNumber: number; expiresAt: Date; token: string }

export interface ReserveAttempt {
  workspaceId: string;
  repoFullName: string;
  surface: string;
  prNumber: number;
  headSha: string;
  baseSha: string | null;
  ttlMs: number;
  now: number;
  /** Replace this exact expired hold (already reconciled against GitHub). */
  takeoverToken?: string | null;
}

export interface SurfaceOrderingDeps {
  readScope: (installationId: number, repoFullName: string, prNumber: number, expectedHeadSha: string | null) => Promise<PrScopeRead>;
  reconcileOwnIntents: (input: ReconcileOwnIntentsInput) => Promise<void>;
  loadOpenIntents: (workspaceId: string, surfaces: string[]) => Promise<IntentRow[]>;
  readPrState: (repoFullName: string, prNumber: number, installationId: number) => Promise<PrLiveState>;
  /** Settle a PR found closed; `exceptPr` (the PR being evaluated) is never re-driven from inside its own decision. */
  settleClosedPr: (workspaceId: string, prNumber: number, exceptPr?: number) => Promise<void>;
  record: (event: RecordGateEventInput) => void;
  // Reservation store (acquireMergeSlot only).
  tryReserve?: (r: ReserveAttempt) => Promise<{ acquired: true; token: string } | { acquired: false; holder: ReservationHolder | null }>;
  readHolder?: (workspaceId: string, repoFullName: string, surface: string) => Promise<ReservationHolder | null>;
  releaseToken?: (workspaceId: string, repoFullName: string, surface: string, token: string) => Promise<void>;
  now?: () => number;
}

/** Bounded: a merge call returns in seconds; a crashed door's hold lapses in minutes. */
export const SURFACE_RESERVATION_TTL_MS = 5 * 60_000;
/** Earlier contenders whose live state one evaluation will read before deferring on the rest. */
export const MAX_BLOCKER_READS = 5;
/** Coalescing window for repeated identical waits. */
const WAIT_COALESCE_MS = 6 * 60 * 60_000;

// ── Guard ────────────────────────────────────────────────────────────────────

export interface GuardInput {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  /** The live head the door is about to act on; null when the door has not read it. */
  headSha: string | null;
  gitConfig: WorkspaceGitConfig | null | undefined;
  taskId: string | null;
  workerId: string | null;
  door: string;
  callerOrigin: GateCallerOrigin;
  /** Compute only: no intent writes, no settling, no ledger (landing shadow). */
  observeOnly?: boolean;
  /** An explicit, authorized override: proceed, but ledger it as `bypassed`. */
  override?: boolean;
}

export interface MergeSlotRequest {
  workspaceId: string;
  repoFullName: string;
  installationId: number;
  prNumber: number;
  headSha: string;
  baseSha: string | null;
  surfaces: string[];
  revision: string;
  taskId: string | null;
  workerId: string | null;
  door: string;
  callerOrigin: GateCallerOrigin;
  gitConfig: WorkspaceGitConfig | null | undefined;
}

export type SurfaceOrderingVerdict =
  | { blocks: false; slot: MergeSlotRequest | null }
  | {
      blocks: true;
      kind: 'ordering' | 'unverified';
      reason: string;
      counterpartPrNumber: number | null;
      surface: string | null;
    };

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function guardSurfaceOrdering(input: GuardInput, depsIn?: Partial<SurfaceOrderingDeps>): Promise<SurfaceOrderingVerdict> {
  const mode = resolveSurfaceOrderingMode(input.gitConfig);
  if (mode === 'off') return { blocks: false, slot: null };
  const defs = serializedSurfaceDefs(input.gitConfig);
  if (defs.length === 0) return { blocks: false, slot: null };

  const deps = { ...defaultDeps(), ...depsIn } as SurfaceOrderingDeps;
  const enforce = mode === 'enforce' && !input.override;
  const quiet = input.observeOnly === true;
  let headSha = input.headSha;
  let baseSha: string | null = null;

  const record = (outcome: RecordGateEventInput['outcome'], reason: string, detail: Record<string, unknown>) => {
    if (quiet) return;
    try {
      deps.record({
        gate: GATE_SLUGS.SURFACE_ORDERING,
        surface: input.door,
        outcome,
        reason,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        workerId: input.workerId,
        callerOrigin: input.callerOrigin,
        detail: { prNumber: input.prNumber, headSha, baseSha, repoFullName: input.repoFullName, door: input.door, mode, ...detail },
      });
    } catch (err) {
      console.warn('[surface-ordering] ledger write failed:', errMessage(err));
    }
  };

  /** Shadow/override never block; enforce does. Every would-block is ledgered once. */
  const refuse = (kind: 'ordering' | 'unverified', reason: string, counterpartPrNumber: number | null, surface: string | null, extra: Record<string, unknown> = {}): SurfaceOrderingVerdict => {
    const detail = { kind, counterpartPrNumber, surface, ...extra };
    if (input.override && mode === 'enforce') {
      record('bypassed', reason, detail);
      return { blocks: false, slot: null };
    }
    if (!enforce) {
      record('warned', reason, { ...detail, shadow: true });
      return { blocks: false, slot: null };
    }
    record('deferred', reason, detail);
    return { blocks: true, kind, reason, counterpartPrNumber, surface };
  };

  // 1. The actual diff, pinned.
  let scope: PrScopeRead;
  try {
    scope = await deps.readScope(input.installationId, input.repoFullName, input.prNumber, headSha);
  } catch (err) {
    return refuse('unverified', `could not read this PR's diff to check surface order: ${errMessage(err)}`, null, null);
  }
  if (scope.status === 'closed') return { blocks: false, slot: null };
  if (scope.status === 'incomplete') {
    headSha = scope.headSha ?? headSha;
    baseSha = scope.baseSha;
    return refuse('unverified', `could not verify this PR's surfaces (${scope.reason}): ${scope.detail}`, null, null, { scopeReason: scope.reason });
  }
  headSha = scope.headSha;
  baseSha = scope.baseSha;
  const surfaces = resolveSerializedSurfaces(scope.files, input.gitConfig);

  // 2. Refresh this PR's intents from the diff (also closes dropped serialized surfaces).
  if (!quiet) {
    try {
      await deps.reconcileOwnIntents({
        workspaceId: input.workspaceId,
        prNumber: input.prNumber,
        taskId: input.taskId,
        headSha,
        actualSurfaces: surfaces,
        serializedSurfaces: defs.map((d) => d.label),
      });
    } catch (err) {
      return refuse('unverified', `could not record this PR's surface intents: ${errMessage(err)}`, null, surfaces[0] ?? null);
    }
  }
  if (surfaces.length === 0) return { blocks: false, slot: null };

  // 3–4. Open intents → ordered contenders.
  let rows: IntentRow[];
  try {
    rows = await deps.loadOpenIntents(input.workspaceId, surfaces);
  } catch (err) {
    return refuse('unverified', `could not read open change intents: ${errMessage(err)}`, null, surfaces[0]);
  }
  const order = evaluateSurfaceOrder(input.prNumber, rows);
  if (order.inversions.length > 0) {
    record('warned', 'surface order differs across surfaces; the global order decides', {
      kind: 'cross_surface_cycle',
      inversions: order.inversions,
      revision: order.revision,
    });
  }

  // 5. Live state of each earlier contender: reconcile missed closes.
  const remaining: OrderEvaluation['blockers'] = [];
  for (const [i, b] of order.blockers.entries()) {
    if (i >= MAX_BLOCKER_READS) {
      remaining.push(b);
      continue;
    }
    let state: PrLiveState;
    try {
      state = await deps.readPrState(input.repoFullName, b.prNumber, input.installationId);
    } catch (err) {
      return refuse('unverified', `could not verify whether PR #${b.prNumber} is still open: ${errMessage(err)}`, b.prNumber, b.surfaces[0] ?? null);
    }
    if (state === 'open') {
      remaining.push(b);
      continue;
    }
    if (!quiet) {
      await deps.settleClosedPr(input.workspaceId, b.prNumber, input.prNumber).catch((err) =>
        console.warn(`[surface-ordering] settling missed close of PR #${b.prNumber} failed:`, errMessage(err)),
      );
    }
  }

  if (remaining.length > 0) {
    const first = remaining[0];
    return refuse(
      'ordering',
      `waiting for PR #${first.prNumber} to close first: both change ${first.surfaces.join(', ')}`,
      first.prNumber,
      first.surfaces[0] ?? null,
      { waitingOn: remaining.map((b) => b.prNumber), revision: order.revision },
    );
  }

  if (!enforce) return { blocks: false, slot: null };
  return {
    blocks: false,
    slot: {
      workspaceId: input.workspaceId,
      repoFullName: input.repoFullName,
      installationId: input.installationId,
      prNumber: input.prNumber,
      headSha,
      baseSha,
      surfaces,
      revision: order.revision,
      taskId: input.taskId,
      workerId: input.workerId,
      door: input.door,
      callerOrigin: input.callerOrigin,
      gitConfig: input.gitConfig,
    },
  };
}

// ── Merge slot ───────────────────────────────────────────────────────────────

export type MergeSlot = { ok: true; release: () => Promise<void> } | { ok: false; reason: string };

const NO_SLOT: MergeSlot = { ok: true, release: async () => {} };

/**
 * Reserve every surface for this PR, re-check the order, and hand back a
 * release. A null request (ordering off/shadow, or nothing serialized) is a
 * free pass. Never throws: a store failure refuses the slot.
 */
export async function acquireMergeSlot(req: MergeSlotRequest | null, depsIn?: Partial<SurfaceOrderingDeps>): Promise<MergeSlot> {
  if (!req || req.surfaces.length === 0) return NO_SLOT;
  const deps = { ...defaultDeps(), ...depsIn } as SurfaceOrderingDeps;
  const now = deps.now ?? Date.now;
  const held: Array<{ surface: string; token: string }> = [];
  const release = async () => {
    for (const h of held.splice(0)) {
      await deps.releaseToken!(req.workspaceId, req.repoFullName, h.surface, h.token).catch((err) =>
        console.warn(`[surface-ordering] release of ${h.surface} for PR #${req.prNumber} failed (expires on its own):`, errMessage(err)),
      );
    }
  };
  const record = (outcome: RecordGateEventInput['outcome'], reason: string, detail: Record<string, unknown>) => {
    try {
      deps.record({
        gate: GATE_SLUGS.SURFACE_ORDERING,
        surface: req.door,
        outcome,
        reason,
        workspaceId: req.workspaceId,
        taskId: req.taskId,
        workerId: req.workerId,
        callerOrigin: req.callerOrigin,
        detail: { prNumber: req.prNumber, headSha: req.headSha, baseSha: req.baseSha, repoFullName: req.repoFullName, door: req.door, revision: req.revision, ...detail },
      });
    } catch { /* ledger is never what fails a merge */ }
  };
  const refuse = async (reason: string, detail: Record<string, unknown>): Promise<MergeSlot> => {
    await release();
    record('deferred', reason, detail);
    return { ok: false, reason };
  };

  try {
    for (const surface of [...req.surfaces].sort()) {
      const res = await deps.tryReserve!({
        workspaceId: req.workspaceId, repoFullName: req.repoFullName, surface, prNumber: req.prNumber,
        headSha: req.headSha, baseSha: req.baseSha, ttlMs: SURFACE_RESERVATION_TTL_MS, now: now(),
      });
      if (res.acquired) {
        held.push({ surface, token: res.token });
        continue;
      }
      const holder = res.holder ?? (await deps.readHolder!(req.workspaceId, req.repoFullName, surface));
      if (!holder || holder.expiresAt.getTime() >= now()) {
        return refuse(`PR #${holder?.prNumber ?? '?'} is merging on ${surface} right now`, { kind: 'reserved', surface, counterpartPrNumber: holder?.prNumber ?? null });
      }
      // An expired hold: GitHub mutation could not share a transaction with it,
      // so ask GitHub what happened to the holder before reusing the slot.
      let state: PrLiveState;
      try {
        state = await deps.readPrState(req.repoFullName, holder.prNumber, req.installationId);
      } catch (err) {
        return refuse(`could not verify the expired reservation of PR #${holder.prNumber} on ${surface}: ${errMessage(err)}`, { kind: 'unverified', surface, counterpartPrNumber: holder.prNumber });
      }
      if (state !== 'open') await deps.settleClosedPr(req.workspaceId, holder.prNumber, req.prNumber).catch(() => {});
      const retry = await deps.tryReserve!({
        workspaceId: req.workspaceId, repoFullName: req.repoFullName, surface, prNumber: req.prNumber,
        headSha: req.headSha, baseSha: req.baseSha, ttlMs: SURFACE_RESERVATION_TTL_MS, now: now(),
        takeoverToken: holder.token,
      });
      if (!retry.acquired) {
        return refuse(`another PR took the ${surface} reservation first`, { kind: 'reserved', surface, counterpartPrNumber: retry.holder?.prNumber ?? null });
      }
      held.push({ surface, token: retry.token });
    }

    // Recheck immediately before the merge: the order may have changed since the guard read it.
    const rows = await deps.loadOpenIntents(req.workspaceId, req.surfaces);
    const order = evaluateSurfaceOrder(req.prNumber, rows);
    if (order.blockers.length > 0) {
      const b = order.blockers[0];
      return refuse(`PR #${b.prNumber} is now ahead on ${b.surfaces.join(', ')}`, { kind: 'ordering', surface: b.surfaces[0] ?? null, counterpartPrNumber: b.prNumber, recheck: true });
    }
  } catch (err) {
    return refuse(`could not reserve the merge surfaces: ${errMessage(err)}`, { kind: 'unverified' });
  }

  record('accepted', 'surface merge reservation taken', { kind: 'reserved', surfaces: req.surfaces });
  return { ok: true, release };
}

/** Reserve, run the merge, always release. A refused slot returns `{ refused }` without calling `merge`. */
export async function withMergeSlot<T>(
  req: MergeSlotRequest | null,
  merge: () => Promise<T>,
  deps?: Partial<SurfaceOrderingDeps>,
): Promise<{ refused: string } | { result: T }> {
  const slot = await acquireMergeSlot(req, deps);
  if (!slot.ok) return { refused: slot.reason };
  try {
    return { result: await merge() };
  } finally {
    await slot.release();
  }
}

// ── Close → settle + wake ────────────────────────────────────────────────────

export interface SettleDeps {
  loadOwnOpenSurfaces: (workspaceId: string, prNumber: number) => Promise<string[]>;
  closeIntents: (workspaceId: string, prNumber: number) => Promise<void>;
  releaseReservations: (workspaceId: string, prNumber: number) => Promise<void>;
  loadOpenIntents: (workspaceId: string, surfaces: string[]) => Promise<IntentRow[]>;
  loadGitConfig: (workspaceId: string) => Promise<WorkspaceGitConfig | null>;
  /** Re-evaluate a waiting PR through its normal merge door. */
  redrive: (workspaceId: string, prNumber: number) => Promise<void>;
}

/**
 * A PR merged or closed (webhook, reconcile sweep, or a guard that found the
 * close was missed): its intents close, its reservations go, and the next
 * contender on each surface it held is re-driven. Never throws.
 */
export async function settleSurfaceIntentsOnClose(
  input: { workspaceId: string; prNumber: number; exceptPr?: number },
  depsIn?: Partial<SettleDeps>,
): Promise<{ woke: number[] }> {
  const deps = { ...defaultSettleDeps(), ...depsIn } as SettleDeps;
  const { workspaceId, prNumber } = input;
  let held: string[] = [];
  try {
    held = await deps.loadOwnOpenSurfaces(workspaceId, prNumber);
  } catch (err) {
    console.warn(`[surface-ordering] could not read PR #${prNumber}'s surfaces before closing:`, errMessage(err));
  }
  try {
    await deps.closeIntents(workspaceId, prNumber);
  } catch (err) {
    console.warn(`[surface-ordering] closing PR #${prNumber}'s intents failed:`, errMessage(err));
    return { woke: [] };
  }
  await deps.releaseReservations(workspaceId, prNumber).catch(() => {});
  if (held.length === 0) return { woke: [] };

  try {
    const gitConfig = await deps.loadGitConfig(workspaceId);
    if (resolveSurfaceOrderingMode(gitConfig) !== 'enforce') return { woke: [] };
    const serialized = new Set(serializedSurfaceDefs(gitConfig).map((d) => d.label));
    const surfaces = held.filter((s) => serialized.has(s));
    if (surfaces.length === 0) return { woke: [] };
    const contenders = groupContenders(await deps.loadOpenIntents(workspaceId, surfaces)).filter((c) => c.prNumber !== prNumber);
    const next = new Set<number>();
    for (const s of surfaces) {
      const head = contenders.find((c) => c.surfaces.includes(s));
      if (head && head.prNumber !== input.exceptPr) next.add(head.prNumber);
    }
    const woke: number[] = [];
    for (const n of next) {
      try {
        await deps.redrive(workspaceId, n);
        woke.push(n);
      } catch (err) {
        console.warn(`[surface-ordering] waking PR #${n} after #${prNumber} closed failed:`, errMessage(err));
      }
    }
    return { woke };
  } catch (err) {
    console.warn(`[surface-ordering] wakeup after PR #${prNumber} closed failed:`, errMessage(err));
    return { woke: [] };
  }
}

// ── Default bindings ─────────────────────────────────────────────────────────

function defaultDeps(): SurfaceOrderingDeps {
  return {
    async readScope(installationId, repoFullName, prNumber, expectedHeadSha) {
      const [{ readPinnedPrScope }, { githubApi }] = await Promise.all([import('@/lib/pr-scope-reconcile'), import('@/lib/github')]);
      return readPinnedPrScope((path) => githubApi(installationId, path), { repoFullName, prNumber, expectedHeadSha });
    },
    reconcileOwnIntents: reconcileOwnIntentsDb,
    loadOpenIntents: loadOpenIntentsDb,
    async readPrState(repoFullName, prNumber, installationId) {
      const { githubApi } = await import('@/lib/github');
      const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
      if (pr?.merged === true || typeof pr?.merged_at === 'string') return 'merged';
      if (pr?.state === 'closed') return 'closed';
      if (pr?.state === 'open') return 'open';
      throw new Error(`unrecognised PR state ${String(pr?.state)}`);
    },
    settleClosedPr: (workspaceId, prNumber, exceptPr) => settleSurfaceIntentsOnClose({ workspaceId, prNumber, exceptPr }).then(() => {}),
    record: (event) => {
      if (event.outcome === 'deferred' || event.outcome === 'warned') {
        const d = event.detail ?? {};
        fireRepeatGateEvent(event, {
          key: { pr: String(d.prNumber ?? ''), kind: String(d.kind ?? ''), counterpart: String(d.counterpartPrNumber ?? ''), head: String(d.headSha ?? '') },
          windowMs: WAIT_COALESCE_MS,
        });
      } else {
        fireGateEvent(event);
      }
    },
    tryReserve: tryReserveDb,
    readHolder: readHolderDb,
    releaseToken: releaseTokenDb,
  };
}

function defaultSettleDeps(): SettleDeps {
  return {
    async loadOwnOpenSurfaces(workspaceId, prNumber) {
      const rows = await db.select({ surface: changeIntents.surface }).from(changeIntents).where(ownOpenIntentsWhere(workspaceId, prNumber));
      return [...new Set(rows.map((r) => r.surface))];
    },
    async closeIntents(workspaceId, prNumber) {
      await db.update(changeIntents).set({ closedAt: new Date() }).where(ownOpenIntentsWhere(workspaceId, prNumber));
    },
    async releaseReservations(workspaceId, prNumber) {
      await db.delete(surfaceReservations).where(and(eq(surfaceReservations.workspaceId, workspaceId), eq(surfaceReservations.prNumber, prNumber)));
    },
    loadOpenIntents: loadOpenIntentsDb,
    async loadGitConfig(workspaceId) {
      const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { gitConfig: true } });
      return (ws?.gitConfig as WorkspaceGitConfig | null) ?? null;
    },
    async redrive(workspaceId, prNumber) {
      const { redriveSurfaceWaiter } = await import('@/lib/surface-ordering-wake');
      await redriveSurfaceWaiter(workspaceId, prNumber);
    },
  };
}

async function loadOpenIntentsDb(workspaceId: string, surfaces: string[]): Promise<IntentRow[]> {
  if (surfaces.length === 0) return [];
  return db
    .select({ prNumber: changeIntents.prNumber, taskId: changeIntents.taskId, surface: changeIntents.surface, createdAt: changeIntents.createdAt })
    .from(changeIntents)
    .where(openIntentsOnSurfacesWhere(workspaceId, surfaces));
}

async function reconcileOwnIntentsDb(i: ReconcileOwnIntentsInput): Promise<void> {
  const own = ownOpenIntentsWhere(i.workspaceId, i.prNumber);
  // Same-PR head update: every open row of this PR now describes this head.
  await db.update(changeIntents).set({ headSha: i.headSha }).where(own);
  // The diff is authoritative over the declaration for serialized surfaces.
  const dropped = i.serializedSurfaces.filter((s) => !i.actualSurfaces.includes(s));
  if (dropped.length > 0) {
    await db.update(changeIntents).set({ closedAt: new Date() }).where(and(own, inArray(changeIntents.surface, dropped)));
  }
  for (const surface of i.actualSurfaces) {
    await db.execute(intentInsertIfAbsentSql({
      workspaceId: i.workspaceId, surface, taskId: i.taskId, prNumber: i.prNumber, branch: null, headSha: i.headSha,
    }));
  }
}

async function tryReserveDb(r: ReserveAttempt) {
  const token = randomUUID();
  const rows = await db
    .insert(surfaceReservations)
    .values({
      workspaceId: r.workspaceId,
      repoFullName: r.repoFullName,
      surface: r.surface,
      prNumber: r.prNumber,
      headSha: r.headSha,
      baseSha: r.baseSha,
      token,
      reservedAt: new Date(r.now),
      expiresAt: new Date(r.now + r.ttlMs),
    })
    .onConflictDoUpdate({
      target: [surfaceReservations.workspaceId, surfaceReservations.repoFullName, surfaceReservations.surface],
      set: {
        prNumber: sql`excluded.pr_number`,
        headSha: sql`excluded.head_sha`,
        baseSha: sql`excluded.base_sha`,
        token: sql`excluded.token`,
        reservedAt: sql`excluded.reserved_at`,
        expiresAt: sql`excluded.expires_at`,
      },
      setWhere: reservationTakeoverWhere(r.takeoverToken ?? null),
    })
    .returning({ token: surfaceReservations.token });
  if (rows[0]?.token === token) return { acquired: true as const, token };
  return { acquired: false as const, holder: null };
}

async function readHolderDb(workspaceId: string, repoFullName: string, surface: string) {
  const [row] = await db
    .select({ prNumber: surfaceReservations.prNumber, expiresAt: surfaceReservations.expiresAt, token: surfaceReservations.token })
    .from(surfaceReservations)
    .where(and(eq(surfaceReservations.workspaceId, workspaceId), eq(surfaceReservations.repoFullName, repoFullName), eq(surfaceReservations.surface, surface)))
    .limit(1);
  return row ?? null;
}

async function releaseTokenDb(workspaceId: string, repoFullName: string, surface: string, token: string) {
  await db
    .delete(surfaceReservations)
    .where(and(
      eq(surfaceReservations.workspaceId, workspaceId),
      eq(surfaceReservations.repoFullName, repoFullName),
      eq(surfaceReservations.surface, surface),
      eq(surfaceReservations.token, token),
    ));
}
