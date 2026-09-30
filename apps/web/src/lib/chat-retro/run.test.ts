import { describe, expect, it } from 'bun:test';
import type { LessonRow } from './lesson';
import { RETRO_MAX_PER_TEAM_DAY, runChatRetroPass, type PassDeps } from './run';
import type { RetroMessage } from './skeleton';
import type { Cluster } from './proposals';

const U = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const T1 = U(901);
const T2 = U(902);

function busyWindow(base: number) {
  const msgs: RetroMessage[] = [];
  for (let i = 0; i < 4; i++) {
    msgs.push({ id: U(base + i * 2), role: i % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: 'x' }], tier: null, createdAt: new Date(Date.UTC(2026, 0, 1, 10, i)), usage: { inputTokens: 100, outputTokens: 10 } });
  }
  return { messages: msgs, thumbsDown: new Map(), deniedApprovalMessageIds: new Set<string>() };
}

const answer = (choice: string) => ({ type: 'choice', choice, confidence: 0.99, probabilities: {} });

function fakeDeps(over: Partial<PassDeps> = {}) {
  const calls: Record<string, number> = {};
  const count = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; };
  const lessons: LessonRow[] = [];
  const filed: Cluster[] = [];
  const gates: Array<{ outcome: string }> = [];
  const deps: PassDeps = {
    env: {},
    now: () => new Date('2026-09-29T14:00:00Z'),
    deadlineAt: Date.now() + 60_000,
    listOptedInTeams: async () => { count('teams'); return [{ teamId: T1, settings: { lessons: true, proposals: false } }]; },
    listPendingConversations: async (teamId) => { count('pending'); return [1, 2, 3].map(i => ({ id: U(teamId === T1 ? i : 100 + i), workspaceId: U(50), dataClass: null })); },
    loadWindow: async (_t, conv) => busyWindow(Number(conv.slice(-6)) * 10),
    judgedToday: async () => 0,
    decide: async ({ onUsage }) => {
      count('decide');
      onUsage({ kind: 'decision', decisionId: 'chat_retro', provider: 'openrouter', model: 'jev', usage: { inputTokens: 900, outputTokens: 5, costUsd: 0.0001 }, latencyMs: 100, outcome: 'ok' } as never);
      return { ok: true, answers: { satisfied: answer('yes'), intent: answer('explain') } as never, model: 'jev', usage: { inputTokens: 900, outputTokens: 5, costUsd: 0.0001 }, latencyMs: 100, attempts: 1 };
    },
    insertLessons: async rows => { lessons.push(...rows); },
    receipts: async r => { count('receipts'); calls.receiptRows = (calls.receiptRows ?? 0) + r.length; },
    loadClusters: async () => { count('clusters'); return []; },
    proposalsFiledToday: async () => 0,
    priorFiling: async () => null,
    insertProposalTask: async ({ cluster }) => { filed.push(cluster); return 't'; },
    appendToProposal: async () => {},
    gate: e => { gates.push(e); },
    pruneExpiredLessons: async () => { count('prune'); return 0; },
    lessonsUrl: 'https://example.test',
    ...over,
  };
  return { deps, calls, lessons, filed, gates };
}

describe('runChatRetroPass', () => {
  it('kill switch CHAT_RETRO_ENABLED=0: touches nothing at all', async () => {
    const { deps, calls, lessons } = fakeDeps({ env: { CHAT_RETRO_ENABLED: '0' } });
    const r = await runChatRetroPass(deps);
    expect(r.disabled).toBe(true);
    expect(calls).toEqual({});
    expect(lessons).toEqual([]);
  });

  it('judges each opted-in window once and receipts the spend', async () => {
    const { deps, calls, lessons } = fakeDeps();
    const r = await runChatRetroPass(deps);
    expect(r.judged).toBe(3);
    expect(calls.decide).toBe(3);
    expect(calls.receiptRows).toBe(3);
    expect(lessons.every(l => l.teamId === T1 && l.status === 'judged')).toBe(true);
    expect(calls.clusters).toBeUndefined();
  });

  it('only teams the store returns as opted in are looked at, and a team with lessons off is skipped', async () => {
    const { deps, calls } = fakeDeps({ listOptedInTeams: async () => [{ teamId: T2, settings: { lessons: false, proposals: false } }] });
    const r = await runChatRetroPass(deps);
    expect(r.windows).toBe(0);
    expect(calls.pending).toBeUndefined();
  });

  it('over the team cap, windows are skipped with no call', async () => {
    const { deps, calls, lessons } = fakeDeps({ judgedToday: async () => RETRO_MAX_PER_TEAM_DAY - 1 });
    await runChatRetroPass(deps);
    expect(calls.decide).toBe(1);
    expect(lessons.map(l => l.skipReason)).toEqual([null, 'team_cap', 'team_cap']);
  });

  it('sensitive workspaces are never sent to the model', async () => {
    const { deps, calls, lessons } = fakeDeps({ listPendingConversations: async () => [{ id: U(1), workspaceId: U(50), dataClass: 'sensitive' }] });
    await runChatRetroPass(deps);
    expect(calls.decide).toBeUndefined();
    expect(lessons[0].skipReason).toBe('sensitive');
  });

  it('a failed call records a failed lesson (the watermark still advances) and is not retried', async () => {
    const { deps, lessons } = fakeDeps({ decide: async () => ({ ok: false, error: { kind: 'timeout', timeoutMs: 5000 }, latencyMs: 5000, attempts: 2 }) as never });
    const r = await runChatRetroPass(deps);
    expect(r.failed).toBe(3);
    expect(lessons.every(l => l.status === 'failed' && l.error === 'timeout' && l.toMessageId)).toBe(true);
  });

  it('proposals run only for teams that turned them on, and record deferrals in the gate ledger', async () => {
    const c = (tool: string): Cluster => ({
      signature: `chat-retro:over_fetch-ui-${tool}-abcdef`, primaryCause: 'over_fetch', fixClass: 'ui', toolName: tool,
      sessions: 5, days: 3, wastedTokens: 1000, satisfiedYes: 0, satisfiedPartly: 0, satisfiedNo: 5,
      workspaceId: U(50), lessonIds: [], conversationIds: [],
    });
    const { deps, filed, gates } = fakeDeps({
      listOptedInTeams: async () => [{ teamId: T1, settings: { lessons: true, proposals: true } }],
      loadClusters: async () => [c('a'), c('b'), c('c')],
    });
    const r = await runChatRetroPass(deps);
    expect(r.filed).toBe(2);
    expect(filed).toHaveLength(2);
    expect(r.deferred).toBe(1);
    expect(gates.map(g => g.outcome)).toEqual(['deferred']);
  });
});
