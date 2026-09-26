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

import { and, eq, ne } from 'drizzle-orm';
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

/**
 * Statuses that retire a doc: it no longer makes any live claim, so there is
 * no declared-vs-derived gap left to measure. docs/specs/SPEC-FORMAT.md retires
 * a contract by `status: superseded` + `superseded_by`, never by deleting it.
 */
export const RETIRED_STATUSES: readonly string[] = ['superseded'];

/**
 * Why a `skip` classification skipped — which decides what happens to a row
 * that ALREADY exists for the assertion (a skip never inserts one):
 *
 *   suppressed   — `skip_until` in force (§6). The row resolves.
 *   retired      — the doc declares `superseded`. The row resolves: a
 *                  re-evaluation that finds the doc retired is a clean result,
 *                  not a missing one.
 *   unrecognized — the status is unset or outside every known set (e.g. a
 *                  doc fix that wrote `shipped` instead of `implemented`). The
 *                  row stays open but IS rechecked: `last_checked_at` and the
 *                  evidence move, so the card can say "re-checked, still open"
 *                  instead of waiting forever on a re-run that already ran.
 *
 * Before this existed every skip left an existing row untouched, so a doc fix
 * that retired its doc, or used a status outside the sets, stranded the row
 * with a `last_checked_at` older than the fix's merge — for good.
 */
export type SkipDisposition = 'suppressed' | 'retired' | 'unrecognized';

