/**
 * Form state for the *Done when…* step on `NewMissionForm` (U5).
 *
 * The rules are **not** restated here. `validateGoalCriteria` in
 * `@buildd/core/mission-helpers` is the write-boundary validator that
 * `POST /api/missions` and `PATCH /api/missions/[id]` already enforce; this
 * module calls it and re-attributes its message to the row the author is
 * editing, so the author sees the rule before the 400 instead of after.
 *
 * It is a pure module (no React, no I/O, no `'use client'`) precisely so both
 * sides can import it — the client/server boundary guard in
 * `client-boundary.test.ts` exists because shared derivation living in a client
 * module is a production-only crash.
 *
 * Two consequences of delegating rather than copying:
 *   - `metric` is not offered at all. The validator rejects every metric
 *     criterion (no evaluator exists, so it would stay UNVERIFIED and block
 *     completion forever), and a picker entry whose only outcome is a 400 is
 *     worse than no entry.
 *   - the 10-character `notMechanizableReason` threshold appears nowhere in this
 *     file. Change it in core and both surfaces move together.
 */
import type { GoalCriterion, GoalCriterionType } from '@buildd/shared';
import { validateGoalCriteria, MECHANICAL_CRITERION_TYPES } from '@buildd/core/mission-helpers';

/**
 * Types the picker offers, **mechanical first** — the order is derived from the
 * shared `MECHANICAL_CRITERION_TYPES` constant rather than typed out, so core
 * cannot add a mechanical form that this picker silently buries.
 */
export const SELECTABLE_CRITERION_TYPES = [
  ...MECHANICAL_CRITERION_TYPES,
  'description',
] as const satisfies readonly GoalCriterionType[];

export type SelectableCriterionType = (typeof SELECTABLE_CRITERION_TYPES)[number];

export interface CriterionTypeOption {
  type: SelectableCriterionType;
  label: string;
  /** One line on what the verdict is read from — the honest cost of the choice. */
  hint: string;
}

export const CRITERION_TYPE_OPTIONS: CriterionTypeOption[] = [
  {
    type: 'command',
    label: 'Command passes',
    hint: 'A script that must exit 0. Graded by machinery, never by a model.',
  },
  {
    type: 'all_prs_merged',
    label: 'All PRs merged',
    hint: 'Every PR this mission opened has landed.',
  },
  {
    type: 'no_open_tasks',
    label: 'No open tasks',
    hint: 'Nothing left pending, assigned or running.',
  },
  {
    type: 'artifact_exists',
    label: 'Artifact exists',
    hint: 'A named artifact was produced by one of the runs.',
  },
  {
    type: 'description',
    label: 'Description (LLM-graded — last resort)',
    hint: 'Needs a live model to reach a verdict, so it needs a stated reason.',
  },
];

/** Shown when the author adds no criteria — a legal, and stated, choice. */
export const NO_CRITERIA_NOTE = 'No criteria — this mission closes on task progress alone.';

/** Flat draft: one shape covering every selectable type's fields. */
export interface CriterionDraft {
  type: SelectableCriterionType;
  label: string;
  command: string;
  artifactKey: string;
  artifactType: string;
  description: string;
  notMechanizableReason: string;
}

export function newCriterionDraft(type: SelectableCriterionType = 'command'): CriterionDraft {
  return {
    type,
    label: '',
    command: '',
    artifactKey: '',
    artifactType: '',
    description: '',
    notMechanizableReason: '',
  };
}

/**
 * Project a draft onto the stored criterion shape.
 *
 * Blank optional fields are dropped rather than sent as empty strings: an
 * `artifact_exists` criterion with `key: ''` would fingerprint differently from
 * the same criterion with the field absent, splitting one criterion's verdict
 * history in two (`criterionFingerprint` reads `key ?? ''`).
 */
export function draftToCriterion(draft: CriterionDraft): GoalCriterion {
  const label = draft.label.trim();
  const base = label ? { label } : {};

  switch (draft.type) {
    case 'command':
      return { type: 'command', command: draft.command.trim(), ...base };
    case 'all_prs_merged':
      return {
        type: 'all_prs_merged',
        ...base,
      };
    case 'no_open_tasks':
      return { type: 'no_open_tasks', ...base };
    case 'artifact_exists': {
      const key = draft.artifactKey.trim();
      const artifactType = draft.artifactType.trim();
      return {
        type: 'artifact_exists',
        ...(key ? { key } : {}),
        ...(artifactType ? { artifactType } : {}),
        ...base,
      };
    }
    case 'description':
      return {
        type: 'description',
        description: draft.description.trim(),
        notMechanizableReason: draft.notMechanizableReason.trim(),
        ...base,
      };
  }
}

/**
 * Re-attribute a validator message to the row being edited.
 *
 * The validator locates faults as `goalCriteria[N]`, which is meaningless to
 * someone looking at a form. Three locator forms exist in core:
 * `goalCriteria[N].field …`, `goalCriteria[N] is …`, `goalCriteria[N]: …`.
 * Everything after the locator is left byte-identical — the rule's own words,
 * not a paraphrase that can drift.
 */
function localise(message: string): string {
  if (/^goalCriteria\[\d+\]\./.test(message)) return message.replace(/^goalCriteria\[\d+\]\./, '');
  return message.replace(/^goalCriteria\[\d+\]/, 'This criterion');
}

export interface CriteriaDraftValidation {
  /** True when `validateGoalCriteria` accepts the whole assembled payload. */
  ok: boolean;
  /** The payload to POST. Only meaningful when `ok`. */
  criteria: GoalCriterion[];
  /** Per-row message, index-aligned with the drafts. */
  errors: (string | null)[];
  /** Array-level fault (e.g. the count ceiling) that belongs to no single row. */
  formError: string | null;
}

/**
 * Validate the draft list against the server's own validator.
 *
 * Each draft is validated as a one-element array so the returned message can be
 * attributed to its row; the assembled array is then validated as a whole to
 * catch array-level rules (the `MAX_GOAL_CRITERIA` ceiling). Nothing here
 * decides whether a criterion is acceptable — `validateGoalCriteria` does.
 */
export function validateCriteriaDrafts(drafts: CriterionDraft[]): CriteriaDraftValidation {
  const criteria = drafts.map(draftToCriterion);
  const errors = criteria.map(c => {
    const message = validateGoalCriteria([c]);
    return message === null ? null : localise(message);
  });

  const whole = validateGoalCriteria(criteria);
  // A whole-array fault that no row claimed is array-level (the ceiling).
  const formError = whole !== null && errors.every(e => e === null) ? whole : null;

  return {
    ok: whole === null,
    criteria,
    errors,
    formError,
  };
}
