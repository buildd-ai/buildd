/** Spec "Skill candidates, usage telemetry and retirement" r1: AC-4 (R-14, R-17). */
import { describe, expect, it } from 'bun:test';
import { archiveSkill, restoreSkill } from '../skill-lifecycle-events';
import { retirementAnchor } from '../skill-retirement-rule';

const DAY = 86_400_000;
const NOW = new Date('2026-11-05T00:00:00Z');

describe('skill lifecycle events', () => {
  it('AC-4: restore writes a restored event, resets the anchor and leaves content unchanged', () => {
    const row = { id: 's1', teamId: 't', enabled: true, content: 'body', contentHash: 'h1' };
    const archived = archiveSkill(row, { mode: 'acting', reason: 'unused 90d', now: NOW });
    expect(archived.skill.enabled).toBe(false);
    expect(archived.event).toMatchObject({ action: 'archived', previousEnabled: true, previousContentHash: 'h1' });

    const later = new Date(NOW.getTime() + 10 * DAY);
    const restored = restoreSkill(archived.skill, { now: later });
    expect(restored.event.action).toBe('restored');
    expect(restored.skill.enabled).toBe(true);
    expect(restored.skill.content).toBe('body');
    expect(restored.skill.contentHash).toBe('h1');

    const anchor = retirementAnchor({
      createdAt: new Date(NOW.getTime() - 300 * DAY), lastClaimedAt: null,
      lastRestoredAt: later, telemetryStartedAt: new Date(NOW.getTime() - 200 * DAY),
    });
    expect(anchor.getTime()).toBe(later.getTime());
  });
});
