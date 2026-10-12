import { describe, expect, it } from 'bun:test';
import {
  DECISION_HEALTH_MIN_CALLS,
  DECISION_HEALTH_WINDOW_MS,
  decisionHealthItem,
  decisionHealthVerdict,
  loadDecisionHealthNeedsYou,
  providerErrorFromReason,
  type DecisionHealthDeps,
} from './decision-health-needs-you';
import { buildActionQueue } from './action-queue';
import { resolveQueueAttention } from './home-attention';

/**
 * A team's decisions all failing at the provider is one Home card for the
 * people who can fix the setting, not silence and not a push per call.
 * Synthetic fixtures: no real team, token or account.
 */

const TEAM = '00000000-0000-4000-8000-0000000000aa';
const CLEF = { endpoint: 'systemone', model: 'clef', via: 'cloudflare' };
const CF_401 = 'HTTP 401: {"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}';

describe('decisionHealthVerdict', () => {
  it('is failing at >= 90% provider_error with enough calls', () => {
    const v = decisionHealthVerdict({ calls: 40, providerErrors: 38, lastError: CF_401 }, CLEF);
    expect(v).not.toBeNull();
    expect(v!.title).toBe('Decisions are failing: Cloudflare rejected the token');
    expect(v!.sentence).toContain('38 of 40 decisions in the last 30 minutes fell back to the rule.');
    expect(v!.sentence).toContain('Cloudflare said: HTTP 401: Authentication error (code 10000)');
  });

  it('is quiet below 90%, and on too few calls to tell', () => {
    expect(decisionHealthVerdict({ calls: 40, providerErrors: 35, lastError: CF_401 }, CLEF)).toBeNull();
    expect(decisionHealthVerdict({ calls: DECISION_HEALTH_MIN_CALLS - 1, providerErrors: DECISION_HEALTH_MIN_CALLS - 1, lastError: CF_401 }, CLEF)).toBeNull();
    expect(decisionHealthVerdict({ calls: 0, providerErrors: 0, lastError: null }, CLEF)).toBeNull();
  });

  it('names the provider the team chose, and a non-auth failure as errors', () => {
    expect(decisionHealthVerdict({ calls: 10, providerErrors: 10, lastError: 'HTTP 401: Invalid API key' }, null)!.title)
      .toBe('Decisions are failing: OpenRouter rejected the key');
    expect(decisionHealthVerdict({ calls: 10, providerErrors: 10, lastError: 'HTTP 503: upstream' }, { endpoint: 'chat', model: 'q', via: 'litellm' })!.title)
      .toBe('Decisions are failing: the LiteLLM gateway is returning errors');
  });
});

describe('providerErrorFromReason', () => {
  it("reads the excerpt a decision kind's ledger row carries", () => {
    expect(providerErrorFromReason('fallback:fallback_provider_failure; cause=provider_failure; chain=cheap; provider_error=HTTP 401: Authentication error')).toBe('HTTP 401: Authentication error');
    expect(providerErrorFromReason('provider_error')).toBeNull();
    expect(providerErrorFromReason(null)).toBeNull();
  });
});

describe('the Home card', () => {
  it('reaches Needs you as one card that links to the decision model setting', () => {
    const verdict = decisionHealthVerdict({ calls: 12, providerErrors: 12, lastError: CF_401 }, CLEF)!;
    const raw = decisionHealthItem(TEAM, verdict);
    const queue = buildActionQueue([raw, raw], []);
    expect(queue).toHaveLength(1);
    const card = resolveQueueAttention(queue[0]);
    expect(card).toMatchObject({
      title: 'Decisions are failing: Cloudflare rejected the token',
      href: '/app/settings/models#routing',
      tone: 'error',
    });
    expect(card!.sentence).toContain('fell back to the rule');
  });
});

describe('loadDecisionHealthNeedsYou', () => {
  const failing: DecisionHealthDeps = {
    teamsOf: async () => [TEAM],
    canManage: async () => true,
    readCounts: async () => ({ calls: 20, providerErrors: 20, lastError: CF_401 }),
    readDecisionModel: async () => CLEF,
    now: () => 1_000_000_000_000,
  };

  it('raises one item per failing team for a team admin, over the last 30 minutes', async () => {
    let since: Date | null = null;
    const items = await loadDecisionHealthNeedsYou('user-1', ['ws-1', 'ws-2'], {
      ...failing,
      readCounts: async (_t, s) => { since = s; return { calls: 20, providerErrors: 20, lastError: CF_401 }; },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'incident', fixHref: '/app/settings/models#routing' });
    expect(since!.getTime()).toBe(1_000_000_000_000 - DECISION_HEALTH_WINDOW_MS);
  });

  it('shows nothing to a person who cannot change the setting', async () => {
    expect(await loadDecisionHealthNeedsYou('user-1', ['ws-1'], { ...failing, canManage: async () => false })).toEqual([]);
  });

  it('shows nothing with no viewer or no workspaces, and never throws', async () => {
    expect(await loadDecisionHealthNeedsYou(null, ['ws-1'], failing)).toEqual([]);
    expect(await loadDecisionHealthNeedsYou('user-1', [], failing)).toEqual([]);
    expect(await loadDecisionHealthNeedsYou('user-1', ['ws-1'], { ...failing, readCounts: async () => { throw new Error('db down'); } })).toEqual([]);
  });
});
