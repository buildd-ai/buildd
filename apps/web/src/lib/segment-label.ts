/**
 * The short label a task wears inside a pulse segment or a fleet slot
 * ("db", "checkout", "research"), plus the rest of its title.
 *
 * One entry point for every surface that needs a one-word task name, so the
 * shared `taskDisplayLabel` (packages/core) can replace this body without
 * touching a caller.
 *
 * Pure and client-safe.
 */
import { stripTaskTypePrefix } from '@buildd/core/mission-helpers';

export interface TaskShortLabel {
  /** One word, lower case, at most `MAX_LABEL` chars. */
  label: string;
  /** The title with the label's prefix removed. */
  rest: string;
}

const MAX_LABEL = 12;
/** Commit types too generic to name a task on their own: the next word does. */
const GENERIC_TYPES = new Set(['feat', 'fix', 'chore', 'refactor', 'perf', 'style', 'build', 'ci']);
const CONVENTIONAL = /^([a-z][\w-]*)(?:\(([^)]+)\))?!?:\s*(.*)$/i;

const clip = (s: string) => s.toLowerCase().slice(0, MAX_LABEL);

function firstWord(text: string): TaskShortLabel {
  const m = /^\s*([\p{L}\p{N}][\p{L}\p{N}_-]*)\s*(.*)$/u.exec(text);
  if (!m) return { label: clip(text.trim()), rest: '' };
  return { label: clip(m[1]), rest: m[2] };
}

export function taskShortLabel(task: { title: string; mode?: string | null }): TaskShortLabel {
  const title = stripTaskTypePrefix(task.title ?? '');
  if (task.mode === 'planning' && /^mission:\s*/i.test(title)) {
    return { label: 'plan', rest: title.replace(/^mission:\s*/i, '') };
  }
  const m = CONVENTIONAL.exec(title);
  if (m) {
    const [, type, scope, rest] = m;
    if (scope) return { label: clip(scope.split(/[,/\s]/)[0]), rest };
    if (!GENERIC_TYPES.has(type.toLowerCase())) return { label: clip(type), rest };
    return firstWord(rest);
  }
  return firstWord(title);
}
