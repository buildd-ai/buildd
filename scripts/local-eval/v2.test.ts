import { describe, it, expect } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { computeContentHash, namedPaths, type CaseFiles, type CaseManifestV2 } from '../../packages/core/local-eval-v2';
import { admitOne, exportToDisk, loadCase, loadSuiteV2, makeVerifier, probeTree, runV2, validateV2 } from './v2';
import { tempDir } from './lib';

/** A tiny answer-style case: the verifier passes iff the candidate's answer.json cites src/live.ts. */
const VERIFIER = `import { readFileSync, existsSync } from 'node:fs';
const p = process.env.CANDIDATE_DIR + '/answer.json';
const a = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
process.exit(a.file === 'src/live.ts' ? 0 : 1);
`;
const FILES = (verifier = VERIFIER): CaseFiles => ({
  'snapshot/src/live.ts': 'export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n',
  'snapshot/src/dead.ts': 'export const totalOld = 0;\n',
  'instruction.md': 'Which file computes the total?\n',
  'verifier/check.ts': verifier,
  'reference/answer.json': '{"file":"src/live.ts"}\n',
  'candidates/decoy/answer.json': '{"file":"src/dead.ts"}\n',
  'candidates/nothing/answer.json': '{"abstain":true}\n',
  'candidates/alt/answer.json': '{"file":"src/live.ts","symbol":"total"}\n',
});

function build(root: string, files: CaseFiles, over: Partial<CaseManifestV2> = {}) {
  const dir = join(root, 'cases', 'find-total');
  const m: CaseManifestV2 = {
    formatVersion: 2, id: 'find-total', version: 1, contentHash: '', category: 'find-by-behaviour',
    files: { snapshot: ['snapshot/src/live.ts', 'snapshot/src/dead.ts'], instruction: 'instruction.md', verifier: ['verifier/check.ts'], reference: ['reference/answer.json'], rubric: null,
      candidates: { broken: ['decoy', 'nothing'], alternative: 'alt', files: ['candidates/decoy/answer.json', 'candidates/nothing/answer.json', 'candidates/alt/answer.json'] } },
    deps: { bun: '1.x' }, resources: { cpuOnly: true, estimatedVramMb: null, estimatedRamMb: null, wallClockSeconds: 60, maxTurns: 10, toolBudget: 20 },
    labels: { difficulty: 'easy', skills: ['search'] }, exposing: true,
    provenance: { source: 'authored', licence: 'repository licence', note: 'authored for this suite' }, contamination: 'authored fixture',
    expected: { kind: 'answer', locations: [{ file: 'src/live.ts' }], decoys: ['src/dead.ts'] }, admission: null, ...over,
  };
  m.contentHash = computeContentHash(files, namedPaths(m));
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  writeFileSync(join(dir, 'case.json'), JSON.stringify(m, null, 2));
  writeFileSync(join(root, 'suite.json'), JSON.stringify({ suiteId: 'coding-playground', suiteVersion: 'v2', formatVersion: 2, scoringVersion: 'score-v2', skills: ['search'], cases: [{ id: m.id, version: 1, contentHash: m.contentHash }] }));
  return dir;
}
const fresh = () => tempDir('v2-test-');

