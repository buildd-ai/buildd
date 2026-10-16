import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CAPTURE_FAILURE_FILE, WORKFLOW_STEPS, recordWorkflowFailure, writeCaptureFailure } from './capture-failure';
import { classifyCaptureFailure } from '../../packages/core/visual-qa-page-source';

/**
 * docs/specs/failure-incident-recovery.md §16.5: a failed visual-qa.yml run
 * leaves one typed `{ component, step, errorSignature }` in the qa-screenshots
 * artifact, so the auditor reports it instead of asking a person.
 */

let dir: string;
let out: string;
let errors: string;
const facts = { runId: '42', ref: 'mission/x', headSha: 'c'.repeat(40) };
const read = () => JSON.parse(readFileSync(join(out, CAPTURE_FAILURE_FILE), 'utf8'));
const outcomes = (failed: string, skippedAfter = true) => {
  const env: Record<string, string> = {};
  let seen = false;
  for (const s of WORKFLOW_STEPS) {
    if (s.env === failed) { env[s.env] = 'failure'; seen = true; continue; }
    env[s.env] = seen && skippedAfter ? 'skipped' : 'success';
  }
  return env;
};

beforeEach(() => {
  dir = mkdtempSync(join(import.meta.dir, '.capture-failure-test-'));
  out = join(dir, 'qa');
  errors = join(dir, 'errors');
  mkdirSync(errors, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('recordWorkflowFailure', () => {
  test('a failed scrub is visual_qa.scrub, signed from its own error text, with the run facts', () => {
    writeFileSync(join(errors, 'scrub.txt'), 'psql:scripts/qa/scrub-pii.sql:88: ERROR:  artifact_revisions rows are immutable\n');
    const f = recordWorkflowFailure({ env: outcomes('STEP_SCRUB'), outputDir: out, errorsDir: errors, facts });
    expect(f).toMatchObject({ ownership: 'infrastructure', component: 'visual_qa.scrub', step: 'Scrub prod clone to placeholders', ...facts });
    expect(read()).toEqual(f!);
    expect(f!.errorSignature).toBe(classifyCaptureFailure({ step: 'Scrub prod clone to placeholders', error: 'artifact_revisions rows are immutable' }).errorSignature);
  });

  test('the first failed step wins; later skipped steps are ignored', () => {
    const env = outcomes('STEP_CLONE');
    const f = recordWorkflowFailure({ env, outputDir: out, errorsDir: errors, facts });
    expect(f?.component).toBe('visual_qa.clone');
  });

  test('a green run writes nothing', () => {
    const env = Object.fromEntries(WORKFLOW_STEPS.map((s) => [s.env, 'success']));
    expect(recordWorkflowFailure({ env, outputDir: out, errorsDir: errors, facts })).toBeNull();
    expect(existsSync(join(out, CAPTURE_FAILURE_FILE))).toBe(false);
  });

  test('a failed capture keeps what capture.ts classified and adds the run facts', () => {
    writeCaptureFailure(out, classifyCaptureFailure({ step: 'Capture screenshots and a11y snapshots', component: 'visual_qa.boot', error: 'document response was HTTP 500' }));
    const f = recordWorkflowFailure({ env: outcomes('STEP_CAPTURE'), outputDir: out, errorsDir: errors, facts });
    expect(f).toMatchObject({ component: 'visual_qa.boot', ...facts });
    expect(read()).toEqual(f!);
  });

  test('a capture that died without classifying itself is visual_qa.browser', () => {
    const f = recordWorkflowFailure({ env: outcomes('STEP_CAPTURE'), outputDir: out, errorsDir: errors, facts });
    expect(f).toMatchObject({ ownership: 'infrastructure', component: 'visual_qa.browser' });
  });

  test('a release-PR capture (continue-on-error) that failed is still recorded', () => {
    // outcome is "failure" even when continue-on-error turns the conclusion green.
    const env = { ...Object.fromEntries(WORKFLOW_STEPS.map((s) => [s.env, 'success'])), STEP_CAPTURE: 'failure' };
    expect(recordWorkflowFailure({ env, outputDir: out, errorsDir: errors, facts })?.step).toBe('Capture screenshots and a11y snapshots');
  });

  test('a failure file from a green run (an auth wall on a report-only run) still gets the facts', () => {
    writeCaptureFailure(out, { ownership: 'person', component: null, step: 'Capture screenshots and a11y snapshots', configError: 'app_auth_not_configured', errorSignature: 'visual-qa:app_auth_not_configured_000000' });
    const env = Object.fromEntries(WORKFLOW_STEPS.map((s) => [s.env, 'success']));
    expect(recordWorkflowFailure({ env, outputDir: out, errorsDir: errors, facts })).toMatchObject({ ownership: 'person', ...facts });
  });
});
