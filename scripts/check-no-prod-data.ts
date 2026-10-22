#!/usr/bin/env bun
/**
 * Fail if production data appears in a change to this PUBLIC repo.
 *
 * Scoping is deliberate, to stay useful rather than noisy:
 *
 *   - Counts and UUIDs are checked in the PR title, the PR body and commit
 *     messages, where they are almost never legitimate. NOT in code, which uses
 *     large numbers and UUID fixtures honestly.
 *   - Identifiers (personal handles, private repo names) are checked in those
 *     places AND in added code lines, because they are never legitimate here.
 *
 * Two rules learned the hard way, both from real failures of the first version:
 *
 *   1. Never print the matched text. This runs on a public repo, and Actions logs
 *      on a public repo are world-readable, so echoing the match would republish
 *      the very figure the check exists to keep out. Findings report a category, a
 *      location and a masked excerpt only.
 *
 *   2. A bare grouped-thousands figure is not evidence of anything. `1,024 KB`,
 *      `Retry-After 3,600` and third-party star counts are ordinary engineering
 *      prose. What matters is a number *tied to a data noun* — and at that point
 *      the magnitude stops mattering, so the floor is two digits, not four.
 *      `487 teams` is more sensitive here than `10,240 bytes` will ever be.
 *
 * The identifier list is NOT stored in this repo -- it would itself be a personal
 * handle and private repo names committed to a public repository. It arrives via
 * NO_PROD_DATA_IDENTIFIERS as a regex alternation, and it must come from a SECRET
 * rather than an Actions variable: variable values are echoed unmasked into the
 * step's env group, and Actions logs on a public repo are world-readable, so
 * carrying the list in a variable would publish it on every run.
 *
 * When the list is absent this script FAILS. It used to warn and exit 0, which is
 * how the identifier half -- the only half that reads added code -- ran on every PR
 * against an empty pattern for its entire life without anyone noticing. A guard
 * that cannot see anything must not report success.
 *
 * Set NO_PROD_DATA_LOCAL=1 to opt into the one exception: a local run (see
 * scripts/check-no-prod-data-local.sh) never has the secret, so failing closed
 * there would make every run red regardless of content and train people to
 * ignore it. That mode downgrades the missing-secret case to a warning instead
 * -- it still runs the count/UUID rules, which need no secret -- and says
 * plainly that the identifier half was skipped. CI never sets this variable, so
 * its fail-closed behavior is unchanged.
 *
 * Escape hatch: a line STARTING with `no-prod-data: allow <reason>` in the PR body
 * suppresses the count/UUID rules for that PR, and is reported. Documenting this
 * check necessarily instantiates the patterns it forbids.
 *
 * This was a Python script; it is TypeScript so that the hook and CI need only
 * Bun. Every pattern, including the secret, is still written in Python `re`
 * syntax and compiled by `pyRegex`, which keeps Python's semantics (Unicode \w,
 * \d, \s and \b; `$`, `^` and `.` splitting on \n only; inline flags; named
 * groups). The pattern constants are therefore character-identical to what
 * they were, and to the copies in apps/web/src/lib/specs/no-prod-data-scan.ts.
 */

import { existsSync, readFileSync } from 'fs';

const USAGE = `Usage:  check-no-prod-data.ts <base-ref> [--body FILE] [--title FILE]
                             [--staged] [--message-file FILE]

--staged scans merge-base..index instead of base...HEAD (pre-commit: a UUID
removed in the staged diff is gone, one added is caught). --message-file adds
the candidate commit message to the prose scan (commit-msg hook).
Exit:   0 clean, 1 violation, 2 usage error (or an identifier list that does
        not compile).`;

// ── Python `re` on a JS RegExp ──────────────────────────────────────────────

