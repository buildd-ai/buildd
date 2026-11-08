/**
 * The v2 executor end to end with a fake agent subprocess (and, for the
 * fixture adapter, a real one). No model, no GPU, no network: the Ollama
 * client and the GPU reader are fakes, and the test asserts they are used in
 * the right order.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { computeContentHash, namedPaths, GPU_WINDOW_OPENS_AT, type CaseFiles, type CaseManifestV2 } from '../../packages/core/local-eval-v2';
import { validateRunRecord } from '../../packages/core/local-eval';
import { HARNESS_TREATMENT_V2 } from '../../packages/core/local-eval-v2-exec';
import { runV2, type V2Env } from './v2';
import { tempDir } from './lib';
import type { AgentInvocation } from './v2-agent';
import type { AgentExit } from '../../packages/core/local-eval-v2-exec';
import type { ExecDeps } from './v2-exec';

const REF_MARKER = 'REFERENCE-ONLY-7f3a';

/** The verifier passes iff answer.json names src/live.ts, and fails loudly if it can see any reference material. */
const VERIFIER = `import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const cand = process.env.CANDIDATE_DIR;
const root = dirname(cand);
const siblings = readdirSync(root).sort().join(',');
if (siblings !== 'candidate,verifier') { console.error('grading root holds ' + siblings); process.exit(7); }
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
for (const f of walk(cand)) if (readFileSync(f, 'utf8').includes('${REF_MARKER}')) { console.error('reference visible in candidate'); process.exit(8); }
const p = cand + '/answer.json';
const a = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
const ok = Array.isArray(a.citations) && a.citations.some((c) => c.file === 'src/live.ts');
console.log(ok ? 'ok' : 'wrong');
process.exit(ok ? 0 : 1);
`;

function writeCase(root: string, id: string, m: Omit<CaseManifestV2, 'contentHash' | 'id'>, files: CaseFiles) {
  const dir = join(root, 'cases', id);
  const man = { ...m, id, contentHash: '' } as CaseManifestV2;
  man.contentHash = computeContentHash(files, namedPaths(man));
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  writeFileSync(join(dir, 'case.json'), JSON.stringify(man, null, 2));
  return man;
}

const common = {
  formatVersion: 2 as const, version: 1, deps: { bun: '1.x' }, labels: { difficulty: 'easy' as const, skills: ['find'] }, exposing: false,
  provenance: { source: 'authored' as const, licence: 'repository licence', note: 'authored for this test' }, contamination: 'authored fixture', admission: null,
};

