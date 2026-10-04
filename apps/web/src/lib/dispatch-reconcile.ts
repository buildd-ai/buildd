/**
 * Orphan reconcile for the Dispatch transport, run by the hourly floor
 * (app/api/cron/dispatch-drain) before its drain. Design: knowledge-base
 * buildd/design/cloudflare-dispatch-transport.md, "Repair, in order of
 * normal-ness" and "Crash points"; contract: docs/specs/task-dispatch-authority.md,
 * "Dispatch transport", invariant 20 and AC-31..AC-34.
 *
 * A row is a candidate when it is `handed_off`, due over ORPHAN_MIN_AGE_MS
 * ago, and still has no terminal receipt. The floor asks the Worker
 * (`GET /v1/intents`, one call per workspace scope and ≤100 ids) and then:
 *
 *   unknown to the Worker        → re-publish (idempotent on id); past the
 *                                  ceiling, take it back instead
 *   terminal on the Worker       → project the receipt that was lost, through
 *                                  the receipts statement (idempotent)
 *   queued/attempting            → leave it; past ORPHAN_CEILING_MS, take it back
 *   Worker unreachable / 5xx     → take back this batch and every later one
 *
 * "Take back" is the design's rollback: `pending`, `transport = 'in_app'`,
 * `handed_off_at = NULL` (core fallBackToInAppSql), so the floor's drain that
 * runs next delivers it in the same tick. A Worker attempt already in flight
 * may still wake a runner once more: a duplicate wake, which the claim
 * route's atomic assignment turns into at most one run. Any later attempt is
 * refused at resolve/relay (the row is out of Dispatch's custody) and its
 * receipt changes nothing.
 */
import {
  MAX_LOOKUP_IDS,
  type IntentsLookupResponse,
  type Receipt,
} from '@buildd/dispatch-contract';
import { DISPATCH_SOURCE_SYSTEM, workspaceScope } from '@buildd/core/dispatch-envelope';
import {
  applyReceipts,
  fallBackToInApp,
  selectOrphanCandidates,
  terminalReceiptFor,
  type OrphanCandidate,
} from '@buildd/core/dispatch-handoff';
import { dispatchTransportConfig, lookupIntents, republishDispatches, type RepublishOutcome } from '@/lib/dispatch-transport';

/** Leaves the floor's drain its budget even when the Worker is slow. */
export const RECONCILE_BUDGET_MS = 15_000;

export interface ReconcileCounts {
  /** Candidates this run decided on (looked up, or taken back without asking). */
  checked: number;
  republished: number;
  /** Lost terminal receipts projected from the Worker's state. */
  projected: number;
  fellBack: number;
  /** Still queued/attempting on the Worker, under the ceiling. */
  left: number;
  /** Lookups or re-publishes that failed (unreachable, timeout, non-2xx). */
  workerErrors: number;
}

export interface ReconcilePlan {
  republish: string[];
  receipts: Receipt[];
  fallBack: string[];
  left: string[];
}

/** The scope key the Worker addresses a workspace's queue by (`system:scope`), as toEnvelope publishes it. */
export const scopeKeyFor = (workspaceId: string) => `${DISPATCH_SOURCE_SYSTEM}:${workspaceScope(workspaceId)}`;

/**
 * What to do with each candidate, given the Worker's answer. Pure. An id the
 * Worker answered neither way is left under the ceiling and taken back past
 * it, never guessed at; so is a merged intent with no target id.
 */
export function planReconcile(candidates: readonly OrphanCandidate[], res: IntentsLookupResponse, nowIso: string): ReconcilePlan {
  const known = new Map((Array.isArray(res?.known) ? res.known : []).filter(k => k && typeof k.id === 'string').map(k => [k.id, k]));
  const unknown = new Set(Array.isArray(res?.unknown) ? res.unknown : []);
  const plan: ReconcilePlan = { republish: [], receipts: [], fallBack: [], left: [] };
  for (const c of candidates) {
    const k = known.get(c.id);
    if (k) {
      const receipt = terminalReceiptFor(k, nowIso);
      if (receipt) plan.receipts.push(receipt);
      else if (k.state === 'queued' || k.state === 'attempting') (c.pastCeiling ? plan.fallBack : plan.left).push(c.id);
      else plan.fallBack.push(c.id);
    } else if (unknown.has(c.id)) {
      (c.pastCeiling ? plan.fallBack : plan.republish).push(c.id);
    } else {
      (c.pastCeiling ? plan.fallBack : plan.left).push(c.id);
    }
  }
  return plan;
}

