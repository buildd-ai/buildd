import { expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedJevEvaluator } from './cache';
import { extractChangedSubjects } from './pipeline';
import { semanticDecision, semanticInputFingerprint, type SemanticEvaluation, type SemanticEvaluator } from './semantic';
import policy from './product-language.json';

it('persists successful advice, deduplicates calls and invalidates context/policy/scope/expiry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'policy-cache-'));
  let now = 1000, calls = 0;
  const subject = extractChangedSubjects({ file: 'x.tsx', before: '', after: '<p>Deployment ready.</p>' })[0];
  const evaluate: SemanticEvaluator = async (s, p, c): Promise<SemanticEvaluation> => ({ label: 'useful', confidence: 0.8, model: 'typesafe/jev-1.13',
    version: semanticDecision(p).version, promptFingerprint: semanticDecision(p).fingerprint, inputFingerprint: semanticInputFingerprint(s, p, c),
    latencyMs: 10, costUsd: 0.001, attempts: ++calls && 1, receipt: null, reasonCode: 'model_useful' });
  const make = (namespace = 'scope-a') => cachedJevEvaluator(evaluate, { directory, namespace, now: () => now, ttlMs: 100 });
  try {
    const cache = make();
    await Promise.all([cache.evaluate(subject, policy), cache.evaluate(subject, policy)]);
    expect(calls).toBe(1);
    const hit = await make().evaluate({ ...subject, file: 'another.tsx', line: 99 }, policy);
    expect(hit.cache?.hit).toBe(true);
    expect(hit.attempts).toBe(0);
    expect(hit.costUsd).toBe(0);
    expect(hit.cache?.historical.costUsd).toBe(0.001);
    await make().evaluate(subject, policy, { source: 'fixture', purpose: 'toast' });
    await make().evaluate(subject, { ...policy, customRules: [{ id: 'x', roles: [], pattern: 'x', correction: 'x' }] });
    await make('scope-b').evaluate(subject, policy);
    expect(calls).toBe(4);
    now = 1101;
    await make().evaluate(subject, policy);
    expect(calls).toBe(5);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('never caches failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'policy-cache-'));
  let calls = 0;
  const subject = extractChangedSubjects({ file: 'x.tsx', before: '', after: '<p>Deployment ready.</p>' })[0];
  const cache = cachedJevEvaluator(async () => ({ label: 'unsupported', confidence: null, model: 'typesafe/jev-1.13', version: 'v',
    promptFingerprint: 'p', inputFingerprint: 'i', latencyMs: 1, costUsd: null, attempts: ++calls && 1, receipt: null, reasonCode: 'provider_error' }), { directory, namespace: 'test' });
  try {
    await cache.evaluate(subject, policy);
    await cache.evaluate(subject, policy);
    expect(calls).toBe(2);
    expect(cache.stats.hits).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('rejects corrupt records and rechecks when neighboring text changes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'policy-cache-'));
  let calls = 0;
  const subject = extractChangedSubjects({ file: 'x.tsx', before: '', after: '<section><h2>Models</h2><p>Manage providers.</p></section>' }).find(s => s.after === 'Manage providers.')!;
  const cache = cachedJevEvaluator(async (s, p, c) => {
    calls++;
    return { label: 'useful', confidence: 0.8, model: 'typesafe/jev-1.13', version: semanticDecision(policy).version,
      promptFingerprint: semanticDecision(policy).fingerprint, inputFingerprint: semanticInputFingerprint(s, p, c), latencyMs: 1, costUsd: 0.001, attempts: 1, receipt: null, reasonCode: 'model_useful' };
  }, { directory, namespace: 'test' });
  try {
    await cache.evaluate(subject, policy);
    writeFileSync(join(directory, readdirSync(directory).find(file => file.endsWith('.json'))!), 'broken');
    await cache.evaluate(subject, policy);
    expect(calls).toBe(2);
    const record = join(directory, readdirSync(directory).find(file => file.endsWith('.json'))!);
    const invalid = JSON.parse(readFileSync(record, 'utf8'));
    invalid.result.receipt = { outcome: 'error' };
    writeFileSync(record, JSON.stringify(invalid));
    await cache.evaluate(subject, policy);
    expect(calls).toBe(3);
    await cache.evaluate({ ...subject, staticContext: { ...subject.staticContext!, heading: 'Agents' } }, policy);
    expect(calls).toBe(4);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
