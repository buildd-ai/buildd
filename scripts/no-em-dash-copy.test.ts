import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync } from 'node:fs';

/**
 * No em dash ("—", U+2014) in rendered app copy.
 *
 * Two failure shapes this catches, both seen in this codebase before the
 * sweep that added this guard:
 *   - An em dash used as a sentence joiner ("Session-keyed — the only line
 *     on this page that is."), where stop-slop wants a period or a colon.
 *   - An em dash used as a value placeholder for "unknown" (`value ?? '—'`),
 *     which reads as a broken cell, not an absence. An unknown value should
 *     render nothing or a muted "0" instead — see `docs/design/derived-metric-availability.md`
 *     for the "never a bare 0" half of that rule.
 *
 * En dashes ("–", U+2013) are unaffected: a numeric range like "50–80%" is a
 * legitimate, different character and is not what this guards against.
 *
 * Scope is `apps/web/src/app` and `apps/web/src/components` — the app's own
 * rendered surface — via `git ls-files` (tracked files only, so this reflects
 * what ships). Test files are excluded: a `describe('X — Y')` label is never
 * rendered to a user.
 */
const SCAN_ROOTS = [/^apps\/web\/src\/app\//, /^apps\/web\/src\/components\//];

/**
 * A file matching one of these keeps its em dash(es). Each entry names why,
 * so a new file added under the same reason still needs its own line — this
 * is a claim about a specific path, not a category.
 */
const ALLOWLIST: Array<[pattern: RegExp, reason: string]> = [
  // A delimiter regex that reads an AGENT-authored option string (a worker's
  // own question payload), not copy this app wrote. The character class
  // covers em dash, en dash, and hyphen because the agent's choice of
  // separator is not ours to constrain.
  [/^apps\/web\/src\/app\/app\/\(protected\)\/home\/NeedsYouCards\.tsx$/, 'parses an agent-authored option string, not app copy'],
  [/^apps\/web\/src\/app\/app\/\(protected\)\/missions\/\[id\]\/MissionBoardParts\.tsx$/, 'parses an agent-authored option string, not app copy'],
  [/^apps\/web\/src\/components\/missions\/MissionListCards\.tsx$/, 'parses an agent-authored option string, not app copy'],
  // A console.error diagnostic string — never rendered to a user, so it is
  // not "app copy" in the sense this guard cares about.
  [/^apps\/web\/src\/app\/app\/\(protected\)\/missions\/\[id\]\/page\.tsx$/, 'the one em dash left is inside a console.error, not JSX'],
];

const EM_DASH = '—';

function trackedTsxFiles(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (ls.stdout ?? '')
    .split('\0')
    .filter(f => f.endsWith('.tsx'))
    .filter(f => !f.includes('.test.') && !f.includes('.stories.'))
    .filter(f => SCAN_ROOTS.some(re => re.test(f)));
}

/** Strips block and line comments so a documentation em dash never counts. */
function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('no em dash in app copy', () => {
  test('the scan finds files (guard the guard)', () => {
    expect(trackedTsxFiles().length).toBeGreaterThan(100);
  });

  test('no tracked component/page file renders an em dash outside a comment', () => {
    const offenders = trackedTsxFiles()
      .filter(f => !ALLOWLIST.some(([re]) => re.test(f)))
      .filter(f => stripComments(readFileSync(f, 'utf8')).includes(EM_DASH));
    expect(offenders).toEqual([]);
  });

  test('every allowlist entry still matches a real, em-dash-carrying file', () => {
    // An allowlist entry for a file that was fixed (or renamed/deleted) is a
    // stale exception, not a live one — drop it rather than let it mask the
    // next regression in the same spot.
    const files = trackedTsxFiles();
    const stale = ALLOWLIST
      .filter(([re]) => !files.some(f => re.test(f) && stripComments(readFileSync(f, 'utf8')).includes(EM_DASH)))
      .map(([re, reason]) => `${re} (claimed: ${reason})`);
    expect(stale).toEqual([]);
  });
});
