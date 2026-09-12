/**
 * Bash command classification — what is a worker actually DOING with Bash?
 *
 * `recordToolCall` (tool-metrics.ts) counts one increment per tool_use block
 * under its raw SDK tool name, so `Bash` gets a single bar and the command
 * string is never inspected. Bash is the most-called tool by a wide margin, so
 * that one bar hides most of what a session does — and specifically it hides
 * every `grep` / `rg` / `git grep` run through a shell. Those are code searches
 * that the `Grep` tool would have counted, which means `cbmFileAccessCounts`
 * (Read/Grep/Glob TOOLS only) and every metric derived from it measures a
 * denominator it does not actually observe.
 *
 * This module turns a command string into COUNTS: one bucket per call, plus a
 * coarse pattern SHAPE for code searches. It stores no command text and no
 * pattern text — ever. A search pattern can contain a secret, a path, or a
 * customer identifier, and these counters land in a production JSONB column in
 * a public-source product; a bucket name and a shape name cannot leak any of
 * that while still answering "what share of Bash is code search, and how
 * precisely could it be intercepted?".
 *
 * ## Buckets
 *
 * - `code_search`  Matching a pattern against FILE CONTENTS: the grep family
 *                  (`grep`/`egrep`/`fgrep`/`zgrep`), `rg`, `ag`, `ack`,
 *                  `ugrep`, and `git grep`. Sharply defined on purpose: this is
 *                  the bucket a "hijack grep" feature would intercept, so a
 *                  `grep` that merely filters another program's output is NOT
 *                  in it (see the pipeline rule).
 * - `file_find`    Locating files by name/path: `find`, `fd`, `locate`,
 *                  `tree`, `git ls-files`/`ls-tree`, and `ls` used recursively.
 * - `file_read`    Reading file contents whole or in part: `cat`, `bat`,
 *                  `head`, `tail`, `nl`, `wc`, `awk`, `sed -n`, pagers.
 * - `file_write`   Mutating the tree: `sed -i`, `cp`, `mv`, `rm`, `mkdir`,
 *                  `touch`, `tee`, `chmod`, `patch`, …
 * - `git`          Any other git subcommand (`status`, `diff`, `log`, `commit`,
 *                  `push`, …). `git grep` is `code_search`; `git ls-files` is
 *                  `file_find`.
 * - `gh`           The GitHub CLI. Separated from `git` because it is API/PR
 *                  work rather than local VCS work.
 * - `test`         Running tests: `bun run test`, `bun test`, `npm test`,
 *                  `vitest`, `jest`, `pytest`, `go test`, `cargo test`, a
 *                  `run` script whose target mentions "test", …
 * - `build`        Compiling, type-checking, linting, formatting, installing
 *                  dependencies — everything that validates or produces
 *                  artifacts without being a test run.
 * - `other`        Everything else: `cd`, `echo`, `pwd`, `curl`, `ps`, plain
 *                  `ls`, unrecognised binaries, and any command that cannot be
 *                  parsed. Deliberately a real bucket, not a silent drop, so
 *                  the bucket totals always reconcile with the Bash tool count.
 *
 * ## Pipelines and chains — the dominance rule
 *
 * A single Bash call is frequently several commands. Every segment of every
 * pipeline is classified (`|`, `||`, `&&`, `;`, `&`, newlines, subshells, and
 * `$(…)`/backtick substitutions all split; quoting is respected, so `rg "a && b"`
 * is one command). The call is then reported as the single **most specific**
 * intent present, ranked:
 *
 *   code_search > file_find > test > build > gh > git > file_write > file_read > other
 *
 * So `cd apps/x && grep -rn foo src` is a search, `bun install && bun run test`
 * is a test run, and `cd /tmp && pwd` is other. Rationale: the plumbing
 * (`cd`, `mkdir`, `echo`) is never why the call was made.
 *
 * One refinement, because it decides whether an interception feature would be
 * firing on the right calls: a grep-family segment counts as `code_search` only
 * if it reads files — i.e. it is first in its pipeline, or its upstream segment
 * is a file producer (`file_read` / `file_find` / another search). Downstream of
 * anything else it is a stream filter and is scored as `other`, letting the
 * upstream win. `cat x | grep y` is a search; `ps aux | grep bun` is not, and
 * `bun run test | grep -i fail` is a test run.
 *
 * Wrappers are unwrapped rather than classified: leading `VAR=value`
 * assignments, `env`, `time`, `nohup`, `timeout`, `command`, `npx`/`bunx`, and
 * `xargs` (which is classified as the command it runs, so
 * `find . | xargs grep foo` is a search). `sh -c`/`bash -c` recurse into the
 * inner script, bounded by MAX_DEPTH.
 *
 * ## Known limits (heuristic by design)
 *
 * - No variable expansion: `$EDITOR file` is `other`, and a search whose binary
 *   comes from a variable is missed.
 * - Redirections are dropped with their target, but a command that only writes
 *   via `>` (`echo x > f`) is `other`, not `file_write`.
 * - An unknown binary that happens to search (a project's own script) is
 *   `other`, so `code_search` is a floor, not a ceiling.
 * - Only the first surviving search in a call contributes a pattern shape; a
 *   call is one observation regardless of how many commands it contains.
 */

