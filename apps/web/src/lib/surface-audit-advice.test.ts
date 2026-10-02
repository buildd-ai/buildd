import { describe, it, expect } from 'bun:test';

/**
 * The visual audit suggestion for the decision sheet. A decision model picks
 * `audit` or `waive`; a pick under the confidence gate, an error, a missing key
 * or a sensitive workspace all mean "no suggestion". Receipts are recorded and
 * the result is cached per mission and merged set. `decisionCall`, the key
 * lookup and the receipt write are injected: nothing reaches the DB or network.
 */

const {
  adviseSurfaceAudit,
  adviceCacheKey,
  buildAdviceState,
  composeAdvice,
  cachedSurfaceAuditAdvice,
  ADVICE_MIN_CONFIDENCE,
  ADVICE_MAX_FILES,
  ADVICE_TIMEOUT_MS,
  SURFACE_AUDIT_ADVICE_CAPABILITY,
} = await import('./surface-audit-advice');
const { SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH } = await import('@buildd/core/surface-audit');
const { INFERENCE_CAPABILITIES, isInferenceAllowed } = await import('@buildd/core/inference-policy');

const INPUT = {
  missionId: 'mission-1',
  teamId: 'team-1',
  workspaceId: 'ws-1',
  accountId: 'acct-1',
  userId: 'user-1',
  uiPaths: ['apps/web/src/app/app/(protected)/missions/[id]/Sheet.tsx', 'apps/web/src/app/app/(protected)/missions/[id]/page.tsx', 'apps/web/src/components/Nav.tsx'],
  workTitles: ['Reword the decision sheet'],
  prNumbers: [12, 7],
};

function okResult(choice: string, confidence = 0.92) {
  return {
    ok: true as const,
    answers: { pick: { type: 'choice' as const, choice, confidence, probabilities: { [choice]: confidence } } },
    model: 'typesafe/jev-1.13-20260917',
    usage: { inputTokens: 300, outputTokens: 20, costUsd: 0.00002 },
    latencyMs: 180,
    attempts: 1,
  };
}

const receipt = { decisionId: 'surface_audit_advice', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.00002, latencyMs: 1 } as any;

function harness(result: unknown, opts: { access?: unknown; throws?: boolean } = {}) {
  const calls: any[] = [];
  const receipts: any[] = [];
  const logs: string[] = [];
  const cache = new Map();
  const decide = async (params: any) => {
    calls.push(params);
    if (opts.throws) throw new Error('boom');
    params.onUsage?.(receipt);
    return result as any;
  };
  return {
    calls, receipts, logs, cache,
    deps: {
      decide: decide as any,
      resolveAccess: (async () => opts.access ?? { ok: true, apiKey: 'k', model: 'typesafe/jev-1.13-20260917' }) as any,
      recordReceipt: async (r: any, scope: any) => { receipts.push({ r, scope }); },
      cache,
      log: (l: string) => logs.push(l),
    },
  };
}

describe('capability', () => {
  it('is built in: no per-team switch, runs whenever a key resolves', () => {
    expect(INFERENCE_CAPABILITIES.surface_audit_advice.kind).toBe('built_in');
    expect(isInferenceAllowed('surface_audit_advice', {})).toBe(true);
  });
});

describe('buildAdviceState', () => {
  it('sends paths and work titles only, capped', () => {
    const many = Array.from({ length: ADVICE_MAX_FILES + 15 }, (_, i) => `apps/web/src/c/File${i}.tsx`);
    const state = buildAdviceState({ uiPaths: many, workTitles: ['a'] });
    expect(state.mission.changedUiFileCount).toBe(many.length);
    expect(state.mission.changedUiFiles).toHaveLength(ADVICE_MAX_FILES);
    expect(Object.keys(state.mission).sort()).toEqual(['changedUiFileCount', 'changedUiFiles', 'shippedWork']);
  });
});

describe('adviceCacheKey', () => {
  it('is stable across order and duplicates, and moves when the merged set does', () => {
    expect(adviceCacheKey('m', [3, 1, 2])).toBe(adviceCacheKey('m', [2, 3, 1, 1]));
    expect(adviceCacheKey('m', [1, 2])).not.toBe(adviceCacheKey('m', [1, 2, 3]));
    expect(adviceCacheKey('m', [1])).not.toBe(adviceCacheKey('n', [1]));
  });
});

