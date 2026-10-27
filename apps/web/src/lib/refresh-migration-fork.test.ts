import { describe, it, expect, mock } from 'bun:test';

mock.module('@/lib/github', () => ({ githubApi: () => Promise.resolve(null) }));

const { drizzleDirsTouched, forkOf } = await import('./refresh-migration-fork');

describe('drizzleDirsTouched', () => {
  it('names each dir a v1 migration folder was added to, from either of its files', () => {
    expect(drizzleDirsTouched([
      { filename: 'packages/core/drizzle/20261002000000_a/migration.sql', status: 'added' },
      { filename: 'packages/core/drizzle/20261002000000_a/snapshot.json', status: 'added' },
      { filename: 'db/migrations/20261003000000_b/snapshot.json', status: 'modified' },
      { filename: 'packages/core/db/schema.ts', status: 'modified' },
    ])).toEqual(['db/migrations', 'packages/core/drizzle']);
  });

  it('ignores removals, non-folder names and a legacy numbered .sql', () => {
    expect(drizzleDirsTouched([
      { filename: 'packages/core/drizzle/20261002000000_a/migration.sql', status: 'removed' },
      { filename: 'packages/core/drizzle/0042_old.sql', status: 'added' },
      { filename: 'packages/core/drizzle/notes/migration.sql', status: 'added' },
      { filename: 'migration.sql', status: 'added' },
    ])).toEqual([]);
  });
});

describe('forkOf', () => {
  const base = ['20261001000000_base'];

  it('both sides added a folder: a fork, listing each side\'s own', () => {
    expect(forkOf('d', [...base, '20261002000000_a'], [...base, '20261003000000_b'])).toEqual({
      drizzleDir: 'd', missionOnly: ['20261002000000_a'], trunkOnly: ['20261003000000_b'],
    });
  });

  it('one side added, or the mission already regenerated on top of trunk: no fork', () => {
    expect(forkOf('d', [...base, '20261002000000_a'], base)).toBeNull();
    expect(forkOf('d', base, [...base, '20261003000000_b'])).toBeNull();
    expect(forkOf('d', [...base, '20261003000000_b', '20261004000000_a'], [...base, '20261003000000_b'])).toBeNull();
  });
});
