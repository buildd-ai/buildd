/**
 * The global needs-input banner links into mission context
 * (docs/design/mission-feed-mobile-continuity.md, "Interaction, URL and
 * scroll model"). Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { needsInputTaskHref } from './NeedsInputBanner';

describe('needsInputTaskHref', () => {
  it('opens a mission task as the sheet over its mission', () => {
    expect(needsInputTaskHref({ id: 'task-1', missionId: 'mission-1' })).toBe('/app/missions/mission-1?task=task-1');
  });

  it('opens a task with no mission on its own page', () => {
    expect(needsInputTaskHref({ id: 'task-1', missionId: null })).toBe('/app/tasks/task-1');
    expect(needsInputTaskHref({ id: 'task-1' })).toBe('/app/tasks/task-1');
  });
});
