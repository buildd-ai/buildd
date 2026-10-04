import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../packages/core/prompt-seed';
import { listRegisteredPrompts, resetPrompts } from '../packages/core/prompts';
import { resetPromptedQuestionsCache } from '../packages/core/prompted-decision';
import type { decisionCall } from '../packages/core/decision-client';
import { TASK_CATEGORY_PROMPT_ID, TASK_CATEGORY_QUESTIONS } from '../apps/web/src/lib/task-category-decision';
import {
  findPromptLeaks,
  formatEvalSummary,
  installPromptsDir,
  runPrivatePromptEval,
} from './private-prompt-eval';

// Text only the "private" directory carries. If any of it reaches the report,
// the report would leak prompt text into a world-readable log.
const PRIVATE_MARKER = 'Private wording seven: a regression is a bug even when nobody filed it as one.';
const CASE_TITLE = 'Checkout total drops the tax line on reload';

function privateDir(): { dir: string; body: string } {
  const dir = mkdtempSync(join(tmpdir(), 'private-prompts-'));
  const q = structuredClone(TASK_CATEGORY_QUESTIONS) as typeof TASK_CATEGORY_QUESTIONS;
  (q.category.criteria.bug as { what: string }).what = PRIVATE_MARKER;
  const body = `${JSON.stringify(q, null, 2)}\n`;
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts', 'tc.json'), body);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ prompts: [{ id: TASK_CATEGORY_PROMPT_ID, version: 3, file: 'prompts/tc.json', sha256: sha256Hex(body) }] }));
  mkdirSync(join(dir, 'evals'));
  writeFileSync(
    join(dir, 'evals', 'task-category.jsonl'),
    [
      JSON.stringify({ id: 'c1', label: 'bug', title: CASE_TITLE, description: 'Customers see a lower total after refreshing.' }),
      JSON.stringify({ id: 'c2', label: 'docs', title: 'Explain the export format in the README', description: '' }),
    ].join('\n'),
  );
  return { dir, body };
}

/** Answers right only when the private wording was sent, so a pass proves which text was scored. */
const fakeDecide = (async (params: { state: unknown; questions: unknown }) => {
  const sentPrivate = JSON.stringify(params.questions).includes(PRIVATE_MARKER);
  const title = (params.state as { task: { title: string } }).task.title;
  const choice = !sentPrivate ? 'feature' : title === CASE_TITLE ? 'bug' : 'docs';
  return { ok: true, answers: { category: { choice, confidence: 0.95 } }, usage: { costUsd: 0.001 }, latencyMs: 5, attempts: 1 };
}) as unknown as typeof decisionCall;

afterEach(() => {
  resetPrompts();
  resetPromptedQuestionsCache();
});

describe('runPrivatePromptEval', () => {
  it('scores the private text, naming its version and fingerprint', async () => {
    const { dir, body } = privateDir();
    const catalog = listRegisteredPrompts();
    const entries = await installPromptsDir(dir, catalog);
    const report = await runPrivatePromptEval({ catalog, entries, casesDir: join(dir, 'evals'), dryRun: false, require: true, apiKey: 'k', decide: fakeDecide });

    const tc = report.sets.find(s => s.set === 'task_category')!;
    expect(tc.status).toBe('scored');
    expect(tc.cases).toBe(2);
    expect(tc.accuracy).toBe(1);
    expect(tc.promptVersion).toBe('tc1+p3');
    expect(tc.fingerprint).toEqual({ id: TASK_CATEGORY_PROMPT_ID, source: 'private', version: 3, hash: sha256Hex(body).slice(0, 12) });
    expect(report.problems).toEqual([]);
  });

  it('never puts prompt text or case content in the summary or the JSON', async () => {
    const { dir, body } = privateDir();
    const catalog = listRegisteredPrompts();
    const entries = await installPromptsDir(dir, catalog);
    const report = await runPrivatePromptEval({ catalog, entries, casesDir: join(dir, 'evals'), dryRun: false, require: true, apiKey: 'k', decide: fakeDecide });
    const out = formatEvalSummary(report) + JSON.stringify(report);

    expect(out).not.toContain(PRIVATE_MARKER);
    expect(out).not.toContain(CASE_TITLE);
    expect(findPromptLeaks(out, [{ id: TASK_CATEGORY_PROMPT_ID, body }])).toEqual([]);
    expect(findPromptLeaks(out, catalog.map(c => ({ id: c.id, body: c.publicDefault })))).toEqual([]);
  });

  it('dry run on the public defaults makes no calls and passes without --require', async () => {
    const catalog = listRegisteredPrompts();
    let calls = 0;
    const report = await runPrivatePromptEval({
      catalog, entries: null, casesDir: null, dryRun: true, require: false, apiKey: null,
      decide: (async () => { calls++; throw new Error('no calls in a dry run'); }) as unknown as typeof decisionCall,
    });
    expect(calls).toBe(0);
    expect(report.source).toBe('public defaults');
    expect(report.sets.every(s => s.status === 'no_cases' && s.fingerprint.source === 'public default')).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('with --require, a run that has nothing to measure fails and says why', async () => {
    const catalog = listRegisteredPrompts();
    const report = await runPrivatePromptEval({ catalog, entries: null, casesDir: null, dryRun: false, require: true, apiKey: null });
    expect(report.problems).toEqual([
      'no private prompt text was loaded',
      'OPENROUTER_API_KEY is not set, so no decision call can be made (set the repo secret OPENROUTER_API_KEY)',
      expect.stringContaining('no labelled cases found'),
    ]);
  });

  it('with --require, a set whose every call failed is red, not a 0% score', async () => {
    const { dir } = privateDir();
    const catalog = listRegisteredPrompts();
    const entries = await installPromptsDir(dir, catalog);
    const failing = (async () => ({ ok: false, error: { kind: 'timeout' }, latencyMs: 1, attempts: 1 })) as unknown as typeof decisionCall;
    const report = await runPrivatePromptEval({ catalog, entries, casesDir: join(dir, 'evals'), dryRun: false, require: true, apiKey: 'k', decide: failing });
    expect(report.problems).toEqual([expect.stringContaining('every decision call failed for: task_category')]);
  });
});

describe('findPromptLeaks', () => {
  const body = JSON.stringify({ q: { criteria: { a: 'The quick brown fox jumps over the lazy dog, then files a ticket about it and waits.' } } });

  it('flags a whole string leaf and a fragment cut from the middle of one', () => {
    expect(findPromptLeaks('x The quick brown fox jumps over the lazy dog, then files a ticket about it and waits. y', [{ id: 'p', body }])).toEqual(['p']);
    expect(findPromptLeaks('...over the lazy dog, then files a ticket about it and wa...', [{ id: 'p', body }])).toEqual(['p']);
  });

  it('ignores whitespace reflow, and passes text that shares only short words', () => {
    expect(findPromptLeaks('The quick brown fox jumps over\n  the lazy dog, then files a ticket about it and waits.', [{ id: 'p', body }])).toEqual(['p']);
    expect(findPromptLeaks('| task_category | `buildd.task_category` | v1 `abc` | the dog |', [{ id: 'p', body }])).toEqual([]);
  });

  it('reads plain-text bodies line by line', () => {
    const md = '# Role\n\nAlways open the pull request against the integration branch first.\n';
    expect(findPromptLeaks('note: Always open the pull request against the integration branch first.', [{ id: 'r', body: md }])).toEqual(['r']);
  });
});
