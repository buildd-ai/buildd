/**
 * Intake check — Slice 4 of docs/design/spec-conformance.md, §10.
 *
 * `POST /api/tasks` already runs `extractSubjectAnchor()` and an atomic
 * dedupe against `task_subject_claims` before the task row is created (see
 * `apps/web/src/app/api/tasks/route.ts`). This check is the same shape, at
 * the same point: match the incoming task's `pathManifest` and description
 * against open `code_ahead` ledger rows for the workspace, using retrieval
 * (not identity — the ledger row's own identity stays exact, §7) over the
 * same `{workspaceId}:docs` corpus `spec_compare` already queries.
 *
 * Warn, never block. §10 states why: many legitimate tasks touch a spec area
 * no assertion covers, and a blocking check that fuzzy gets bypassed
 * reflexively via `fileAnywayReason` — a routinely-bypassed gate enforces
 * nothing, but a warning costs nothing to ignore. So there is no bypass
 * param here, and a retrieval failure must never fail task creation.
 */

import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { specDiscrepancies } from './db/schema';
import { buildNamespace } from './knowledge-store/pg-vector-store';
import type { KnowledgeStore } from './knowledge-store/types';

export interface SpecWarning {
  specPath: string;
  assertionId: string;
  direction: 'code_ahead';
  message: string;
}

interface OpenCodeAheadRow {
  specPath: string;
  assertionId: string;
}

interface DocHit {
  sourcePath: string | null;
}

const RETRIEVAL_TOP_K = 10;
// Bounds the query text sent to the embedder/lexical search — a large
// description or manifest shouldn't inflate retrieval cost or latency.
const MAX_QUERY_CHARS = 2000;

/**
 * Builds the retrieval query from the two inputs §10 names: pathManifest (when
 * supplied) and description. Pure, so it's testable without a knowledge store.
 */
export function buildIntakeQueryText(
  pathManifest: string[] | null | undefined,
  description: string | null | undefined,
): string {
  const parts = [...(pathManifest ?? []), description ?? ''].filter(Boolean);
  return parts.join('\n').trim().slice(0, MAX_QUERY_CHARS);
}

/**
 * Maps retrieved doc hits onto open code_ahead rows by exact `sourcePath` ==
 * `specPath` match. A hit that doesn't land on a spec path with an open row
 * produces nothing — this is deliberately not "closest doc wins"; a
 * discrepancy row must actually exist for the path retrieval surfaced.
 */
export function matchDiscrepancyWarnings(
  openRows: OpenCodeAheadRow[],
  docHits: DocHit[],
): SpecWarning[] {
  if (openRows.length === 0 || docHits.length === 0) return [];

  const openBySpecPath = new Map(openRows.map((r) => [r.specPath, r]));
  const warnings: SpecWarning[] = [];
  const seen = new Set<string>();

  for (const hit of docHits) {
    if (!hit.sourcePath) continue;
    const row = openBySpecPath.get(hit.sourcePath);
    if (!row) continue;
    const key = `${row.specPath}:${row.assertionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push({
      specPath: row.specPath,
      assertionId: row.assertionId,
      direction: 'code_ahead',
      message:
        `${row.specPath} has an open code_ahead discrepancy (assertion \`${row.assertionId}\`): ` +
        `the code already satisfies this claim but the spec's declared status is stale. ` +
        `This is a doc fix, not new implementation work — consider updating the spec's status ` +
        `instead of filing a build task.`,
    });
  }
  return warnings;
}

/**
 * Full intake check: fetch this workspace's open code_ahead rows, skip
 * retrieval entirely when there are none (cheap short-circuit — most
 * workspaces have few or zero), otherwise query the docs corpus and match.
 * Never throws by design of its caller's contract, but does not itself
 * swallow errors — the route wraps this call so a retrieval failure warns
 * nothing rather than failing task creation.
 */
export async function checkIntakeForDiscrepancies(
  workspaceId: string,
  input: { pathManifest?: string[] | null; description?: string | null },
  ks: Pick<KnowledgeStore, 'query'>,
): Promise<SpecWarning[]> {
  const queryText = buildIntakeQueryText(input.pathManifest, input.description);
  if (!queryText) return [];

  const openRows = await db
    .select({
      specPath: specDiscrepancies.specPath,
      assertionId: specDiscrepancies.assertionId,
    })
    .from(specDiscrepancies)
    .where(
      and(
        eq(specDiscrepancies.workspaceId, workspaceId),
        eq(specDiscrepancies.direction, 'code_ahead'),
        eq(specDiscrepancies.status, 'open'),
      ),
    );
  if (openRows.length === 0) return [];

  const docHits = await ks.query(buildNamespace(workspaceId, 'docs'), {
    text: queryText,
    mode: 'hybrid',
    topK: RETRIEVAL_TOP_K,
  });

  return matchDiscrepancyWarnings(openRows, docHits);
}
