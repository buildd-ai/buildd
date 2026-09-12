import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { MEMORY_DIGEST_POLICY_VERSION } from '../../src/memory-digest-policy';

/**
 * WHY THIS TEST EXISTS — read this before you re-pin anything.
 *
 * `memory-digest-policy.ts` runs a live two-arm experiment on the worker
 * prompt: `full` (control — the workspace-wide memory digest is included) vs
 * `task_scoped` (treatment — it is dropped). The arms are meant to differ on
 * exactly ONE axis, and that only holds while everything else about memory
 * injection stays still.
 *
 * `MEMORY_DIGEST_POLICY_VERSION` is the mechanism for that. It does two
 * things: it stamps every outcome row so rows from different definitions of an
 * arm are never pooled, and — because the assignment draw is salted with it —
 * bumping it RE-RANDOMISES, so no task carries an arm it drew against a
 * different meaning of that arm.
 *
 * The failure mode this guard catches is not a bad change. It is a GOOD change
 * to memory retrieval, landed mid-flight, with no version bump: the control
 * silently moves, one cohort straddles two injection behaviours, and the pooled
 * headline number becomes an artifact of where that boundary fell. Nothing
 * breaks, no test fails, and the contamination is invisible until someone
 * reads the commit log against the enrolment window. That has already happened
 * once on this experiment.
 *
 * So: this test pins a content fingerprint of every surface that decides what
 * memory reaches the prompt, keyed to the CURRENT policy version. Change any of
 * them and CI goes red until you either bump the version or revert.
 *
 * Same shape as `cbm-version-pin.test.ts` — a pin across files that fails on
 * drift, for a coupling the type system cannot see.
 */

const REPO_ROOT = join(import.meta.dir, '../../../..');

/**
 * The pinned pair. The version and the fingerprints live in one object because
 * they are one fact: "this is what the arms mean at memory-digest-v4".
 *
 * To re-pin: run this test, copy the `Received` block it prints into
 * `PINNED.surfaces`, and change `PINNED.policyVersion` to match the new
 * `MEMORY_DIGEST_POLICY_VERSION`. Do both in the SAME commit as the behaviour
 * change — a re-pin without a bump is the exact contamination this guards.
 */
const PINNED = {
  policyVersion: 'memory-digest-v4',
  surfaces: {
    'apps/runner/src/memory-digest-policy.ts': '206abe9b8e13f89f',
    'apps/runner/src/task-memory-retrieval.ts': 'db7560ff4d94fd41',
    'packages/core/task-path-inference.ts': '322aed95cedbb465',
    'packages/core/memory-file-scope.ts': 'cf150b970baf8069',
    'packages/core/memory-file-scope-sql.ts': 'de0dc5516e276b23',
    'packages/core/memory-query-tokens.ts': '33cab6337689e231',
    'apps/runner/src/buildd.ts :: getCompactObservations()': '7e887a20fcf3a8d9',
    'apps/runner/src/buildd.ts :: searchObservations()': '90df6b7106c286ae',
    'apps/runner/src/buildd.ts :: getBatchObservations()': '9bc8eb66fa8b4420',
    'packages/core/memory-store.ts :: search()': 'ca6730bd771de4a3',
    'apps/runner/src/prompt-builder.ts :: assignMemoryDigestArm(…)': 'f737b2c31dc0813d',
    'apps/runner/src/prompt-builder.ts :: buildMemoryBlock(…)': 'f4b44c175c7377b3',
    'apps/runner/src/workers.ts :: retrieveTaskMemory(…)': '24cbbe4435d2b5be',
  },
} as const;