// Python's \w is str.isalnum() plus underscore, \d is any decimal digit, and \s
// is str.isspace() -- all Unicode. JS's \w, \d and \b are ASCII even with the u
// flag, and its \s differs at the edges (it has U+FEFF, lacks \x1c-\x1f, \x85).
const PY_W = String.raw`\p{L}\p{N}_`;
const PY_D = String.raw`\p{Nd}`;
const PY_S = String.raw`\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const PY_B = `(?:(?<=[${PY_W}])(?![${PY_W}])|(?<![${PY_W}])(?=[${PY_W}]))`;
const PY_NB = `(?:(?<=[${PY_W}])(?=[${PY_W}])|(?<![${PY_W}])(?![${PY_W}]))`;
const ASCII_CLASSES = { w: 'a-zA-Z0-9_', d: '0-9', s: String.raw` \t\n\r\f\v` };
// Characters a u-mode RegExp accepts after a backslash as themselves.
const JS_SYNTAX = new Set('^$\\.*+?()[]{}|/');

/**
 * Compile a Python `re` pattern to a JS RegExp with the same meaning.
 * `flags` takes Python's letters (i, m, s, x, a); a leading inline group such as
 * `(?i)` is honoured too. `global` adds JS's g, for replace-all. Throws on a
 * pattern Python would reject or that has no JS equivalent (atomic groups,
 * scoped inline flags, \N{...}).
 */
export function pyRegex(source: string, flags = '', global = false): RegExp {
  let src = source;
  let fl = flags;
  for (let m: RegExpExecArray | null; (m = /^\(\?([aiLmsux]+)\)/.exec(src)); ) {
    fl += m[1];
    src = src.slice(m[0].length);
  }
  const ascii = fl.includes('a');
  const cls = (k: 'w' | 'd' | 's') => (ascii ? ASCII_CLASSES[k] : { w: PY_W, d: PY_D, s: PY_S }[k]);
  const verbose = fl.includes('x');
  const multiline = fl.includes('m');
  const dotall = fl.includes('s');

  let out = '';
  let inClass = false;
  let classBody = 0; // characters emitted since the class opened (a leading ] is literal)
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (verbose && !inClass) {
      if (/\s/.test(c)) continue;
      if (c === '#') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
    }
    if (c === '\\') {
      const n = src[++i];
      if (n === undefined) throw new SyntaxError('bad escape (end of pattern)');
      const lower = n.toLowerCase() as 'w' | 'd' | 's';
      if ('wds'.includes(n)) out += inClass ? cls(lower) : `[${cls(lower)}]`;
      else if ('WDS'.includes(n)) {
        if (inClass) throw new SyntaxError(`\\${n} inside a character class is not supported`);
        out += `[^${cls(lower)}]`;
      } else if (n === 'b') out += inClass ? '\\x08' : ascii ? '\\b' : PY_B;
      else if (n === 'B' && !inClass) out += ascii ? '\\B' : PY_NB;
      else if (n === 'A' && !inClass) out += '^';
      else if (n === 'Z' && !inClass) out += '$';
      else if (n === 'a') out += '\\x07';
      else if ('ntrfv'.includes(n)) out += `\\${n}`;
      else if (n === 'x' || n === 'u' || n === 'U') {
        const len = { x: 2, u: 4, U: 8 }[n];
        const hex = src.slice(i + 1, i + 1 + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) throw new SyntaxError(`incomplete escape \\${n}`);
        out += `\\u{${hex}}`;
        i += len;
      } else if (/[0-9]/.test(n)) {
        const octal = n === '0' || inClass || /^[0-7]{3}/.test(src.slice(i, i + 3));
        if (octal) {
          const digits = /^[0-7]{1,3}/.exec(src.slice(i))?.[0];
          if (!digits) throw new SyntaxError(`bad escape \\${n}`);
          out += `\\u{${parseInt(digits, 8).toString(16)}}`;
          i += digits.length - 1;
        } else {
          const digits = /^[0-9]{1,2}/.exec(src.slice(i))![0];
          out += `\\${digits}`;
          i += digits.length - 1;
        }
      } else if (/[A-Za-z]/.test(n)) throw new SyntaxError(`bad escape \\${n}`);
      else if (JS_SYNTAX.has(n) || (inClass && n === '-')) out += `\\${n}`;
      else out += n;
      if (inClass) classBody++;
      continue;
    }
    if (inClass) {
      if (c === ']' && classBody > 0) inClass = false;
      else if (c === ']' || c === '[') out += '\\';
      out += c;
      classBody++;
      continue;
    }
    if (c === '[') {
      inClass = true;
      classBody = 0;
      out += '[';
      if (src[i + 1] === '^') {
        out += '^';
        i++;
      }
    } else if (c === '.') out += dotall ? '[^]' : '[^\\n]';
    else if (c === '^') out += multiline ? '(?<=^|\\n)' : '^';
    else if (c === '$') out += multiline ? '(?=\\n|$)' : '(?=\\n?$)';
    else if (c === '(' && src[i + 1] === '?') {
      const rest = src.slice(i + 2);
      let m: RegExpExecArray | null;
      if ((m = /^P<(\w+)>/.exec(rest))) {
        out += `(?<${m[1]}>`;
        i += 1 + m[0].length;
      } else if ((m = /^P=(\w+)\)/.exec(rest))) {
        out += `\\k<${m[1]}>`;
        i += 1 + m[0].length;
      } else if ((m = /^#[^)]*\)/.exec(rest))) {
        i += 1 + m[0].length;
      } else if (/^[:=!]|^<[=!]/.test(rest)) {
        out += '(?';
        i++;
      } else {
        throw new SyntaxError('unsupported group construct');
      }
    } else if (c === '{') {
      const m = /^\{(\d*)(,?)(\d*)\}/.exec(src.slice(i));
      if (m && (m[1] || (m[2] && m[3]))) {
        out += `{${m[1] || '0'}${m[2]}${m[3]}}`;
        i += m[0].length - 1;
      } else out += '\\{';
    } else if (c === '}' || c === ']') out += `\\${c}`;
    else out += c;
  }
  if (inClass) throw new SyntaxError('unterminated character set');
  return new RegExp(out, `u${fl.includes('i') ? 'i' : ''}${global ? 'g' : ''}`);
}

// Python's str.splitlines() boundaries. Line numbers in findings count these.
const PY_LINE_BREAK = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/;

/** str.splitlines(): no trailing empty line for a final terminator. */
export function pySplitlines(text: string): string[] {
  if (!text) return [];
  const parts = text.split(PY_LINE_BREAK);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

const PY_SPACE_EDGES = new RegExp(`^[${PY_S}]+|[${PY_S}]+$`, 'gu');

/** str.strip() with no argument. */
function pyStrip(text: string): string {
  return text.replace(PY_SPACE_EDGES, '');
}

/** What Python's text-mode reads (open(), subprocess text=True) see: universal newlines. */
function universalNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// ── Patterns ────────────────────────────────────────────────────────────────

// Two classes of noun, because they carry different risk.
//
// TENANCY nouns count paying entities. A number beside one of these is a
// disclosure at any magnitude -- "25 api keys across 9 teams" says more about
// the business than a six-figure row count does, and nobody writes a
// configuration limit in terms of customers.
export const TENANCY = String.raw`teams?|tenants?|customers?|orgs?|organi[sz]ations?|seats?|subscribers?|accounts?|api keys?|paying`;
// VOLUME nouns count things inside the product. These appear constantly as
// batch sizes, concurrency caps and test fixtures, so they need either a large
// figure or a production-flavoured sentence before they mean anything.
export const VOLUME = String.raw`rows?|records?|entries|entities|memories|keys?|users?|workspaces?|workers?|chunks?|tasks?|missions?|sessions?`;
const NOUNS = `${TENANCY}|${VOLUME}`;

// A quoted population figure: grouped thousands, or 4+ digits, or a k/M/B
// suffix. The floor is deliberate. Sub-1000 numbers beside a data noun are
// overwhelmingly concurrency limits, test fixtures and batch sizes -- measured
// against this repo's own history, dropping the floor produced ~150 false
// positives and would have got the check switched off inside a day.
export const BIG = String.raw`\d{1,3}(?:,\d{3})+|\d{4,}|\d{2,}(?:\.\d+)?\s*[kKmMbB]\b`;

// Units that make a figure a measurement rather than a population.
export const UNITS = String.raw`kb|mb|gb|tb|kib|mib|gib|bytes?|bits?|ms|milliseconds?|s|seconds?|minutes?|hours?|days?|px|rem|em|%|stars?|forks?|tokens?|iterations?|items?|lines?|chars?|characters?|commits?|files?|prs?|issues?|requests?/s|rps|qps|usd|eur|gbp`;

// Words that mark a sentence as being about live data rather than configuration.
// These let a SMALL figure count, because "prod has 487 teams" is a disclosure
// while "cap at 60 workers" is not, and only the surrounding words tell them
// apart. Tenancy counts here are small, so without this the real risk is missed.
export const PROD_CONTEXT = String.raw`\bprod(?:uction)?\b|\blive\b|\bcurrently\b|\btotal\b|\bwe (?:have|had)\b|\bacross all\b`;

// A leading zero (`0223`) marks a migration index or zero-padded id, never a
// quoted population, so `(?!0\d)` keeps "its own 0223 into the mission" out.
// A big figure beside a data noun. `(?<!#)` keeps every squash subject's trailing
// "(#1964)" out -- that alone was 162 hits on this repo's history.
// `(?:/[\d,]+)?` catches the "N,NNN/N,NNN rows" form: the real disclosure that
// prompted this check was written that way, and without it the slash defeats the
// match entirely.
export const COUNT_BIG = pyRegex(
  String.raw`(?<![\w.#-])(?!0\d)(${BIG})(?:\s*/\s*[\d,]+)?\s+(?!(?:${UNITS})\b)` + String.raw`(?:[a-z-]+\s+){0,2}?(${NOUNS})\b`,
  'i',
);
// Any figure, however small, beside a tenancy noun.
export const COUNT_TENANCY = pyRegex(
  String.raw`(?<![\w./#-])(?!0\d)(\d+)(?:\s*/\s*[\d,]+)?\s+(?!(?:${UNITS})\b)` + String.raw`(?:[a-z-]+\s+){0,2}?(${TENANCY})\b`,
  'i',
);
// A small figure beside a data noun, only in a production-flavoured sentence.
export const COUNT_SMALL_IN_CONTEXT = pyRegex(
  String.raw`(?<![\w./#-])(?!0\d)(\d{2,3})\s+(?!(?:${UNITS})\b)(?:[a-z-]+\s+){0,2}?(${NOUNS})\b`,
  'i',
);
export const UUID_RE = pyRegex(String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`, 'i');
const PROD_CONTEXT_RE = pyRegex(PROD_CONTEXT, 'i');
const CODE_SPAN = pyRegex('`[^`\\n]*`', '', true);
const LIVE = pyRegex(String.raw`\blive\b`, 'i', true);

/**
 * PROD_CONTEXT, except that `live` inside a backtick span is an identifier
 * (`mode: 'live'`), not a claim about production. Only `live` is excused: a
 * span naming `prod` is still a production-flavoured sentence.
 */
export function hasProdContext(line: string): boolean {
  return PROD_CONTEXT_RE.test(line.replace(CODE_SPAN, (span) => span.replace(LIVE, ' ')));
}

// Must start a line and carry a reason. An unanchored version matched its own
// documentation -- a PR body that merely named the marker, inside backticks,
// switched the check off on that PR. Mentioning the escape hatch must not be
// the same act as using it.
export const ALLOW_RE = pyRegex(String.raw`^[ \t]*no-prod-data:[ \t]*allow[ \t]+(\S.*)$`, 'im');

// This file documents the categories it forbids, so exclude it from the scan of
// added lines or it flags its own header.
const SELF = ['scripts/check-no-prod-data.ts'];

const MASKABLE = pyRegex('[0-9a-f]', 'i', true);

/** Redact digits and hex so a finding never republishes the value. */
export function mask(text: string): string {
  return text.replace(MASKABLE, '•');
}

export class Report {
  failed = false;
  // Tracked separately so the epilogue only offers the escape hatch when the
  // hatch would actually help. It suppresses the count/UUID rules and nothing
  // else, so advertising it under a missing-secret failure sends the reader to
  // a switch that cannot clear their error.
  suppressible = false;

  constructor(private readonly print: (line: string) => void = (line) => console.log(line)) {}

  hit(where: string, category: string, lineNo: number, excerpt: string, advice: string): void {
    this.failed = true;
    this.suppressible = true;
    // Masked, and truncated (by code point, as Python slices). Never the raw match.
    const shown = Array.from(mask(pyStrip(excerpt))).slice(0, 110).join('');
    this.print(`::error::${where}: possible ${category} at line ${lineNo} — ${advice}`);
    this.print(`   masked: ${shown}`);
  }

  /**
   * Report an identifier match with NO excerpt at all.
   *
   * `mask` only redacts [0-9a-f], which is right for a count or a UUID --
   * digits are the payload there. A personal handle or a private repo name is
   * made of the other twenty letters, so masking leaves it readable
   * ('some-private-repo-name' -> 'som•-priv•t•-r•po-n•m•'). Echoing it here
   * would republish the exact string this check exists to keep out of a public
   * repo. The location is enough: whoever wrote the line knows what is on it.
   */
  hitIdentifier(where: string, lineNo: number, _excerpt: string): void {
    this.failed = true;
    this.print(
      `::error::${where}: possible personal handle or private repo name ` +
        `at line ${lineNo} — remove it; this repository is public. ` +
        `The match is not printed: this log is world-readable.`,
    );
  }
}

// `+++ b/path` names the file that the following `+` lines belong to. Tracking it
// is what lets the UUID scan skip test paths without skipping the rest of a diff.
const DIFF_FILE_RE = pyRegex(String.raw`^\+\+\+ b/(.*)$`);
const TEST_PATH_RE = pyRegex(String.raw`(^|/)__tests__/|\.test\.[jt]sx?$|(^|/)tests/`);
// `@@ -oldstart,oldcount +newstart,newcount @@` -- newstart is where the new
// file's line numbering resumes for this hunk.
const HUNK_HEADER_RE = pyRegex(String.raw`^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@`);

/**
 * `[path, lineNo, line]` for every added line.
 *
 * `lineNo` is the line's real position in the resulting file, tracked from each
 * hunk's `+newstart` header and advanced on every context or added line
 * (removed lines only exist on the old side and don't advance it). Previously
 * this was an enumeration index over the filtered `+`-only lines, which is only
 * correct when a diff is a single hunk starting at line 1 -- any other shape
 * reported a line number that pointed nowhere near the actual match, which is
 * exactly the class of diff a real PR produces.
 */
export function diffAddedLines(diff: string, { excludeTests = false } = {}): Array<[string, number, string]> {
  const out: Array<[string, number, string]> = [];
  let path = '?';
  let newLine = 0;
  for (const line of pySplitlines(diff)) {
    const header = DIFF_FILE_RE.exec(line);
    if (header) {
      path = header[1]!;
      continue;
    }
    const hunk = HUNK_HEADER_RE.exec(line);
    if (hunk) {
      newLine = parseInt(hunk[1]!, 10);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      if (!(excludeTests && TEST_PATH_RE.test(path))) out.push([path, newLine, line]);
      newLine += 1;
    } else if (line.startsWith('-') || line.startsWith('\\')) {
      continue; // old-side-only line, or "\ No newline at end of file"
    } else {
      newLine += 1; // unchanged context line, still present in the new file
    }
  }
  return out;
}

/** Exit 2. With no message: the identifier list did not compile (and is not printed). */
class UsageError extends Error {}

/**
 * The identifier list, compiled, or null when unset. A list that does not
 * compile throws an error that does NOT carry the pattern: a JS SyntaxError
 * quotes it whole, and after translation it is no longer the exact string
 * Actions masks.
 */
function identifierRe(): RegExp | null {
  const ident = pyStrip(process.env.NO_PROD_DATA_IDENTIFIERS ?? '');
  if (!ident) return null;
  try {
    return pyRegex(ident, 'i');
  } catch {
    throw new UsageError();
  }
}

export function scanProse(text: string, where: string, rep: Report, checkCounts: boolean): void {
  const identRe = identifierRe();
  pySplitlines(text).forEach((line, idx) => {
    const i = idx + 1;
    if (checkCounts) {
      const big = COUNT_BIG.test(line);
      const tenancy = COUNT_TENANCY.test(line);
      const small = COUNT_SMALL_IN_CONTEXT.test(line) && hasProdContext(line);
      if (big || tenancy || small) {
        rep.hit(where, 'population count', i, line, 'state evidence qualitatively; exact figures belong in the private knowledge-base');
      }
      if (UUID_RE.test(line)) rep.hit(where, 'UUID', i, line, 'row identifiers must not enter a public repo');
    }
    if (identRe && identRe.test(line)) rep.hitIdentifier(where, i, line);
  });
}

function git(args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return universalNewlines(r.stdout.toString());
}

function readText(path: string): string {
  return universalNewlines(readFileSync(path, 'utf8'));
}

function flagValue(args: string[], flag: string): string | null {
  const at = args.indexOf(flag);
  if (at === -1) return null;
  const val = args[at + 1];
  if (val === undefined) throw new UsageError(`${flag} needs a value`);
  return val;
}

export function main(args: string[]): number {
  if (args.length === 0) {
    console.log(USAGE);
    return 2;
  }
  try {
    return run(args);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.log(
      e.message
        ? `::error::${e.message}\n\n${USAGE}`
        : '::error::NO_PROD_DATA_IDENTIFIERS does not compile as a regular expression. ' +
            'Its value is not printed: this log is world-readable. Check the secret against Python `re` syntax.',
    );
    return 2;
  }
}

function run(args: string[]): number {
  const base = args[0]!;
  const bodyFile = flagValue(args, '--body');
  const titleFile = flagValue(args, '--title');
  const staged = args.includes('--staged');
  const messageFile = flagValue(args, '--message-file');

  const rep = new Report();

  let body = '';
  if (bodyFile && existsSync(bodyFile)) body = readText(bodyFile);

  const allow = ALLOW_RE.exec(body);
  if (allow) {
    console.log(
      `::warning::count/UUID rules suppressed by 'no-prod-data: allow'` +
        `${pyStrip(allow[1]!) ? ' —' + allow[1] : ''}. ` +
        'Identifier checks still apply.',
    );
  }

  const checkCounts = allow === null;

  if (titleFile && existsSync(titleFile)) scanProse(readText(titleFile), 'PR title', rep, checkCounts);
  if (body) scanProse(body, 'PR body', rep, checkCounts);

  const msgs = git(['log', '--format=%B', `${base}..HEAD`]);
  if (pyStrip(msgs)) scanProse(msgs, 'commit message', rep, checkCounts);

  if (messageFile && existsSync(messageFile)) {
    // Drop git's "# ..." comment lines, which git strips from the message.
    const cand = readText(messageFile)
      .split(/(?<=\n)/)
      .filter((l) => !l.startsWith('#'))
      .join('');
    if (pyStrip(cand)) scanProse(cand, 'commit message (candidate)', rep, checkCounts);
  }

  const excludes = SELF.map((p) => `:(exclude)${p}`);
  let diffRange: string[];
  if (staged) {
    const mb = git(['merge-base', base, 'HEAD']).trim() || base;
    diffRange = ['--cached', mb];
  } else {
    diffRange = [`${base}...HEAD`];
  }
  const diff = git([
    'diff',
    ...diffRange,
    '--',
    '.',
    ':(exclude)packages/core/drizzle/meta',
    // drizzle v1 folder snapshots: generated, and every one carries random UUID ids.
    ':(exclude,glob)packages/core/drizzle/**/snapshot.json',
    ...excludes,
  ]);

  // Added SOURCE lines: UUIDs. Needs no secret, so unlike the identifier half
  // below it cannot silently no-op.
  //
  // This existed only for prose (PR title/body/commit messages) until a real
  // workspace id sat in a committed .ts file for months: code was never
  // scanned for UUIDs at all, so the rule was enforced on the description of a
  // change and not on the change.
  //
  // Test files are excluded deliberately. They are full of UUID-shaped
  // fixtures, and a good number are high-entropy enough to be indistinguishable
  // from real ones by shape or by character variety — measured on this repo,
  // `aabbccdd-1234-5678-9abc-def012345678` (synthetic) and
  // `d7e60452-8a4d-49e6-9cf3-60221baf12dd` (looks real) both use 16 distinct
  // hex characters, so no entropy threshold separates them. Every real-looking
  // UUID in the tree today lives under a test path. KNOWN GAP: a genuine id
  // pasted into a test file still passes. Narrow and stated beats broad and
  // switched off for noise.
  if (checkCounts) {
    for (const [path, lineNo, line] of diffAddedLines(diff, { excludeTests: true })) {
      if (UUID_RE.test(line)) {
        rep.hit(
          `added source line (${path})`,
          'UUID',
          lineNo,
          line,
          'pass it in at run time (env var or argument); row identifiers must not enter a public repo',
        );
      }
    }
  }

  // Added code lines: identifiers only.
  const rx = identifierRe();
  if (rx) {
    for (const [path, lineNo, line] of diffAddedLines(diff)) {
      if (rx.test(line)) rep.hitIdentifier(`added code (${path})`, lineNo, line);
    }
  } else if (process.env.NO_PROD_DATA_LOCAL) {
    // A developer/agent machine never has the secret -- that's the whole
    // point of it being a secret. Failing closed here would make every
    // local run red regardless of content, which trains people to ignore
    // it. Say plainly what was skipped instead of faking a verdict.
    console.log(
      '::warning::NO_PROD_DATA_IDENTIFIERS not set locally -- the handle/' +
        'private-repo scan (added code AND prose) was skipped. CI still ' +
        'enforces it with the real secret. This run cannot promise that ' +
        'verdict for this half.',
    );
  } else {
    // Not a warning. With no pattern there is nothing to match, so the
    // identifier half of this check silently passes every PR -- including one
    // that adds a private repo name to a public file.
    rep.failed = true;
    console.log(
      '::error::NO_PROD_DATA_IDENTIFIERS is not set, so the handle and ' +
        'private-repo checks scanned nothing. Set it as a repository ' +
        'SECRET (not a variable -- variable values are printed in this ' +
        'log) under Settings → Secrets and variables → Actions.',
    );
  }

  if (rep.failed) {
    console.log('');
    console.log("This repository is public. See 'This Repo Is Public' in CLAUDE.md.");
    if (rep.suppressible) {
      console.log('Matches are shown masked on purpose: Actions logs on a public repo are');
      console.log('world-readable, so printing the value would republish it.');
      console.log('If a finding is a false positive, add a line to the PR body:');
      console.log('  no-prod-data: allow <short reason>');
    }
    return 1;
  }

  console.log('no-prod-data: clean');
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
