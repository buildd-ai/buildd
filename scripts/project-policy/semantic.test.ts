import { expect, it } from 'bun:test';
import policy from './product-language.json';
import { extractChangedSubjects, evaluateSubject, policyExitCode } from './pipeline';
import { buildSemanticState, createJevEvaluator, createClefEvaluator, semanticDecision } from './semantic';

const subject = () => extractChangedSubjects({ file: 'src/Status.tsx', before: '', after: '<span>slipping first</span>' })[0];
const context = { source: 'fixture provenance', purpose: 'section-subtitle' };

it('runs each Clef variant through Workers AI with the same policy and records top probability separately', async () => {
  for (const model of ['clef', 'clef-flash'] as const) {
    const evaluate = createClefEvaluator(model, 'test-key', { kind: 'workers-ai', baseURL: 'https://example.test/ai/run' }, async (url, init) => {
      expect(String(url)).toEndWith(`/@cf/cloudflare/${model}`);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      expect(body.questions).toEqual(semanticDecision(policy).questions);
      return new Response(JSON.stringify({ success: true, result: { model, answers: { value: {
        type: 'choice', choice: 'redundant', probabilities: { useful: 0.1, redundant: 0.7, unclear: 0.1, uncertain: 0.1 }, confidence: 0.12,
      } }, usage: { input_tokens: 30 } } }), { status: 200 });
    });
    const result = await evaluate(subject(), policy, context);
    expect(result).toMatchObject({ label: 'redundant', confidence: 0.12, topProbability: 0.7, costUsd: null });
    expect(result.receipt?.provider).toBe('cloudflare');
    expect(policyExitCode(await evaluateSubject(subject(), policy, context, evaluate))).toBe(0);
  }
});

it('uses bounded semantic facts, excluding paths, before copy, context source and diffs', () => {
  const state = buildSemanticState({ ...subject(), before: 'private old copy' }, context);
  expect(state).toEqual({ text: 'slipping first', role: 'description', component: 'span', prop: 'children', purpose: 'section-subtitle' });
  expect(JSON.stringify(state)).not.toContain('private');
  expect(semanticDecision(policy).policyOf('value').mode).toBe('shadow');
});

it('runs typed Jev advice through existing shadow adapter; even confidence 1 cannot block', async () => {
  let calls = 0;
  const semantic = createJevEvaluator('test-key', async (_url, init) => {
    calls++;
    expect(String(init?.body)).not.toContain('src/Status.tsx');
    return new Response(JSON.stringify({ answers: { value: { type: 'choice', choice: 'redundant', probabilities: { useful: 0, redundant: 1, unclear: 0, uncertain: 0 }, confidence: 1 } }, usage: { input_tokens: 12, output_tokens: 4, cost: 0.000001 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const findings = await evaluateSubject(subject(), policy, context, semantic);
  const advice = findings.find(f => f.evaluator === 'model-advisory')!;
  expect(calls).toBe(1);
  expect(advice.verdict).toBe('revise');
  expect(advice.enforced).toBe(false);
  expect(advice.decision?.confidence).toBe(1);
  expect(advice.decision?.receipt).toBeTruthy();
  expect(policyExitCode(findings)).toBe(0);
});

it('never calls the model to overrule deterministic truth, or with unresolved or secret-bearing copy', async () => {
  let calls = 0;
  const semantic = createJevEvaluator('test-key', async () => { calls++; throw new Error('must not call'); });
  const bad = extractChangedSubjects({ file: 'src/X.tsx', before: '', after: '<span>Held</span>' })[0];
  const findings = await evaluateSubject(bad, policy, context, semantic);
  expect(policyExitCode(findings)).toBe(1);
  expect(findings.find(f => f.rule === 'semantic-value')?.message).toContain('skipped');
  const unknown = { ...subject(), after: null };
  await evaluateSubject(unknown, policy, context, semantic);
  const secret = await semantic({ ...subject(), after: 'Bearer test-key-that-must-not-leave' }, policy, context);
  expect(secret.label).toBe('unsupported');
  expect(calls).toBe(0);
});

it('records missing-key/provider failures as unsupported, never semantic success', async () => {
  const missing = await createJevEvaluator(undefined)(subject(), policy, context);
  expect(missing.reasonCode).toBe('missing_key');
  expect(missing.attempts).toBe(0);
  const failure = await createJevEvaluator('test-key', async () => new Response('{}', { status: 401 }))(subject(), policy, context);
  expect(failure.label).toBe('unsupported');
  expect(failure.reasonCode).toBe('provider_error');
});

it('caps explicitly opted-in local model spend and includes only resolved state facts', async () => {
  expect(buildSemanticState(subject(), { ...context, role: 'status', state: { kind: 'waiting', value: 'start_deferred' }, scheduledAt: '2027-01-15T12:00:00Z' })).toMatchObject({ canonicalLabel: 'Scheduled', scheduledAt: '2027-01-15T12:00:00.000Z' });
  const evaluate = createJevEvaluator('test-key', async () => new Response('{}', { status: 401 }), 1);
  await evaluate(subject(), policy, context);
  expect((await evaluate(subject(), policy, context)).reasonCode).toBe('local_budget_exhausted');
});
