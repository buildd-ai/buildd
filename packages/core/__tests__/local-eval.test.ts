import { describe, it, expect } from 'bun:test';
import {
  SCORING_VERSION, validateSuite, buildPrompt, leakFindings, detectTestTampering, scoreRun, runToObservation,
  validateRunRecord, deterministicUuid, parseGpuMemory, gpuGate, digestCheck, admittedCases,
  type Suite, type SuiteCase, type RunRecord,
} from '../local-eval';
import { buildModelComparison, type ComparisonRow } from '../model-comparison';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const kase = (over: Partial<SuiteCase> = {}): SuiteCase => ({
  id: 'case-one', title: 'T', difficulty: 'easy', problem: 'The widget total ignores discounts.',
  reference: { fixSha: SHA_B, preFixSha: SHA_A, subject: 'fix(widget): apply discounts' },
  hiddenTests: ['src/widget.test.ts'], visibleTests: ['src/other.test.ts'], fixTouchesFiles: 1,
  setup: { requires: ['bun'], network: false, credentials: false }, expected: 'Total reflects discounts.',
  contamination: 'Public history.', admission: { preFix: 'fail', reference: 'pass', visibleOnPreFix: 'pass', admittedOn: '2026-11-08', toolchain: 'bun' },
  ...over,
});
const suite = (cases: SuiteCase[] = [kase()]): Suite => ({
  suiteId: 's', suiteVersion: 'v1', formatVersion: 1, scoringVersion: SCORING_VERSION,
  policy: { promptTemplate: 'Fix this.\n\n{{problem}}', maxTurns: 40, wallClockSeconds: 1800, contextTokens: [16384, 32768], trials: 3, context: 'problem-and-pre-fix-tree-only' },
  cases,
});

describe('validateSuite', () => {
  it('accepts a well-formed admitted suite', () => expect(validateSuite(suite())).toEqual([]));
  it('refuses a problem that leaks the fix sha, a hidden test path or a PR number', () => {
    expect(validateSuite(suite([kase({ problem: `see ${SHA_B}` })])).join()).toContain('leaks');
    expect(validateSuite(suite([kase({ problem: 'edit src/widget.test.ts' })])).join()).toContain('leaks');
    expect(validateSuite(suite([kase({ problem: 'fixed in (#123)' })])).join()).toContain('cites a PR');
  });
  it('refuses admission without a failing pre-fix run and a passing reference', () => {
    const bad = kase({ admission: { preFix: 'pass', reference: 'pass', visibleOnPreFix: 'pass', admittedOn: '2026-11-08', toolchain: 'bun' } });
    expect(validateSuite(suite([bad])).join()).toContain('did not fail on the pre-fix');
    const unrun = kase({ admission: { preFix: 'unrun', reference: 'unrun', visibleOnPreFix: 'unrun', admittedOn: null, toolchain: 'bun' } });
    expect(validateSuite(suite([unrun]))).toEqual([]);
    expect(admittedCases(suite([unrun]))).toEqual([]);
  });
  it('requires a contamination note, no network and no credentials', () => {
    expect(validateSuite(suite([kase({ contamination: ' ' })])).join()).toContain('contamination');
    expect(validateSuite(suite([kase({ setup: { requires: [], network: true as never, credentials: false } })])).join()).toContain('no network');
  });
  it('refuses duplicate ids and a case whose test is both hidden and visible', () => {
    expect(validateSuite(suite([kase(), kase()])).join()).toContain('duplicate');
    expect(validateSuite(suite([kase({ visibleTests: ['src/widget.test.ts'] })])).join()).toContain('both hidden and visible');
  });
});

describe('buildPrompt', () => {
  it('is identical for the same case and carries only the problem', () => {
    const s = suite();
    const a = buildPrompt(s, s.cases[0]);
    expect(a.text).toContain('widget total');
    expect(a.text).not.toContain(SHA_B);
    expect(buildPrompt(s, s.cases[0]).hash).toBe(a.hash);
  });
});

