import { expect, it, mock } from 'bun:test';
let teamMode: unknown = 'repo';
const findTeam = mock(async (_query: unknown) => ({ warmHandover: teamMode }));
mock.module('@buildd/core/db', () => ({ db: { query: { teams: { findFirst: findTeam } } } }));
const { resolveWorkspaceWarmHandover } = await import('./warm-handover-store');
it('reads team policy and applies the workspace override', async () => {
  expect(await resolveWorkspaceWarmHandover({ teamId: 'team-fixture', gitConfig: {} })).toBe('repo');
  expect(await resolveWorkspaceWarmHandover({ teamId: 'team-fixture', gitConfig: { warmHandover: 'off' } })).toBe('off');
  expect(await resolveWorkspaceWarmHandover({ teamId: 'team-fixture', gitConfig: { warmHandover: 'deps' } })).toBe('deps');
  teamMode = 'deps';
  expect(await resolveWorkspaceWarmHandover({ teamId: 'team-fixture', gitConfig: { warmHandover: null } })).toBe('deps');
  expect(findTeam).toHaveBeenCalled();
});
it('missing team defaults to off', async () => {
  expect(await resolveWorkspaceWarmHandover({})).toBe('off');
});
