import { describe, it, expect } from 'bun:test';
import { dispatchEarlyRelease, resolveEarlyReleaseMode, type EarlyReleaseDispatchDeps } from './early-release-dispatch';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';

const BASE_INPUT = {
  workspaceId: 'ws-1',
  teamId: 'team-1',
  upstreamTaskId: 'upstream-1',
  upstreamPrNumber: 42,
  upstreamBranch: 'buildd/upstream-1-feat',
  repoFullName: 'acme/widgets',
  installationId: 1,
};

function gitConfig(mode?: 'off' | 'rule_only' | 'rule_and_jev'): WorkspaceGitConfig {
  return { earlyRelease: mode ? { mode } : undefined } as WorkspaceGitConfig;
}

function neverCalled(name: string) {
  return async (...args: unknown[]) => {
    throw new Error(`${name} should not have been called, got ${JSON.stringify(args)}`);
  };
}

function harness(overrides: Partial<EarlyReleaseDispatchDeps> = {}) {
  const inserted: unknown[] = [];
  const recorded: unknown[] = [];
  const deps: EarlyReleaseDispatchDeps = {
    findPendingDependents: async () => [{ id: 'dep-1', title: 'Dependent task', pathManifest: ['apps/web/src/lib/foo.ts'] }],
    getUpstreamDiffFiles: async () => ['apps/web/src/lib/foo.ts'],
    insertRelease: async (row) => { inserted.push(row); },
    record: async (row) => { recorded.push(row); return 'ledger-1'; },
    estimateSize: async () => null,
    ...overrides,
  };
  return { deps, inserted, recorded };
}

describe('resolveEarlyReleaseMode', () => {
  it('defaults to off for an absent, missing or unrecognized mode', () => {
    expect(resolveEarlyReleaseMode(undefined)).toBe('off');
    expect(resolveEarlyReleaseMode({} as WorkspaceGitConfig)).toBe('off');
    expect(resolveEarlyReleaseMode(gitConfig('off'))).toBe('off');
    expect(resolveEarlyReleaseMode({ earlyRelease: { mode: 'bogus' as never } } as WorkspaceGitConfig)).toBe('off');
  });

  it('reads rule_only and rule_and_jev through', () => {
    expect(resolveEarlyReleaseMode(gitConfig('rule_only'))).toBe('rule_only');
    expect(resolveEarlyReleaseMode(gitConfig('rule_and_jev'))).toBe('rule_and_jev');
  });
});

describe('dispatchEarlyRelease: off is a true no-op', () => {
  it('writes nothing and never looks up dependents, the diff, or a decision — for an absent or explicit off', async () => {
    for (const cfg of [undefined, gitConfig('off')]) {
      const { deps, inserted, recorded } = harness({
        findPendingDependents: neverCalled('findPendingDependents'),
        getUpstreamDiffFiles: neverCalled('getUpstreamDiffFiles'),
        insertRelease: neverCalled('insertRelease'),
        record: neverCalled('record'),
      });
      const result = await dispatchEarlyRelease({ ...BASE_INPUT, gitConfig: cfg }, deps);
      expect(result).toEqual({ mode: 'off', releases: [] });
      expect(inserted).toHaveLength(0);
      expect(recorded).toHaveLength(0);
    }
  });
});

describe('dispatchEarlyRelease: rule_only', () => {
  it('skips the model call entirely when no rule fires, and still writes a wait row', async () => {
    const { deps, inserted, recorded } = harness({
      // Overlapping, non-doc upstream diff: neither docsOnlyUpstream nor
      // zeroManifestOverlap fires, and the dependent is pending (no PR yet) so
      // terminalApproveGreenCi never can either.
      getUpstreamDiffFiles: async () => ['apps/web/src/lib/foo.ts'],
      decisionDeps: { call: neverCalled('decide (the Jev transport)'), resolveAccess: neverCalled('resolveAccess') } as never,
    });
    const result = await dispatchEarlyRelease({ ...BASE_INPUT, gitConfig: gitConfig('rule_only') }, deps);
    expect(result.releases).toEqual([{ dependentTaskId: 'dep-1', decision: 'wait', source: 'fallback', reasonCode: 'fallback_disabled' }]);
    expect(inserted).toEqual([{
      dependentTaskId: 'dep-1', upstreamTaskId: 'upstream-1', upstreamPrNumber: 42,
      decision: 'wait', source: 'fallback', reasonCode: 'fallback_disabled', baseBranch: null,
    }]);
    expect(recorded).toHaveLength(1);
  });

  it('a fired Layer 1 rule writes a start_now row without ever needing a model', async () => {
    const { deps, inserted } = harness({
      getUpstreamDiffFiles: async () => ['docs/readme.md'],
      decisionDeps: { call: neverCalled('decide'), resolveAccess: neverCalled('resolveAccess') } as never,
    });
    const result = await dispatchEarlyRelease({ ...BASE_INPUT, gitConfig: gitConfig('rule_only') }, deps);
    expect(result.releases).toEqual([{ dependentTaskId: 'dep-1', decision: 'start_now', source: 'rule', reasonCode: 'docs_only' }]);
    expect(inserted[0]).toMatchObject({ decision: 'start_now', source: 'rule', reasonCode: 'docs_only', baseBranch: null });
  });
});

