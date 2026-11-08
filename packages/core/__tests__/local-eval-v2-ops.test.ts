import { describe, it, expect } from 'bun:test';
import {
  RETENTION_DAYS, caseRow, filterCases, hasSecret, isExpired, permittedBrief, planRuns, redactDeep, resourceLabel, sealedRow, redactText, smokeCases, validatePolicy,
  type CaseRow, type RunPolicy,
} from '../local-eval-v2-ops';
import type { CaseManifestV2 } from '../local-eval-v2';

const row = (o: Partial<CaseRow>): CaseRow => ({ id: 'x', version: 1, category: 'find-by-behaviour', difficulty: 'easy', skills: ['find'], contextSizes: [], cpuOnly: false, estimatedVramMb: 16000, exposing: false, split: 'dev', available: true, ...o });
const ROWS: CaseRow[] = [
  row({ id: 'find-a', exposing: true }), row({ id: 'find-b', difficulty: 'hard', cpuOnly: true, estimatedVramMb: null }),
  row({ id: 'debug-a', category: 'causal-debugging', skills: ['fix'] }), row({ id: 'review-a', category: 'code-review', skills: ['review'] }),
  row({ id: 'ctx-a', category: 'long-context-requirements', skills: ['long-context'], contextSizes: [8192, 16384, 32768] }),
  row({ id: 'term-a', category: 'terminal-recovery-compaction', skills: ['compaction'] }),
  row({ id: 'sealed-find-a', split: 'sealed-holdout', available: false }),
];

describe('filterCases', () => {
  it('filters by skill, difficulty, context and resource', () => {
    expect(filterCases(ROWS, { skill: 'review' }).rows.map((r) => r.id)).toEqual(['review-a']);
    expect(filterCases(ROWS, { difficulty: 'hard' }).rows.map((r) => r.id)).toEqual(['find-b']);
    expect(filterCases(ROWS, { context: 16384 }).rows.map((r) => r.id)).toEqual(['ctx-a']);
    expect(filterCases(ROWS, { resource: 'cpu-only' }).rows.map((r) => r.id)).toEqual(['find-b']);
    expect(filterCases(ROWS, { resource: 'vram<=16000' }).rows.map((r) => r.id)).toContain('find-a');
    expect(filterCases(ROWS, { split: 'sealed-holdout' }).rows.map((r) => r.id)).toEqual(['sealed-find-a']);
  });
  it('rejects an unknown resource filter instead of matching everything', () => {
    expect(filterCases(ROWS, { resource: 'big' }).error).toContain('resource must be');
  });
});

describe('permittedBrief', () => {
  it('shows the instruction and snapshot paths, never verifier, reference or candidates', () => {
    const m = { id: 'c', category: 'find-by-behaviour', resources: { cpuOnly: true }, files: { snapshot: ['snapshot/a.ts'], instruction: 'instruction.md', verifier: ['verifier/check.ts'], reference: ['reference/answer.json'], rubric: null, candidates: { broken: [], alternative: null, files: [] } } } as unknown as CaseManifestV2;
    const b = permittedBrief(m, { 'snapshot/a.ts': 'x', 'instruction.md': 'Find it.', 'verifier/check.ts': 'SECRET_VERIFIER', 'reference/answer.json': 'SECRET_REF' });
    expect(JSON.stringify(b)).not.toContain('SECRET');
    expect(b.snapshotPaths).toEqual(['a.ts']);
    expect(b.instruction).toBe('Find it.');
  });
  it('caseRow carries the labels for filtering', () => {
    const m = { id: 'c', version: 2, category: 'code-review', labels: { difficulty: 'medium', skills: ['review'] }, resources: { cpuOnly: true, estimatedVramMb: null }, exposing: true } as unknown as CaseManifestV2;
    expect(caseRow(m, 'dev')).toMatchObject({ id: 'c', version: 2, difficulty: 'medium', skills: ['review'], cpuOnly: true });
  });
});

describe('smoke preset', () => {
  it('is bounded at four dev cases, one per category, exposing first, never sealed', () => {
    const s = smokeCases(ROWS);
    expect(s.map((r) => r.id)).toEqual(['find-a', 'debug-a', 'review-a', 'ctx-a']);
    expect(smokeCases([...ROWS, row({ id: 'find-0', exposing: true, split: 'sealed-holdout', available: false })]).length).toBe(4);
  });
});

