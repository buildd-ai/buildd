import { expect, it } from 'bun:test';
import { scanSurface } from './surface';
import { policyPreset } from './policy-presets';
import type { SemanticEvaluator } from './semantic';

it('inventories the surface, checks deterministic rules first and reports model coverage honestly', async () => {
  let calls = 0;
  const evaluate: SemanticEvaluator = async subject => {
    calls++;
    expect(subject.after).not.toBe('Held');
    if (subject.role === 'description') expect(subject.staticContext?.heading).toBe('Deployments');
    return { label: 'redundant', confidence: 0.7, model: 'test', version: 'v', promptFingerprint: 'p', inputFingerprint: 'i',
      attempts: 1, latencyMs: 2, costUsd: 0.001, receipt: null, reasonCode: 'model_redundant' };
  };
  const report = await scanSurface([
    { path: 'src/Toast.tsx', content: '<section><h2>Deployments</h2><p>Your deployment is ready and you can now visit it.</p><p>Held</p><p>{dynamic}</p></section>' },
    { path: 'src/Toast.test.tsx', content: '<p>Ignore this</p>' },
  ], policyPreset('wwvd').policy, evaluate);
  expect(report.inventory.subjects).toBe(4);
  expect(report.inventory.unresolved).toBe(1);
  expect(report.coverage.deterministicViolations).toBeGreaterThan(0);
  expect(report.coverage.newDecisions).toBe(calls);
  expect(report.coverage.advisoryRevisions).toBe(calls);
  expect(report.coverage.rendered).toBe(false);
});

it('does not call the model in inventory-only mode and records parse errors', async () => {
  const report = await scanSurface([{ path: 'x.tsx', content: '<p>Deployment ready.</p>' }, { path: 'broken.tsx', content: '<p title=' }], policyPreset('wwvd').policy);
  expect(report.coverage.newDecisions).toBe(0);
  expect(report.errors).toHaveLength(1);
  expect(report.inventory.subjects).toBe(1);
});
