import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateGoalCriteria, MECHANICAL_CRITERION_TYPES, MAX_GOAL_CRITERIA } from '@buildd/core/mission-helpers';
import {
  SELECTABLE_CRITERION_TYPES,
  CRITERION_TYPE_OPTIONS,
  NO_CRITERIA_NOTE,
  newCriterionDraft,
  draftToCriterion,
  validateCriteriaDrafts,
} from './goal-criteria-form';

/**
 * U5 — the "Done when…" step on NewMissionForm.
 *
 * The point of these tests is *parity*, not re-statement: every expected error
 * string is computed by calling the server's own `validateGoalCriteria`, so a
 * client-side re-implementation of a rule fails here instead of drifting
 * silently until a user meets the 400.
 */

describe('SELECTABLE_CRITERION_TYPES — mechanical first, server-rejected types absent', () => {
  it('opens with exactly the mechanical types, in the shared constant order', () => {
    expect(SELECTABLE_CRITERION_TYPES.slice(0, MECHANICAL_CRITERION_TYPES.length))
      .toEqual([...MECHANICAL_CRITERION_TYPES]);
  });

  it('offers description last — it is the only LLM-graded form', () => {
    expect(SELECTABLE_CRITERION_TYPES[SELECTABLE_CRITERION_TYPES.length - 1]).toBe('description');
  });

  it('does not offer metric, and the server proves why', () => {
    expect(SELECTABLE_CRITERION_TYPES).not.toContain('metric');
    // Not an opinion: POST /api/missions rejects every metric criterion.
    expect(validateGoalCriteria([{ type: 'metric', query: 'coverage', operator: 'gte', threshold: 1 }])).not.toBeNull();
  });

  it('gives every selectable type a label and a hint', () => {
    expect(CRITERION_TYPE_OPTIONS.map(o => o.type)).toEqual([...SELECTABLE_CRITERION_TYPES]);
    for (const opt of CRITERION_TYPE_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('draftToCriterion', () => {
  it('drops blank optional fields rather than sending empty strings', () => {
    const draft = { ...newCriterionDraft('artifact_exists'), artifactKey: '', artifactType: '' };
    expect(draftToCriterion(draft)).toEqual({ type: 'artifact_exists' });
  });

  it('carries a label through when set', () => {
    const draft = { ...newCriterionDraft('no_open_tasks'), label: 'Backlog clear' };
    expect(draftToCriterion(draft)).toEqual({ type: 'no_open_tasks', label: 'Backlog clear' });
  });

  it('trims a command', () => {
    const draft = { ...newCriterionDraft('command'), command: '  bun run test  ' };
    expect(draftToCriterion(draft)).toEqual({ type: 'command', command: 'bun run test' });
  });

  it('produces criteria the server accepts for every mechanical type', () => {
    const filled = MECHANICAL_CRITERION_TYPES.map(type => {
      const draft = newCriterionDraft(type);
      return draftToCriterion(type === 'command' ? { ...draft, command: 'bun run test' } : draft);
    });
    expect(validateGoalCriteria(filled)).toBeNull();
  });
});

describe('validateCriteriaDrafts — same rules as POST /api/missions, before the 400', () => {
  it('accepts an empty list: a mission with no criteria is legal', () => {
    const result = validateCriteriaDrafts([]);
    expect(result.ok).toBe(true);
    expect(result.criteria).toEqual([]);
    expect(result.formError).toBeNull();
    expect(result.errors).toEqual([]);
  });

  it('rejects a description criterion with no notMechanizableReason, using the server message', () => {
    const draft = { ...newCriterionDraft('description'), description: 'Docs read well' };
    const result = validateCriteriaDrafts([draft]);

    const serverMessage = validateGoalCriteria([draftToCriterion(draft)]);
    expect(serverMessage).not.toBeNull();

    expect(result.ok).toBe(false);
    // Derived from the server string, not written by hand: the tail after the
    // `goalCriteria[0]` locator must match byte for byte.
    expect(result.errors[0]).toContain(serverMessage!.replace(/^goalCriteria\[0\]\s*/, ''));
    expect(result.errors[0]).toContain('notMechanizableReason');
  });

  it('rejects a notMechanizableReason under the server threshold', () => {
    const draft = {
      ...newCriterionDraft('description'),
      description: 'Docs read well',
      notMechanizableReason: 'too short',
    };
    expect(validateGoalCriteria([draftToCriterion(draft)])).not.toBeNull();
    expect(validateCriteriaDrafts([draft]).ok).toBe(false);
  });

  it('accepts a description criterion once the reason clears the threshold', () => {
    const draft = {
      ...newCriterionDraft('description'),
      description: 'Docs read well',
      notMechanizableReason: 'Prose quality has no command that can grade it',
    };
    const result = validateCriteriaDrafts([draft]);
    expect(result.ok).toBe(true);
    expect(result.errors[0]).toBeNull();
    expect(validateGoalCriteria(result.criteria)).toBeNull();
  });

  it('rejects a blank command with the server message', () => {
    const draft = { ...newCriterionDraft('command'), command: '   ' };
    const result = validateCriteriaDrafts([draft]);
    const serverMessage = validateGoalCriteria([draftToCriterion(draft)]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe(serverMessage!.replace(/^goalCriteria\[0\]\./, ''));
  });

  it('attributes the error to the offending row, not to row 0', () => {
    const good = { ...newCriterionDraft('command'), command: 'bun run test' };
    const bad = { ...newCriterionDraft('description'), description: 'vibes' };
    const result = validateCriteriaDrafts([good, bad]);
    expect(result.errors[0]).toBeNull();
    expect(result.errors[1]).not.toBeNull();
  });

  it('surfaces the array-level ceiling as a form error, not a row error', () => {
    const many = Array.from({ length: MAX_GOAL_CRITERIA + 1 }, () => newCriterionDraft('no_open_tasks'));
    const result = validateCriteriaDrafts(many);
    expect(result.ok).toBe(false);
    expect(result.formError).toContain(`at most ${MAX_GOAL_CRITERIA}`);
    expect(result.errors.every(e => e === null)).toBe(true);
  });

  it('never returns ok for a payload the server would reject', () => {
    const drafts = [
      newCriterionDraft('command'),                                        // blank command
      { ...newCriterionDraft('description'), description: 'x' },           // no reason
      { ...newCriterionDraft('artifact_exists'), artifactKey: 'deploy' },  // fine
    ];
    for (const draft of drafts) {
      const client = validateCriteriaDrafts([draft]).ok;
      const server = validateGoalCriteria([draftToCriterion(draft)]) === null;
      expect(client).toBe(server);
    }
  });

  it('strips the goalCriteria[N] locator — users never see array indices', () => {
    const result = validateCriteriaDrafts([newCriterionDraft('command')]);
    expect(result.errors[0]).not.toContain('goalCriteria[');
  });

  it('states the no-criteria consequence in the words the design specifies', () => {
    expect(NO_CRITERIA_NOTE).toBe('No criteria — this mission closes on task progress alone.');
  });
});

// ─── Wiring: the form must delegate, not re-implement ────────────────────────

describe('NewMissionForm wiring', () => {
  const source = readFileSync(
    join(import.meta.dir, '../app/app/(protected)/missions/new/NewMissionForm.tsx'),
    'utf8',
  );

  it('imports the shared validator instead of hand-rolling the rules', () => {
    expect(source).toMatch(/from\s+['"]@\/lib\/goal-criteria-form['"]/);
    expect(source).toContain('validateCriteriaDrafts');
  });

  it('sends goalCriteria on the POST /api/missions payload', () => {
    expect(source).toMatch(/payload\.goalCriteria\s*=/);
  });

  it('renders the no-criteria note from the shared constant, not a copy of the sentence', () => {
    expect(source).toContain('NO_CRITERIA_NOTE');
    expect(source).not.toContain('closes on task progress alone.<');
  });

  it('carries no copy of the notMechanizableReason length rule', () => {
    // The 10-char threshold lives in `validateGoalCriteria`. A literal here is
    // the drift this whole test file exists to prevent.
    expect(source).not.toMatch(/notMechanizableReason[^\n]*(?:length|trim\(\))[^\n]*[<>]=?\s*10/);
    expect(source).not.toMatch(/minLength=\{?10/);
  });
});