function buildSuite(): string {
  const root = tempDir('v2-exec-');
  const find = writeCase(root, 'find-total', {
    ...common, category: 'find-by-behaviour',
    files: { snapshot: ['snapshot/src/live.ts', 'snapshot/src/dead.ts', 'snapshot/test/live.spec.ts'], instruction: 'instruction.md', verifier: ['verifier/check.ts'], reference: ['reference/answer.json'], rubric: null,
      candidates: { broken: ['decoy'], alternative: 'alt', files: ['candidates/decoy/answer.json', 'candidates/alt/answer.json'] } },
    resources: { cpuOnly: true, estimatedVramMb: null, estimatedRamMb: null, wallClockSeconds: 30, maxTurns: 5, toolBudget: 10 },
    expected: { kind: 'answer', locations: [{ file: 'src/live.ts' }], decoys: ['src/dead.ts'] },
  }, {
    'snapshot/src/live.ts': 'export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n',
    'snapshot/src/dead.ts': 'export const totalOld = 0;\n',
    'snapshot/test/live.spec.ts': "import { expect, test } from 'bun:test';\nimport { total } from '../src/live';\ntest('total', () => expect(total([1, 2])).toBe(3));\n",
    'instruction.md': 'Which file computes the total? Write {"citations":[{"file":"..."}]} to answer.json.\n',
    'verifier/check.ts': VERIFIER,
    'reference/answer.json': `{"citations":[{"file":"src/live.ts"}],"note":"${REF_MARKER}"}\n`,
    'candidates/decoy/answer.json': '{"citations":[{"file":"src/dead.ts"}]}\n',
    'candidates/alt/answer.json': '{"citations":[{"file":"src/live.ts","symbol":"total"}]}\n',
  });
  const needles = JSON.stringify([{ id: 'REQ-1', text: 'REQ-1: the limit is 7.' }]);
  const ctx = writeCase(root, 'ctx-limit', {
    ...common, category: 'long-context-requirements', labels: { difficulty: 'easy', skills: ['long-context'] },
    files: { snapshot: ['snapshot/evidence/needles.json', 'snapshot/evidence/filler.md'], instruction: 'instruction.md', verifier: ['verifier/check.ts'], reference: ['reference/answer.json'], rubric: null,
      candidates: { broken: ['wrong'], alternative: null, files: ['candidates/wrong/answer.json'] } },
    resources: { cpuOnly: true, estimatedVramMb: null, estimatedRamMb: null, wallClockSeconds: 30, maxTurns: 5, toolBudget: 10 },
    expected: { kind: 'verifier' }, longContext: { sizes: [8192, 16384, 32768], positions: ['middle'] },
  }, {
    'snapshot/evidence/needles.json': needles,
    'snapshot/evidence/filler.md': Array.from({ length: 400 }, (_, i) => `NOTE-${i}: an unrelated note about another service and its usual behaviour, kept for padding.`).join('\n\n'),
    'instruction.md': 'What is the limit? Write {"answer": "..."} to answer.json.\n',
    'verifier/check.ts': "import { readFileSync } from 'node:fs';\nconst a = JSON.parse(readFileSync(process.env.CANDIDATE_DIR + '/answer.json', 'utf8'));\nprocess.exit(String(a.answer).includes('7') ? 0 : 1);\n",
    'reference/answer.json': '{"answer":"7"}\n',
    'candidates/wrong/answer.json': '{"answer":"9"}\n',
  });
  writeFileSync(join(root, 'suite.json'), JSON.stringify({ suiteId: 'coding-playground', suiteVersion: 'v2', formatVersion: 2, scoringVersion: 'score-v2', skills: ['find', 'long-context'], cases: [find, ctx].map((m) => ({ id: m.id, version: 1, contentHash: m.contentHash })) }));
  writeFileSync(join(root, 'splits.json'), JSON.stringify({ dev: ['find-total', 'ctx-limit'], sealedHoldout: [{ id: 'sealed-x', category: 'find-by-behaviour', version: 1, contentHash: 'a'.repeat(64), difficulty: 'easy', skills: ['find'], exposing: false }] }));
  writeFileSync(join(root, 'models.json'), JSON.stringify({ modelsFormatVersion: 2, models: [{ tag: 'm:1', digest: 'sha256:aaa', estimatedVramMb: 12000 }] }));
  return root;
}

type Call = { inv: AgentInvocation; cwd: string; input: string; timeoutMs: number; treeFiles: string[] };
function treeFilesOf(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.name === '.git' ? [] : e.isDirectory() ? treeFilesOf(dir, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]));
}

/** A fake agent: records the call, then lets `act` edit the tree and choose the exit. */
function fakeAgent(act: (cwd: string, call: Call) => Partial<AgentExit> | void) {
  const calls: Call[] = [];
  const spawnAgent = async (inv: AgentInvocation, o: { cwd: string; input: string; timeoutMs: number }): Promise<AgentExit> => {
    const call = { inv, ...o, treeFiles: treeFilesOf(o.cwd).sort() };
    calls.push(call);
    const r = act(o.cwd, call) ?? {};
    return { code: 0, out: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'done', usage: { input_tokens: 900, output_tokens: 40 } }) + '\n', err: '', timedOut: false, spawnError: null, ...r };
  };
  return { calls, spawnAgent };
}

const ollamaLog: string[] = [];
const fakeOllama = (digest = 'sha256:aaa') => ({
  tagInfo: async (_o: string, tag: string) => { ollamaLog.push(`tag ${tag}`); return { digest, quantization: 'Q4_K_M' }; },
  loadModel: async (_o: string, tag: string, ctx: number) => { ollamaLog.push(`load ${tag}@${ctx}`); },
  unloadModel: async (_o: string, tag: string) => { ollamaLog.push(`unload ${tag}`); },
});
const afterWindow = () => new Date(Date.parse(GPU_WINDOW_OPENS_AT) + 3_600_000);

function envWith(spawnAgent: ExecDeps['spawnAgent'], over: Partial<V2Env> = {}): V2Env {
  return {
    minFreeMb: 20000, readGpu: () => [{ usedMb: 500, totalMb: 24000 }], loaded: async () => [], now: afterWindow,
    ollama: fakeOllama(), harnessVersion: () => '2.1.310 (Claude Code)', claudeBin: 'claude', exec: { spawnAgent, sampleVramMb: () => null }, ...over,
  };
}

