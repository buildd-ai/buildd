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
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  buildPromptV2, buildRunRecordV2, classifyAgentExit, extractJsonAnswer, answerFileOf, gradeRunV2, tamperingV2, treatmentHash, visibleTestPaths,
  HARNESS_TREATMENT_V2, HARNESS_UNKNOWNS_V2,
  type AgentExit, type CaseResultV2, type ExitClass, type VerifierRun,
} from '../../packages/core/local-eval-v2-exec';
import type { CaseFiles, EvidencePosition } from '../../packages/core/local-eval-v2';
import { redactDeep, redactText, type PlannedRun, type RunPolicy, type Split } from '../../packages/core/local-eval-v2-ops';
import { changedFiles, fullDiff, sh } from './lib';
import { cleanEnv, type AdapterV2, type AgentInvocation } from './v2-agent';
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

/**
 * A fresh temporary directory outside the repository and the run output
 * (LOCAL_EVAL_TMP, else the OS temp dir), as its canonical long path. On
 * Windows the temp dir is often an 8.3 short path (`C:\Users\ADMINI~1\...`);
 * Claude Code's permission check does not treat that as the working directory
 * and denies edits despite `acceptEdits`. The canonical path fixes that without
 * widening any permission.
 */
const REPO_ROOT = realpathSync.native(join(import.meta.dir, '..', '..'));

export function v2TempDir(prefix: string): string {
  const base = process.env.LOCAL_EVAL_TMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const real = realpathSync.native(base);
  // Inside the checkout, module resolution from the agent tree or the grader would walk up into the
  // repository's own node_modules and files: the candidate must resolve against its snapshot only.
  const rel = relative(REPO_ROOT, real);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error(`LOCAL_EVAL_TMP (${real}) is inside the repository; use a directory outside it`);
  const d = realpathSync.native(mkdtempSync(join(real, prefix)));
  LIVE_TEMP.add(d);
  return d;
}

/** Remove a v2 temporary directory and forget it. */
export function dropTemp(d: string) { rmSync(d, { recursive: true, force: true }); LIVE_TEMP.delete(d); }

const LIVE_TEMP = new Set<string>();
const LIVE_AGENTS = new Set<number>();

/**
 * For a signal handler: end every agent still running (their process groups) and
 * delete every temporary directory in use, including grading dirs that hold a
 * hidden verifier, so nothing is left for the next agent to find.
 */
export function abortLive() {
  for (const pid of LIVE_AGENTS) killTree(pid, 'SIGKILL');
  LIVE_AGENTS.clear();
  for (const d of LIVE_TEMP) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  LIVE_TEMP.clear();
}

/** Keep the tail: the result record is the last line. */
const STREAM_CAP = 32 * 1024 * 1024;
const keepTail = (acc: string, d: string) => { const s = acc + d; return s.length > STREAM_CAP ? s.slice(s.length - STREAM_CAP) : s; };

/** Ends the agent and everything it started (its own process group on POSIX, the process tree on Windows). */
function killTree(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']); return; }
  // The agent leads its own process group (detached), so the group id is its pid. No plain-pid fallback:
  // after the agent has exited, that pid may belong to an unrelated process.
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
}

