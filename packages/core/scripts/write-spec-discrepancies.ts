#!/usr/bin/env bun
/**
 * Tier-2 CI ledger writer — Slice 2 of docs/design/spec-conformance.md §7 Part B.
 *
 * Runs Slice 1's checker (`evaluateAllDocs`) and upserts `spec_discrepancies`
 * rows per the §8 direction rule and §9 closure rule (spec-discrepancy-ledger.ts
 * has both). Wired into CI at .github/workflows/spec-discrepancy-ledger.yml,
 * which runs this on every push to dev. `scripts/check-spec-conformance.ts`
 * (Slice 1's checker entry point) remains unwired — that gap predates this
 * slice and is tracked separately.
 *
 * Usage:
 *   bun run packages/core/scripts/write-spec-discrepancies.ts --workspace-id <uuid>
 *   bun run packages/core/scripts/write-spec-discrepancies.ts --dry-run
 *
 * Without --dry-run, DATABASE_URL must be set. If it isn't, the script falls
 * back to a dry run with a notice rather than failing — the same
 * "skip gracefully, don't red the build over a missing secret" posture
 * `.github/workflows/knowledge-eval.yml` already uses for a DB-dependent job.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { evaluateAllDocs, resolveConformanceConfig } from '../spec-conformance';
import { summarizeClassifications, writeLedgerFromEvaluations } from '../spec-discrepancy-ledger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const config = resolveConformanceConfig({
  repoRoot: ROOT,
  specsRoot: argValue('--specs-root'),
  designRoot: argValue('--design-root'),
});

const workspaceId = argValue('--workspace-id');
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const evaluations = evaluateAllDocs(config);
  const counts = summarizeClassifications(evaluations);

  console.log(`Spec discrepancy ledger — ${evaluations.length} docs (${config.specsRoot}, ${config.designRoot})\n`);
  console.log(`Classifications this run:`);
  console.log(`  code_ahead:   ${counts.code_ahead}  (assertion passes, declared status is non-terminal — a doc fix)`);
  console.log(`  contradicted: ${counts.contradicted}  (assertion fails, declared status is terminal — needs an owner)`);
  console.log(`  clean:        ${counts.clean}  (declared status and assertion result agree — no gap)`);
  console.log(`  skip:         ${counts.skip}  (suppressed, or declared status not recognized for this doc type)`);
  console.log(`\nNote: spec_ahead is never written by this Tier-2 job — only the Tier-3 cron`);
  console.log(`(slice 7) writes it, after its deeper search rules out a rename.`);

  if (dryRun || !process.env.DATABASE_URL) {
    if (!dryRun) {
      console.log(`\n::notice::DATABASE_URL not set — dry run only, no ledger rows written.`);
    }
    console.log(
      `\nOn an empty table, this run would insert ${counts.code_ahead + counts.contradicted} row(s) ` +
        `(${counts.code_ahead} code_ahead, ${counts.contradicted} contradicted).`
    );
    return;
  }

  if (!workspaceId) {
    console.error('ERROR: --workspace-id is required when writing to the ledger (omit for --dry-run).');
    process.exit(1);
  }

  const summary = await writeLedgerFromEvaluations(workspaceId, evaluations);

  console.log(`\nLedger writes:`);
  console.log(`  inserted:      ${summary.inserted}`);
  console.log(`  reopened:      ${summary.reopened}`);
  console.log(`  refreshed:     ${summary.refreshed}`);
  console.log(`  kept accepted: ${summary.keptAccepted}`);
  console.log(`  resolved:      ${summary.resolved}`);
  console.log(`  skipped:       ${summary.skipped}`);
  console.log(`By direction: spec_ahead=${summary.byDirection.spec_ahead} code_ahead=${summary.byDirection.code_ahead} contradicted=${summary.byDirection.contradicted}`);
}

main();
