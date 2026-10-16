import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  baseIsV1,
  findDrizzleKit,
  layoutProblems,
  regenerateAgainstBase,
  runDrizzleCheck,
  type RepoPaths,
} from '../db/migration-layout';
import { V1_FOLDER } from '../db/migrate-tree';

/**
 * Two branches fork off `dev` and each run the real drizzle-kit (the pinned rc)
 * `generate` in parallel. On v1 their folders cannot collide, so git merges them
 * cleanly, but both snapshots name the same parent: the kit's own `check` is the
 * only thing that sees it. `regenerate` then re-diffs the second branch's schema
 * change against the merged base.
 */
describe('parallel branches against a real drizzle repo (drizzle v1 kit)', () => {
  const repoRoot = resolve(import.meta.dir, '../../..');
  let dir: string;
  let paths: RepoPaths;
  const pkg = () => join(dir, 'pkg');
  const drizzle = () => join(dir, 'pkg', 'drizzle');

  const GIT_ENV = {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
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
  const folders = () => readdirSync(drizzle()).filter((f) => V1_FOLDER.test(f)).sort();
  const slugs = () => folders().map((f) => f.replace(/^\d{14}_/, ''));
  const schema = (name: string, cols: string) =>
    writeFileSync(join(pkg(), 'schema', name), `import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const ${name.replace('.ts', '')} = pgTable('${name.replace('.ts', '')}', { id: text('id').primaryKey()${cols} });\n`);
  const cli = (...a: string[]) =>
    sh('bun', [join(repoRoot, 'packages/core/db/migration-layout.ts'), ...a, '--drizzle-dir=pkg/drizzle'], dir, true);
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    // regenerateAgainstBase shells out to git with process.env.
    for (const [k, v] of Object.entries(GIT_ENV)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    dir = mkdtempSync(join(tmpdir(), 'migration-layout-'));
    // packages/core's own install: drizzle-kit and drizzle-orm live there, not at the root.
    symlinkSync(join(repoRoot, 'packages/core/node_modules'), join(dir, 'node_modules'));
    mkdirSync(join(dir, 'pkg', 'schema'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(dir, 'pkg', 'drizzle.config.ts'),
      `import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ schema: './schema', out: './drizzle', dialect: 'postgresql' });\n`,
    );
    schema('a.ts', ", v: text('v')");
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

  it('the kit writes v1 folders, so a base is v1 and a clean tree passes the layout check', () => {
    expect(folders().length).toBe(1);
    expect(baseIsV1(paths, 'dev')).toBe(true);
    expect(layoutProblems(paths, 'dev')).toEqual([]);
    expect(cli('check', '--base=dev').status).toBe(0);
    expect(runDrizzleCheck(pkg()).ok).toBe(true);
  }, 60_000);

  it('commutative branches need no repair: two folders, one parent, and the kit check passes', () => {
    sh('git', ['checkout', '-q', '-b', 'feat-commute-x', 'dev']);
    schema('p.ts', '');
    generate('--name=add_p');
    commitAll('p');
    sh('git', ['checkout', '-q', '-b', 'feat-commute-y', 'dev']);
    schema('q.ts', '');
    generate('--name=add_q');
    commitAll('q');
    sh('git', ['merge', '-q', '--no-edit', 'feat-commute-x']);
    expect(slugs()).toEqual(['init', 'add_p', 'add_q']);
    // Two snapshots share a parent, but the changes do not touch each other.
    expect(cli('commute').status).toBe(0);
    sh('git', ['checkout', '-q', 'dev']);
  }, 120_000);

  it('non-commutative branches: no name collision, the kit check fails the merge, regenerate repairs it', () => {
    // Branch X drops a.v.
    sh('git', ['checkout', '-q', '-b', 'feat-x', 'dev']);
    schema('a.ts', '');
    generate('--name=drop_v');
    commitAll('x');

    // Branch Y, forked off the same dev, makes a.v NOT NULL.
    sh('git', ['checkout', '-q', '-b', 'feat-y', 'dev']);
    writeFileSync(join(pkg(), 'schema', 'a.ts'), `import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const a = pgTable('a', { id: text('id').primaryKey(), v: text('v').notNull() });\n`);
    generate('--name=v_not_null');
    commitAll('y');
    expect(slugs()).toEqual(['init', 'v_not_null']);
    expect(cli('commute').status).toBe(0);

    // X lands first.
    sh('git', ['checkout', '-q', 'dev']);
    sh('git', ['merge', '-q', '--ff-only', 'feat-x']);

    // Y merges dev: the schema file conflicts (a person settles that), the
    // drizzle dir does not: different folders. That is the trap.
    sh('git', ['checkout', '-q', 'feat-y']);
    expect(sh('git', ['merge', '-q', '--no-edit', 'dev'], dir, true).status).not.toBe(0);
    sh('git', ['checkout', '--ours', '--', 'pkg/schema/a.ts']);
    sh('git', ['add', 'pkg/schema/a.ts']);
    sh('git', ['commit', '-q', '--no-edit']);
    expect(slugs()).toEqual(['init', 'drop_v', 'v_not_null']);
    expect(layoutProblems(paths, 'dev')).toEqual([]);

    // Two snapshots name the same parent and the changes do not commute.
    const commute = cli('commute', '--base=dev');
    expect(commute.status).toBe(1);
    expect(commute.stderr).toContain('do not commute');

    // Regenerate: reset to dev, re-diff Y's schema change against dev's newest snapshot.
    const r = regenerateAgainstBase(paths, 'dev');
    expect(r.removed.map((n) => n.replace(/^\d{14}_/, ''))).toEqual(['v_not_null']);
    expect(r.generated.map((n) => n.replace(/^\d{14}_/, ''))).toEqual(['v_not_null']);
    // The SQL had to change: dev dropped the column, so Y's change is now an add.
    expect(r.sqlChanged).toBe(true);
    sh('git', ['commit', '-q', '-m', 'regenerate']);

    expect(slugs()).toEqual(['init', 'drop_v', 'v_not_null']);
    expect(cli('commute').status).toBe(0);
    const folder = folders().find((f) => f.endsWith('_v_not_null'))!;
    expect(readFileSync(join(drizzle(), folder, 'migration.sql'), 'utf8')).toMatch(/ADD COLUMN "v"/);
    // And nothing is left for the kit to generate.
    expect(generate().stdout).toContain('No schema changes');
  }, 180_000);

  it('regenerate carries a hand-written (--custom) migration verbatim', () => {
    sh('git', ['checkout', '-q', '-b', 'feat-data', 'dev']);
    generate('--custom', '--name=backfill_x');
    const folder = folders().find((f) => f.endsWith('_backfill_x'))!;
    writeFileSync(join(drizzle(), folder, 'migration.sql'), "UPDATE a SET id = id WHERE id = 'never';\n");
    commitAll('data');

    // dev moves: another migration lands.
    sh('git', ['checkout', '-q', 'dev']);
    schema('b.ts', '');
    generate('--name=add_b');
    commitAll('b');
    sh('git', ['checkout', '-q', 'feat-data']);
    sh('git', ['merge', '-q', '--no-edit', 'dev']);

    const r = regenerateAgainstBase(paths, 'dev');
    expect(r.removed.map((n) => n.replace(/^\d{14}_/, ''))).toEqual(['backfill_x']);
    expect(r.generated.map((n) => n.replace(/^\d{14}_/, ''))).toEqual(['backfill_x']);
    const fresh = folders().find((f) => f.endsWith('_backfill_x'))!;
    expect(readFileSync(join(drizzle(), fresh, 'migration.sql'), 'utf8')).toBe("UPDATE a SET id = id WHERE id = 'never';\n");
    expect(cli('commute').status).toBe(0);
  }, 180_000);

  it('regenerate refuses until dev is merged in, and a base with no folders', () => {
    sh('git', ['checkout', '-q', '-b', 'feat-unmerged', 'dev']);
    schema('c.ts', '');
    generate('--name=add_c');
    commitAll('c');
    sh('git', ['checkout', '-q', 'dev']);
    schema('d.ts', '');
    generate('--name=add_d');
    commitAll('d');
    sh('git', ['checkout', '-q', 'feat-unmerged']);
    expect(() => regenerateAgainstBase(paths, 'dev')).toThrow(/git merge dev/);
    // A base that was never on v1 has nothing to regenerate against.
    sh('git', ['checkout', '-q', '-b', 'no-folders', 'feat-unmerged']);
    sh('git', ['rm', '-q', '-r', 'pkg/drizzle']);
    commitAll('no migrations');
    sh('git', ['checkout', '-q', 'feat-unmerged']);
    expect(() => regenerateAgainstBase(paths, 'no-folders')).toThrow(/no drizzle v1 migration folders/);
  }, 180_000);
});

/**
 * The fail-closed layout check `migrations:layout-check` runs. On a drizzle v1
 * tree names cannot collide; what can go wrong is a legacy-layout file landing
 * next to (or instead of) v1 folders, which drizzle v1 never reads, so its DDL
 * never runs and the deploy stays green. That is refused here, in CI, before it
 * can merge.
 */
describe('layout check (drizzle v1 folders)', () => {
  let dir: string;
  const paths = (): RepoPaths => ({ root: dir, drizzleDir: 'pkg/drizzle' });
  const drizzle = () => join(dir, 'pkg', 'drizzle');
  const GIT_ENV = {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const folder = (name: string, snapshot = true) => {
    mkdirSync(join(drizzle(), name), { recursive: true });
    writeFileSync(join(drizzle(), name, 'migration.sql'), 'SELECT 1;');
    if (snapshot) writeFileSync(join(drizzle(), name, 'snapshot.json'), '{}');
  };
  const legacyTree = () => {
    mkdirSync(join(drizzle(), 'meta'), { recursive: true });
    writeFileSync(join(drizzle(), '0000_init.sql'), 'SELECT 1;');
    writeFileSync(join(drizzle(), 'meta', '_journal.json'), '{"entries":[]}');
  };

  function repo(base: 'v1' | 'legacy') {
    dir = mkdtempSync(join(tmpdir(), 'migration-layout-'));
    git('init', '-q', '-b', 'dev');
    if (base === 'v1') folder('20260101000000_init');
    else legacyTree();
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feat');
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a clean v1 tree over a v1 base passes', () => {
    repo('v1');
    folder('20260102000000_add_x');
    expect(layoutProblems(paths(), 'dev')).toEqual([]);
  });

  it('refuses a legacy .sql merged in next to v1 folders', () => {
    repo('v1');
    writeFileSync(join(drizzle(), '0261_late_branch.sql'), 'ALTER TABLE t ADD COLUMN c text;');
    expect(layoutProblems(paths(), 'dev').join('\n')).toMatch(/0261_late_branch\.sql/);
  });

  it('refuses a v1 folder without its snapshot (the next generate could not diff)', () => {
    repo('v1');
    folder('20260102000000_add_x', false);
    expect(layoutProblems(paths(), 'dev')).toEqual(['20260102000000_add_x: missing snapshot.json']);
  });

  it('refuses a legacy tree over a v1 base (a pre-cutover branch, or an old kit on a v1 checkout)', () => {
    repo('v1');
    git('rm', '-q', '-r', 'pkg/drizzle');
    legacyTree();
    const problems = layoutProblems(paths(), 'dev').join('\n');
    expect(problems).toMatch(/legacy journal layout/);
    expect(problems).toMatch(/\(dev does\)/);
    expect(problems).toContain('migrations:regenerate');
  });

  it('refuses a legacy tree even over a legacy base: this repo is on v1, so nothing numbered is read', () => {
    repo('legacy');
    writeFileSync(join(drizzle(), '0001_next.sql'), 'SELECT 1;');
    expect(layoutProblems(paths(), 'dev').join('\n')).toMatch(/legacy journal layout/);
  });
});