describe('grading isolation', () => {
  const c = kase();
  it('is clean for a one-commit export without hidden material', () => {
    expect(leakFindings(c, { paths: ['src/widget.ts', 'src/other.test.ts', 'src/widget.test.ts'], answerBearingTests: [], commits: ['c'.repeat(40)], remotes: [] })).toEqual([]);
  });
  it('flags hidden tests, history, the fix commit, remotes and grading material', () => {
    const f = leakFindings(c, { paths: ['eval/local-suite/v1/suite.json', 'reference.patch'], answerBearingTests: ['src/widget.test.ts'], commits: [SHA_A, SHA_B], remotes: ['origin'] }).join('\n');
    expect(f).toContain('hidden test present');
    expect(f).toContain('grading material');
    expect(f).toContain('2 commits');
    expect(f).toContain('fix commit');
    expect(f).toContain('remote');
  });
});

describe('detectTestTampering', () => {
  const c = kase();
  it('allows adding tests and editing source', () => {
    expect(detectTestTampering([
      { path: 'src/widget.ts', status: 'modified', patch: '-a\n+b' },
      { path: 'src/new.test.ts', status: 'added', patch: '+it("x", () => { expect(1).toBe(1) })' },
    ], c)).toEqual([]);
  });
  it('catches skipped tests, deleted tests, removed assertions and runner edits', () => {
    const f = detectTestTampering([
      { path: 'src/other.test.ts', status: 'modified', patch: '-  expect(a).toBe(1)\n-  expect(b).toBe(2)\n+  // gone' },
      { path: 'src/a.test.ts', status: 'modified', patch: '+it.skip("x", () => {})' },
      { path: 'src/b.test.ts', status: 'deleted', patch: '' },
      { path: 'bunfig.toml', status: 'modified', patch: '+x' },
      { path: 'package.json', status: 'modified', patch: '-    "test": "bun run a"\n+    "test": "true"' },
    ], c).join('\n');
    expect(f).toContain('assertions removed');
    expect(f).toContain('test disabled');
    expect(f).toContain('test file deleted');
    expect(f).toContain('bunfig.toml');
    expect(f).toContain('package.json');
  });
  it('ignores a dependency edit in package.json', () => {
    expect(detectTestTampering([{ path: 'package.json', status: 'modified', patch: '-"x": "1"\n+"x": "2"' }], c)).toEqual([]);
  });
});

describe('scoreRun', () => {
  const ok = { ran: true, passed: true as boolean | null };
  const base = { harnessError: false, hidden: ok, visible: ok, tampering: [] as string[], leaks: [] as string[] };
  it('passes only with hidden and visible green, no tampering, no leaks', () => {
    expect(scoreRun(base)).toBe('pass');
    expect(scoreRun({ ...base, hidden: { ran: true, passed: false } })).toBe('fail');
    expect(scoreRun({ ...base, visible: { ran: true, passed: false } })).toBe('fail');
    expect(scoreRun({ ...base, tampering: ['x'] })).toBe('invalid');
    expect(scoreRun({ ...base, leaks: ['x'] })).toBe('invalid');
    expect(scoreRun({ ...base, hidden: { ran: false, passed: null } })).toBe('unscored');
    expect(scoreRun({ ...base, harnessError: true })).toBe('error');
  });
  it('does not require patch equality: an alternative fix that passes passes', () => {
    expect(scoreRun(base)).toBe('pass');
  });
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: 'r1', suiteId: 's', suiteVersion: 'v1', scoringVersion: SCORING_VERSION, caseId: 'case-one', trial: 1,
  configId: 'model-x@16384', model: { tag: 'model-x', digest: null, quantization: null }, contextTokens: 16384, promptHash: 'abc',
  harness: { name: 'claude-code', version: null }, runtime: null, startedAt: '2026-11-08T00:00:00Z', endedAt: '2026-11-08T00:05:00Z',
  durationMs: 300000, inputTokens: null, outputTokens: null, turns: null, peakVramMb: null, vramSamples: null,
  result: 'pass', hidden: { ran: true, passed: true }, visible: { ran: true, passed: true }, tampering: [], leaks: [], review: null, harnessNote: null,
  ...over,
});

