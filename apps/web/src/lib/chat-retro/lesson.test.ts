import { describe, expect, it } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { chatRetros } from '@buildd/core/db/schema';
import { assertContentFree, buildQuestions, failedLesson, judgedLesson, retroSignature, skippedLesson, withVisibleAnswer, type WindowRef } from './lesson';
import type { Candidate } from './skeleton';
import { EVIDENCE_KEYS, LESSON_TEXT_COLUMNS, SIGNATURE_PATTERN, TURN_LABELS } from './vocab';

const M = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ref: WindowRef = { teamId: M(1), conversationId: M(2), workspaceId: M(3), fromMessageId: M(10), toMessageId: M(20), toMessageAt: new Date() };
const totals = { userTurns: 3, turns: 6, inputTokens: 30000, outputTokens: 2000, costUsd: 0.1 };
const ans = (choice: string, confidence = 0.95) => ({ type: 'choice' as const, choice, confidence, probabilities: {} });

describe('chat_retros is content-free by construction', () => {
  const cfg = getTableConfig(chatRetros);

  it('every text column has a fixed vocabulary or pattern', () => {
    const textColumns = cfg.columns.filter(c => c.dataType === 'string' && c.columnType !== 'PgUUID').map(c => c.name);
    // Pinned: a new text column must be added to LESSON_TEXT_COLUMNS with its vocabulary.
    expect(textColumns.sort()).toEqual(Object.keys(LESSON_TEXT_COLUMNS).sort());
  });

  it('no column is shaped to hold message, prompt or model text', () => {
    const suspicious = cfg.columns.map(c => c.name).filter(n => /text|content|prompt|message(?!_id|_at)|body|summary|comment|note|reply|answer|transcript/.test(n));
    expect(suspicious).toEqual([]);
  });

  it('no varchar or unbounded text other than the vocabulary columns, and the only jsonb is evidence', () => {
    const json = cfg.columns.filter(c => c.dataType === 'json').map(c => c.name);
    expect(json).toEqual(['evidence']);
  });

  it('rejects a row carrying free text in any text column', () => {
    const base = skippedLesson(ref, totals, 'trivial');
    expect(() => assertContentFree(base)).not.toThrow();
    for (const [field, value] of [
      ['intent', 'what is stuck in checkout?'], ['satisfied', 'mostly'], ['primaryCause', 'the model was confused'],
      ['toolName', 'List Tasks please'], ['signature', 'chat-retro: user asked about X'], ['error', 'Error: key sk-123'],
      ['version', 'cr1 the user said hi'], ['skipReason', 'nope'],
    ] as const) {
      expect(() => assertContentFree({ ...base, [field]: value } as never)).toThrow();
    }
  });

  it('rejects evidence with extra keys or non-ref values', () => {
    const base = skippedLesson(ref, totals, 'trivial');
    const ok = { turn: 1, messageId: M(11), kind: 'stopped', tokens: 5, label: 'reasoning_timeout', conf: 1 };
    expect(() => assertContentFree({ ...base, evidence: [ok] })).not.toThrow();
    expect(() => assertContentFree({ ...base, evidence: [{ ...ok, text: 'hi' } as never] })).toThrow();
    expect(() => assertContentFree({ ...base, evidence: [{ ...ok, messageId: 'see the user message' }] })).toThrow();
    expect(() => assertContentFree({ ...base, evidence: [{ ...ok, label: 'free text' }] })).toThrow();
    expect(() => assertContentFree({ ...base, evidence: [{ ...ok, kind: 'whatever' }] })).toThrow();
    expect([...EVIDENCE_KEYS].sort()).toEqual(Object.keys(ok).sort());
  });
});

describe('questions', () => {
  const cands: Candidate[] = [
    { id: 0, kind: 'stopped', turn: 1, messageId: M(11), tokens: 5000, toolName: null },
    { id: 1, kind: 'large_result', turn: 3, messageId: M(13), tokens: 9000, toolName: 'list_tasks' },
  ];
  it('asks about every non-stopped candidate, never about a stopped one, and fix_class only with candidates', () => {
    const q = buildQuestions(cands);
    expect(Object.keys(q).sort()).toEqual(['fix_class', 'intent', 'satisfied', 'turn_1']);
    expect(Object.keys(q.turn_1.criteria).sort()).toEqual([...TURN_LABELS].sort());
    expect(Object.keys(buildQuestions([])).sort()).toEqual(['intent', 'satisfied']);
  });
});

describe('judgedLesson: the model labels, code counts', () => {
  const cands: Candidate[] = [
    { id: 0, kind: 'stopped', turn: 1, messageId: M(11), tokens: 5000, toolName: 'list_tasks' },
    { id: 1, kind: 'large_result', turn: 3, messageId: M(13), tokens: 9000, toolName: 'list_tasks' },
    { id: 2, kind: 'thumbs_down', turn: 5, messageId: M(15), tokens: 800, toolName: null },
  ];
  const run = (answers: Record<string, ReturnType<typeof ans>>) => judgedLesson({
    ref, totals, candidates: cands, answers, model: 'typesafe/jev-1', stateTokens: 900, latencyMs: 300, jevCostUsd: 0.0001,
  });

  it('sums waste above the gate, picks the cause with most tokens, and signs it', () => {
    const row = run({ satisfied: ans('partly'), intent: ans('status_check'), turn_1: ans('over_fetch'), turn_2: ans('needed'), fix_class: ans('tool_or_param') });
    expect(row.status).toBe('judged');
    expect(row.wastedTurns).toBe(2);
    expect(row.wastedTokens).toBe(14000);
    expect(row.primaryCause).toBe('over_fetch');
    expect(row.toolName).toBe('list_tasks');
    expect(row.signature).toBe(retroSignature('over_fetch', 'tool_or_param', 'list_tasks'));
    expect(row.signature).toMatch(SIGNATURE_PATTERN);
    expect(row.evidence.map(e => e.label)).toEqual(['reasoning_timeout', 'over_fetch', 'needed']);
    expect(() => assertContentFree(row)).not.toThrow();
  });

  it('a label under its gate is recorded as evidence but counts no waste', () => {
    const row = run({ satisfied: ans('no', 0.5), intent: ans('act', 0.2), turn_1: ans('over_fetch', 0.6), turn_2: ans('re_asked', 0.6), fix_class: ans('ui') });
    expect(row.satisfied).toBeNull();
    expect(row.intent).toBeNull();
    expect(row.wastedTokens).toBe(5000);
    expect(row.primaryCause).toBe('reasoning_timeout');
  });

  it('no signature without a confident fix class', () => {
    const row = run({ turn_1: ans('over_fetch'), fix_class: ans('ui', 0.3) });
    expect(row.primaryCause).toBe('over_fetch');
    expect(row.fixClass).toBeNull();
    expect(row.signature).toBeNull();
  });
});

