import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/decision-client', () => ({
  decisionCall: async () => ({ ok: false, error: { kind: 'capability_disabled' } }),
  gateChoice: (a: any, min: number) => (!a ? { apply: false, reason: 'no_answer' }
    : a.confidence >= min ? { apply: true, label: a.choice, confidence: a.confidence }
    : { apply: false, reason: 'low_confidence', label: a.choice, confidence: a.confidence }),
}));

const { routeTurn, FALLBACK_TIER, workspaceHint, TITLE_TOPIC_QUESTION } = await import('./routing');

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
    expect((await routeTurn(input, { decide: answer(['simple', 0.95], ['act', 0.5]) })).tier).toBe('budget');
    expect((await routeTurn(input, { decide: answer(['complex', 0.95], ['act', 0.5]) })).tier).toBe('premium');
  });

  it('low confidence takes the safe default tier', async () => {
    expect((await routeTurn(input, { decide: answer(['simple', 0.5], ['act', 0.5]) })).tier).toBe('standard');
  });

  it('write tools are withheld only on a confident non-filing intent', async () => {
    expect((await routeTurn(input, { decide: answer(['standard', 0.9], ['needs_tools', 0.95]) })).allowWrites).toBe(false);
    expect((await routeTurn(input, { decide: answer(['standard', 0.9], ['needs_tools', 0.6]) })).allowWrites).toBe(true);
    expect((await routeTurn(input, { decide: answer(['standard', 0.9], ['act', 0.99]) })).allowWrites).toBe(true);
  });

  it('a confident area names one tool group; low confidence or "general" names none', async () => {
    const withArea = (area: [string, number]) => async () => ({
      ok: true as const,
      answers: { complexity: { choice: 'standard', confidence: 0.9 }, intent: { choice: 'act', confidence: 0.95 }, area: { choice: area[0], confidence: area[1] } },
    }) as any;
    expect((await routeTurn(input, { decide: withArea(['schedules', 0.9]) })).area).toBe('schedules');
    // 0.8 gate: 0.79 confidence drops the area routing (narrowing is too risky)
    expect((await routeTurn(input, { decide: withArea(['schedules', 0.79]) })).area).toBeUndefined();
    // Below gate, fallback set (missions + tasks + workers) is used
    expect((await routeTurn(input, { decide: withArea(['schedules', 0.5]) })).area).toBeUndefined();
    expect((await routeTurn(input, { decide: withArea(['general', 0.99]) })).area).toBeUndefined();
    // No area answer at all (an older decision) is the fallback set, not an error.
    expect((await routeTurn(input, { decide: answer(['standard', 0.9], ['act', 0.95]) })).area).toBeUndefined();
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

describe('routeTurn: which workspace (unpinned conversations)', () => {
  const workspaces = [
    { id: 'ws-a', name: 'billing-web', hint: 'repo billing-web · Stripe checkout, invoices' },
    { id: 'ws-b', name: 'docs-site', hint: 'repo docs-site' },
  ];
  const withWs = (choice: string, confidence: number) => {
    const seen: any[] = [];
    const decide = async (p: any) => {
      seen.push(p);
      return {
        ok: true as const,
        answers: {
          complexity: { choice: 'standard', confidence: 0.9 }, intent: { choice: 'act', confidence: 0.95 },
          workspace: { choice, confidence },
        },
      } as any;
    };
    return { decide, seen };
  };

  it('asks a choice over the workspace names, described by their hints', async () => {
    const { decide, seen } = withWs('billing-web', 0.95);
    await routeTurn({ ...input, workspaces }, { decide });
    const q = seen[0].questions.workspace;
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria)).toEqual(['billing-web', 'docs-site']);
    expect(q.criteria['billing-web']).toContain('Stripe checkout');
  });

  it('a confident pick names the workspace id', async () => {
    const { decide } = withWs('billing-web', 0.95);
    expect((await routeTurn({ ...input, workspaces }, { decide })).workspaceId).toBe('ws-a');
  });

  it('low confidence names none (the agent asks, or the tool call names one)', async () => {
    const { decide } = withWs('billing-web', 0.6);
    expect((await routeTurn({ ...input, workspaces }, { decide })).workspaceId).toBeUndefined();
  });

  it('one workspace, or none offered: no question and no pick', async () => {
    const { decide, seen } = withWs('billing-web', 0.99);
    const r = await routeTurn({ ...input, workspaces: [workspaces[0]] }, { decide });
    expect(seen[0].questions.workspace).toBeUndefined();
    expect(r.workspaceId).toBeUndefined();
  });

  it('duplicate names get distinct labels, and each maps back to its own id', async () => {
    const dupes = [{ id: 'ws-a', name: 'web' }, { id: 'ws-b', name: 'web' }];
    const { decide, seen } = withWs('web (ws-b)', 0.95);
    const r = await routeTurn({ ...input, workspaces: dupes }, { decide });
    expect(Object.keys(seen[0].questions.workspace.criteria)).toEqual(['web (ws-a)', 'web (ws-b)']);
    expect(r.workspaceId).toBe('ws-b');
  });
});

describe('workspaceHint', () => {
  it('repo name (never the whole URL) and projects', () => {
    expect(workspaceHint({ repo: 'https://github.com/acme/billing-web.git', projects: [{ name: 'checkout', description: 'Stripe' }, { name: 'invoices' }] }))
      .toBe('repo billing-web · projects: checkout (Stripe); invoices');
    expect(workspaceHint({ repo: 'git@github.com:acme/docs-site' })).toBe('repo docs-site');
    expect(workspaceHint({ repo: null, projects: [] })).toBeNull();
  });
});

describe('routeTurn: title topic (re-title shadow)', () => {
  const withTopic = (topic?: [string, number]) => async (p: any) => {
    asked.push(p);
    return {
      ok: true as const,
      answers: {
        complexity: { choice: 'standard', confidence: 0.9 },
        intent: { choice: 'needs_tools', confidence: 0.5 },
        ...(topic ? { topic: { choice: topic[0], confidence: topic[1] } } : {}),
      },
    } as any;
  };
  let asked: any[] = [];

  it('asks the topic question, with the title in state, only when a title is passed', async () => {
    asked = [];
    await routeTurn(input, { decide: withTopic() });
    expect(asked[0].questions.topic).toBeUndefined();
    expect(asked[0].state.turn.title).toBeUndefined();
    await routeTurn({ ...input, title: 'Release status' }, { decide: withTopic(['new_topic', 0.95]) });
    expect(asked[1].questions.topic).toBe(TITLE_TOPIC_QUESTION);
    expect(asked[1].state.turn.title).toBe('Release status');
  });

  it('returns the answer ungated; absent when not asked or not answered', async () => {
    expect((await routeTurn({ ...input, title: 'T' }, { decide: withTopic(['new_topic', 0.4]) })).topic).toEqual({ label: 'new_topic', confidence: 0.4 });
    expect((await routeTurn({ ...input, title: 'T' }, { decide: withTopic() })).topic).toBeUndefined();
    expect((await routeTurn(input, { decide: withTopic(['new_topic', 0.99]) })).topic).toBeUndefined();
  });
});