describe('runToObservation', () => {
  const scope = { workspaceId: 'w', teamId: 't' };
  it('keeps unmeasured metrics unknown, never zero', () => {
    const { values } = runToObservation(run(), scope);
    expect(values.inputTokens).toBeNull();
    expect(values.peakVramMb).toBeNull();
    expect(values.modelVersion).toBeNull();
    expect(values.costUsd).toBeNull();
    expect(values.unavailable.peakVramMb).toBeTruthy();
    expect(values.endpointKind).toBe('local_loopback');
  });
  it('gives every configuration on one case the same chain, and one run one stable worker id', () => {
    const a = runToObservation(run({ runId: 'a', configId: 'm1@16384' }), scope);
    const b = runToObservation(run({ runId: 'b', configId: 'm2@16384' }), scope);
    expect(a.values.chainId).toBe(b.values.chainId);
    expect(a.values.workerId).not.toBe(b.values.workerId);
    expect(runToObservation(run({ runId: 'a' }), scope).values.workerId).toBe(a.values.workerId);
    expect(a.evaluation).toMatchObject({ provenance: 'controlled_replay', caseId: 'case-one', configId: 'm1@16384', suiteVersion: 'v1' });
  });
  it('maps results to independent evidence and a harness error to a harness failure', () => {
    expect(runToObservation(run(), scope).evidence).toMatchObject({ specVerdict: 'pass', ciState: 'passed', reviewVerdict: null, reworked: false });
    const f = runToObservation(run({ result: 'fail', review: { reviewer: 'r', rubricVersion: '1', verdict: 'changes_requested', reworkRounds: 2 } }), scope).evidence;
    expect(f).toMatchObject({ specVerdict: 'fail', reviewVerdict: 'changes_requested', reworked: true });
    const e = runToObservation(run({ result: 'error', hidden: { ran: false, passed: null }, visible: { ran: false, passed: null } }), scope);
    expect(e.values.failureOrigin).toBe('harness');
    expect(e.evidence.specVerdict).toBeNull();
  });
});

describe('validateRunRecord', () => {
  it('accepts a record and refuses a wrong scoring version or missing ids', () => {
    expect(validateRunRecord(run())).toEqual([]);
    expect(validateRunRecord({ ...run(), scoringVersion: 'score-v0' }).join()).toContain('scoringVersion');
    expect(validateRunRecord({}).length).toBeGreaterThan(3);
    expect(validateRunRecord(null).length).toBeGreaterThan(3);
  });
  it('refuses records the mapper would crash on or the database would reject', () => {
    const { harness: _h, ...noHarness } = run();
    const { visible: _v, ...noVisible } = run();
    expect(validateRunRecord(noHarness).join()).toContain('harness');
    expect(validateRunRecord(noVisible).join()).toContain('visible');
    expect(validateRunRecord({ ...run(), durationMs: '300' }).join()).toContain('durationMs');
    expect(validateRunRecord({ ...run(), peakVramMb: Infinity }).join()).toContain('peakVramMb');
    expect(validateRunRecord({ ...run(), tampering: [1] }).join()).toContain('tampering');
    expect(validateRunRecord({ ...run(), review: { verdict: 'x' } }).join()).toContain('review');
    expect(validateRunRecord({ ...run(), model: { tag: 'x'.repeat(500), digest: null, quantization: null } }).join()).toContain('model.tag');
  });
});

