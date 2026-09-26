import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/decision-client', () => ({
  decisionCall: async () => ({ ok: false, error: { kind: 'capability_disabled' } }),
  gateChoice: (a: any, min: number) => (!a ? { apply: false, reason: 'no_answer' }
    : a.confidence >= min ? { apply: true, label: a.choice, confidence: a.confidence }
    : { apply: false, reason: 'low_confidence', label: a.choice, confidence: a.confidence }),
}));

const { routeTurn, FALLBACK_TIER } = await import('./routing');

const input = { teamId: 't', workspaceId: null, userId: 'u', message: 'make this a mission' };
const answer = (complexity: [string, number], intent: [string, number]) => async () => ({
  ok: true as const,
  answers: {
    complexity: { choice: complexity[0], confidence: complexity[1] },
    intent: { choice: intent[0], confidence: intent[1] },
  },
}) as any;

describe('routeTurn', () => {
  it('no decision available ⇒ standard tier with every tool', async () => {
    expect(await routeTurn(input)).toEqual({ tier: 'standard', allowWrites: true, source: 'fallback' });
    expect(FALLBACK_TIER).toBe('standard');
  });

  it('a throwing decision call still falls back', async () => {
    expect(await routeTurn(input, { decide: async () => { throw new Error('boom'); } }))
      .toEqual({ tier: 'standard', allowWrites: true, source: 'fallback' });
  });

  it('confident complexity maps simple/standard/complex to budget/standard/premium', async () => {
    expect((await routeTurn(input, { decide: answer(['simple', 0.95], ['file_work', 0.5]) })).tier).toBe('budget');
    expect((await routeTurn(input, { decide: answer(['complex', 0.95], ['file_work', 0.5]) })).tier).toBe('premium');
  });

  it('low confidence takes the safe default tier', async () => {
    expect((await routeTurn(input, { decide: answer(['simple', 0.5], ['file_work', 0.5]) })).tier).toBe('standard');
  });

  it('write tools are withheld only on a confident non-filing intent', async () => {
    expect((await routeTurn(input, { decide: answer(['standard', 0.9], ['needs_tools', 0.95]) })).allowWrites).toBe(false);
    expect((await routeTurn(input, { decide: answer(['standard', 0.9], ['needs_tools', 0.6]) })).allowWrites).toBe(true);
    expect((await routeTurn(input, { decide: answer(['standard', 0.9], ['file_work', 0.99]) })).allowWrites).toBe(true);
  });

  it('reports the decision call\'s usage so the turn can meter it', async () => {
    const decide = async () => ({
      ok: true as const,
      answers: { complexity: { choice: 'simple', confidence: 0.95 }, intent: { choice: 'answer', confidence: 0.95 } },
      usage: { inputTokens: 40, outputTokens: 4, costUsd: 0.0007 },
    }) as any;
    expect((await routeTurn(input, { decide })).usage).toEqual({ inputTokens: 40, outputTokens: 4, costUsd: 0.0007 });
  });
});