export function skipDisposition(declaredStatus: string | null, result: AssertionResult): SkipDisposition {
  if (result.outcome === 'suppressed') return 'suppressed';
  const declared = declaredStatus?.toLowerCase() ?? null;
  if (declared !== null && RETIRED_STATUSES.includes(declared)) return 'retired';
  return 'unrecognized';
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

/**
 * `decideLedgerWrite` only ever returns 'insert' / 'reopen' / 'refresh' /
 * 'keep_accepted' when `classification` is a gap ('code_ahead' or
 * 'contradicted') — never 'clean'. This guard makes that invariant a type
 * fact at the three write call sites instead of a comment, so a `direction`
 * column can never be written 'clean' even if type-check scope widens enough
 * to otherwise allow it.
 */
export function isDirection(
  classification: Exclude<Classification, 'skip'>
): classification is Exclude<Classification, 'skip' | 'clean'> {
  return classification !== 'clean';
}

export function assertPromotable(direction: Direction): void {
  if (!canPromote(direction)) {
    throw new Error(
      `Cannot promote a '${direction}' discrepancy into a mission — only spec_ahead rows ` +
        `(confirmed by the Tier-3 cron) may be promoted. See docs/design/spec-conformance.md §8.`
    );
  }
}

// ─── Adjudication (§13's `adjudicate_discrepancy`) ─────────────────────────

export type AdjudicationAction = 'accept' | 'flip_direction';

export interface AdjudicationInput {
  action: AdjudicationAction;
  reason?: string | null;
  newDirection?: Direction;
}

export interface AdjudicationCurrent {
  direction: Direction;
  status: DiscrepancyStatus;
}

/** The column values `adjudicate_discrepancy`'s route should write. */
export interface AdjudicationPatch {
  status?: DiscrepancyStatus;
  direction?: Direction;
  acceptedReason?: string;
}

/**
 * Pure validation + patch computation for §13's `adjudicate_discrepancy`,
 * split out the same way `decideLedgerWrite` is: every branch is directly
 * unit-testable without a DB. Throws (never returns a partial/invalid patch)
 * on a bad request so the route can turn it into a 400 uniformly.
 *
 * `accept` requires a non-blank `reason` — same discipline as the assertion
 * escape hatch's `skip_reason` (§6). `flip_direction` is "the only path off
 * `contradicted`" (§13): it only operates on a currently-`contradicted` row,
 * and `newDirection` must actually move it (not flip `contradicted` to
 * itself). Accepting a `resolved` row is rejected — there is no open gap left
 * to defer (§9: `accepted` is a parked-but-open state, not a label for a
 * closed one).
 */
export function planAdjudication(current: AdjudicationCurrent, input: AdjudicationInput): AdjudicationPatch {
  const reason = input.reason?.trim();

  if (input.action === 'accept') {
    if (!reason) {
      throw new Error("adjudicate_discrepancy action=accept requires a non-blank 'reason'.");
    }
    if (current.status === 'resolved') {
      throw new Error(
        'Cannot accept a resolved discrepancy — the gap is already closed, so there is nothing left to defer.'
      );
    }
    return { status: 'accepted', acceptedReason: reason };
  }

  if (input.action === 'flip_direction') {
    if (current.direction !== 'contradicted') {
      throw new Error(
        `flip_direction only applies to 'contradicted' rows (this row is '${current.direction}') — ` +
          `see docs/design/spec-conformance.md §13.`
      );
    }
    if (!input.newDirection) {
      throw new Error("adjudicate_discrepancy action=flip_direction requires 'newDirection'.");
    }
    if (input.newDirection === 'contradicted') {
      throw new Error("newDirection must be 'spec_ahead' or 'code_ahead' — flipping 'contradicted' to itself is a no-op.");
    }
    return { direction: input.newDirection };
  }

  throw new Error(`Unknown adjudicate_discrepancy action: '${input.action}'. Use 'accept' or 'flip_direction'.`);
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
  /** Existing rows on an unrecognized status: rechecked, left open. */
  rechecked: number;
  /** Of `resolved`: rows whose assertion is no longer declared anywhere. */
  unasserted: number;
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
    rechecked: 0,
    unasserted: 0,
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
export interface LedgerWriteOptions {
  /**
   * Set only when `evaluations` covers EVERY doc the ledger tracks (the CI
   * run over the default roots). Rows whose assertion no longer appears in any
   * evaluated doc — renamed, removed, or the doc deleted — then resolve: the
   * claim they measured is gone. Without this, a doc fix that corrected an
   * assertion by renaming its id stranded the old row forever, because nothing
   * ever evaluated that identity again.
   */
  resolveUnasserted?: boolean;
}

export async function writeLedgerFromEvaluations(
  workspaceId: string,
  evaluations: DocEvaluation[],
  now: Date = new Date(),
  options: LedgerWriteOptions = {}
): Promise<LedgerRunSummary> {
  const summary = emptySummary();
  const seen = new Set<string>();

  for (const evalDoc of evaluations) {
    for (const result of evalDoc.results) {
      seen.add(`${evalDoc.path}\u0000${result.id}`);
      const classification = classifyAssertion(evalDoc.docType, evalDoc.declaredStatus, result);
      if (classification === 'skip') {
        summary.skipped++;
        // A skip never creates a row, but it must not strand one that already
        // exists — see SkipDisposition for what each case does.
        const existingRows = await db
          .select({ status: specDiscrepancies.status })
          .from(specDiscrepancies)
          .where(identityFilter(workspaceId, evalDoc.path, result.id));
        const existing = existingRows[0] as ExistingDiscrepancy | undefined;
        if (existing && existing.status !== 'resolved') {
          const disposition = skipDisposition(evalDoc.declaredStatus, result);
          const evidence = {
            assertionType: result.type,
            outcome: result.outcome,
            detail: result.detail,
            declaredStatus: evalDoc.declaredStatus,
            docType: evalDoc.docType,
            skipDisposition: disposition,
          };
          if (disposition === 'unrecognized') {
            await db
              .update(specDiscrepancies)
              .set({ lastCheckedAt: now, evidence })
              .where(identityFilter(workspaceId, evalDoc.path, result.id));
            summary.rechecked++;
          } else {
            await db
              .update(specDiscrepancies)
              .set({ status: 'resolved', lastCheckedAt: now, evidence })
              .where(identityFilter(workspaceId, evalDoc.path, result.id));
            summary.resolved++;
          }
        }
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

        case 'insert': {
          if (!isDirection(classification)) {
            throw new Error(`invariant violated: 'insert' implies a gap classification, got 'clean'`);
          }
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
        }

        case 'reopen': {
          if (!isDirection(classification)) {
            throw new Error(`invariant violated: 'reopen' implies a gap classification, got 'clean'`);
          }
          await db
            .update(specDiscrepancies)
            .set({
              direction: classification,
              status: 'open',
              firstSeenAt: now,
              lastCheckedAt: now,
              evidence,
              // A reopen is a NEW occurrence (§9: fresh first_seen_at), so the
              // doc-fix claim from the occurrence that was already settled is
              // released with it. Left behind, it would render the new finding
              // as "fix in flight" pointing at a task that finished long ago,
              // and the dispatch CTA would never come back for it.
              docFixTaskId: null,
            })
            .where(identityFilter(workspaceId, evalDoc.path, result.id));
          summary.reopened++;
          summary.byDirection[classification]++;
          break;
        }

        case 'refresh':
        case 'keep_accepted': {
          if (!isDirection(classification)) {
            throw new Error(`invariant violated: '${action}' implies a gap classification, got 'clean'`);
          }
          await db
            .update(specDiscrepancies)
            .set({ direction: classification, lastCheckedAt: now, evidence })
            .where(identityFilter(workspaceId, evalDoc.path, result.id));
          summary[action === 'refresh' ? 'refreshed' : 'keptAccepted']++;
          summary.byDirection[classification]++;
          break;
        }

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

  if (options.resolveUnasserted) {
    const live = await db
      .select({ specPath: specDiscrepancies.specPath, assertionId: specDiscrepancies.assertionId })
      .from(specDiscrepancies)
      .where(and(eq(specDiscrepancies.workspaceId, workspaceId), ne(specDiscrepancies.status, 'resolved')));
    for (const row of live) {
      if (seen.has(`${row.specPath}\u0000${row.assertionId}`)) continue;
      await db
        .update(specDiscrepancies)
        .set({
          status: 'resolved',
          lastCheckedAt: now,
          evidence: {
            outcome: 'not_asserted',
            detail: 'The assertion is no longer declared in any evaluated doc (removed, renamed, or the doc was deleted).',
          },
        })
        .where(identityFilter(workspaceId, row.specPath, row.assertionId));
      summary.resolved++;
      summary.unasserted++;
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
