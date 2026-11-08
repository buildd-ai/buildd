/**
 * Executes planned v2 runs (I/O half; rules in packages/core/local-eval-v2-exec.ts).
 *
 * Per run: export the case's agent tree (snapshot + instruction only, one
 * commit, no remote), build the prompt, check it fits, start the agent ONCE
 * in that tree with a clean environment and an empty per-run config dir,
 * record what it changed, then grade a COPY of its tree with the hidden
 * verifier in a separate temporary directory. The reference solution is never
 * read or copied by any of this.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildPromptV2, buildRunRecordV2, classifyAgentExit, extractJsonAnswer, answerFileOf, gradeRunV2, tamperingV2, treatmentHash, visibleTestPaths,
  HARNESS_TREATMENT_V2, HARNESS_UNKNOWNS_V2,
  type AgentExit, type CaseResultV2, type ExitClass, type VerifierRun,
} from '../../packages/core/local-eval-v2-exec';
import type { CaseFiles, EvidencePosition } from '../../packages/core/local-eval-v2';
import { redactDeep, redactText, type PlannedRun, type RunPolicy, type Split } from '../../packages/core/local-eval-v2-ops';
import { changedFiles, fullDiff, sh, tempDir } from './lib';
import type { AdapterV2, AgentInvocation } from './v2-agent';
import { exportToDisk, type LoadedCase } from './v2';

export interface ExecDeps {
  /** Start the agent. Called exactly once per executed trial. */
  spawnAgent(inv: AgentInvocation, o: { cwd: string; input: string; timeoutMs: number }): Promise<AgentExit>;
  /** One VRAM reading in MiB, or null. Only called for adapters that start a model. */
  sampleVramMb(): number | null;
  now(): Date;
  log(line: string): void;
  verifierTimeoutMs?: number;
}

export function spawnAgentReal(inv: AgentInvocation, o: { cwd: string; input: string; timeoutMs: number }): Promise<AgentExit> {
  return new Promise((done) => {
    let so = ''; let se = ''; let timedOut = false; let spawnError: string | null = null;
    const cap = 64 * 1024 * 1024;
    const p = spawn(inv.cmd, inv.args, { cwd: o.cwd, env: inv.env, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => { if (so.length < cap) so += d; });
    p.stderr.on('data', (d) => { if (se.length < cap) se += d; });
    p.stdin.on('error', () => { /* agent closed stdin early: its exit says why */ });
    p.stdin.end(o.input);
    const t = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 5000).unref(); }, o.timeoutMs);
    p.on('error', (e) => { spawnError = String(e); });
    p.on('close', (code) => { clearTimeout(t); done({ code: code ?? (spawnError ? 127 : 143), out: so, err: se, timedOut, spawnError }); });
  });
}

function filesOf(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const n of readdirSync(join(dir, rel))) {
    if (n === '.git' || n === 'node_modules') continue;
    const r = rel ? `${rel}/${n}` : n;
    if (statSync(join(dir, r)).isDirectory()) out.push(...filesOf(dir, r)); else out.push(r);
  }
  return out;
}

/** Copy a candidate tree without its Git data or dependencies. */
function copyCandidate(from: string, to: string) {
  for (const f of filesOf(from)) { mkdirSync(dirname(join(to, f)), { recursive: true }); cpSync(join(from, f), join(to, f)); }
}

/**
 * Run the case's hidden verifier on a candidate directory. The candidate is
 * copied into `<tmp>/candidate`, the verifier into `<tmp>/verifier`; nothing
 * else (no reference, no candidates, no rubric) is written there.
 */
