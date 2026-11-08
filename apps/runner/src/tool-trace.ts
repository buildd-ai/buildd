/**
 * Local, bounded, per-call tool trace.
 *
 * `tool-metrics.ts` counts calls, `bash-classify.ts` buckets Bash into counts,
 * `action-events.ts` ships buildd action names. None of them can answer "did
 * this search find anything, and did the agent run it again after the files
 * changed?" because that needs one record per call joined to its result.
 * This module is that record. It is OBSERVATION ONLY: it reads tool_use and
 * tool_result blocks the worker already sees and never alters a prompt, a tool
 * input, a permission or a result.
 *
 * ## What stays local
 *
 * Raw commands, queries, paths and results never leave the machine. The trace
 * file lives under a runner-local directory (0700 dir, 0600 file) and only when
 * persistence is opted into. What may be sent to the platform is
 * `summarizeToolTrace()`: enum counts and dropped-event counters, no hashes, no
 * paths, no text. Fingerprints are HMACs keyed by a per-trace random salt, so
 * they compare within one trace and nowhere else.
 *
 * ## Measured vs estimated
 *
 * Every number says where it came from: `output.basis` is `measured` (the full
 * result text was seen), `estimated` (the harness truncated it, so the figure
 * is a lower bound) or `absent` (no text, e.g. an image or no result at all).
 * `exitCodeBasis` is `structured`, `parsed_text`, `inferred` (success with no
 * code shown) or `absent`. Bytes are not tokens; this module never converts.
 *
 * ## Classification honesty
 *
 * Shell parsing is heuristic. A command this module cannot parse with
 * confidence (unbalanced quotes, heredocs, `eval`, a variable as the binary,
 * an unrecognised binary, an over-long command) is category `unknown`, never a
 * guess. `bash-classify.ts` supplies the bucket for everything it can parse.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalToolName } from '@buildd/shared';
import { classifyBashSearch, type BashBucket } from './bash-classify';

export const TRACE_SCHEMA_VERSION = 1;

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const TRACE_CATEGORIES = [
  'search', 'find', 'read', 'write', 'test', 'build', 'git', 'gh',
  'shell_other', 'mcp', 'web', 'agent', 'other_tool', 'unknown',
] as const;
export type TraceCategory = (typeof TRACE_CATEGORIES)[number];

export type TraceOrigin = 'native' | 'shell' | 'mcp' | 'other';
export type TraceHarness = 'claude' | 'codex' | 'unknown';

export const TRACE_OUTCOMES = [
  'ok', 'no_matches', 'empty_output', 'error', 'path_unavailable', 'denied',
  'timeout', 'cancelled', 'nonzero_unmodeled', 'unobserved',
] as const;
export type TraceOutcome = (typeof TRACE_OUTCOMES)[number];

export type Basis = 'measured' | 'estimated' | 'absent';
export type ExitCodeBasis = 'structured' | 'parsed_text' | 'inferred' | 'absent';
export type RepeatKind = 'none' | 'repeat_unchanged' | 'repeat_after_change';

/** `search_role` only exists for shell commands that contain a grep-family segment. */
export type SearchRole = 'repo_search' | 'output_filter';

export interface TraceScope {
  /** Normalised, repo-relative path operands. Local only. */
  paths: string[];
  /** Whitelisted flag names only (`-i`, `--hidden`); values are never kept except `limit`. */
  options: string[];
  patternShape: string | null;
  /** How much of the call was understood. */
  parse: 'full' | 'partial' | 'none';
}

export interface TraceEvent {
  kind: 'call';
  v: typeof TRACE_SCHEMA_VERSION;
  callId: string;
  seq: number;
  ts: number;
  tool: string;
  category: TraceCategory;
  origin: TraceOrigin;
  /** Shell commands only: what the dominant bash-classify bucket said. */
  shellBucket?: BashBucket;
  searchRole?: SearchRole;
  elapsedMs: number | null;
  outcome: TraceOutcome;
  exitCode: number | null;
  exitCodeBasis: ExitCodeBasis;
  /** True only when a tool_result for this call was seen. */
  resultObserved: boolean;
  output: { bytes: number | null; lines: number | null; basis: Basis };
  truncated: boolean;
  limit: number | null;
  denial?: 'policy' | 'os';
  scope: TraceScope | null;
  /** HMAC of the scoped call; null for categories that are never compared. */
  fingerprint: string | null;
  repeat: { kind: RepeatKind; priorSeq?: number; priorCount?: number; priorOutcome?: TraceOutcome };
  /** Why a shell command was left `unknown` (e.g. `unbalanced_quote`). An enum label, never text. Additive; readers may ignore it. */
  parseFailure?: string;
  /** HMAC of the exact call (tool + input) for non-write calls; compares within one trace only. Additive. */
  callKey?: string;
  /** HMAC of the first 8 KB of the result text, when a result was seen. Additive. */
  resultDigest?: string;
  /** Present only when excerpts are opted into: redacted and length-bounded. */
  excerpt?: string;
}

export interface TraceHeader {
  kind: 'header';
  v: typeof TRACE_SCHEMA_VERSION;
  taskId: string;
  attempt: number;
  workerId?: string;
  harness: TraceHarness;
  /** Resolved model and config, as the runner resolved them for this attempt. */
  model: string | null;
  config: Record<string, string | number | boolean | null>;
  salt: string;
  startedAt: number;
}

export interface TraceCounters {
  recorded: number;
  droppedByEventCap: number;
  droppedByByteCap: number;
  sampledOut: number;
  fingerprintEvictions: number;
  /** Calls seen with no result by the time the trace closed. */
  unobserved: number;
}

