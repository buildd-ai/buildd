/**
 * AC-11 (docs/design/mission-feed-mobile-continuity.md): every link into a
 * mission-owned task goes through `missionTaskHref` / `taskPageHref`
 * (lib/mission-task-href.ts), and nothing emits the retired `?tab=tasks`.
 *
 * A hand-built `/app/tasks/${…}` in one of these files is how a link skipped
 * the mission and landed on a bare task page with no way back to its place.
 * Slices that route further call sites (the task sheet, the task page) add
 * their files to CALL_SITES.
 */
import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');

const CALL_SITES = [
  'lib/action-card-context.ts',
  'lib/mission-card-view.ts',
  'components/TaskCard.tsx',
  'components/NeedsInputBanner.tsx',
  'components/NeedsInputProvider.tsx',
  'components/WaitingOnYouMergeCard.tsx',
  'components/WaitingOnYouReviewCard.tsx',
  'components/AgentHandledCard.tsx',
  'components/MissionProgressBar.tsx',
  'components/MissionProgress.tsx',
  'components/FlightDetailSheet.tsx',
  'components/missions/MissionCard.tsx',
  'app/app/(protected)/home/page.tsx',
  'app/app/(protected)/home/HomeMissions.tsx',
  'app/app/(protected)/missions/MissionGrid.tsx',
  'app/app/(protected)/missions/page.tsx',
  'app/app/(protected)/tasks/[id]/page.tsx',
  'app/app/(protected)/tasks/[id]/respond/page.tsx',
  'app/app/(protected)/tasks/[id]/respond/RespondForm.tsx',
];

const HAND_BUILT_TASK_LINK = /`\/app\/tasks\/\$\{/;

describe('AC-11: mission task links go through the helper', () => {
  for (const rel of CALL_SITES) {
    it(`${rel} builds no /app/tasks/\${…} link by hand`, async () => {
      const source = await Bun.file(join(SRC, rel)).text();
      const offending = source.split('\n').filter(line => HAND_BUILT_TASK_LINK.test(line));
      expect(offending).toEqual([]);
    });
  }

  it('the helper itself is where the task path is spelled', async () => {
    const source = await Bun.file(join(SRC, 'lib/mission-task-href.ts')).text();
    expect(HAND_BUILT_TASK_LINK.test(source)).toBe(true);
  });

  it('nothing under apps/web/src emits the retired ?tab=tasks', async () => {
    const hits: string[] = [];
    for await (const rel of new Glob('**/*.{ts,tsx}').scan({ cwd: SRC })) {
      if (rel.endsWith('mission-task-href-callsites.test.ts')) continue;
      const text = await Bun.file(join(SRC, rel)).text();
      if (text.includes('tab=tasks')) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });
});
