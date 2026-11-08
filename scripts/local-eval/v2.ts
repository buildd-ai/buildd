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
 *   cli.ts run      --suite v2 ...                          (guard only; see below)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

export function loadArtifacts(dir: string): StoredArtifact[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as StoredArtifact);
}

/** Dispatch for `--suite v2`. Returns the process exit code. */
export async function runV2(cmd: string | undefined, opt: (n: string) => string | undefined, has: (n: string) => boolean, env: { minFreeMb: number; readGpu: () => { usedMb: number; totalMb: number }[] | null; loaded: () => Promise<string[]> }): Promise<number> {
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
    // Guard first, for every case, before anything could load a model. This task ships the guard; the v2 model runner is not built.
    const id = opt('case');
    const { cases } = loadSuiteV2(root);
    const list = Object.values(cases).filter((c) => !id || c.manifest.id === id);
    if (!list.length) { console.error('no v2 cases to run'); return 2; }
    const gpus = env.readGpu(); const loaded = await env.loaded().catch(() => []);
    for (const c of list) {
      const g = inferenceGuard({ cpuOnly: c.manifest.resources.cpuOnly, estimatedVramMb: c.manifest.resources.estimatedVramMb, gpus, loadedModels: loaded, now: new Date(), purpose: 'model-run' });
      if (!g.allowed) { console.error(`${c.manifest.id}: no model started: ${g.reason}`); return 3; }
    }
    console.error('v2 model runs are not implemented yet (guard passed; nothing was started)');
    return 4;
  }
  console.error('usage with --suite v2: validate | admit | export | regrade | run');
  return 2;
}
