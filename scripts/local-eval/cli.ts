#!/usr/bin/env bun
/**
 * Local replay evaluation. See docs/local-model-evaluation.md for the runbook.
 *
 *   bun run scripts/local-eval/cli.ts validate
 *   bun run scripts/local-eval/cli.ts admit  --source <repo> --deps-from <repo> [--write]
 *   bun run scripts/local-eval/cli.ts gpu-check
 *   bun run scripts/local-eval/cli.ts run    --model <tag> --context 16384 [--case id] [--trials n] [--origin url] --out <dir> --source <repo> --deps-from <repo>
 *   bun run scripts/local-eval/cli.ts review --run <run.json> --verdict approved|changes_requested --rounds <n> --reviewer <id>
 *   bun run scripts/local-eval/cli.ts ingest --dir <out> --workspace <id> [--api https://buildd.dev]   (BUILDD_API_KEY in env)
 *
 * Nothing here is run by CI. The GPU suite is run by a person on their machine.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  SCORING_VERSION, admittedCases, buildPrompt, detectTestTampering, digestCheck, gpuGate, leakFindings, scoreRun, validateSuite,
  type RunRecord, type Suite,
} from '../../packages/core/local-eval';
import { VRAM_SAMPLING, parseNvidiaSmiMemory } from '../../packages/core/model-observation';
import { answerBearingTests, applyReference, changedFiles, createWorkspace, fullDiff, injectHiddenTests, loadSuite, probeWorkspace, restoreRunner, runTests, sh, tempDir } from './lib';
import { assertLoopback, gpuName, loadModel, loadedModels, readGpu, tagInfo, unloadModel } from './ollama';
import { claudeInvocation, parseClaudeJson } from './agent';
import { runV2 } from './v2';

const SUITE_PATH = resolve(import.meta.dir, '../../eval/local-suite/v1/suite.json');
const MODELS_PATH = resolve(import.meta.dir, '../../eval/local-suite/v1/models.json');
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n: string) => argv.includes(`--${n}`);
const need = (n: string) => { const v = opt(n); if (!v) { console.error(`--${n} is required`); process.exit(2); } return v; };
const MIN_FREE_MB = Number(process.env.LOCAL_EVAL_MIN_FREE_MB ?? 20000);

function pickCases(suite: Suite) {
  const only = opt('case');
  const list = admittedCases(suite).filter((c) => !only || c.id === only);
  if (!list.length) { console.error(only ? `no admitted case ${only}` : 'suite has no admitted cases: run `admit` first'); process.exit(2); }
  return list;
}

async function main() {
  if (opt('suite') === 'v2') {
    process.exit(await runV2(cmd, opt, has, {
      minFreeMb: MIN_FREE_MB, readGpu: () => readGpu(), loaded: async () => (await loadedModels(opt('origin') ?? 'http://127.0.0.1:11435')).map((m) => m.name),
      ollama: { tagInfo, loadModel, unloadModel }, gpuName,
      // The version of the same binary the v2 adapter starts (LOCAL_EVAL_CLAUDE_BIN or claude on PATH), so Windows records it too.
      harnessVersion: () => { const b = process.env.LOCAL_EVAL_CLAUDE_BIN || Bun.which('claude'); return b && !/\.(cmd|bat)$/i.test(b) ? sh(b, ['--version']).out.trim() || null : null; },
    }));
  }
  const suite = loadSuite(SUITE_PATH);
  if (cmd === 'validate') {
    const errs = validateSuite(suite);
    console.log(errs.length ? errs.join('\n') : `suite ${suite.suiteId}@${suite.suiteVersion}: ${suite.cases.length} cases, ${admittedCases(suite).length} admitted, valid`);
    process.exit(errs.length ? 1 : 0);
  }

  if (cmd === 'admit') {
    const source = resolve(need('source')); const deps = resolve(need('deps-from'));
    for (const c of suite.cases.filter((x) => !opt('case') || x.id === opt('case'))) {
      const root = tempDir('eval-admit-');
      const pre = createWorkspace(source, c.reference.preFixSha, join(root, 'pre'), deps);
      const visiblePre = runTests(pre, c.visibleTests);
      injectHiddenTests(source, pre, c);
      const hiddenPre = runTests(pre, c.hiddenTests);
      const ref = createWorkspace(source, c.reference.preFixSha, join(root, 'ref'), deps);
      applyReference(source, ref, c);
      const hiddenRef = runTests(ref, c.hiddenTests);
      const visibleRef = runTests(ref, c.visibleTests);
      c.admission.visibleOnPreFix = visiblePre.passed ? 'pass' : 'fail';
      c.admission.preFix = hiddenPre.passed ? 'pass' : 'fail';
      c.admission.reference = hiddenRef.passed && visibleRef.passed ? 'pass' : 'fail';
      c.admission.toolchain = `bun ${Bun.version}; ${process.platform}-${process.arch}`;
      c.admission.admittedOn = c.admission.preFix === 'fail' && c.admission.reference === 'pass' && c.admission.visibleOnPreFix === 'pass' ? new Date().toISOString().slice(0, 10) : null;
      console.log(`${c.id}: visible-on-pre-fix=${c.admission.visibleOnPreFix} hidden-on-pre-fix=${c.admission.preFix} (want fail) reference=${c.admission.reference} -> ${c.admission.admittedOn ? 'ADMITTED' : 'NOT admitted'}`);
    }
    if (has('write')) { writeFileSync(SUITE_PATH, JSON.stringify(suite, null, 2) + '\n'); console.log('suite.json updated'); }
    process.exit(0);
  }

  if (cmd === 'gpu-check') {
    const origin = opt('origin') ?? 'http://127.0.0.1:11435';
    assertLoopback(origin);
    const g = gpuGate({ gpus: readGpu(), loadedModels: (await loadedModels(origin).catch(() => [])).map((m) => m.name), minFreeMb: MIN_FREE_MB });
    console.log(g.ok ? `GPU ok: ${g.reason}` : `GPU NOT ready: ${g.reason}`);
    process.exit(g.ok ? 0 : 1);
  }

  if (cmd === 'run') {
    const source = resolve(need('source')); const deps = resolve(need('deps-from'));
    const tag = need('model'); const ctx = Number(need('context')); const out = resolve(need('out'));
    const origin = opt('origin') ?? 'http://127.0.0.1:11435';
    assertLoopback(origin);
    if (!suite.policy.contextTokens.includes(ctx)) { console.error(`context must be one of ${suite.policy.contextTokens.join(', ')}`); process.exit(2); }
    const trials = Number(opt('trials') ?? suite.policy.trials);
    const cases = pickCases(suite);

    const models = JSON.parse(readFileSync(MODELS_PATH, 'utf8')).models as Array<{ tag: string; digest: string | null }>;
    const info = await tagInfo(origin, tag);
    if (!info) { console.error(`${tag} is not pulled on ${origin}. Run: ollama pull ${tag}`); process.exit(2); }
    const dg = digestCheck(models.find((m) => m.tag === tag)?.digest ?? null, info.digest);
    if (!dg.ok) { console.error(`digest: ${dg.note}`); process.exit(2); }
    console.log(`digest ${info.digest}: ${dg.note}`);

    const gate = gpuGate({ gpus: readGpu(), loadedModels: (await loadedModels(origin)).map((m) => m.name), minFreeMb: MIN_FREE_MB });
    if (!gate.ok) { console.error(gate.reason); process.exit(3); }
    mkdirSync(out, { recursive: true });
    await loadModel(origin, tag, ctx);
    const configId = `${tag}@${ctx}`;
    const claudeVersion = sh('claude', ['--version']).out.trim() || null;
    try {
      for (const c of cases) for (let trial = 1; trial <= trials; trial++) {
        const runId = `${suite.suiteVersion}.${c.id}.${configId.replace(/[^a-z0-9.@-]/gi, '_')}.t${trial}`;
        const runDir = join(out, runId);
        if (existsSync(join(runDir, 'run.json'))) { console.log(`${runId}: already recorded, skipping`); continue; }
        mkdirSync(runDir, { recursive: true });
        const ws = createWorkspace(source, c.reference.preFixSha, join(runDir, 'tree'), deps);
        const leaks = leakFindings(c, { ...probeWorkspace(ws.dir), answerBearingTests: answerBearingTests(source, ws, c) });
        const prompt = buildPrompt(suite, c);
        const inv = claudeInvocation({ origin, tag, contextTokens: ctx, prompt: prompt.text, policy: suite.policy, configDir: join(runDir, 'claude-config'), baseEnv: process.env });
        mkdirSync(inv.env.CLAUDE_CONFIG_DIR, { recursive: true });

        const started = new Date();
        let peak: number | null = null; let samples = 0;
        const sampler = setInterval(() => {
          if (samples >= VRAM_SAMPLING.maxSamples) return;
          const r = sh('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits']);
          const used = r.code === 0 ? parseNvidiaSmiMemory(r.out) : null;
          if (used !== null) { samples++; peak = Math.max(peak ?? 0, used); }
        }, VRAM_SAMPLING.intervalMs);
        const agent = await new Promise<{ code: number; out: string; err: string; timedOut: boolean }>((done) => {
          const p = spawn(inv.cmd, inv.args, { cwd: ws.dir, env: inv.env });
          let so = ''; let se = ''; let timedOut = false;
          p.stdout.on('data', (d) => (so += d)); p.stderr.on('data', (d) => (se += d));
          const t = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, suite.policy.wallClockSeconds * 1000);
          p.on('close', (code) => { clearTimeout(t); done({ code: code ?? 1, out: so, err: se, timedOut }); });
          p.on('error', (e) => { clearTimeout(t); done({ code: 127, out: so, err: String(e), timedOut }); });
        });
        clearInterval(sampler);
        const ended = new Date();
        writeFileSync(join(runDir, 'agent.stdout.txt'), agent.out); writeFileSync(join(runDir, 'agent.stderr.txt'), agent.err);

        // Grade: record the agent's own edits first, then restore the runner and inject the hidden tests.
        const changed = changedFiles(ws);
        writeFileSync(join(runDir, 'agent.diff'), fullDiff(ws));
        const tampering = detectTestTampering(changed, c);
        restoreRunner(source, ws, c.reference.preFixSha);
        injectHiddenTests(source, ws, c);
        const hidden = runTests(ws, c.hiddenTests);
        const visible = runTests(ws, c.visibleTests);
        writeFileSync(join(runDir, 'grading.txt'), `# hidden\n${hidden.output}\n# visible\n${visible.output}`);
        const harnessError = agent.code === 127 || (agent.code !== 0 && !agent.timedOut && agent.out.trim() === '');
        const usage = parseClaudeJson(agent.out);
        const result = scoreRun({ harnessError, hidden, visible, tampering, leaks });
        const rec: RunRecord = {
          runId, suiteId: suite.suiteId, suiteVersion: suite.suiteVersion, scoringVersion: SCORING_VERSION, caseId: c.id, trial, configId,
          model: { tag, digest: info.digest, quantization: info.quantization }, contextTokens: ctx, promptHash: prompt.hash,
          harness: { name: 'claude-code', version: claudeVersion },
          runtime: { os: process.platform, arch: process.arch, ...(gpuName() ? { gpu: gpuName()! } : {}), ...(readGpu() ? { gpuMemoryMb: readGpu()![0].totalMb } : {}) },
          startedAt: started.toISOString(), endedAt: ended.toISOString(), durationMs: ended.getTime() - started.getTime(),
          ...usage, peakVramMb: peak, vramSamples: peak === null ? null : samples,
          result, hidden: { ran: hidden.ran, passed: hidden.passed }, visible: { ran: visible.ran, passed: visible.passed },
          tampering, leaks, review: null, harnessNote: agent.timedOut ? 'wall-clock limit reached' : harnessError ? `agent exited ${agent.code}` : null,
        };
        writeFileSync(join(runDir, 'run.json'), JSON.stringify(rec, null, 2) + '\n');
        console.log(`${runId}: ${result}`);
      }
    } finally {
      await unloadModel(origin, tag).catch((e) => console.error(`unload failed: ${e}`));
    }
    process.exit(0);
  }

  if (cmd === 'review') {
    const path = resolve(need('run'));
    const rec = JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
    const verdict = need('verdict');
    if (verdict !== 'approved' && verdict !== 'changes_requested') { console.error('verdict must be approved or changes_requested'); process.exit(2); }
    rec.review = { reviewer: need('reviewer'), rubricVersion: opt('rubric') ?? '1', verdict, reworkRounds: Number(opt('rounds') ?? (verdict === 'approved' ? 0 : 1)) };
    writeFileSync(path, JSON.stringify(rec, null, 2) + '\n');
    console.log(`${rec.runId}: review recorded`);
    process.exit(0);
  }

  if (cmd === 'ingest') {
    const dir = resolve(need('dir')); const workspaceId = need('workspace');
    const api = (opt('api') ?? 'https://buildd.dev').replace(/\/$/, '');
    const key = process.env.BUILDD_API_KEY;
    if (!key) { console.error('BUILDD_API_KEY is required in the environment'); process.exit(2); }
    const runs = readdirSync(dir).map((d) => join(dir, d, 'run.json')).filter(existsSync).map((p) => JSON.parse(readFileSync(p, 'utf8')));
    for (let i = 0; i < runs.length; i += 100) {
      const res = await fetch(`${api}/api/model-observations/replay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ workspaceId, runs: runs.slice(i, i + 100) }) });
      console.log(res.status, JSON.stringify(await res.json()));
      if (!res.ok) process.exit(1);
    }
    process.exit(0);
  }

  console.error('usage: validate | admit | gpu-check | run | review | ingest (see file header)');
  process.exit(2);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