/** Buckets, in the dominance order used to reduce a multi-command call. */
export const BASH_BUCKETS = [
  'code_search',
  'file_find',
  'test',
  'build',
  'gh',
  'git',
  'file_write',
  'file_read',
  'other',
] as const;

export type BashBucket = (typeof BASH_BUCKETS)[number];

/**
 * Coarse shape of a code search's pattern. Counted, never stored verbatim.
 *
 * - `identifier`    A bare literal term with no regex metacharacters
 *                   (`recordToolCall`, `foo_bar2`) — the case a structural
 *                   index could answer exactly.
 * - `regex`         Contains regex metacharacters (`^(a|b)$`, `foo.bar`).
 * - `quoted_phrase` A quoted string containing whitespace.
 * - `path_glob`     Looks like a path or filename glob (`apps/runner/src`,
 *                   `*.test.ts`).
 * - `unknown`       No pattern argument could be identified (`rg --help`).
 */
export const SEARCH_SHAPES = ['identifier', 'regex', 'quoted_phrase', 'path_glob', 'unknown'] as const;

export type SearchShape = (typeof SEARCH_SHAPES)[number];

/**
 * Per-worker Bash histogram. Sparse on purpose: only observed keys are present,
 * so the JSON stays a couple hundred bytes for any session length.
 */
export interface BashCommandCounts {
  /** Bash calls classified (equals the `Bash` entry of the tool histogram). */
  total: number;
  /** Calls per bucket. */
  buckets: Partial<Record<BashBucket, number>>;
  /** Pattern shapes, for `code_search` calls only. */
  searchShapes: Partial<Record<SearchShape, number>>;
}

/** Result of classifying one Bash call. `searchShape` is set iff bucket is `code_search`. */
export interface BashClassification {
  bucket: BashBucket;
  searchShape?: SearchShape;
}

/** Rank of each bucket for the dominance reduction (lower wins). */
const RANK: Record<BashBucket, number> = BASH_BUCKETS.reduce(
  (acc, b, i) => { acc[b] = i; return acc; },
  {} as Record<BashBucket, number>,
);

/** Buckets whose output is file content or file paths — a valid upstream for a real search. */
const FILE_PRODUCERS: ReadonlySet<BashBucket> = new Set<BashBucket>(['file_read', 'file_find', 'code_search']);

/** Longest command prefix parsed. Bounds cost on pathological input; the tail of a 4 KB command does not change intent. */
const MAX_COMMAND_CHARS = 4000;

/** Recursion bound for `sh -c` / command substitution. */
const MAX_DEPTH = 3;

