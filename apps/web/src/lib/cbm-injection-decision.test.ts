/**
 * decideCbmInjection: access resolution, the pinned-model guard, the deadline
 * and the run → reply mapping. Never throws.
 */
import { describe, expect, it } from 'bun:test';
import { decideCbmInjection } from './cbm-injection-decision';
import type { CbmInjectionFacts } from '@buildd/core/cbm-injection';

const SCOPE = { teamId: 't', workspaceId: 'w', accountId: 'a' };
const FACTS: CbmInjectionFacts = {
  trigger: 'bash', taskKind: 'engineering', taskCategory: null, missedInManifest: false, missedAlreadyEdited: false,
  hitCount: 1, hitFiles: 1, definitionCount: 1, callerCount: 1, diffSize: 1, definitionMissed: false, symbolKind: 'Function',
};

const appliedRun = (value: string, confidence: number, status: 'applied' | 'suggested' = 'applied') => async (opts: any) => ({
  ok: true, decisionId: 'd', version: 'v1', outcomes: { action: { status, value, confidence, reason: 'below_threshold', answer: {} } },
  result: { ok: true, answers: {}, model: 'm', usage: {}, latencyMs: 5, attempts: 1 }, receipt: null, _opts: opts,
}) as any;

describe('decideCbmInjection', () => {
  it('runs on the team key with facts-only state and returns the applied action', async () => {
    let seen: any;
    const reply = await decideCbmInjection(SCOPE, FACTS, {
      resolveAccess: async () => ({ ok: true, apiKey: 'sk-team', model: 'jev' }),
      run: (async (opts: any) => { seen = opts; return appliedRun('inject_impact', 0.8)(opts); }) as any,
    });
    expect(reply).toMatchObject({ ok: true, action: 'inject_impact', status: 'applied', confidence: 0.8 });
    expect(seen.apiKey).toBe('sk-team');
    expect(seen.timeoutMs).toBeLessThanOrEqual(900);
    expect(JSON.stringify(seen.state)).not.toContain('sk-team');
  });

  it('a refused access (no key, capability off) is an error kind', async () => {
    const reply = await decideCbmInjection(SCOPE, FACTS, {
      resolveAccess: async () => ({ ok: false, error: { kind: 'missing_key' } }),
      run: (() => { throw new Error('must not run'); }) as any,
    });
    expect(reply).toMatchObject({ ok: false, error: 'missing_key' });
  });

  it('a team routed to a non-Jev endpoint cannot answer the pinned decision', async () => {
    const reply = await decideCbmInjection(SCOPE, FACTS, {
      resolveAccess: async () => ({ ok: true, apiKey: 'gw', model: 'qwen', endpoint: { kind: 'chat', baseURL: 'https://gw.example.test/v1' } as any }),
    });
    expect(reply).toMatchObject({ ok: false, error: 'unsupported_decision_model' });
  });

  it('a slow key lookup that eats the budget is a timeout, and a throw is transport', async () => {
    let t = 0;
    const slow = await decideCbmInjection(SCOPE, FACTS, {
      now: () => t,
      resolveAccess: async () => { t += 880; return { ok: true, apiKey: 'k', model: 'jev' }; },
      run: (() => { throw new Error('must not run'); }) as any,
    });
    expect(slow).toMatchObject({ ok: false, error: 'timeout' });
    const thrown = await decideCbmInjection(SCOPE, FACTS, { resolveAccess: async () => { throw new Error('db down'); } });
    expect(thrown).toMatchObject({ ok: false, error: 'transport' });
  });
});
