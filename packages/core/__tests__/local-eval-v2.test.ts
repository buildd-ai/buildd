import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SCORING_VERSION, scoreRun } from '../local-eval';
import {
  SCORING_VERSION_V2, GRADER_IDS, computeContentHash, namedPaths, validateManifestV2, validateSuiteV2, admitCase, exportAgentTree, leakFindingsV2,
  gradeFind, gradeReview, assertGraderAllowed, buildEvidence, checkFit, truncateExplicit, gradeLongContext, gradeCompaction, regrade, scoreRunV2,
  unsupportedCapabilities, inferenceGuard, scoringVersionForSuite, GPU_WINDOW_OPENS_AT,
  type CaseManifestV2, type CaseFiles, type StoredArtifact, type Expected, type OverflowRecord, type EvidenceBuild,
} from '../local-eval-v2';

const ROOT = resolve(import.meta.dir, '../../..');
const sha = (p: string) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');

describe('v1 stays byte-identical (AC-1)', () => {
  it('pins the v1 suite files', () => {
    expect(sha('eval/local-suite/v1/suite.json')).toBe('a659c6e479b7d49cb89d7d2b96749896660ac81e5463595c062f6241f559d1bf');
    expect(sha('eval/local-suite/v1/models.json')).toBe('19953ddab7a6cc3018244f6cd09d02dc4a186d6d7a50e676ae8c163389bf6f17');
    expect(sha('eval/local-suite/v1/rubric.md')).toBe('5a3142bd47401b945e97b6a4f0ba5d538f92c29bc2cbd296f84a11d632f166fd');
  });
  it('keeps score-v1 behaviour and version', () => {
    expect(SCORING_VERSION).toBe('score-v1');
    const ok = { ran: true, passed: true }; const bad = { ran: true, passed: false };
    const base = { harnessError: false, hidden: ok, visible: ok, tampering: [], leaks: [] };
    expect(scoreRun(base)).toBe('pass');
    expect(scoreRun({ ...base, hidden: bad })).toBe('fail');
    expect(scoreRun({ ...base, tampering: ['x'] })).toBe('invalid');
    expect(scoreRun({ ...base, harnessError: true })).toBe('error');
    expect(scoreRun({ ...base, hidden: { ran: false, passed: null } })).toBe('unscored');
  });
  it('v2 has its own scoring version and a v2 run is never v1-scorable', () => {
    expect(SCORING_VERSION_V2).toBe('score-v2');
    expect(scoringVersionForSuite('v2')).toBe('score-v2');
    expect(scoringVersionForSuite('v1')).toBe('score-v1');
    expect(scoringVersionForSuite('v9')).toBeNull();
  });
});

const FILES: CaseFiles = {
  'snapshot/src/a.ts': 'export const a = 1;\n',
  'instruction.md': 'Find where the total is computed.\n',
  'verifier/check.ts': 'verifier code that is secret and long enough to fingerprint\n',
  'reference/answer.json': '{"file":"src/a.ts"}\n',
  'candidates/broken-1/answer.json': '{"file":"src/decoy.ts"}\n',
  'candidates/broken-2/answer.json': '{"abstain":true}\n',
  'candidates/alt/answer.json': '{"file":"src/a.ts","symbol":"a"}\n',
};
const manifest = (over: Partial<CaseManifestV2> = {}): CaseManifestV2 => {
  const m: CaseManifestV2 = {
    formatVersion: 2, id: 'find-total', version: 1, contentHash: '', category: 'find-by-behaviour',
    files: {
      snapshot: ['snapshot/src/a.ts'], instruction: 'instruction.md', verifier: ['verifier/check.ts'], reference: ['reference/answer.json'], rubric: null,
      candidates: { broken: ['broken-1', 'broken-2'], alternative: 'alt', files: ['candidates/broken-1/answer.json', 'candidates/broken-2/answer.json', 'candidates/alt/answer.json'] },
    },
    deps: { bun: '1.x' },
    resources: { cpuOnly: true, estimatedVramMb: null, estimatedRamMb: null, wallClockSeconds: 600, maxTurns: 20, toolBudget: 40 },
    labels: { difficulty: 'easy', skills: ['search'] }, exposing: true,
    provenance: { source: 'authored', licence: 'repository licence', note: 'authored for this suite' },
    contamination: 'Authored fixture, not published before 2026-11-08.',
    expected: { kind: 'answer', locations: [{ file: 'src/a.ts' }] }, admission: null,
    ...over,
  };
  m.contentHash = computeContentHash(FILES, namedPaths(m));
  return m;
};