const SEARCH_BINS = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ripgrep', 'ag', 'ack', 'ack-grep', 'ugrep', 'sift', 'pt']);
const FIND_BINS = new Set(['find', 'fd', 'fdfind', 'locate', 'mlocate', 'tree']);
const READ_BINS = new Set(['cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'wc', 'strings', 'od', 'xxd', 'hexdump', 'awk']);
const WRITE_BINS = new Set(['cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'tee', 'ln', 'chmod', 'chown', 'truncate', 'patch', 'install']);
const TEST_BINS = new Set(['jest', 'vitest', 'mocha', 'pytest', 'py.test', 'phpunit', 'rspec', 'ava', 'tap', 'tox', 'gotestsum', 'nose2']);
const BUILD_BINS = new Set(['tsc', 'eslint', 'prettier', 'biome', 'swc', 'esbuild', 'webpack', 'rollup', 'tsup', 'rustc', 'cmake', 'gcc', 'clang', 'javac']);
/** Wrappers that contribute nothing and are simply dropped. */
const TRANSPARENT_WRAPPERS = new Set(['time', 'nohup', 'command', 'builtin', 'exec', 'stdbuf', 'nice', 'ionice', 'setsid']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PKG_MANAGERS = new Set(['bun', 'npm', 'pnpm', 'yarn', 'deno']);
/** Search flags that consume the NEXT token as their value (so it is not the pattern). */
const SEARCH_VALUE_FLAGS = new Set([
  '-m', '--max-count', '-A', '--after-context', '-B', '--before-context', '-C', '--context',
  '-f', '--file', '--include', '--exclude', '--exclude-dir', '-t', '--type', '-T', '--type-not',
  '-g', '--glob', '-d', '--directories', '--max-depth', '-j', '--threads', '--color', '--colour',
  '-M', '--max-columns', '--sort', '--iglob', '--binary-files',
]);
/** Characters that only make sense in a regex (never in a plain path or glob). */
const REGEX_ONLY = /[()[\]{}|^$\\+]/;

interface Token { text: string; quoted: boolean }
interface ParseResult { pipelines: Token[][][]; subs: string[] }

/** Read a balanced `$( … )` starting at the `(`. Returns the inner text and the index after the `)`. */
function readSubstitution(src: string, openParen: number): { inner: string; next: number } {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return { inner: src.slice(openParen + 1, i), next: i + 1 };
    }
  }
  return { inner: src.slice(openParen + 1), next: src.length };
}

/** Read a backtick substitution starting at the opening backtick. */
function readBacktick(src: string, start: number): { inner: string; next: number } {
  const end = src.indexOf('`', start + 1);
  if (end === -1) return { inner: src.slice(start + 1), next: src.length };
  return { inner: src.slice(start + 1, end), next: end + 1 };
}

/**
 * Split a command string into pipelines of simple commands, plus the text of
 * any command substitutions found along the way.
 *
 * Quote-aware (so operators inside a pattern do not split), tolerant of
 * unterminated quotes, and it drops redirections together with their target so
 * `rg foo > out.txt` does not see `out.txt` as an argument.
 */
function parse(src: string): ParseResult {
  const pipelines: Token[][][] = [];
  const subs: string[] = [];
  let pipeline: Token[][] = [];
  let tokens: Token[] = [];
  let cur = '';
  let curQuoted = false;
  let hasCur = false;
  let dropNext = false;

  const endToken = () => {
    if (!hasCur) return;
    if (dropNext) dropNext = false;
    else tokens.push({ text: cur, quoted: curQuoted });
    cur = '';
    curQuoted = false;
    hasCur = false;
  };
  const endCommand = () => {
    endToken();
    if (tokens.length) pipeline.push(tokens);
    tokens = [];
  };
  const endPipeline = () => {
    endCommand();
    if (pipeline.length) pipelines.push(pipeline);
    pipeline = [];
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === '\\') {
      if (i + 1 < src.length) { cur += src[i + 1]; hasCur = true; i += 2; } else i++;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      cur += end === -1 ? src.slice(i + 1) : src.slice(i + 1, end);
      curQuoted = true;
      hasCur = true;
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) { cur += src[i + 1]; hasCur = true; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '(') { const r = readSubstitution(src, i + 1); subs.push(r.inner); i = r.next; continue; }
        if (src[i] === '`') { const r = readBacktick(src, i); subs.push(r.inner); i = r.next; continue; }
        cur += src[i];
        hasCur = true;
        i++;
      }
      curQuoted = true;
      hasCur = true;
      i++;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') { const r = readSubstitution(src, i + 1); subs.push(r.inner); i = r.next; continue; }
    if (c === '`') { const r = readBacktick(src, i); subs.push(r.inner); i = r.next; continue; }
    if (c === '|') {
      if (src[i + 1] === '|') { endPipeline(); i += 2; continue; }
      endCommand();
      i++;
      continue;
    }
    if (c === '&') {
      endPipeline();
      i += src[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === ';' || c === '\n' || c === '\r') { endPipeline(); i++; continue; }
    if ((c === '(' || c === ')') && !hasCur) { endCommand(); i++; continue; }
    if (c === '>' || c === '<') {
      endToken();
      dropNext = true;
      i++;
      while (i < src.length && (src[i] === '>' || src[i] === '<' || src[i] === '&')) i++;
      continue;
    }
    if (c === ' ' || c === '\t') { endToken(); i++; continue; }
    cur += c;
    hasCur = true;
    i++;
  }
  endPipeline();
  return { pipelines, subs };
}

/** `/usr/bin/grep` → `grep`. */
function baseName(token: string): string {
  const slash = token.lastIndexOf('/');
  return slash === -1 ? token : token.slice(slash + 1);
}

/** Drop leading `VAR=value` assignments. */
function stripEnvAssignments(tokens: Token[]): Token[] {
  let i = 0;
  while (i < tokens.length && !tokens[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].text)) i++;
  return tokens.slice(i);
}

/** Drop `xargs` and its own flags, leaving the command it would run. */
function stripXargs(tokens: Token[]): Token[] {
  const valueFlags = new Set(['-n', '-P', '-I', '-L', '-s', '-a', '-E', '-d', '--max-args', '--max-procs', '--replace', '--delimiter']);
  let i = 0;
  while (i < tokens.length && tokens[i].text.startsWith('-')) {
    const flag = tokens[i].text;
    const eq = flag.indexOf('=');
    const bare = eq === -1 ? flag : flag.slice(0, eq);
    // `-n1` / `-I{}` carry their value inline; `-n 1` takes the next token.
    if (eq === -1 && valueFlags.has(bare) && flag === bare) i += 2;
    else i += 1;
  }
  return tokens.slice(i);
}

/** True when any token is a recursive-listing flag (`-R`, `-lR`, `--recursive`). */
function hasRecursiveFlag(tokens: Token[]): boolean {
  return tokens.some(t => {
    if (t.text === '--recursive') return true;
    return /^-[A-Za-z]*R/.test(t.text);
  });
}

/** Classify a `run`-script target or bare subcommand of a package manager. */
function classifyScriptTarget(target: string, rest: string): BashBucket {
  if (/^(install|i|ci|add|remove|rm|update|upgrade|link|dedupe)$/.test(target)) return 'build';
  if (/test|spec|vitest|jest/i.test(target) || /test/i.test(rest)) return 'test';
  if (/^(build|lint|typecheck|type-check|types|tsc|compile|check|format|fmt|prettier|bundle)/.test(target)) return 'build';
  return 'other';
}

/** Package-manager / runtime dispatch (`bun`, `npm`, `pnpm`, `yarn`, `deno`). */
function classifyPackageManager(rest: Token[]): BashBucket {
  if (!rest.length) return 'other';
  const sub = rest[0].text;
  if (sub === 'run' || sub === 'run-script' || sub === 'exec') {
    const target = rest[1]?.text ?? '';
    return classifyScriptTarget(target, rest.slice(1).map(t => t.text).join(' '));
  }
  return classifyScriptTarget(sub, rest.map(t => t.text).join(' '));
}

/** Build-vs-test dispatch for toolchains whose subcommand decides it. */
function classifyToolchain(name: string, rest: Token[]): BashBucket | null {
  const args = rest.map(t => t.text);
  const sub = args[0] ?? '';
  switch (name) {
    case 'go':
      if (sub === 'test') return 'test';
      return /^(build|vet|install|generate|mod)$/.test(sub) ? 'build' : 'other';
    case 'cargo':
      if (sub === 'test' || sub === 'nextest') return 'test';
      return /^(build|check|clippy|fmt|bench)$/.test(sub) ? 'build' : 'other';
    case 'make':
      return args.some(a => /test/i.test(a)) ? 'test' : 'build';
    case 'playwright':
      return sub === 'test' ? 'test' : 'other';
    case 'turbo':
      if (args.some(a => /test/i.test(a))) return 'test';
      return args.some(a => /^(build|lint|typecheck)$/.test(a)) ? 'build' : 'other';
    case 'next':
    case 'vite':
      return sub === 'build' ? 'build' : 'other';
    case 'gradle':
    case 'mvn':
    case 'dotnet':
      return args.some(a => /test/i.test(a)) ? 'test' : 'build';
    case 'python':
    case 'python3':
      return args.some(a => /pytest|unittest/i.test(a)) ? 'test' : 'other';
    default:
      return null;
  }
}

/** git subcommand dispatch: `grep` searches, `ls-files`/`ls-tree` discover, the rest is VCS work. */
function classifyGit(rest: Token[]): BashClassification {
  const sub = rest.find(t => !t.text.startsWith('-'))?.text ?? '';
  if (sub === 'grep') {
    const after = rest.slice(rest.findIndex(t => t.text === 'grep') + 1);
    return { bucket: 'code_search', searchShape: searchShapeOf(after) };
  }
  if (sub === 'ls-files' || sub === 'ls-tree') return { bucket: 'file_find' };
  return { bucket: 'git' };
}

/**
 * Identify the pattern argument of a search command and reduce it to a shape.
 * Returns `unknown` when no positional pattern can be found.
 */
export function searchShapeOf(args: Token[]): SearchShape {
  let pattern: Token | undefined;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    const text = tok.text;
    if (!tok.quoted && (text === '-e' || text === '--regexp' || text === '--pattern')) {
      pattern = args[i + 1];
      break; // explicit pattern flag beats any positional guess
    }
    if (!tok.quoted && text.startsWith('-') && text.length > 1) {
      const eq = text.indexOf('=');
      if (eq !== -1) continue; // `--include=*.ts` carries its own value
      if (SEARCH_VALUE_FLAGS.has(text)) { i++; continue; }
      continue; // boolean flag or short cluster
    }
    pattern = tok;
    break;
  }
  if (!pattern) return 'unknown';
  return shapeOfPattern(pattern.text);
}