describe('v2 harness', () => {
  it('validates a suite and names a case whose files were edited after hashing (AC-2)', () => {
    const root = fresh();
    const dir = build(root, FILES());
    expect(validateV2(root)).toEqual([]);
    writeFileSync(join(dir, 'instruction.md'), 'edited\n');
    expect(validateV2(root).join()).toContain('case find-total: contentHash does not match');
    rmSync(root, { recursive: true, force: true });
  });

  it('admits a sound case and stores evidence; the verifier ran on real candidate trees', async () => {
    const root = fresh();
    build(root, FILES());
    const c = loadCase(join(root, 'cases', 'find-total'));
    const ev = await admitOne(c, join(root, 'admission'));
    expect(ev.gates.filter((g) => !g.ok)).toEqual([]);
    expect(ev.admitted).toBe(true);
    const stored = JSON.parse(readFileSync(join(root, 'admission', 'find-total.v1.json'), 'utf8'));
    expect(stored.verdicts.snapshot).toEqual([false]);
    expect(stored.verdicts.reference).toEqual([true, true, true]);
    expect(stored.verdicts['broken:decoy']).toEqual([false]);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects, and keeps evidence for, a verifier that accepts everything (AC-3, AC-4)', async () => {
    const root = fresh();
    build(root, FILES('process.exit(0);\n'));
    const c = loadCase(join(root, 'cases', 'find-total'));
    const ev = await admitOne(c, join(root, 'admission'));
    expect(ev.admitted).toBe(false);
    expect(ev.gates.find((g) => g.gate === 'negative-control-fails')!.ok).toBe(false);
    expect(existsSync(join(root, 'admission', 'find-total.v1.json'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a verifier that only accepts the reference text (AC-6)', async () => {
    const root = fresh();
    build(root, FILES(`import { readFileSync } from 'node:fs';
process.exit(readFileSync(process.env.CANDIDATE_DIR + '/answer.json','utf8') === '{"file":"src/live.ts"}\\n' ? 0 : 1);
`));
    const ev = await admitOne(loadCase(join(root, 'cases', 'find-total')), join(root, 'admission'));
    expect(ev.gates.find((g) => g.gate === 'independent-of-patch')!.ok).toBe(false);
    expect(ev.admitted).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('exports an agent tree with one commit, no remote and none of the hidden files (AC-8)', () => {
    const root = fresh();
    build(root, FILES());
    const c = loadCase(join(root, 'cases', 'find-total'));
    const out = join(root, 'out');
    const r = exportToDisk(c, out);
    expect(r).toEqual({ leaks: [], commits: [expect.any(String)] });
    const probe = probeTree(out);
    expect(Object.keys(probe.files).sort()).toEqual(['TASK.md', 'src/dead.ts', 'src/live.ts']);
    expect(probe.remotes).toEqual([]);
    const all = Object.values(probe.files).join('\n');
    expect(all).not.toContain('CANDIDATE_DIR');
    rmSync(root, { recursive: true, force: true });
  });

  it('the verifier fixture really discriminates (guards the fixture itself)', () => {
    const root = fresh();
    build(root, FILES());
    const v = makeVerifier(loadCase(join(root, 'cases', 'find-total')));
    expect([v('snapshot'), v('reference'), v('broken:decoy'), v('alternative')]).toEqual([false, true, false, true]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('cli --suite v2 guard (AC-15)', () => {
  const env = { minFreeMb: 1, readGpu: () => [{ usedMb: 0, totalMb: 24000 }], loaded: async () => [] as string[] };
  const opts = (root: string) => (n: string) => (n === 'root' ? root : undefined);
  it('refuses a run on a cpuOnly case and exits non-zero without loading anything', async () => {
    const root = fresh(); build(root, FILES());
    expect(await runV2('run', opts(root), () => false, env)).toBe(3);
    rmSync(root, { recursive: true, force: true });
  });
  it('refuses a model-running case with no GPU gate pass', async () => {
    const root = fresh();
    build(root, FILES(), { resources: { cpuOnly: false, estimatedVramMb: 18000, estimatedRamMb: null, wallClockSeconds: 60, maxTurns: 10, toolBudget: 20 } });
    expect(await runV2('run', opts(root), () => false, { ...env, readGpu: () => null })).toBe(3);
    rmSync(root, { recursive: true, force: true });
  });
  it('validate and admit never consult the GPU environment', async () => {
    const root = fresh(); build(root, FILES());
    const boom = { minFreeMb: 1, readGpu: () => { throw new Error('GPU read'); }, loaded: async () => { throw new Error('ollama'); } };
    expect(await runV2('validate', opts(root), () => false, boom)).toBe(0);
    expect(await runV2('admit', opts(root), () => false, boom)).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
  it('loadSuiteV2 skips the _template directory', () => {
    const root = fresh(); build(root, FILES());
    mkdirSync(join(root, 'cases', '_template'), { recursive: true });
    expect(Object.keys(loadSuiteV2(root).cases)).toEqual(['find-total']);
    rmSync(root, { recursive: true, force: true });
  });
});