describe('replay tool efficiency (validate -> mapping)', () => {
  const scope = { workspaceId: 'w', teamId: 't' };
  const aggregate = () => ({
    schemaVersion: 1, analyserVersion: 'tea-v1', harness: 'claude', calls: 7,
    findingKinds: { identical_search_unchanged: 1, redundant_read_unchanged: 2 },
    failureClasses: { error: 1 },
    timing: { observedCalls: 0, totalMs: 0, p50Ms: null, p90Ms: null, maxMs: null },
    coverage: { recorded: 7, dropped: 0, unobserved: 1, sampledOut: 0 },
  });
  const te = (over: Record<string, unknown> = {}) => ({ aggregate: aggregate(), source: 'claude_stream_json', timing: 'unknown', ...over });

  it('carries a bounded aggregate onto the row and its provenance onto the evaluation', () => {
    const r = run({ toolEfficiency: te() as never });
    expect(validateRunRecord(r)).toEqual([]);
    const { values, evaluation } = runToObservation(r, scope);
    expect(values.toolEfficiency).toMatchObject({ analyserVersion: 'tea-v1', calls: 7, findingKinds: { identical_search_unchanged: 1, redundant_read_unchanged: 2 }, failureClasses: { error: 1 } });
    expect(values.toolEfficiency!.timing).toEqual({ observedCalls: 0, totalMs: 0, p50Ms: null, p90Ms: null, maxMs: null });
    expect(values.unavailable.toolEfficiency).toBeUndefined();
    expect(evaluation.toolEfficiency).toEqual({ source: 'claude_stream_json', timing: 'unknown', analyserVersion: 'tea-v1' });
  });

  it('a record without a trace keeps tool efficiency unknown, not clean (backward compatible)', () => {
    for (const r of [run(), run({ toolEfficiency: null })]) {
      expect(validateRunRecord(r)).toEqual([]);
      const { values, evaluation } = runToObservation(r, scope);
      expect(values.toolEfficiency).toBeNull();
      expect(values.unavailable.toolEfficiency).toBeTruthy();
      expect(evaluation.toolEfficiency).toBeUndefined();
    }
  });

  it('secrets, raw text and unknown fields inside the aggregate never reach the row', () => {
    const dirty = {
      ...aggregate(),
      command: 'grep -r sk-live-secret /home/me/src', paths: ['/home/me/src/a.ts'], fingerprint: 'abc123', claims: ['done'],
      findingKinds: { identical_search_unchanged: 1, made_up_kind: 4, prompt: 'leak' },
      review: { reviewerVersion: 'rev-v1', candidates: 1, confirmed: 0, dismissed: 0, kinds: {}, excerpt: 'ghp_token' },
    };
    const r = run({ toolEfficiency: te({ aggregate: dirty }) as never });
    expect(validateRunRecord(r)).toEqual([]);
    const stored = JSON.stringify(runToObservation(r, scope));
    for (const s of ['sk-live', '/home/me', 'abc123', 'claims', 'made_up_kind', 'leak', 'ghp_', 'excerpt', 'command']) expect(stored).not.toContain(s);
  });

  it('refuses unknown wrapper fields, unknown provenance and invented timings', () => {
    expect(validateRunRecord(run({ toolEfficiency: te({ prompt: 'the whole prompt' }) as never })).join()).toContain('toolEfficiency.prompt');
    expect(validateRunRecord(run({ toolEfficiency: te({ source: 'somewhere' }) as never })).join()).toContain('toolEfficiency.source');
    expect(validateRunRecord(run({ toolEfficiency: te({ timing: 'exact' }) as never })).join()).toContain('toolEfficiency.timing');
    expect(validateRunRecord(run({ toolEfficiency: te({ aggregate: { ...aggregate(), schemaVersion: 99 } }) as never })).join()).toContain('toolEfficiency.aggregate');
    expect(validateRunRecord(run({ toolEfficiency: 'x' as never })).join()).toContain('toolEfficiency');
    // Timing the source could not observe is not recorded as measured.
    const timed = { ...aggregate(), timing: { observedCalls: 3, totalMs: 30, p50Ms: 10, p90Ms: 10, maxMs: 10 } };
    expect(validateRunRecord(run({ toolEfficiency: te({ aggregate: timed }) as never })).join()).toContain('timing');
    expect(validateRunRecord(run({ toolEfficiency: te({ aggregate: timed, source: 'claude_stream_json', timing: 'measured' }) as never })).join()).toContain('measured');
    expect(validateRunRecord(run({ toolEfficiency: te({ aggregate: timed, source: 'claude_transcript', timing: 'approximate' }) as never }))).toEqual([]);
    expect(validateRunRecord(run({ toolEfficiency: te({ aggregate: timed, source: 'runner_trace', timing: 'measured' }) as never }))).toEqual([]);
  });
});