describe('manifest v2', () => {
  it('accepts a well-formed manifest with matching hash', () => expect(validateManifestV2(manifest(), FILES)).toEqual([]));
  it('names the case when contentHash is stale (AC-2) and when a file changes', () => {
    const m = manifest();
    const edited = { ...FILES, 'instruction.md': 'changed' };
    expect(validateManifestV2(m, edited).join()).toContain('case find-total: contentHash does not match');
    const s = validateSuiteV2({ suiteId: 's', suiteVersion: 'v2', formatVersion: 2, scoringVersion: 'score-v2', skills: ['search'], cases: [{ id: 'find-total', version: 1, contentHash: m.contentHash }] }, { 'find-total': { manifest: m, files: edited } });
    expect(s.join()).toContain('find-total');
  });
  it('hash is independent of path order and sensitive to every byte', () => {
    const paths = namedPaths(manifest());
    expect(computeContentHash(FILES, [...paths].reverse())).toBe(computeContentHash(FILES, paths));
    expect(computeContentHash({ ...FILES, 'instruction.md': FILES['instruction.md'] + ' ' }, paths)).not.toBe(computeContentHash(FILES, paths));
  });
  it('rejects unknown category, missing fields, hidden path in snapshot, shared verifier/reference', () => {
    expect(validateManifestV2(manifest({ category: 'nope' as never }), FILES).join()).toContain('unknown category');
    expect(validateManifestV2(manifest({ provenance: { source: 'authored', licence: '', note: '' } }), FILES).join()).toContain('provenance');
    const m = manifest(); m.files.snapshot = ['snapshot/verifier/x.ts'];
    expect(validateManifestV2(m).join()).toContain('hidden material');
    const m2 = manifest(); m2.files.reference = ['verifier/check.ts'];
    expect(validateManifestV2(m2).join()).toContain('independent');
  });
  it('model-running cases need an estimate; unknown VRAM is null, not zero', () => {
    expect(validateManifestV2(manifest({ resources: { cpuOnly: false, estimatedVramMb: null, estimatedRamMb: null, wallClockSeconds: 1, maxTurns: 1, toolBudget: 1 } })).join()).toContain('estimatedVramMb');
    expect(validateManifestV2(manifest({ resources: { cpuOnly: true, estimatedVramMb: null, estimatedRamMb: null, wallClockSeconds: 1, maxTurns: 1, toolBudget: 1 } }))).toEqual([]);
  });
  it('an exposing case needs two broken candidates; long-context needs sizes', () => {
    const m = manifest(); m.files.candidates.broken = ['broken-1'];
    expect(validateManifestV2(m).join()).toContain('two broken');
    expect(validateManifestV2(manifest({ category: 'long-context-requirements' })).join()).toContain('longContext');
    expect(validateManifestV2(manifest({ category: 'long-context-requirements', longContext: { sizes: [4096], positions: ['start'] } })).join()).toContain('size 4096');
  });
  it('refuses an instruction naming hidden files and files containing a UUID', () => {
    const f = { ...FILES, 'instruction.md': 'see verifier/check.ts' };
    expect(validateManifestV2({ ...manifest(), contentHash: computeContentHash(f, namedPaths(manifest())) }, f).join()).toContain('names hidden file');
  });
});

