import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockGithubApi = mock((_installationId: number, _path: string, _options?: RequestInit): Promise<unknown> => Promise.resolve([]));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

import { inspectPullRequestMigrations } from './migration-inspector';
import { clearLeafCache, snapshotEntityKey } from './mission-schema-overlap';

const DIR = 'packages/core/drizzle';
const TRUNK_FOLDER = '20261020000000_trunk_leaf';
const B_FOLDER = '20261025000000_serial_lanes';
const PR_FOLDER = '20261027000000_serial_lanes_again';

const table = (name: string) => ({ entityType: 'tables', schema: 'public', name, isRlsEnabled: false });
const column = (t: string, name: string) => ({ entityType: 'columns', schema: 'public', table: t, name, type: 'uuid' });
const TRUNK_DDL = [table('tasks'), column('tasks', 'id')];
const T_DDL = [table('t'), column('t', 'id')];

const snapshot = (id: string, prev: string, ddl: unknown[]) =>
  JSON.stringify({ version: '8', dialect: 'postgres', id, prevIds: [prev], ddl, renames: [] });

type Tree = Record<string, string>;
const trunkTree = (ddl: unknown[] = TRUNK_DDL): Tree => ({
  [`${DIR}/${TRUNK_FOLDER}/migration.sql`]: 'CREATE TABLE "tasks" ("id" uuid);',
  [`${DIR}/${TRUNK_FOLDER}/snapshot.json`]: snapshot('trunk', 'root', ddl),
});
const withFolder = (tree: Tree, folder: string, sql: string, id: string, prev: string, ddl: unknown[]): Tree => ({
  ...tree,
  [`${DIR}/${folder}/migration.sql`]: sql,
  [`${DIR}/${folder}/snapshot.json`]: snapshot(id, prev, ddl),
});

const SQL_T = 'CREATE TABLE "t" ("id" uuid);';

/**
 * Two missions, A and B, in one repo. PR #42 is a task PR into A's branch whose
 * head adds table `t`; `bTree` is what B's integration branch holds.
 */
function github(opts: { trunk: Tree; aBase: Tree; bTree: Tree }) {
  const head = withFolder(opts.aBase, PR_FOLDER, SQL_T, 'pr', 'trunk', [...TRUNK_DDL, ...T_DDL]);
  const trees: Record<string, Tree> = { 'trunk-sha': opts.trunk, 'a-sha': opts.aBase, 'b-sha': opts.bTree, abc123: head };
  const shaOf: Record<string, string> = { dev: 'trunk-sha', 'mission/a-aaaaaaaa': 'a-sha', 'mission/b-bbbbbbbb': 'b-sha' };
  mockGithubApi.mockImplementation(async (_i, url) => {
    if (url.includes('/pulls/42/files')) {
      return [
        { filename: `${DIR}/${PR_FOLDER}/migration.sql`, status: 'added' },
        { filename: `${DIR}/${PR_FOLDER}/snapshot.json`, status: 'added' },
      ];
    }
    if (url.endsWith('/pulls/42')) return { number: 42, base: { ref: 'mission/a-aaaaaaaa' }, head: { ref: 'buildd/12345678-task' } };
    if (url.endsWith('/repos/acme/app')) return { default_branch: 'dev' };
    const ref = /\/git\/ref\/heads\/(.+)$/.exec(url);
    if (ref) return { object: { sha: shaOf[decodeURIComponent(ref[1])] } };
    if (url.includes('/pulls?')) return [{ number: 42 }];
    if (url.includes('/commits?sha=b-sha')) return [{ sha: 'land-commit' }];
    if (url.endsWith('/commits/land-commit/pulls')) return [{ number: 77, head: { ref: 'buildd/cafebabe-add-serial-lanes' } }];
    const contents = /\/contents\/(.+)\?ref=(.+)$/.exec(url);
    if (contents) {
      const path = decodeURIComponent(contents[1]);
      const tree = trees[decodeURIComponent(contents[2])];
      if (!tree) throw new Error('Not Found');
      if (path === DIR) {
        const folders = [...new Set(Object.keys(tree).map((p) => p.slice(DIR.length + 1).split('/')[0]))];
        return folders.map((name) => ({ name, type: 'dir' }));
      }
      const body = tree[path];
      if (body === undefined) throw new Error('Not Found');
      return { encoding: 'base64', content: Buffer.from(body).toString('base64') };
    }
    throw new Error(`unexpected GitHub call ${url}`);
  });
}