/** Shape of a pattern string. Never returns or logs the string itself. */
function shapeOfPattern(raw: string): SearchShape {
  const text = raw.trim();
  if (!text) return 'unknown';
  if (/\s/.test(text)) return 'quoted_phrase';
  if (REGEX_ONLY.test(text)) return 'regex';
  if (text.includes('/') || text.includes('*') || text.includes('?')) return 'path_glob';
  if (text.includes('.')) return 'regex';
  return 'identifier';
}

/** Classify one simple command (no pipes), after wrapper stripping. */
function classifySimple(rawTokens: Token[], depth: number): BashClassification {
  let args = stripEnvAssignments(rawTokens);

  // Peel wrappers until a real binary is in front.
  for (let guard = 0; guard < 8 && args.length; guard++) {
    const name = baseName(args[0].text);
    if (name === 'env') {
      args = stripEnvAssignments(args.slice(1));
      continue;
    }
    if (TRANSPARENT_WRAPPERS.has(name)) { args = args.slice(1); continue; }
    if (name === 'timeout') {
      args = args.slice(1);
      while (args.length && args[0].text.startsWith('-')) {
        args = args[0].text === '-k' || args[0].text === '--kill-after' ? args.slice(2) : args.slice(1);
      }
      if (args.length && /^[\d.]+[smhd]?$/.test(args[0].text)) args = args.slice(1);
      continue;
    }
    if (name === 'xargs') { args = stripXargs(args.slice(1)); continue; }
    if (name === 'npx' || name === 'bunx' || name === 'pnpx') {
      args = args.slice(1);
      while (args.length && args[0].text.startsWith('-')) args = args.slice(1);
      continue;
    }
    if (SHELLS.has(name)) {
      const ci = args.findIndex(t => t.text === '-c');
      const inner = ci >= 0 ? args[ci + 1] : undefined;
      if (inner && depth < MAX_DEPTH) return classifyParsed(inner.text, depth + 1);
      return { bucket: 'other' };
    }
    break;
  }
  if (!args.length) return { bucket: 'other' };

  const name = baseName(args[0].text);
  const rest = args.slice(1);

  if (SEARCH_BINS.has(name)) return { bucket: 'code_search', searchShape: searchShapeOf(rest) };
  if (name === 'git') return classifyGit(rest);
  if (name === 'gh') return { bucket: 'gh' };
  if (FIND_BINS.has(name)) return { bucket: 'file_find' };
  if (name === 'ls' || name === 'exa' || name === 'eza' || name === 'lsd') {
    return { bucket: hasRecursiveFlag(rest) ? 'file_find' : 'other' };
  }
  if (name === 'sed') {
    const inPlace = rest.some(t => t.text === '-i' || t.text === '--in-place' || /^-[a-zA-Z]*i/.test(t.text));
    return { bucket: inPlace ? 'file_write' : 'file_read' };
  }
  if (READ_BINS.has(name)) return { bucket: 'file_read' };
  if (WRITE_BINS.has(name)) return { bucket: 'file_write' };
  if (TEST_BINS.has(name)) return { bucket: 'test' };
  if (BUILD_BINS.has(name)) return { bucket: 'build' };
  if (PKG_MANAGERS.has(name)) return { bucket: classifyPackageManager(rest) };
  const toolchain = classifyToolchain(name, rest);
  if (toolchain) return { bucket: toolchain };
  return { bucket: 'other' };
}

