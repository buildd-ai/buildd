import { describe, expect, it, mock } from 'bun:test';
import { deriveTaskVerdict, type TaskVerdict } from './task-verdict';
import {
  decideTaskVerdict,
  unclearTraceFacts,
  verdictFingerprint,
  VERDICT_MIN_CONFIDENCE,
  type VerdictLedgerRow,
  type VerdictRecord,
} from './task-verdict-decision';
import { refreshTaskVerdict } from './task-verdict-decision-refresh';
import { classifyTracesByRule, type ConsequenceTrace } from './trace-consequence';

const blocked = deriveTaskVerdict({
  taskStatus: 'completed',
  live: null,
  openQuestion: false,
  pr: { url: 'https://github.com/acme/app/pull/12', number: 12, lifecycle: 'ci_failed', merged: false },
  checks: [{ name: 'PR body lint', state: 'failed', url: null, line: 'Body contains a full UUID' }],
  openAttempt: null,
  mismatch: [{ kind: 'success_with_red_check', detail: 'Reported success while a check was failing: PR body lint.' }],
}) as TaskVerdict;

const record = (over: Partial<VerdictRecord> = {}): VerdictRecord => ({
  taskId: '00000000-0000-4000-8000-000000000001',
  teamId: 'team', workspaceId: 'ws', missionId: null, workerId: null, prNumber: 12, headSha: 'abc',
  sensitive: false,
  verdict: blocked,
  mismatch: [{ kind: 'success_with_red_check', detail: 'Reported success while a check was failing: PR body lint.' }],
  attempts: [{ n: 2, status: 'completed', diff: '+0 -0 · 0 files' }],
  notes: ['Edited the PR body'],
  unclearTraces: [],
  ...over,
});

let n = 0;
const ids = () => `id-${++n}`;
const ok = (answers: Record<string, { choice: string; confidence: number }>) => mock(async () => ({
  ok: true as const, answers, model: 'jev-test', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.00001 }, latencyMs: 12, attempts: 1,
}));

