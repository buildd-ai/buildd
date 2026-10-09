#!/usr/bin/env bun
/**
 * Dump one decision kind's ledger (`decision_records` + `decision_outcomes`)
 * as a versioned dataset in the layout of the merge-readiness backtest
 * (`buildd-datasets/merge-readiness/v1/`), so a new version is comparable:
 * see `packages/core/decision-dataset.ts` for the files and the manifest.
 *
 *   DATABASE_URL=... bun run scripts/export-decision-dataset.ts \
 *     --kind buildd.merge_readiness --dataset merge-readiness --version v2
 *
 * Writes under `.decision-data/<dataset>/` by default. That directory is
 * gitignored and this repo is public: the output is production data, so it
 * goes to the private bucket, never into a commit. Upload, e.g.:
 *
 *   wrangler r2 object put buildd-datasets/merge-readiness/v2/data/records.jsonl --file ...
 *
 * Read-only against the database.
 *
 * Flags:
 *   --kind <kind>          decision kind / capability (required)
 *   --dataset <name>       dataset name (default: the kind without its `buildd.` prefix, `_` → `-`)
 *   --version <vN>         dataset version (required)
 *   --out <dir>            dataset root (default .decision-data/<dataset>)
 *   --since <iso date>     only records created at or after this
 *   --team <uuid>          only one team's records
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import * as schema from '../packages/core/db/schema';
import { buildDecisionDataset } from '../packages/core/decision-dataset';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const kind = flag('kind');
const version = flag('version');
if (!kind || !version) {
  console.error('usage: export-decision-dataset.ts --kind <kind> --version <vN> [--dataset <name>] [--out <dir>] [--since <date>] [--team <uuid>]');
  process.exit(2);
}
const dataset = flag('dataset') ?? kind.replace(/^buildd\./, '').replace(/_/g, '-');
const out = flag('out') ?? join('.decision-data', dataset);
const since = flag('since');
const team = flag('team');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set');
  process.exit(2);
}
const db = drizzle(neon(process.env.DATABASE_URL), { schema });
const { decisionRecords, decisionOutcomes } = schema;

const PAGE = 2000;

async function loadRecords() {
  const rows: Array<typeof decisionRecords.$inferSelect> = [];
  for (let offset = 0; ; offset += PAGE) {
    const clauses = [eq(decisionRecords.capability, kind!)];
    if (since) clauses.push(gte(decisionRecords.createdAt, new Date(since)));
    if (team) clauses.push(eq(decisionRecords.teamId, team));
    const page = await db.select().from(decisionRecords).where(and(...clauses))
      .orderBy(asc(decisionRecords.createdAt), asc(decisionRecords.id)).limit(PAGE).offset(offset);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function loadOutcomes(ids: string[]) {
  const rows: Array<typeof decisionOutcomes.$inferSelect> = [];
  for (let i = 0; i < ids.length; i += 500) {
    rows.push(...await db.select().from(decisionOutcomes).where(and(
      eq(decisionOutcomes.capability, kind!),
      inArray(decisionOutcomes.decisionRecordId, ids.slice(i, i + 500)),
    )));
  }
  return rows;
}

const records = await loadRecords();
const outcomes = await loadOutcomes(records.map(r => r.id));
const { files, manifest } = buildDecisionDataset({ dataset, version, kind, records, outcomes, generatedAt: new Date() });

for (const f of files) {
  const path = join(out, f.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, f.content);
}
console.log(`wrote ${files.length} files under ${out}`);
console.log(JSON.stringify(manifest, null, 2));
