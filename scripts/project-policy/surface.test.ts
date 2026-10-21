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
    { path: 'apps/web/src/app/dev/toast/page.tsx', content: '<p>Development fixture</p>' },
  ], policyPreset('wwvd').policy, evaluate);
  expect(report.inventory.subjects).toBe(4);
  expect(report.inventory.excludedDevelopmentFiles).toBe(1);
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

it('bounds bulk inference concurrency while retaining stable row order', async () => {
  let active = 0, peak = 0;
  const evaluate: SemanticEvaluator = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { label: 'useful', confidence: 0.8, model: 'test', version: 'v', promptFingerprint: 'p', inputFingerprint: 'i',
      attempts: 1, latencyMs: 5, costUsd: 0.001, receipt: null, reasonCode: 'model_useful' };
  };
  const report = await scanSurface([{ path: 'x.tsx', content: `<section>${Array.from({ length: 8 }, (_, i) => `<p>Example ${i}</p>`).join('')}</section>` }], policyPreset('wwvd').policy, evaluate);
  expect(peak).toBe(4);
  expect(report.rows.map(row => row.subject.after)).toEqual(Array.from({ length: 8 }, (_, i) => `Example ${i}`));
});
