/**
 * I/O for the v2 coding evaluation playground (rules live in
 * packages/core/local-eval-v2.ts). `validate`, `admit`, `export` and `regrade`
 * run the hidden verifier or pure graders only: they never import Ollama and
 * never start a model. `run` executes planned runs (scripts/local-eval/v2-exec.ts):
 * a model adapter only after its tag, digest and the GPU guard pass; the
 * `fixture` adapter starts no model and exists to exercise the grading path.
 *
 *   cli.ts validate --suite v2 [--root eval/local-suite/v2]
 *   cli.ts admit    --suite v2 [--case id] [--evidence <dir>] [--write]
 *   cli.ts export   --suite v2 --case id --out <dir>      (agent tree: one commit, no remote)
 *   cli.ts regrade  --suite v2 --dir <artifacts dir | runs dir>   (pure graders; for a runs dir also re-runs the hidden verifier on each stored tree)
 *   cli.ts list     --suite v2 [--skill s] [--difficulty d] [--category c] [--context 8192|16384|32768] [--resource cpu-only|needs-gpu|vram<=N] [--split dev|sealed-holdout] [--json]
 *   cli.ts inspect  --suite v2 --case id                    (the permitted brief only)
 *   cli.ts run      --suite v2 --model tag --harness claude-code|fixture --context N (--preset smoke | --all [--split dev|sealed-holdout] | --case id) --out <dir>
 *                   [--trials n] [--track single-context|tool-retrieval] [--evidence-size N] [--position start|middle|end|dispersed]
 *                   [--vram-mb N] [--origin url] [--fixture-dir <dir>] [--sealed-root <dir>] [--dry-run]
 *   cli.ts report   --suite v2 --dir <runs dir>              (per config, split, track and category; splits never pooled)
 *   cli.ts ingest   --suite v2 --dir <runs dir> --workspace <id> [--api url]   (redacts, then POSTs run.json records)
 *   cli.ts redact   --suite v2 --dir <runs dir>              (rewrite stored artifacts with secrets and user paths removed)
 *   cli.ts enrich-tools --suite v2 --dir <runs dir> [--apply]  (add the bounded tool-efficiency block to runs recorded without one, from their stored stdout; no model; then `ingest` again)
 *   cli.ts prune    --suite v2 --dir <runs dir> [--days 30] [--apply]   (delete raw transcripts older than the retention period; run.json is kept)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  RETENTION_DAYS, caseRow, filterCases, isExpired, permittedBrief, planRuns, redactDeep, resourceLabel, redactText, sealedRow, smokeCases, validatePolicy,
  type CaseRow, type RunPolicy, type SealedDescriptor,
} from '../../packages/core/local-eval-v2-ops';
import { enrichRunDir, ingestRefusal } from './v2-tools';
import {
  admitCase, exportAgentTree, leakFindingsV2, regrade, validateSuiteV2,
  type CaseFiles, type CaseManifestV2, type StoredArtifact, type SuiteV2, type AdmissionEvidence,
} from '../../packages/core/local-eval-v2';
import { git, sh, tempDir } from './lib';
import { readoutV2, validateModelsV2, verifySealedContent, type CaseResultV2, type ModelsV2 } from '../../packages/core/local-eval-v2-exec';
import { requiredVramMb, type EvidencePosition, POSITIONS } from '../../packages/core/local-eval-v2';
import type { RunRecord } from '../../packages/core/local-eval';

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
        : { prefix: `candidates/${candidate === 'alternative' ? m.files.candidates.alternative : candidate.replace(/^(broken|alternative):/, '')}/`, paths: m.files.candidates.files };
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
export function exportToDisk(c: LoadedCase, out: string, extra: CaseFiles = {}): { leaks: string[]; commits: string[] } {
  const tree = exportAgentTree(c.manifest, c.files);
  rmSync(out, { recursive: true, force: true });
  write(out, tree.files);
  // Harness-derived files (tool-retrieval evidence) are built from the snapshot only, and are leak-checked with the rest.
  write(out, extra);
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

/**
 * Sealed-holdout content held outside the repository, in the same layout
 * (`<sealedRoot>/cases/<id>/case.json` + files). Each case is used only if its
 * recomputed hash equals the hash published in splits.json; otherwise it stays
 * a descriptor and the reason is returned. Its verifier and reference stay out
 * of the agent tree exactly as for an open case.
 */
