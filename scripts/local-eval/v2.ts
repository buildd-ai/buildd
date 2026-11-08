/**
 * I/O for the v2 coding evaluation playground (rules live in
 * packages/core/local-eval-v2.ts). `validate`, `admit`, `export` and `regrade`
 * run the hidden verifier or pure graders only: they never import Ollama and
 * never start a model. `run` refuses unless the CPU-only guard allows it.
 *
 *   cli.ts validate --suite v2 [--root eval/local-suite/v2]
 *   cli.ts admit    --suite v2 [--case id] [--evidence <dir>] [--write]
 *   cli.ts export   --suite v2 --case id --out <dir>      (agent tree: one commit, no remote)
 *   cli.ts regrade  --suite v2 --dir <artifacts dir>
 *   cli.ts list     --suite v2 [--skill s] [--difficulty d] [--category c] [--context 8192|16384|32768] [--resource cpu-only|needs-gpu|vram<=N] [--split dev|sealed-holdout] [--json]
 *   cli.ts inspect  --suite v2 --case id                    (the permitted brief only)
 *   cli.ts run      --suite v2 --model tag --harness name --context N (--preset smoke | --all | --case id) [--trials n] [--track single-context|tool-retrieval] [--dry-run]
 *   cli.ts ingest   --suite v2 --dir <runs dir> --workspace <id> [--api url]   (redacts, then POSTs run.json records)
 *   cli.ts redact   --suite v2 --dir <runs dir>              (rewrite stored artifacts with secrets and user paths removed)
 *   cli.ts prune    --suite v2 --dir <runs dir> [--days 30] [--apply]   (delete raw transcripts older than the retention period; run.json is kept)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  RETENTION_DAYS, caseRow, filterCases, hasSecret, isExpired, permittedBrief, planRuns, redactDeep, resourceLabel, redactText, sealedRow, smokeCases, validatePolicy,
  type CaseRow, type RunPolicy, type SealedDescriptor,
} from '../../packages/core/local-eval-v2-ops';
import { validateRunRecord } from '../../packages/core/local-eval';
import {
  admitCase, exportAgentTree, inferenceGuard, leakFindingsV2, regrade, validateSuiteV2,
  type CaseFiles, type CaseManifestV2, type StoredArtifact, type SuiteV2, type AdmissionEvidence,
} from '../../packages/core/local-eval-v2';
import { git, sh, tempDir } from './lib';

export const DEFAULT_ROOT = resolve(import.meta.dir, '../../eval/local-suite/v2');
const MANIFEST = 'case.json';

function readTree(dir: string, rel = ''): CaseFiles {
  const out: CaseFiles = {};
  for (const name of readdirSync(join(dir, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, r)).isDirectory()) Object.assign(out, readTree(dir, r));
    else if (r !== MANIFEST) out[r] = readFileSync(join(dir, r), 'utf8');
  }
  return out;
}

export interface LoadedCase { manifest: CaseManifestV2; files: CaseFiles; dir: string }

export function loadCase(dir: string): LoadedCase {
  return { manifest: JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as CaseManifestV2, files: readTree(dir), dir };
}

export function loadSuiteV2(root: string): { suite: SuiteV2; cases: Record<string, LoadedCase> } {
  const suiteFile = join(root, 'suite.json');
  if (!existsSync(suiteFile)) throw new Error(`v2 suite not found: ${suiteFile} does not exist (pass --root <dir> containing suite.json)`);
  const suite = JSON.parse(readFileSync(suiteFile, 'utf8')) as SuiteV2;
  const casesDir = join(root, 'cases');
  const cases: Record<string, LoadedCase> = {};
  if (existsSync(casesDir)) {
    for (const d of readdirSync(casesDir)) {
      // `_template` is documentation, not a case.
      if (d.startsWith('_') || !existsSync(join(casesDir, d, MANIFEST))) continue;
      cases[d] = loadCase(join(casesDir, d));
    }
  }
  return { suite, cases };
}

export function validateV2(root: string): string[] {
  const { suite, cases } = loadSuiteV2(root);
  return validateSuiteV2(suite, Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, { manifest: v.manifest, files: v.files }])));
}

function write(base: string, files: CaseFiles) {
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(base, p)), { recursive: true }); writeFileSync(join(base, p), c); }
}

/**
 * Run the hidden verifier on a candidate. The candidate tree is the snapshot
 * plus an overlay (`reference/`, `candidates/<name>/`); the verifier lives in a
 * sibling directory, never inside the candidate. Exit 0 = pass. The verifier is
 * the first `.ts` file in the manifest's verifier list; it reads CANDIDATE_DIR.
 */