export interface ToolTraceOptions {
  taskId: string;
  attempt?: number;
  workerId?: string;
  harness?: TraceHarness;
  model?: string | null;
  config?: Record<string, string | number | boolean | null>;
  /** Repo root, used to make path operands repo-relative. */
  root?: string;
  /** Opt-in persistence. Unset = in-memory only. */
  persistDir?: string;
  /** Opt-in: keep a redacted, bounded excerpt of each command/query. Default off. */
  captureExcerpts?: boolean;
  excerptChars?: number;
  /** Worker secret redactor, applied before the built-in patterns. */
  redact?: (text: string) => string;
  maxEvents?: number;
  maxBytes?: number;
  /** Beyond this many recorded events, keep one in `sampleEvery`. */
  sampleAfter?: number;
  sampleEvery?: number;
  maxFingerprints?: number;
  maxPendingCalls?: number;
  flushEvery?: number;
  now?: () => number;
}

export const DEFAULT_TRACE_LIMITS = {
  maxEvents: 1000,
  maxBytes: 512 * 1024,
  sampleAfter: 600,
  sampleEvery: 5,
  maxFingerprints: 2000,
  maxPendingCalls: 256,
  maxEditedPaths: 2000,
  flushEvery: 16,
  excerptChars: 160,
  maxCommandChars: 4000,
} as const;

// ── Redaction ───────────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /\bbld_[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*)\S+/gi,
];

/** Remove secrets from a string. Runs the worker's own redactor first. */
export function redactExcerpt(text: string, redact?: (t: string) => string): string {
  let out = text;
  try { if (redact) out = redact(out); } catch { /* a broken redactor must not leak: fall through to patterns */ }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, p1) => (typeof p1 === 'string' && p1.length < m.length ? `${p1}[redacted]` : '[redacted]'));
  }
  return out;
}

// ── Shell tokenising (just enough to scope a search, and to refuse to guess) ─

const SEARCH_BINS = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ripgrep', 'ag', 'ack', 'ack-grep', 'ugrep']);
/** Binaries whose presence alone is a confident `shell_other`. */
const KNOWN_OTHER_BINS = new Set([
  'cd', 'echo', 'pwd', 'ls', 'ps', 'pgrep', 'curl', 'wget', 'sleep', 'true', 'false', 'export', 'unset', 'kill',
  'which', 'date', 'uname', 'whoami', 'id', 'sort', 'uniq', 'cut', 'tr', 'jq', 'printf', 'test', '[', 'env',
  'basename', 'dirname', 'realpath', 'readlink', 'stat', 'du', 'df', 'lsof', 'ss', 'netstat', 'xargs', 'tee',
  'head', 'tail', 'wc', 'sed', 'awk', 'cat', 'set', 'wait', 'exit', 'time', 'timeout', 'nohup', 'command',
]);
const GIT_MUTATING = new Set(['checkout', 'switch', 'reset', 'restore', 'stash', 'pull', 'merge', 'rebase', 'apply', 'cherry-pick', 'clean', 'revert', 'am']);
const SEARCH_BOOL_FLAGS = new Set([
  '-i', '-n', '-r', '-R', '-l', '-L', '-c', '-w', '-x', '-F', '-v', '-E', '-P', '-H', '-h', '-o', '-s', '-q', '-I', '-a', '-z', '-U',
  '--hidden', '--no-ignore', '--ignore-case', '--smart-case', '--files-with-matches', '--count', '--fixed-strings',
  '--word-regexp', '--invert-match', '--no-heading', '--line-number', '--no-messages', '--recursive', '--follow',
  '--multiline', '--files', '--untracked', '--cached', '--null',
]);
const SEARCH_VALUE_FLAGS = new Set([
  '-m', '--max-count', '-A', '--after-context', '-B', '--before-context', '-C', '--context', '-g', '--glob', '-t', '--type',
  '-T', '--type-not', '--include', '--exclude', '--exclude-dir', '--max-depth', '-d', '--directories', '-j', '--threads',
  '--color', '--colour', '-M', '--max-columns', '--sort', '--iglob', '--binary-files', '-f', '--file',
]);
const LIMIT_FLAGS = new Set(['-m', '--max-count']);

interface Segment { tokens: string[]; sep: '' | '|' | '&&' | '||' | ';' | '&' }

interface Tokenised { segments: Segment[]; ok: boolean; reason?: string }

/** Quote-aware split into simple commands. `ok=false` means "do not trust this parse". */
export function tokeniseShell(src: string, maxChars: number = DEFAULT_TRACE_LIMITS.maxCommandChars): Tokenised {
  if (src.length > maxChars) return { segments: [], ok: false, reason: 'too_long' };
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let cur = '';
  let has = false;
  const endTok = () => { if (has) { tokens.push(cur); cur = ''; has = false; } };
  const endSeg = (sep: Segment['sep']) => { endTok(); if (tokens.length) segments.push({ tokens, sep }); tokens = []; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { if (i + 1 < src.length) { cur += src[i + 1]; has = true; i += 2; } else i++; continue; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return { segments: [], ok: false, reason: 'unbalanced_quote' };
      cur += src.slice(i + 1, end); has = true; i = end + 1; continue;
    }
    if (c === '"') {
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '\\' && i + 1 < src.length) { cur += src[i + 1]; i += 2; continue; }
        if (src[i] === '"') { closed = true; i++; break; }
        cur += src[i]; i++;
      }
      if (!closed) return { segments: [], ok: false, reason: 'unbalanced_quote' };
      has = true; continue;
    }
    if (c === '<' && src[i + 1] === '<') return { segments: [], ok: false, reason: 'heredoc' };
    if (c === '<' && src[i + 1] === '(') return { segments: [], ok: false, reason: 'process_substitution' };
    if (c === '|') { if (src[i + 1] === '|') { endSeg('||'); i += 2; } else { endSeg('|'); i++; } continue; }
    if (c === '&') {
      if (src[i + 1] === '>') { i += 2; continue; }
      if (src[i + 1] === '&') { endSeg('&&'); i += 2; } else { endSeg('&'); i++; }
      continue;
    }
    if (c === ';' || c === '\n' || c === '\r') { endSeg(';'); i++; continue; }
    if (c === '>' || c === '<') {
      endTok();
      i++;
      while (i < src.length && (src[i] === '>' || src[i] === '<' || src[i] === '&')) i++;
      while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
      // Drop the redirect target (a file, or `&1`).
      while (i < src.length && !/[\s|&;<>]/.test(src[i])) i++;
      continue;
    }
    if (c === ' ' || c === '\t') { endTok(); i++; continue; }
    cur += c; has = true; i++;
  }
  endSeg('');
  return { segments, ok: true };
}