/**
 * What is in scope, and — just as importantly — what is not.
 *
 * IN: every surface whose behaviour changes the bytes of the `## Workspace
 * Memory` block, or changes which memories are eligible to appear in it.
 *
 * OUT, deliberately:
 * - The rest of `workers.ts` / `prompt-builder.ts`. They are 5k and 600 lines
 *   of unrelated prompt assembly; a whole-file pin would fire on every edit and
 *   get deleted by the third engineer it annoyed. Only the memory call sites
 *   are pinned — which is enough, because that is where the arguments feeding
 *   retrieval are chosen (the contaminating commit's change to `workers.ts` was
 *   adding one argument to `retrieveTaskMemory`).
 * - `api/workspaces/[id]/memory/route.ts`. It is auth plus a query-param
 *   pass-through; the logic that decides which rows come back lives in
 *   `MemoryStore.search`, which IS pinned. Pinning the route would trip on
 *   auth and dashboard-pagination refactors that cannot move the prompt.
 * - `path-overlap.ts`. Shared with path claims and dependency inference, so it
 *   churns for reasons unrelated to retrieval. Its contribution here is
 *   `stripTrailingSep`, and the overlap semantics that matter are restated
 *   executably in `memory-file-scope.ts`, which is pinned.
 * - `MemoryStore`'s own compact-markdown renderer. The runner does not call it:
 *   the digest the prompt gets is rendered by `buildd.ts`'s
 *   `getCompactObservations` off the list endpoint.
 * - Feedback memories (`searchFeedbackMemories`). They render as a separate
 *   `## User Preferences` block, outside the arms' axis.
 */
type Surface =
  | { key: string; file: string }
  | { key: string; file: string; member: string }
  | { key: string; file: string; call: string };

const SURFACES: Surface[] = [
  // Whole files: each one exists solely to decide what memory reaches a prompt,
  // so any change to it is by definition a change to an arm.

  // The arms themselves: assignment, the digest cap, and the block rendering.
  { key: 'apps/runner/src/memory-digest-policy.ts', file: 'apps/runner/src/memory-digest-policy.ts' },
  // Which memories land in `### Relevant to This Task`, and the step order that
  // decides it. Changed without a bump in #2209 — the contamination event.
  { key: 'apps/runner/src/task-memory-retrieval.ts', file: 'apps/runner/src/task-memory-retrieval.ts' },
  // The regex that turns task prose into a path scope. Widen it and more tasks
  // match on inferred paths instead of falling through to the title step.
  { key: 'packages/core/task-path-inference.ts', file: 'packages/core/task-path-inference.ts' },
  // Path-scope normalisation and the executable overlap spec.
  { key: 'packages/core/memory-file-scope.ts', file: 'packages/core/memory-file-scope.ts' },
  // The SQL that overlap compiles to — the half that actually runs.
  { key: 'packages/core/memory-file-scope-sql.ts', file: 'packages/core/memory-file-scope-sql.ts' },
  // Which words the title step searches on. v4 was bumped for a change here.
  { key: 'packages/core/memory-query-tokens.ts', file: 'packages/core/memory-query-tokens.ts' },

  // Regions inside wider files: pinned narrowly so unrelated edits stay quiet.

  // Renders the workspace-wide digest markdown — i.e. the control arm's payload.
  { key: 'apps/runner/src/buildd.ts :: getCompactObservations()', file: 'apps/runner/src/buildd.ts', member: 'getCompactObservations' },
  // The retrieval request itself: query, limit, and file scope on the wire.
  { key: 'apps/runner/src/buildd.ts :: searchObservations()', file: 'apps/runner/src/buildd.ts', member: 'searchObservations' },
  // Hydrates the matched memories into the content that gets injected.
  { key: 'apps/runner/src/buildd.ts :: getBatchObservations()', file: 'apps/runner/src/buildd.ts', member: 'getBatchObservations' },
  // Server side of retrieval: filters, tokenisation and ordering decide which
  // rows fit inside the caller's `limit`.
  { key: 'packages/core/memory-store.ts :: search()', file: 'packages/core/memory-store.ts', member: 'search' },
  // Call sites. What gets passed in is behaviour: the arm is drawn here, and
  // the retrieval inputs are chosen here.
  { key: 'apps/runner/src/prompt-builder.ts :: assignMemoryDigestArm(…)', file: 'apps/runner/src/prompt-builder.ts', call: 'assignMemoryDigestArm' },
  { key: 'apps/runner/src/prompt-builder.ts :: buildMemoryBlock(…)', file: 'apps/runner/src/prompt-builder.ts', call: 'buildMemoryBlock' },
  { key: 'apps/runner/src/workers.ts :: retrieveTaskMemory(…)', file: 'apps/runner/src/workers.ts', call: 'retrieveTaskMemory' },
];

