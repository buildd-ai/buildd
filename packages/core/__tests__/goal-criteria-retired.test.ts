import { describe, it, expect } from 'bun:test';
import {
  HAND_WRITTEN_CRITERION_TYPES,
  handWrittenCriteriaRefusal,
} from '../mission-helpers';
import type { GoalCriterion, LivingSpecGoalCriterion } from '@buildd/shared';

// Living Specs D-44: hand-written goal criteria retire. A mission that holds
// none may not start; one that already holds them keeps them until it
// completes. Nothing is migrated.

const spec: LivingSpecGoalCriterion = {
  type: 'living_spec',
  specId: '11111111-1111-4111-8111-111111111111',
  specRevisionId: '22222222-2222-4222-8222-222222222222',
  revision: 3,
  contentHash: 'a'.repeat(64),
};

const everyHandWritten: GoalCriterion[] = [
  { type: 'command', command: 'bun run check' },
  { type: 'all_prs_merged' },
  { type: 'no_open_tasks' },
  { type: 'artifact_exists', key: 'report' },
  { type: 'metric', query: 'coverage', operator: 'gte', threshold: 80 },
  { type: 'description', description: 'Rows exist', notMechanizableReason: 'needs a person to read the page' },
];

describe('hand-written goal criteria: the retired types', () => {
  it('are every type except the outcome spec', () => {
    expect([...HAND_WRITTEN_CRITERION_TYPES].sort()).toEqual(
      ['all_prs_merged', 'artifact_exists', 'command', 'description', 'metric', 'no_open_tasks'],
    );
  });
});

describe('hand-written goal criteria: a new mission (nothing stored)', () => {
  for (const c of everyHandWritten) {
    it(`refuses ${c.type} and points at selecting a spec`, () => {
      const err = handWrittenCriteriaRefusal(undefined, [c]);
      expect(err).toContain('outcomeSpec');
      expect(err).toContain(`goalCriteria[0]`);
    });
  }

  it('refuses one beside an outcome spec too', () => {
    expect(handWrittenCriteriaRefusal([spec], [spec, { type: 'no_open_tasks' }])).toContain('goalCriteria[1]');
  });

  it('passes an empty list, null, and a list holding only the stored outcome spec', () => {
    expect(handWrittenCriteriaRefusal(null, [])).toBeNull();
    expect(handWrittenCriteriaRefusal(null, null)).toBeNull();
    expect(handWrittenCriteriaRefusal([spec], [spec])).toBeNull();
  });

  it('leaves shape faults to validateGoalCriteria (non-arrays and non-objects pass here)', () => {
    expect(handWrittenCriteriaRefusal(null, { type: 'command' })).toBeNull();
    expect(handWrittenCriteriaRefusal(null, ['command'])).toBeNull();
  });
});

describe('hand-written goal criteria: a mission that already carries them (grandfathered)', () => {
  const stored: GoalCriterion[] = [{ type: 'command', command: 'bun run check' }, spec];

  it('keeps them on a full-list re-save', () => {
    expect(handWrittenCriteriaRefusal(stored, stored)).toBeNull();
  });

  it('may still edit, add or remove them until it completes', () => {
    expect(handWrittenCriteriaRefusal(stored, [{ type: 'command', command: 'bun run check:fixed' }, spec])).toBeNull();
    expect(handWrittenCriteriaRefusal(stored, [...stored, { type: 'all_prs_merged' }])).toBeNull();
    expect(handWrittenCriteriaRefusal(stored, [spec])).toBeNull();
  });

  it('a mission whose only stored criterion is its outcome spec is not grandfathered', () => {
    expect(handWrittenCriteriaRefusal([spec], [spec, { type: 'command', command: 'x' }])).not.toBeNull();
  });
});