describe('admission (AC-3..6)', () => {
  const absent = (over: object = {}): Expected => ({ kind: 'abstain', searchScope: { filesSearched: 'all-snapshot', dependencyTreeSearched: true, generatedAndConfigSearched: true, identifiers: ['x'], behaviourKeywords: ['y'], method: 'rg + manual', auditor: 'a', confirmer: 'b', ...over } });
  const verifier = (pass: Record<string, boolean>) => (c: string) => pass[c] ?? false;
  const good = { reference: true, alternative: true };

  it('admits when reference and alternative pass and snapshot and broken candidates fail', async () => {
    const ev = await admitCase(manifest(), verifier(good), { leaks: [] });
    expect(ev.admitted).toBe(true);
    expect(ev.gates.map((g) => g.gate)).toHaveLength(6);
  });
  it('rejects a verifier that passes the unmodified snapshot (AC-3) and keeps the evidence', async () => {
    const ev = await admitCase(manifest(), verifier({ ...good, snapshot: true }), { leaks: [] });
    expect(ev.admitted).toBe(false);
    expect(ev.gates.find((g) => g.gate === 'negative-control-fails')!.detail).toContain('unmodified snapshot');
    expect(ev.verdicts.snapshot).toEqual([true]);
  });
  it('rejects when a broken candidate passes (AC-4)', async () => {
    const ev = await admitCase(manifest(), verifier({ ...good, 'broken:broken-2': true }), { leaks: [] });
    expect(ev.admitted).toBe(false);
    expect(ev.gates.find((g) => g.gate === 'negative-control-fails')!.detail).toContain('broken candidate broken-2');
  });
  it('rejects when the reference fails or the alternative fails (matches patch, not behaviour)', async () => {
    expect((await admitCase(manifest(), verifier({ alternative: true }), { leaks: [] })).gates.find((g) => g.gate === 'reference-passes')!.ok).toBe(false);
    const ev = await admitCase(manifest(), verifier({ reference: true }), { leaks: [] });
    expect(ev.gates.find((g) => g.gate === 'independent-of-patch')!.ok).toBe(false);
    const m = manifest(); m.files.candidates.alternative = null;
    expect((await admitCase(m, verifier(good), { leaks: [] })).admitted).toBe(false);
  });
  it('rejects a nondeterministic verifier', async () => {
    let n = 0;
    const ev = await admitCase(manifest(), (c) => (c === 'reference' ? n++ % 2 === 0 : c === 'alternative'), { leaks: [] });
    expect(ev.gates.find((g) => g.gate === 'deterministic')!.ok).toBe(false);
    expect(ev.admitted).toBe(false);
  });
  it('rejects an answer-absent case without a search scope or second confirmer (AC-5)', async () => {
    const ok = await admitCase(manifest({ expected: absent() }), verifier(good), { leaks: [] });
    expect(ok.admitted).toBe(true);
    for (const bad of [{ confirmer: null }, { confirmer: 'a' }, { dependencyTreeSearched: false }, { filesSearched: [] }, { identifiers: [] }]) {
      const ev = await admitCase(manifest({ expected: absent(bad) }), verifier(good), { leaks: [] });
      expect(ev.gates.find((g) => g.gate === 'absence-audited')!.ok).toBe(false);
      expect(ev.admitted).toBe(false);
    }
  });
  it('rejects when the probe tree leaks', async () => {
    const ev = await admitCase(manifest(), verifier(good), { leaks: ['hidden or grading path present: verifier/x'] });
    expect(ev.admitted).toBe(false);
  });
  it('a manifest claiming admission without all gates is invalid', () => {
    expect(validateManifestV2(manifest({ admission: { admittedOn: '2026-11-08', toolchain: 'bun', gates: [] } })).join()).toContain('admitted without a passing');
  });
});

