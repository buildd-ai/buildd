#!/usr/bin/env bun
/**
 * Spec conformance checker CLI — Slice 1 of docs/design/spec-conformance.md.
 *
 * Evaluates every assertion in docs/specs/ and docs/design/ frontmatter
 * against the codebase and prints derived-vs-declared status per doc. No
 * ledger table, no CI wiring yet — this is the standalone evaluator; later
 * slices persist its output as `spec_discrepancies` rows and wire it into a
 * CI job with a delta gate. Running this script directly does not fail a
 * build on its own.
 *
 * Usage:
 *   bun run scripts/check-spec-conformance.ts
 *   bun run scripts/check-spec-conformance.ts --specs-root docs/specs --design-root docs/design
 *   bun run scripts/check-spec-conformance.ts --json
 *   bun run scripts/check-spec-conformance.ts --fail-on-contradiction
 *
 * Exit codes:
 *   0  always, unless --fail-on-contradiction is passed and at least one
 *      doc's declared status contradicts its derived status (§2)
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { evaluateAllDocs, resolveConformanceConfig, MISSING_ASSERTIONS_DEBT, type DocEvaluation } from '../packages/core/spec-conformance';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const config = resolveConformanceConfig({
  repoRoot: ROOT,
  specsRoot: argValue('--specs-root'),
  designRoot: argValue('--design-root'),
});

const asJson = process.argv.includes('--json');
const failOnContradiction = process.argv.includes('--fail-on-contradiction');

const evaluations = evaluateAllDocs(config);
const contradictions = evaluations.filter((e) => e.contradiction);

if (asJson) {
  console.log(JSON.stringify(evaluations, null, 2));
} else {
  printReport(evaluations);
}

if (failOnContradiction && contradictions.length > 0) {
  process.exit(1);
}

function printReport(evals: DocEvaluation[]) {
  const byDerived: Record<string, number> = { implemented: 0, partial: 0, failing: 0, unverified: 0 };
  let totalAssertions = 0;
  let totalPass = 0;
  let totalFail = 0;
  let totalSuppressed = 0;
  let totalValidationErrors = 0;

  for (const e of evals) {
    byDerived[e.derivedStatus]++;
    totalAssertions += e.results.length;
    totalValidationErrors += e.validationErrors.length;
    for (const r of e.results) {
      if (r.outcome === 'pass') totalPass++;
      else if (r.outcome === 'fail') totalFail++;
      else totalSuppressed++;
    }
  }

  console.log(`Spec conformance — ${evals.length} docs (${config.specsRoot}, ${config.designRoot})\n`);

  for (const e of evals) {
    if (e.results.length === 0 && e.validationErrors.length === 0 && !e.contradiction) continue; // quiet for the common zero-assertion case
    const flag = e.contradiction ? ' ⚠ CONTRADICTION' : '';
    console.log(`${e.path}`);
    console.log(`  declared=${e.declaredStatus ?? '(none)'} derived=${e.derivedStatus}${flag}`);
    if (e.contradiction) console.log(`  ${e.contradiction.message}`);
    for (const err of e.validationErrors) {
      console.log(`  [invalid] ${err.message}`);
    }
    for (const r of e.results) {
      const mark = r.outcome === 'pass' ? 'PASS' : r.outcome === 'fail' ? 'FAIL' : 'SKIP';
      console.log(`  [${mark}] ${r.id} (${r.type}): ${r.detail}`);
    }
    console.log('');
  }

  console.log('── Summary ──────────────────────────────────────────────');
  console.log(`Docs:              ${evals.length}`);
  console.log(`  implemented:     ${byDerived.implemented}`);
  console.log(`  partial:         ${byDerived.partial}`);
  console.log(`  failing:         ${byDerived.failing}`);
  console.log(`  unverified:      ${byDerived.unverified}  (no assertions declared — not a failure, see §16)`);
  console.log(`Assertions:        ${totalAssertions} (${totalPass} pass, ${totalFail} fail, ${totalSuppressed} suppressed)`);
  console.log(`Validation errors: ${totalValidationErrors}`);
  console.log(`Contradictions:    ${contradictions.length}`);
  console.log(
    `Assertion debt:    ${MISSING_ASSERTIONS_DEBT.size} pre-existing doc(s) grandfathered past the missing-assertions gate — shrinks only, never grows (Part A)`,
  );
}