describe('validatePolicy and planRuns', () => {
  const policy: RunPolicy = { model: 'm:1', harness: 'claude-code', contextTokens: 16384, trials: 2, track: 'single-context', retrievalPolicy: 'none' };
  const adapter = { id: 'a', capabilities: { toolCalling: true, systemPrompt: true, structuredOutput: true, contextTokens: 16384 } };
  const base = { policy, adapter, gpus: [{ usedMb: 0, totalMb: 24000 }], loadedModels: [] as string[] };
  const needs = { 'find-a': { toolCalling: true, systemPrompt: false, structuredOutput: false, contextTokens: 0 } };

  it('requires an explicit model, harness and context', () => {
    expect(validatePolicy({})).toHaveLength(4);
    expect(validatePolicy(policy)).toEqual([]);
    expect(validatePolicy({ ...policy, contextTokens: 100000 })[0]).toContain('--context');
  });
  it('refuses every run before the GPU window and says why', () => {
    const plan = planRuns({ ...base, cases: [ROWS[0]], needs, now: new Date('2026-11-08T13:59:00Z') });
    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.action === 'refused' && /deferred until/.test(p.reason ?? ''))).toBe(true);
  });
  it('allows a gpu case after the window, but never a cpuOnly case or a sealed one', () => {
    const plan = planRuns({ ...base, cases: [ROWS[0], ROWS[1], ROWS[6]], needs, now: new Date('2026-11-08T14:00:01Z') });
    expect(plan.filter((p) => p.caseId === 'find-a').every((p) => p.action === 'run')).toBe(true);
    expect(plan.find((p) => p.caseId === 'find-b')?.action).toBe('refused');
    expect(plan.find((p) => p.caseId === 'sealed-find-a')?.reason).toContain('not in this repository');
  });
  it('records unsupported instead of altering the case', () => {
    const plan = planRuns({ ...base, adapter: { ...adapter, capabilities: { ...adapter.capabilities, toolCalling: false } }, cases: [ROWS[0]], needs, now: new Date('2026-11-09T00:00:00Z') });
    expect(plan[0]).toMatchObject({ action: 'unsupported', reason: 'unsupported: toolCalling' });
  });
  it('gives each run a stable id that names case, config, track and trial', () => {
    const plan = planRuns({ ...base, cases: [ROWS[0]], needs, now: new Date('2026-11-09T00:00:00Z') });
    expect(plan.map((p) => p.runId)).toEqual(['v2.find-a.m_1@16384.single-context.t1', 'v2.find-a.m_1@16384.single-context.t2']);
  });
});

describe('redaction and retention', () => {
  it('removes secret-shaped strings and machine user paths, idempotently', () => {
    const raw = 'key bld_abcdef123456 and sk-abcdefghijklmnopqrstuv in /home/someone/work, ANTHROPIC_API_KEY=abc123456789, Authorization: Bearer abcdefghijklmnop1234';
    const out = redactText(raw);
    expect(out).not.toMatch(/bld_abc|sk-abc|someone|abc123456789|abcdefghijklmnop1234/);
    expect(out).toContain('~/work');
    expect(redactText(out)).toBe(out);
    expect(hasSecret(raw)).toBe(true);
    expect(hasSecret(out)).toBe(false);
  });
  it('redacts nested values and leaves numbers alone', () => {
    expect(redactDeep({ a: ['/Users/jo/x'], n: 3 })).toEqual({ a: ['~/x'], n: 3 });
  });
  it('expires raw output after the retention period only', () => {
    const now = new Date('2026-12-15T00:00:00Z');
    expect(isExpired(new Date('2026-11-10T00:00:00Z'), now)).toBe(true);
    expect(isExpired(new Date('2026-12-01T00:00:00Z'), now)).toBe(false);
    expect(RETENTION_DAYS).toBe(30);
  });
});

describe('resourceLabel', () => {
  it('shows a sealed descriptor as unknown, never as a GPU figure', () => {
    const r = sealedRow({ id: 's', category: 'find-by-behaviour', version: 1, difficulty: 'hard', skills: ['find'], exposing: false });
    expect(resourceLabel(r)).toBe('resource unknown');
    expect(resourceLabel(r)).not.toContain('MiB');
  });
  it('labels open cases by their recorded need', () => {
    expect(resourceLabel(row({ cpuOnly: true }))).toBe('cpu-only');
    expect(resourceLabel(row({ cpuOnly: false, estimatedVramMb: 8192 }))).toBe('gpu 8192MiB');
    expect(resourceLabel(row({ cpuOnly: false, estimatedVramMb: null }))).toBe('gpu (vram not estimated)');
  });
});