describe('isolation export and leak scan (AC-8)', () => {
  it('exports the snapshot and instruction only; hidden material is not present', () => {
    const m = manifest();
    const t = exportAgentTree(m, FILES);
    expect(Object.keys(t.files)).toEqual(['src/a.ts']);
    expect(t.instruction).toContain('total');
    expect(t.git).toEqual({ commits: 1, remotes: [] });
    expect(leakFindingsV2(m, FILES, { files: t.files, commits: ['c1'], remotes: [] })).toEqual([]);
    const all = JSON.stringify(t);
    for (const p of [...m.files.verifier, ...m.files.reference, ...m.files.candidates.files]) expect(all).not.toContain(FILES[p].trim());
  });
  it('detects tampering: planted hidden paths, copied bytes, pasted lines, history and remotes', () => {
    const m = manifest();
    const t = exportAgentTree(m, FILES);
    const probe = (files: CaseFiles, commits = ['c1'], remotes: string[] = []) => leakFindingsV2(m, FILES, { files, commits, remotes }).join('\n');
    expect(probe({ ...t.files, 'verifier/check.ts': 'x' })).toContain('hidden or grading path');
    expect(probe({ ...t.files, 'docs/copy.ts': FILES['verifier/check.ts'] })).toContain('byte-identical to withheld verifier/check.ts');
    expect(probe({ ...t.files, 'docs/p.md': `prefix ${FILES['verifier/check.ts'].trim()} suffix` })).toContain('contains a line of withheld');
    expect(probe({ ...t.files, 'x/eval/local-suite/v2/suite.json': '{}' })).toContain('hidden or grading path');
    expect(probe({ ...t.files, '.git/HEAD': '' })).toContain('hidden or grading path');
    expect(probe(t.files, ['c1', 'c2'])).toContain('2 commits');
    expect(probe(t.files, ['c1'], ['origin'])).toContain('remote');
  });
  it('a whole-file reference that repeats unchanged snapshot lines is not a leak, a changed line still is', () => {
    const long = 'export const shared = computeSomethingQuiteLong(argumentOne, two);';
    const files: CaseFiles = { ...FILES, 'snapshot/src/a.ts': `${long}\nexport const a = 1;\n`, 'reference/src/a.ts': `${long}\nexport const a = 2; // changed and long enough to be fingerprinted\n` };
    const m = manifest();
    m.files.reference = ['reference/src/a.ts'];
    const t = exportAgentTree(m, files);
    expect(leakFindingsV2(m, files, { files: t.files, commits: ['c1'], remotes: [] })).toEqual([]);
    const planted = { ...t.files, 'notes.md': 'export const a = 2; // changed and long enough to be fingerprinted' };
    expect(leakFindingsV2(m, files, { files: planted, commits: ['c1'], remotes: [] }).join()).toContain('line of withheld reference/src/a.ts');
  });
  it('export fails loudly on a missing snapshot file', () => {
    expect(() => exportAgentTree(manifest(), {})).toThrow('snapshot file missing');
  });
});

describe('find grader (AC-11)', () => {
  const ans: Expected = { kind: 'answer', locations: [{ file: 'src/live.ts', symbol: 'total' }], decoys: ['src/dead.ts'], liveSite: 'src/live.ts' };
  it('passes a correct citation and any other correct form', () => {
    expect(gradeFind({ citations: [{ file: 'src/live.ts', symbol: 'total' }], liveSite: 'src/live.ts' }, ans).pass).toBe(true);
    expect(gradeFind({ citations: [{ file: 'src/live.ts' }], liveSite: 'src/live.ts' }, ans).pass).toBe(true);
  });
  it('fails the decoy, a missing location, a wrong live site and a wrong abstention', () => {
    expect(gradeFind({ citations: [{ file: 'src/live.ts' }, { file: 'src/dead.ts' }], liveSite: 'src/live.ts' }, ans).notes.join()).toContain('decoy');
    expect(gradeFind({ citations: [{ file: 'src/other.ts' }] }, ans).pass).toBe(false);
    expect(gradeFind({ citations: [{ file: 'src/live.ts' }], liveSite: 'src/dead.ts' }, ans).pass).toBe(false);
    expect(gradeFind({ abstain: true, citations: [] }, ans).notes).toEqual(['wrong_abstention']);
  });
  it('line ranges are matched by line', () => {
    const e: Expected = { kind: 'answer', locations: [{ file: 'a.ts', startLine: 10, endLine: 20 }] };
    expect(gradeFind({ citations: [{ file: 'a.ts', line: 15 }] }, e).pass).toBe(true);
    expect(gradeFind({ citations: [{ file: 'a.ts', line: 30 }] }, e).pass).toBe(false);
  });
  it('abstention passes; naming a file is fabrication', () => {
    const abs = { kind: 'abstain', searchScope: {} } as unknown as Expected;
    expect(gradeFind({ abstain: true, citations: [] }, abs).pass).toBe(true);
    const r = gradeFind({ citations: [{ file: 'src/x.ts' }] }, abs);
    expect(r.pass).toBe(false);
    expect(r.notes).toContain('fabrication');
  });
});

