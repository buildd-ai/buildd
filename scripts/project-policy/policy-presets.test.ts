import { expect, it } from 'bun:test';
import { policyPreset } from './policy-presets';
import { runLocalCheck } from './cli';

it('keeps WWVD opt-in, attributable and advisory, with positive and negative controls', () => {
  expect(policyPreset().policy.id).toBe('buildd.product-language');
  const { policy, examples } = policyPreset('wwvd');
  expect(policy.id).toBe('buildd.wwvd');
  expect(policy.authority.title).toContain('User');
  expect(policy.semantic.instructions).toContain('necessary');
  expect(policy.enforcement.commit).toBe('deterministic-only');
  expect(new Set(examples.map(row => row.expected))).toEqual(new Set(['useful', 'redundant', 'unclear']));
  expect(examples.some(row => row.expected === 'useful' && row.text.length > 180)).toBe(true);
  expect(() => policyPreset('unknown')).toThrow('Unknown policy preset');
});

it('applies the selected policy to real changed copy without turning model advice into a veto', async () => {
  const selected = policyPreset('wwvd').policy;
  const result = await runLocalCheck({ changes: [{ file: 'src/Deploy.tsx', before: '', after: '<p>Your deployment is ready and you can now visit it.</p>' }] }, 'commit',
    async (_subject, policy) => {
      expect(policy.id).toBe(selected.id);
      return { label: 'redundant', confidence: 1, model: 'test', version: 'v1', promptFingerprint: 'p', inputFingerprint: 'i',
        attempts: 1, latencyMs: 1, costUsd: null, receipt: null, reasonCode: 'model_redundant' };
    }, selected);
  expect(result.policy).toBe('buildd.wwvd@1');
  expect(result.findings.some(row => row.evaluator === 'model-advisory' && !row.enforced)).toBe(true);
  expect(result.findings.find(row => row.evaluator === 'model-advisory')?.suggestedCorrection).toContain('unnecessary explanation');
  expect(result.exitCode).toBe(0);
});
