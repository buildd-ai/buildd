import { describe, it, expect, mock } from 'bun:test';

const seeded: string[] = [];
let seedImpl: (teamId: string) => Promise<void> = async () => {};
mock.module('@/lib/default-roles', () => ({
  seedDefaultRolesForTeam: mock((teamId: string) => { seeded.push(teamId); return seedImpl(teamId); }),
}));
mock.module('@buildd/core/report-ops', () => ({ reportOps: mock(async () => {}) }));
mock.module('@/modules', () => ({ SUBSCRIBERS: [] }));

const { emit } = await import('./core-emit');
const { roleSubscribers } = await import('./default-roles-subscribers');

describe('team.created → default roles', () => {
  it('seeds the new team, without the creation waiting on the seed', async () => {
    seeded.length = 0;
    seedImpl = () => new Promise(() => {}); // never settles
    await emit({ type: 'team.created', teamId: 'team-1' }, { subscribers: roleSubscribers });
    expect(seeded).toEqual(['team-1']);
  });

  it('a failed seed is logged, never thrown into the creating request', async () => {
    seedImpl = async () => { throw new Error('boom'); };
    const err = mock(() => {});
    const orig = console.error;
    console.error = err;
    try {
      await emit({ type: 'team.created', teamId: 'team-2' }, { subscribers: roleSubscribers });
      await new Promise(r => setTimeout(r, 0));
    } finally {
      console.error = orig;
    }
    expect(err).toHaveBeenCalledTimes(1);
    expect((err.mock.calls[0] as unknown[])[0]).toBe('Failed to seed default roles for new team:');
  });
});