// ---------------------------------------------------------------------------
// Fingerprinting.
//
// Comments are stripped and whitespace collapsed before hashing, so rewording
// a comment (or this very file's pointer comment next to the version constant)
// does not fire the guard. String and regex literals are preserved verbatim —
// they are content.
//
// The stripper is a small hand-rolled lexer, not a parser. It handles line and
// block comments, all three quote forms, `${}` interpolation, and regex
// literals. It is not TypeScript-complete: if it ever misreads something the
// result is still deterministic, so drift is still detected — the only cost is
// that a nearby comment-only edit could trip the pin. That false positive is
// cleared by re-pinning, which is why the failure message says how.
// ---------------------------------------------------------------------------

/** True when a `/` at this position opens a regex literal rather than divides. */
function startsRegex(prevCode: string, prevWord: string): boolean {
  if (!prevCode) return true;
  if ('(,=:[!&|?{};+-*%~^<>'.includes(prevCode)) return true;
  return ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await'].includes(prevWord);
}

/** Index just past a `'`/`"` string starting at `i`. */
function endOfQuoted(src: string, i: number): number {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === quote) return j + 1;
    if (src[j] === '\n') return j; // unterminated; do not run away
  }
  return src.length;
}

/** Index just past a template literal starting at `i`, `${}` groups included. */
function endOfTemplate(src: string, i: number): number {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '`') return j + 1;
    if (src[j] === '$' && src[j + 1] === '{') { j = endOfGroup(src, j + 1, '{', '}') - 1; continue; }
  }
  return src.length;
}

/** Index just past a regex literal starting at `i`, char classes included. */
function endOfRegex(src: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '[') inClass = true;
    else if (src[j] === ']') inClass = false;
    else if (src[j] === '/' && !inClass) {
      let k = j + 1;
      while (k < src.length && /[a-z]/.test(src[k])) k++; // flags
      return k;
    } else if (src[j] === '\n') return j; // unterminated; it was division after all
  }
  return src.length;
}

/**
 * Index just past the balanced `open`…`close` group beginning at `i`, skipping
 * anything that only looks like a delimiter because it sits in a comment,
 * string or regex.
 */
function endOfGroup(src: string, i: number, open: string, close: string): number {
  let depth = 0;
  let prevCode = '';
  let prevWord = '';
  for (let j = i; j < src.length; j++) {
    const two = src.slice(j, j + 2);
    if (two === '//') { while (j < src.length && src[j] !== '\n') j++; continue; }
    if (two === '/*') { const end = src.indexOf('*/', j + 2); j = end === -1 ? src.length : end + 1; continue; }
    const c = src[j];
    if (c === '"' || c === "'") { j = endOfQuoted(src, j) - 1; prevCode = c; prevWord = ''; continue; }
    if (c === '`') { j = endOfTemplate(src, j) - 1; prevCode = c; prevWord = ''; continue; }
    if (c === '/' && startsRegex(prevCode, prevWord)) { j = endOfRegex(src, j) - 1; prevCode = '/'; prevWord = ''; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return j + 1; }
    if (/\s/.test(c)) continue;
    prevWord = /[A-Za-z_$]/.test(c) ? prevWord + c : '';
    prevCode = c;
  }
  throw new Error(`unbalanced ${open}${close} from offset ${i}`);
}

/** Strip comments, collapse whitespace, keep literals verbatim. */
export function normalizeSource(src: string): string {
  let out = '';
  let prevCode = '';
  let prevWord = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); i = end === -1 ? src.length : end + 2; continue; }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = c === '`' ? endOfTemplate(src, i) : endOfQuoted(src, i);
      out += src.slice(i, end);
      i = end; prevCode = c; prevWord = '';
      continue;
    }
    if (c === '/' && startsRegex(prevCode, prevWord)) {
      const end = endOfRegex(src, i);
      out += src.slice(i, end);
      i = end; prevCode = '/'; prevWord = '';
      continue;
    }
    if (/\s/.test(c)) {
      if (out && !out.endsWith(' ')) out += ' ';
      i++;
      continue;
    }
    out += c;
    prevWord = /[A-Za-z_$]/.test(c) ? prevWord + c : '';
    prevCode = c;
    i++;
  }
  return out.trim();
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Offset of the `{` that opens a method body, given the offset just past its
 * parameter list.
 *
 * Not simply the next `{`: a return type annotation carries its own braces
 * (`Promise<{ markdown: string; count: number }>`), and taking those captures
 * the signature and calls it the body. Braces nested inside `<>`, `()` or `[]`
 * therefore do not count — a return type's object literal is always inside the
 * generic's angle brackets.
 */