const opts = (o: Record<string, string>) => (n: string) => o[n];
async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const lines: string[] = []; const l = console.log; const e = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); }; console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { return { value: await fn(), out: lines.join('\n') }; } finally { console.log = l; console.error = e; }
}
const readRun = (out: string, runId: string) => JSON.parse(readFileSync(join(out, runId, 'run.json'), 'utf8'));

describe('v2 executor: claude-code adapter with a fake subprocess', () => {
  it('starts the agent once per trial in the exported tree, with the treatment, a clean env and the prompt on stdin', async () => {
    const root = buildSuite(); const out = join(root, 'runs');
    const agent = fakeAgent((cwd) => { writeFileSync(join(cwd, 'answer.json'), '{"citations":[{"file":"src/live.ts"}]}'); });
    ollamaLog.length = 0;
    process.env.BUILDD_API_KEY_FOR_TEST = 'bld_shouldnotleak1234';
    const r = await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', trials: '2', out }), () => false, envWith(agent.spawnAgent)));
    delete process.env.BUILDD_API_KEY_FOR_TEST;
    expect(r.value).toBe(0);
    expect(agent.calls).toHaveLength(2);
    expect(ollamaLog).toEqual(['tag m:1', 'load m:1@16384', 'tag m:1', 'tag m:1', 'unload m:1']);
    for (const [i, c] of agent.calls.entries()) {
      const runId = `v2.find-total.m_1@16384.single-context.t${i + 1}`;
      // The agent works outside the run output and the repository; its final tree is kept afterwards.
      expect(c.cwd.startsWith(out)).toBe(false);
      expect(c.cwd.startsWith(root)).toBe(false);
      expect(existsSync(c.cwd)).toBe(false);
      expect(readFileSync(join(out, runId, 'tree', 'answer.json'), 'utf8')).toContain('src/live.ts');
      // Only the snapshot and the instruction: no verifier, reference or candidates.
      expect(c.treeFiles).toEqual(['TASK.md', 'src/dead.ts', 'src/live.ts', 'test/live.spec.ts']);
      expect(c.input).toContain('Which file computes the total?');
      expect(c.input).toContain('Budget: at most 5 turns and 10 tool calls.');
      expect(c.input).not.toContain(REF_MARKER);
      expect(c.timeoutMs).toBe(30_000);
      expect(c.inv.cmd).toBe('claude');
      expect(c.inv.args).toContain('--system-prompt');
      expect(c.inv.args[c.inv.args.indexOf('--system-prompt') + 1]).toBe(HARNESS_TREATMENT_V2.systemPrompt);
      expect(c.inv.args[c.inv.args.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Glob,Grep,Bash');
      expect(c.inv.args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '']));
      expect(c.inv.args).not.toContain(c.input); // the prompt is on stdin, not argv
      expect(c.inv.env.CLAUDE_CONFIG_DIR).toBe(join(dirname(c.cwd), 'claude-config'));
      expect(c.inv.env.HOME).toBe(join(dirname(c.cwd), 'home'));
      expect(c.inv.env.MAX_THINKING_TOKENS).toBe('0');
      expect(c.inv.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(HARNESS_TREATMENT_V2.maxOutputTokens));
      expect(c.inv.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11435');
      expect(c.inv.env.ANTHROPIC_API_KEY).toBe('');
      expect(c.inv.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('16384');
      expect(Object.values(c.inv.env).join(' ')).not.toContain('bld_shouldnotleak');
      expect(Object.keys(c.inv.env)).not.toContain('BUILDD_API_KEY_FOR_TEST');
      const rec = readRun(out, runId);
      expect(validateRunRecord(rec)).toEqual([]);
      expect(rec).toMatchObject({ result: 'pass', suiteVersion: 'v2', scoringVersion: 'score-v2', model: { tag: 'm:1', digest: 'sha256:aaa', quantization: 'Q4_K_M' }, harness: { name: 'claude-code', version: '2.1.310 (Claude Code)' }, hidden: { ran: true, passed: true }, visible: { ran: true, passed: true }, inputTokens: 900, turns: 2 });
      expect(rec.v2).toMatchObject({ category: 'find-by-behaviour', split: 'dev', graderId: 'verifier-v1', failureClass: null, track: 'single-context' });
      const ex = JSON.parse(readFileSync(join(out, runId, 'execution.json'), 'utf8'));
      expect(ex.treatment.id).toBe('claude-code-minimal-v1');
      expect(ex.truncation).toBe('unknown');
      expect(ex.unknowns.length).toBeGreaterThan(0);
      // Nothing in the run directory carries the reference.
      for (const f of ['run.json', 'execution.json', 'prompt.txt', 'agent.diff', 'grading.txt']) expect(readFileSync(join(out, runId, f), 'utf8')).not.toContain(REF_MARKER);
    }
    // A second invocation skips recorded runs and never starts the agent again.
    await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', trials: '2', out }), () => false, envWith(agent.spawnAgent)));
    expect(agent.calls).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });

  it('grades the candidate only: a wrong answer fails as a model failure; editing a shipped test is invalid', async () => {
    const root = buildSuite(); const out = join(root, 'runs');
    const wrong = fakeAgent((cwd) => { writeFileSync(join(cwd, 'answer.json'), '{"citations":[{"file":"src/dead.ts"}]}'); });
    await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', trials: '1', out }), () => false, envWith(wrong.spawnAgent)));
    const rec = readRun(out, 'v2.find-total.m_1@16384.single-context.t1');
    expect(rec).toMatchObject({ result: 'fail', hidden: { ran: true, passed: false }, v2: { failureClass: 'model' } });
    const tamper = fakeAgent((cwd) => { writeFileSync(join(cwd, 'answer.json'), '{"citations":[{"file":"src/live.ts"}]}'); writeFileSync(join(cwd, 'test/live.spec.ts'), '// gone\n'); });
    const out2 = join(root, 'runs2');
    await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', trials: '1', out: out2 }), () => false, envWith(tamper.spawnAgent)));
    const t = readRun(out2, 'v2.find-total.m_1@16384.single-context.t1');
    expect(t).toMatchObject({ result: 'invalid', v2: { failureClass: 'model' } });
    expect(t.tampering).toEqual(['modified test test/live.spec.ts']);
    rmSync(root, { recursive: true, force: true });
  });

  it('classifies timeout, turn budget, harness crash and server failure without calling a harness error a model failure', async () => {
    const root = buildSuite();
    const cases: [string, Partial<AgentExit>, string, string | null][] = [
      ['timeout', { timedOut: true, code: 143, out: '' }, 'fail', 'model'],
      ['turns', { out: JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 5 }) }, 'fail', 'model'],
      ['crash', { code: 1, out: '', err: 'TypeError: boom' }, 'error', 'harness'],
      ['nostart', { code: 127, out: '', spawnError: 'Error: spawn claude ENOENT' }, 'error', 'harness'],
      ['server', { code: 1, out: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: Connection error. ECONNREFUSED 127.0.0.1:11435' }) }, 'error', 'infra'],
      ['ctxfull', { code: 1, out: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 400 prompt is too long: 17000 tokens > 16384 maximum' }) }, 'error', 'infra'],
    ];
    for (const [name, exit, result, cls] of cases) {
      const out = join(root, `runs-${name}`);
      const agent = fakeAgent(() => exit);
      await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', trials: '1', out }), () => false, envWith(agent.spawnAgent)));
      expect(agent.calls.length, name).toBe(1);
      const rec = readRun(out, 'v2.find-total.m_1@16384.single-context.t1');
      expect([rec.result, rec.v2.failureClass], name).toEqual([result, cls]);
      if (cls !== 'model') expect(rec.hidden.ran, name).toBe(false); // a harness or infra error is never graded
      if (name === 'timeout') expect(rec.v2.flags).toContain('budget_exhausted');
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('records overflow before starting the agent and truncates nothing; a fitting window runs the same case', async () => {
    const root = buildSuite(); const out = join(root, 'runs');
    const agent = fakeAgent((cwd) => { writeFileSync(join(cwd, 'answer.json'), '{"answer":"the limit is 7"}'); });
    await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '8192', case: 'ctx-limit', trials: '1', out }), () => false, envWith(agent.spawnAgent)));
    expect(agent.calls).toHaveLength(0);
    const rec = readRun(out, 'v2.ctx-limit.m_1@8192.single-context.e8192-dispersed.t1');
    expect(rec).toMatchObject({ result: 'error', v2: { failureClass: 'infra' } });
    expect(rec.harnessNote).toContain('nothing was truncated');
    const ex = JSON.parse(readFileSync(join(out, 'v2.ctx-limit.m_1@8192.single-context.e8192-dispersed.t1', 'execution.json'), 'utf8'));
    expect(ex.overflow.kind).toBe('overflow');
    expect(ex.agentStarted).toBe(false);
    await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'ctx-limit', trials: '1', out, position: 'middle' }), () => false, envWith(agent.spawnAgent)));
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0].input).toContain('<evidence>');
    expect(agent.calls[0].input).toContain('REQ-1: the limit is 7.');
    expect(readRun(out, 'v2.ctx-limit.m_1@16384.single-context.e8192-middle.t1').result).toBe('pass');
    rmSync(root, { recursive: true, force: true });
  });

  it('tool-retrieval puts the evidence in the tree, not the prompt', async () => {
    const root = buildSuite(); const out = join(root, 'runs');
    const agent = fakeAgent((cwd) => { writeFileSync(join(cwd, 'answer.json'), '{"answer":"7"}'); });
    await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'ctx-limit', trials: '1', out, track: 'tool-retrieval' }), () => false, envWith(agent.spawnAgent)));
    expect(agent.calls[0].treeFiles).toContain('evidence/context-8192.md');
    expect(agent.calls[0].input).not.toContain('<evidence>');
    expect(readRun(out, 'v2.ctx-limit.m_1@16384.tool-retrieval.e8192-dispersed.t1').v2.track).toBe('tool-retrieval');
    rmSync(root, { recursive: true, force: true });
  });

  it('unsupported and unavailable cases are recorded or skipped, never scored as model failures, and start nothing', async () => {
    const root = buildSuite(); const out = join(root, 'runs');
    const agent = fakeAgent(() => {});
    await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', trials: '1', out }), (n) => n === 'no-tool-calling', envWith(agent.spawnAgent)));
    expect(agent.calls).toHaveLength(0);
    expect(readRun(out, 'v2.find-total.m_1@16384.single-context.notools.t1')).toMatchObject({ result: 'unscored', configId: 'm:1@16384+notools', v2: { failureClass: null } });
    const sealed = await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', all: '1', split: 'sealed-holdout', trials: '1', out }), (n) => n === 'all', envWith(agent.spawnAgent)));
    expect(agent.calls).toHaveLength(0);
    expect(sealed.out).toContain('descriptor and hash are not a runnable case');
    expect(existsSync(join(out, 'v2.sealed-x.m_1@16384.single-context.t1', 'run.json'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a changed digest and a busy GPU before loading anything', async () => {
    const root = buildSuite(); const out = join(root, 'runs');
    const agent = fakeAgent(() => {});
    ollamaLog.length = 0;
    expect((await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', out }), () => false, envWith(agent.spawnAgent, { ollama: fakeOllama('sha256:bbb') })))).value).toBe(2);
    expect((await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', out }), () => false, envWith(agent.spawnAgent, { readGpu: () => [{ usedMb: 20000, totalMb: 24000 }] })))).value).toBe(3);
    expect((await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', out }), () => false, envWith(agent.spawnAgent, { loaded: async () => ['other:1'] })))).value).toBe(3);
    expect(ollamaLog.filter((l) => l.startsWith('load'))).toEqual([]);
    expect(agent.calls).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('v2TempDir', () => {
  it('returns the canonical path (no 8.3 short names or symlinked temp roots), outside the cwd', async () => {
    const { v2TempDir } = await import('./v2-exec');
    const { realpathSync } = await import('node:fs');
    const d = v2TempDir('v2-canon-');
    expect(d).toBe(realpathSync.native(d));
    expect(d.startsWith(process.cwd())).toBe(false);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('resolveClaudeBin', () => {
  it('prefers LOCAL_EVAL_CLAUDE_BIN and refuses a .cmd shim, which needs a shell that would re-split arguments', async () => {
    const { resolveClaudeBin } = await import('./v2-agent');
    expect(resolveClaudeBin({ LOCAL_EVAL_CLAUDE_BIN: 'C:\\tools\\claude.exe' }, () => null)).toEqual({ cmd: 'C:\\tools\\claude.exe', reason: null });
    expect(resolveClaudeBin({}, () => 'C:\\npm\\claude.cmd').cmd).toBeNull();
    expect(resolveClaudeBin({}, () => null).reason).toContain('not found');
    expect(resolveClaudeBin({}, () => '/usr/local/bin/claude').cmd).toBe('/usr/local/bin/claude');
  });
});

describe('v2 executor: hostile candidates', () => {
  it.skipIf(process.platform === 'win32')('a symlink in the result is tampering and is never followed by the grader', async () => {
    const root = buildSuite(); const out = join(root, 'runs');
    const { symlinkSync } = await import('node:fs');
    const agent = fakeAgent((cwd) => { symlinkSync(join(root, 'cases', 'find-total', 'reference', 'answer.json'), join(cwd, 'answer.json')); });
    await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', trials: '1', out }), () => false, envWith(agent.spawnAgent)));
    const rec = readRun(out, 'v2.find-total.m_1@16384.single-context.t1');
    expect(rec).toMatchObject({ result: 'invalid', v2: { failureClass: 'model' } });
    expect(rec.tampering.join()).toContain('symlink answer.json');
    expect(rec.hidden.passed).toBe(false); // the verifier saw no answer: the link was not copied
    rmSync(root, { recursive: true, force: true });
  });
  it('a candidate that hangs the verifier fails as a model outcome', async () => {
    const root = buildSuite(); const out = join(root, 'runs');
    // Replace the verifier with one that imports candidate code; the candidate loops forever.
    const agent = fakeAgent((cwd) => { writeFileSync(join(cwd, 'answer.json'), '{"citations":[{"file":"src/live.ts"}]}'); writeFileSync(join(cwd, 'src/live.ts'), 'while (true) {}\nexport const total = 0;\n'); });
    const env = envWith(agent.spawnAgent, {}); env.exec!.verifierTimeoutMs = 1500;
    // The visible spec imports src/live.ts, so the visible check hangs and times out.
    await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', trials: '1', out }), () => false, env));
    const rec = readRun(out, 'v2.find-total.m_1@16384.single-context.t1');
    expect(rec).toMatchObject({ result: 'fail', v2: { failureClass: 'model' } });
    expect(readFileSync(join(out, 'v2.find-total.m_1@16384.single-context.t1', 'grading.txt'), 'utf8')).toContain('timed out');
    rmSync(root, { recursive: true, force: true });
  }, 30_000);
  it('an agent that deletes the baseline Git data is invalid, recorded, and not rerun', async () => {
    const root = buildSuite(); const out = join(root, 'runs');
    const agent = fakeAgent((cwd) => { rmSync(join(cwd, '.git'), { recursive: true, force: true }); writeFileSync(join(cwd, 'answer.json'), '{"citations":[{"file":"src/live.ts"}]}'); });
    await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', trials: '1', out }), () => false, envWith(agent.spawnAgent)));
    const rec = readRun(out, 'v2.find-total.m_1@16384.single-context.t1');
    expect(rec.result).toBe('invalid');
    expect(rec.tampering.join()).toContain('baseline Git data');
    await quiet(() => runV2('run', opts({ root, model: 'm:1', harness: 'claude-code', context: '16384', case: 'find-total', trials: '1', out }), () => false, envWith(agent.spawnAgent)));
    expect(agent.calls).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
  it('a fixture run cannot borrow a model tag (it would share run ids with a model run)', async () => {
    const root = buildSuite();
    const r = await quiet(() => runV2('run', opts({ root, harness: 'fixture', 'fixture-dir': root, model: 'm:1', context: '16384', case: 'find-total', out: join(root, 'runs') }), () => false, { minFreeMb: 1, readGpu: () => null, loaded: async () => [] }));
    expect(r.value).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('v2 executor: fixture adapter (real subprocess, no model)', () => {
  it('runs candidate -> hidden verifier -> record, labels it fixture, and ingest refuses it', async () => {
    const root = buildSuite(); const out = join(root, 'runs'); const fx = join(root, 'fixtures');
    mkdirSync(join(fx, 'find-total'), { recursive: true });
    writeFileSync(join(fx, 'find-total', 'answer.json'), '{"citations":[{"file":"src/live.ts"}]}\n');
    const r = await quiet(() => runV2('run', opts({ root, harness: 'fixture', 'fixture-dir': fx, context: '16384', case: 'find-total', trials: '1', out }), () => false, { minFreeMb: 1, readGpu: () => { throw new Error('no GPU read for a fixture'); }, loaded: async () => { throw new Error('no Ollama for a fixture'); } }));
    expect(r.value).toBe(0);
    expect(r.out).toContain('NOT a model result');
    const rec = readRun(out, 'v2.find-total.fixture@16384.single-context.t1');
    expect(rec).toMatchObject({ result: 'pass', harness: { name: 'fixture' }, hidden: { ran: true, passed: true } });
    process.env.BUILDD_API_KEY = process.env.BUILDD_API_KEY ?? 'test-key-not-used';
    const ing = await quiet(() => runV2('ingest', opts({ root, dir: out, workspace: 'w', api: 'http://127.0.0.1:9' }), () => false, { minFreeMb: 1, readGpu: () => null, loaded: async () => [] }));
    expect(ing.value).toBe(1);
    expect(ing.out).toContain('fixture run');
    const rep = await quiet(() => runV2('report', opts({ root, dir: out }), () => false, { minFreeMb: 1, readGpu: () => null, loaded: async () => [] }));
    expect(rep.out).toContain('fixture (NOT a model)');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('shipped v2 suite is executable end to end (fixture adapter, no model)', () => {
  const noGpu = { minFreeMb: 1, readGpu: () => null, loaded: async () => [] as string[] };
  type Rec = { caseId: string; result: string; hidden: { ran: boolean }; harnessNote: string | null; v2: { category: string; failureClass: string | null; track: string } };
  const records = (out: string): Rec[] => readdirSync(out).map((d) => JSON.parse(readFileSync(join(out, d, 'run.json'), 'utf8')));
  it('every dev case in all six categories is graded by its hidden verifier; long-context fits at 16K only on tool-retrieval', async () => {
    const { DEFAULT_ROOT, loadSuiteV2 } = await import('./v2');
    const { CATEGORIES } = await import('../../packages/core/local-eval-v2');
    const cases = loadSuiteV2(DEFAULT_ROOT).cases;
    const ids = Object.keys(cases).sort();
    const isCtx = (id: string) => cases[id].manifest.category === 'long-context-requirements';
    const tmp = tempDir('v2-shipped-'); const fx = join(tmp, 'fx');
    for (const id of ids) mkdirSync(join(fx, id), { recursive: true }); // empty fixtures: the agent changes nothing
    const run = (out: string, extra: Record<string, string>) => quiet(() => runV2('run', opts({ root: DEFAULT_ROOT, harness: 'fixture', 'fixture-dir': fx, all: '1', trials: '1', out, ...extra }), (n) => n === 'all', noGpu));

    const single16 = join(tmp, 's16');
    expect((await run(single16, { context: '16384' })).value).toBe(0);
    const s16 = records(single16);
    expect(s16.map((x) => x.caseId).sort()).toEqual(ids);
    for (const x of s16) {
      if (isCtx(x.caseId)) {
        // 8K of evidence + tool schemas + the output reservation do not fit 16K: recorded, not started, not a model failure.
        expect([x.result, x.v2.failureClass, x.hidden.ran], x.caseId).toEqual(['error', 'infra', false]);
        expect(x.harnessNote ?? '', x.caseId).toContain('nothing was truncated');
      } else {
        // An untouched snapshot is not a solution (admission proved the verifier fails it), and an answer case with no answer file fails too.
        expect([x.result, x.v2.failureClass, x.hidden.ran], x.caseId).toEqual(['fail', 'model', true]);
      }
    }
    const tool16 = join(tmp, 't16');
    expect((await run(tool16, { context: '16384', track: 'tool-retrieval' })).value).toBe(0);
    const single32 = join(tmp, 's32');
    expect((await run(single32, { context: '32768' })).value).toBe(0);
    const ctxGraded = [...records(tool16), ...records(single32)].filter((x) => isCtx(x.caseId));
    expect(ctxGraded.length).toBe(ids.filter(isCtx).length * 2);
    for (const x of ctxGraded) expect([x.result, x.hidden.ran], `${x.caseId} ${x.v2.track}`).toEqual(['fail', true]);
    const graded = new Set([...s16, ...ctxGraded].filter((x) => x.hidden.ran).map((x) => x.v2.category));
    expect(graded).toEqual(new Set(CATEGORIES));
    rmSync(tmp, { recursive: true, force: true });
  }, 240_000);
});
