import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import {
  SIGNAL_REGISTRY,
  parseSignalFireMarkers,
  formatSignalFireMarker,
} from '../packages/core/signal-registry';

/**
 * Bidirectional coverage over `packages/core/signal-registry.ts`.
 *
 * The convention this enforces: "a signal without a test proving it can FIRE
 * is not a signal." Modeled on `scripts/collector-coverage.test.ts` and
 * `scripts/skills-listed.test.ts` — same shape, same enforcement style, same
 * choice of `git ls-files` over the filesystem so an untracked scratch file
 * cannot flip this for everyone else.
 *
 * Two directions, both required:
 *   1. Every registered signal (without `noLocalFireTest`) names a fireTest
 *      file+title, that file is git-tracked, and it actually contains a test
 *      with that exact title carrying the marker (see SIGNAL_FIRE_MARKER_PREFIX
 *      in signal-registry.ts) for this slug immediately above it.
 *   2. Every marker found anywhere in the tracked test corpus names a slug
 *      that IS in the registry, and matches that entry's declared fireTest
 *      file+title — a fire-test cannot exist for a signal this file does not
 *      list, and cannot silently drift to a different title than the one the
 *      registry claims.
 *
 * The marker text itself is never respelled here — it comes from
 * `signal-registry.ts` via `parseSignalFireMarkers`/`formatSignalFireMarker`,
 * both built from the single SIGNAL_FIRE_MARKER_PREFIX constant. A checker
 * that hardcodes the literal pattern text in its own source (including in its
 * own prose comments) self-matches the moment its own file is included in the
 * scan — this file's history has exactly that bug, caught by its own
 * fire-test → registry direction below. Describe the marker by the constant's
 * name here, never by spelling it out.
 */

function trackedTestFiles(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (ls.stdout ?? '')
    .split('\0')
    .filter(f => /\.test\.tsx?$/.test(f));
}

/** The `it`/`test` title on the line immediately following a marker line, if any. */
function titleAfterMarkerLine(lines: string[], markerLineIndex: number): string | null {
  for (let i = markerLineIndex + 1; i < lines.length && i <= markerLineIndex + 3; i++) {
    const m = /\b(?:it|test)(?:\.each\([^)]*\))?\(\s*['"`]([^'"`]+)['"`]/.exec(lines[i]);
    if (m) return m[1];
    // Stop at the first non-blank, non-comment line that isn't the test call —
    // the marker must sit directly above its test, not float free in the file.
    if (lines[i].trim() && !lines[i].trim().startsWith('//') && !lines[i].trim().startsWith('*')) return null;
  }
  return null;
}

/** Every `(slug, title, file)` triple found by scanning the tracked test corpus for markers. */
function markersInRepo(): Array<{ slug: string; title: string | null; file: string }> {
  const out: Array<{ slug: string; title: string | null; file: string }> = [];
  for (const file of trackedTestFiles()) {
    if (!existsSync(file)) continue; // deleted-but-staged edge case
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      for (const slug of parseSignalFireMarkers(line)) {
        out.push({ slug, title: titleAfterMarkerLine(lines, idx), file });
      }
    });
  }
  return out;
}

describe('signal registry sanity', () => {
  it('the registry is non-empty and the corpus scan finds tracked test files', () => {
    expect(SIGNAL_REGISTRY.length).toBeGreaterThan(0);
    expect(trackedTestFiles().length).toBeGreaterThan(50);
  });
});

describe('registry → fire-test (every registered signal is provably able to fire)', () => {
  const withFireTest = SIGNAL_REGISTRY.filter(e => e.fireTest);

  it.each(withFireTest.map(e => [e.slug, e] as const))(
    '%s: fireTest file is git-tracked and contains the marked test',
    (_slug, entry) => {
      const tracked = new Set(trackedTestFiles());
      expect(tracked.has(entry.fireTest!.file), `${entry.fireTest!.file} is not git-tracked`).toBe(true);

      const content = readFileSync(entry.fireTest!.file, 'utf8');
      const lines = content.split('\n');
      const markerLineIndex = lines.findIndex(l => parseSignalFireMarkers(l).includes(entry.slug));
      expect(
        markerLineIndex,
        `${entry.fireTest!.file} has no "${formatSignalFireMarker(entry.slug)}" marker`,
      ).toBeGreaterThanOrEqual(0);

      const title = titleAfterMarkerLine(lines, markerLineIndex);
      expect(
        title,
        `${entry.fireTest!.file}: marker for '${entry.slug}' is not directly above an it()/test() block`,
      ).toBe(entry.fireTest!.title);
    },
  );

  it.each(SIGNAL_REGISTRY.filter(e => e.noLocalFireTest).map(e => [e.slug, e] as const))(
    '%s: has no local fire-test, but names why and where it is tracked instead',
    (_slug, entry) => {
      expect(entry.noLocalFireTest!.reason.length).toBeGreaterThan(0);
      expect(entry.noLocalFireTest!.trackedBy.length).toBeGreaterThan(0);
    },
  );
});

describe('fire-test → registry (no marker for an unregistered signal)', () => {
  it('every @signal-fire marker in the repo names a slug in the registry', () => {
    const registered = new Set(SIGNAL_REGISTRY.map(e => e.slug));
    const found = markersInRepo();
    const orphans = found.filter(m => !registered.has(m.slug));
    expect(
      orphans,
      `these markers reference a slug not in SIGNAL_REGISTRY — register the signal or drop the marker:\n` +
        orphans.map(o => `  ${o.file}: ${formatSignalFireMarker(o.slug)}`).join('\n'),
    ).toEqual([]);
  });

  it('every @signal-fire marker sits in the exact file+title its registry entry declares', () => {
    const bySlug = new Map(SIGNAL_REGISTRY.map(e => [e.slug, e]));
    const found = markersInRepo();
    const mismatched = found
      .filter(m => bySlug.has(m.slug))
      .filter(m => {
        const entry = bySlug.get(m.slug)!;
        return !entry.fireTest || entry.fireTest.file !== m.file || entry.fireTest.title !== m.title;
      });
    expect(
      mismatched,
      `these markers don't match their registry entry's declared fireTest (file/title drifted apart):\n` +
        mismatched.map(m => `  ${m.file}: ${formatSignalFireMarker(m.slug)} (found title: ${m.title})`).join('\n'),
    ).toEqual([]);
  });

  it('no signal is marked as firing in more than one place', () => {
    const found = markersInRepo();
    const bySlug = new Map<string, number>();
    for (const m of found) bySlug.set(m.slug, (bySlug.get(m.slug) ?? 0) + 1);
    const duplicated = [...bySlug.entries()].filter(([, count]) => count > 1);
    expect(duplicated).toEqual([]);
  });
});