describe('dispatchEarlyRelease: rule_and_jev', () => {
  it('a fired rule still short-circuits the model in rule_and_jev mode', async () => {
    const { deps, inserted } = harness({
      getUpstreamDiffFiles: async () => ['docs/readme.md'],
      decisionDeps: { call: neverCalled('decide'), resolveAccess: neverCalled('resolveAccess') } as never,
    });
    const result = await dispatchEarlyRelease({ ...BASE_INPUT, gitConfig: gitConfig('rule_and_jev') }, deps);
    expect(result.releases).toEqual([{ dependentTaskId: 'dep-1', decision: 'start_now', source: 'rule', reasonCode: 'docs_only' }]);
    expect(inserted[0]).toMatchObject({ decision: 'start_now', source: 'rule' });
  });

  it('a failed Jev call writes a wait row rather than nothing', async () => {
    const { deps, inserted, recorded } = harness({
      getUpstreamDiffFiles: async () => ['apps/web/src/lib/foo.ts'],
      decisionDeps: {
        resolveAccess: async () => ({ ok: true, apiKey: 'k', model: 'typesafe/jev-1.13' }),
        call: async () => ({ ok: false, error: { kind: 'timeout', timeoutMs: 5 }, latencyMs: 5, attempts: 1 }),
      } as never,
    });
    const result = await dispatchEarlyRelease({ ...BASE_INPUT, gitConfig: gitConfig('rule_and_jev') }, deps);
    expect(result.releases).toEqual([{ dependentTaskId: 'dep-1', decision: 'wait', source: 'fallback', reasonCode: 'fallback_provider_failure' }]);
    expect(inserted).toEqual([{
      dependentTaskId: 'dep-1', upstreamTaskId: 'upstream-1', upstreamPrNumber: 42,
      decision: 'wait', source: 'fallback', reasonCode: 'fallback_provider_failure', baseBranch: null,
    }]);
    expect(recorded).toHaveLength(1);
  });

  it('a low-confidence Jev answer also writes a wait row, not silently nothing', async () => {
    const { deps, inserted } = harness({
      getUpstreamDiffFiles: async () => ['apps/web/src/lib/foo.ts'],
      decisionDeps: {
        resolveAccess: async () => ({ ok: true, apiKey: 'k', model: 'typesafe/jev-1.13' }),
        call: async () => ({
          ok: true,
          answers: { release: { type: 'choice', choice: 'start_now', confidence: 0.4, probabilities: { start_now: 0.4, wait: 0.3, start_stacked: 0.3 } } },
          model: 'typesafe/jev-1.13',
          usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
          latencyMs: 1,
          attempts: 1,
        }),
      } as never,
    });
    const result = await dispatchEarlyRelease({ ...BASE_INPUT, gitConfig: gitConfig('rule_and_jev') }, deps);
    expect(result.releases).toEqual([{ dependentTaskId: 'dep-1', decision: 'wait', source: 'fallback', reasonCode: 'fallback_low_confidence' }]);
    expect(inserted[0]).toMatchObject({ decision: 'wait', source: 'fallback' });
  });

  it('a confident Jev answer applies and stamps baseBranch for start_stacked', async () => {
    const { deps, inserted } = harness({
      getUpstreamDiffFiles: async () => ['apps/web/src/lib/foo.ts'],
      decisionDeps: {
        resolveAccess: async () => ({ ok: true, apiKey: 'k', model: 'typesafe/jev-1.13' }),
        call: async () => ({
          ok: true,
          answers: { release: { type: 'choice', choice: 'start_stacked', confidence: 0.95, probabilities: { start_now: 0.02, wait: 0.03, start_stacked: 0.95 } } },
          model: 'typesafe/jev-1.13',
          usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
          latencyMs: 1,
          attempts: 1,
        }),
      } as never,
    });
    const result = await dispatchEarlyRelease({ ...BASE_INPUT, gitConfig: gitConfig('rule_and_jev') }, deps);
    expect(result.releases).toEqual([{ dependentTaskId: 'dep-1', decision: 'start_stacked', source: 'model', reasonCode: 'model_start_stacked' }]);
    expect(inserted[0]).toMatchObject({ decision: 'start_stacked', baseBranch: BASE_INPUT.upstreamBranch });
  });
});

describe('dispatchEarlyRelease: no pending dependents or an unreadable diff', () => {
  it('writes nothing when there are no pending dependents', async () => {
    const { deps, inserted } = harness({
      findPendingDependents: async () => [],
      getUpstreamDiffFiles: neverCalled('getUpstreamDiffFiles'),
    });
    const result = await dispatchEarlyRelease({ ...BASE_INPUT, gitConfig: gitConfig('rule_only') }, deps);
    expect(result).toEqual({ mode: 'rule_only', releases: [] });
    expect(inserted).toHaveLength(0);
  });

  it('writes nothing when the upstream diff cannot be read completely', async () => {
    const { deps, inserted } = harness({ getUpstreamDiffFiles: async () => null });
    const result = await dispatchEarlyRelease({ ...BASE_INPUT, gitConfig: gitConfig('rule_only') }, deps);
    expect(result).toEqual({ mode: 'rule_only', releases: [] });
    expect(inserted).toHaveLength(0);
  });
});
