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
