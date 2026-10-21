import { expect, it } from 'bun:test';
import { explorePolicy, localJevEvaluator } from './explore';
import policy from './product-language.json';
import type { SemanticEvaluation } from './semantic';

it('scores labeled development examples without leaking gold to evaluator or selecting an enforcement threshold', async () => {
  const rows = [{ text: 'oldest first', purpose: 'section-subtitle', expected: 'redundant' }];
  const result = await explorePolicy(rows, policy, async (subject, _policy, context) => {
    expect(subject.after).toBe('oldest first');
    expect(JSON.stringify(context)).not.toContain('redundant');
    return { label: 'redundant', confidence: 0.9, model: 'test-model', version: 'v1', promptFingerprint: 'p1',
      inputFingerprint: 'i1', latencyMs: 12, costUsd: 0.001, attempts: 1, receipt: null, reasonCode: 'model_redundant' } satisfies SemanticEvaluation;
  });
  expect(result.summary.accuracy).toBe(1);
  expect(result.measurement.latencyTotalMs).toBe(12);
  expect(result.measurement.costUsd).toBe(0.001);
  expect(result.enforcement).toBe('advisory-only; no threshold selected');
});

it('honors explicit workspace credential scope ahead of an unrelated env key', async () => {
  const old = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'unrelated-test-key';
  try {
    let calls = 0;
    await localJevEvaluator('team-test', 'workspace-test', async scope => {
      calls++;
      expect(scope).toEqual({ teamId: 'team-test', workspaceId: 'workspace-test', allowPlatformKey: false });
      return { apiKey: null };
    });
    expect(calls).toBe(1);
  } finally {
    if (old === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = old;
  }
});
