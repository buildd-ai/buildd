/**
 * Which unit test files a change can break.
 *
 * Output contract (unchanged from the bash version this replaces): the LAST
 * stdout line is `ALL`, `SKIP`, or a space-separated list of test files, which
 * build.yml passes straight to scripts/run-unit-tests.ts. Reasoning goes to
 * stderr as `::notice::` lines so CI shows it without polluting the selection.
 *
 * Selection is by the REVERSE IMPORT GRAPH, not by file adjacency. Every tracked
 * JS/TS file is scanned with Bun.Transpiler, every specifier is resolved with
 * Bun.resolveSync (so tsconfig paths, workspace package exports and index files
 * resolve exactly as they do at run time), and a test is selected when its
 * transitive imports reach a changed file. The old mapper only looked at the
 * test next to a changed file, which is why it needed blunt fallbacks (any
 * packages/core change, more than 20 files => ALL); the graph replaces both.
 *
 * What the graph cannot see is handled explicitly, and every doubt resolves to
 * running more, never fewer:
 *   - `mock.module('<spec>')` targets are edges too: a test that mocks a module
 *     is broken by a change to that module's exports even if it never imports it.
 *   - A file that loads a module by a computed specifier (`import(x)`) can reach
 *     anything, so every test that reaches such a file is always selected.
 *   - Files tests read or spawn by path (fixtures, JSON, .mjs/.sh scripts) are
 *     found by a reference scan of every source for the changed path. Code that
 *     is not in the TS graph and that nothing references falls back to ALL.
 *   - A changed file that fails to parse, or that has an import nothing
 *     resolves, falls back to ALL.
 *   - Toolchain inputs (lockfile, bunfig, tsconfig, test preloads, the runner,
 *     this script, package.json dependency fields) fall back to ALL.
 *   - Selecting more than CEILING of the suite just says ALL.
 *   - Pushes and PRs into main always run ALL: dev stays the full safety net.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { basename, dirname, extname, relative, resolve as resolvePath } from 'path';
import { isUnitTestFile } from './run-unit-tests';

export type Resolution =
  | { kind: 'local'; path: string }
  | { kind: 'external' }
  | { kind: 'unresolved' };

export interface Repo {
  /** Every tracked file at HEAD, repo-relative. */
  files: readonly string[];
  /** HEAD content, or undefined when the file is absent. */
  read(path: string): string | undefined;
  /** Resolve `spec` as imported from `fromFile`. */
  resolve(spec: string, fromFile: string): Resolution;
  /** Content at the diff base, or undefined when unknown or absent. */
  readBase(path: string): string | undefined;
}

export interface Graph {
  /** file -> files it depends on (imports, re-exports, mock.module targets). */
  deps: Map<string, Set<string>>;
  /** file -> files that depend on it. */
  rdeps: Map<string, Set<string>>;
  /** file -> why its own edges are incomplete (parse failure, unresolvable import). */
  errors: Map<string, string>;
  /** file -> local specifiers that did not resolve (to match deleted files). */
  unresolved: Map<string, string[]>;
  /** Files that load a module by a computed specifier. */
  opaque: Set<string>;
  /** Source of every scanned code file. */
  sources: Map<string, string>;
}

export type Selection =
  | { kind: 'ALL'; reason: string }
  | { kind: 'SKIP'; reason: string }
  | { kind: 'LIST'; tests: string[]; reasons: Map<string, string> };

/** Selecting more than this share of the suite runs ALL instead. */
export const CEILING = 0.6;

const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
/** JS-family code: shipped as scripts tests may spawn rather than import. */
const SCRIPT_JS_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs']);
/** Executable code the TS graph cannot parse at all. */
const FOREIGN_CODE_EXT = new Set(['.sh', '.bash', '.zsh', '.py', '.rb', '.pl']);

/** Files every test process loads before the test itself (root bunfig preloads + the runner's own). */
export const PRELOADS = ['tests/setup.ts', 'scripts/stub-server-only.ts', 'scripts/test-store-guard.ts'];

