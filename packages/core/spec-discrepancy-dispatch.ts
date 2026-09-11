/**
 * Dispatch-time injection — Slice 5 of docs/design/spec-conformance.md §11.
 *
 * `buildPromptWithComposition` (apps/runner/src/prompt-builder.ts) concatenates
 * `resolvedContextProviders` blocks computed once at claim time
 * (apps/web/src/app/api/workers/claim/context-injection.ts) — the same rail
 * `attachKnowledgeContext` and `attachSubjectPriorWork` already ride. This
 * module is the discrepancy-ledger analog: for a dispatched task whose
 * `pathManifest` intersects an OPEN ledger row's spec doc or resolved code
 * path, format the exact claim the worker is expected to either satisfy or
 * update. It reads the ledger's already-computed rows and never re-runs the
 * checker — §11: "the expensive decision was already made once, upstream,"
 * the same reasoning `resolveSessionModel` uses for a precomputed
 * `task.context.model`.
 *
 * Unlike the intake check (§10, spec-discrepancy-intake.ts), which surfaces
 * only `code_ahead` rows because it warns about possibly-redundant work, this
 * reads every open direction — a `spec_ahead` or `contradicted` row is
 * exactly the case §11's worked example shows: the worker renaming a symbol
 * needs to know the assertion pointed at the old name before writing the
 * second, reactive commit.
 *
 * Matching itself is not re-derived: `matchRowsByPathManifest` (path/file/
 * entry overlap against `evidence.detail`) is the identical mechanical check
 * the intake path already uses, imported rather than duplicated.
 */

import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { specDiscrepancies } from './db/schema';
import { isAdvisoryManifest } from './path-overlap';
import { matchRowsByPathManifest, type OpenCodeAheadRow } from './spec-discrepancy-intake';
import type { Direction } from './spec-discrepancy-ledger';

export interface OpenDiscrepancyRow extends OpenCodeAheadRow {
  direction: Direction;
}

async function fetchOpenDiscrepancyRows(workspaceId: string): Promise<OpenDiscrepancyRow[]> {
  return db
    .select({
      specPath: specDiscrepancies.specPath,
      assertionId: specDiscrepancies.assertionId,
      evidence: specDiscrepancies.evidence,
      direction: specDiscrepancies.direction,
    })
    .from(specDiscrepancies)
    .where(and(eq(specDiscrepancies.workspaceId, workspaceId), eq(specDiscrepancies.status, 'open')));
}

/**
 * §11's literal injection text. Returns null (not an empty string) when there
 * is nothing to say, so callers can `if (!block) continue` without checking
 * length separately.
 */
export function formatDispatchBlock(rows: OpenDiscrepancyRow[]): string | null {
  if (rows.length === 0) return null;
  const lines = ['## Spec Discrepancies You May Be Closing'];
  for (const row of rows) {
    const detail = typeof row.evidence?.detail === 'string' ? (row.evidence.detail as string) : null;
    lines.push(
      `- ${row.specPath} — assertion \`${row.assertionId}\` (${row.direction})` +
        (detail ? `: ${detail}` : '') +
        `. If you are touching this code or spec, update the assertion frontmatter in the same PR — ` +
        `do not leave it pointing at code or a status that no longer matches reality.`
    );
  }
  return lines.join('\n');
}

/**
 * The dispatch injection itself (§11). Bails before any DB read when the
 * task's pathManifest is empty/advisory (undeclared scope, the mission-task
 * default) — mirrors `findIntakeWarnings`'s short-circuit shape, so a task
 * with no declared scope never pays a query for a match that can never fire.
 */
export async function findDispatchDiscrepancyBlock(params: {
  workspaceId: string;
  pathManifest?: string[] | null;
}): Promise<string | null> {
  if (!params.pathManifest || params.pathManifest.length === 0 || isAdvisoryManifest(params.pathManifest)) {
    return null;
  }
  const rows = await fetchOpenDiscrepancyRows(params.workspaceId);
  if (rows.length === 0) return null;
  const matched = matchRowsByPathManifest(params.pathManifest, rows);
  return formatDispatchBlock(matched);
}
