import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkAgainstBase,
  describeCollision,
  findDrizzleKit,
  findIndexCollisions,
  renumberAgainstBase,
  type RepoPaths,
} from '../db/migration-index';

describe('findIndexCollisions', () => {
  const base = ['drizzle/0278_a.sql', 'drizzle/0279_b.sql', 'drizzle/0280_failure_incidents.sql'];

  it('fails a duplicated index, naming the base file and the next free index', () => {
    const [c] = findIndexCollisions(['drizzle/0280_tense_donald_blake.sql'], base);
    expect(c).toEqual({
      file: '0280_tense_donald_blake.sql',
      baseFile: '0280_failure_incidents.sql',
      baseNewest: '0280_failure_incidents.sql',
      nextFreeIndex: 281,
    });
    expect(describeCollision(c)).toBe(
      '0280_tense_donald_blake.sql: index 0280 is already taken on the base by 0280_failure_incidents.sql. Next free index: 0281.',
    );
  });

  it('passes a free index', () => {
    expect(findIndexCollisions(['drizzle/0281_tense_donald_blake.sql'], base)).toEqual([]);
  });

  it('fails an index below the base newest even when that slot is empty', () => {
    const [c] = findIndexCollisions(['0277_x.sql'], ['0276_a.sql', '0280_b.sql']);
    expect(c.baseFile).toBeNull();
    expect(c.nextFreeIndex).toBe(281);
  });

  it('assigns consecutive free indices to several added migrations', () => {
    const got = findIndexCollisions(['0280_x.sql', '0281_y.sql'], base);
    expect(got.map((c) => c.nextFreeIndex)).toEqual([281]);
    const both = findIndexCollisions(['0279_x.sql', '0280_y.sql'], base);
    expect(both.map((c) => c.nextFreeIndex)).toEqual([281, 282]);
  });

  it('ignores non-migration files', () => {
    expect(findIndexCollisions(['meta/0280_snapshot.json', 'meta/_journal.json'], base)).toEqual([]);
  });
});

/**
 * End-to-end against a real git repo and the real (patched) drizzle-kit: two
 * branches fork off `dev` and each run `drizzle-kit generate` in parallel, so
 * both mint 0001 — drizzle-kit has no way not to. The check must fail the one
 * that lands second, and `renumber` must move it to 0002 by regenerating.
 */