function bodyBraceAfter(src: string, from: number): number {
  let angle = 0, paren = 0, square = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '[') square++;
    else if (c === ']') square = Math.max(0, square - 1);
    else if (c === '{' && angle === 0 && paren === 0 && square === 0) return i;
  }
  throw new Error(`no method body found after offset ${from}`);
}

/** The one place a source region is located; also asserts it is unambiguous. */
function regionSource(surface: Surface): string {
  const src = readFileSync(join(REPO_ROOT, surface.file), 'utf8');

  if ('member' in surface) {
    // A class method at any indentation, optionally async. Anchored to line
    // start so a call to the same name elsewhere is not mistaken for it.
    const anchor = new RegExp(`^[ \\t]*(?:async[ \\t]+)?${surface.member}\\s*\\(`, 'gm');
    const hits = [...src.matchAll(anchor)];
    if (hits.length !== 1) {
      throw new Error(`${surface.key}: expected 1 declaration of ${surface.member}, found ${hits.length}`);
    }
    // Signature first, then the body, so a changed parameter list counts as
    // drift too.
    const start = hits[0].index!;
    const paramsEnd = endOfGroup(src, start + hits[0][0].length - 1, '(', ')');
    const brace = bodyBraceAfter(src, paramsEnd);
    const region = src.slice(start, endOfGroup(src, brace, '{', '}'));
    // A method body's closing brace sits alone on its own line. If the capture
    // ends mid-line we grabbed a type literal, not the body — the bug this
    // check was added after hitting: `Promise<{ markdown: string }>` gave a
    // 96-character "body" that was really just the signature.
    if (!/\n[ \t]*\}$/.test(region)) {
      throw new Error(`${surface.key}: captured a type literal, not the method body (got ${region.length} chars)`);
    }
    return region;
  }

  if ('call' in surface) {
    const anchor = new RegExp(`\\b${surface.call}\\s*\\(`, 'g');
    const hits = [...src.matchAll(anchor)].filter(h => {
      // Skip the import statement and any type position.
      const lineStart = src.lastIndexOf('\n', h.index!) + 1;
      return !/^\s*(import|export)\b/.test(src.slice(lineStart, h.index!));
    });
    if (hits.length !== 1) {
      throw new Error(`${surface.key}: expected 1 call to ${surface.call}, found ${hits.length}`);
    }
    const parenStart = hits[0].index! + hits[0][0].length - 1;
    return src.slice(hits[0].index!, endOfGroup(src, parenStart, '(', ')'));
  }

  return src;
}

function fingerprints(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const surface of SURFACES) out[surface.key] = sha(normalizeSource(regionSource(surface)));
  return out;
}

/** The paste-ready replacement for `PINNED.surfaces`, printed on failure. */
function repinBlock(actual: Record<string, string>): string {
  const rows = SURFACES.map(s => `    '${s.key}': '${actual[s.key]}',`).join('\n');
  return `  surfaces: {\n${rows}\n  },`;
}

const REMEDIES = `Two valid remedies, and only two:

  1. BUMP the version. Add a new case to MEMORY_DIGEST_POLICY_VERSION in
     apps/runner/src/memory-digest-policy.ts saying what changed and why it
     moves an arm, then re-pin. This stops old rows being pooled with new ones,
     and re-randomises the assignment so no task keeps an arm it drew against a
     different definition of that arm.

  2. REVERT the change and land it once the experiment concludes.

"Just re-pin it" is not a third option. Re-pinning without a bump is exactly the
silent rebase this test exists to make loud.

RE-PIN (do this in the SAME commit as the version bump):
  - set PINNED.policyVersion in this file to the new version string
  - replace PINNED.surfaces with the block printed above

If you think this fired on a comment-only edit, that is the documented limit of
the normaliser (see its header) — confirm with \`git diff\` and re-pin.`;

