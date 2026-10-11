/**
 * Shared DOM-test fixtures for Settings → Model tiers. Every number here is
 * illustrative, not observed.
 */
import type { ModelPolicyCell, ModelPolicyCellsResponse } from '@buildd/shared';

const T = (iso: string) => Date.parse(iso) / 1000;
export const MODELS = [
  { id: 'claude-opus-5', displayName: 'Claude Opus 5', provider: 'anthropic', vendor: 'anthropic', inputPrice: 5, outputPrice: 25, contextLength: 1_000_000, created: T('2026-07-01') },
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', provider: 'anthropic', openRouterId: 'anthropic/claude-sonnet-5', vendor: 'anthropic', inputPrice: 2, outputPrice: 10, contextLength: 1_000_000, created: T('2026-06-30') },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', provider: 'anthropic', vendor: 'anthropic', inputPrice: 1, outputPrice: 5, contextLength: 200_000, created: T('2025-10-01') },
  { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', provider: 'other', openRouterId: 'deepseek/deepseek-v4-pro', vendor: 'deepseek', inputPrice: 1.6, outputPrice: 3.2, contextLength: 1_000_000, created: T('2026-08-10') },
];

const base = { alternates: [], dial: 3 as const, source: 'team' as const, overrideCount: 0, poolId: null, whatRan: [] };
const cell = (c: Partial<ModelPolicyCell> & Pick<ModelPolicyCell, 'tier' | 'surface' | 'state'>): ModelPolicyCell => ({
  primary: { provider: 'anthropic', model: 'claude-sonnet-5' }, ...base, ...c,
});

export const CELLS: ModelPolicyCell[] = [
  cell({ tier: 'premium-plus', surface: 'agent', state: 'always', source: 'default', primary: { provider: 'anthropic', model: 'claude-opus-5' } }),
  cell({
    tier: 'premium', surface: 'agent', state: 'learning', poolId: 'pool-prem',
    primary: { provider: 'anthropic', model: 'claude-opus-5' },
    alternates: [{ provider: 'runner:claude', model: 'claude-sonnet-5' }],
    progress: { graded: 12, threshold: 40, primaryGraded: 55, candidate: 'claude-sonnet-5', etaDays: 9 },
  }),
  cell({
    tier: 'standard', surface: 'agent', state: 'shifted', poolId: 'pool-std', share: 0.5, shiftedTo: 'deepseek/deepseek-v4-pro',
    alternates: [{ provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' }],
    whatRan: [
      { model: 'claude-sonnet-5', share: 0.6, runs: 30, mergedRate: 0.8, reviewOkRate: 0.7, mergedGraded: 25, reviewOkGraded: 20, costPerRunUsd: 0.42,
        recentRuns: [{ taskId: 'task-a', title: 'Add retry to webhook sender', at: '2026-10-01T10:00:00Z', merged: true, reviewOk: true }] },
      { model: 'deepseek/deepseek-v4-pro', share: 0.4, runs: 20, mergedRate: 0.75, reviewOkRate: 0.65, mergedGraded: 4, reviewOkGraded: 0, costPerRunUsd: 0.12,
        recentRuns: [{ taskId: 'task-b', title: 'Fix flaky date test', at: '2026-10-02T10:00:00Z', merged: false, reviewOk: null }] },
    ],
  }),
  cell({
    tier: 'budget', surface: 'agent', state: 'reverted', poolId: 'pool-bud', experimentRunning: true,
    primary: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    alternates: [{ provider: 'openrouter', model: 'qwen/qwen3-coder' }],
    revertedFrom: 'qwen/qwen3-coder', revertReason: 'merged rate 40% vs primary 75% over 30 runs (tolerance 5 points)',
  }),
  cell({ tier: 'premium-plus', surface: 'chat', state: 'always', primary: { provider: 'anthropic', model: 'claude-opus-5' } }),
  cell({
    tier: 'premium', surface: 'chat', state: 'learning', poolId: 'pool-chat-prem',
    primary: { provider: 'anthropic', model: 'claude-opus-5' },
    alternates: [{ provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' }],
    whatRan: [
      { model: 'claude-opus-5', share: 1, runs: 10, mergedRate: null, reviewOkRate: null, mergedGraded: 0, reviewOkGraded: 0, costPerRunUsd: 0.05,
        satisfiedRate: 0.9, thumbsUp: 9, thumbsDown: 1, reaskedRate: 0.1, recentRuns: [] },
    ],
  }),
  cell({ tier: 'standard', surface: 'chat', state: 'always', overrideCount: 2 }),
  cell({ tier: 'budget', surface: 'chat', state: 'always', source: 'service', primary: { provider: 'anthropic', model: 'claude-haiku-4-5' } }),
];

export const CELLS_BODY: ModelPolicyCellsResponse & { isAdmin: boolean } = {
  teamId: 'team-demo', generatedAt: '2026-10-05T00:00:00Z', windowDays: 30, cells: CELLS, overrideWorkspaces: 2, isAdmin: true,
};

const arm = (id: string | null, route: string, model: string, role: 'incumbent' | 'challenger') =>
  ({ id, route, model, role, status: 'active', share: role === 'incumbent' ? 1 : 0, weight: 'high', stats: null });

export const POOLS_BODY = {
  isAdmin: true,
  rows: [
    { tier: 'premium', surface: 'agent', poolId: 'pool-prem', mode: 'dial', locked: false, allocationVersion: 7, incumbentFloor: 0.6, explorationCap: 0.3, minGraded: 30, lastChange: null,
      arms: [arm('arm-opus', 'runner:claude', 'claude-opus-5', 'incumbent'), arm('arm-sonnet', 'runner:claude', 'claude-sonnet-5', 'challenger')] },
  ],
};