describe('parallel branches against a real drizzle repo', () => {
  const repoRoot = resolve(import.meta.dir, '../../..');
  let dir: string;
  let paths: RepoPaths;
  const pkg = () => join(dir, 'pkg');
  const drizzle = () => join(dir, 'pkg', 'drizzle');

  const sh = (cmd: string, args: string[], cwd = dir, allowFail = false) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    return r;
  };
  const generate = (...extra: string[]) => sh(findDrizzleKit(pkg()), ['generate', ...extra], pkg());
  const commitAll = (msg: string) => {
    sh('git', ['add', '-A']);
    sh('git', ['commit', '-q', '-m', msg]);
  };
  const sqlFiles = () => readdirSync(drizzle()).filter((f) => f.endsWith('.sql')).sort();
  const journal = () =>
    (JSON.parse(readFileSync(join(drizzle(), 'meta/_journal.json'), 'utf8')).entries as { idx: number; tag: string; when: number }[]);
  const GIT_ENV = {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    // renumberAgainstBase shells out to git with process.env.
    for (const [k, v] of Object.entries(GIT_ENV)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    dir = mkdtempSync(join(tmpdir(), 'migration-index-'));
    // packages/core's own install: drizzle-kit and drizzle-orm live there, not at the root.
    symlinkSync(join(repoRoot, 'packages/core/node_modules'), join(dir, 'node_modules'));
    mkdirSync(join(dir, 'pkg', 'schema'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(dir, 'pkg', 'drizzle.config.ts'),
      `import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ schema: './schema', out: './drizzle', dialect: 'postgresql' });\n`,
    );
    writeFileSync(
      join(dir, 'pkg', 'schema', 'a.ts'),
      `import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const a = pgTable('a', { id: text('id').primaryKey() });\n`,
    );
    sh('git', ['init', '-q', '-b', 'dev']);
    generate('--name=init');
    commitAll('base');
    paths = { root: dir, drizzleDir: 'pkg/drizzle' };
  }, 60_000);

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('two branches mint the same index; the check fails the second; renumber gives it the next free one', () => {
    // Branch X: add a column to a.
    sh('git', ['checkout', '-q', '-b', 'feat-x', 'dev']);
    writeFileSync(
      join(pkg(), 'schema', 'a.ts'),
      `import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const a = pgTable('a', { id: text('id').primaryKey(), x: text('x') });\n`,
    );
    generate('--name=add_x');
    commitAll('x');

    // Branch Y, forked off the same dev: add a table.
    sh('git', ['checkout', '-q', '-b', 'feat-y', 'dev']);
    writeFileSync(
      join(pkg(), 'schema', 'y.ts'),
      `import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const y = pgTable('y', { id: text('id').primaryKey() });\n`,
    );
    generate('--name=add_y');
    commitAll('y');
    expect(sqlFiles()).toEqual(['0000_init.sql', '0001_add_y.sql']);

    // Both are clean against dev while neither has landed.
    sh('git', ['checkout', '-q', 'feat-x']);
    expect(checkAgainstBase(paths, 'dev')).toEqual([]);

    // X lands first.
    sh('git', ['checkout', '-q', 'dev']);
    sh('git', ['merge', '-q', '--ff-only', 'feat-x']);

    // Y now collides: same 0001 as dev's 0001_add_x.
    sh('git', ['checkout', '-q', 'feat-y']);
    const collisions = checkAgainstBase(paths, 'dev');
    expect(collisions.map(describeCollision)).toEqual([
      '0001_add_y.sql: index 0001 is already taken on the base by 0001_add_x.sql. Next free index: 0002.',
    ]);

    // The CLI fails the same way (this is what CI runs).
    const cli = sh('bun', [join(repoRoot, 'packages/core/db/migration-index.ts'), 'check', '--base=dev', '--drizzle-dir=pkg/drizzle'], dir, true);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('0001_add_y.sql: index 0001 is already taken on the base by 0001_add_x.sql. Next free index: 0002.');

    // Renumber refuses until dev is merged in.
    expect(() => renumberAgainstBase(paths, 'dev')).toThrow(/git merge dev/);

    // Merging dev in conflicts only on drizzle metadata (journal + 0001_snapshot.json).
    const merge = sh('git', ['merge', '-q', 'dev'], dir, true);
    expect(merge.status).not.toBe(0);

    const r = renumberAgainstBase(paths, 'dev');
    expect(r.removed).toEqual(['0001_add_y.sql']);
    expect(r.generated).toEqual(['0002_add_y.sql']);
    expect(r.sqlChanged).toBe(false);
    sh('git', ['commit', '-q', '--no-edit']);

    expect(sqlFiles()).toEqual(['0000_init.sql', '0001_add_x.sql', '0002_add_y.sql']);
    const entries = journal();
    expect(entries.map((e) => e.idx)).toEqual([0, 1, 2]);
    expect(entries[2].when).toBeGreaterThan(entries[1].when);
    // The new snapshot carries both sides: dev's column and this branch's table.
    const snap = JSON.parse(readFileSync(join(drizzle(), 'meta/0002_snapshot.json'), 'utf8'));
    expect(Object.keys(snap.tables).sort()).toEqual(['public.a', 'public.y']);
    expect(Object.keys(snap.tables['public.a'].columns)).toContain('x');
    expect(readFileSync(join(drizzle(), '0002_add_y.sql'), 'utf8')).toContain('CREATE TABLE "y"');

    // And it now passes, with nothing left for drizzle-kit to generate.
    expect(checkAgainstBase(paths, 'dev')).toEqual([]);
    expect(generate().stdout).toContain('No schema changes');
  }, 120_000);

  it('carries a hand-written (--custom) migration to the next free index verbatim', () => {
    // dev is at 0001_add_x; feat-y (0002_add_y) has not landed yet.
    sh('git', ['checkout', '-q', '-b', 'feat-z', 'dev']);
    generate('--custom', '--name=backfill');
    const body = `UPDATE "a" SET "x" = 'seed' WHERE "x" IS NULL;`;
    writeFileSync(join(drizzle(), '0002_backfill.sql'), body);
    commitAll('z');

    sh('git', ['checkout', '-q', 'dev']);
    sh('git', ['merge', '-q', '--ff-only', 'feat-y']);
    sh('git', ['checkout', '-q', 'feat-z']);
    expect(checkAgainstBase(paths, 'dev').map((c) => c.nextFreeIndex)).toEqual([3]);

    sh('git', ['merge', '-q', 'dev'], dir, true);
    const r = renumberAgainstBase(paths, 'dev');
    expect(r.generated).toEqual(['0003_backfill.sql']);
    sh('git', ['commit', '-q', '--no-edit']);
    expect(readFileSync(join(drizzle(), '0003_backfill.sql'), 'utf8')).toBe(body);
    expect(journal().map((e) => e.tag)).toEqual(['0000_init', '0001_add_x', '0002_add_y', '0003_backfill']);
    expect(checkAgainstBase(paths, 'dev')).toEqual([]);
  }, 120_000);
  it('steps past an open PR that holds the next slot, then converges once that PR lands', () => {
    // dev is at 0002_add_y (feat-z never landed). Two open PRs both mint 0003.
    sh('git', ['checkout', '-q', '-b', 'feat-other', 'dev']);
    writeFileSync(join(pkg(), 'schema', 'o.ts'), `import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const o = pgTable('o', { id: text('id').primaryKey() });\n`);
    generate('--name=add_o');
    commitAll('other');
    sh('git', ['checkout', '-q', '-b', 'feat-w', 'dev']);
    writeFileSync(join(pkg(), 'schema', 'w.ts'), `import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const w = pgTable('w', { id: text('id').primaryKey() });\n`);
    generate('--name=add_w');
    commitAll('w');
    expect(sqlFiles().at(-1)).toBe('0003_add_w.sql');

    // The landing gate names feat-other's 0003; dev alone cannot see it.
    expect(checkAgainstBase(paths, 'dev')).toEqual([]);
    const r = renumberAgainstBase(paths, 'dev', { minIndex: 4 });
    expect(r.generated).toEqual(['0004_add_w.sql']);
    sh('git', ['commit', '-q', '-m', 'renumber past open PR']);
    expect(journal().map((e) => `${e.idx}:${e.tag}`).slice(-2)).toEqual(['2:0002_add_y', '4:0004_add_w']);
    expect(generate().stdout).toContain('No schema changes');

    // feat-other lands; feat-w merges dev (journal conflicts) and renumbers once more.
    sh('git', ['checkout', '-q', 'dev']);
    sh('git', ['merge', '-q', '--ff-only', 'feat-other']);
    sh('git', ['checkout', '-q', 'feat-w']);
    sh('git', ['merge', '-q', 'dev'], dir, true);
    const again = renumberAgainstBase(paths, 'dev');
    expect(again.generated).toEqual(['0004_add_w.sql']);
    sh('git', ['commit', '-q', '--no-edit']);
    expect(journal().map((e) => e.idx)).toEqual([0, 1, 2, 3, 4]);
    expect(checkAgainstBase(paths, 'dev')).toEqual([]);
    expect(generate().stdout).toContain('No schema changes');
  }, 120_000);
});