describe('memory digest policy version pin', () => {
  it('pins the version the fingerprints were taken at', () => {
    // The coupling, made mechanical: a bump without a re-pin lands here, and a
    // re-pin without a bump lands here too. The pair only ever moves together.
    if (MEMORY_DIGEST_POLICY_VERSION !== PINNED.policyVersion) {
      throw new Error(
        `MEMORY_DIGEST_POLICY_VERSION is '${MEMORY_DIGEST_POLICY_VERSION}' but the ` +
        `fingerprints below were pinned at '${PINNED.policyVersion}'.\n\n` +
        `If you bumped the version because memory injection changed, re-pin: run this ` +
        `test again (it prints a paste-ready block) and set PINNED.policyVersion to the ` +
        `new string.\n\nIf you did NOT mean to change either, revert.`,
      );
    }
  });

  it('locates exactly one region per pinned surface', () => {
    // If a method is renamed or a call site duplicated, the pin would otherwise
    // silently start measuring the wrong text — or nothing at all, which is the
    // green-over-an-empty-set failure this guard is supposed to prevent.
    for (const surface of SURFACES) {
      expect(() => regionSource(surface)).not.toThrow();
      expect(regionSource(surface).length).toBeGreaterThan(0);
    }
  });

  it('has not changed what memory reaches the prompt since the version was set', () => {
    const actual = fingerprints();
    const pinned = PINNED.surfaces as Record<string, string>;
    const drifted = Object.keys(actual).filter(k => actual[k] !== pinned[k]);
    if (drifted.length === 0) return;
    // Thrown, not `expect`ed with a console note: tests/setup.ts stubs out
    // console.{log,error,warn} for the duration of every test, so anything
    // logged from in here is discarded. The message has to BE the failure.
    throw new Error(
      `MEMORY INJECTION CHANGED WITHOUT A POLICY VERSION BUMP\n\n` +
      `A live two-arm experiment is enrolling on ${MEMORY_DIGEST_POLICY_VERSION} (full vs\n` +
      `task_scoped workspace memory). These surfaces decide what memory reaches a\n` +
      `worker's prompt, and ${drifted.length === 1 ? 'one of them' : `${drifted.length} of them`} moved:\n\n` +
      drifted.map(k => `  - ${k}`).join('\n') +
      `\n\nWhy that is a problem: changing them mid-flight silently rebases the\n` +
      `comparison. The control arm now means something different than it did for the\n` +
      `rows already collected, so one cohort straddles two injection behaviours and\n` +
      `the pooled result becomes an artifact of where that boundary fell. Nothing\n` +
      `errors at runtime — which is why it needs a test.\n\n` +
      `${repinBlock(actual)}\n\n` +
      REMEDIES,
    );
  });

  it('covers every surface the experiment depends on', () => {
    // A pin with a surface quietly dropped from SURFACES is a green light over
    // an empty set. Keep the two lists in lockstep.
    expect(Object.keys(fingerprints()).sort()).toEqual(Object.keys(PINNED.surfaces).sort());
  });

  it('ignores comments but not code, when fingerprinting', () => {
    // The normaliser is load-bearing for whether engineers tolerate this guard.
    // If it stopped stripping comments, every doc edit would look like drift.
    const withComments = `
      /** doc */
      export const A = 1; // trailing
      /* block */ const re = /a\\/\\/b/g;
      const s = "// not a comment";
    `;
    const rewordedComments = `
      /** different doc entirely */
      export const A = 1; // other
      const re = /a\\/\\/b/g;
      const s = "// not a comment";
    `;
    expect(normalizeSource(withComments)).toBe(normalizeSource(rewordedComments));
    // Regex and string literals survive: they are content, not formatting.
    expect(normalizeSource(withComments)).toContain('/a\\/\\/b/g');
    expect(normalizeSource(withComments)).toContain('"// not a comment"');
    // And a real change still shows up.
    expect(normalizeSource(withComments)).not.toBe(normalizeSource(withComments.replace('A = 1', 'A = 2')));
  });
});