export function loadSealedContent(root: string, sealedRoot: string | undefined): { cases: Record<string, LoadedCase>; errors: string[] } {
  const out: Record<string, LoadedCase> = {}; const errors: string[] = [];
  if (!sealedRoot) return { cases: out, errors };
  for (const d of loadSplits(root).sealedHoldout as (SealedDescriptor & { contentHash?: string })[]) {
    const dir = join(sealedRoot, 'cases', d.id);
    if (!existsSync(join(dir, MANIFEST))) { errors.push(`sealed ${d.id}: no content under ${sealedRoot}`); continue; }
    const c = loadCase(dir);
    const errs = verifySealedContent(d, c.manifest, c.files);
    if (errs.length) errors.push(...errs); else out[d.id] = c;
  }
  return { cases: out, errors };
}

/** Every case this checkout knows: open cases with their split, then sealed ones (runnable only when verified content was supplied). */
export function listCaseRows(root: string, sealedRoot?: string): CaseRow[] {
  const { cases } = loadSuiteV2(root);
  const { sealedHoldout } = loadSplits(root);
  const sealed = loadSealedContent(root, sealedRoot).cases;
  const open = Object.values(cases).map((c) => caseRow(c.manifest, 'dev'));
  return [...open, ...sealedHoldout.map((d) => (sealed[d.id] ? caseRow(sealed[d.id].manifest, 'sealed-holdout') : sealedRow(d)))];
}

export const MODELS_FILE = 'models.json';

export function loadModelsV2(root: string): ModelsV2 {
  const f = join(root, MODELS_FILE);
  if (!existsSync(f)) throw new Error(`${f} does not exist: list the model tags this suite may run`);
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const errs = validateModelsV2(j);
  if (errs.length) throw new Error(errs.join('; '));
  return j as ModelsV2;
}

/** Raw agent output kept for regrade and review; deleted after the retention period. The run record is not in this list. */
const RAW_ARTIFACTS = ['agent.stdout.txt', 'agent.stderr.txt', 'agent.diff', 'grading.txt', 'prompt.txt', 'claude-config', 'tree', 'trajectory.json', 'grader-artifacts.json'];

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
export interface V2Env {
  /** Fallback VRAM figure for a model whose profile has none (LOCAL_EVAL_MIN_FREE_MB). */
  minFreeMb: number;
  readGpu: () => { usedMb: number; totalMb: number }[] | null;
  loaded: () => Promise<string[]>;
  now?: () => Date;
  /** Ollama operations for a model adapter; only called after the guard passes (loadModel) or to verify the tag (tagInfo). */
  ollama?: {
    tagInfo: (origin: string, tag: string) => Promise<{ digest: string | null; quantization: string | null } | null>;
    loadModel: (origin: string, tag: string, contextTokens: number) => Promise<unknown>;
    unloadModel: (origin: string, tag: string) => Promise<unknown>;
  };
  harnessVersion?: () => string | null;
  gpuName?: () => string | null;
  /** The Claude Code binary; default: LOCAL_EVAL_CLAUDE_BIN, else `claude` on PATH (an `.exe` on Windows). */
  claudeBin?: string;
  exec?: Partial<import('./v2-exec').ExecDeps>;
}

