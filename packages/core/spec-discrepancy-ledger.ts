/**
 * Discrepancy ledger — Slice 2 of docs/design/spec-conformance.md.
 *
 * Turns the Slice 1 checker's per-run assertion results into durable state
 * (§7). A discrepancy is a row, not a report line: identity is the exact
 * `(workspace, spec_path, assertion_id)` triple, so the same finding across
 * runs updates one row instead of manufacturing a new one every time — the
 * `path-claims.md` failure §7 documents.
 *
 * Direction (§8) and closure (§9) are both computed here. The design's stated
 * reason there is no optimistic-lock generation column: the delta gate (§4)
 * already serializes runs through a single keyed artifact, so a plain
 * select-then-decide-then-write is correct — no concurrent writer to race.
 */

import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { specDiscrepancies } from './db/schema';
import {
  TERMINAL_STATUS,
  NON_TERMINAL_STATUS,
  type AssertionResult,
  type DocEvaluation,
  type DocType,
} from './spec-conformance';

// ─── Direction (§8) ─────────────────────────────────────────────────────────

export type Direction = 'spec_ahead' | 'code_ahead' | 'contradicted';
export type DiscrepancyStatus = 'open' | 'accepted' | 'resolved';

/**
 * Per-assertion classification for a Tier-2 CI writer. `spec_ahead` is
 * deliberately absent from this return type: §8 is explicit that CI never
 * writes it directly (a CI-tier failure always lands as `contradicted`
 * first; only the Tier-3 cron, after its deeper search rules out a rename,
 * may write `spec_ahead`). `clean` means the declared status and the
 * assertion result agree (either pass+terminal, or fail+non-terminal — §2's
 * expected in-progress state) — no gap, nothing to log. `skip` means the
 * declared status isn't one this doc type's terminal/non-terminal sets
 * recognize (unset, `superseded`, or unparseable) — the same exclusion
 * `checkContradiction` already applies, so promotion logic never runs against
 * a doc whose status this checker couldn't classify.
 */
export type Classification = 'code_ahead' | 'contradicted' | 'clean' | 'skip';

export function classifyAssertion(
  docType: DocType,
  declaredStatus: string | null,
  result: AssertionResult
): Classification {
  if (result.outcome === 'suppressed') return 'skip';

  const declared = declaredStatus?.toLowerCase() ?? null;
  const terminal = TERMINAL_STATUS[docType];
  const nonTerminal = NON_TERMINAL_STATUS[docType];
  const isTerminal = declared === terminal;
  const isNonTerminal = declared !== null && nonTerminal.includes(declared);
  if (!isTerminal && !isNonTerminal) return 'skip';

  if (result.outcome === 'pass') return isTerminal ? 'clean' : 'code_ahead';
  // outcome === 'fail'
  return isTerminal ? 'contradicted' : 'clean';
}

// ─── Promotion gate (§8's table, enforced at the data layer) ───────────────

/**
 * Only `spec_ahead` — confirmed by the Tier-3 cron's five-step search, never
 * a bare CI `contradicted` reclassified in place — may mint a mission.
 * `code_ahead` NEVER promotes: that is precisely how the 2026-07-25 incident
 * happened (a false NOT-BUILT verdict produced a recommendation to rebuild
 * already-merged work). `contradicted` isn't promotable either — it needs
 * `adjudicate_discrepancy` to flip it to `spec_ahead` or `code_ahead` first.
 * Slice 3's `promote_discrepancy` calls this; it lives here, not only in the
 * UI that lands later, so the gate can't be bypassed by a caller that skips
 * the UI.
 */
export function canPromote(direction: Direction): direction is 'spec_ahead' {
  return direction === 'spec_ahead';
}

export function assertPromotable(direction: Direction): void {
  if (!canPromote(direction)) {
    throw new Error(
      `Cannot promote a '${direction}' discrepancy into a mission — only spec_ahead rows ` +
        `(confirmed by the Tier-3 cron) may be promoted. See docs/design/spec-conformance.md §8.`
    );
  }
}

// ─── Closure (§9) — the write decision, computed in plain JS ───────────────

export type LedgerAction = 'insert' | 'reopen' | 'refresh' | 'keep_accepted' | 'resolve' | 'noop';

export interface ExistingDiscrepancy {
  status: DiscrepancyStatus;
  firstSeenAt: Date;
}

/**
 * Decides what write (if any) a re-evaluated assertion needs, given whatever
 * row already exists for its identity key. Pure — no DB — so every branch of
 * §9's closure rule is directly unit-testable.
 *
 *   clean + no row / already resolved  -> noop        (nothing to log)
 *   clean + open or accepted row       -> resolve      (§9: stops contradicting)
 *   gap   + no row                     -> insert       (first sighting)
 *   gap   + resolved row               -> reopen       (a new occurrence; fresh first_seen_at)
 *   gap   + accepted row                -> keep_accepted (§9: parked, not auto-reopened to 'open';
 *                                                          still re-evaluated and refreshed every run)
 *   gap   + open row                    -> refresh      (path-claims.md shape: same row, same
 *                                                          first_seen_at, only last_checked_at moves)
 */