const MISSIONS = [
  { missionId: 'mission-a', title: 'Mission A', branch: 'mission/a-aaaaaaaa' },
  { missionId: 'mission-b', title: 'Serial lanes', branch: 'mission/b-bbbbbbbb' },
];

const inspect = (missions = MISSIONS) =>
  inspectPullRequestMigrations({
    installationId: 1,
    repoFullName: 'acme/app',
    prNumber: 42,
    headSha: 'abc123',
    files: [],
    baseRef: 'mission/a-aaaaaaaa',
    trunkRef: 'dev',
    missionBranches: async () => missions,
  });

beforeEach(() => {
  mockGithubApi.mockReset();
  clearLeafCache();
});

describe('inspectPullRequestMigrations — a schema object another open mission already carries', () => {
  it('holds a PR into mission A that adds a table mission B adds over trunk, naming B, its branch and the task', async () => {
    const trunk = trunkTree();
    github({
      trunk,
      aBase: trunk,
      bTree: withFolder(trunk, B_FOLDER, SQL_T, 'b', 'trunk', [...TRUNK_DDL, ...T_DDL]),
    });
    const result = await inspect();
    expect(result.safe).toBe(true);
    if (!result.safe) throw new Error('unreachable');
    expect(result.hold).toMatchObject({
      missionId: 'mission-b',
      branch: 'mission/b-bbbbbbbb',
      entities: ['table "t"'],
      landedBy: { prNumber: 77, taskShortId: 'cafebabe' },
    });
    expect(result.hold!.reason.startsWith('shared schema hold:')).toBe(true);
    expect(result.hold!.reason).toContain('mission "Serial lanes"');
    expect(result.hold!.reason).toContain('mission/b-bbbbbbbb');
    expect(result.hold!.reason).toContain('task cafebabe');
    expect(result.hold!.reason).toContain('bun run migrations:regenerate --base=origin/dev');
  });

  it('does not hold the same PR once mission B merged to trunk', async () => {
    const merged = withFolder(trunkTree(), B_FOLDER, SQL_T, 'b', 'trunk', [...TRUNK_DDL, ...T_DDL]);
    github({ trunk: merged, aBase: trunkTree(), bTree: merged });
    const result = await inspect();
    expect(result).toEqual({ safe: true, operationClass: 'EXPAND' });
  });

  it('does not hold when B adds a different table', async () => {
    const trunk = trunkTree();
    github({
      trunk,
      aBase: trunk,
      bTree: withFolder(trunk, B_FOLDER, 'CREATE TABLE "u" ("id" uuid);', 'b', 'trunk', [...TRUNK_DDL, table('u')]),
    });
    expect(await inspect()).toEqual({ safe: true, operationClass: 'EXPAND' });
  });

  it('skips the mission whose branch is the PR base', async () => {
    const trunk = trunkTree();
    github({ trunk, aBase: trunk, bTree: withFolder(trunk, B_FOLDER, SQL_T, 'b', 'trunk', [...TRUNK_DDL, ...T_DDL]) });
    expect(await inspect([MISSIONS[0]!])).toEqual({ safe: true, operationClass: 'EXPAND' });
  });

  it('does not hold when the mission lookup fails', async () => {
    const trunk = trunkTree();
    github({ trunk, aBase: trunk, bTree: withFolder(trunk, B_FOLDER, SQL_T, 'b', 'trunk', [...TRUNK_DDL, ...T_DDL]) });
    const result = await inspectPullRequestMigrations({
      installationId: 1, repoFullName: 'acme/app', prNumber: 42, headSha: 'abc123', files: [],
      baseRef: 'mission/a-aaaaaaaa', trunkRef: 'dev',
      missionBranches: async () => { throw new Error('db down'); },
    });
    expect(result).toEqual({ safe: true, operationClass: 'EXPAND' });
  });
});

describe('snapshotEntityKey', () => {
  it('identifies an entity by type, schema, table and name', () => {
    expect(snapshotEntityKey(column('t', 'id'))).toBe('columns|public|t|id');
    expect(snapshotEntityKey(table('t'))).toBe('tables|public||t');
  });
});
