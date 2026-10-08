/**
 * Memory Jev decisions (packages/core/memory-decisions.ts). The transport is
 * mocked at `fetch` (a System One response body); every gate, fallback and
 * log row is the real code.
 */
import { describe, expect, it } from 'bun:test';
import { expectDecisionPinned, type DecisionReceipt } from '@builddai/ai-kit/decide';
import {
  createMemoryDecider,
  labelTaskMemoryUses,
  gateKeep,
  gateType,
  gateUpdate,
  gateUse,
  gateChatMemoryTier,
  gateDirectiveScope,
  gatePromoteVeto,
  gateRelevanceDemote,
  promoteState,
  learnState,
  KEEP_NOT_DURABLE_TAG,
  MAX_USE_LABELS_PER_TASK,
  MAX_RELEVANCE_SHADOW_HITS,
  MEMORY_DECISIONS,
  MEMORY_PROMOTE_DECISION,
  MAX_PROMOTE_SHADOW_ITEMS,
  PROMOTE_VETO_MIN_CONFIDENCE,
  MEMORY_RELEVANCE_DECISION,
  RELEVANCE_DEMOTE_MIN_CONFIDENCE,
  RELEVANCE_LIVE_BUDGET_MS,
  MEMORY_DECISION_TIMEOUT_MS,
  STATE_CHARS,
  type PromoteItem,
  type MemoryDecisionRow,
  type MemoryDecisionScope,
} from '../memory-decisions';

const TEAM = 'bbbb0000-0000-0000-0000-000000000001';
const WS = 'aaaa0000-0000-0000-0000-000000000000';
const TASK = 'cccc0000-0000-0000-0000-000000000002';
const scope: MemoryDecisionScope = { teamId: TEAM, workspaceId: WS, taskId: TASK, accountId: null };

function body(answers: Record<string, unknown>) {
  return { model: 'typesafe/jev-1.13-test', answers, usage: { input_tokens: 300, output_tokens: 10, cost: 0.00001 } };
}
const choiceAns = (label: string, confidence: number) => ({ type: 'choice', choice: label, probabilities: { [label]: confidence }, confidence });
const noulAns = (p: number) => ({ type: 'noul', noul: p });

type Reply = Record<string, unknown> | ((req: any) => Record<string, unknown>) | 'error' | 'hang';

