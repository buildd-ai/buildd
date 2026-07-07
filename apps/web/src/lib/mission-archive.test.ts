import { describe, expect, it } from 'bun:test';
import { selectMissionsToArchive, type ArchiveCandidate } from './mission-archive';

const NOW = new Date('2026-07-05T12:00:00Z');
const HOURS = 60 * 60 * 1000;

function candidate(overrides: Partial<ArchiveCandidate> = {}): ArchiveCandidate {
  return {
    id: 'm1',
    status: 'active',
    updatedAt: new Date(NOW.getTime() - 30 * HOURS),
    scheduleEnabled: null,
    tasks: [
      { status: 'completed', updatedAt: new Date(NOW.getTime() - 30 * HOURS) },
      { status: 'completed', updatedAt: new Date(NOW.getTime() - 26 * HOURS) },
    ],
    ...overrides,
  };
}

describe('selectMissionsToArchive', () => {
  it('archives an active, all-tasks-completed mission quiet for >24h', () => {
    expect(selectMissionsToArchive([candidate()], NOW)).toEqual(['m1']);
  });

  it('skips missions with recent task activity (<24h)', () => {
    const c = candidate({
      tasks: [
        { status: 'completed', updatedAt: new Date(NOW.getTime() - 30 * HOURS) },
        { status: 'completed', updatedAt: new Date(NOW.getTime() - 2 * HOURS) },
      ],
    });
    expect(selectMissionsToArchive([c], NOW)).toEqual([]);
  });

  it('skips missions whose own row was touched recently', () => {
    const c = candidate({ updatedAt: new Date(NOW.getTime() - 1 * HOURS) });
    expect(selectMissionsToArchive([c], NOW)).toEqual([]);
  });

  it('skips missions with any non-completed task (failed/pending/running)', () => {
    for (const status of ['failed', 'pending', 'running']) {
      const c = candidate({
        tasks: [
          { status: 'completed', updatedAt: new Date(NOW.getTime() - 30 * HOURS) },
          { status, updatedAt: new Date(NOW.getTime() - 30 * HOURS) },
        ],
      });
      expect(selectMissionsToArchive([c], NOW)).toEqual([]);
    }
  });

  it('skips missions with no tasks', () => {
    expect(selectMissionsToArchive([candidate({ tasks: [] })], NOW)).toEqual([]);
  });

  it('skips paused and completed missions (deliberate states)', () => {
    expect(selectMissionsToArchive([candidate({ status: 'paused' })], NOW)).toEqual([]);
    expect(selectMissionsToArchive([candidate({ status: 'completed' })], NOW)).toEqual([]);
  });

  it('skips missions with an enabled schedule (they will run again)', () => {
    expect(selectMissionsToArchive([candidate({ scheduleEnabled: true })], NOW)).toEqual([]);
    // Disabled schedule does not block archiving
    expect(selectMissionsToArchive([candidate({ scheduleEnabled: false })], NOW)).toEqual(['m1']);
  });
});
