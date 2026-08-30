#!/usr/bin/env bun
/**
 * Audit null coverage for source_path and source_ts across all knowledge_chunks namespaces.
 *
 * Usage:
 *   bun packages/core/scripts/audit-knowledge-coverage.ts
 *
 * Requires DATABASE_URL in env.
 *
 * Output: per-namespace counts of total rows, null source_path, and null source_ts
 * (is_current=true rows only, since superseded rows are expected to be stale).
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../db';

const db = await getDb();

const res = await db.execute(sql`
  SELECT
    namespace,
    split_part(namespace, ':', 2) AS corpus,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE source_path IS NULL) AS null_source_path,
    COUNT(*) FILTER (WHERE source_ts IS NULL) AS null_source_ts,
    ROUND(
      100.0 * COUNT(*) FILTER (WHERE source_path IS NULL) / NULLIF(COUNT(*), 0), 1
    ) AS pct_null_path,
    ROUND(
      100.0 * COUNT(*) FILTER (WHERE source_ts IS NULL) / NULLIF(COUNT(*), 0), 1
    ) AS pct_null_ts
  FROM knowledge_chunks
  WHERE is_current = true
  GROUP BY namespace
  ORDER BY namespace
`);

type Row = {
  namespace: string;
  corpus: string;
  total: string;
  null_source_path: string;
  null_source_ts: string;
  pct_null_path: string;
  pct_null_ts: string;
};

const rows = res.rows as unknown as Row[];

if (rows.length === 0) {
  console.log('No knowledge_chunks rows found.');
  process.exit(0);
}

const header = [
  'namespace'.padEnd(50),
  'corpus'.padEnd(12),
  'total'.padStart(7),
  'null_path'.padStart(10),
  'pct'.padStart(6),
  'null_ts'.padStart(8),
  'pct'.padStart(6),
].join('  ');
console.log(header);
console.log('-'.repeat(header.length));

for (const row of rows) {
  const pctPath = Number(row.pct_null_path);
  const pctTs = Number(row.pct_null_ts);
  const pathFlag = pctPath >= 90 ? ' ⚠ mostly null' : pctPath >= 50 ? ' △ >50% null' : '';
  const tsFlag = pctTs >= 90 ? ' ⚠ mostly null' : pctTs >= 50 ? ' △ >50% null' : '';
  console.log(
    [
      row.namespace.padEnd(50),
      row.corpus.padEnd(12),
      String(row.total).padStart(7),
      String(row.null_source_path).padStart(10),
      `${row.pct_null_path}%`.padStart(6),
      String(row.null_source_ts).padStart(8),
      `${row.pct_null_ts}%`.padStart(6),
    ].join('  ') + pathFlag + tsFlag,
  );
}

console.log('\nLegend: ⚠ = ≥90% null (backfill needed), △ = ≥50% null (investigate)');
