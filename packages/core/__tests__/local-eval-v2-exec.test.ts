import { describe, it, expect } from 'bun:test';
import {
  HARNESS_TREATMENT_V2, buildPromptV2, classifyAgentExit, defaultEvidenceSize, extractJsonAnswer, gradeRunV2, parseAgentStream, readoutV2, tamperingV2,
  treatmentHash, validateModelsV2, verifySealedContent, type ExitClass,
} from '../local-eval-v2-exec';
import { computeContentHash, namedPaths, type CaseFiles, type CaseManifestV2 } from '../local-eval-v2';
import type { RunRecord } from '../local-eval';

const manifest = (o: Partial<CaseManifestV2> = {}): CaseManifestV2 => ({
  formatVersion: 2, id: 'c', version: 1, contentHash: '', category: 'find-by-behaviour',
  files: { snapshot: ['snapshot/a.ts', 'snapshot/test/a.spec.ts'], instruction: 'instruction.md', verifier: ['verifier/check.ts'], reference: ['reference/answer.json'], rubric: null, candidates: { broken: ['b'], alternative: null, files: ['candidates/b/answer.json'] } },
  deps: {}, resources: { cpuOnly: true, estimatedVramMb: null, estimatedRamMb: null, wallClockSeconds: 60, maxTurns: 7, toolBudget: 9 },
  labels: { difficulty: 'easy', skills: ['find'] }, exposing: false, provenance: { source: 'authored', licence: 'l', note: 'n' }, contamination: 'c',
  expected: { kind: 'answer', locations: [{ file: 'a.ts' }] }, admission: null, ...o,
});
const ok: ExitClass = { kind: 'completed', note: '', inputTokens: 1, outputTokens: 1, turns: 1, toolCalls: 2, resultText: 'done' };

describe('harness treatment', () => {
  it('is versioned and hashed; the hash moves when the system prompt does', () => {
    expect(HARNESS_TREATMENT_V2.id).toBe('claude-code-minimal-v1');
    expect(HARNESS_TREATMENT_V2.tools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']);
    expect(treatmentHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(treatmentHash({ ...HARNESS_TREATMENT_V2, systemPrompt: 'x' })).not.toBe(treatmentHash());
    // Small enough that a 16K window is not spent on the harness.
    expect(HARNESS_TREATMENT_V2.systemPrompt.length).toBeLessThan(800);
  });
});

describe('buildPromptV2', () => {
  const files: CaseFiles = { 'instruction.md': 'Find it.\n', 'snapshot/a.ts': 'x' };
  it('uses the instruction verbatim plus a budget line, and reads only instruction and snapshot', () => {
    const p = buildPromptV2({ manifest: manifest(), files, track: 'single-context', contextTokens: 16384, toolCalling: true });
    expect(p.text).toBe('Find it.\n\nBudget: at most 7 turns and 9 tool calls.\n');
    expect(p.overflow).toBeNull();
    expect(p.answerChannel).toBe('file');
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  const ctxFiles: CaseFiles = {
    'instruction.md': 'Answer it.\n',
    'snapshot/evidence/needles.json': JSON.stringify([{ id: 'R1', text: 'R1: the answer is 7.' }]),
    'snapshot/evidence/filler.md': Array.from({ length: 300 }, (_, i) => `NOTE-${i}: padding about something else entirely here.`).join('\n\n'),
  };
  const ctx = manifest({ category: 'long-context-requirements', expected: { kind: 'verifier' }, longContext: { sizes: [8192, 16384, 32768], positions: ['middle'] } });
  it('puts evidence in the prompt (single-context) or in the tree (tool-retrieval), and records its position', () => {
    const a = buildPromptV2({ manifest: ctx, files: ctxFiles, track: 'single-context', contextTokens: 32768, position: 'end', toolCalling: true });
    expect(a.evidence).toMatchObject({ size: 16384, position: 'end' });
    expect(a.text).toContain('R1: the answer is 7.');
    expect(a.extraFiles).toEqual({});
    const b = buildPromptV2({ manifest: ctx, files: ctxFiles, track: 'tool-retrieval', contextTokens: 32768, toolCalling: true });
    expect(Object.keys(b.extraFiles)).toEqual(['evidence/context-16384.md']);
    expect(b.text).not.toContain('R1: the answer is 7.');
  });
  it('records overflow instead of truncating when the prompt does not fit', () => {
    const p = buildPromptV2({ manifest: ctx, files: ctxFiles, track: 'single-context', contextTokens: 8192, toolCalling: true });
    expect(p.overflow).toMatchObject({ kind: 'overflow', contextTokens: 8192 });
    expect(p.overflow!.inputTokens).toBeGreaterThan(8192);
  });
  it('asks for the answer as the final message when the adapter has no tools', () => {
    const p = buildPromptV2({ manifest: ctx, files: ctxFiles, track: 'single-context', contextTokens: 32768, toolCalling: false });
    expect(p.answerChannel).toBe('final-message');
    expect(p.text).toContain('answer.json');
  });
  it('defaultEvidenceSize picks the largest size below the window', () => {
    expect(defaultEvidenceSize([8192, 16384, 32768], 16384)).toBe(8192);
    expect(defaultEvidenceSize([8192, 16384, 32768], 32768)).toBe(16384);
    expect(defaultEvidenceSize([8192, 16384, 32768], 8192)).toBe(8192);
  });
});

describe('classifyAgentExit', () => {
  const res = (o: object) => JSON.stringify({ type: 'result', ...o });
  const x = (o: Partial<Parameters<typeof classifyAgentExit>[0]>) => classifyAgentExit({ code: 0, out: '', err: '', timedOut: false, spawnError: null, ...o });
  it('reads usage, turns and tool calls from stream-json', () => {
    const out = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }, { type: 'text' }, { type: 'tool_use' }] } }), res({ subtype: 'success', is_error: false, num_turns: 3, result: 'ok', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 2 } })].join('\n');
    expect(x({ out })).toMatchObject({ kind: 'completed', inputTokens: 15, outputTokens: 2, turns: 3, toolCalls: 2, resultText: 'ok' });
    expect(parseAgentStream('').toolCalls).toBeNull();
  });
  it('separates budget exhaustion (model) from harness, server and context failures', () => {
    expect(x({ timedOut: true, code: 143 }).kind).toBe('budget_exhausted');
    expect(x({ out: res({ subtype: 'error_max_turns', is_error: true }) }).kind).toBe('budget_exhausted');
    expect(x({ spawnError: 'ENOENT', code: 127 }).kind).toBe('harness');
    expect(x({ code: 1, err: 'crash' }).kind).toBe('harness');
    expect(x({ code: 1, out: res({ subtype: 'error_during_execution', is_error: true, result: 'API Error: Connection error.' }) }).kind).toBe('infra');
    expect(x({ code: 1, err: 'connect ECONNREFUSED 127.0.0.1:11435' }).kind).toBe('infra');
    expect(x({ code: 1, out: res({ subtype: 'error_during_execution', is_error: true, result: 'prompt is too long: 20000 tokens' }) }).kind).toBe('overflow');
  });
  it('extracts the last JSON object from a final message', () => {
    expect(extractJsonAnswer('Here:\n```json\n{"answer":"7"}\n```')).toBe('{"answer":"7"}\n');
    expect(extractJsonAnswer('{"abstain": true}')).toBe('{"abstain": true}\n');
    expect(extractJsonAnswer('no json')).toBeNull();
  });
});

