/**
 * The Decide port's boundary (docs/specs/workflow-kernel-library.md §2):
 * `decideAt` is the command and effect layer's, never the reducer's or a gate
 * check's. AC-27–AC-29 run as shared conformance scenarios
 * (conformance/scenarios.ts) on the in-memory and Postgres stores.
 */
import { describe, expect, test } from 'bun:test';
import { decideAt, VISUAL_IMPACT_POINT, type DecisionFact } from './decide';
import { ScriptedDecide } from './memory/ports';

// Bun's own file API: the package's boundary test allows no Node built-in, even in a test.
const src = (f: string) => Bun.file(new URL(`./${f}`, import.meta.url)).text();
/** An import of the decide module, built so this file does not itself contain one. */
const IMPORTS_DECIDE = new RegExp(['from', "'\\./decide'"].join('\\s+'));
const NAMES_DECIDE = /decideAt|decideAndRecord|DecisionFact/;

describe('decide stays out of the reducer and the gate', () => {
  test('the reducer, commands and projections never import decide or read a decision fact', async () => {
    for (const f of ['reducer.ts', 'commands.ts', 'projections.ts', 'types.ts', 'base-delta.ts']) {
      const text = await src(f);
      expect({ f, hit: IMPORTS_DECIDE.test(text) || NAMES_DECIDE.test(text) }).toEqual({ f, hit: false });
    }
  });
  test('the scan can fail', async () => {
    expect(IMPORTS_DECIDE.test(['import { decideAt }', 'from', "'./decide';"].join(' '))).toBe(true);
    expect(NAMES_DECIDE.test(await src('effects.ts'))).toBe(false);
    expect(NAMES_DECIDE.test(await src('decide.ts'))).toBe(true);
  });
});

describe('decideAt', () => {
  test('a timeout is bounded and takes the default', async () => {
    const d = new ScriptedDecide('slow', { visual_impact: { hangs: true } });
    const t0 = Date.now();
    const r = await decideAt(VISUAL_IMPACT_POINT, { headSha: 'H' }, { decide: d, timeoutMs: 30 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.fact).toMatchObject({ verdict: 'review_required', source: 'default', fallback: 'timeout', deciderId: 'slow' });
  });
  test('an error is recorded, bounded, and takes the default', async () => {
    const r = await decideAt(VISUAL_IMPACT_POINT, { headSha: 'H' }, { decide: new ScriptedDecide('e', { visual_impact: { throws: 'x'.repeat(500) } }) });
    expect(r.fact).toMatchObject({ fallback: 'error', verdict: 'review_required' });
    expect(r.fact.error!.length).toBe(200);
  });
  test('a recorded fact is replayed without calling the decider', async () => {
    const d = new ScriptedDecide('d', { visual_impact: { verdict: 'review_required', confidence: 1, reason: 'r' } });
    const recorded: DecisionFact = { point: 'visual_impact', inputKey: 'H', deciderId: 'old', verdict: 'no_visual_impact', confidence: 0.9, reason: 'r', source: 'decider', fallback: null };
    const r = await decideAt(VISUAL_IMPACT_POINT, { headSha: 'H' }, { decide: d, recorded });
    expect(r).toEqual({ fact: recorded, replayed: true });
    expect(d.calls).toEqual([]);
  });
  test('a confident, valid answer is taken as given', async () => {
    const d = new ScriptedDecide('d@2', { visual_impact: { verdict: 'no_visual_impact', confidence: 0.85, reason: 'copy only' } });
    const r = await decideAt(VISUAL_IMPACT_POINT, { headSha: 'H' }, { decide: d });
    expect(r.fact).toEqual({ point: 'visual_impact', inputKey: 'H', deciderId: 'd@2', verdict: 'no_visual_impact', confidence: 0.85, reason: 'copy only', source: 'decider', fallback: null });
    expect(d.calls).toEqual([{ point: 'visual_impact', input: { headSha: 'H' } }]);
  });
});