function baseName(t: string): string { const s = t.lastIndexOf('/'); return s === -1 ? t : t.slice(s + 1); }

/** First real binary of a segment, skipping env assignments and a few transparent wrappers. */
function binaryOf(tokens: string[]): { bin: string; rest: string[] } | null {
  let i = 0;
  for (let guard = 0; guard < 8 && i < tokens.length; guard++) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    const b = baseName(t);
    if (b === 'env' || b === 'time' || b === 'nohup' || b === 'command' || b === 'exec') { i++; continue; }
    return { bin: b, rest: tokens.slice(i + 1) };
  }
  return null;
}

// ── Classification ──────────────────────────────────────────────────────────

export interface ShellTraceClass {
  category: TraceCategory;
  bucket?: BashBucket;
  searchRole?: SearchRole;
  /** A single simple command: exit-code semantics of its binary apply to the call's exit code. */
  single: boolean;
  /** The one search segment, when the call is a single search. */
  search?: { family: 'grep' | 'rg' | 'git_grep'; args: string[] };
  /** Git subcommand that rewrites the working tree. */
  mutatesTree: boolean;
  unknownReason?: string;
}

const BUCKET_TO_CATEGORY: Record<BashBucket, TraceCategory> = {
  code_search: 'search', file_find: 'find', file_read: 'read', file_write: 'write', test: 'test',
  build: 'build', gh: 'gh', git: 'git', other: 'shell_other',
};

/** Classify one shell command for tracing, refusing to guess where parsing is untrustworthy. */
export function classifyShellForTrace(command: string): ShellTraceClass {
  const base: ShellTraceClass = { category: 'unknown', single: false, mutatesTree: false };
  if (typeof command !== 'string' || !command.trim()) return { ...base, unknownReason: 'empty' };
  const tok = tokeniseShell(command);
  if (!tok.ok) return { ...base, unknownReason: tok.reason };
  if (!tok.segments.length) return { ...base, unknownReason: 'empty' };

  const bins = tok.segments.map(s => binaryOf(s.tokens));
  for (const b of bins) {
    if (!b) return { ...base, unknownReason: 'no_binary' };
    if (b.bin.startsWith('$') || b.bin.startsWith('`') || b.bin.includes('$(')) return { ...base, unknownReason: 'variable_binary' };
    if (b.bin === 'eval' || b.bin === 'source' || b.bin === '.') return { ...base, unknownReason: 'eval' };
  }

  const { classification } = classifyBashSearch(command);
  const bucket = classification.bucket;
  const single = tok.segments.length === 1;
  const mutatesTree = bins.some(b => b?.bin === 'git' && gitSubcommand(b.rest) !== null && GIT_MUTATING.has(gitSubcommand(b.rest) as string));

  let category = BUCKET_TO_CATEGORY[bucket];
  if (bucket === 'other') {
    // `other` is bash-classify's bucket for both "known and boring" and "never heard of it".
    const allKnown = bins.every(b => b && (KNOWN_OTHER_BINS.has(b.bin) || SEARCH_BINS.has(b.bin)));
    if (!allKnown) category = 'unknown';
  }
  const out: ShellTraceClass = {
    category, bucket, single, mutatesTree,
    ...(category === 'unknown' ? { unknownReason: 'unrecognised_binary' } : {}),
  };

  // A grep-family segment that is not the search the bucket reports is an output filter.
  const hasDownstreamGrep = tok.segments.some((_seg, i) => {
    const b = bins[i];
    return !!b && SEARCH_BINS.has(b.bin) && i > 0 && tok.segments[i - 1].sep === '|';
  });
  if (bucket === 'code_search') out.searchRole = 'repo_search';
  else if (hasDownstreamGrep) out.searchRole = 'output_filter';

  if (single && bucket === 'code_search' && bins[0]) {
    const { bin, rest } = bins[0];
    if (bin === 'git') {
      const gi = rest.findIndex(t => t === 'grep');
      if (gi >= 0) out.search = { family: 'git_grep', args: rest.slice(gi + 1) };
    } else if (SEARCH_BINS.has(bin)) {
      out.search = { family: bin === 'rg' || bin === 'ripgrep' ? 'rg' : 'grep', args: rest };
    }
  }
  return out;
}

function gitSubcommand(rest: string[]): string | null {
  const sub = rest.find(t => !t.startsWith('-'));
  return sub ?? null;
}

// ── Scope parsing ───────────────────────────────────────────────────────────

