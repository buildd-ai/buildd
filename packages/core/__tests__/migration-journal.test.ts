import { describe, it, expect } from 'bun:test';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards on `drizzle/meta/_journal.json`, because both ways it can be wrong are
 * silent until a production deploy.
 *
 * 1. **A journal entry with no `.sql` file breaks every migration.**
 *    `readMigrationFiles` loops the whole journal and `readFileSync`s each tag
 *    before it filters by what has already been applied, so one missing file
 *    throws and nothing runs — including the migrations that would have worked.
 *    A hand-edited journal entry shipped exactly this, and it was invisible
 *    locally because migrations only run on deploy.
 *
 * 2. **A trailing entry below the high-water mark never runs.**
 *    Drizzle applies by `when`, not by `idx`. A new migration whose `when` is
 *    lower than the newest already-applied one is skipped forever, so its columns
 *    never exist while the code that reads them ships anyway.
 *
 * Earlier mid-list inversions are grandfathered: they were applied long ago and
 * rewriting history would re-run them. Only the tail is enforced, which is where
 * a newly generated migration lands.
 */

const DRIZZLE_DIR = path.resolve(import.meta.dir, '..', 'drizzle');
const JOURNAL_PATH = path.join(DRIZZLE_DIR, 'meta', '_journal.json');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints?: boolean;
}

function journal(): { entries: JournalEntry[] } {
  return JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
}

describe('drizzle migration journal', () => {
  it('has an entry for every journal tag on disk', () => {
    const missing = journal().entries
      .map(e => e.tag)
      .filter(tag => !fs.existsSync(path.join(DRIZZLE_DIR, `${tag}.sql`)));

    // A missing file is not a partial failure — it is a total one.
    expect(missing).toEqual([]);
  });

  it('loads through drizzle\'s own migrator without throwing', () => {
    // The most direct assertion available: run the exact function the deploy runs.
    expect(() => readMigrationFiles({ migrationsFolder: DRIZZLE_DIR })).not.toThrow();
  });

  it('gives the newest migration the highest `when`', () => {
    const entries = journal().entries;
    const last = entries[entries.length - 1]!;
    const maxWhen = Math.max(...entries.map(e => e.when));

    // If this fails, the migration you just added will never run in production
    // and no error will say so. Regenerate it so it gets a current timestamp
    // rather than hand-editing `when`.
    expect(last.when).toBe(maxWhen);
  });

  it('has unique idx and tag values', () => {
    const entries = journal().entries;
    expect(new Set(entries.map(e => e.idx)).size).toBe(entries.length);
    expect(new Set(entries.map(e => e.tag)).size).toBe(entries.length);
  });

  it('has no orphan .sql file that the journal never references', () => {
    // Grandfathered: a custom-migration stub whose every line is commented out,
    // so it is inert. Left on disk rather than deleted because removing history
    // buys nothing; named here so a NEW orphan still fails this test.
    const KNOWN_INERT_ORPHANS = new Set(['0024_numerous_firebird.sql']);

    const referenced = new Set(journal().entries.map(e => `${e.tag}.sql`));
    const orphans = fs.readdirSync(DRIZZLE_DIR)
      .filter(f => f.endsWith('.sql'))
      .filter(f => !referenced.has(f) && !KNOWN_INERT_ORPHANS.has(f));

    // An orphan is the other half of the same mistake: DDL that exists but is
    // never applied, so the schema silently diverges from the migration history.
    expect(orphans).toEqual([]);
  });
});
