import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { drizzle } from 'drizzle-orm/neon-http';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';
import {
  lockDriver,
  queryRows,
  readAppliedRows,
  readDbShape,
  recordApplied,
  type MigrateSession,
} from '../db/migrate-client';

/**
 * What db/migrate.ts needs from the installed drizzle, pinned as properties
 * rather than as a version. Each one holds on drizzle-orm 0.45 and was checked
 * against 1.0.0-rc.4, so a bump that breaks one fails here instead of in a
 * deploy. No database: the neon client is a fake that records what drizzle
 * sends it and answers in neon's `fullResults` shape.
 */

type Sent = { sql: string; params: unknown[]; opts: unknown };

function fakeNeonClient(rowsFor: (sql: string) => unknown[] = () => []) {
  const sent: Sent[] = [];
  const transactions: unknown[][] = [];
  const query = async (text: string, params: unknown[] = [], opts?: unknown) => {
    sent.push({ sql: text, params, opts });
    return { rows: rowsFor(text), fields: [], rowCount: 0, command: 'SELECT' };
  };
  const client = Object.assign((text: string, params?: unknown[], opts?: unknown) => query(text, params, opts), {
    query,
    async transaction(queries: unknown[]) {
      transactions.push(queries);
      return Promise.all(queries);
    },
  });
  return { client, sent, transactions };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeDb = (client: unknown) => drizzle({ client: client as any });

describe('drizzle neon-http driver: what the migrator relies on', () => {
  it('drizzle({ client }) sends queries through the client it was given', async () => {
    // drizzle v1 takes a string or a config object only; a client passed
    // positionally is read as a config object and silently replaced.
    const { client, sent } = fakeNeonClient();
    await makeDb(client).execute(sql`SELECT 1`);
    expect(sent.map((s) => s.sql)).toEqual(['SELECT 1']);
  });

  it('db.execute resolves to the full result, rows under `rows`', async () => {
    const { client, sent } = fakeNeonClient(() => [{ created_at: '1700000000000' }]);
    const result = (await makeDb(client).execute(sql`SELECT created_at FROM t`)) as unknown as {
      rows: unknown[];
    };
    expect(result.rows).toEqual([{ created_at: '1700000000000' }]);
    // Object rows, not arrays: readAppliedRows reads `row.created_at`.
    expect(sent[0]!.opts).toMatchObject({ arrayMode: false, fullResults: true });
  });

  it('the migrator runs unchanged on a real drizzle db (no session internals)', async () => {
    const { client, sent } = fakeNeonClient((text) => {
      if (text.includes('__drizzle_migrations')) return [{ created_at: '1700000000000' }];
      if (text.includes('RETURNING holder')) return [{ holder: 'h' }];
      if (text.includes('information_schema.tables')) return [{ table_name: 'tasks' }];
      return [];
    });
    const db: MigrateSession = makeDb(client);

    expect(await readAppliedRows(db)).toEqual([{ created_at: '1700000000000' }]);
    expect(await lockDriver(db).tryAcquire('h', 60_000)).toBe(true);
    expect([...(await readDbShape(db)).tables]).toEqual(['tasks']);
    await recordApplied(db, { hash: 'abc', folderMillis: 1700000000000, sql: [] });
    expect(sent.at(-1)!.params).toEqual(['abc', 1700000000000]);
  });

  it('db.batch is one client.transaction carrying every statement (atomic per-file apply)', async () => {
    const { client, transactions } = fakeNeonClient();
    const db = makeDb(client);
    await db.batch([db.execute(sql`CREATE TABLE a (id int)`), db.execute(sql`INSERT INTO t VALUES (1)`)]);
    expect(transactions.length).toBe(1);
    expect(transactions[0]!.length).toBe(2);
  });

  it('db.transaction is unavailable, so the migrator must not use it', async () => {
    const { client } = fakeNeonClient();
    await expect(makeDb(client).transaction(async () => {})).rejects.toThrow(/transaction/i);
  });
});

describe('queryRows', () => {
  it('refuses a result with no rows array instead of reading it as "no rows"', async () => {
    // An empty applied-set means "fresh database" to planMigrations, which
    // would then replay the baseline over a live schema.
    for (const result of [undefined, null, [], { rowCount: 0 }, { rows: 'x' }]) {
      const session: MigrateSession = { execute: async () => result };
      await expect(queryRows(session, sql`SELECT 1`)).rejects.toThrow(/no rows array/);
      await expect(readAppliedRows(session)).rejects.toThrow(/no rows array/);
    }
  });
});

describe('readMigrationFiles: what the migrator relies on', () => {
  const migrationsFolder = join(import.meta.dir, '..', 'drizzle');
  const migrations = readMigrationFiles({ migrationsFolder });

  it('reads the tree', () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it('hash is sha256 of the whole file, statements are the raw breakpoint split', () => {
    // Tracking rows store this hash, and backfill evaluates `sql` statement by
    // statement. Neither the layout (`NNNN_x.sql` vs `<ts>_x/migration.sql`)
    // nor the version may change either, or every applied row stops matching.
    for (const m of migrations) {
      const file = m.sql.join('--> statement-breakpoint');
      expect(createHash('sha256').update(file).digest('hex')).toBe(m.hash);
    }
  });

  it('folderMillis is an integer, strictly increasing in apply order', () => {
    for (let i = 0; i < migrations.length; i++) {
      expect(Number.isInteger(migrations[i]!.folderMillis)).toBe(true);
      if (i > 0) expect(migrations[i]!.folderMillis).toBeGreaterThan(migrations[i - 1]!.folderMillis);
    }
  });
});

describe('source guards', () => {
  const root = join(import.meta.dir, '..', '..', '..');
  const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  it('the migrator does not call session.all() (removed in drizzle v1)', () => {
    const offenders = tracked
      .filter((f) => /^packages\/core\/db\/migrate[^/]*\.ts$/.test(f))
      .filter((f) => /\.all\(/.test(readFileSync(join(root, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it("never imports drizzle's stock migrate() or upgradeIfNeeded()", () => {
    // Stock v1 migrate()/upgradeIfNeeded() throw on our append-only tracking
    // table (rows matching no local folder) and apply by name with no legacy
    // map, so a lost row replays its DDL (#1288 class). Our migrator owns
    // planning, the tracking-table upgrade and apply (db/migrate*.ts). The only
    // drizzle migrator export allowed is readMigrationFiles, which the legacy
    // layout still reads until the cutover.
    const offenders: string[] = [];
    for (const f of tracked) {
      if (f.endsWith('migrate-driver-contract.test.ts')) continue;
      const src = readFileSync(join(root, f), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        const stockMigrator = /from\s+['"]drizzle-orm\/[\w-]+\/migrator['"]/.test(line);
        const stockUpgrade = /\bupgradeIfNeeded\s*\(/.test(line) || /import[^;]*\bupgradeIfNeeded\b/.test(line);
        const otherImport = /import\s*\{([^}]*)\}\s*from\s*['"]drizzle-orm\/migrator['"]/.exec(line);
        const disallowed = otherImport?.[1]!.split(',').map((s) => s.trim()).filter((s) => s && s !== 'readMigrationFiles');
        if (stockMigrator || stockUpgrade || (disallowed && disallowed.length > 0)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('CI fetches the release tag the rollback case runs the previous migrator from', () => {
    // A shallow checkout has no tags; bumping ROLLBACK_MIGRATOR_REF without
    // the fetch fails the db-architecture job on `git archive`, not here.
    const testSrc = readFileSync(join(root, 'apps/web/tests/db/migration-layout-v1.test.ts'), 'utf8');
    const ref = /const ROLLBACK_MIGRATOR_REF = '([^']+)'/.exec(testSrc)?.[1];
    expect(ref).toBeDefined();
    const workflow = readFileSync(join(root, '.github/workflows/build.yml'), 'utf8');
    expect(workflow).toContain(`+refs/tags/${ref}:refs/tags/${ref}`);
  });

  it('no neon-http drizzle() is initialised with a positional client', () => {
    // v1 reads drizzle(client) as drizzle(config) and silently connects with
    // a client of its own. Use drizzle({ client, ... }).
    const offenders: string[] = [];
    for (const f of tracked) {
      if (f.includes('/node_modules/') || f.endsWith('migrate-driver-contract.test.ts')) continue;
      const src = readFileSync(join(root, f), 'utf8');
      if (!src.includes("'drizzle-orm/neon-http'")) continue;
      src.split('\n').forEach((line, i) => {
        if (/\bdrizzle\(\s*[^\s{)'"`]/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
