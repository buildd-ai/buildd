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
 * The actionable invariant for any NEW migration is therefore: its `when` must
 * exceed the max `when` of all earlier entries. We intentionally do NOT assert
 * global strict monotonicity — a few legacy pairs (0020/21, 0032/33, 0043/44)
 * are out of order but already applied everywhere and harmless to leave.
 */
describe('drizzle migration journal ordering', () => {
  const journalPath = join(import.meta.dir, '..', 'drizzle', 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  it('the newest migration has a `when` greater than every prior migration', () => {
    expect(entries.length).toBeGreaterThan(1);
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