export function makeVerifier(c: LoadedCase, timeoutMs = 120_000): (candidate: string) => boolean {
  const m = c.manifest;
  return (candidate: string) => {
    const root = tempDir('eval-verify-');
    try {
      const cand = join(root, 'candidate');
      const snap: CaseFiles = {};
      for (const p of m.files.snapshot) snap[p.replace(/^snapshot\//, '')] = c.files[p];
      write(cand, snap);
      const overlay = candidate === 'snapshot' ? null : candidate === 'reference' ? { prefix: null, paths: m.files.reference }
        : { prefix: `candidates/${candidate === 'alternative' ? m.files.candidates.alternative : candidate.replace(/^broken:/, '')}/`, paths: m.files.candidates.files };
      if (overlay) {
        for (const p of overlay.paths) {
          if (overlay.prefix && !p.startsWith(overlay.prefix)) continue;
          write(cand, { [overlay.prefix ? p.slice(overlay.prefix.length) : p.replace(/^reference\//, '')]: c.files[p] });
        }
      }
      const vdir = join(root, 'verifier');
      for (const p of m.files.verifier) write(vdir, { [p.replace(/^verifier\//, '')]: c.files[p] });
      const entry = m.files.verifier.find((p) => p.endsWith('.ts'));
      if (!entry) return false;
      const r = sh('bun', ['run', join(vdir, entry.replace(/^verifier\//, ''))], { cwd: root, env: { ...process.env, CANDIDATE_DIR: cand }, timeoutMs });
      return r.code === 0;
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
}

/** Exports the agent tree to disk as a single-commit, remote-less repository. Returns the leaks found (must be empty). */
export function exportToDisk(c: LoadedCase, out: string): { leaks: string[]; commits: string[] } {
  const tree = exportAgentTree(c.manifest, c.files);
  rmSync(out, { recursive: true, force: true });
  write(out, tree.files);
  writeFileSync(join(out, 'TASK.md'), tree.instruction);
  git(out, 'init', '-q', '-b', 'baseline');
  appendFileSync(join(out, '.git', 'info', 'exclude'), 'node_modules\n');
  git(out, '-c', 'user.name=eval', '-c', 'user.email=eval@localhost', 'add', '-A');
  git(out, '-c', 'user.name=eval', '-c', 'user.email=eval@localhost', 'commit', '-q', '-m', 'baseline');
  const probe = probeTree(out);
  return { leaks: leakFindingsV2(c.manifest, c.files, probe), commits: probe.commits };
}

export function probeTree(dir: string) {
  const files: CaseFiles = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      if (name === '.git' || name === 'node_modules') continue;
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, r)).isDirectory()) walk(r); else files[r] = readFileSync(join(dir, r), 'utf8');
    }
  };
  walk('');
  const commits = sh('git', ['log', '--format=%H', '--all'], { cwd: dir }).out.split('\n').map((s) => s.trim()).filter(Boolean);
  const remotes = sh('git', ['remote'], { cwd: dir }).out.split('\n').map((s) => s.trim()).filter(Boolean);
  return { files, commits, remotes };
}

/** Admission with stored evidence: written for admitted and rejected cases alike. */
export async function admitOne(c: LoadedCase, evidenceDir: string): Promise<AdmissionEvidence> {
  const probeDir = tempDir('eval-probe-');
  try {
    const { leaks } = exportToDisk(c, join(probeDir, 'tree'));
    const ev = await admitCase(c.manifest, makeVerifier(c), { leaks });
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `${c.manifest.id}.v${c.manifest.version}.json`), JSON.stringify({ ...ev, toolchain: `bun ${Bun.version}; ${process.platform}-${process.arch}`, checkedOn: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
    return ev;
  } finally { rmSync(probeDir, { recursive: true, force: true }); }
}

export function loadSplits(root: string): { dev: string[]; sealedHoldout: SealedDescriptor[] } {
  const f = join(root, 'splits.json');
  if (!existsSync(f)) return { dev: [], sealedHoldout: [] };
  const j = JSON.parse(readFileSync(f, 'utf8')) as { dev?: string[]; sealedHoldout?: SealedDescriptor[] };
  return { dev: j.dev ?? [], sealedHoldout: j.sealedHoldout ?? [] };
}

/** Every case this checkout knows: open cases with their split, then sealed descriptors (not runnable here). */
export function listCaseRows(root: string): CaseRow[] {
  const { cases } = loadSuiteV2(root);
  const { sealedHoldout } = loadSplits(root);
  const open = Object.values(cases).map((c) => caseRow(c.manifest, 'dev'));
  return [...open, ...sealedHoldout.map(sealedRow)];
}

/** Raw agent output kept for regrade and review; deleted after the retention period. The run record is not in this list. */
const RAW_ARTIFACTS = ['agent.stdout.txt', 'agent.stderr.txt', 'agent.diff', 'grading.txt', 'claude-config', 'tree', 'trajectory.json'];

export function runDirs(dir: string): string[] {
  return readdirSync(dir).map((d) => join(dir, d)).filter((p) => statSync(p).isDirectory());
}

export function redactRunDir(runDir: string): number {
  let changed = 0;
  for (const name of readdirSync(runDir)) {
    const p = join(runDir, name);
    if (!statSync(p).isFile() || !/\.(txt|json|diff|md)$/.test(name)) continue;
    const before = readFileSync(p, 'utf8');
    let after: string;
    if (name === 'run.json') {
      const parsed = JSON.parse(before);
      const red = redactDeep(parsed);
      after = JSON.stringify(red) === JSON.stringify(parsed) ? before : JSON.stringify(red, null, 2) + '\n';
    } else after = redactText(before);
    if (after !== before) { writeFileSync(p, after); changed++; }
  }
  return changed;
}

export function pruneRunDir(runDir: string, now: Date, days: number, apply: boolean): string[] {
  const rec = join(runDir, 'run.json');
  if (!existsSync(rec)) return [];
  if (!isExpired(statSync(rec).mtime, now, days)) return [];
  const gone = RAW_ARTIFACTS.map((n) => join(runDir, n)).filter(existsSync);
  if (apply) for (const g of gone) rmSync(g, { recursive: true, force: true });
  return gone;
}

export function loadArtifacts(dir: string): StoredArtifact[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as StoredArtifact);
}

function sealedHoldoutHas(root: string, id: string): boolean { return loadSplits(root).sealedHoldout.some((d) => d.id === id); }

/** Dispatch for `--suite v2`. Returns the process exit code. */
export async function runV2(cmd: string | undefined, opt: (n: string) => string | undefined, has: (n: string) => boolean, env: { minFreeMb: number; readGpu: () => { usedMb: number; totalMb: number }[] | null; loaded: () => Promise<string[]>; now?: () => Date }): Promise<number> {
  const root = resolve(opt('root') ?? DEFAULT_ROOT);
  if (cmd === 'validate') {
    const errs = validateV2(root);
    const { cases } = loadSuiteV2(root);
    console.log(errs.length ? errs.join('\n') : `suite v2: ${Object.keys(cases).length} cases, valid`);
    return errs.length ? 1 : 0;
  }
  if (cmd === 'admit') {
    const errs = validateV2(root);
    if (errs.length) { console.error(errs.join('\n')); return 1; }
    const { cases } = loadSuiteV2(root);
    const evidence = resolve(opt('evidence') ?? join(root, 'admission'));
    let rejected = 0;
    for (const c of Object.values(cases)) {
      if (opt('case') && c.manifest.id !== opt('case')) continue;
      const ev = await admitOne(c, evidence);
      for (const g of ev.gates) console.log(`${c.manifest.id}: ${g.ok ? 'ok  ' : 'FAIL'} ${g.gate}: ${g.detail}`);
      console.log(`${c.manifest.id}: ${ev.admitted ? 'ADMITTED' : 'NOT admitted'}`);
      if (!ev.admitted) rejected++;
      if (has('write')) {
        c.manifest.admission = { admittedOn: ev.admitted ? new Date().toISOString().slice(0, 10) : null, toolchain: `bun ${Bun.version}; ${process.platform}-${process.arch}`, gates: ev.gates };
        writeFileSync(join(c.dir, MANIFEST), JSON.stringify(c.manifest, null, 2) + '\n');
      }
    }
    return rejected ? 1 : 0;
  }
  if (cmd === 'export') {
    const id = opt('case'); const out = opt('out');
    if (!id || !out) { console.error('--case and --out are required'); return 2; }
    const c = Object.values(loadSuiteV2(root).cases).find((x) => x.manifest.id === id);
    if (!c) { console.error(`no case ${id}`); return 2; }
    const r = exportToDisk(c, resolve(out));
    console.log(r.leaks.length ? `LEAKS:\n${r.leaks.join('\n')}` : `exported ${id}: one commit, no remote, no hidden material`);
    return r.leaks.length ? 1 : 0;
  }
  if (cmd === 'list') {
    const f = filterCases(listCaseRows(root), {
      skill: opt('skill'), difficulty: opt('difficulty'), category: opt('category'), context: opt('context') ? Number(opt('context')) : undefined,
      resource: opt('resource'), split: opt('split') as 'dev' | 'sealed-holdout' | undefined,
    });
    if (f.error) { console.error(f.error); return 2; }
    if (has('json')) console.log(JSON.stringify(f.rows, null, 2));
    else {
      for (const r of f.rows) console.log(`${r.id}\tv${r.version}\t${r.category}\t${r.difficulty}\t${r.split}${r.available ? '' : ' (sealed)'}\t${resourceLabel(r)}\t${r.skills.join(',')}${r.contextSizes.length ? `\tctx ${r.contextSizes.join('/')}` : ''}`);
      console.log(`${f.rows.length} case(s)`);
    }
    return 0;
  }
  if (cmd === 'inspect') {
    const id = opt('case');
    if (!id) { console.error('--case is required'); return 2; }
    const c = Object.values(loadSuiteV2(root).cases).find((x) => x.manifest.id === id);
    if (!c) { console.error(sealedHoldoutHas(root, id) ? `${id} is sealed-holdout: its content is not in this repository` : `no case ${id}`); return 2; }
    const b = permittedBrief(c.manifest, c.files);
    console.log(`# ${b.id} (${b.category})\n\n${b.instruction}\nFiles the agent receives:\n${b.snapshotPaths.map((p) => `  ${p}`).join('\n')}\nBudget: ${b.resources.maxTurns} turns, ${b.resources.toolBudget} tool calls, ${b.resources.wallClockSeconds}s`);
    return 0;
  }
  if (cmd === 'redact') {
    const dir = opt('dir'); if (!dir) { console.error('--dir is required'); return 2; }
    let n = 0; for (const d of runDirs(resolve(dir))) n += redactRunDir(d);
    console.log(`redacted ${n} file(s)`);
    return 0;
  }
  if (cmd === 'prune') {
    const dir = opt('dir'); if (!dir) { console.error('--dir is required'); return 2; }
    const days = Number(opt('days') ?? RETENTION_DAYS);
    let n = 0;
    for (const d of runDirs(resolve(dir))) { const gone = pruneRunDir(d, new Date(), days, has('apply')); n += gone.length; for (const g of gone) console.log(`${has('apply') ? 'deleted' : 'would delete'} ${g}`); }
    console.log(`${n} raw artifact(s) older than ${days} days${has('apply') ? ' deleted' : ' (dry run; pass --apply)'}`);
    return 0;
  }
  if (cmd === 'ingest') {
    const dir = opt('dir'); const workspaceId = opt('workspace');
    if (!dir || !workspaceId) { console.error('--dir and --workspace are required'); return 2; }
    const key = process.env.BUILDD_API_KEY;
    if (!key) { console.error('BUILDD_API_KEY is required in the environment'); return 2; }
    const api = (opt('api') ?? 'https://buildd.dev').replace(/\/$/, '');
    const runs: unknown[] = [];
    for (const d of runDirs(resolve(dir))) {
      const p = join(d, 'run.json'); if (!existsSync(p)) continue;
      const raw = readFileSync(p, 'utf8');
      // A record that would store a secret-shaped string is invalid and is not sent.
      if (hasSecret(raw)) { console.error(`${p}: contains a secret-shaped string; run \`redact\` first. Not sent.`); return 1; }
      const rec = JSON.parse(raw);
      const errs = validateRunRecord(rec);
      if (errs.length) { console.error(`${p}: ${errs.join('; ')}`); return 1; }
      runs.push(rec);
    }
    if (!runs.length) { console.error('no run.json records found'); return 2; }
    for (let i = 0; i < runs.length; i += 100) {
      const res = await fetch(`${api}/api/model-observations/replay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ workspaceId, runs: runs.slice(i, i + 100) }) });
      console.log(res.status, JSON.stringify(await res.json()));
      if (!res.ok) return 1;
    }
    return 0;
  }
  if (cmd === 'regrade') {
    const dir = opt('dir');
    if (!dir) { console.error('--dir is required'); return 2; }
    let n = 0; let changed = 0;
    for (const r of regrade(loadArtifacts(resolve(dir)))) {
      n++; if (r.changedFromRecorded) changed++;
      console.log(`${r.runId} ${r.graderId}: ${r.outcome.pass ? 'pass' : 'fail'}${r.changedFromRecorded ? ' (CHANGED from recorded)' : ''} ${r.outcome.notes.join('; ')}`);
    }
    console.log(`regraded ${n} run(s), ${changed} changed`);
    return changed ? 1 : 0;
  }
  if (cmd === 'run') {
    const rows = listCaseRows(root);
    const policy: Partial<RunPolicy> = {
      model: opt('model'), harness: opt('harness'), contextTokens: Number(opt('context')),
      trials: Number(opt('trials') ?? (opt('preset') === 'smoke' ? 1 : 3)),
      track: (opt('track') as RunPolicy['track'] | undefined) ?? 'single-context', retrievalPolicy: opt('retrieval') ?? 'none',
    };
    const perr = validatePolicy(policy);
    if (opt('preset') && opt('preset') !== 'smoke') perr.push('--preset must be smoke');
    const modes = [opt('preset') ? 1 : 0, has('all') ? 1 : 0, opt('case') ? 1 : 0].reduce((a, b) => a + b, 0);
    if (modes !== 1) perr.push('choose exactly one of --preset smoke, --all, --case <id>');
    if (perr.length) { console.error(perr.join('\n')); return 2; }
    const selected = opt('preset') === 'smoke' ? smokeCases(rows)
      : opt('case') ? rows.filter((r) => r.id === opt('case'))
      : rows.filter((r) => r.split === 'dev');
    if (!selected.length) { console.error(`no v2 case matched${opt('case') ? ` ${opt('case')}` : ''}`); return 2; }
    const { cases } = loadSuiteV2(root);
    const p = policy as RunPolicy;
    // Declared capabilities of the chosen adapter; each can be turned off to record `unsupported` without touching the case.
    const adapter = { id: `${p.harness}:${p.model}`, capabilities: { toolCalling: !has('no-tool-calling'), systemPrompt: !has('no-system-prompt'), structuredOutput: !has('no-structured-output'), contextTokens: p.contextTokens } };
    const needs = Object.fromEntries(selected.filter((r) => cases[r.id]).map((r) => [r.id, { toolCalling: p.track === 'tool-retrieval' || r.category !== 'long-context-requirements', systemPrompt: false, structuredOutput: false, contextTokens: 0 }]));
    const gpus = env.readGpu(); const loaded = await env.loaded().catch(() => []);
    const plan = planRuns({ cases: selected, needs, policy: p, adapter, now: env.now?.() ?? new Date(), gpus, loadedModels: loaded });
    for (const r of plan) console.log(`${r.runId}\t${r.split}\t${r.action}${r.reason ? `\t${r.reason}` : ''}`);
    const bad = plan.filter((r) => r.action !== 'run');
    console.log(`${plan.length} planned run(s), ${plan.length - bad.length} allowed, ${bad.length} not started`);
    if (has('dry-run')) return 0;
    if (bad.some((r) => r.action === 'refused')) { console.error('no model started: the guard refused at least one run (see above)'); return 3; }
    // The model executor is not wired yet; the guard has passed and nothing was started.
    console.error('v2 model runs are not implemented yet (guard passed; nothing was started)');
    return 4;
  }
  console.error('usage with --suite v2: validate | admit | list | inspect | export | regrade | run | ingest | redact | prune');
  return 2;
}