describe('gradeRunV2', () => {
  const base = { runId: 'r', exit: ok, overflow: null, unsupported: null, leaks: [], tampering: [], visible: null, toolBudget: 9, contextTokens: 16384 };
  it('the hidden verifier decides; the find grader adds fabrication on an absence case', () => {
    const m = manifest({ expected: { kind: 'abstain', searchScope: {} as never } });
    const g = gradeRunV2({ ...base, manifest: m, verifier: { ran: true, passed: false, stdout: '' }, outputs: { answer: '{"citations":[{"file":"a.ts"}]}' } });
    expect(g.score).toMatchObject({ result: 'fail', failureClass: 'model' });
    expect(g.flags).toContain('fabrication');
    const good = gradeRunV2({ ...base, manifest: m, verifier: { ran: true, passed: true, stdout: '' }, outputs: { answer: '{"abstain":true,"citations":[]}' } });
    expect(good.score.result).toBe('pass');
    expect(good.absenceClaimed).toBe(true);
  });
  it('review precision and recall come from the candidate review only', () => {
    const m = manifest({ category: 'code-review', expected: { kind: 'review', defects: [{ id: 'd1', file: 'a.ts', startLine: 10, endLine: 12, cause: [['null']] }] } });
    const g = gradeRunV2({ ...base, manifest: m, verifier: { ran: true, passed: false, stdout: '' }, outputs: { answer: JSON.stringify({ findings: [{ file: 'a.ts', line: 11, description: 'null deref' }, { file: 'b.ts', line: 1, description: 'style' }] }) } });
    expect(g.detail).toMatchObject({ precision: 0.5, recall: 1, falsePositives: 1 });
    expect(g.artifacts[0].graderId).toBe('review-v1');
  });
  it('a compaction stage vector with a dropped constraint flags constraint_dropped', () => {
    const m = manifest({ category: 'terminal-recovery-compaction', expected: { kind: 'verifier' } });
    const stdout = JSON.stringify({ stages: [{ stage: 1, constraints: { a: false }, testsPass: true }, { stage: 2, constraints: { a: true }, testsPass: true }] });
    const g = gradeRunV2({ ...base, manifest: m, verifier: { ran: true, passed: true, stdout }, outputs: { answer: null } });
    expect(g.flags).toContain('constraint_dropped');
    expect(g.score.result).toBe('fail');
    expect(g.detail.retention).toEqual([0, 1]);
  });
  it('never grades a harness or infra error, and never as a model failure', () => {
    const m = manifest();
    for (const kind of ['harness', 'infra', 'overflow'] as const) {
      const g = gradeRunV2({ ...base, manifest: m, exit: { ...ok, kind }, verifier: { ran: true, passed: false, stdout: '' }, outputs: { answer: null } });
      expect(g.score.result).toBe('error');
      expect(g.score.failureClass).not.toBe('model');
    }
    expect(gradeRunV2({ ...base, manifest: m, exit: null, unsupported: 'toolCalling', verifier: { ran: false, passed: null, stdout: '' }, outputs: { answer: null } }).score).toMatchObject({ result: 'unscored', failureClass: null });
  });
  it('flags tool-budget overrun and budget exhaustion', () => {
    const g = gradeRunV2({ ...base, manifest: manifest(), exit: { ...ok, kind: 'budget_exhausted', toolCalls: 50 }, verifier: { ran: true, passed: true, stdout: '' }, outputs: { answer: '{"citations":[{"file":"a.ts"}]}' } });
    expect(g.flags).toEqual(expect.arrayContaining(['budget_exhausted', 'tool_budget_exceeded']));
  });
  it('tampering: editing or deleting a shipped test, not adding one', () => {
    expect(tamperingV2([{ path: 'test/a.spec.ts', status: 'modified' }, { path: 'test/new.spec.ts', status: 'added' }, { path: 'a.ts', status: 'modified' }], manifest())).toEqual(['modified test test/a.spec.ts']);
  });
});