export function decideLedgerWrite(
  existing: ExistingDiscrepancy | undefined,
  classification: Exclude<Classification, 'skip'>
): LedgerAction {
  if (classification === 'clean') {
    if (!existing || existing.status === 'resolved') return 'noop';
    return 'resolve';
  }
  if (!existing) return 'insert';
  if (existing.status === 'resolved') return 'reopen';
  if (existing.status === 'accepted') return 'keep_accepted';
  return 'refresh';
}

// ─── DB write ───────────────────────────────────────────────────────────────

export interface LedgerRunSummary {
  inserted: number;
  reopened: number;
  refreshed: number;
  keptAccepted: number;
  resolved: number;
  skipped: number;
  byDirection: Record<Direction, number>;
}

function emptySummary(): LedgerRunSummary {
  return {
    inserted: 0,
    reopened: 0,
    refreshed: 0,
    keptAccepted: 0,
    resolved: 0,
    skipped: 0,
    byDirection: { spec_ahead: 0, code_ahead: 0, contradicted: 0 },
  };
}

function identityFilter(workspaceId: string, specPath: string, assertionId: string) {
  return and(
    eq(specDiscrepancies.workspaceId, workspaceId),
    eq(specDiscrepancies.specPath, specPath),
    eq(specDiscrepancies.assertionId, assertionId)
  );
}

/**
 * The Tier-2 CI job's write path (§7 Part B). Evaluates every assertion
 * result already computed by Slice 1's checker against whatever row exists
 * for its identity, and applies exactly one of §9's closure actions.
 */
export async function writeLedgerFromEvaluations(
  workspaceId: string,
  evaluations: DocEvaluation[],
  now: Date = new Date()
): Promise<LedgerRunSummary> {
  const summary = emptySummary();

  for (const evalDoc of evaluations) {
    for (const result of evalDoc.results) {
      const classification = classifyAssertion(evalDoc.docType, evalDoc.declaredStatus, result);
      if (classification === 'skip') {
        summary.skipped++;
        continue;
      }

      const evidence = {
        assertionType: result.type,
        outcome: result.outcome,
        detail: result.detail,
        declaredStatus: evalDoc.declaredStatus,
        docType: evalDoc.docType,
      };

      const existingRows = await db
        .select({ status: specDiscrepancies.status, firstSeenAt: specDiscrepancies.firstSeenAt })
        .from(specDiscrepancies)
        .where(identityFilter(workspaceId, evalDoc.path, result.id));
      const existing = existingRows[0] as ExistingDiscrepancy | undefined;

      const action = decideLedgerWrite(existing, classification);

      switch (action) {
        case 'noop':
          break;

        case 'insert':
          await db.insert(specDiscrepancies).values({
            workspaceId,
            specPath: evalDoc.path,
            assertionId: result.id,
            direction: classification,
            status: 'open',
            firstSeenAt: now,
            lastCheckedAt: now,
            evidence,
          });
          summary.inserted++;
          summary.byDirection[classification]++;
          break;

        case 'reopen':
          await db
            .update(specDiscrepancies)
            .set({ direction: classification, status: 'open', firstSeenAt: now, lastCheckedAt: now, evidence })
            .where(identityFilter(workspaceId, evalDoc.path, result.id));
          summary.reopened++;
          summary.byDirection[classification]++;
          break;

        case 'refresh':
        case 'keep_accepted':
          await db
            .update(specDiscrepancies)
            .set({ direction: classification, lastCheckedAt: now, evidence })
            .where(identityFilter(workspaceId, evalDoc.path, result.id));
          summary[action === 'refresh' ? 'refreshed' : 'keptAccepted']++;
          summary.byDirection[classification]++;
          break;

        case 'resolve':
          await db
            .update(specDiscrepancies)
            .set({ status: 'resolved', lastCheckedAt: now, evidence })
            .where(identityFilter(workspaceId, evalDoc.path, result.id));
          summary.resolved++;
          break;
      }
    }
  }

  return summary;
}

/**
 * Dry-run classification counts, with no DB access at all — what a Tier-2 CI
 * run WOULD produce if every gap were a fresh row (i.e. the first real run
 * against an empty table, where `insert` is the only gap action available).
 * Also useful standalone reporting when DATABASE_URL isn't configured.
 */
export function summarizeClassifications(
  evaluations: DocEvaluation[]
): Record<Classification, number> {
  const counts: Record<Classification, number> = { code_ahead: 0, contradicted: 0, clean: 0, skip: 0 };
  for (const evalDoc of evaluations) {
    for (const result of evalDoc.results) {
      counts[classifyAssertion(evalDoc.docType, evalDoc.declaredStatus, result)]++;
    }
  }
  return counts;
}