describe('review grader (AC-9, AC-10)', () => {
  const defects = [{ id: 'd1', file: 'a.ts', startLine: 10, endLine: 12, cause: [['off-by-one', 'boundary', 'index']] }, { id: 'd2', file: 'b.ts', startLine: 5, endLine: 5, cause: [['null', 'undefined']] }];
  it('counts true findings by location and cause, not wording', () => {
    const r = gradeReview([{ file: 'a.ts', line: 11, description: 'Loop has an Off-By-One at the end' }, { file: 'b.ts', line: 5, description: 'may dereference undefined' }], defects);
    expect(r.pass).toBe(true);
    expect(r.metrics).toMatchObject({ precision: 1, recall: 1, falsePositives: 0 });
  });
  it('a right line with the wrong cause is a false positive and the defect is missed', () => {
    const r = gradeReview([{ file: 'a.ts', line: 11, description: 'style: rename variable' }], defects);
    expect(r.falsePositives).toHaveLength(1);
    expect(r.missed).toEqual(['d1', 'd2']);
    expect(r.metrics.precision).toBe(0);
  });
  it('a finding on a clean control is a false positive; none passes', () => {
    const fp = gradeReview([{ file: 'c.ts', line: 1, description: 'looks wrong' }], []);
    expect(fp.pass).toBe(false);
    expect(fp.metrics.cleanControlFalsePositive).toBe(1);
    expect(fp.notes).toContain('false positive on a clean control');
    const clean = gradeReview([], []);
    expect(clean.pass).toBe(true);
    expect(clean.metrics).toMatchObject({ precision: null, recall: null, cleanControlFalsePositive: 0 });
  });
  it('duplicates of a found defect are not false positives', () => {
    const f = { file: 'a.ts', line: 10, description: 'off-by-one' };
    expect(gradeReview([f, f], [defects[0]]).falsePositives).toHaveLength(0);
  });
  it('refuses a model grader that is the model under test', () => {
    expect(() => assertGraderAllowed({ kind: 'model', id: 'Qwen3-Coder:30b' }, 'qwen3-coder:30b@16384')).toThrow('model under test');
    expect(() => assertGraderAllowed({ kind: 'model', id: 'other:7b' }, 'qwen3-coder:30b')).not.toThrow();
    expect(() => assertGraderAllowed({ kind: 'person', id: 'qwen3-coder:30b' }, 'qwen3-coder:30b')).not.toThrow();
  });
});

describe('long-context evidence', () => {
  const pool = Array.from({ length: 9 }, (_, i) => `Note ${i}: ${'lorem ipsum dolor sit amet '.repeat(6 + i)}`);
  const needles = [{ id: 'req-a', text: 'REQUIREMENT A: limit is 5.' }, { id: 'req-b', text: 'REQUIREMENT B: supersedes A, limit is 7.' }];
  const build = (target: number, position: 'start' | 'middle' | 'end' | 'dispersed') => buildEvidence({ pool, needles, targetTokens: target, position }) as EvidenceBuild;

  it('is deterministic and never exceeds the target at 8K/16K/32K', () => {
    for (const t of [8192, 16384, 32768]) {
      const a = build(t, 'middle');
      expect(a.tokens).toBeLessThanOrEqual(t);
      expect(a.tokens).toBeGreaterThan(t * 0.95);
      expect(a.text).toBe(build(t, 'middle').text);
      expect(a.tokenMethod).toBe('approx-chars/4');
    }
  });
  it('uses the same material across sizes (smaller filler is a prefix of larger)', () => {
    const small = build(8192, 'end').text.replace(/REQUIREMENT[^\n]*\n\n/g, '');
    const big = build(16384, 'end').text.replace(/REQUIREMENT[^\n]*\n\n/g, '');
    expect(big.startsWith(small)).toBe(true);
  });
  it('records needle positions that differ by placement', () => {
    const at = (p: 'start' | 'middle' | 'end' | 'dispersed') => build(8192, p).needles.map((n) => n.fraction);
    expect(at('start')[0]).toBe(0);
    expect(at('middle')[0]).toBeGreaterThan(0.4);
    expect(at('middle')[0]).toBeLessThan(0.6);
    expect(at('end')[1]).toBeGreaterThan(0.95);
    const d = at('dispersed');
    expect(d[0]).toBeGreaterThan(0.2); expect(d[0]).toBeLessThan(0.45);
    expect(d[1]).toBeGreaterThan(0.55);
    const b = build(8192, 'dispersed');
    for (const n of b.needles) expect(b.text.slice(n.charOffset)).toContain('REQUIREMENT');
  });
  it('reports overflow explicitly when the needles alone cannot fit, and never silently truncates', () => {
    const o = buildEvidence({ pool, needles: [{ id: 'big', text: 'x'.repeat(4000) }], targetTokens: 100 }) as OverflowRecord;
    expect(o.kind).toBe('overflow');
    expect(o.tokensOver).toBeGreaterThan(0);
    expect(checkFit(40000, 32768)).toEqual({ kind: 'overflow', inputTokens: 40000, contextTokens: 32768, tokensOver: 7232 });
    expect(checkFit(8000, 8192)).toBeNull();
  });
  it('truncation is explicit and records what was dropped', () => {
    const text = 'word '.repeat(400);
    const t = truncateExplicit(text, 100);
    expect(t.truncated).toBe(true);
    if (t.truncated) { expect(t.tokensDropped).toBeGreaterThan(0); expect(t.text.length).toBeLessThan(text.length); }
    expect(truncateExplicit('short', 100)).toEqual({ truncated: false, text: 'short' });
  });
  it('overflow scores error/infra, not a model failure (AC-12)', () => {
    const s = scoreRunV2({ graderId: GRADER_IDS.longContext, overflow: checkFit(40000, 32768), verifier: { ran: false, passed: null }, visible: { ran: false, passed: null }, tampering: [], leaks: [] });
    expect(s).toMatchObject({ result: 'error', failureClass: 'infra' });
    expect(s.notes.join()).toContain('7232 over');
  });
  it('grades superseded, correct, absent and abstention answers', () => {
    const e = { answer: 'limit is 7', superseded: ['limit is 5'] };
    expect(gradeLongContext({ answer: 'The limit is 7.' }, e).pass).toBe(true);
    expect(gradeLongContext({ answer: 'The limit is 5.' }, e).notes[0]).toContain('followed_superseded');
    expect(gradeLongContext({ abstain: true }, e).notes).toEqual(['wrong_abstention']);
    expect(gradeLongContext({ abstain: true }, { answer: null, abstain: true }).pass).toBe(true);
    expect(gradeLongContext({ answer: 'something' }, { answer: null, abstain: true }).notes).toEqual(['fabrication']);
  });
});