export function spawnAgentReal(inv: AgentInvocation, o: { cwd: string; input: string; timeoutMs: number }): Promise<AgentExit> {
  return new Promise((done) => {
    let so = ''; let se = ''; let timedOut = false; let spawnError: string | null = null;
    const p = spawn(inv.cmd, inv.args, { cwd: o.cwd, env: inv.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    p.stdout.on('data', (d) => { so = keepTail(so, String(d)); });
    p.stderr.on('data', (d) => { se = keepTail(se, String(d)); });
    if (p.pid) LIVE_AGENTS.add(p.pid);
    p.stdin.on('error', () => { /* agent closed stdin early: its exit says why */ });
    p.stdin.end(o.input);
    const t = setTimeout(() => { timedOut = true; killTree(p.pid, 'SIGTERM'); setTimeout(() => killTree(p.pid, 'SIGKILL'), 5000).unref(); }, o.timeoutMs);
    p.on('error', (e) => { spawnError = String(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (p.pid) LIVE_AGENTS.delete(p.pid);
      // Background processes the agent left behind must not touch the tree while it is graded. POSIX only:
      // the group outlives its leader; on Windows the tree cannot be found from an exited parent, and
      // killing a pid after exit could hit a reused one.
      if (process.platform !== 'win32') killTree(p.pid, 'SIGKILL');
      done({ code: code ?? (spawnError ? 127 : 143), out: so, err: se, timedOut, spawnError });
    });
  });
}

/** Files of a tree without Git data or dependencies; symlinks are listed apart and never followed. */
function walkTree(dir: string, rel = '', out: { files: string[]; links: string[] } = { files: [], links: [] }) {
  for (const n of readdirSync(join(dir, rel))) {
    if (n === '.git' || n === 'node_modules') continue;
    const r = rel ? `${rel}/${n}` : n;
    const st = lstatSync(join(dir, r));
    if (st.isSymbolicLink()) out.links.push(r);
    else if (st.isDirectory()) walkTree(dir, r, out);
    else if (st.isFile()) out.files.push(r);
  }
  return out;
}

/** Copy a candidate's regular files only. A symlink could point a grader at material outside the tree, so none is copied. */
function copyCandidate(from: string, to: string) {
  for (const f of walkTree(from).files) { mkdirSync(dirname(join(to, f)), { recursive: true }); cpSync(join(from, f), join(to, f)); }
}

/** Environment for verifier and visible-check subprocesses: enough to start Bun and Git on any OS, nothing else. */
function toolEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ...cleanEnv(process.env, home), ...extra };
}

/**
 * Run the case's hidden verifier on a candidate directory. The candidate is
 * copied into `<tmp>/candidate`, the verifier into `<tmp>/verifier`; nothing
 * else (no reference, no candidates, no rubric) is written there. Admission
 * proved the verifier terminates on the reference and the broken candidates,
 * so a timeout here is the candidate's doing: a failed check, not a harness error.
 */
export function verifyCandidateDir(c: LoadedCase, candidateDir: string, timeoutMs = 120_000, extraEnv: Record<string, string> = {}): VerifierRun & { stderr: string } {
  const root = v2TempDir('eval-grade-');
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
    const r = sh(process.execPath, ['run', join(vdir, entry.replace(/^verifier\//, ''))], { cwd: root, env: toolEnv(root, { ...extraEnv, CANDIDATE_DIR: cand }), timeoutMs });
    if (r.code === 143) return { ran: true, passed: false, stdout: r.out, stderr: `${r.err}\nverifier timed out on the candidate after ${timeoutMs} ms` };
    return { ran: true, passed: r.code === 0, stdout: r.out, stderr: r.err };
  } finally { dropTemp(root); }
}

/** The snapshot's own tests, with pristine copies restored first so an edited test cannot grade itself. Null when the case ships none. A timeout is a failed check. */
export function runVisibleChecks(c: LoadedCase, candidateDir: string, timeoutMs = 120_000): { ran: boolean; passed: boolean | null; output: string } | null {
  const tests = visibleTestPaths(c.manifest);
  if (!tests.length) return null;
  const root = v2TempDir('eval-visible-');
  try {
    copyCandidate(candidateDir, root);
    for (const t of tests) { mkdirSync(dirname(join(root, t)), { recursive: true }); writeFileSync(join(root, t), c.files[`snapshot/${t}`]); }
    const r = sh(process.execPath, ['test', ...tests.map((t) => `./${t}`)], { cwd: root, env: toolEnv(root), timeoutMs });
    return { ran: true, passed: r.code === 0, output: `${r.out}\n${r.err}${r.code === 143 ? `\nvisible checks timed out after ${timeoutMs} ms` : ''}`.slice(-20000) };
  } finally { dropTemp(root); }
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
  const t = adapter.treatment;
  const prompt = buildPromptV2({ manifest: m, files: c.files, track: policy.track, contextTokens: policy.contextTokens, evidenceSize: i.evidenceSize, position: i.position, toolCalling, systemPrompt: t.systemPrompt, reserveTokens: t.reserveTokens });
  const execution: Record<string, unknown> = {
    treatment: { id: t.id, hash: treatmentHash(t), flags: t.flags, tools: toolCalling ? t.tools : [], toolSchemaTokens: t.toolSchemaTokens, maxOutputTokens: t.maxOutputTokens, thinking: t.thinking, reserveTokens: t.reserveTokens, compaction: t.compaction, auth: t.auth },
    // Admission evidence is per toolchain; a different Bun may grade differently until the case is re-admitted on it.
    toolchain: { now: `bun ${Bun.version}; ${process.platform}-${process.arch}`, admittedOn: m.admission?.toolchain ?? null, matchesAdmission: m.admission?.toolchain === `bun ${Bun.version}; ${process.platform}-${process.arch}` },
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

  // The agent works in a fresh temporary directory: not inside the repository (no case files, no parent
  // CLAUDE.md) and not inside the run output (no earlier trial's records or grader artifacts nearby).
  const work = v2TempDir('eval-agent-');
  const tree = join(work, 'tree');
  try {
    const exported = exportToDisk(c, tree, prompt.extraFiles);
    if (exported.leaks.length) return finish(null, notRun, null, gradeWith({ exit: null, leaks: exported.leaks }), 'agent tree leaked hidden material; the agent was not started');
    const baseline = sh('git', ['rev-parse', 'HEAD'], { cwd: tree }).out.trim();
    const configDir = join(work, 'claude-config'); const homeDir = join(work, 'home');
    mkdirSync(configDir, { recursive: true }); mkdirSync(homeDir, { recursive: true });
    const inv = adapter.invocation({ prompt: prompt.text, caseId: m.id, configDir, homeDir, maxTurns: m.resources.maxTurns, toolCalling });

    let peak: number | null = null; let samples = 0;
    const sampler = adapter.startsModel ? setInterval(() => { const v = deps.sampleVramMb(); if (v !== null) { samples++; peak = Math.max(peak ?? 0, v); } }, 2000) : null;
    execution.agentStarted = true;
    const raw = await deps.spawnAgent(inv, { cwd: tree, input: prompt.text, timeoutMs: m.resources.wallClockSeconds * 1000 }).finally(() => { if (sampler) clearInterval(sampler); });
    writeFileSync(join(runDir, 'agent.stdout.txt'), redactText(raw.out));
    writeFileSync(join(runDir, 'agent.stderr.txt'), redactText(raw.err));
    const exit = classifyAgentExit(raw);
    execution.exit = { kind: exit.kind, note: exit.note, code: raw.code, timedOut: raw.timedOut, toolCalls: exit.toolCalls };
    const vram = { peak, samples: peak === null ? null : samples };
    try {
      const answerFile = answerFileOf(m);
      if (prompt.answerChannel === 'final-message' && answerFile && (exit.kind === 'completed' || exit.kind === 'budget_exhausted')) {
        const j = extractJsonAnswer(exit.resultText);
        if (j && !existsSync(join(tree, answerFile))) writeFileSync(join(tree, answerFile), j);
      }
      const tampering: string[] = [];
      try {
        const changed = changedFiles({ dir: tree, baseline });
        writeFileSync(join(runDir, 'agent.diff'), redactText(fullDiff({ dir: tree, baseline })));
        tampering.push(...tamperingV2(changed, m));
        execution.changedFiles = changed.map((f) => `${f.status} ${f.path}`);
      } catch (e) {
        tampering.push(`the agent damaged the baseline Git data, so its changes cannot be audited (${String((e as Error).message).slice(0, 120)})`);
      }
      // A symlink in the result could point a grader at material outside the tree.
      for (const l of walkTree(tree).links) tampering.push(`symlink ${l} in the result`);
      if (exit.kind !== 'completed' && exit.kind !== 'budget_exhausted') return finish(exit, notRun, null, gradeWith({ exit, tampering }), exit.note, vram);

      const verifier = verifyCandidateDir(c, tree, deps.verifierTimeoutMs ?? 120_000);
      const visible = runVisibleChecks(c, tree, deps.verifierTimeoutMs ?? 120_000);
      writeFileSync(join(runDir, 'grading.txt'), redactText(`# hidden verifier (${verifier.ran ? (verifier.passed ? 'pass' : 'fail') : 'did not run'})\n${verifier.stdout}\n${verifier.stderr}\n# visible checks\n${visible ? visible.output : '(case ships none)'}\n`));
      const answer = answerFile && existsSync(join(tree, answerFile)) && lstatSync(join(tree, answerFile)).isFile() ? readFileSync(join(tree, answerFile), 'utf8') : null;
      const vis = visible ? { ran: visible.ran, passed: visible.passed } : null;
      return finish(exit, verifier, vis, gradeWith({ exit, tampering, verifier, visible: vis, answer }), exit.note, vram);
    } catch (e) {
      // Recorded, so a rerun does not start the agent again for this trial.
      const ex: ExitClass = { ...exit, kind: 'harness', note: `grading failed: ${String((e as Error).message).slice(0, 200)}` };
      return finish(ex, notRun, null, gradeWith({ exit: ex }), ex.note, vram);
    }
  } finally {
    // Keep the final tree (regular files and Git data; links stay links) for review and regrade, then drop the workspace.
    try { if (existsSync(tree)) cpSync(tree, join(runDir, 'tree'), { recursive: true, verbatimSymlinks: true }); } catch { /* retention is best effort */ }
    dropTemp(work);
  }
}

/** Re-run the hidden verifier on each stored final tree and compare with the recorded verdict. */
export interface Reverify { runId: string; recorded: boolean | null; now: boolean | null; changed: boolean; skipped?: string }
export function reverifyRuns(dir: string, caseOf: (id: string) => LoadedCase | null): Reverify[] {
  const out: Reverify[] = [];
  for (const d of readdirSync(dir).map((n) => join(dir, n)).filter((x) => statSync(x).isDirectory())) {
    const recPath = join(d, 'run.json'); const tree = join(d, 'tree');
    if (!existsSync(recPath) || !existsSync(tree)) continue;
    const rec = JSON.parse(readFileSync(recPath, 'utf8'));
    if (!rec.hidden?.ran) continue;
    const c = caseOf(rec.caseId); if (!c) continue;
    // Regrading against edited case bytes would compare different cases.
    const ex = existsSync(join(d, 'execution.json')) ? JSON.parse(readFileSync(join(d, 'execution.json'), 'utf8')) : null;
    if (ex?.contentHash && ex.contentHash !== c.manifest.contentHash) { out.push({ runId: rec.runId, recorded: rec.hidden.passed, now: null, changed: false, skipped: `case ${c.manifest.id} is now ${c.manifest.contentHash.slice(0, 12)}, the run used ${String(ex.contentHash).slice(0, 12)}` }); continue; }
    const v = verifyCandidateDir(c, tree);
    out.push({ runId: rec.runId, recorded: rec.hidden.passed, now: v.passed, changed: v.passed !== rec.hidden.passed });
  }
  return out;
}

export type { CaseFiles };
