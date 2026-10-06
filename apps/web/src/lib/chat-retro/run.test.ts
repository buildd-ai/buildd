import { describe, expect, it } from 'bun:test';
import type { LessonRow } from './lesson';
import { RETRO_MAX_PER_TEAM_DAY, runChatRetroPass, type PassDeps } from './run';
import type { RetroMessage } from './skeleton';
import type { Cluster } from './proposals';
import { clusterLessonsInMemory, FIXTURE_SECRET, visibleAnswerFixtures } from './visible-answer-fixtures';
import { retroSignature } from './lesson';

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

  it('kill switch wins over account dogfood: no reconciliation runs', async () => {
    let reconciled = 0;
    const { deps } = fakeDeps({ env: { CHAT_RETRO_ENABLED: '0' }, reconcileAccountDogfood: async () => { reconciled++; return { activatedUsers: 1, syncedTeams: 1 }; } });
    expect((await runChatRetroPass(deps)).disabled).toBe(true);
    expect(reconciled).toBe(0);
  });

  it('reconciles account dogfood before listing teams, and counts it', async () => {
    const order: string[] = [];
    const { deps } = fakeDeps({
      reconcileAccountDogfood: async () => { order.push('reconcile'); return { activatedUsers: 1, syncedTeams: 3 }; },
      listOptedInTeams: async () => { order.push('teams'); return []; },
    });
    const r = await runChatRetroPass(deps);
    expect(order).toEqual(['reconcile', 'teams']);
    expect([r.dogfoodActivated, r.dogfoodSynced, r.errors]).toEqual([1, 3, 0]);
  });

  it('a failed reconciliation is counted and the pass goes on', async () => {
    const { deps, calls } = fakeDeps({ reconcileAccountDogfood: async () => { throw new Error('db'); } });
    const r = await runChatRetroPass(deps);
    expect(r.errors).toBe(1);
    expect(calls.teams).toBe(1);
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
      sessions: 5, days: 3, wastedTokens: 1000, satisfiedYes: 0, satisfiedPartly: 0, satisfiedNo: 5, highConfidence: 0,
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

describe('visible-answer failures through the whole pass', () => {
  const fixtures = visibleAnswerFixtures();
  const byName = (n: string) => fixtures.find(f => f.name === n)!;

  function passOver(names: string[], over: Partial<PassDeps> = {}) {
    const lessonsSoFar: LessonRow[] = [];
    const harness = fakeDeps({
      listPendingConversations: async () => names.map((_, i) => ({ id: U(300 + i), workspaceId: U(50), dataClass: null })),
      loadWindow: async (_t, conv) => byName(names[Number(conv.slice(-3)) - 300]).input,
      insertLessons: async rows => { lessonsSoFar.push(...rows); },
      loadClusters: async () => clusterLessonsInMemory(lessonsSoFar),
      ...over,
    });
    return { ...harness, lessons: lessonsSoFar };
  }

  it('backend-empty and render gap land as distinct, stable signatures; suppressed shapes sign nothing', async () => {
    const { deps, lessons } = passOver(['backend_empty_first_question', 'render_gap_foreground', 'render_gap_suppressed_hidden', 'render_gap_suppressed_pagehide', 'rendered_ok']);
    await runChatRetroPass(deps);
    expect(lessons.map(l => l.signature)).toEqual([
      retroSignature('no_answer', 'turn_pipeline', null),
      retroSignature('render_gap', 'ui', null),
      null, null, null,
    ]);
    // A single first question nobody saw answered is judged, not skipped as trivial.
    expect(lessons[0].status).toBe('judged');
  });

  it('the decision failing still keeps code\'s finding', async () => {
    const { deps, lessons } = passOver(['render_gap_foreground'], { decide: async () => ({ ok: false, error: { kind: 'timeout' }, latencyMs: 1, attempts: 1 }) as never });
    await runChatRetroPass(deps);
    expect(lessons[0]).toMatchObject({ status: 'failed', primaryCause: 'render_gap', signature: retroSignature('render_gap', 'ui', null) });
  });

  it('no lesson, evidence or filed proposal carries message text', async () => {
    const { deps, lessons, filed } = passOver(fixtures.map(f => f.name), {
      listOptedInTeams: async () => [{ teamId: T1, settings: { lessons: true, proposals: true }, dogfood: true }],
    });
    await runChatRetroPass(deps);
    expect(JSON.stringify(lessons)).not.toContain(FIXTURE_SECRET);
    expect(JSON.stringify(filed)).not.toContain(FIXTURE_SECRET);
  });

  it('a dogfood team files the first high-confidence occurrence; an ordinary team files nothing yet', async () => {
    const dog = passOver(['render_gap_foreground'], { listOptedInTeams: async () => [{ teamId: T1, settings: { lessons: true, proposals: true }, dogfood: true }] });
    const r1 = await runChatRetroPass(dog.deps);
    expect(r1.filed).toBe(1);
    expect(dog.filed[0].signature).toBe(retroSignature('render_gap', 'ui', null));

    const plain = passOver(['render_gap_foreground'], { listOptedInTeams: async () => [{ teamId: T1, settings: { lessons: true, proposals: true } }] });
    const r2 = await runChatRetroPass(plain.deps);
    expect(r2.filed).toBe(0);
    expect(plain.filed).toEqual([]);
  });

  it('a repeat of the same failure appends to the open proposal instead of filing a second', async () => {
    const { deps } = passOver(['backend_empty_first_question', 'backend_empty_tools_only'], {
      listOptedInTeams: async () => [{ teamId: T1, settings: { lessons: true, proposals: true }, dogfood: true }],
      priorFiling: async () => ({ taskId: 'open-1', open: true, sessions: 1 }),
    });
    const r = await runChatRetroPass(deps);
    expect(r.filed).toBe(0);
    expect(r.appended).toBe(1);
  });
});
