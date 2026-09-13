import { describe, test, expect } from 'bun:test';
import {
  buildTier3ScheduleParams,
  TIER3_DEFAULT_CRON,
  TIER3_DEFAULT_TIMEZONE,
} from '../spec-conformance-schedule';

describe('buildTier3ScheduleParams', () => {
  test('defaults to buildd-shaped roots and the original weekly cadence when no options given', () => {
    const params = buildTier3ScheduleParams();
    expect(params.name).toBe('weekly-spec-status-drift');
    expect(params.cronExpression).toBe(TIER3_DEFAULT_CRON);
    expect(params.timezone).toBe(TIER3_DEFAULT_TIMEZONE);
    expect(params.title).toBe('Weekly spec status drift check');
    expect(params.description).toContain('docs/specs/**');
    expect(params.description).toContain('docs/design/**');
  });

  test('interpolates a workspace-supplied specsRoot/designRoot into the task description', () => {
    const params = buildTier3ScheduleParams({ specsRoot: 'spec', designRoot: 'design' });
    expect(params.description).toContain('spec/**');
    expect(params.description).toContain('design/**');
    expect(params.description).not.toContain('docs/specs/**');
  });

  test('allows overriding cadence independently of doc roots', () => {
    const params = buildTier3ScheduleParams({ cronExpression: '0 0 * * 0', timezone: 'America/New_York' });
    expect(params.cronExpression).toBe('0 0 * * 0');
    expect(params.timezone).toBe('America/New_York');
    // Name/title stay stable so re-running init on the same workspace doesn't
    // silently mint a second schedule under a different name.
    expect(params.name).toBe('weekly-spec-status-drift');
  });

  test('never mentions blocking behavior — the Tier-3 cron is advisory only', () => {
    const params = buildTier3ScheduleParams();
    expect(params.description.toLowerCase()).toContain('does not block');
  });
});
