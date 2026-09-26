/**
 * The one-word name a task wears inside a pulse segment or a fleet slot
 * ("db", "checkout", "research"), plus its short label for the line beside it.
 *
 * Built on `taskDisplayLabel` (@buildd/core/task-label) — the stored
 * creator/classifier label, else the shared title heuristic — so a segment,
 * a slot and a task row never name one task three ways. This module only adds
 * the one-word pick a cell has room for: the conventional-commit scope when
 * there is one, else a non-generic commit type ("research", "docs"), else the
 * label's first word.
 *
 * Pure and client-safe.
 */
import { stripTaskTypePrefix } from '@buildd/core/mission-helpers';
import { heuristicTaskLabel, taskDisplayLabel } from '@buildd/core/task-label';

export interface TaskShortLabel {
  /** One word, lower case, at most `MAX_LABEL` chars. */
  label: string;
  /** The task's short (2–4 word) label, for the line beside the cell. */
  rest: string;
}

const MAX_LABEL = 12;
/** Commit types too generic to name a task on their own. */
const GENERIC_TYPES = new Set(['feat', 'fix', 'chore', 'refactor', 'perf', 'style', 'build', 'ci', 'test']);
const TYPE_PREFIX = /^([a-z][\w-]*)(?:\([^)]*\))?!?:\s*/i;

const clip = (s: string) => s.toLowerCase().slice(0, MAX_LABEL);

export function taskShortLabel(task: { title: string; label?: string | null; mode?: string | null }): TaskShortLabel {
  const title = stripTaskTypePrefix(task.title ?? '');
  const display = taskDisplayLabel({ title: task.title ?? '', label: task.label ?? null });
  if (task.mode === 'planning' && /^mission:\s*/i.test(title)) {
    return { label: 'plan', rest: display.label };
  }
  if (display.scope) return { label: clip(display.scope.split(/[,/\s]/)[0]), rest: display.label };
  const type = TYPE_PREFIX.exec(title)?.[1];
  if (type && !GENERIC_TYPES.has(type.toLowerCase())) {
    // The cell already says the type; the line beside it says what the task is.
    const rest = display.label.toLowerCase() === type.toLowerCase()
      ? heuristicTaskLabel(title.replace(TYPE_PREFIX, '')).label
      : display.label;
    return { label: clip(type), rest };
  }
  const [first, ...more] = display.label.split(/\s+/);
  return { label: clip(first ?? ''), rest: more.join(' ') };
}
