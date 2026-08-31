import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for the 0067_tasks_path_manifest silent-skip incident.
 *
 * Drizzle's migrator reads the highest `created_at` already recorded in
 * `__drizzle_migrations` ONCE per run, then applies every journal entry whose
 * `when` is greater than that high-water-mark. A migration authored with a
 * `when` at or below the high-water-mark is silently skipped: `migrate` exits 0
 * ("success"), the deploy goes green, and the column never gets added — which is
 * exactly how 0067 (`when` = 2025-07-11) slipped past a DB already at 0065's
 * 2026-07 mark and produced `column "path_manifest" does not exist` (42703) in
 * prod inserts.
 *
 * The invariant is therefore: **no** journal entry may have a `when` at or below
 * the max `when` of all entries with a lower `idx`. This file used to check only
 * the tail (newest entry vs. everything before it), which meant a mid-list
 * inversion was invisible the moment one more migration landed on top of it —
 * 0116/0117 (a 7.1-second inversion) was hidden by 0118 that way. The known
 * legacy inversions used to live in this comment only; they are now enumerated
 * in `GRANDFATHERED_INVERSIONS` below so that a NEW one fails.
 *
 * CORRECTION (2026-07-12): the 0020/21 pair was NOT harmless. Direct read-only
 * introspection of production during the release-#1184 schema-drift investigation
 * confirmed 0021 (DROP TABLE secret_refs) and 0022 (DROP COLUMN ... on the
 * objectives/missions table) were both silently skipped in production — the
 * exact same failure mode as 0067, just leaving prod BEHIND instead of missing a
 * new column. See 0074_reconcile_missions_secret_refs_drift.sql, which re-issues
 * the equivalent idempotent DDL under current table names rather than editing
 * 0021/0022 in place (unsafe: 0022 targets the pre-rename "objectives" name).
 */

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface Inversion {
  tag: string;
  idx: number;
  when: number;
  priorMaxTag: string;
  priorMax: number;
}

/**
 * Inversions that already exist in committed history and cannot be repaired by
 * editing `_journal.json` (rewriting a `when` upward would re-run the migration
 * against a schema that has since moved on).
 *
 * This list is SHRINK-ONLY. A new entry means a migration that Drizzle's
 * high-water-mark migrator may silently skip in production — fix the `when`
 * before merging instead of adding it here. Entries are keyed by tag because
 * tags are unique (asserted in migration-journal.test.ts).
 *
 * Note there are SIX entries, not the four you get by comparing each entry with
 * only its immediate predecessor. Drizzle compares against the running maximum,
 * not the previous entry, so 0022 (below 0020's `when`, above 0021's) and 0034
 * (below 0032's, above 0033's) are skippable too — and 0074's own header
 * confirms 0022 was in fact skipped in production alongside 0021. An
 * adjacent-pair check would have declared those two safe.
 *
 * The three oldest offenders (0020, 0032, 0043's partners) sit behind
 * suspiciously round `when` values ending in many zeros — hand-written or
 * produced by a different tool — whereas 0116/0117 is a genuine 7.1-second
 * generation-order artifact from two migrations created in one sitting.
 */
const GRANDFATHERED_INVERSIONS: ReadonlyMap<string, string> = new Map([
  // Confirmed NOT harmless: both were silently skipped in production and had to
  // be reconciled by 0074_reconcile_missions_secret_refs_drift.sql.
  ['0021_faithful_warbound', 'skipped in prod; reconciled by 0074 (see file header)'],
  ['0022_mixed_mastermind', 'skipped in prod; reconciled by 0074 (see file header)'],
  // Never independently re-verified against production. Treat "harmless" as
  // unconfirmed, not disproven.
  ['0033_red_toxin', 'legacy inversion behind 0032; not re-verified against prod'],
  ['0034_spicy_tombstone', 'legacy inversion behind 0032; not re-verified against prod'],
  ['0044_mighty_ricochet', 'legacy inversion behind 0043 (-365s); not re-verified against prod'],
  // Landed in the same release as 0116, so the pair applied together and no
  // high-water-mark skip was possible. Recorded here because the tail-only
  // check never saw it: 0118 hid it the moment it landed.
  ['0117_condemned_johnny_blaze', 'same-release pair with 0116 (-7.1s); applied together'],
]);

function findInversions(entries: readonly JournalEntry[]): Inversion[] {
  const byIdx = [...entries].sort((a, b) => a.idx - b.idx);
  const inversions: Inversion[] = [];
  let priorMax = -Infinity;
  let priorMaxTag = '(none)';

  for (const entry of byIdx) {
    if (entry.when <= priorMax) {
      inversions.push({
        tag: entry.tag,
        idx: entry.idx,
        when: entry.when,
        priorMaxTag,
        priorMax,
      });
    } else {
      priorMax = entry.when;
      priorMaxTag = entry.tag;
    }
  }

  return inversions;
}

describe('drizzle migration journal ordering', () => {
  const journalPath = join(import.meta.dir, '..', 'drizzle', 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  it('has no unrecorded `when` inversion anywhere in the journal', () => {
    expect(entries.length).toBeGreaterThan(1);

    const inversions = findInversions(entries);
    // Print what was measured, not just pass/fail: a silently empty scan is the
    // failure mode this repo keeps hitting.
    console.log(
      `journal ordering: scanned ${entries.length} entries, ` +
        `found ${inversions.length} inversion(s), ${GRANDFATHERED_INVERSIONS.size} grandfathered`,
    );

    const unrecorded = inversions.filter((i) => !GRANDFATHERED_INVERSIONS.has(i.tag));
    expect(
      unrecorded.map(
        (i) =>
          `${i.tag} (idx ${i.idx}) when=${i.when} is ${((i.priorMax - i.when) / 1000).toFixed(1)}s ` +
          `EARLIER than ${i.priorMaxTag} (when=${i.priorMax})`,
      ),
      'A journal entry has a `when` at or below an earlier entry\'s. Drizzle applies ' +
        'by `when` high-water-mark, not idx, so this migration can be silently SKIPPED ' +
        'in production (exit 0, deploy green, DDL never runs). Regenerate it or raise its ' +
        '"when" above the prior max. Do NOT add it to GRANDFATHERED_INVERSIONS — that list ' +
        'is shrink-only and exists for history that can no longer be repaired.',
    ).toEqual([]);
  });

  it('has no stale GRANDFATHERED_INVERSIONS entry', () => {
    const actual = new Set(findInversions(entries).map((i) => i.tag));
    const stale = [...GRANDFATHERED_INVERSIONS.keys()].filter((tag) => !actual.has(tag));

    expect(
      stale,
      'These tags are on the grandfathered-inversion allowlist but are no longer ' +
        'inversions (or no longer in the journal). Delete them — the list is shrink-only, ' +
        'and a stale entry silently widens what a future inversion is allowed to be.',
    ).toEqual([]);
  });

  it('the newest migration has a `when` greater than every prior migration', () => {
    // Kept as its own case because it produces the message a developer who just
    // ran `db:generate` needs, naming the number to beat.
    const newest = entries[entries.length - 1]!;
    const priorMax = Math.max(...entries.slice(0, -1).map((e) => e.when));
    expect(
      newest.when,
      `Migration "${newest.tag}" has when=${newest.when} but a prior migration has ` +
        `when=${priorMax}. Drizzle would silently SKIP it (see file header). ` +
        `Regenerate it or bump its "when" in _journal.json above ${priorMax}.`,
    ).toBeGreaterThan(priorMax);
  });
});
