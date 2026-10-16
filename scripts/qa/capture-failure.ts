/**
 * The typed capture failure of one Visual QA run (docs/specs/failure-incident-recovery.md
 * §16.5): `{ component, step, errorSignature }` written as `capture-failure.json`
 * beside the manifest, so the qa-screenshots artifact says what failed and the
 * auditor reports it instead of asking a person.
 *
 * capture.ts writes its own failures (boot, browser, an auth wall) with
 * `writeCaptureFailure`. The workflow's "Classify capture failure" step runs
 * this file as a CLI after capture, always:
 *
 *   STEP_<X>=<steps.<id>.outcome> ...  QA_OUTPUT=/tmp/qa  QA_ERRORS_DIR=/tmp/qa-errors
 *   QA_RUN_ID / QA_REF / QA_HEAD_SHA   the run facts added to the record
 *   bun scripts/qa/capture-failure.ts
 *
 * The first failed step is classified, from the error text the step left in
 * QA_ERRORS_DIR/<file> (outside QA_OUTPUT, so raw output is never uploaded).
 * A failure capture.ts already typed is kept and only gets the run facts.
 * Never exits non-zero: the run's own failure is the signal, this only types it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  classifyCaptureFailure,
  parseCaptureFailure,
  type CaptureFailure,
  type CaptureFailureFacts,
} from '../../packages/core/visual-qa-page-source';

export const CAPTURE_FAILURE_FILE = 'capture-failure.json';

/** visual-qa.yml steps in run order: the step's name and id, its outcome env var, its error file. */
export const WORKFLOW_STEPS = [
  { step: 'Install Playwright + Chromium', id: 'browser_install', env: 'STEP_BROWSER_INSTALL', errorFile: null },
  { step: 'Create Neon prod-clone branch', id: 'neon', env: 'STEP_CLONE', errorFile: 'clone.txt' },
  { step: 'Run migrations', id: 'migrate', env: 'STEP_MIGRATE', errorFile: 'migrate.txt' },
  { step: 'Scrub prod clone to placeholders', id: 'scrub', env: 'STEP_SCRUB', errorFile: 'scrub.txt' },
  { step: 'Guard scrubbed clone', id: 'guard', env: 'STEP_GUARD', errorFile: 'guard.txt' },
  { step: 'Start app', id: 'boot', env: 'STEP_BOOT', errorFile: 'boot.txt' },
  { step: 'Capture screenshots and a11y snapshots', id: 'capture', env: 'STEP_CAPTURE', errorFile: null },
] as const;

export function writeCaptureFailure(outputDir: string, failure: CaptureFailure): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, CAPTURE_FAILURE_FILE), JSON.stringify(failure, null, 2));
}

function readExisting(outputDir: string): CaptureFailure | null {
  const path = join(outputDir, CAPTURE_FAILURE_FILE);
  if (!existsSync(path)) return null;
  try { return parseCaptureFailure(JSON.parse(readFileSync(path, 'utf8'))); } catch { return null; }
}

function withFacts(f: CaptureFailure, facts: CaptureFailureFacts): CaptureFailure {
  const set = Object.fromEntries(Object.entries(facts).filter(([, v]) => typeof v === 'string' && v));
  return { ...f, ...set };
}

/** Type the run's failure, write it, and return it. Null for a run with nothing to report. */
export function recordWorkflowFailure(opts: {
  env: Record<string, string | undefined>;
  outputDir: string;
  errorsDir: string;
  facts: CaptureFailureFacts;
}): CaptureFailure | null {
  const failed = WORKFLOW_STEPS.find((s) => opts.env[s.env] === 'failure');
  // capture.ts typed it (also on a report-only run, where a wall leaves the step green).
  const existing = readExisting(opts.outputDir);
  let failure: CaptureFailure | null = null;
  if (existing && (!failed || failed.env === 'STEP_CAPTURE')) {
    failure = existing;
  } else if (failed) {
    const errorPath = failed.errorFile ? join(opts.errorsDir, failed.errorFile) : null;
    const error = errorPath && existsSync(errorPath) ? readFileSync(errorPath, 'utf8') : null;
    failure = classifyCaptureFailure({ step: failed.step, error });
  }
  if (!failure) return null;
  failure = withFacts(failure, opts.facts);
  writeCaptureFailure(opts.outputDir, failure);
  return failure;
}

if (import.meta.main) {
  const failure = recordWorkflowFailure({
    env: process.env,
    outputDir: process.env.QA_OUTPUT ?? '/tmp/qa',
    errorsDir: process.env.QA_ERRORS_DIR ?? '/tmp/qa-errors',
    facts: { runId: process.env.QA_RUN_ID, ref: process.env.QA_REF, headSha: process.env.QA_HEAD_SHA },
  });
  if (!failure) {
    console.log('[capture-failure] no failed step');
  } else {
    const what = failure.ownership === 'person' ? failure.configError : failure.component ?? 'unclassified';
    console.log(`[capture-failure] ${failure.ownership}: ${what} at "${failure.step}" (${failure.errorSignature})`);
    if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Visual QA capture failure::${failure.ownership} ${what} at ${failure.step}`);
  }
}