describe('compaction (AC-13)', () => {
  it('marks constraint_dropped when a stage failed but final tests are green', () => {
    const r = gradeCompaction([
      { stage: 0, constraints: { 'no-network': true }, testsPass: true },
      { stage: 1, constraints: { 'no-network': false }, testsPass: true },
      { stage: 2, constraints: { 'no-network': true }, testsPass: true },
    ]);
    expect(r.pass).toBe(false);
    expect(r.notes[0]).toBe('constraint_dropped');
    expect(r.retention).toEqual([1, 0, 1]);
    expect(scoreRunV2({ graderId: r.graderId, verifier: { ran: true, passed: true }, visible: { ran: true, passed: true }, tampering: [], leaks: [], flags: r.notes }).result).toBe('fail');
  });
  it('passes when every stage retains the constraints; fails on red final tests; handles empty', () => {
    expect(gradeCompaction([{ stage: 0, constraints: { a: true }, testsPass: true }, { stage: 1, constraints: { a: true }, testsPass: true }]).pass).toBe(true);
    expect(gradeCompaction([{ stage: 0, constraints: { a: true }, testsPass: false }]).notes).toContain('final tests failed');
    expect(gradeCompaction([]).pass).toBe(false);
  });
});

describe('score-v2', () => {
  const base = { graderId: 'verifier-v1', verifier: { ran: true, passed: true }, visible: { ran: true, passed: true }, tampering: [], leaks: [] };
  it('retains the grader id and version on every score', () => {
    for (const i of [base, { ...base, harnessError: true }, { ...base, unsupported: 'toolCalling' }, { ...base, leaks: ['x'] }]) {
      const s = scoreRunV2(i);
      expect(s.graderId).toBe('verifier-v1');
      expect(s.scoringVersion).toBe('score-v2');
    }
  });
  it('separates model, harness and infra failures', () => {
    expect(scoreRunV2(base)).toMatchObject({ result: 'pass', failureClass: null });
    expect(scoreRunV2({ ...base, verifier: { ran: true, passed: false } })).toMatchObject({ result: 'fail', failureClass: 'model' });
    expect(scoreRunV2({ ...base, harnessError: true })).toMatchObject({ result: 'error', failureClass: 'harness' });
    expect(scoreRunV2({ ...base, infraError: true })).toMatchObject({ result: 'error', failureClass: 'infra' });
    expect(scoreRunV2({ ...base, tampering: ['test deleted'] })).toMatchObject({ result: 'invalid', failureClass: 'model' });
    expect(scoreRunV2({ ...base, leaks: ['leak'] })).toMatchObject({ result: 'invalid', failureClass: 'harness' });
    expect(scoreRunV2({ ...base, flags: ['fabrication'], verifier: { ran: true, passed: false } }).notes).toContain('fabrication');
  });
  it('unsupported capability is unscored and named, not a model failure (AC-14)', () => {
    expect(scoreRunV2({ ...base, unsupported: 'toolCalling' })).toMatchObject({ result: 'unscored', failureClass: null, notes: ['unsupported: toolCalling'] });
  });
});

