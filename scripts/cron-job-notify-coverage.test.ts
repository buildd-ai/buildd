import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import {
  CRON_JOB_REGISTRY,
  parseNotifyFireMarkers,
  formatNotifyFireMarker,
} from '../packages/core/signal-registry';

/**
 * Bidirectional coverage over the `CRON_JOB_REGISTRY` entries in
 * `packages/core/signal-registry.ts`.
 *
 * The convention this enforces: a `findings`-polarity cron job — one whose
 * `changed` count is problems FOUND, not work performed — is not allowed to
 * ship without a demonstrated path to notify a human when it finds one. An
 * outage ran a full night while its detector fired correctly on every run,
 * because the one branch of its route that could have paged someone had no
 * notification call in it at all. This test is the thing that would have
 * failed the build before that branch shipped.
 *
 * Modeled directly on `scripts/signal-fire-coverage.test.ts` — same shape,
 * same `git ls-files` sourcing so an untracked scratch file cannot flip this
 * for everyone else, same two-direction check:
 *   1. Every `findings`-polarity registry entry names a notifyTest file+title,
 *      that file is git-tracked, and it contains a test with that exact title
 *      carrying the `@notify-fire:` marker for this slug immediately above it.
 *   2. Every `@notify-fire:` marker found in the tracked test corpus names a
 *      slug that IS a `findings`-polarity entry in the registry, and matches
 *      that entry's declared notifyTest file+title.
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
      for (const slug of parseNotifyFireMarkers(line)) {
        out.push({ slug, title: titleAfterMarkerLine(lines, idx), file });
      }
    });
  }
  return out;
}

const findingsJobs = CRON_JOB_REGISTRY.filter(e => e.changedPolarity === 'findings');

describe('cron job registry sanity', () => {
  it('has at least the detector jobs registered as findings-polarity', () => {
    expect(findingsJobs.length).toBeGreaterThan(0);
  });
});

describe('findings job → notify-test (every findings-polarity job is provably able to notify)', () => {
  it('every findings-polarity job declares a notifyTest', () => {
    const missing = findingsJobs.filter(e => !e.notifyTest);
    expect(
      missing.map(e => e.slug),
      'a findings-polarity job with no notifyTest can raise an alarm nobody will ever see',
    ).toEqual([]);
  });

  it.each(findingsJobs.map(e => [e.slug, e] as const))(
    '%s: notifyTest file is git-tracked and contains the marked test',
    (_slug, entry) => {
      const tracked = new Set(trackedTestFiles());
      expect(tracked.has(entry.notifyTest!.file), `${entry.notifyTest!.file} is not git-tracked`).toBe(true);

      const content = readFileSync(entry.notifyTest!.file, 'utf8');
      const lines = content.split('\n');
      const markerLineIndex = lines.findIndex(l => parseNotifyFireMarkers(l).includes(entry.slug));
      expect(
        markerLineIndex,
        `${entry.notifyTest!.file} has no "${formatNotifyFireMarker(entry.slug)}" marker`,
      ).toBeGreaterThanOrEqual(0);

      const title = titleAfterMarkerLine(lines, markerLineIndex);
      expect(
        title,
        `${entry.notifyTest!.file}: marker for '${entry.slug}' is not directly above an it()/test() block`,
      ).toBe(entry.notifyTest!.title);
    },
  );
});

describe('notify-fire marker → registry (no marker for a non-findings or unregistered job)', () => {
  it('every @notify-fire marker in the repo names a findings-polarity slug in the registry', () => {
    const registered = new Set(findingsJobs.map(e => e.slug));
    const found = markersInRepo();
    const orphans = found.filter(m => !registered.has(m.slug));
    expect(
      orphans,
      `these markers reference a slug that is not a findings-polarity CRON_JOB_REGISTRY entry:\n` +
        orphans.map(o => `  ${o.file}: ${formatNotifyFireMarker(o.slug)}`).join('\n'),
    ).toEqual([]);
  });

  it('every @notify-fire marker sits in the exact file+title its registry entry declares', () => {
    const bySlug = new Map(findingsJobs.map(e => [e.slug, e]));
    const found = markersInRepo();
    const mismatched = found
      .filter(m => bySlug.has(m.slug))
      .filter(m => {
        const entry = bySlug.get(m.slug)!;
        return !entry.notifyTest || entry.notifyTest.file !== m.file || entry.notifyTest.title !== m.title;
      });
    expect(
      mismatched,
      `these markers don't match their registry entry's declared notifyTest (file/title drifted apart):\n` +
        mismatched.map(m => `  ${m.file}: ${formatNotifyFireMarker(m.slug)} (found title: ${m.title})`).join('\n'),
    ).toEqual([]);
  });

  it('no job is marked as notify-firing in more than one place', () => {
    const found = markersInRepo();
    const bySlug = new Map<string, number>();
    for (const m of found) bySlug.set(m.slug, (bySlug.get(m.slug) ?? 0) + 1);
    const duplicated = [...bySlug.entries()].filter(([, count]) => count > 1);
    expect(duplicated).toEqual([]);
  });
});