/** Make a path operand repo-relative; anything outside the root is `<outside>`. */
export function normaliseTracePath(p: unknown, root?: string): string | null {
  if (typeof p !== 'string' || !p) return null;
  let rel = p;
  if (p.startsWith('/')) {
    if (!root) return '<abs>';
    const base = root.endsWith('/') ? root : `${root}/`;
    if (p === root) return '.';
    if (!p.startsWith(base)) return '<outside>';
    rel = p.slice(base.length);
  }
  const parts = rel.split('/').filter(s => s && s !== '.');
  if (parts[0] === '..') return '<outside>';
  return parts.length ? parts.join('/') : '.';
}

interface ParsedSearch { scope: TraceScope; patternText: string | null; limit: number | null; flagsKey: string }

/** Parse a rg/grep/git grep argument list. Only whitelisted flags are kept; unknown flags make the parse `partial`. */
export function parseSearchArgs(args: string[], root?: string): ParsedSearch {
  const options: string[] = [];
  const positionals: string[] = [];
  const values: string[] = [];
  let pattern: string | null = null;
  let limit: number | null = null;
  let partial = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (t === '-e' || t === '--regexp') { pattern = args[i + 1] ?? null; i++; options.push('-e'); continue; }
    if (t.startsWith('-') && t.length > 1) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      if (SEARCH_VALUE_FLAGS.has(name)) {
        const val = eq === -1 ? args[++i] : t.slice(eq + 1);
        options.push(name);
        if (val !== undefined) values.push(`${name}=${val}`);
        if (LIMIT_FLAGS.has(name) && val !== undefined && /^\d+$/.test(val)) limit = Number(val);
        continue;
      }
      if (SEARCH_BOOL_FLAGS.has(name)) { options.push(name); continue; }
      // Short cluster of known booleans (`-rn`, `-iF`).
      if (!t.startsWith('--') && [...t.slice(1)].every(ch => SEARCH_BOOL_FLAGS.has(`-${ch}`))) {
        for (const ch of t.slice(1)) options.push(`-${ch}`);
        continue;
      }
      partial = true;
      continue;
    }
    positionals.push(t);
  }
  if (pattern === null && positionals.length) pattern = positionals.shift() ?? null;
  const paths = positionals.map(p => normaliseTracePath(p, root)).filter((p): p is string => !!p);
  options.sort();
  const hasPattern = pattern !== null && pattern !== '';
  return {
    scope: { paths, options: [...new Set(options)], patternShape: null, parse: !hasPattern ? 'none' : partial ? 'partial' : 'full' },
    patternText: hasPattern ? pattern : null,
    limit,
    flagsKey: [...new Set(options)].join(',') + '|' + values.sort().join(','),
  };
}

// ── Result interpretation ───────────────────────────────────────────────────

export interface ResultInput {
  text: string | null;
  isError: boolean;
  /** Harness-declared non-execution (permission denied by policy). */
  nonExecutionKind?: unknown;
  /** Structured exit code, when the backend supplies one. */
  exitCode?: number | null;
}