/** Parse a command string, classify every segment, reduce to the dominant intent. */
function classifyParsed(src: string, depth: number): BashClassification {
  const { pipelines, subs } = parse(src.slice(0, MAX_COMMAND_CHARS));
  const candidates: BashClassification[] = [];

  for (const pipeline of pipelines) {
    const results = pipeline.map(tokens => classifySimple(tokens, depth));
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      // A search that filters a non-file producer's output is not a code
      // search; drop it to `other` so the upstream command wins the reduction.
      if (result.bucket === 'code_search' && i > 0 && !FILE_PRODUCERS.has(results[i - 1].bucket)) {
        candidates.push({ bucket: 'other' });
        continue;
      }
      candidates.push(result);
    }
  }
  if (depth < MAX_DEPTH) {
    for (const sub of subs) candidates.push(classifyParsed(sub, depth + 1));
  }
  if (!candidates.length) return { bucket: 'other' };

  let best = candidates[0];
  for (const candidate of candidates) {
    if (RANK[candidate.bucket] < RANK[best.bucket]) best = candidate;
  }
  return best.bucket === 'code_search'
    ? { bucket: 'code_search', searchShape: best.searchShape ?? 'unknown' }
    : { bucket: best.bucket };
}

/**
 * Classify one Bash command string. Never throws: an unparseable command is
 * `other`, because a dropped call would make the bucket totals disagree with
 * the `Bash` entry of the tool histogram and there would be no way to tell
 * which number was wrong.
 */