describe('models, sealed content, readout', () => {
  it('validates the v2 model profile', () => {
    expect(validateModelsV2({ modelsFormatVersion: 2, models: [{ tag: 'a', digest: null, estimatedVramMb: null }] })).toEqual([]);
    expect(validateModelsV2({ modelsFormatVersion: 1, models: [] }).length).toBe(1);
    expect(validateModelsV2({ modelsFormatVersion: 2, models: [{ tag: 'a', digest: null, estimatedVramMb: 0 }, { tag: 'a', digest: null, estimatedVramMb: null }] }).length).toBe(2);
  });
  it('accepts sealed content only when its hash equals the published one', () => {
    const files: CaseFiles = { 'snapshot/a.ts': 'x', 'snapshot/test/a.spec.ts': 't', 'instruction.md': 'i', 'verifier/check.ts': 'v', 'reference/answer.json': 'r', 'candidates/b/answer.json': 'b' };
    const m = manifest({ id: 'sealed-a' });
    m.contentHash = computeContentHash(files, namedPaths(m));
    const d = { id: 'sealed-a', category: 'find-by-behaviour', version: 1, difficulty: 'easy', skills: ['find'], exposing: false, contentHash: m.contentHash };
    expect(verifySealedContent(d, m, files)).toEqual([]);
    expect(verifySealedContent({ ...d, contentHash: 'f'.repeat(64) }, m, files).join()).toContain('does not match the published');
    expect(verifySealedContent({ ...d, version: 2 }, m, files).join()).toContain('version');
  });
  it('reads out per split and category; harness and infra errors are beside the rate, not in it', () => {
    const rec = (o: Partial<RunRecord> & { split?: string; fc?: string | null }): RunRecord => ({
      runId: 'r', suiteId: 's', suiteVersion: 'v2', scoringVersion: 'score-v2', caseId: 'c', trial: 1, configId: 'm@16384', model: { tag: 'm', digest: null, quantization: null }, contextTokens: 16384, promptHash: 'h',
      harness: { name: 'claude-code', version: null }, runtime: null, startedAt: '', endedAt: '', durationMs: 0, inputTokens: null, outputTokens: null, turns: null, peakVramMb: null, vramSamples: null,
      result: 'pass', hidden: { ran: true, passed: true }, visible: { ran: false, passed: null }, tampering: [], leaks: [], review: null, harnessNote: null,
      ...o, v2: { category: 'find-by-behaviour', split: (o.split ?? 'dev') as 'dev', graderId: 'verifier-v1', failureClass: (o.fc ?? null) as null, track: 'single-context' },
    });
    const rows = readoutV2([rec({}), rec({ result: 'fail', fc: 'model' }), rec({ result: 'error', fc: 'harness' }), rec({ result: 'error', fc: 'infra' }), rec({ split: 'sealed-holdout' })]);
    expect(rows).toHaveLength(2);
    const dev = rows.find((r) => r.split === 'dev')!;
    expect(dev).toMatchObject({ runs: 4, pass: 1, modelFail: 1, harnessErrors: 1, infraErrors: 1, passRate: 0.5 });
    expect(rows.find((r) => r.split === 'sealed-holdout')).toMatchObject({ runs: 1, pass: 1 });
  });
});