describe('GPU gate and digests', () => {
  it('parses nvidia-smi and refuses unreadable, busy or already-loaded GPUs', () => {
    expect(parseGpuMemory('1200, 24576\n')).toEqual([{ usedMb: 1200, totalMb: 24576 }]);
    expect(parseGpuMemory('garbage')).toBeNull();
    expect(gpuGate({ gpus: null, loadedModels: [], minFreeMb: 1 }).ok).toBe(false);
    expect(gpuGate({ gpus: [{ usedMb: 100, totalMb: 24000 }], loadedModels: ['m'], minFreeMb: 1 }).reason).toContain('unload');
    expect(gpuGate({ gpus: [{ usedMb: 20000, totalMb: 24000 }], loadedModels: [], minFreeMb: 18000 }).ok).toBe(false);
    expect(gpuGate({ gpus: [{ usedMb: 100, totalMb: 24000 }], loadedModels: [], minFreeMb: 18000 }).ok).toBe(true);
  });
  it('records a first digest and rejects a changed one', () => {
    expect(digestCheck(null, 'abc').ok).toBe(true);
    expect(digestCheck('abc', 'abc').ok).toBe(true);
    expect(digestCheck('abc', 'def').ok).toBe(false);
    expect(digestCheck('abc', null).ok).toBe(false);
  });
  it('makes uuid-shaped deterministic ids', () => {
    expect(deterministicUuid('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicUuid('x')).toBe(deterministicUuid('x'));
  });
});

describe('comparison keeps replay apart from production', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  const row = (over: Partial<ComparisonRow>): ComparisonRow => ({
    workerId: 'w', taskId: null, chainId: null, resolvedModel: 'm', endpointKind: 'local_loopback', modelVersion: null, quantization: null,
    backend: null, harnessVersion: null, runtime: null, taskClass: null, startedAt: now, endedAt: null, createdAt: now, durationMs: 1, inputTokens: null,
    outputTokens: null, tokensPerSecond: null, terminalOutcome: 'completed', failureOrigin: 'none', costUsd: null, reviewVerdict: null, ciState: null,
    specVerdict: null, prOutcome: null, reworked: false, ...over,
  });
  const ev = (configId: string, caseId: string, result: string, trial = 1) => ({ provenance: 'controlled_replay', suiteVersion: 'v1', scoringVersion: SCORING_VERSION, configId, caseId, trial, result });

  it('excludes replay rows from production figures and reports them under replay', () => {
    const rows = [
      row({ workerId: 'p1', specVerdict: 'pass' }),
      row({ workerId: 'e1', resolvedModel: 'm1', specVerdict: 'pass', evaluation: ev('m1@16384', 'c1', 'pass') }),
      row({ workerId: 'e2', resolvedModel: 'm2', specVerdict: 'fail', evaluation: ev('m2@16384', 'c1', 'fail') }),
      row({ workerId: 'e3', resolvedModel: 'm2', evaluation: ev('m2@16384', 'c2', 'error'), terminalOutcome: 'failed' }),
    ];
    const out = buildModelComparison(rows, { window: '24h' }, { now });
    expect(out.totals.attempts).toBe(1);
    expect(out.configs).toHaveLength(1);
    expect(out.replay.design).toBe('controlled_replay');
    expect(out.replay.configs.map((c) => c.configId)).toEqual(['m1@16384', 'm2@16384']);
    expect(out.replay.commonCases).toEqual(['c1']);
    const m2 = out.replay.configs[1].cases;
    expect(m2).toEqual([{ caseId: 'c1', trials: 1, passes: 0, harnessErrors: 0 }, { caseId: 'c2', trials: 0, passes: 0, harnessErrors: 1 }]);
    expect(out.replay.verdict).toBe('not_computed');
    expect(out.autoPromote).toBe(false);
  });
  it('says no_runs when nothing was replayed', () => {
    expect(buildModelComparison([row({})], { window: '24h' }, { now }).replay.verdict).toBe('no_runs');
  });
});