function harness(reply: Reply, opts: { key?: string | null; timeoutMs?: number } = {}) {
  const rows: MemoryDecisionRow[] = [];
  const receipts: DecisionReceipt[] = [];
  const requests: any[] = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body ?? '{}'));
    requests.push(req);
    if (reply === 'error') return new Response('{"error":"nope"}', { status: 400, headers: { 'content-type': 'application/json' } });
    if (reply === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    const answers = typeof reply === 'function' ? reply(req) : reply;
    return new Response(JSON.stringify(body(answers)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const decider = createMemoryDecider({
    resolveKey: async () => (opts.key === undefined ? 'sk-test' : opts.key),
    record: (r, rc) => { rows.push(...r); receipts.push(...rc); },
    fetch,
    timeoutMs: opts.timeoutMs,
  });
  return { decider, rows, receipts, requests };
}

describe('definitions', () => {
  it('every decision is pinned: a changed question, mode or threshold fails until its version is bumped', () => {
    // Re-pin only together with a PROMPT_VERSION bump (memory-decisions.ts).
    for (const [k, d] of Object.entries(MEMORY_DECISIONS)) expectDecisionPinned(d, { fingerprint: PINNED[k as keyof typeof PINNED] });
  });

  it('relevance gates a demotion; promote gates a veto; the rest act', () => {
    expect(MEMORY_DECISIONS.relevance.policyOf('relevant').mode).toBe('gated');
    expect(MEMORY_DECISIONS.relevance.policyOf('relevant').minConfidence).toBe(RELEVANCE_DEMOTE_MIN_CONFIDENCE);
    expect(MEMORY_DECISIONS.promote.policyOf('promote').mode).toBe('gated');
    expect(MEMORY_DECISIONS.promote.policyOf('promote').minConfidence).toBe(PROMOTE_VETO_MIN_CONFIDENCE);
    expect(MEMORY_DECISIONS.learn.policyOf('keep').minConfidence).toBe(0.8);
    expect(MEMORY_DECISIONS.learn.policyOf('type').minConfidence).toBe(0.9);
    expect(MEMORY_DECISIONS.update.policyOf('action').minConfidence).toBe(0.9);
  });

  it('no catch-all label on type or update', () => {
    expect(Object.keys(MEMORY_DECISIONS.learn.questions.type.criteria).sort()).toEqual(['architecture', 'decision', 'discovery', 'gotcha', 'pattern']);
    expect(Object.keys(MEMORY_DECISIONS.update.questions.action.criteria).sort()).toEqual(['ADD', 'NOOP', 'SUPERSEDE', 'UPDATE']);
  });

  it('states are truncated well inside the 32K token limit', () => {
    const huge = 'x'.repeat(200_000);
    const s = learnState({ title: huge, content: huge, type: 'gotcha' });
    expect(s.memory.content.length).toBeLessThanOrEqual(STATE_CHARS.content + 1);
    expect(s.memory.title.length).toBeLessThanOrEqual(STATE_CHARS.title + 1);
    const p = promoteState({ content: huge }, { uses: huge });
    expect(JSON.stringify(p).length).toBeLessThan(20_000);
  });
});

describe('pure gates', () => {
  it('keep flags only a confident "not durable"', () => {
    expect(gateKeep(noulAns(0.1) as any).flag).toBe(true);
    expect(gateKeep(noulAns(0.3) as any).flag).toBe(false);
    expect(gateKeep(noulAns(0.95) as any).flag).toBe(false);
    expect(gateKeep(null).flag).toBe(false);
  });

  it('type overrides only above the high threshold', () => {
    expect(gateType('gotcha', choiceAns('pattern', 0.95) as any)).toMatchObject({ type: 'pattern', overridden: true, jev: 'pattern' });
    expect(gateType('gotcha', choiceAns('pattern', 0.85) as any)).toMatchObject({ type: 'gotcha', overridden: false, jev: 'pattern' });
    expect(gateType('gotcha', null)).toMatchObject({ type: 'gotcha', overridden: false, jev: null });
  });

  it('update needs more confidence to merge than to supersede', () => {
    expect(gateUpdate(choiceAns('SUPERSEDE', 0.92) as any)).toBe('SUPERSEDE');
    expect(gateUpdate(choiceAns('UPDATE', 0.92) as any)).toBeNull();
    expect(gateUpdate(choiceAns('UPDATE', 0.96) as any)).toBe('UPDATE');
    expect(gateUpdate(choiceAns('NOOP', 0.5) as any)).toBeNull();
  });

  it('use labels only confident answers', () => {
    expect(gateUse(noulAns(0.9) as any)).toBe('used');
    expect(gateUse(noulAns(0.1) as any)).toBe('ignored');
    expect(gateUse(noulAns(0.5) as any)).toBeNull();
  });

  it('chat tier proposes nothing for neither or low confidence; scope preselects only when confident', () => {
    expect(gateChatMemoryTier(choiceAns('directive', 0.9) as any)).toBe('directive');
    expect(gateChatMemoryTier(choiceAns('neither', 0.99) as any)).toBeNull();
    expect(gateChatMemoryTier(choiceAns('knowledge', 0.5) as any)).toBeNull();
    expect(gateDirectiveScope(choiceAns('workspace', 0.9) as any)).toBe('workspace');
    expect(gateDirectiveScope(choiceAns('everywhere', 0.7) as any)).toBeNull();
  });

  it('promote vetoes only on a confident "do not promote"', () => {
    expect(PROMOTE_VETO_MIN_CONFIDENCE).toBe(0.8);
    expect(gatePromoteVeto(noulAns(0.1) as any)).toBe(true);
    expect(gatePromoteVeto(noulAns(0.2) as any)).toBe(true);
    expect(gatePromoteVeto(noulAns(0.3) as any)).toBe(false);
    expect(gatePromoteVeto(noulAns(0.95) as any)).toBe(false);
    expect(gatePromoteVeto(null)).toBe(false);
  });
});

describe('judgeLearn', () => {
  it('tags a confident task summary, overrides a confidently wrong type, and logs both against the row', async () => {
    const h = harness({ keep: noulAns(0.05), type: choiceAns('discovery', 0.97) });
    const j = await h.decider.judgeLearn({ scope, title: 'Did X', content: 'Implemented X, PR opened', type: 'gotcha' });
    expect(j.addTags).toEqual([KEEP_NOT_DURABLE_TAG]);
    expect(j.type).toMatchObject({ type: 'discovery', overridden: true });
    j.record('mem-1');
    j.record('mem-1');
    expect(h.rows).toHaveLength(2);
    const keep = h.rows.find(r => r.decision === 'keep')!;
    expect(keep).toMatchObject({ memoryId: 'mem-1', verdict: 'false', rule: 'keep', applied: true, mode: 'live', teamId: TEAM, taskId: TASK });
    expect(keep.probability).toBeCloseTo(0.05);
    const type = h.rows.find(r => r.decision === 'type')!;
    expect(type).toMatchObject({ verdict: 'discovery', rule: 'gotcha', applied: true, confidence: 0.97 });
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0].decisionId).toBe('buildd.memory_learn');
    // The request carried the typed questions.
    expect(Object.keys(h.requests[0].questions).sort()).toEqual(['keep', 'type']);
  });

  it('below threshold keeps the caller\'s type and adds no tag, but still logs the verdict', async () => {
    const h = harness({ keep: noulAns(0.4), type: choiceAns('pattern', 0.6) });
    const j = await h.decider.judgeLearn({ scope, title: 'T', content: 'C', type: 'gotcha' });
    expect(j.addTags).toEqual([]);
    expect(j.type).toMatchObject({ type: 'gotcha', overridden: false, jev: 'pattern' });
    j.record('mem-2');
    expect(h.rows.map(r => r.applied)).toEqual([false, false]);
  });

  it('fails open with no key: no call, no rows', async () => {
    const h = harness({}, { key: null });
    const j = await h.decider.judgeLearn({ scope, title: 'T', content: 'C', type: 'pattern' });
    expect(j.type.type).toBe('pattern');
    expect(j.addTags).toEqual([]);
    j.record('m');
    expect(h.requests).toHaveLength(0);
    expect(h.rows).toHaveLength(0);
  });

  it('fails open on a provider error and logs the error kind', async () => {
    const h = harness('error');
    const j = await h.decider.judgeLearn({ scope, title: 'T', content: 'C', type: 'decision' });
    expect(j.type.type).toBe('decision');
    j.record('m');
    expect(h.rows.every(r => r.error === 'provider_error' && r.verdict === null && !r.applied)).toBe(true);
  });

  it('fails open at the deadline', async () => {
    const h = harness('hang', { timeoutMs: 150 });
    const t0 = Date.now();
    const j = await h.decider.judgeLearn({ scope, title: 'T', content: 'C', type: 'gotcha' });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(j.type.type).toBe('gotcha');
    expect(j.addTags).toEqual([]);
  });

  it('a hanging key lookup still returns the fallback within the deadline, and logs the timeout', async () => {
    const rows: MemoryDecisionRow[] = [];
    let fetched = 0;
    const d = createMemoryDecider({
      resolveKey: () => new Promise<string | null>(() => {}),
      record: r => { rows.push(...r); },
      fetch: async () => { fetched++; return new Response('{}'); },
      timeoutMs: 120,
    });
    const t0 = Date.now();
    const j = await d.judgeLearn({ scope, title: 'T', content: 'C', type: 'pattern' });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(j.type).toMatchObject({ type: 'pattern', overridden: false });
    expect(j.addTags).toEqual([]);
    j.record('m');
    expect(fetched).toBe(0);
    expect(rows.map(r => [r.decision, r.error, r.applied])).toEqual([['keep', 'timeout', false], ['type', 'timeout', false]]);

    const u = await d.judgeUpdate({ scope, incoming: { content: 'a' }, existing: { id: 'old', content: 'b' } });
    expect(u.action).toBeNull();
    await d.shadowRelevance({ scope, task: 't', caller: 'claim_context', hits: [{ memoryId: 'm1', content: 'c', gatedBy: null }] });
    expect(rows.at(-1)).toMatchObject({ decision: 'relevance', error: 'timeout' });
  });

  it('a record sink that throws never fails the decision', async () => {
    const d = createMemoryDecider({
      resolveKey: async () => 'k',
      record: () => { throw new Error('db down'); },
      fetch: async () => new Response(JSON.stringify(body({ keep: noulAns(0.9), type: choiceAns('gotcha', 0.9) })), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const j = await d.judgeLearn({ scope, title: 'T', content: 'C', type: 'gotcha' });
    expect(() => j.record('m')).not.toThrow();
  });
});

describe('judgeUpdate', () => {
  it('returns the gated action and logs it with the rule it replaced', async () => {
    const h = harness({ action: choiceAns('SUPERSEDE', 0.93) });
    const j = await h.decider.judgeUpdate({ scope, incoming: { title: 'New', content: 'new' }, existing: { id: 'old-id', content: 'old' } });
    expect(j.action).toBe('SUPERSEDE');
    j.record('new-id', true);
    expect(h.rows[0]).toMatchObject({ decision: 'update', verdict: 'SUPERSEDE', rule: 'conflict', applied: true, memoryId: 'new-id' });
    expect(Object.keys(h.requests[0].state).sort()).toEqual(['existing', 'incoming']);
  });

  it('below threshold falls back to the conflict reply (null action)', async () => {
    const h = harness({ action: choiceAns('NOOP', 0.7) });
    const j = await h.decider.judgeUpdate({ scope, incoming: { content: 'a' }, existing: { id: 'old', content: 'b' } });
    expect(j.action).toBeNull();
    j.record(null, false);
    expect(h.rows[0]).toMatchObject({ verdict: 'NOOP', applied: false, memoryId: 'old' });
  });
});

describe('labelUses', () => {
  it('labels at most MAX_USE_LABELS_PER_TASK distinct memories', async () => {
    const h = harness(req => ({ used: noulAns(String(req.state.memory.content).includes('acted') ? 0.95 : 0.05) }));
    const memories = Array.from({ length: 14 }, (_, i) => ({ memoryId: `m${i}`, content: i === 0 ? 'acted on' : 'unrelated' }));
    memories.push({ memoryId: 'm0', content: 'acted on' });
    const labels = await h.decider.labelUses({ scope, summary: 'Did the thing', memories });
    expect(labels).toHaveLength(MAX_USE_LABELS_PER_TASK);
    expect(h.requests).toHaveLength(MAX_USE_LABELS_PER_TASK);
    expect(labels[0]).toEqual({ memoryId: 'm0', outcome: 'used' });
    expect(labels[1]).toEqual({ memoryId: 'm1', outcome: 'ignored' });
    expect(h.rows.filter(r => r.decision === 'use')).toHaveLength(MAX_USE_LABELS_PER_TASK);
  });
});

describe('shadowRelevance', () => {
  it('logs a shadow verdict per hit (bounded) with the current rule, and never acts', async () => {
    const h = harness({ relevant: noulAns(0.2) });
    const hits = Array.from({ length: 12 }, (_, i) => ({ memoryId: `m${i}`, content: 'c', gatedBy: null }));
    await h.decider.shadowRelevance({ scope, task: 'fix the claim route', caller: 'claim_context', hits });
    expect(h.rows).toHaveLength(MAX_RELEVANCE_SHADOW_HITS);
    expect(h.rows.every(r => r.mode === 'shadow' && !r.applied && r.rule === 'shown' && r.verdict === 'false' && r.caller === 'claim_context')).toBe(true);
  });
});

describe('relevance live', () => {
  const hit = (memoryId: string, extra: Record<string, unknown> = {}) => ({ memoryId, content: memoryId, gatedBy: null, ...extra });
  const byContent = (p: Record<string, number>) => (req: any) => ({ relevant: noulAns(p[String(req.state.memory.content)] ?? 0.5) });

  it('the threshold is at least 0.85 and the budget well under the 5s deadline', () => {
    expect(RELEVANCE_DEMOTE_MIN_CONFIDENCE).toBeGreaterThanOrEqual(0.85);
    expect(RELEVANCE_LIVE_BUDGET_MS).toBeLessThanOrEqual(MEMORY_DECISION_TIMEOUT_MS / 2);
  });

  it('versioned apart from the md1 shadow, so readouts split shadow from live', () => {
    expect(MEMORY_RELEVANCE_DECISION.promptVersion).toBe('md2');
  });

  it('demotes only on a confident "not relevant"', () => {
    expect(gateRelevanceDemote(noulAns(0.1) as any)).toBe(true);
    expect(gateRelevanceDemote(noulAns(0.2) as any)).toBe(false);
    expect(gateRelevanceDemote(noulAns(0.95) as any)).toBe(false);
    expect(gateRelevanceDemote(null)).toBe(false);
  });

  it('returns the confident not-relevant hits; rows are live and applied only once recorded as applied', async () => {
    const h = harness(byContent({ noise: 0.05, unsure: 0.3, useful: 0.95 }));
    const j = await h.decider.judgeRelevance!({ scope, task: 'fix the claim route', caller: 'claim_context', hits: [hit('noise'), hit('unsure'), hit('useful')] });
    expect([...j.demote]).toEqual(['noise']);
    expect(h.rows).toHaveLength(0);
    j.record(true);
    j.record(true);
    expect(h.rows.map(r => [r.memoryId, r.mode, r.verdict, r.applied, r.rule, r.caller])).toEqual([
      ['noise', 'live', 'false', true, 'shown', 'claim_context'],
      ['unsure', 'live', 'false', false, 'shown', 'claim_context'],
      ['useful', 'live', 'true', false, 'shown', 'claim_context'],
    ]);
    expect(h.rows.every(r => r.decision === 'relevance' && r.version.startsWith('md2|'))).toBe(true);
  });

  it('a mandatory hit is judged and logged but never demoted', async () => {
    const h = harness({ relevant: noulAns(0.01) });
    const j = await h.decider.judgeRelevance!({ scope, task: 't', caller: 'claim_context', hits: [hit('pinned', { mandatory: true }), hit('other')] });
    expect([...j.demote]).toEqual(['other']);
    j.record(true);
    expect(h.rows.find(r => r.memoryId === 'pinned')).toMatchObject({ rule: 'mandatory', applied: false, verdict: 'false' });
  });

  it('recorded as not applied (the caller fell back to the rule order): every row applied=false', async () => {
    const h = harness({ relevant: noulAns(0.01) });
    const j = await h.decider.judgeRelevance!({ scope, task: 't', caller: 'claim_context', hits: [hit('a'), hit('b')] });
    j.record(false);
    expect(h.rows.every(r => !r.applied && r.mode === 'live')).toBe(true);
  });

  it('a hang is bounded by the live budget, not the 5s deadline, and demotes nothing', async () => {
    const h = harness('hang');
    const started = Date.now();
    const j = await h.decider.judgeRelevance!({ scope, task: 't', caller: 'claim_context', hits: [hit('a'), hit('b')], budgetMs: 40 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(j.demote.size).toBe(0);
    j.record(true);
    expect(h.rows.every(r => r.error === 'timeout' && !r.applied)).toBe(true);
  });

  it('no key or no task text: nothing demoted, nothing logged', async () => {
    const none = harness({}, { key: null });
    const j = await none.decider.judgeRelevance!({ scope, task: 't', caller: 'claim_context', hits: [hit('a')] });
    j.record(true);
    expect(j.demote.size).toBe(0);
    expect(none.rows).toHaveLength(0);
    const blank = harness({ relevant: noulAns(0.01) });
    const k = await blank.decider.judgeRelevance!({ scope, task: '  ', caller: 'claim_context', hits: [hit('a')] });
    expect(k.demote.size).toBe(0);
    expect(blank.requests).toHaveLength(0);
  });
});

describe('judgePromote', () => {
  const item = (memoryId: string, live: boolean, rule = live ? 'promote' : 'hold:no_evidence'): PromoteItem => ({
    memoryId, title: `t ${memoryId}`, content: memoryId, type: 'gotcha', evidence: { corroborated: true }, rule, live,
  });
  const byContent = (p: Record<string, number>) => (req: any) => ({ promote: noulAns(p[String(req.state.memory.content)] ?? 0.5) });

  it('is a yes/no over bounded evidence', () => {
    expect(MEMORY_PROMOTE_DECISION.questions.promote.type).toBe('noul');
    const state = promoteState({ title: 't', content: 'c', type: 'pattern' }, { usedBy: 3, contradicted: 0 });
    expect(state.evidence).toEqual({ usedBy: 3, contradicted: 0 });
  });

  it('versioned apart from the md1 decisions, so readouts split pre/post veto', () => {
    expect(MEMORY_PROMOTE_DECISION.promptVersion).toBe('md2');
    expect(MEMORY_DECISIONS.learn.promptVersion).toBe('md1');
  });

  it('a live item vetoes on a confident no: logged live and applied', async () => {
    const h = harness(byContent({ veto: 0.1, unsure: 0.3, yes: 0.95 }));
    const out = await h.decider.judgePromote({ scope: { teamId: TEAM }, items: [item('veto', true), item('unsure', true), item('yes', true)] });
    expect(out).toEqual([{ memoryId: 'veto', veto: true }, { memoryId: 'unsure', veto: false }, { memoryId: 'yes', veto: false }]);
    expect(h.rows.map(r => [r.memoryId, r.mode, r.verdict, r.applied, r.rule])).toEqual([
      ['veto', 'live', 'false', true, 'promote'],
      ['unsure', 'live', 'false', false, 'promote'],
      ['yes', 'live', 'true', false, 'promote'],
    ]);
    expect(h.rows.every(r => r.decision === 'promote' && r.version.startsWith('md2|'))).toBe(true);
  });

  it('a challenger (the rule held it) never acts, whatever Jev says: logged shadow', async () => {
    const h = harness(byContent({ promote: 0.99, no: 0.01 }));
    const out = await h.decider.judgePromote({ scope: { teamId: TEAM }, items: [item('promote', false), item('no', false)] });
    expect(out.every(v => !v.veto)).toBe(true);
    expect(h.rows.every(r => r.mode === 'shadow' && !r.applied)).toBe(true);
    expect(h.rows.map(r => r.verdict)).toEqual(['true', 'false']);
  });

  it('fails open: an error or no key vetoes nothing', async () => {
    const err = harness('error');
    expect(await err.decider.judgePromote({ scope: { teamId: TEAM }, items: [item('a', true)] })).toEqual([{ memoryId: 'a', veto: false }]);
    expect(err.rows[0]).toMatchObject({ mode: 'live', applied: false, error: 'provider_error' });
    const none = harness({}, { key: null });
    expect(await none.decider.judgePromote({ scope: { teamId: TEAM }, items: [item('a', true)] })).toEqual([{ memoryId: 'a', veto: false }]);
    expect(none.rows).toHaveLength(0);
  });

  it('asks at most MAX_PROMOTE_SHADOW_ITEMS per call', async () => {
    const h = harness({ promote: noulAns(0.9) });
    const many = Array.from({ length: MAX_PROMOTE_SHADOW_ITEMS + 2 }, (_, i) => item(`m${i}`, true));
    const out = await h.decider.judgePromote({ scope: { teamId: TEAM }, items: many });
    expect(h.requests).toHaveLength(MAX_PROMOTE_SHADOW_ITEMS);
    expect(out).toHaveLength(MAX_PROMOTE_SHADOW_ITEMS + 2);
    expect(out.every(v => !v.veto)).toBe(true);
  });
});

describe('labelTaskMemoryUses', () => {
  it('loads the task\'s shown uses, labels them and writes only decided outcomes', async () => {
    const h = harness(req => ({ used: noulAns(String(req.state.memory.content) === 'yes' ? 0.9 : 0.5) }));
    const writes: any[] = [];
    const out = await labelTaskMemoryUses({ taskId: TASK, summary: 'final summary' }, {
      decider: h.decider,
      loadUses: async () => [
        { teamId: TEAM, workspaceId: WS, memoryId: 'a' },
        { teamId: TEAM, workspaceId: WS, memoryId: 'a' },
        { teamId: TEAM, workspaceId: WS, memoryId: 'b' },
      ],
      loadMemories: async () => [{ id: 'a', content: 'yes' }, { id: 'b', content: 'maybe' }],
      writeOutcomes: async (taskId, labels) => { writes.push({ taskId, labels }); },
    });
    expect(out).toEqual({ labelled: 1, considered: 2 });
    expect(writes).toEqual([{ taskId: TASK, labels: [{ memoryId: 'a', outcome: 'used' }] }]);
  });

  it('does not ask again for a task already labelled', async () => {
    const h = harness({ used: noulAns(0.9) });
    let loaded = 0;
    const out = await labelTaskMemoryUses({ taskId: TASK, summary: 's' }, {
      decider: h.decider,
      attempted: async () => true,
      loadUses: async () => { loaded++; return [{ teamId: TEAM, workspaceId: WS, memoryId: 'a' }]; },
      loadMemories: async () => [{ id: 'a', content: 'x' }],
      writeOutcomes: async () => {},
    });
    expect(out).toEqual({ labelled: 0, considered: 0 });
    expect(loaded).toBe(0);
    expect(h.requests).toHaveLength(0);
  });

  it('never throws, and does nothing without a summary', async () => {
    const h = harness({});
    const boom = async () => { throw new Error('x'); };
    expect(await labelTaskMemoryUses({ taskId: TASK, summary: 's' }, { decider: h.decider, loadUses: boom, loadMemories: boom, writeOutcomes: boom })).toEqual({ labelled: 0, considered: 0 });
    expect(await labelTaskMemoryUses({ taskId: TASK, summary: '  ' }, { decider: h.decider, loadUses: boom, loadMemories: boom, writeOutcomes: boom })).toEqual({ labelled: 0, considered: 0 });
  });
});

describe('judgeChatDirective', () => {
  const byState = (tier: unknown, scopeAns: unknown) => (req: any) => (req.state.turn ? { tier } : { scope: scopeAns });

  it('asks tier and, with a workspace, scope; logs both rows next to the rule', async () => {
    const h = harness(byState(choiceAns('directive', 0.92), choiceAns('workspace', 0.88)));
    const out = await h.decider.judgeChatDirective({
      scope, message: 'Always run the billing smoke test first.', workspace: { name: 'billing-web' }, rule: true,
    });
    expect(out).toEqual({ tier: { choice: 'directive', confidence: 0.92 }, scope: { choice: 'workspace', confidence: 0.88 } });
    expect(h.requests).toHaveLength(2);
    expect(h.rows.map(r => [r.decision, r.verdict, r.rule, r.applied, r.caller])).toEqual([
      ['chat_tier', 'directive', 'directive', true, 'chat'],
      ['directive_scope', 'workspace', 'everywhere', true, 'chat'],
    ]);
    expect(h.receipts).toHaveLength(2);
  });

  it('no workspace: one call, no scope answer', async () => {
    const h = harness(byState(choiceAns('neither', 0.6), null));
    const out = await h.decider.judgeChatDirective({ scope, message: 'never mind', workspace: null, rule: false });
    expect(out).toEqual({ tier: { choice: 'neither', confidence: 0.6 }, scope: null });
    expect(h.requests).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ decision: 'chat_tier', applied: false, rule: 'neither' });
  });

  it('chat_tier is applied only when a confident directive proposed a card, not for a confident neither or knowledge', async () => {
    for (const tier of ['neither', 'knowledge'] as const) {
      const h = harness(byState(choiceAns(tier, 0.97), null));
      await h.decider.judgeChatDirective({ scope, message: 'The billing service runs on port 4000.', workspace: null, rule: false });
      expect(h.rows[0]).toMatchObject({ decision: 'chat_tier', verdict: tier, applied: false });
    }
    const low = harness(byState(choiceAns('directive', 0.6), null));
    await low.decider.judgeChatDirective({ scope, message: 'Always x', workspace: null, rule: true });
    expect(low.rows[0]).toMatchObject({ verdict: 'directive', applied: false });
  });

  it('no key: null, nothing logged', async () => {
    const h = harness({}, { key: null });
    expect(await h.decider.judgeChatDirective({ scope, message: 'Always x', workspace: null, rule: true })).toBeNull();
    expect(h.rows).toHaveLength(0);
  });

  it('a failed call fails open: null answers, the error logged', async () => {
    const h = harness('error');
    const out = await h.decider.judgeChatDirective({ scope, message: 'Always x', workspace: { name: 'w' }, rule: true });
    expect(out).toEqual({ tier: null, scope: null });
    expect(h.rows.length).toBe(2);
    expect(h.rows.every(r => r.error !== null && r.applied === false)).toBe(true);
  });

  it('a hang is bounded by the deadline', async () => {
    const h = harness('hang', { timeoutMs: 30 });
    const out = await h.decider.judgeChatDirective({ scope, message: 'Always x', workspace: null, rule: true });
    expect(out).toEqual({ tier: null, scope: null });
    expect(h.rows[0].error).toBe('timeout');
  });
});

const PINNED = {
  learn: '614834af489d',
  update: '3f167883df52',
  use: '41f06ea424cc',
  relevance: '92eb47fc6823',
  promote: 'a8bc20d757de',
  chat_tier: '9a7353f294b1',
  directive_scope: '5a0801087fd0',
};