export function verifyCandidateDir(c: LoadedCase, candidateDir: string, timeoutMs = 120_000, extraEnv: Record<string, string> = {}): VerifierRun & { stderr: string } {
  const root = tempDir('eval-grade-');
  try {
    const cand = join(root, 'candidate');
    mkdirSync(cand, { recursive: true });
    copyCandidate(candidateDir, cand);
    const vdir = join(root, 'verifier');
    for (const p of c.manifest.files.verifier) {
      const dst = join(vdir, p.replace(/^verifier\//, ''));
      mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, c.files[p]);
    }
    const entry = c.manifest.files.verifier.find((p) => p.endsWith('.ts'));
    if (!entry) return { ran: false, passed: null, stdout: '', stderr: 'no verifier entry' };
    const r = sh(process.execPath, ['run', join(vdir, entry.replace(/^verifier\//, ''))], { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extraEnv, CANDIDATE_DIR: cand }, timeoutMs });
    if (r.code === 143) return { ran: false, passed: null, stdout: r.out, stderr: `${r.err}\nverifier timed out` };
    return { ran: true, passed: r.code === 0, stdout: r.out, stderr: r.err };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** The snapshot's own tests, with pristine copies restored first so an edited test cannot grade itself. Null when the case ships none. */
export function runVisibleChecks(c: LoadedCase, candidateDir: string, timeoutMs = 120_000): { ran: boolean; passed: boolean | null; output: string } | null {
  const tests = visibleTestPaths(c.manifest);
  if (!tests.length) return null;
  const root = tempDir('eval-visible-');
  try {
    copyCandidate(candidateDir, root);
    for (const t of tests) { mkdirSync(dirname(join(root, t)), { recursive: true }); writeFileSync(join(root, t), c.files[`snapshot/${t}`]); }
    const r = sh(process.execPath, ['test', ...tests.map((t) => `./${t}`)], { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, timeoutMs });
    return { ran: r.code !== 143, passed: r.code === 143 ? null : r.code === 0, output: `${r.out}\n${r.err}`.slice(-20000) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export interface ExecuteInput {
  caseOf: (id: string) => { loaded: LoadedCase; split: Split } | null;
  planned: PlannedRun;
  policy: RunPolicy;
  adapter: AdapterV2;
  out: string;
  model: { tag: string; digest: string | null; quantization: string | null };
  harnessVersion: string | null;
  runtime: Record<string, unknown> | null;
  evidenceSize?: number;
  position?: EvidencePosition;
  deps: ExecDeps;
}

function writeRecord(runDir: string, rec: unknown, execution: unknown, artifacts: unknown[]) {
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(redactDeep(rec), null, 2) + '\n');
  writeFileSync(join(runDir, 'execution.json'), JSON.stringify(redactDeep(execution), null, 2) + '\n');
  if (artifacts.length) writeFileSync(join(runDir, 'grader-artifacts.json'), JSON.stringify(redactDeep(artifacts), null, 2) + '\n');
}

/** One trial. Returns a typed result; writes `run.json` and its raw artifacts under `<out>/<runId>/`. */
export async function executeRun(i: ExecuteInput): Promise<CaseResultV2> {
  const { planned: p, policy, adapter, deps } = i;
  const found = i.caseOf(p.caseId);
  const runDir = join(i.out, p.runId);
  const base = { runId: p.runId, caseId: p.caseId, trial: p.trial, split: p.split };
  if (existsSync(join(runDir, 'run.json'))) return { ...base, outcome: 'skipped', failureClass: null, notes: ['already recorded'] };
  if (!found || p.action === 'refused') return { ...base, outcome: 'skipped', failureClass: null, notes: [p.reason ?? 'case content not available; not run and not scored'] };
  const { loaded: c, split } = found;
  const m = c.manifest;
  mkdirSync(runDir, { recursive: true });
  const toolCalling = adapter.capabilities.toolCalling;
  const prompt = buildPromptV2({ manifest: m, files: c.files, track: policy.track, contextTokens: policy.contextTokens, evidenceSize: i.evidenceSize, position: i.position, toolCalling });
  const execution: Record<string, unknown> = {
    treatment: { id: HARNESS_TREATMENT_V2.id, hash: treatmentHash(), tools: toolCalling ? HARNESS_TREATMENT_V2.tools : [], reserveTokens: HARNESS_TREATMENT_V2.reserveTokens, compaction: HARNESS_TREATMENT_V2.compaction },
    harness: adapter.harness, adapterId: adapter.id, fixture: adapter.harness === 'fixture',
    budgets: { maxTurns: m.resources.maxTurns, toolBudget: m.resources.toolBudget, wallClockSeconds: m.resources.wallClockSeconds },
    caseVersion: m.version, contentHash: m.contentHash,
    prompt: { hash: prompt.hash, estimatedTokens: prompt.estimatedTokens, tokenMethod: prompt.tokenMethod, answerChannel: prompt.answerChannel },
    evidence: prompt.evidence, overflow: prompt.overflow, truncation: 'unknown', unknowns: HARNESS_UNKNOWNS_V2,
    agentStarted: false,
  };
  writeFileSync(join(runDir, 'prompt.txt'), prompt.text);
  const started = deps.now();
  const finish = (exit: ExitClass | null, verifier: VerifierRun, visible: { ran: boolean; passed: boolean | null } | null, grade: ReturnType<typeof gradeRunV2>, note: string | null, vram: { peak: number | null; samples: number | null } = { peak: null, samples: null }): CaseResultV2 => {
    const rec = buildRunRecordV2({
      planned: p, manifest: m, split, policy, model: i.model, harness: { name: adapter.harness, version: i.harnessVersion }, runtime: i.runtime as never,
      promptHash: prompt.hash, startedAt: started, endedAt: deps.now(), exit, peakVramMb: vram.peak, vramSamples: vram.samples, verifier, visible, grade, note,
    });
    writeRecord(runDir, rec, execution, grade.artifacts);
    return { ...base, outcome: rec.result, failureClass: rec.v2!.failureClass, notes: grade.score.notes };
  };
  const notRun: VerifierRun = { ran: false, passed: null, stdout: '' };
  const gradeWith = (o: { exit: ExitClass | null; leaks?: string[]; tampering?: string[]; verifier?: VerifierRun; visible?: { ran: boolean; passed: boolean | null } | null; answer?: string | null; unsupported?: string | null; overflow?: typeof prompt.overflow }) => gradeRunV2({
    runId: p.runId, manifest: m, exit: o.exit, overflow: o.overflow ?? null, unsupported: o.unsupported ?? null, leaks: o.leaks ?? [], tampering: o.tampering ?? [],
    verifier: o.verifier ?? notRun, visible: o.visible ?? null, outputs: { answer: o.answer ?? null }, toolBudget: m.resources.toolBudget, contextTokens: policy.contextTokens,
  });

  if (p.action === 'unsupported') return finish(null, notRun, null, gradeWith({ exit: null, unsupported: (p.reason ?? 'unsupported').replace(/^unsupported: /, '') }), p.reason);
  if (prompt.overflow) return finish(null, notRun, null, gradeWith({ exit: null, overflow: prompt.overflow }), 'prompt does not fit the loaded context; the agent was not started and nothing was truncated');

  const tree = join(runDir, 'tree');
  const exported = exportToDisk(c, tree, prompt.extraFiles);
  if (exported.leaks.length) return finish(null, notRun, null, gradeWith({ exit: null, leaks: exported.leaks }), 'agent tree leaked hidden material; the agent was not started');
  const baseline = sh('git', ['rev-parse', 'HEAD'], { cwd: tree }).out.trim();
  const configDir = join(runDir, 'claude-config');
  mkdirSync(configDir, { recursive: true });
  const inv = adapter.invocation({ prompt: prompt.text, caseId: m.id, configDir, maxTurns: m.resources.maxTurns, toolCalling });

  let peak: number | null = null; let samples = 0;
  const sampler = adapter.startsModel ? setInterval(() => { const v = deps.sampleVramMb(); if (v !== null) { samples++; peak = Math.max(peak ?? 0, v); } }, 2000) : null;
  execution.agentStarted = true;
  const raw = await deps.spawnAgent(inv, { cwd: tree, input: prompt.text, timeoutMs: m.resources.wallClockSeconds * 1000 });
  if (sampler) clearInterval(sampler);
  writeFileSync(join(runDir, 'agent.stdout.txt'), redactText(raw.out));
  writeFileSync(join(runDir, 'agent.stderr.txt'), redactText(raw.err));
  const exit = classifyAgentExit(raw);
  execution.exit = { kind: exit.kind, note: exit.note, code: raw.code, timedOut: raw.timedOut, toolCalls: exit.toolCalls };
  const vram = { peak, samples: peak === null ? null : samples };

  const answerFile = answerFileOf(m);
  if (prompt.answerChannel === 'final-message' && answerFile && (exit.kind === 'completed' || exit.kind === 'budget_exhausted')) {
    const j = extractJsonAnswer(exit.resultText);
    if (j && !existsSync(join(tree, answerFile))) writeFileSync(join(tree, answerFile), j);
  }
  const changed = changedFiles({ dir: tree, baseline });
  writeFileSync(join(runDir, 'agent.diff'), redactText(fullDiff({ dir: tree, baseline })));
  const tampering = tamperingV2(changed, m);
  execution.changedFiles = changed.map((f) => `${f.status} ${f.path}`);
  if (exit.kind !== 'completed' && exit.kind !== 'budget_exhausted') return finish(exit, notRun, null, gradeWith({ exit, tampering }), exit.note, vram);

  const verifier = verifyCandidateDir(c, tree, deps.verifierTimeoutMs ?? 120_000);
  const visible = runVisibleChecks(c, tree, deps.verifierTimeoutMs ?? 120_000);
  writeFileSync(join(runDir, 'grading.txt'), redactText(`# hidden verifier (${verifier.ran ? (verifier.passed ? 'pass' : 'fail') : 'did not run'})\n${verifier.stdout}\n${verifier.stderr}\n# visible checks\n${visible ? visible.output : '(case ships none)'}\n`));
  const answer = answerFile && existsSync(join(tree, answerFile)) ? readFileSync(join(tree, answerFile), 'utf8') : null;
  return finish(exit, verifier, visible ? { ran: visible.ran, passed: visible.passed } : null, gradeWith({ exit, tampering, verifier, visible: visible ? { ran: visible.ran, passed: visible.passed } : null, answer }), exit.note, vram);
}

/** Re-run the hidden verifier on each stored final tree and compare with the recorded verdict. */
export function reverifyRuns(dir: string, caseOf: (id: string) => LoadedCase | null): { runId: string; recorded: boolean | null; now: boolean | null; changed: boolean }[] {
  const out: { runId: string; recorded: boolean | null; now: boolean | null; changed: boolean }[] = [];
  for (const d of readdirSync(dir).map((n) => join(dir, n)).filter((x) => statSync(x).isDirectory())) {
    const recPath = join(d, 'run.json'); const tree = join(d, 'tree');
    if (!existsSync(recPath) || !existsSync(tree)) continue;
    const rec = JSON.parse(readFileSync(recPath, 'utf8'));
    if (!rec.hidden?.ran) continue;
    const c = caseOf(rec.caseId); if (!c) continue;
    const v = verifyCandidateDir(c, tree);
    out.push({ runId: rec.runId, recorded: rec.hidden.passed, now: v.passed, changed: v.passed !== rec.hidden.passed });
  }
  return out;
}

export type { CaseFiles };