export async function runV2(cmd: string | undefined, opt: (n: string) => string | undefined, has: (n: string) => boolean, env: V2Env): Promise<number> {
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
      // A secret-shaped string, a fixture run (no model) or an invalid record is not sent.
      const refusal = ingestRefusal(raw);
      if (refusal) { console.error(`${p}: ${refusal}`); return 1; }
      runs.push(JSON.parse(raw));
    }
    if (!runs.length) { console.error('no run.json records found'); return 2; }
    for (let i = 0; i < runs.length; i += 100) {
      const res = await fetch(`${api}/api/model-observations/replay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ workspaceId, runs: runs.slice(i, i + 100) }) });
      console.log(res.status, JSON.stringify(await res.json()));
      if (!res.ok) return 1;
    }
    return 0;
  }
  if (cmd === 'enrich-tools') {
    const dir = opt('dir'); if (!dir) { console.error('--dir is required'); return 2; }
    const counts = { enriched: 0, unchanged: 0, skipped: 0 };
    for (const d of runDirs(resolve(dir))) {
      const r = enrichRunDir(d, has('apply'));
      counts[r.action]++;
      console.log(`${r.runId ?? d} ${r.action}: ${r.reason}`);
    }
    console.log(`${counts.enriched} enriched${has('apply') ? '' : ' (dry run; pass --apply)'}, ${counts.unchanged} unchanged, ${counts.skipped} skipped. No model was started; re-run \`ingest\` to update the stored rows.`);
    return 0;
  }
  if (cmd === 'regrade') {
    const dir = opt('dir');
    if (!dir) { console.error('--dir is required'); return 2; }
    let n = 0; let changed = 0;
    const d = resolve(dir);
    const nested = runDirs(d).map((x) => join(x, 'grader-artifacts.json')).filter(existsSync).flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as StoredArtifact[]);
    if (runDirs(d).some((x) => existsSync(join(x, 'run.json')))) {
      const { cases } = loadSuiteV2(root);
      const sealed = loadSealedContent(root, opt('sealed-root')).cases;
      const { reverifyRuns } = await import('./v2-exec');
      for (const r of reverifyRuns(d, (id) => cases[id] ?? sealed[id] ?? null)) {
        if (r.skipped) { console.log(`${r.runId} verifier-v1: not regraded (${r.skipped})`); continue; }
        n++; if (r.changed) changed++;
        console.log(`${r.runId} verifier-v1: ${r.now ? 'pass' : 'fail'}${r.changed ? ' (CHANGED from recorded)' : ''}`);
      }
    }
    for (const r of regrade([...loadArtifacts(d), ...nested])) {
      n++; if (r.changedFromRecorded) changed++;
      console.log(`${r.runId} ${r.graderId}: ${r.outcome.pass ? 'pass' : 'fail'}${r.changedFromRecorded ? ' (CHANGED from recorded)' : ''} ${r.outcome.notes.join('; ')}`);
    }
    console.log(`regraded ${n} run(s), ${changed} changed`);
    return changed ? 1 : 0;
  }
  if (cmd === 'report') {
    const dir = opt('dir'); if (!dir) { console.error('--dir is required'); return 2; }
    const recs = runDirs(resolve(dir)).map((d) => join(d, 'run.json')).filter(existsSync).map((f) => JSON.parse(readFileSync(f, 'utf8')) as RunRecord);
    const rows = readoutV2(recs);
    if (has('json')) { console.log(JSON.stringify(rows, null, 2)); return 0; }
    console.log('config\tharness\tsplit\ttrack\tcategory\tpass/resolved\trate [95% Wilson]\tharness err\tinfra err\tunscored\tflags');
    for (const r of rows) {
      const n = r.pass + r.modelFail;
      console.log(`${r.configId}\t${r.harness}${r.harness === 'fixture' ? ' (NOT a model)' : ''}\t${r.split}\t${r.track}\t${r.category}\t${r.pass}/${n}\t${r.passRate === null ? 'n/a' : `${(r.passRate * 100).toFixed(0)}% [${(r.interval.lower * 100).toFixed(0)}-${(r.interval.upper * 100).toFixed(0)}]`}\t${r.harnessErrors}\t${r.infraErrors}\t${r.unscored}\t${Object.entries(r.flags).map(([k, v]) => `${k}:${v}`).join(',')}`);
    }
    console.log(`${recs.length} run record(s); dev and sealed-holdout are separate rows and never pooled; no rank or winner`);
    return 0;
  }
  if (cmd === 'run') {
    const sealedRoot = opt('sealed-root') ? resolve(opt('sealed-root')!) : undefined;
    const rows = listCaseRows(root, sealedRoot);
    const harness = opt('harness');
    const policy: Partial<RunPolicy> = {
      model: opt('model') ?? (harness === 'fixture' ? 'fixture' : undefined), harness, contextTokens: Number(opt('context')),
      trials: Number(opt('trials') ?? (opt('preset') === 'smoke' ? 1 : 3)),
      track: (opt('track') as RunPolicy['track'] | undefined) ?? 'single-context', retrievalPolicy: opt('retrieval') ?? 'none',
    };
    const perr = validatePolicy(policy);
    if (harness && harness !== 'claude-code' && harness !== 'fixture') perr.push('--harness must be claude-code or fixture');
    if (policy.track !== 'single-context' && policy.track !== 'tool-retrieval') perr.push('--track must be single-context or tool-retrieval');
    if (opt('preset') && opt('preset') !== 'smoke') perr.push('--preset must be smoke');
    if (harness === 'fixture' && !opt('fixture-dir')) perr.push('--harness fixture needs --fixture-dir <dir> (operator-authored outputs per case id)');
    // A fixture run must never share a run id with a model run.
    if (harness === 'fixture' && opt('model') && opt('model') !== 'fixture') perr.push('--harness fixture runs no model: leave out --model');
    const position = opt('position') as EvidencePosition | undefined;
    if (position && !(POSITIONS as readonly string[]).includes(position)) perr.push(`--position must be one of ${POSITIONS.join(', ')}`);
    const evidenceSize = opt('evidence-size') ? Number(opt('evidence-size')) : undefined;
    if (evidenceSize !== undefined && ![8192, 16384, 32768].includes(evidenceSize)) perr.push('--evidence-size must be 8192, 16384 or 32768');
    const modes = [opt('preset') ? 1 : 0, has('all') ? 1 : 0, opt('case') ? 1 : 0].reduce((a, b) => a + b, 0);
    if (modes !== 1) perr.push('choose exactly one of --preset smoke, --all, --case <id>');
    if (perr.length) { console.error(perr.join('\n')); return 2; }
    const split = (opt('split') as 'dev' | 'sealed-holdout' | undefined) ?? 'dev';
    const selected = opt('preset') === 'smoke' ? smokeCases(rows)
      : opt('case') ? rows.filter((r) => r.id === opt('case'))
      : rows.filter((r) => r.split === split);
    if (!selected.length) { console.error(`no v2 case matched${opt('case') ? ` ${opt('case')}` : ''}`); return 2; }
    const { cases } = loadSuiteV2(root);
    const sealed = loadSealedContent(root, sealedRoot);
    for (const e of sealed.errors) console.error(e);
    const all: Record<string, LoadedCase> = { ...cases, ...sealed.cases };
    const p = policy as RunPolicy;
    const toolCalling = !has('no-tool-calling');
    const origin = opt('origin') ?? 'http://127.0.0.1:11435';
    const { claudeAdapter, fixtureAdapter, resolveClaudeBin } = await import('./v2-agent');
    const { HARNESS_TREATMENTS_V2, HARNESS_TREATMENT_V2 } = await import('../../packages/core/local-eval-v2-exec');
    const treatment = HARNESS_TREATMENTS_V2[opt('treatment') ?? HARNESS_TREATMENT_V2.id];
    if (!treatment) { console.error(`--treatment must be one of ${Object.keys(HARNESS_TREATMENTS_V2).join(', ')}`); return 2; }
    if (harness === 'fixture' && opt('treatment')) { console.error('--treatment applies to claude-code only'); return 2; }
    const bin = harness === 'fixture' ? { cmd: null, reason: null } : resolveClaudeBin();
    const adapter = harness === 'fixture'
      ? fixtureAdapter({ fixtureDir: resolve(opt('fixture-dir')!), contextTokens: p.contextTokens, toolCalling, baseEnv: process.env })
      : claudeAdapter({ origin, tag: p.model, contextTokens: p.contextTokens, toolCalling, systemPrompt: !has('no-system-prompt'), structuredOutput: !has('no-structured-output'), baseEnv: process.env, cmd: env.claudeBin ?? bin.cmd ?? 'claude', treatment });
    // Tool calling is needed everywhere except a single-context long-context case, whose answer can come back as the final message.
    const needs = Object.fromEntries(selected.filter((r) => all[r.id]).map((r) => [r.id, { toolCalling: p.track === 'tool-retrieval' || r.category !== 'long-context-requirements', systemPrompt: false, structuredOutput: false, contextTokens: 0 }]));
    let modelVramMb: number | null = null;
    let vramSource = 'none';
    let modelEntry: ModelsV2['models'][number] | undefined;
    if (adapter.startsModel) {
      const { assertLoopback } = await import('./ollama');
      try { assertLoopback(origin); } catch (e) { console.error((e as Error).message); return 2; }
      let models: ModelsV2;
      try { models = loadModelsV2(root); } catch (e) { console.error((e as Error).message); return 2; }
      modelEntry = models.models.find((m) => m.tag === p.model);
      if (!modelEntry) { console.error(`${p.model} is not listed in ${join(root, MODELS_FILE)}; add it (digest null until first observed) before running it`); return 2; }
      const declared = opt('vram-mb') ? Number(opt('vram-mb')) : null;
      if (declared !== null && !(declared > 0)) { console.error('--vram-mb must be a positive number of MiB'); return 2; }
      modelVramMb = requiredVramMb(modelEntry.estimatedVramMb, declared) ?? env.minFreeMb;
      vramSource = declared !== null ? '--vram-mb' : modelEntry.estimatedVramMb !== null ? 'models.json' : 'LOCAL_EVAL_MIN_FREE_MB';
    }
    const gpus = adapter.startsModel ? env.readGpu() : null; const loaded = adapter.startsModel ? await env.loaded().catch(() => []) : [];
    const now = env.now?.() ?? new Date();
    // The default treatment keeps the plain config id; any other treatment is a separate configuration.
    const treatSuffix = treatment.id === HARNESS_TREATMENT_V2.id ? '' : `~${treatment.id}`;
    // Run ids name everything that changes what the agent sees: no-tools runs and, for long-context cases, the evidence set and position.
    const { defaultEvidenceSize } = await import('../../packages/core/local-eval-v2-exec');
    const variant = (id: string) => {
      const c = all[id];
      const ev = c?.manifest.category === 'long-context-requirements' ? `.e${evidenceSize ?? defaultEvidenceSize(c.manifest.longContext?.sizes ?? [8192], p.contextTokens)}-${position ?? 'dispersed'}` : '';
      return `${toolCalling ? '' : '.notools'}${treatSuffix ? '.bare' : ''}${ev}`;
    };
    const plan = planRuns({ cases: selected, needs, policy: p, adapter, now, gpus, loadedModels: loaded, startsModel: adapter.startsModel, modelVramMb })
      .map((r) => ({ ...r, runId: r.runId.replace(/\.t(\d+)$/, `${variant(r.caseId)}.t$1`), configId: `${r.configId}${toolCalling ? '' : '+notools'}${treatSuffix}` }));
    if (adapter.startsModel) console.log(`model VRAM figure ${modelVramMb} MiB (from ${vramSource}); each case's own estimate raises it when larger`);
    else console.log('fixture adapter: no model is loaded; outputs are operator-authored fixtures, NOT model results');
    for (const r of plan) console.log(`${r.runId}\t${r.split}\t${r.action}${r.reason ? `\t${r.reason}` : ''}`);
    const bad = plan.filter((r) => r.action !== 'run');
    console.log(`${plan.length} planned run(s), ${plan.length - bad.length} allowed, ${bad.length} not started`);
    const toolchain = `bun ${Bun.version}; ${process.platform}-${process.arch}`;
    const otherToolchain = [...new Set(plan.map((r) => r.caseId))].filter((id) => all[id] && all[id].manifest.admission?.toolchain !== toolchain);
    if (otherToolchain.length) console.log(`warning: ${otherToolchain.length} case(s) were admitted on a different toolchain than ${toolchain}; run \`admit --suite v2\` here (evidence to a scratch --evidence dir) before trusting their verdicts. Each run records both.`);
    console.log(`treatment ${treatment.id}`);
    if (has('dry-run')) return 0;
    // A sealed descriptor without content is reported, not scored, and does not block the rest.
    const guardRefusals = bad.filter((r) => r.action === 'refused' && all[r.caseId]);
    if (guardRefusals.length) { console.error('no model started: the guard refused at least one run (see above)'); return 3; }
    const out = opt('out');
    if (!out) { console.error('--out <dir> is required to execute runs'); return 2; }
    if (adapter.startsModel && !env.claudeBin && !bin.cmd) { console.error(`no agent started: ${bin.reason}`); return 2; }
    const pending = plan.filter((r) => r.action !== 'refused' && !existsSync(join(resolve(out), r.runId, 'run.json')));
    if (!pending.length) { console.log('every planned run is already recorded; nothing to start'); return 0; }
    mkdirSync(resolve(out), { recursive: true });
    const { executeRun, spawnAgentReal, abortLive } = await import('./v2-exec');
    const log = (l: string) => console.log(l);
    const deps = { spawnAgent: spawnAgentReal, sampleVramMb: () => { const g = env.readGpu(); return g ? g.reduce((a, x) => a + x.usedMb, 0) : null; }, now: () => new Date(), log, ...env.exec };
    let model = { tag: p.model, digest: null as string | null, quantization: null as string | null };
    const ollama = env.ollama;
    if (adapter.startsModel) {
      if (!ollama) { console.error('no Ollama client configured'); return 2; }
      const info = await ollama.tagInfo(origin, p.model).catch((e) => { console.error(`Ollama at ${origin}: ${e}`); return undefined; });
      if (info === undefined) return 3;
      if (!info) { console.error(`${p.model} is not pulled on ${origin}. Run: ollama pull ${p.model}`); return 2; }
      const { digestCheck } = await import('../../packages/core/local-eval');
      const dg = digestCheck(modelEntry!.digest, info.digest);
      if (!dg.ok) { console.error(`digest: ${dg.note}`); return 2; }
      console.log(`digest ${info.digest}: ${dg.note}`);
      model = { tag: p.model, digest: info.digest, quantization: info.quantization };
      // Re-check immediately before loading: the GPU and Ollama may have changed since planning.
      const again = planRuns({ cases: selected.filter((r) => all[r.id]), needs, policy: { ...p, trials: 1 }, adapter, now: env.now?.() ?? new Date(), gpus: env.readGpu(), loadedModels: await env.loaded().catch(() => []), startsModel: true, modelVramMb });
      const refusedNow = again.filter((r) => r.action === 'refused');
      if (refusedNow.length) { console.error(`no model started: ${refusedNow[0].reason}`); return 3; }
    }
    const gpuMem = adapter.startsModel ? env.readGpu() : null;
    const gpu = adapter.startsModel ? env.gpuName?.() ?? null : null;
    const runtime = { os: process.platform, arch: process.arch, ...(gpu ? { gpu } : {}), ...(gpuMem?.length ? { gpuMemoryMb: gpuMem.reduce((a, g) => a + g.totalMb, 0) } : {}) };
    const harnessVersion = env.harnessVersion?.() ?? null;
    const results: CaseResultV2[] = [];
    // Unload on Ctrl-C or a kill too, not only on a normal finish: a loaded model would hold the GPU for keep_alive.
    let stopping = false;
    const onSignal = (sig: NodeJS.Signals) => {
      if (stopping) return; stopping = true;
      // The agent runs in its own process group, so the terminal's Ctrl-C does not reach it: end it first,
      // or it would keep calling Ollama and load the model again.
      abortLive();
      console.error(`${sig}: stopping the batch${adapter.startsModel ? ' and unloading the model' : ''}`);
      void (adapter.startsModel && ollama ? ollama.unloadModel(origin, p.model).catch(() => {}) : Promise.resolve()).finally(() => process.exit(130));
    };
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    if (adapter.startsModel && ollama) {
      try { await ollama.loadModel(origin, p.model, p.contextTokens); } catch (e) { console.error(`model not loaded: ${(e as Error).message}`); await ollama.unloadModel(origin, p.model).catch(() => {}); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); return 3; }
    }
    try {
      for (const r of plan) {
        if (adapter.startsModel && r.action === 'run' && ollama) {
          const info = await ollama.tagInfo(origin, p.model).catch(() => null);
          if (!info || info.digest !== model.digest) { console.error(`model ${p.model} changed or vanished during the batch (digest ${info?.digest ?? 'none'}); stopping`); break; }
        }
        const res = await executeRun({
          caseOf: (id) => (all[id] ? { loaded: all[id], split: rows.find((x) => x.id === id)!.split } : null),
          planned: r, policy: p, adapter, out: resolve(out), model, harnessVersion, runtime, evidenceSize, position, deps,
        });
        results.push(res);
        console.log(`${res.runId}\t${res.outcome}${res.failureClass ? `\t${res.failureClass}` : ''}\t${res.notes.join('; ')}`);
      }
    } finally {
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
      if (adapter.startsModel && ollama && !stopping) await ollama.unloadModel(origin, p.model).catch((e) => console.error(`unload failed: ${e}`));
    }
    const count = (f: (x: CaseResultV2) => boolean) => results.filter(f).length;
    console.log(`${results.length} run(s): ${count((x) => x.outcome === 'pass')} pass, ${count((x) => x.failureClass === 'model' && x.outcome !== 'pass')} model fail/invalid, ${count((x) => x.failureClass === 'harness')} harness error, ${count((x) => x.failureClass === 'infra')} infra error, ${count((x) => x.outcome === 'unscored')} unscored, ${count((x) => x.outcome === 'skipped')} not run${adapter.harness === 'fixture' ? ' (fixture: NOT a model result)' : ''}`);
    return 0;
  }
  console.error('usage with --suite v2: validate | admit | list | inspect | export | regrade | run | report | ingest | redact | enrich-tools | prune');
  return 2;
}