const RE_PATH_GONE = /no such file or directory|\bENOENT\b|does not exist|not a directory|file not found|cannot find the path|no such path/i;
const RE_OS_DENIED = /permission denied|operation not permitted|\bEACCES\b|\bEPERM\b|access is denied/i;
const RE_TIMEOUT = /timed out|\bETIMEDOUT\b|command timeout|exceeded .{0,24}timeout/i;
const RE_CANCEL = /interrupted|\bcancell?ed\b|\baborted\b|\bSIGINT\b|\bSIGTERM\b/i;
const RE_TRUNC = /\[?(?:output|content|result)s? (?:was )?truncated|\.\.\. ?\[?\d+ (?:more )?(?:lines?|chars?|characters?|bytes?)|\[truncated\]|truncated to \d+/i;
const RE_EXIT = /^\s*Exit code:?\s+(-?\d+)/im;

export function countLines(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n : n + 1;
}

interface Derived {
  outcome: TraceOutcome; exitCode: number | null; exitCodeBasis: ExitCodeBasis;
  output: TraceEvent['output']; truncated: boolean; denial?: 'policy' | 'os';
}

export function deriveResult(ctx: { category: TraceCategory; origin: TraceOrigin; single: boolean; searchFamily?: string; limit: number | null }, r: ResultInput): Derived {
  const text = r.text;
  const bytes = text === null ? null : Buffer.byteLength(text, 'utf8');
  const lines = text === null ? null : countLines(text);
  const truncatedByHarness = text !== null && RE_TRUNC.test(text.slice(0, 200) + '\n' + text.slice(-300));
  const hitLimit = ctx.limit !== null && lines !== null && lines >= ctx.limit && (ctx.category === 'search' || ctx.category === 'read' || ctx.category === 'find');
  const output: TraceEvent['output'] = { bytes, lines, basis: text === null ? 'absent' : truncatedByHarness ? 'estimated' : 'measured' };
  const truncated = truncatedByHarness || hitLimit;

  // Exit code. Only a shell has one.
  let exitCode: number | null = null;
  let exitCodeBasis: ExitCodeBasis = 'absent';
  if (ctx.origin === 'shell') {
    if (typeof r.exitCode === 'number') { exitCode = r.exitCode; exitCodeBasis = 'structured'; }
    else {
      const m = text ? RE_EXIT.exec(text) : null;
      if (m) { exitCode = Number(m[1]); exitCodeBasis = 'parsed_text'; }
      else if (!r.isError) { exitCode = 0; exitCodeBasis = 'inferred'; }
    }
  }
  const failed = r.isError || (exitCode !== null && exitCode !== 0);
  const done = (outcome: TraceOutcome, denial?: 'policy' | 'os'): Derived => ({
    outcome, exitCode, exitCodeBasis, output, truncated, ...(denial ? { denial } : {}),
  });

  if (r.nonExecutionKind) return done('denied', 'policy');
  // Text signals are only trusted on a failed call: a file that merely contains the word "timeout" is not one.
  if (failed && text) {
    if (exitCode === 124 || RE_TIMEOUT.test(text)) return done('timeout');
    if (exitCode === 130 || exitCode === 143 || RE_CANCEL.test(text)) return done('cancelled');
    if (RE_PATH_GONE.test(text)) return done('path_unavailable');
    if (RE_OS_DENIED.test(text)) return done('denied', 'os');
  } else if (failed && (exitCode === 124)) return done('timeout');

  const isSearchLike = ctx.category === 'search' || ctx.category === 'find';
  if (ctx.origin === 'shell') {
    if (exitCode !== null && exitCode !== 0) {
      if (ctx.category === 'search' && ctx.single && ctx.searchFamily) {
        // rg, grep and git grep: 1 is "no matches", anything higher is an error.
        if (exitCode === 1) return done('no_matches');
        return done('error');
      }
      if (ctx.category === 'search' || ctx.single === false) return done('nonzero_unmodeled');
      return done('error');
    }
    if (r.isError && exitCode === null) return done('error');
    if (text !== null && text.trim() === '') return done('empty_output');
    return done('ok');
  }
  if (r.isError) return done('error');
  if (text !== null && isSearchLike && (text.trim() === '' || /^no (matches|files|results) found/i.test(text.trim()))) return done('no_matches');
  if (text !== null && text.trim() === '') return done('empty_output');
  return done('ok');
}

// ── Shell command extraction (Claude: string; Codex-style: argv array) ──────

export function commandText(input: unknown): string | null {
  const i = input as { command?: unknown; cmd?: unknown } | null | undefined;
  const c = i?.command ?? i?.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every(x => typeof x === 'string')) {
    // ["bash","-lc","rg foo"] is the script; any other argv is a command line.
    if (c.length >= 3 && /^(ba|z|da|k)?sh$/.test(baseName(c[0])) && /^-\w*c$/.test(c[1])) return c[2];
    return c.join(' ');
  }
  return null;
}

// ── Recorder ────────────────────────────────────────────────────────────────

interface Pending {
  callId: string; seq: number; ts: number; tool: string; category: TraceCategory; origin: TraceOrigin;
  shell?: ShellTraceClass; scope: TraceScope | null; fingerprint: string | null; repeat: TraceEvent['repeat'];
  limit: number | null; excerpt?: string; writePath: string | null; searchFamily?: string; clockAtStart: number; callKey?: string;
}

interface FpEntry { seq: number; clock: number; count: number; outcome?: TraceOutcome }

export interface ToolUseBlock { id?: string; name: string; input?: unknown }
export interface ToolResultBlock { tool_use_id?: string; content?: unknown; is_error?: boolean; tool_result_meta?: { non_execution_kind?: unknown } | null; exit_code?: number | null }

function digestOf(text: string | null, salt: string): { resultDigest?: string } {
  if (text === null) return {};
  return { resultDigest: createHmac('sha256', salt).update(text.slice(0, 8192)).digest('hex').slice(0, 20) };
}

export class ToolTraceRecorder {
  readonly header: TraceHeader;
  readonly events: TraceEvent[] = [];
  readonly counters: TraceCounters = { recorded: 0, droppedByEventCap: 0, droppedByByteCap: 0, sampledOut: 0, fingerprintEvictions: 0, unobserved: 0 };

  private readonly lim: typeof DEFAULT_TRACE_LIMITS & Partial<ToolTraceOptions>;
  private readonly opts: ToolTraceOptions;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Set<string>();
  private readonly fps = new Map<string, FpEntry>();
  private readonly pathWrites = new Map<string, number>();
  private clock = 0;
  private globalWriteClock = 0;
  private lastWriteClock = 0;
  private seq = 0;
  private bytesKept = 0;
  private buffer: string[] = [];
  private file: string | null = null;
  private closed = false;

  constructor(opts: ToolTraceOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.lim = { ...DEFAULT_TRACE_LIMITS, ...stripUndefined({
      maxEvents: opts.maxEvents, maxBytes: opts.maxBytes, sampleAfter: opts.sampleAfter, sampleEvery: opts.sampleEvery,
      maxFingerprints: opts.maxFingerprints, maxPendingCalls: opts.maxPendingCalls, flushEvery: opts.flushEvery, excerptChars: opts.excerptChars,
    }) };
    this.header = {
      kind: 'header', v: TRACE_SCHEMA_VERSION, taskId: opts.taskId, attempt: opts.attempt ?? 1,
      ...(opts.workerId ? { workerId: opts.workerId } : {}),
      harness: opts.harness ?? 'unknown', model: opts.model ?? null, config: opts.config ?? {},
      salt: randomBytes(16).toString('hex'), startedAt: this.now(),
    };
    if (opts.persistDir) this.openFile(opts.persistDir);
  }

  /** Path of the trace file, when persisting. */
  get path(): string | null { return this.file; }

  /** Record a tool_use block. Never throws. */
  onToolUse(block: ToolUseBlock): void {
    try { this.toolUse(block); } catch { /* observation must never break the worker */ }
  }

  /** Join a tool_result block to its call and finalise the event. Never throws. */
  onToolResult(block: ToolResultBlock): void {
    try { this.toolResult(block); } catch { /* see above */ }
  }

  /** Finalise calls that never got a result, flush, and write the counter footer. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      for (const p of [...this.pending.values()]) this.finalise(p, null);
      this.counters.unobserved = this.events.filter(e => !e.resultObserved).length;
      this.buffer.push(JSON.stringify({ kind: 'summary', v: TRACE_SCHEMA_VERSION, closedAt: this.now(), counters: this.counters }));
      this.flush();
    } catch { /* ignore */ }
  }

  flush(): void {
    if (!this.file || !this.buffer.length) { this.buffer = []; return; }
    const chunk = this.buffer.join('\n') + '\n';
    this.buffer = [];
    try {
      appendFileSync(this.file, chunk, { mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch { /* disk trouble must not fail the worker */ }
  }

  // ── internals ──

  private toolUse(block: ToolUseBlock): void {
    if (this.closed || !block?.name) return;
    const callId = block.id || `anon-${this.seq + 1}-${this.now()}`;
    if (this.seen.has(callId) || this.pending.has(callId)) return; // idempotent by call id
    const tool = canonicalToolName(block.name);
    const seq = ++this.seq;
    const ts = this.now();
    const input = (block.input ?? {}) as Record<string, any>;

    let category: TraceCategory = 'other_tool';
    let origin: TraceOrigin = 'other';
    let shell: ShellTraceClass | undefined;
    let scope: TraceScope | null = null;
    let patternText: string | null = null;
    let flagsKey = '';
    let limit: number | null = null;
    let writePath: string | null = null;
    let readPath: string | null = null;
    let searchFamily: string | undefined;
    let excerptSource: string | null = null;
    const root = this.opts.root;
    // Raw path (never emitted) for native tools, so two different files that both normalise to
    // '<abs>' / '<outside>' are not mistaken for one repeated call.
    const rawPath = (v: unknown) => (typeof v === 'string' ? v : '');
    let fpRaw = '';

    switch (tool) {
      case 'Grep': {
        category = 'search'; origin = 'native';
        patternText = typeof input.pattern === 'string' ? input.pattern : null;
        const p = normaliseTracePath(input.path, root);
        fpRaw = rawPath(input.path);
        const opts = ['-i', '-n', '-A', '-B', '-C', 'multiline'].filter(k => input[k] !== undefined && input[k] !== false);
        if (typeof input.glob === 'string') opts.push('glob');
        if (typeof input.type === 'string') opts.push('type');
        if (typeof input.output_mode === 'string') opts.push(`mode:${input.output_mode}`);
        limit = typeof input.head_limit === 'number' ? input.head_limit : null;
        scope = { paths: p ? [p] : [], options: opts.sort(), patternShape: null, parse: patternText ? 'full' : 'none' };
        flagsKey = `${opts.join(',')}|${input.glob ?? ''}|${input.type ?? ''}|${input.output_mode ?? ''}`;
        excerptSource = patternText;
        break;
      }
      case 'Glob': {
        category = 'find'; origin = 'native';
        patternText = typeof input.pattern === 'string' ? input.pattern : null;
        const p = normaliseTracePath(input.path, root);
        fpRaw = rawPath(input.path);
        scope = { paths: p ? [p] : [], options: [], patternShape: null, parse: patternText ? 'full' : 'none' };
        excerptSource = patternText;
        break;
      }
      case 'Read': {
        category = 'read'; origin = 'native';
        readPath = normaliseTracePath(input.file_path, root);
        fpRaw = rawPath(input.file_path);
        limit = typeof input.limit === 'number' ? input.limit : null;
        const off = typeof input.offset === 'number' ? input.offset : 0;
        scope = { paths: readPath ? [readPath] : [], options: [], patternShape: null, parse: readPath ? 'full' : 'none' };
        flagsKey = `${off}:${limit ?? ''}`;
        excerptSource = typeof input.file_path === 'string' ? input.file_path : null;
        break;
      }
      case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
        category = 'write'; origin = 'native';
        writePath = normaliseTracePath(input.file_path ?? input.notebook_path, root);
        scope = { paths: writePath ? [writePath] : [], options: [], patternShape: null, parse: writePath ? 'full' : 'none' };
        break;
      }
      case 'Bash': {
        origin = 'shell';
        const cmd = commandText(input);
        excerptSource = cmd;
        if (cmd === null) { category = 'unknown'; shell = { category: 'unknown', single: false, mutatesTree: false, unknownReason: 'no_command' }; break; }
        shell = classifyShellForTrace(cmd);
        category = shell.category;
        if (shell.search) {
          searchFamily = shell.search.family;
          const parsed = parseSearchArgs(shell.search.args, root);
          scope = parsed.scope; patternText = parsed.patternText; flagsKey = parsed.flagsKey; limit = parsed.limit;
        } else if (category === 'write' || shell.mutatesTree) {
          // A shell write names no path we trust; treat it as touching everything.
          writePath = null;
        }
        break;
      }
      default: {
        if (tool.startsWith('mcp__')) { category = 'mcp'; origin = 'mcp'; }
        else if (tool === 'WebSearch' || tool === 'WebFetch') category = 'web';
        else if (tool === 'Task' || tool === 'Agent') category = 'agent';
      }
    }
    if (scope && patternText !== null) scope.patternShape = shapeLabel(patternText);

    // Fingerprint + repetition (searches, finds, reads only).
    let fingerprint: string | null = null;
    let repeat: TraceEvent['repeat'] = { kind: 'none' };
    // A shell search whose path could not be made relative has no stable identity: skip it rather than
    // collapse every such path into one fingerprint.
    const unresolvable = origin === 'shell' && !!scope && scope.paths.some((x) => x === '<abs>' || x === '<outside>');
    if ((category === 'search' || category === 'find' || category === 'read') && scope && scope.parse !== 'none' && !unresolvable) {
      const key = [category, origin === 'shell' ? 'sh' : 'nat', searchFamily ?? tool, patternText ?? '', flagsKey, [...scope.paths].sort().join('\0'), fpRaw].join('\u0001');
      fingerprint = createHmac('sha256', this.header.salt).update(key).digest('hex').slice(0, 20);
      const prior = this.fps.get(fingerprint);
      const scopeClock = this.scopeClock(scope.paths);
      if (prior) {
        repeat = {
          kind: scopeClock > prior.clock ? 'repeat_after_change' : 'repeat_unchanged',
          priorSeq: prior.seq, priorCount: prior.count, ...(prior.outcome ? { priorOutcome: prior.outcome } : {}),
        };
        this.fps.delete(fingerprint);
        this.fps.set(fingerprint, { seq, clock: this.clock, count: prior.count + 1, outcome: prior.outcome });
      } else {
        if (this.fps.size >= this.lim.maxFingerprints) {
          const oldest = this.fps.keys().next().value;
          if (oldest !== undefined) { this.fps.delete(oldest); this.counters.fingerprintEvictions++; }
        }
        this.fps.set(fingerprint, { seq, clock: this.clock, count: 1 });
      }
    }

    let callKey: string | undefined;
    if (category !== 'write' && category !== 'agent') {
      const material = commandText(input) ?? JSON.stringify(input ?? {});
      callKey = createHmac('sha256', this.header.salt).update(`${tool}\u0001${material.slice(0, 4000)}`).digest('hex').slice(0, 20);
    }

    let excerpt: string | undefined;
    if (this.opts.captureExcerpts && excerptSource) {
      excerpt = redactExcerpt(excerptSource, this.opts.redact).slice(0, this.lim.excerptChars);
    }

    if (this.pending.size >= this.lim.maxPendingCalls) {
      // Oldest pending call is almost certainly never going to resolve.
      const oldest = this.pending.values().next().value;
      if (oldest) this.finalise(oldest, null);
    }
    this.pending.set(callId, {
      callId, seq, ts, tool, category, origin, ...(shell ? { shell } : {}), scope, fingerprint, repeat, limit,
      ...(excerpt ? { excerpt } : {}), writePath, ...(searchFamily ? { searchFamily } : {}), clockAtStart: this.clock,
      ...(callKey ? { callKey } : {}),
    });
  }

  private toolResult(block: ToolResultBlock): void {
    if (this.closed) return;
    const id = block?.tool_use_id;
    if (!id) return;
    const p = this.pending.get(id);
    if (!p) return; // unknown or already finalised: idempotent
    this.finalise(p, block);
  }

  private finalise(p: Pending, block: ToolResultBlock | null): void {
    this.pending.delete(p.callId);
    if (this.seen.has(p.callId)) return;
    this.seen.add(p.callId);

    const endTs = this.now();
    let derived: Derived;
    if (!block) {
      derived = { outcome: 'unobserved', exitCode: null, exitCodeBasis: 'absent', output: { bytes: null, lines: null, basis: 'absent' }, truncated: false };
    } else {
      derived = deriveResult(
        { category: p.category, origin: p.origin, single: p.shell?.single ?? true, searchFamily: p.searchFamily, limit: p.limit },
        { text: resultText(block.content), isError: block.is_error === true, nonExecutionKind: block.tool_result_meta?.non_execution_kind, exitCode: block.exit_code ?? null },
      );
    }

    // Writes invalidate earlier reads/searches. A failed or denied write changed nothing.
    const changed = p.category === 'write' || p.shell?.mutatesTree;
    if (changed && derived.outcome !== 'error' && derived.outcome !== 'denied' && derived.outcome !== 'path_unavailable') {
      this.clock++;
      this.lastWriteClock = this.clock;
      if (p.writePath) {
        if (this.pathWrites.size >= DEFAULT_TRACE_LIMITS.maxEditedPaths && !this.pathWrites.has(p.writePath)) this.globalWriteClock = this.clock;
        else this.pathWrites.set(p.writePath, this.clock);
      } else this.globalWriteClock = this.clock;
    }
    if (p.fingerprint) {
      const e = this.fps.get(p.fingerprint);
      if (e && e.seq === p.seq) e.outcome = derived.outcome;
    }

    const event: TraceEvent = {
      kind: 'call', v: TRACE_SCHEMA_VERSION, callId: p.callId, seq: p.seq, ts: p.ts, tool: p.tool,
      category: p.category, origin: p.origin,
      ...(p.shell?.bucket ? { shellBucket: p.shell.bucket } : {}),
      ...(p.shell?.searchRole ? { searchRole: p.shell.searchRole } : {}),
      elapsedMs: block ? Math.max(0, endTs - p.ts) : null,
      outcome: derived.outcome, exitCode: derived.exitCode, exitCodeBasis: derived.exitCodeBasis,
      resultObserved: !!block, output: derived.output, truncated: derived.truncated, limit: p.limit,
      ...(derived.denial ? { denial: derived.denial } : {}),
      scope: p.scope, fingerprint: p.fingerprint, repeat: p.repeat,
      ...(p.callKey ? { callKey: p.callKey } : {}),
      ...(block ? digestOf(resultText(block.content), this.header.salt) : {}),
      ...(p.shell?.unknownReason ? { parseFailure: p.shell.unknownReason } : {}),
      ...(p.excerpt ? { excerpt: p.excerpt } : {}),
    };
    this.keep(event);
  }

  /** Apply the event, sampling and byte caps, then store. */
  private keep(event: TraceEvent): void {
    if (this.counters.recorded >= this.lim.maxEvents) { this.counters.droppedByEventCap++; return; }
    if (this.counters.recorded >= this.lim.sampleAfter && event.seq % this.lim.sampleEvery !== 0) { this.counters.sampledOut++; return; }
    const line = JSON.stringify(event);
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (this.bytesKept + size > this.lim.maxBytes) { this.counters.droppedByByteCap++; return; }
    this.bytesKept += size;
    this.counters.recorded++;
    this.events.push(event);
    if (this.file) {
      this.buffer.push(line);
      if (this.buffer.length >= this.lim.flushEvery) this.flush();
    }
  }

  /** Latest write clock touching any of these scope paths. */
  private scopeClock(paths: string[]): number {
    let c = this.globalWriteClock;
    if (!paths.length || paths.includes('.')) return Math.max(c, this.lastWriteClock);
    for (const s of paths) {
      for (const [edited, at] of this.pathWrites) {
        if (at > c && (edited === s || edited.startsWith(`${s}/`) || s.startsWith(`${edited}/`))) c = at;
      }
    }
    return c;
  }

  private openFile(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { chmodSync(dir, 0o700); } catch { /* best effort */ }
      const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
      this.file = join(dir, `${safe(this.opts.taskId)}-a${this.header.attempt}.jsonl`);
      if (existsSync(this.file)) {
        // Resume: remember what is already on disk so a re-sent call id is not written twice.
        for (const line of readFileSync(this.file, 'utf8').split('\n')) {
          if (!line) continue;
          try {
            const o = JSON.parse(line);
            if (o?.kind === 'call' && typeof o.callId === 'string') { this.seen.add(o.callId); this.bytesKept += Buffer.byteLength(line) + 1; this.seq = Math.max(this.seq, o.seq ?? 0); }
          } catch { /* skip a torn line */ }
        }
      } else {
        this.buffer.push(JSON.stringify(this.header));
        this.flush();
      }
    } catch {
      this.file = null; // persistence is best-effort; memory capture continues
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function shapeLabel(pattern: string): string {
  const t = pattern.trim();
  if (!t) return 'empty';
  if (/\s/.test(t)) return 'phrase';
  if (/[()[\]{}|^$\\+*?]/.test(t)) return 'regex';
  if (t.includes('/')) return 'path';
  return 'identifier';
}

/** Tool result content is a string or an array of text blocks; anything else (images) has no text. */
export function resultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text as string);
    return texts.length ? texts.join('\n') : null;
  }
  return null;
}

