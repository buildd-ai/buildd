import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectLayout,
  folderMillis,
  formatFolderPrefix,
  isCommentOnly,
  MigrationLayoutError,
  readMigrationTree,
  v1LayoutProblems,
} from '../db/migrate-tree';

/**
 * The drizzle v1 tree reader (packages/core/db/migrate-tree.ts), pinned against
 * real drizzle-kit 1.0.0-rc.4 output. `fixtures/drizzle-v1-rc4/` is exactly
 * what `drizzle-kit generate` (rc.4) wrote for a two-step schema, and the
 * EXPECTED values below are what rc.4's own `readMigrationFiles` returned for
 * that directory. Our reader must agree with drizzle's on name, hash,
 * folderMillis and the statement split (rc properties b and c in the design),
 * so a tracking row we write means the same thing to drizzle's tooling.
 */

const FIXTURE = join(import.meta.dir, 'fixtures', 'drizzle-v1-rc4');

// Recorded from rc.4's readMigrationFiles({ migrationsFolder: FIXTURE }).
const EXPECTED = [
  {
    name: '20261012153026_init',
    hash: 'ff9b54f6bc0d32c7e7f1baa6337fb94c4fb4b60dc70b3670cf5c17cc262aa8c2',
    folderMillis: 1791819026000,
    sql: [
      'CREATE TABLE "widgets" (\n\t"id" integer PRIMARY KEY,\n\t"name" text NOT NULL,\n\t"kind" text\n);\n',
      '\nCREATE INDEX "widgets_kind_idx" ON "widgets" ("kind") WHERE "kind" is not null;',
    ],
  },
  {
    name: '20261012153027_add_extra',
    hash: '626036f9edf22755752820a773e2791deaf9e225e55b077111a8ae79cce3f0d7',
    folderMillis: 1791819027000,
    sql: ['ALTER TABLE "widgets" ADD COLUMN "extra" text;'],
  },
];

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'migrate-tree-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function folder(name: string, sql = 'SELECT 1;', snapshot = true) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'migration.sql'), sql);
  if (snapshot) writeFileSync(join(dir, name, 'snapshot.json'), '{}');
}

describe('readMigrationTree on real drizzle-kit rc.4 output', () => {
  it('matches what rc.4 readMigrationFiles returns: name, hash, folderMillis, raw breakpoint split', () => {
    expect(readMigrationTree(FIXTURE)).toEqual(EXPECTED);
  });

  it('hash is sha256 of the whole migration.sql', () => {
    for (const m of readMigrationTree(FIXTURE)) {
      const text = readFileSync(join(FIXTURE, m.name, 'migration.sql'));
      expect(createHash('sha256').update(text).digest('hex')).toBe(m.hash);
    }
  });

  it('every folder carries migration.sql and snapshot.json (layout property)', () => {
    expect(v1LayoutProblems(FIXTURE, { requireSnapshot: true })).toEqual([]);
    expect(detectLayout(FIXTURE)).toBe('v1');
  });
});

describe('folderMillis / formatFolderPrefix', () => {
  it('folderMillis is Date.UTC of the 14-digit prefix (what v1 writes to created_at)', () => {
    expect(folderMillis('20261012153026_init')).toBe(Date.UTC(2026, 9, 12, 15, 30, 26));
  });

  it('formatFolderPrefix truncates ms to the second, in UTC', () => {
    expect(formatFolderPrefix(Date.UTC(2026, 0, 2, 3, 4, 5) + 999)).toBe('20260102030405');
  });

  it('round-trips', () => {
    expect(formatFolderPrefix(folderMillis('20261012153026_x'))).toBe('20261012153026');
  });

  it('refuses an impossible date rather than letting Date.UTC roll it over', () => {
    expect(() => folderMillis('20261332000000_x')).toThrow(MigrationLayoutError);
  });
});

describe('detectLayout: fails closed on anything but one clean layout', () => {
  it('legacy: a journal', () => {
    mkdirSync(join(dir, 'meta'));
    writeFileSync(join(dir, 'meta', '_journal.json'), '{"entries":[]}');
    writeFileSync(join(dir, '0000_x.sql'), 'SELECT 1;');
    expect(detectLayout(dir)).toBe('legacy');
  });

  it('v1: folders only', () => {
    folder('20260101000000_a');
    expect(detectLayout(dir)).toBe('v1');
  });

  it('refuses a legacy .sql at the root of a v1 tree (merge kept a pre-cutover file; v1 would ignore it)', () => {
    folder('20260101000000_a');
    writeFileSync(join(dir, '0261_late_branch.sql'), 'ALTER TABLE t ADD COLUMN c text;');
    expect(() => detectLayout(dir)).toThrow(/0261_late_branch\.sql/);
  });

  it('refuses a meta/ directory next to v1 folders (0.31 kit run on a v1 tree)', () => {
    folder('20260101000000_a');
    mkdirSync(join(dir, 'meta'));
    writeFileSync(join(dir, 'meta', '_journal.json'), '{"entries":[]}');
    expect(() => detectLayout(dir)).toThrow(MigrationLayoutError);
  });

  it('refuses an empty directory', () => {
    expect(() => detectLayout(dir)).toThrow(/no migrations/);
  });
});

describe('readMigrationTree: never silently skips a migration', () => {
  it('refuses a v1-named folder with no migration.sql (drizzle would skip it)', () => {
    folder('20260101000000_a');
    mkdirSync(join(dir, '20260102000000_b'));
    expect(() => readMigrationTree(dir)).toThrow(/20260102000000_b.*migration\.sql/);
  });

  it('refuses a stray directory or file it does not recognise', () => {
    folder('20260101000000_a');
    mkdirSync(join(dir, 'notes'));
    expect(() => readMigrationTree(dir)).toThrow(/notes/);
  });

  it('ignores dotfiles', () => {
    folder('20260101000000_a');
    writeFileSync(join(dir, '.DS_Store'), '');
    expect(readMigrationTree(dir).map((m) => m.name)).toEqual(['20260101000000_a']);
  });

  it('sorts by name', () => {
    folder('20260102000000_b');
    folder('20260101000000_a');
    expect(readMigrationTree(dir).map((m) => m.name)).toEqual(['20260101000000_a', '20260102000000_b']);
  });

  it('does not require snapshot.json to read (the migrator needs only the SQL)', () => {
    folder('20260101000000_a', 'SELECT 1;', false);
    expect(readMigrationTree(dir)).toHaveLength(1);
    expect(v1LayoutProblems(dir, { requireSnapshot: true })).toEqual([
      '20260101000000_a: missing snapshot.json',
    ]);
  });
});

describe('isCommentOnly', () => {
  it('a body of comments and blank lines has nothing to execute', () => {
    expect(isCommentOnly(['-- snapshot rebase\n-- no DDL\n', '\n  \n'])).toBe(true);
  });

  it('any real statement makes it executable', () => {
    expect(isCommentOnly(['-- header\nSELECT 1;'])).toBe(false);
  });
});
