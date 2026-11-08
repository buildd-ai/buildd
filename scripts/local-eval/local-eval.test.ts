import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { admittedCases, buildPrompt, detectTestTampering, leakFindings, validateSuite } from '../../packages/core/local-eval';
import { answerBearingTests, changedFiles, createWorkspace, injectHiddenTests, loadSuite, probeWorkspace, sh, tempDir } from './lib';
import { claudeInvocation, parseClaudeJson } from './agent';

const ROOT = resolve(import.meta.dir, '../..');
const suite = loadSuite(join(ROOT, 'eval/local-suite/v1/suite.json'));

describe('suite v1', () => {
  it('is valid and every admitted case recorded a failing pre-fix run and a passing reference', () => {
    expect(validateSuite(suite)).toEqual([]);
    const admitted = admittedCases(suite);
    expect(admitted.length).toBeGreaterThanOrEqual(3);
    for (const c of admitted) expect([c.admission.preFix, c.admission.reference, c.admission.visibleOnPreFix]).toEqual(['fail', 'pass', 'pass']);
  });
  it('keeps a rejected case unadmitted rather than counting it', () => {
    const rejected = suite.cases.filter((c) => c.admission.admittedOn === null);
    expect(rejected.map((c) => c.id)).toContain('build-complete-predicate');
    expect(admittedCases(suite).map((c) => c.id)).not.toContain('build-complete-predicate');
  });
  it('covers more than one difficulty and at least one multi-file fix', () => {
    const a = admittedCases(suite);
    expect(new Set(a.map((c) => c.difficulty)).size).toBeGreaterThan(1);
    expect(a.some((c) => c.fixTouchesFiles > 1)).toBe(true);
  });
  it('contains no production identifiers in public text', () => {
    const text = JSON.stringify(suite);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
  it('lists the candidate models in run order with no digest filled by hand', () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'eval/local-suite/v1/models.json'), 'utf8')).models;
    expect(m.map((x: { tag: string }) => x.tag)).toEqual(['gemma4:26b', 'qwen3-coder:30b', 'qwen3.5:27b', 'devstral-small-2:24b', 'glm-4.7-flash']);
    expect(m.every((x: { digest: unknown }) => x.digest === null)).toBe(true);
  });
  it('pins reference commits that exist in this repository', () => {
    for (const c of suite.cases) {
      for (const s of [c.reference.fixSha, c.reference.preFixSha]) {
        const r = sh('git', ['-C', ROOT, 'cat-file', '-t', s]);
        // A shallow checkout may not have old commits; then the claim is unverifiable here, not false.
        if (r.code === 0) expect(r.out.trim()).toBe('commit');
      }
    }
  });
});

describe('prompt policy', () => {
  it('is identical across cases except the problem, and carries no reference', () => {
    const [a, b] = admittedCases(suite);
    const pa = buildPrompt(suite, a).text.replace(a.problem, '');
    const pb = buildPrompt(suite, b).text.replace(b.problem, '');
    expect(pa).toBe(pb);
    expect(pa).not.toMatch(/[0-9a-f]{40}/);
  });
  it('invokes the agent with an empty config dir, a placeholder token and the same budget for any model', () => {
    const mk = (tag: string) => claudeInvocation({ origin: 'http://127.0.0.1:11435', tag, contextTokens: 16384, prompt: 'p', policy: suite.policy, configDir: '/tmp/cfg', baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-real', CLAUDE_CODE_OAUTH_TOKEN: 'real', HOME: '/h' } });
    const a = mk('m1'); const b = mk('m2');
    expect(a.env.ANTHROPIC_API_KEY).toBe('');
    expect(a.env.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(a.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(a.env.CLAUDE_CONFIG_DIR).toBe('/tmp/cfg');
    expect(a.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('16384');
    expect(a.args).toContain(String(suite.policy.maxTurns));
    expect(a.args.filter((x) => x !== 'm1')).toEqual(b.args.filter((x) => x !== 'm2').map((x) => x.replace('m2', 'm1')).filter((x) => x !== 'm1'));
  });
  it('reads usage tolerantly: unreported stays null', () => {
    expect(parseClaudeJson('not json')).toEqual({ inputTokens: null, outputTokens: null, turns: null });
    expect(parseClaudeJson(JSON.stringify({ usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 }, num_turns: 3 }))).toEqual({ inputTokens: 15, outputTokens: 7, turns: 3 });
    expect(parseClaudeJson(JSON.stringify({ usage: { input_tokens: 0 } }))).toEqual({ inputTokens: null, outputTokens: null, turns: null });
  });
});

const haveHistory = sh('git', ['-C', ROOT, 'cat-file', '-e', suite.cases[0].reference.fixSha]).code === 0;

describe.skipIf(!haveHistory)('grading isolation on a real export', () => {
  const c = admittedCases(suite)[0];
  const dir = tempDir('eval-iso-test-');
  const ws = createWorkspace(ROOT, c.reference.preFixSha, join(dir, 'tree'), ROOT);

  it('exports one commit, no remote, no fix commit, no hidden answer, no grading material', () => {
    const probe = { ...probeWorkspace(ws.dir), answerBearingTests: answerBearingTests(ROOT, ws, c) };
    expect(probe.commits).toHaveLength(1);
    expect(probe.remotes).toEqual([]);
    expect(leakFindings(c, probe)).toEqual([]);
    expect(sh('git', ['cat-file', '-e', c.reference.fixSha], { cwd: ws.dir }).code).not.toBe(0);
    expect(sh('git', ['log', '--all', '--oneline'], { cwd: ws.dir }).out.trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(ws.dir, 'eval/local-suite'))).toBe(false);
  });
  it('detects an injected hidden test as answer-bearing, and only after injection', () => {
    expect(answerBearingTests(ROOT, ws, c)).toEqual([]);
    injectHiddenTests(ROOT, ws, c);
    expect(answerBearingTests(ROOT, ws, c)).toEqual(c.hiddenTests);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!haveHistory)('tamper detection on a real workspace', () => {
  it('flags a skipped existing test and leaves a source edit alone', () => {
    const c = admittedCases(suite)[0];
    const dir = tempDir('eval-tamper-test-');
    const ws = createWorkspace(ROOT, c.reference.preFixSha, join(dir, 'tree'), ROOT);
    const test = join(ws.dir, c.visibleTests[0]);
    const src = readFileSync(test, 'utf8');
    require('node:fs').writeFileSync(test, src.replace(/\bit\(/, 'it.skip('));
    const found = detectTestTampering(changedFiles(ws), c);
    rmSync(dir, { recursive: true, force: true });
    expect(found.join('\n')).toContain('test disabled');
  });
});