// ── Platform-safe summary, retention, env ───────────────────────────────────

export interface ToolTraceSummary {
  v: typeof TRACE_SCHEMA_VERSION;
  harness: TraceHarness;
  calls: number;
  byCategory: Partial<Record<TraceCategory, number>>;
  byOutcome: Partial<Record<TraceOutcome, number>>;
  repeats: { unchanged: number; afterChange: number };
  searchesByRole: Partial<Record<SearchRole, number>>;
  unobserved: number;
  truncated: number;
  counters: TraceCounters;
}

/** The only trace-derived value that may leave the machine: enum counts, no text, paths or hashes. */
export function summarizeToolTrace(rec: ToolTraceRecorder): ToolTraceSummary {
  const byCategory: ToolTraceSummary['byCategory'] = {};
  const byOutcome: ToolTraceSummary['byOutcome'] = {};
  const searchesByRole: ToolTraceSummary['searchesByRole'] = {};
  let unchanged = 0, afterChange = 0, truncated = 0, unobserved = 0;
  for (const e of rec.events) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    if (e.searchRole) searchesByRole[e.searchRole] = (searchesByRole[e.searchRole] ?? 0) + 1;
    if (e.repeat.kind === 'repeat_unchanged') unchanged++;
    if (e.repeat.kind === 'repeat_after_change') afterChange++;
    if (e.truncated) truncated++;
    if (!e.resultObserved) unobserved++;
  }
  return { v: TRACE_SCHEMA_VERSION, harness: rec.header.harness, calls: rec.events.length, byCategory, byOutcome, repeats: { unchanged, afterChange }, searchesByRole, unobserved, truncated, counters: { ...rec.counters, unobserved } };
}

