import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/decision-client', () => ({
  decisionCall: async () => ({ ok: false, error: { kind: 'capability_disabled' } }),
  gateChoice: (a: any, min: number) => (!a ? { apply: false, reason: 'no_answer' }
    : a.confidence >= min ? { apply: true, label: a.choice, confidence: a.confidence }
    : { apply: false, reason: 'low_confidence', label: a.choice, confidence: a.confidence }),
}));

const { routeTurn, FALLBACK_TIER, workspaceHint, askTopicQuestion, TITLE_TOPIC_QUESTION, isAcknowledgement, offeredAction, ROUTING_DECISION_ID, logRoutingRecord } = await import('./routing');

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
    expect(await routeTurn(input)).toMatchObject({ tier: 'standard', allowWrites: true, source: 'fallback' });
    expect(FALLBACK_TIER).toBe('standard');
  });

  it('a throwing decision call still falls back', async () => {
    expect(await routeTurn(input, { decide: async () => { throw new Error('boom'); } }))
      .toMatchObject({ tier: 'standard', allowWrites: true, source: 'fallback' });
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

describe('askTopicQuestion', () => {
  const withTopic = (topic?: [string, number]) => async (p: any) => {
    return {
      ok: true as const,
      answers: {
        ...(topic ? { topic: { choice: topic[0], confidence: topic[1] } } : {}),
      },
    } as any;
  };

  it('returns the answer ungated; absent when not answered', async () => {
    expect(await askTopicQuestion(
      { teamId: 't', workspaceId: null, userId: 'u', message: 'test', title: 'T' },
      { decide: withTopic(['new_topic', 0.4]) }
    )).toEqual({ label: 'new_topic', confidence: 0.4 });
    expect(await askTopicQuestion(
      { teamId: 't', workspaceId: null, userId: 'u', message: 'test', title: 'T' },
      { decide: withTopic() }
    )).toBeUndefined();
  });

  it('returns undefined on decision call failure', async () => {
    const throwingDecide = async () => { throw new Error('boom'); };
    expect(await askTopicQuestion(
      { teamId: 't', workspaceId: null, userId: 'u', message: 'test', title: 'T' },
      { decide: throwingDecide }
    )).toBeUndefined();
  });
});

describe('routeTurn: the routing record (content-free)', () => {
  const MESSAGE = 'SECRET-MESSAGE-TEXT please pause checkout';
  const workspaces = [
    { id: 'ws-a', name: 'SECRET-WS-billing', hint: 'SECRET-HINT stripe' },
    { id: 'ws-b', name: 'docs-site', hint: null },
  ];
  const full = { ...input, message: MESSAGE, previous: 'SECRET-PREVIOUS', workspaces };
  const failed = (error: any) => async () => ({ ok: false as const, error, latencyMs: 912, attempts: 1 }) as any;
  const answered = (a: Record<string, [string, number]>) => async () => ({
    ok: true as const,
    answers: Object.fromEntries(Object.entries(a).map(([k, [choice, confidence]]) => [k, { choice, confidence }])),
    usage: { inputTokens: 300, outputTokens: 12, costUsd: 0.0004 },
    latencyMs: 420, attempts: 1,
  }) as any;

  it('a gate applied: outcome decision, with latency, attempts, shape and every answer', async () => {
    const r = await routeTurn(full, { decide: answered({
      complexity: ['simple', 0.95], intent: ['act', 0.95], area: ['tasks', 0.5],
      workspace: ['SECRET-WS-billing', 0.9],
    }) });
    expect(r.routing).toEqual({
      outcome: 'decision', latencyMs: 420, attempts: 1,
      questionCount: 4, workspaceCount: 2,
      answers: {
        complexity: { label: 'simple', confidence: 0.95, applied: true },
        intent: { label: 'act', confidence: 0.95, applied: true },
        area: { label: 'tasks', confidence: 0.5, applied: false },
        workspace: { label: 'ws-a', confidence: 0.9, applied: true },
      },
    });
    expect(r.source).toBe('decision');
  });

  it('answered but nothing cleared a gate: low_confidence, not an error', async () => {
    const r = await routeTurn(input, { decide: answered({ complexity: ['simple', 0.5], intent: ['act', 0.5], area: ['tasks', 0.3] }) });
    expect(r.source).toBe('fallback');
    expect(r.routing).toMatchObject({ outcome: 'low_confidence', questionCount: 3, workspaceCount: 0 });
    expect(r.routing!.answers.complexity).toEqual({ label: 'simple', confidence: 0.5, applied: false });
    expect(r.routing!.answers.workspace).toBeUndefined();
  });

  it('a workspace question the model skipped is recorded as unanswered', async () => {
    const r = await routeTurn({ ...input, workspaces }, { decide: answered({ complexity: ['simple', 0.95], intent: ['act', 0.5] }) });
    expect(r.routing!.answers.workspace).toEqual({ label: null, confidence: null, applied: false });
    expect(r.routing!.answers.area).toEqual({ label: null, confidence: null, applied: false });
  });

  for (const error of [
    { kind: 'timeout', timeoutMs: 900 },
    { kind: 'missing_key' },
    { kind: 'capability_disabled', capability: 'chat' },
    { kind: 'provider_error', status: 502, body: 'upstream said SECRET-MESSAGE-TEXT' },
    { kind: 'rate_limited' },
    { kind: 'transport', message: 'fetch failed' },
    { kind: 'parse', message: 'bad answer' },
  ]) {
    it(`a failed call records error:${error.kind}, its latency and attempts`, async () => {
      const r = await routeTurn(full, { decide: failed(error) });
      expect(r).toMatchObject({ tier: 'standard', allowWrites: true, source: 'fallback' });
      expect(r.routing).toEqual({
        outcome: `error:${error.kind}` as any, latencyMs: 912, attempts: 1,
        questionCount: 4, workspaceCount: 2, answers: {},
      });
    });
  }

  it('a throw records error:threw with the measured latency', async () => {
    let t = 1_000;
    const r = await routeTurn(input, { now: () => t, decide: async () => { t += 37; throw new Error('boom SECRET-MESSAGE-TEXT'); } });
    expect(r.routing).toEqual({ outcome: 'error:threw', latencyMs: 37, attempts: 0, questionCount: 3, workspaceCount: 0, answers: {} });
  });

  it('never carries message, previous, workspace names or hints, whatever the outcome', async () => {
    const outcomes = [
      await routeTurn(full, { decide: answered({ complexity: ['simple', 0.95], intent: ['act', 0.95], area: ['tasks', 0.9], workspace: ['SECRET-WS-billing', 0.99] }) }),
      await routeTurn(full, { decide: answered({ complexity: ['simple', 0.1], intent: ['act', 0.1], workspace: ['SECRET-WS-billing', 0.1] }) }),
      await routeTurn(full, { decide: failed({ kind: 'provider_error', status: 500, body: 'SECRET-MESSAGE-TEXT' }) }),
      await routeTurn(full, { decide: async () => { throw new Error('SECRET-MESSAGE-TEXT'); } }),
    ];
    for (const r of outcomes) expect(JSON.stringify(r.routing)).not.toContain('SECRET');
    const lines: string[] = [];
    logRoutingRecord(outcomes[0].routing!, l => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('[chat-routing] {')).toBe(true);
    expect(lines[0]).not.toContain('SECRET');
  });

  it('asks the decision call for a receipt, stamped chat_routing', async () => {
    const seen: any[] = [];
    const onUsage = () => {};
    await routeTurn(input, { onUsage, decide: async (p: any) => { seen.push(p); return { ok: false, error: { kind: 'timeout', timeoutMs: 900 }, latencyMs: 900, attempts: 1 } as any; } });
    expect(seen[0].decisionId).toBe(ROUTING_DECISION_ID);
    expect(ROUTING_DECISION_ID).toBe('chat_routing');
    expect(seen[0].onUsage).toBe(onUsage);
  });
});

describe('routeTurn: acknowledgements skip the routing call', () => {
  const never = async () => { throw new Error('the routing call must not run'); };

  it('recognises a whole-message thanks / ok / greeting / emoji, and nothing longer', () => {
    for (const m of ['thanks', 'Thank you!', 'ok', 'OK.', 'okay thanks', 'hi', 'hey', 'good morning', '👍', 'ok 👍', 'great, thanks!', 'yes', 'sounds good']) {
      expect(isAcknowledgement(m)).toBe(true);
    }
    for (const m of ['thanks, now pause checkout', 'ok what failed?', 'hi, what is running', 'yes create the mission', '', 'status?']) {
      expect(isAcknowledgement(m)).toBe(false);
    }
    expect(isAcknowledgement('thanks '.repeat(10))).toBe(false); // over the length cap
  });

  it('routes an acknowledgement as budget tier with the fallback groups, no call', async () => {
    const route = await routeTurn({ ...input, message: 'thanks!' }, { decide: never });
    expect(route).toEqual({ tier: 'budget', allowWrites: false, source: 'fallback' });
    expect(route.area).toBeUndefined();
  });

  it('keeps the write tools only when the previous turn offered to do something', async () => {
    expect((await routeTurn({ ...input, message: 'ok', previous: 'Want me to file this as a mission?' }, { decide: never })).allowWrites).toBe(true);
    expect((await routeTurn({ ...input, message: 'yes', previous: 'I can pause checkout for you.' }, { decide: never })).allowWrites).toBe(true);
    expect((await routeTurn({ ...input, message: 'ok', previous: 'Checkout shipped in PR 12.' }, { decide: never })).allowWrites).toBe(false);
  });

  it('offeredAction: a closing question or an offer phrase', () => {
    expect(offeredAction('Shall I retry it?')).toBe(true);
    expect(offeredAction('Should I cancel it? It has been stuck for a day.')).toBe(true);
    expect(offeredAction('Three tasks are running.')).toBe(false);
    expect(offeredAction(null)).toBe(false);
  });
});

describe('routeTurn: a pinned tier', () => {
  it('does not ask the complexity question, whose answer would be overwritten', async () => {
    const seen: any[] = [];
    const decide = async (p: any) => {
      seen.push(p);
      return { ok: true as const, answers: { intent: { choice: 'needs_tools', confidence: 0.95 }, area: { choice: 'tasks', confidence: 0.9 } } } as any;
    };
    const route = await routeTurn({ ...input, tierPinned: true }, { decide });
    expect(Object.keys(seen[0].questions)).toEqual(['intent', 'area']);
    expect(route).toMatchObject({ tier: FALLBACK_TIER, allowWrites: false, area: 'tasks', source: 'decision' });
    expect(route.routing!.questionCount).toBe(2);
  });

  it('still asks it when the tier is not pinned', async () => {
    const seen: any[] = [];
    await routeTurn(input, { decide: async (p: any) => { seen.push(p); return { ok: false, error: { kind: 'timeout' } } as any; } });
    expect(Object.keys(seen[0].questions)).toEqual(['complexity', 'intent', 'area']);
  });
});

describe('routeTurn: the decision key resolved ahead', () => {
  it('hands the pre-resolved access to the decision call', async () => {
    const access = Promise.resolve({ ok: true as const, apiKey: 'sk', model: 'm' });
    const seen: any[] = [];
    await routeTurn({ ...input, access }, { decide: async (p: any) => { seen.push(p); return { ok: false, error: { kind: 'timeout' } } as any; } });
    expect(seen[0].access).toBe(access);
    expect(seen[0].timeoutMs).toBe(900);
  });
});