describe('composeAdvice', () => {
  it('audit: one plain sentence, no draft', () => {
    const a = composeAdvice('audit', INPUT);
    expect(a.recommend).toBe('audit');
    expect(a.why).toContain('3 UI files');
    expect(a.why).toContain('missions');
    expect(a.waiverDraft).toBeUndefined();
  });

  it('waive: a draft that clears the API minimum and names the work', () => {
    const a = composeAdvice('waive', INPUT);
    expect(a.recommend).toBe('waive');
    expect(a.waiverDraft!.trim().length).toBeGreaterThanOrEqual(SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH);
    expect(a.waiverDraft).toContain('Reword the decision sheet');
  });

  it('waive without a work title still drafts a reason', () => {
    expect(composeAdvice('waive', { ...INPUT, workTitles: [] }).waiverDraft).toContain('3 UI files');
  });
});

describe('adviseSurfaceAudit', () => {
  it('returns the model\'s pick with a composed reason, and asks within the deadline', async () => {
    const h = harness(okResult('waive'));
    const out = await adviseSurfaceAudit(INPUT, h.deps);
    expect(out?.recommend).toBe('waive');
    expect(out?.waiverDraft).toBeDefined();
    expect(h.calls[0].capability).toBe(SURFACE_AUDIT_ADVICE_CAPABILITY);
    expect(h.calls[0].timeoutMs).toBe(ADVICE_TIMEOUT_MS);
    expect(h.calls[0].decisionId).toBe('surface_audit_advice');
    expect(h.calls[0].state.mission.shippedWork).toEqual(['Reword the decision sheet']);
  });

  it('records the spend like other decision calls, scoped to the team', async () => {
    const h = harness(okResult('audit'));
    await adviseSurfaceAudit(INPUT, h.deps);
    expect(h.receipts).toEqual([{ r: receipt, scope: { teamId: 'team-1', accountId: 'acct-1' } }]);
  });

  it('logs ids, labels and numbers only', async () => {
    const h = harness(okResult('audit'));
    await adviseSurfaceAudit(INPUT, h.deps);
    const line = h.logs.join('\n');
    expect(line).toContain('"pick":"audit"');
    expect(line).not.toContain('Reword the decision sheet');
    expect(line).not.toContain('Sheet.tsx');
  });

  it('caches per mission and merged set: a second ask spends nothing', async () => {
    const h = harness(okResult('audit'));
    const first = await adviseSurfaceAudit(INPUT, h.deps);
    const second = await adviseSurfaceAudit({ ...INPUT, prNumbers: [7, 12] }, h.deps);
    expect(second).toEqual(first);
    expect(h.calls).toHaveLength(1);
    expect(cachedSurfaceAuditAdvice('mission-1', [12, 7], h.cache)).toEqual(first);
  });

  it('asks again when another PR merges', async () => {
    const h = harness(okResult('audit'));
    await adviseSurfaceAudit(INPUT, h.deps);
    await adviseSurfaceAudit({ ...INPUT, prNumbers: [12, 7, 30] }, h.deps);
    expect(h.calls).toHaveLength(2);
  });

  it('gives no suggestion under the confidence gate, and does not cache it', async () => {
    const h = harness(okResult('waive', ADVICE_MIN_CONFIDENCE - 0.01));
    expect(await adviseSurfaceAudit(INPUT, h.deps)).toBeNull();
    expect(h.cache.size).toBe(0);
    expect(h.logs.join('\n')).toContain('"shown":false');
  });

  it('gives no suggestion on a decision error', async () => {
    const h = harness({ ok: false, error: { kind: 'timeout' }, latencyMs: 4000, attempts: 1 });
    expect(await adviseSurfaceAudit(INPUT, h.deps)).toBeNull();
    expect(h.cache.size).toBe(0);
  });

  it('gives no suggestion, and never calls the model, without a key or with the capability off', async () => {
    const h = harness(okResult('audit'), { access: { ok: false, error: { kind: 'missing_key' } } });
    expect(await adviseSurfaceAudit(INPUT, h.deps)).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it('never sends a sensitive workspace\'s content out', async () => {
    const h = harness(okResult('audit'));
    expect(await adviseSurfaceAudit({ ...INPUT, dataClass: 'sensitive' }, h.deps)).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it('has nothing to ask about without changed UI files', async () => {
    const h = harness(okResult('audit'));
    expect(await adviseSurfaceAudit({ ...INPUT, uiPaths: [] }, h.deps)).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it('never throws', async () => {
    const h = harness(null, { throws: true });
    expect(await adviseSurfaceAudit(INPUT, h.deps)).toBeNull();
  });
});
