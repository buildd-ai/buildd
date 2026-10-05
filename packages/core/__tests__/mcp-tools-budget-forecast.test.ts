import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WS = '00000000-0000-0000-0000-000000000001';

function ctx(): ActionContext {
  return {
    workspaceId: WS,
    workerId: '00000000-0000-0000-0000-000000000002',
    authType: 'oauth',
    getWorkspaceId: async () => WS,
    getLevel: async () => 'admin',
  };
}

const FAR = '2099-01-01T00:00:00.000Z';

async function forecastText(forecast: Record<string, unknown>): Promise<string> {
  const api = mock(async () => ({
    forecast: { oauthSessions: [], monthly: null, codex: null, claudeTenant: null, missions: [], ...forecast },
  }));
  const res = await handleBuilddAction(api as unknown as ApiFn, 'get_budget_forecast', {}, ctx());
  expect(res.isError).toBeFalsy();
  return res.content[0].text as string;
}

describe('get_budget_forecast', () => {
  it('labels monthly and mission spend as estimates', async () => {
    const out = await forecastText({
      monthly: {
        kind: 'monthly', spentUsd: 12.5, budgetUsd: 100, pctUsed: 13,
        resetsAt: FAR, burnRateUsdPerDay: 3, daysToDepletion: null, confidence: 'high',
      },
      missions: [{ missionId: 'm1', missionTitle: 'M', spentUsd: 2, budgetUsd: 10, pctUsed: 20, status: 'active' }],
    });
    expect(out).toContain('Monthly budget: $12.50 est. / $100');
    expect(out).toContain('Mission "M": $2.00 est. / $10.00');
  });

  it('reports a Dispatch-tenant wall as Claude, not Codex', async () => {
    const out = await forecastText({
      claudeTenant: { kind: 'claude_tenant', isExhausted: true, resetsAt: FAR, exhaustedAt: null },
    });
    expect(out).toContain('Claude tenant budget: exhausted');
    expect(out).not.toContain('Codex');
  });

  it('reports a Codex pause on the Codex line', async () => {
    const out = await forecastText({
      codex: { kind: 'codex', isExhausted: true, reason: 'budget', resetsAt: FAR, exhaustedAt: null },
    });
    expect(out).toContain('Codex budget: exhausted');
    expect(out).not.toContain('Claude tenant');
  });

  it('labels a rejected Codex credential as a credential, not a budget', async () => {
    const out = await forecastText({
      codex: { kind: 'codex', isExhausted: true, reason: 'auth', resetsAt: FAR, exhaustedAt: null },
    });
    expect(out).toContain('Codex credential: rejected');
    expect(out).not.toContain('Codex budget');
  });
});

it('learned OAuth pressure is labeled as a forecast with evidence, never percent used', async () => {
  const out = await forecastText({oauthSessions: [{
    accountName: 'Test seat', pressurePct: 100, state: 'active', windowEndsAt: FAR,
    episodes: 5, confidence: 'high', limiter: 'turns', observationAgeMs: 3600000,
    source: 'learned_exhaustion_floor', sampleBasis: {quantile: 0.25},
  }]});
  expect(out).not.toContain('% used');
  expect(out).toContain('100% forecast floor pressure');
  expect(out).toContain('5 episodes');
  expect(out).toContain('observation age: 60m');
  expect(out).toContain('provider usage: unknown');
});

it('labels expired observations unknown rather than asking for already available samples', async () => {
  const out = await forecastText({oauthSessions: [{
    accountName: 'Test seat', pressurePct: 0, state: 'learning', episodes: 5, confidence: null,
  }]});
  expect(out).toContain('unknown');
  expect(out).toContain('inert');
  expect(out).not.toContain('need 3+');
});