export interface ReconcileDeps {
  configured: () => boolean;
  selectCandidates: () => Promise<OrphanCandidate[]>;
  lookup: (scope: string, ids: string[]) => Promise<IntentsLookupResponse>;
  republish: (ids: string[]) => Promise<RepublishOutcome>;
  applyReceipts: (receipts: Receipt[]) => Promise<number>;
  fallBackToInApp: (ids: string[]) => Promise<number>;
  now: () => number;
  log: (line: Record<string, unknown>) => void;
  budgetMs?: number;
}

const DEFAULT_DEPS: ReconcileDeps = {
  configured: () => dispatchTransportConfig() !== null,
  selectCandidates: () => selectOrphanCandidates(),
  lookup: (scope, ids) => lookupIntents(scope, ids),
  republish: ids => republishDispatches(ids),
  applyReceipts: r => applyReceipts(r),
  fallBackToInApp: ids => fallBackToInApp(ids),
  now: () => Date.now(),
  log: line => console.log(JSON.stringify(line)),
};

function batches(candidates: readonly OrphanCandidate[]): Array<{ scope: string; items: OrphanCandidate[] }> {
  const byWs = new Map<string, OrphanCandidate[]>();
  for (const c of candidates) byWs.set(c.workspaceId, [...(byWs.get(c.workspaceId) ?? []), c]);
  const out: Array<{ scope: string; items: OrphanCandidate[] }> = [];
  for (const [ws, items] of byWs) {
    for (let i = 0; i < items.length; i += MAX_LOOKUP_IDS) out.push({ scope: scopeKeyFor(ws), items: items.slice(i, i + MAX_LOOKUP_IDS) });
  }
  return out;
}

/**
 * One reconcile pass. Throws only if the candidate read or a Postgres write
 * fails (the floor isolates it); a Worker failure is counted, not thrown.
 * Logs one `dispatch_reconcile` line when there was anything to check.
 */
export async function reconcileOrphans(over: Partial<ReconcileDeps> = {}): Promise<ReconcileCounts> {
  const d = { ...DEFAULT_DEPS, ...over };
  const counts: ReconcileCounts = { checked: 0, republished: 0, projected: 0, fellBack: 0, left: 0, workerErrors: 0 };
  const candidates = await d.selectCandidates();
  if (candidates.length === 0) return counts;

  const started = d.now();
  const budget = d.budgetMs ?? RECONCILE_BUDGET_MS;
  const fallBack: string[] = [];
  const receipts: Receipt[] = [];
  const republish: string[] = [];

  if (!d.configured()) {
    // No Worker to ask or hand back to: every handed-off row is the in-app drain's.
    fallBack.push(...candidates.map(c => c.id));
    counts.checked = candidates.length;
  } else {
    let workerDown = false;
    for (const b of batches(candidates)) {
      if (workerDown) {
        fallBack.push(...b.items.map(c => c.id));
        counts.checked += b.items.length;
        continue;
      }
      if (d.now() - started > budget) break;
      let res: IntentsLookupResponse;
      try {
        res = await d.lookup(b.scope, b.items.map(c => c.id));
      } catch {
        counts.workerErrors++;
        workerDown = true;
        fallBack.push(...b.items.map(c => c.id));
        counts.checked += b.items.length;
        continue;
      }
      const plan = planReconcile(b.items, res, new Date(d.now()).toISOString());
      counts.checked += b.items.length;
      counts.left += plan.left.length;
      receipts.push(...plan.receipts);
      fallBack.push(...plan.fallBack);
      republish.push(...plan.republish);
    }
  }

  if (republish.length > 0) {
    try {
      const out = await d.republish(republish);
      counts.republished += out.republished.length;
      fallBack.push(...out.rejected, ...(out.notDispatch ?? []));
      const at = new Date(d.now()).toISOString();
      receipts.push(...out.merged.map(m => ({ id: m.id, attempt: 0, event: 'merged' as const, into: m.into, at })));
    } catch {
      counts.workerErrors++;
      fallBack.push(...republish);
    }
  }
  if (receipts.length > 0) counts.projected += await d.applyReceipts(receipts);
  if (fallBack.length > 0) counts.fellBack += await d.fallBackToInApp([...new Set(fallBack)]);

  d.log({ event: 'dispatch_reconcile', ...counts });
  return counts;
}