export function classifyBashCommand(command: string): BashClassification {
  if (typeof command !== 'string' || !command.trim()) return { bucket: 'other' };
  try {
    return classifyParsed(command, 0);
  } catch {
    return { bucket: 'other' };
  }
}

/** A zeroed counter set. Buckets and shapes stay sparse until observed. */
export function emptyBashCommandCounts(): BashCommandCounts {
  return { total: 0, buckets: {}, searchShapes: {} };
}

/**
 * Classify `command` and fold it into `counts` in place.
 *
 * Ignores a missing or non-string command entirely — the Bash tool always
 * carries one, so a call without it is a shape we do not understand and
 * counting it as `other` would invent an observation.
 */
export function recordBashCommand(counts: BashCommandCounts, command: unknown): void {
  if (typeof command !== 'string' || command.length === 0) return;
  const { bucket, searchShape } = classifyBashCommand(command);
  counts.total += 1;
  counts.buckets[bucket] = (counts.buckets[bucket] ?? 0) + 1;
  if (bucket === 'code_search') {
    const shape = searchShape ?? 'unknown';
    counts.searchShapes[shape] = (counts.searchShapes[shape] ?? 0) + 1;
  }
}

/** Total classified Bash calls. */
export function totalBashCommands(counts: BashCommandCounts): number {
  return counts.total;
}
