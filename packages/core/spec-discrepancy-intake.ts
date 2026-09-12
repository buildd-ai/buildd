/**
 * Intake check — Slice 4 of docs/design/spec-conformance.md §10.
 *
 * `POST /api/tasks` already runs `extractSubjectAnchor()` + atomic dedupe
 * before the task row exists. This is the same shape, at the same point: a
 * read-only lookup that never blocks task creation, only annotates the
 * response. Matching is deliberately NOT identity (the ledger row's own
 * identity stays the exact `(workspace, spec_path, assertion_id)` triple —
 * see spec-discrepancy-ledger.ts) — it is retrieval, because "does this new
 * task touch a spec area with a known stale status" is inherently a fuzzy
 * question. Warn, never block (§10): a `fileAnywayReason`-style escape hatch
 * would only recreate the reflexive-bypass failure friction-dedup already
 * paid for.
 *
 * Only `open` + `code_ahead` rows are candidates — §8 is explicit that a
 * `code_ahead` row means the code already shipped and the doc's status
 * string is what's stale, so the warning this module produces is "you may be
 * about to redo already-done work; consider a docs fix instead," never a
 * claim that work is unbuilt (that would need `spec_ahead`, which only the
 * Tier-3 cron writes).
 */

import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { specDiscrepancies } from './db/schema';
import { isAdvisoryManifest, pathsOverlap } from './path-overlap';
import { PgVectorStore, buildNamespace } from './knowledge-store/pg-vector-store';
import { getVoyageEmbedder } from './knowledge-store/voyage-embedder';
import { getVoyageReranker } from './knowledge-store/reranker';

export interface OpenCodeAheadRow {
  specPath: string;
  assertionId: string;
  evidence: Record<string, unknown> | null;
}

export interface SpecWarning {
  specPath: string;
  assertionId: string;
  direction: 'code_ahead';
  message: string;
}

/** Minimal retrieval shape this module needs — injectable for tests, same idea as apps/web's `KnowledgeQuerier`. */
export interface IntakeQuerier {
  query(
    namespace: string,
    params: { text: string; mode?: 'hybrid' | 'lexical' | 'vector'; topK?: number }
  ): Promise<Array<{ sourcePath: string | null; score: number }>>;
}

// The evaluator's `detail` strings (spec-conformance.ts's evalSymbol/evalRoute/
// evalConfigKey/evalTestFile/evalSymbolReachable) embed the resolved code path
// as the last path-shaped token, e.g. `export of "X" found in apps/foo/bar.ts`.
// Extracting it from the already-persisted `evidence.detail` avoids a repo
// filesystem read this route has no access to at request time (unlike Tier-1/
// Tier-2, which run inside a repo checkout).
const PATH_TOKEN_RE = /(?:^|[\s"])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)(?=[\s".,;:]|$)/g;

export function extractPathFromDetail(detail: string | undefined | null): string | null {
  if (!detail) return null;
  const matches = [...detail.matchAll(PATH_TOKEN_RE)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

function candidatePaths(row: OpenCodeAheadRow): string[] {
  const detail = typeof row.evidence?.detail === 'string' ? (row.evidence.detail as string) : null;
  const codePath = extractPathFromDetail(detail);
  return codePath ? [row.specPath, codePath] : [row.specPath];
}

/**
 * Exact/prefix overlap between the incoming task's declared scope and an open
 * row's spec doc or resolved code path. A `['**']` (or empty) manifest means
 * "scope undeclared" (the mission-task default), not "touches everything" —
 * treating it as a match would warn on every task ever filed against a
 * mission, so it is excluded the same way `shouldSerializeByManifest` excludes
 * it from dependency inference.
 */
export function matchRowsByPathManifest(
  pathManifest: string[] | null | undefined,
  rows: OpenCodeAheadRow[]
): OpenCodeAheadRow[] {
  if (!pathManifest || pathManifest.length === 0 || isAdvisoryManifest(pathManifest)) return [];
  return rows.filter((row) => pathsOverlap(pathManifest, candidatePaths(row)));
}

/**
 * Fuzzy match: reuses `spec_compare`'s retrieval (a `docs`-corpus query on the
 * task's own description) rather than inventing a second similarity scheme.
 * Only rows whose `specPath` is itself among the top hits count — this is
 * "does the description read like it's about one of these specific docs,"
 * not a generic relevance score.
 */
export async function matchRowsByDescription(
  workspaceId: string,
  description: string,
  rows: OpenCodeAheadRow[],
  querier: IntakeQuerier,
  topK = 5
): Promise<OpenCodeAheadRow[]> {
  if (!description.trim() || rows.length === 0) return [];
  const specPaths = new Set(rows.map((r) => r.specPath));
  const hits = await querier.query(buildNamespace(workspaceId, 'docs'), {
    text: description,
    mode: 'hybrid',
    topK,
  });
  const matchedPaths = new Set(
    hits.filter((h) => h.sourcePath && specPaths.has(h.sourcePath)).map((h) => h.sourcePath as string)
  );
  return rows.filter((r) => matchedPaths.has(r.specPath));
}

export function dedupeRows(rows: OpenCodeAheadRow[]): OpenCodeAheadRow[] {
  const seen = new Map<string, OpenCodeAheadRow>();
  for (const row of rows) seen.set(`${row.specPath}::${row.assertionId}`, row);
  return [...seen.values()];
}

export function toWarning(row: OpenCodeAheadRow): SpecWarning {
  const detail = typeof row.evidence?.detail === 'string' ? (row.evidence.detail as string) : null;
  return {
    specPath: row.specPath,
    assertionId: row.assertionId,
    direction: 'code_ahead',
    message:
      `${row.specPath} — assertion \`${row.assertionId}\` already passes` +
      (detail ? ` (${detail})` : '') +
      `, but the doc's declared status is still non-terminal. This may be a docs fix rather than new work — see docs/design/spec-conformance.md §8.`,
  };
}

async function fetchOpenCodeAheadRows(workspaceId: string): Promise<OpenCodeAheadRow[]> {
  return db
    .select({
      specPath: specDiscrepancies.specPath,
      assertionId: specDiscrepancies.assertionId,
      evidence: specDiscrepancies.evidence,
    })
    .from(specDiscrepancies)
    .where(
      and(
        eq(specDiscrepancies.workspaceId, workspaceId),
        eq(specDiscrepancies.status, 'open'),
        eq(specDiscrepancies.direction, 'code_ahead')
      )
    );
}

let defaultQuerier: PgVectorStore | null = null;
function getDefaultQuerier(): IntakeQuerier {
  if (!defaultQuerier) defaultQuerier = new PgVectorStore(getVoyageEmbedder(), getVoyageReranker());
  return defaultQuerier;
}

/**
 * The intake check itself (§10). Bails before touching retrieval at all when
 * the workspace has no open `code_ahead` rows — the common case today (4 rows
 * repo-wide per the Slice 2 real run) — so task creation never pays an
 * embedding-query cost for a workspace with a clean ledger.
 */
export async function findIntakeWarnings(params: {
  workspaceId: string;
  description?: string | null;
  pathManifest?: string[] | null;
  querier?: IntakeQuerier;
}): Promise<SpecWarning[]> {
  const rows = await fetchOpenCodeAheadRows(params.workspaceId);
  if (rows.length === 0) return [];

  const byPath = matchRowsByPathManifest(params.pathManifest, rows);
  const byDescription = params.description?.trim()
    ? await matchRowsByDescription(params.workspaceId, params.description, rows, params.querier ?? getDefaultQuerier())
    : [];

  return dedupeRows([...byPath, ...byDescription]).map(toWarning);
}