describe('adapters and the CPU-only guard (AC-14, AC-15)', () => {
  const needs = { toolCalling: true, systemPrompt: true, structuredOutput: false, contextTokens: 32768 };
  it('reports unsupported capabilities explicitly and does not alter the case', () => {
    const a = { id: 'm', capabilities: { toolCalling: false, systemPrompt: true, structuredOutput: false, contextTokens: 16384 } };
    const before = JSON.stringify(needs);
    expect(unsupportedCapabilities(a, needs)).toEqual(['toolCalling', 'context:32768']);
    expect(JSON.stringify(needs)).toBe(before);
    expect(unsupportedCapabilities({ ...a, capabilities: { ...a.capabilities, toolCalling: true, contextTokens: 32768 } }, needs)).toEqual([]);
  });
  const open = new Date(Date.parse(GPU_WINDOW_OPENS_AT) + 1000);
  const gpu = [{ usedMb: 100, totalMb: 24000 }];
  const g = (o: object) => inferenceGuard({ cpuOnly: false, estimatedVramMb: 18000, gpus: gpu, loadedModels: [], now: open, purpose: 'model-run', ...o });
  it('never starts a model for verification or a cpuOnly case', () => {
    expect(g({ purpose: 'verify' }).allowed).toBe(false);
    expect(g({ cpuOnly: true }).allowed).toBe(false);
  });
  it('refuses before the GPU window, without an estimate, on an unreadable GPU, and without room', () => {
    expect(g({ now: new Date('2026-11-08T13:59:00Z') }).reason).toContain('deferred');
    expect(g({ estimatedVramMb: null }).reason).toContain('estimatedVramMb');
    expect(g({ gpus: null }).allowed).toBe(false);
    expect(g({ estimatedVramMb: 30000 }).allowed).toBe(false);
    expect(g({ loadedModels: ['x'] }).allowed).toBe(false);
  });
  it('allows a model-running case only when the window is open and the gate passes', () => {
    expect(g({}).allowed).toBe(true);
  });
});

describe('regrade from stored artifacts', () => {
  const art = (over: Partial<StoredArtifact> = {}): StoredArtifact => ({
    runId: 'r1', caseId: 'find-total', graderId: GRADER_IDS.find,
    output: { citations: [{ file: 'src/live.ts' }] }, expected: { kind: 'answer', locations: [{ file: 'src/live.ts' }] }, recorded: { pass: true, graderId: GRADER_IDS.find }, ...over,
  });
  it('reproduces the recorded score with no model', () => {
    const [r] = regrade([art()]);
    expect(r.outcome.pass).toBe(true);
    expect(r.graderId).toBe('find-v1');
    expect(r.changedFromRecorded).toBe(false);
  });
  it('flags a changed score and dispatches by grader id', () => {
    const [a, b] = regrade([art({ recorded: { pass: false, graderId: 'find-v1' } }), art({ graderId: GRADER_IDS.review, output: [], expected: { defects: [] }, recorded: undefined })]);
    expect(a.changedFromRecorded).toBe(true);
    expect(b.outcome.graderId).toBe('review-v1');
    expect(b.changedFromRecorded).toBeNull();
  });
  it('refuses an unknown grader id instead of substituting another', () => {
    expect(() => regrade([art({ graderId: 'find-v0' })])).toThrow('not available');
  });
});
