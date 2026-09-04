import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockArchiveStaleDoneMissions = mock(() => Promise.resolve([] as string[]));

mock.module('@/lib/mission-archive', () => ({
  archiveStaleDoneMissions: mockArchiveStaleDoneMissions,
}));

import { runMissionArchive } from './archive-missions';

const NOW = new Date('2026-03-01T12:00:00Z');

/**
 * Behavioural contract (prose):
 *   - Passes the cron tick's `now` straight through (the archive TTL is
 *     measured against it, so a different clock changes what gets archived).
 *   - Returns the archived mission ids on success.
 *   - On failure returns `{ error }` instead of throwing: the cron tick must
 *     still return 200 with the scheduling counters it already accumulated,
 *     and the error has to be visible in the response body rather than
 *     swallowed into silence.
 */
describe('runMissionArchive', () => {
  beforeEach(() => {
    mockArchiveStaleDoneMissions.mockReset();
    mockArchiveStaleDoneMissions.mockResolvedValue([]);
  });

  it('returns the archived mission ids', async () => {
    mockArchiveStaleDoneMissions.mockResolvedValue(['mission-1', 'mission-2']);
    expect(await runMissionArchive(NOW)).toEqual(['mission-1', 'mission-2']);
  });

  it('passes the cron tick timestamp through to the archiver', async () => {
    await runMissionArchive(NOW);
    expect(mockArchiveStaleDoneMissions).toHaveBeenCalledWith(NOW);
  });

  it('returns { error } instead of throwing when the archive fails', async () => {
    mockArchiveStaleDoneMissions.mockImplementation(() => {
      throw new Error('neon HTTP blip');
    });
    expect(await runMissionArchive(NOW)).toEqual({ error: 'neon HTTP blip' });
  });

  it('stringifies a non-Error rejection', async () => {
    mockArchiveStaleDoneMissions.mockImplementation(() => Promise.reject('plain string'));
    expect(await runMissionArchive(NOW)).toEqual({ error: 'plain string' });
  });
});
