import { describe, test, expect } from 'bun:test';
import type { WorkerMilestone } from '@buildd/core/db/schema';
import { describeOp, describeOps, isSubstantive, isToolPreamble, preambleActionLabel } from './tool-preamble';

const phase = (label: string, ops?: string[], toolCount = 1): WorkerMilestone => ({ type: 'phase', label, toolCount, ts: 0, ...(ops && { ops }) });

describe('isToolPreamble — structural, not phrase-coupled', () => {
  // None of these share an opening phrase; what makes them preambles is that
  // each is one short contentless sentence that was followed by tool calls.
  test.each([
    'Now let me save a knowledge entry',
    'Let me get error traces',
    'Checking the decision log next…',
    'Time to create the workspace.',
    'Quick look at the schema',
    'Pulling the PR state',
    'Okay',
    'First, the route handler:',
  ])('preamble: %s', (text) => {
    expect(isToolPreamble(phase(text))).toBe(true);
  });

  test('the same text with no tool calls after it is not a preamble', () => {
    expect(isToolPreamble(phase('Pulling the PR state', undefined, 0))).toBe(false);
    expect(isToolPreamble({ type: 'status', label: 'Pulling the PR state', ts: 0 })).toBe(false);
  });

  test.each([
    'Found the cause: the parser drops the trailing newline',
    'The test fails because the fixture is stale, so let me fix it',
    'Decided to keep the old route as a redirect',
    'Warning: this migration drops a column',
    'Tests pass',
    'The claim route does not filter by role',
    "I've traced it to the scheduler",
  ])('substantive prose stays visible: %s', (text) => {
    expect(isSubstantive(text)).toBe(true);
    expect(isToolPreamble(phase(text))).toBe(false);
  });

  test('a second sentence means the line goes on to say something', () => {
    expect(isToolPreamble(phase('Read the route. The handler swallows the 409'))).toBe(false);
  });

  test('long prose is not a lead-in', () => {
    expect(isToolPreamble(phase('Let me walk through every dispatch path in the claim route, the scheduler and the runner pickup loop together'))).toBe(false);
  });

  test('a phase without a label (sensitive workspace) is left alone', () => {
    expect(isToolPreamble({ type: 'phase', toolCount: 3, ts: 0 })).toBe(false);
  });
});

describe('describeOp / describeOps', () => {
  test.each([
    ['get_decision', 'Checked decision'],
    ['create_workspace', 'Created workspace'],
    ['get_error_traces', 'Checked error traces'],
    ['learn', 'Saved knowledge'],
    ['create_pr', 'Created PR'],
    ['list_prs', 'Listed PRs'],
    ['Read', 'Read files'],
    ['Bash', 'Ran commands'],
    ['Grep', 'Searched code'],
    ['frobnicate', 'Ran frobnicate'],
  ])('%s → %s', (op, label) => {
    expect(describeOp(op)).toBe(label);
  });

  test('bookkeeping tools are never named', () => {
    expect(describeOp('TodoWrite')).toBeNull();
    expect(describeOps(['ToolSearch', 'TodoWrite'])).toBeNull();
  });

  test('several ops read as one sentence, in call order, deduped', () => {
    expect(describeOps(['Read', 'Glob', 'Grep'])).toBe('Read files and searched code');
    expect(describeOps(['Read', 'Edit', 'Bash'])).toBe('Read files, edited files and ran commands');
    expect(describeOps(['Read', 'Edit', 'Bash', 'create_pr', 'learn'])).toBe('Read files, edited files, ran commands and 2 more');
  });

  test('no ops, no label', () => {
    expect(describeOps(undefined)).toBeNull();
    expect(describeOps([])).toBeNull();
  });

  test('preambleActionLabel names a phase by its ops', () => {
    expect(preambleActionLabel(phase('Now let me check the decision', ['get_decision']))).toBe('Checked decision');
    expect(preambleActionLabel(phase('Now let me check the decision'))).toBeNull();
  });
});