describe('visible-answer families', () => {
  const vis = (id: number, kind: Candidate['kind'], conf = 1): Candidate => ({ id, kind, turn: id, messageId: M(100 + id), tokens: 50, toolName: null, conf });

  it('signatures are stable strings: the friction dedupe key never drifts', () => {
    // Pinned on purpose. Changing one re-files every open proposal as new.
    expect(retroSignature('no_answer', 'turn_pipeline', null)).toBe('chat-retro:no_answer-turn_pipeline-none-e2ac0e');
    expect(retroSignature('render_gap', 'ui', null)).toBe('chat-retro:render_gap-ui-none-845fd4');
    expect(retroSignature('blank_retry', 'turn_pipeline', null)).toBe('chat-retro:blank_retry-turn_pipeline-none-a73a2f');
    expect(retroSignature('render_gap', 'ui', null)).toMatch(SIGNATURE_PATTERN);
    expect(retroSignature('no_answer', 'turn_pipeline', null)).toMatch(SIGNATURE_PATTERN);
    expect(retroSignature('blank_retry', 'turn_pipeline', null)).toMatch(SIGNATURE_PATTERN);
    expect(new Set([
      retroSignature('no_answer', 'turn_pipeline', null),
      retroSignature('render_gap', 'ui', null),
      retroSignature('blank_retry', 'turn_pipeline', null),
    ]).size).toBe(3);
  });

  it('code labels them: never asked, and no fix-class question when they are all there is', () => {
    const q = buildQuestions([vis(0, 'no_output'), vis(1, 'render_gap'), vis(2, 'blank_retry')]);
    expect(Object.keys(q).sort()).toEqual(['intent', 'satisfied']);
  });

  it('a sure visible failure is the primary cause whatever the model said, with code\'s fix class', () => {
    const cands: Candidate[] = [
      { id: 0, kind: 'large_result', turn: 1, messageId: M(30), tokens: 90_000, toolName: 'list_tasks' },
      vis(1, 'render_gap'),
    ];
    const row = judgedLesson({ ref, totals, candidates: cands, answers: { turn_0: ans('over_fetch'), fix_class: ans('tool_or_param') }, model: 'jev', stateTokens: 1, latencyMs: 1, jevCostUsd: 0 });
    expect(row.primaryCause).toBe('render_gap');
    expect(row.fixClass).toBe('ui');
    expect(row.toolName).toBeNull();
    expect(row.signature).toBe(retroSignature('render_gap', 'ui', null));
    expect(row.evidence.find(e => e.kind === 'render_gap')).toMatchObject({ label: 'render_gap', conf: 1 });
    expect(() => assertContentFree(row)).not.toThrow();
  });

  it('render gap outranks no answer, which outranks a retry', () => {
    const row = judgedLesson({ ref, totals, candidates: [vis(0, 'blank_retry'), vis(1, 'no_output'), vis(2, 'render_gap')], answers: {}, model: 'jev', stateTokens: 1, latencyMs: 1, jevCostUsd: 0 });
    expect(row.primaryCause).toBe('render_gap');
    const row2 = judgedLesson({ ref, totals, candidates: [vis(0, 'blank_retry'), vis(1, 'no_output')], answers: {}, model: 'jev', stateTokens: 1, latencyMs: 1, jevCostUsd: 0 });
    expect(row2.primaryCause).toBe('no_answer');
  });

  it('a guessed retry does not outrank the model\'s bigger cause', () => {
    const cands: Candidate[] = [
      { id: 0, kind: 'large_result', turn: 1, messageId: M(30), tokens: 90_000, toolName: 'list_tasks' },
      vis(1, 'blank_retry', 0.6),
    ];
    const row = judgedLesson({ ref, totals, candidates: cands, answers: { turn_0: ans('over_fetch'), fix_class: ans('tool_or_param') }, model: 'jev', stateTokens: 1, latencyMs: 1, jevCostUsd: 0 });
    expect(row.primaryCause).toBe('over_fetch');
  });

  it('a window the model did not judge still carries code\'s finding and signature', () => {
    const row = withVisibleAnswer(failedLesson(ref, totals, 'timeout', 10, 5000), [vis(0, 'no_output')]);
    expect(row.status).toBe('failed');
    expect(row.primaryCause).toBe('no_answer');
    expect(row.signature).toBe(retroSignature('no_answer', 'turn_pipeline', null));
    expect(row.wastedTurns).toBe(1);
    expect(() => assertContentFree(row)).not.toThrow();
    // Nothing visible: the row is untouched.
    const plain = skippedLesson(ref, totals, 'team_cap');
    expect(withVisibleAnswer(plain, [])).toBe(plain);
  });
});