export interface RetentionPolicy { maxAgeDays: number; maxFiles: number }
export const DEFAULT_RETENTION: RetentionPolicy = { maxAgeDays: 7, maxFiles: 200 };

/** Delete trace files past the age or count bound. Returns how many were removed. */
export function pruneTraceDir(dir: string, policy: RetentionPolicy = DEFAULT_RETENTION, now: number = Date.now()): number {
  let removed = 0;
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => ({ f, p: join(dir, f), m: statSync(join(dir, f)).mtimeMs }));
    files.sort((a, b) => b.m - a.m);
    files.forEach((x, i) => {
      if (i >= policy.maxFiles || now - x.m > policy.maxAgeDays * 86_400_000) {
        try { unlinkSync(x.p); removed++; } catch { /* skip */ }
      }
    });
  } catch { /* no dir yet */ }
  return removed;
}

/**
 * Trace configuration from the environment.
 *
 * - `BUILDD_TOOL_TRACE=off`      no recorder at all.
 * - unset / `memory`             in-memory, bounded (the cheap default).
 * - `BUILDD_TOOL_TRACE_DIR=...`  opt in to persistence under that directory.
 * - `BUILDD_TOOL_TRACE_EXCERPTS=1` opt in to redacted excerpts.
 */
export function toolTraceConfigFromEnv(env: Record<string, string | undefined>): { enabled: boolean; persistDir?: string; captureExcerpts: boolean } {
  const mode = (env.BUILDD_TOOL_TRACE ?? 'memory').toLowerCase();
  if (mode === 'off' || mode === '0' || mode === 'false') return { enabled: false, captureExcerpts: false };
  const dir = env.BUILDD_TOOL_TRACE_DIR?.trim();
  return { enabled: true, ...(dir ? { persistDir: dir } : {}), captureExcerpts: env.BUILDD_TOOL_TRACE_EXCERPTS === '1' };
}
