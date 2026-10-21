#!/usr/bin/env bun
/**
 * Batch-run read-only SQL against the buildd prod DB over the neon HTTP driver.
 *
 * Direct psql to Neon times out from a laptop (5432 unreachable), so this goes
 * over HTTPS the same way the app does.
 *
 * Usage: bun q.ts <file-holding-DATABASE_URL> <file-of-sql>
 * Statements are split on ";\n". A leading `-- comment` line becomes the block
 * label. A failing statement prints `ERR <msg>` and the batch continues.
 */
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';

const sql = neon(readFileSync(process.argv[2], 'utf8').trim());
const text = readFileSync(process.argv[3], 'utf8');

for (const stmt of text.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
  const first = stmt.split('\n')[0];
  console.log('\n### ' + (first.startsWith('--') ? first : stmt.slice(0, 60).replace(/\s+/g, ' ')));
  try {
    const rows = (await sql.query(stmt)) as Record<string, unknown>[];
    if (!rows.length) { console.log('(0 rows)'); continue; }
    const keys = Object.keys(rows[0]);
    console.log(keys.join('\t'));
    for (const r of rows) {
      console.log(keys.map(k => (r[k] === null ? '-' : String(r[k]).replace(/\s+/g, ' ').slice(0, 70))).join('\t'));
    }
  } catch (e) {
    console.log('ERR ' + (e as Error).message);
  }
}