/** Inputs that change how every test is resolved, loaded or selected. */
const TOOLCHAIN_EXACT = new Set([
  'bun.lock',
  'bun.lockb',
  'scripts/run-unit-tests.ts',
  'scripts/affected-tests.ts',
  'scripts/affected-tests.sh',
]);
const TOOLCHAIN_PATTERNS: RegExp[] = [/(^|\/)bunfig\.toml$/, /(^|\/)tsconfig[^/]*\.json$/, /^patches\//];

/** package.json fields that change what a specifier resolves to. Version and scripts do not. */
const RESOLUTION_FIELDS = [
  'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
  'overrides', 'resolutions', 'patchedDependencies', 'trustedDependencies',
  'workspaces', 'exports', 'imports', 'main', 'module', 'type', 'name',
];

const isCode = (path: string) => CODE_EXT.has(extname(path)) && !path.endsWith('.d.ts');

function loaderFor(path: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  const ext = extname(path);
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx') return 'jsx';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js';
  return 'ts';
}

/** Specifiers that name a file in this repo (as opposed to a dependency or builtin). */
function isLocalSpecifier(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/') || spec.startsWith('@buildd/') || spec.startsWith('@builddai/');
}

/** `import(x)` / `require(x)` with anything but a plain string literal. */
const OPAQUE_LOAD = /\b(?:import|require)\(\s*(?:[^'"`\s)]|`[^`]*\$\{)/;
/** Literal specifiers the transpiler does not report as imports. */
const EXTRA_SPECIFIERS = /\b(?:mock\.module|require\.resolve|import\.meta\.resolve)\(\s*(['"`])([^'"`$]+)\1/g;

export function buildGraph(repo: Repo): Graph {
  const deps = new Map<string, Set<string>>();
  const rdeps = new Map<string, Set<string>>();
  const errors = new Map<string, string>();
  const unresolved = new Map<string, string[]>();
  const opaque = new Set<string>();
  const sources = new Map<string, string>();
  const transpilers = new Map<string, Bun.Transpiler>();
  const tracked = new Set(repo.files);

  const addEdge = (from: string, to: string) => {
    if (from === to || !tracked.has(to)) return;
    let out = deps.get(from);
    if (!out) deps.set(from, (out = new Set()));
    out.add(to);
    let back = rdeps.get(to);
    if (!back) rdeps.set(to, (back = new Set()));
    back.add(from);
  };

  for (const file of repo.files) {
    if (!isCode(file)) continue;
    const src = repo.read(file);
    if (src === undefined) continue;
    sources.set(file, src);
    if (OPAQUE_LOAD.test(src)) opaque.add(file);

    const loader = loaderFor(file);
    let transpiler = transpilers.get(loader);
    if (!transpiler) transpilers.set(loader, (transpiler = new Bun.Transpiler({ loader })));
    const specs = new Set<string>();
    try {
      // The transpiler rejects a shebang line; blank it so offsets stay put.
      const body = src.startsWith('#!') ? src.replace(/^#![^\n]*/, '') : src;
      for (const imp of transpiler.scanImports(body)) specs.add(imp.path);
    } catch (err) {
      errors.set(file, `cannot parse: ${String((err as Error)?.message ?? err).split('\n')[0]}`);
    }
    for (const m of src.matchAll(EXTRA_SPECIFIERS)) specs.add(m[2]!);

    for (const spec of specs) {
      const r = repo.resolve(spec, file);
      if (r.kind === 'local') addEdge(file, r.path);
      else if (r.kind === 'unresolved' && isLocalSpecifier(spec)) {
        const list = unresolved.get(file) ?? [];
        list.push(spec);
        unresolved.set(file, list);
        if (!errors.has(file)) errors.set(file, `unresolvable import '${spec}'`);
      }
    }
  }
  return { deps, rdeps, errors, unresolved, opaque, sources };
}

/** Multi-source reverse BFS. Returns reached file -> [changed origin, next hop toward it]. */
function reverseReach(graph: Graph, roots: Iterable<string>): Map<string, { origin: string; via: string | null; hops: number }> {
  const seen = new Map<string, { origin: string; via: string | null; hops: number }>();
  const queue: string[] = [];
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.set(root, { origin: root, via: null, hops: 0 });
    queue.push(root);
  }
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    const here = seen.get(node)!;
    for (const parent of graph.rdeps.get(node) ?? []) {
      if (seen.has(parent)) continue;
      // `via` is what the parent imports on the way to the origin: the hop
      // nearest the test, which is the one worth printing.
      seen.set(parent, { origin: here.origin, via: here.hops === 0 ? null : node, hops: here.hops + 1 });
      queue.push(parent);
    }
  }
  return seen;
}

/** Helpers that exist for tests: fixtures, harnesses, shared stubs. */
export function isTestSupport(path: string): boolean {
  return /(^|\/)(__tests__|__fixtures__|fixtures|test-support|test-utils|test-helpers|tests?)(\/|$)/.test(path)
    || /(^|[/.-])(test-support|test-utils|test-helpers|fixtures?)\.[cm]?[jt]sx?$/.test(path);
}

/**
 * Source with comments removed (by transpiling it), so a doc comment that names
 * a path does not count as a read. Falls back to the raw source when it does
 * not transpile, which can only add a mention.
 */
const STRIPPERS = new Map<string, Bun.Transpiler>();

export function stripComments(src: string, path = 'x.ts'): string {
  try {
    const body = src.startsWith('#!') ? src.replace(/^#![^\n]*/, '') : src;
    const loader = loaderFor(path);
    let t = STRIPPERS.get(loader);
    if (!t) STRIPPERS.set(loader, (t = new Bun.Transpiler({ loader })));
    return t.transformSync(body);
  } catch {
    return src;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The shortest trailing run of path segments no other tracked file ends with. */
export function uniqueSuffix(path: string, files: readonly string[]): string | null {
  const parts = path.split('/');
  for (let n = 1; n < parts.length; n++) {
    const suffix = parts.slice(-n).join('/');
    const clash = files.some(f => f !== path && (f === suffix || f.endsWith(`/${suffix}`)));
    if (!clash) return suffix;
  }
  return null;
}

/**
 * Strings whose presence in a source means it may read, spawn or list this
 * path. `testsOnly` needles are too generic to trust in production code: a
 * bare file name (`CLAUDE.md` is also what every worktree fixture writes) or a
 * directory (`packages/core/drizzle/` is in a hundred path-manifest fixtures).
 * In a test they are still worth a run; in a library they are a fixture string,
 * and following them into its importers would select half the suite.
 */
export type Needle = { literal: string; re: RegExp; testsOnly: boolean; siblingOk: boolean };

/**
 * Production code only "reads" a path if it does file or process IO at all. One
 * that merely lists repo paths as data (an overlap policy naming generated
 * files) is not affected by their content, and is imported by most of the suite.
 */
const DOES_IO = /\b(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|createReadStream|Bun\.file|Bun\.spawn|Bun\.spawnSync|spawnSync|spawn|execSync|execFileSync|exec|Glob)\b/;

export function referenceNeedles(
  path: string,
  files: readonly string[],
  dirNames: Map<string, number>,
): Needle[] {
  const fileNeedle = (s: string): Needle => ({
    literal: s,
    re: new RegExp(`(?:^|[^A-Za-z0-9_.-])${escapeRe(s)}(?![A-Za-z0-9_])`),
    // A bare name is still specific in a sibling (`join(import.meta.dir, name)`).
    testsOnly: !s.includes('/'),
    siblingOk: true,
  });
  const needles = [fileNeedle(path)];
  const suffix = uniqueSuffix(path, files);
  if (suffix && suffix !== path) needles.push(fileNeedle(suffix));
  if (!isCode(path)) {
    // A data file can be found by listing its directory rather than by name
    // (a new migration, a new spec doc), so the directory counts as a mention:
    // its full path, or its name as a whole string (a `join(dir, 'drizzle')`
    // segment) when no other directory has that name.
    const dir = dirname(path);
    if (dir.includes('/')) {
      needles.push({ literal: dir, re: new RegExp(`(?:^|[^A-Za-z0-9_.-])${escapeRe(dir)}(?=[/'"\`])`), testsOnly: true, siblingOk: false });
    }
    const name = basename(dir);
    if (dir !== '.' && (dirNames.get(name) ?? 0) === 1 && name.length >= 4) {
      needles.push({ literal: name, re: new RegExp(`['"\`]${escapeRe(name)}['"\`]`), testsOnly: true, siblingOk: false });
    }
  }
  return needles;
}

function dirNameCounts(files: readonly string[]): Map<string, number> {
  const dirs = new Set<string>();
  for (const f of files) {
    let d = dirname(f);
    while (d !== '.' && !dirs.has(d)) {
      dirs.add(d);
      d = dirname(d);
    }
  }
  const counts = new Map<string, number>();
  for (const d of dirs) counts.set(basename(d), (counts.get(basename(d)) ?? 0) + 1);
  return counts;
}

/** Why a package.json change can alter resolution, or null when only inert fields moved. */
export function packageJsonResolutionChange(head: string | undefined, base: string | undefined): string | null {
  if (head === undefined || base === undefined) return head === base ? null : 'added or removed';
  let h: Record<string, unknown>, b: Record<string, unknown>;
  try {
    h = JSON.parse(head);
    b = JSON.parse(base);
  } catch {
    return 'unparseable';
  }
  for (const field of RESOLUTION_FIELDS) {
    if (JSON.stringify(h[field] ?? null) !== JSON.stringify(b[field] ?? null)) return `'${field}' changed`;
  }
  return null;
}

/** The forward closure of the preload files: a change anywhere in it reaches every test. */
function preloadClosure(graph: Graph): Set<string> {
  const out = new Set<string>();
  const stack = [...PRELOADS];
  while (stack.length) {
    const f = stack.pop()!;
    if (out.has(f)) continue;
    out.add(f);
    for (const d of graph.deps.get(f) ?? []) stack.push(d);
  }
  return out;
}

export function selectAffected(input: {
  changed: readonly string[];
  repo: Repo;
  graph: Graph;
  alwaysRun: readonly string[];
  isTest?: (path: string) => boolean;
  ceiling?: number;
}): Selection {
  const { repo, graph } = input;
  const isTest = input.isTest ?? isUnitTestFile;
  const changed = [...new Set(input.changed.map(f => f.trim()).filter(Boolean))].sort();
  if (changed.length === 0) return { kind: 'SKIP', reason: 'no changed files' };

  const tracked = new Set(repo.files);
  const allTests = repo.files.filter(isTest);
  const preloads = preloadClosure(graph);
  const dirNames = dirNameCounts(repo.files);

  const reasons = new Map<string, string>();
  const select = (test: string, reason: string) => {
    if (isTest(test) && tracked.has(test) && !reasons.has(test)) reasons.set(test, reason);
  };

  // Toolchain and whole-suite inputs first: any one of them settles it.
  for (const file of changed) {
    if (TOOLCHAIN_EXACT.has(file) || TOOLCHAIN_PATTERNS.some(re => re.test(file))) {
      return { kind: 'ALL', reason: `${file} changed (affects how every test is resolved, loaded or selected)` };
    }
    if (preloads.has(file)) return { kind: 'ALL', reason: `${file} changed (loaded by every test process)` };
    if (basename(file) === 'package.json') {
      const why = packageJsonResolutionChange(repo.read(file), repo.readBase(file));
      if (why) return { kind: 'ALL', reason: `${file}: ${why} (changes module resolution)` };
    }
    if (tracked.has(file) && graph.errors.has(file)) {
      return { kind: 'ALL', reason: `${file}: ${graph.errors.get(file)} (its imports cannot be followed)` };
    }
  }

  const describe = (test: string, info: { origin: string; via: string | null; hops: number }, verb: string) =>
    `${test} ← ${verb} ${info.origin}${info.via && info.via !== test ? ` (via ${info.via})` : ''}`;

  // 1. Changed test files run themselves.
  for (const file of changed) if (isTest(file)) select(file, `${file} changed`);

  // 2. Reverse import graph from every changed file that is still present.
  const present = changed.filter(f => tracked.has(f));
  const reached = reverseReach(graph, present);
  for (const [file, info] of reached) if (info.hops > 0) select(file, describe(file, info, 'imports'));

  // 3. Deleted files: anything still importing them is now broken.
  const deleted = changed.filter(f => !tracked.has(f) && isCode(f));
  if (deleted.length) {
    const stems = new Map<string, string>();
    for (const f of deleted) {
      const stem = basename(f, extname(f));
      stems.set(stem === 'index' ? basename(dirname(f)) : stem, f);
    }
    const broken: string[] = [];
    for (const [file, specs] of graph.unresolved) {
      for (const spec of specs) {
        const last = spec.replace(/\/+$/, '').split('/').pop() ?? '';
        const stem = basename(last, extname(last));
        const hit = stems.get(stem === 'index' ? (spec.split('/').at(-2) ?? '') : stem);
        if (hit) broken.push(file);
      }
    }
    for (const [file, info] of reverseReach(graph, broken)) {
      select(file, `${file} ← imports ${info.origin}, which still imports a deleted file`);
    }
  }

  // 4. Reference scan: sources that name the changed path (read, spawn, list).
  // For a changed CODE file only test code counts as a holder: production code
  // that names another source file is a comment or a fixture string, and the
  // import graph already covers how it really uses it. A data file is different
  // (a lib that reads a JSON manifest by path), so production code can hold it,
  // through the specific needles only (see referenceNeedles). Comments are
  // stripped first either way: a doc comment is not a read.
  const referenced = new Map<string, Set<string>>();
  for (const file of changed) {
    const needles = referenceNeedles(file, repo.files, dirNames);
    const fileDir = dirname(file);
    const holders = new Set<string>();
    for (const [src, text] of graph.sources) {
      if (src === file) continue;
      const candidates = needles.filter(n => text.includes(n.literal));
      if (candidates.length === 0) continue;
      let usable = candidates;
      if (!isTest(src) && !isTestSupport(src)) {
        if (isCode(file) || !DOES_IO.test(text)) continue;
        const sibling = dirname(src) === fileDir;
        usable = candidates.filter(n => !n.testsOnly || (sibling && n.siblingOk));
        if (usable.length === 0) continue;
      }
      const code = stripComments(text, src);
      if (usable.some(n => n.re.test(code))) holders.add(src);
    }
    referenced.set(file, holders);
    for (const [test, info] of reverseReach(graph, holders)) {
      select(test, info.hops === 0
        ? `${test} ← mentions ${file}`
        : `${test} ← imports ${info.origin}, which mentions ${file}`);
    }
  }

  // 5. Code the TS graph cannot vouch for. Nothing imports or names it, but a
  // test may still run it (a spawned script, a build step), so run everything.
  for (const file of changed) {
    if (!tracked.has(file)) continue;
    const ext = extname(file);
    const foreign = FOREIGN_CODE_EXT.has(ext);
    const scriptJs = SCRIPT_JS_EXT.has(ext);
    if (!foreign && !scriptJs) continue;
    const importers = graph.rdeps.get(file)?.size ?? 0;
    const mentions = referenced.get(file)?.size ?? 0;
    if (importers === 0 && mentions === 0) {
      return { kind: 'ALL', reason: `${file} is code outside the TS import graph and no test imports or names it` };
    }
  }

  // 6. Tests that reach a computed import can load anything: always in.
  for (const [file, info] of reverseReach(graph, graph.opaque)) {
    select(file, `${file} ← ${info.hops === 0 ? 'has' : `imports ${info.origin}, which has`} a computed import()`);
  }

  // 7. Repo-wide invariants.
  for (const test of input.alwaysRun) select(test, `${test} ← always-run manifest`);

  const ceiling = input.ceiling ?? CEILING;
  if (allTests.length > 0 && reasons.size > ceiling * allTests.length) {
    return { kind: 'ALL', reason: `${reasons.size} of ${allTests.length} test files selected (over ${Math.round(ceiling * 100)}%)` };
  }
  if (reasons.size === 0) return { kind: 'SKIP', reason: 'no test can reach the changed files' };
  return { kind: 'LIST', tests: [...reasons.keys()].sort(), reasons };
}

export type Mode = { kind: 'ALL'; reason: string } | { kind: 'DIFF'; base: string; label: string };

/** Pushes and PRs into main run everything; PRs elsewhere (dev, mission branches) are selected. */
export function decideMode(env: Record<string, string | undefined>): Mode {
  const base = env.GITHUB_BASE_REF;
  if (base) {
    if (base === 'main') return { kind: 'ALL', reason: 'PR into main (release or hotfix): always the full suite' };
    return { kind: 'DIFF', base: `origin/${base}`, label: `PR into ${base}` };
  }
  if (env.GITHUB_EVENT_NAME === 'push') {
    return { kind: 'ALL', reason: `push to ${env.GITHUB_REF_NAME ?? 'a branch'}: dev is the full safety net` };
  }
  if (env.GITHUB_EVENT_NAME) return { kind: 'ALL', reason: `${env.GITHUB_EVENT_NAME} event: full suite` };
  return { kind: 'DIFF', base: 'origin/dev', label: 'local run' };
}

export function readAlwaysRun(path = 'scripts/always-run-tests.txt'): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(line => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .filter(entry => existsSync(entry));
}

const git = (args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
};

/** The working tree as a Repo, with `base` (a commit-ish) for package.json comparisons. */
export function workingTreeRepo(root: string, base: string | null): Repo {
  const files = git(['ls-files', '-z']).out.split('\0').filter(Boolean).filter(f => existsSync(f));
  const cache = new Map<string, string | undefined>();
  return {
    files,
    read(path) {
      if (!cache.has(path)) {
        try {
          cache.set(path, readFileSync(path, 'utf8'));
        } catch {
          cache.set(path, undefined);
        }
      }
      return cache.get(path);
    },
    resolve(spec, fromFile) {
      let abs: string;
      try {
        abs = Bun.resolveSync(spec, resolvePath(root, dirname(fromFile)));
      } catch {
        return { kind: 'unresolved' };
      }
      if (!abs.startsWith('/')) return { kind: 'external' }; // node:fs, bun:test
      try {
        abs = realpathSync(abs);
      } catch {
        /* keep the unresolved-symlink path */
      }
      const rel = relative(root, abs);
      if (rel.startsWith('..') || rel.split('/').includes('node_modules')) return { kind: 'external' };
      return { kind: 'local', path: rel };
    },
    readBase(path) {
      if (!base) return undefined;
      const r = git(['show', `${base}:${path}`]);
      return r.ok ? r.out : undefined;
    },
  };
}

export function formatLog(selection: Selection, changedCount: number, totalTests: number): string[] {
  if (selection.kind === 'ALL') return [`Running ALL unit tests: ${selection.reason}`];
  if (selection.kind === 'SKIP') return [`Skipping unit tests: ${selection.reason}`];
  const examples = [...selection.reasons.values()]
    .filter(r => !r.endsWith('always-run manifest'))
    .slice(0, 3);
  return [
    `Selected ${selection.tests.length} of ${totalTests} test files for ${changedCount} changed file(s)`,
    ...examples.map(e => `  ${e}`),
  ];
}

function main(): void {
  const log = (line: string) => console.error(`::notice::${line}`);
  const root = process.cwd();
  const mode = decideMode(process.env);
  const seam = process.env.AFFECTED_TESTS_CHANGED;

  let changed: string[];
  let base: string | null = null;
  if (seam !== undefined) {
    // Test seam: drive the real selection without fabricating git history.
    changed = seam.split('\n');
    base = process.env.AFFECTED_TESTS_BASE ?? null;
  } else {
    if (mode.kind === 'ALL') {
      log(`Running ALL unit tests: ${mode.reason}`);
      console.log('ALL');
      return;
    }
    const mergeBase = git(['merge-base', mode.base, 'HEAD']);
    if (!mergeBase.ok) {
      log(`Running ALL unit tests: cannot find a merge base with ${mode.base}`);
      console.log('ALL');
      return;
    }
    base = mergeBase.out.trim();
    log(`${mode.label}: diffing against ${mode.base} (merge base ${base.slice(0, 12)})`);
    const diff = git(['diff', '--name-only', '--no-renames', `${base}...HEAD`]);
    if (!diff.ok) {
      log('Running ALL unit tests: git diff failed');
      console.log('ALL');
      return;
    }
    changed = diff.out.split('\n');
  }
  changed = changed.map(f => f.trim()).filter(Boolean);

  const started = performance.now();
  const repo = workingTreeRepo(root, base);
  const graph = buildGraph(repo);
  const selection = selectAffected({ changed, repo, graph, alwaysRun: readAlwaysRun() });
  const totalTests = repo.files.filter(isUnitTestFile).length;
  for (const line of formatLog(selection, changed.length, totalTests)) log(line);
  log(`Import graph: ${graph.sources.size} files in ${Math.round(performance.now() - started)}ms`);
  console.log(selection.kind === 'LIST' ? selection.tests.join(' ') : selection.kind);
}

if (import.meta.main) main();