describe('decideTaskVerdict', () => {
  it('applies a confident answer and writes exactly one ledger row per question', async () => {
    const rows: VerdictLedgerRow[] = [];
    const decide = ok({ headline: { choice: 'fix_pr_metadata', confidence: 0.95 }, mismatch_diagnosis: { choice: 'wrong_check', confidence: 0.9 } });
    const out = await decideTaskVerdict(record(), { decide: decide as never, insertRows: async r => { rows.push(...r); }, newId: ids });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ wording: 'fix_pr_metadata', mismatchDiagnosis: 'wrong_check', fallback: false, model: 'jev-test', state: 'blocked' });
    expect(rows.map(r => [r.decisionId, r.status, r.capability])).toEqual([
      ['task_verdict.headline', 'applied', 'task_verdict'],
      ['task_verdict.mismatch_diagnosis', 'applied', 'task_verdict'],
    ]);
    expect(out.decisionIds.map(d => d.id)).toEqual(rows.map(r => r.id));
    expect(rows.every(r => r.fingerprint === out.fingerprint)).toBe(true);
  });

  it('below the threshold: logged as a suggestion, nothing applied, rules wording stands', async () => {
    const rows: VerdictLedgerRow[] = [];
    const out = await decideTaskVerdict(record({ mismatch: [] }), {
      decide: ok({ headline: { choice: 'rerun_checks', confidence: VERDICT_MIN_CONFIDENCE - 0.1 } }) as never,
      insertRows: async r => { rows.push(...r); }, newId: ids,
    });
    expect(out.wording).toBeNull();
    expect(out.fallback).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'suggested', applied: false, reason: 'below_threshold', suggested: 'rerun_checks', effective: 'rules' });
  });

  it('a failed call writes fallback rows and never throws', async () => {
    const rows: VerdictLedgerRow[] = [];
    const out = await decideTaskVerdict(record(), {
      decide: mock(async () => ({ ok: false as const, error: { kind: 'missing_key' as const }, latencyMs: 1, attempts: 0 })) as never,
      insertRows: async r => { rows.push(...r); }, newId: ids,
    });
    expect(out.fallback).toBe(true);
    expect(rows.map(r => [r.status, r.reason])).toEqual([['fallback', 'missing_key'], ['fallback', 'missing_key']]);
  });

  it('a thrown call and a failed insert are both contained', async () => {
    const out = await decideTaskVerdict(record(), {
      decide: mock(async () => { throw new Error('boom'); }) as never,
      insertRows: async () => { throw new Error('db down'); }, newId: ids,
    });
    expect(out.fallback).toBe(true);
    expect(out.decisionIds.every(d => d.status === 'fallback')).toBe(true);
  });

  it('a sensitive workspace never calls out, and still logs its fallback', async () => {
    const decide = ok({});
    const rows: VerdictLedgerRow[] = [];
    await decideTaskVerdict(record({ sensitive: true }), { decide: decide as never, insertRows: async r => { rows.push(...r); }, newId: ids });
    expect(decide).not.toHaveBeenCalled();
    expect(rows.every(r => r.reason === 'sensitive')).toBe(true);
  });

  it('grep noise never reaches the model: nothing unclear, nothing to ask on a shipped task', async () => {
    const traces: ConsequenceTrace[] = [{ id: 'g', pattern: 'bash_nonzero_exit', excerpt: '$ grep -rn x . 2>/dev/null [exit 2]', ts: new Date(1) }];
    const unclear = unclearTraceFacts(traces, classifyTracesByRule(traces, { succeeded: false, failed: false, gatingCheckRed: true }));
    expect(unclear).toEqual([]);
    const shipped = deriveTaskVerdict({ taskStatus: 'completed', live: null, openQuestion: false, pr: { url: 'u', number: 1, lifecycle: 'merged', merged: true }, checks: null, openAttempt: null })!;
    const decide = ok({});
    const rows: VerdictLedgerRow[] = [];
    const out = await decideTaskVerdict(record({ verdict: shipped, mismatch: [], unclearTraces: unclear }), { decide: decide as never, insertRows: async r => { rows.push(...r); } });
    expect(decide).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    expect(out.fallback).toBe(false);
  });

  it('an unclear trace is asked about and a confident call is cached by trace id', async () => {
    const traces: ConsequenceTrace[] = [{ id: 'u1', pattern: 'bash_nonzero_exit', excerpt: '$ node scripts/x.js [exit 1]\nError: cannot find module', ts: new Date(1) }];
    const unclear = unclearTraceFacts(traces, classifyTracesByRule(traces, { succeeded: false, failed: false, gatingCheckRed: false }));
    expect(unclear.map(t => t.key)).toEqual(['trace_0']);
    const rows: VerdictLedgerRow[] = [];
    const out = await decideTaskVerdict(record({ mismatch: [], unclearTraces: unclear }), {
      decide: ok({ headline: { choice: 'fix_code', confidence: 0.5 }, trace_0: { choice: 'real', confidence: 0.92 } }) as never,
      insertRows: async r => { rows.push(...r); }, newId: ids,
    });
    expect(out.traceClasses).toEqual({ u1: 'real' });
    expect(rows.filter(r => r.decisionId === 'task_verdict.error_class')).toHaveLength(1);
  });
});

describe('refreshTaskVerdict', () => {
  it('recomputes only when the record changed: same fingerprint, no model call, no write', async () => {
    const r = record();
    const decide = ok({ headline: { choice: 'fix_code', confidence: 0.99 } });
    const write = mock(async () => {});
    const stored = { v: 'tv1', fingerprint: verdictFingerprint(r), state: r.verdict.state, causeKey: r.verdict.causeKey, at: '', model: null, wording: null, mismatchDiagnosis: null, traceClasses: {}, decisionIds: [], fallback: false };
    await refreshTaskVerdict('t', 'ci_result', { load: async () => ({ record: r, verdict: r.verdict, stored }), decide: decide as never, write, insertRows: async () => {} });
    expect(decide).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('a changed record is decided once and cached', async () => {
    const r = record();
    const decide = ok({ headline: { choice: 'fix_code', confidence: 0.99 }, mismatch_diagnosis: { choice: 'flaky_ci', confidence: 0.2 } });
    const write = mock(async () => {});
    const out = await refreshTaskVerdict('t', 'ci_result', { load: async () => ({ record: r, verdict: r.verdict, stored: null }), decide: decide as never, write, insertRows: async () => {} });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(out?.wording).toBe('fix_code');
  });

  it('never throws', async () => {
    expect(await refreshTaskVerdict('t', 'pr_event', { load: async () => { throw new Error('db'); } })).toBeNull();
  });
});
