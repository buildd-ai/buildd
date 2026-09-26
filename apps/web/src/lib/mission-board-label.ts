/**
 * The Board's scope chip + short label for one task. The one seam between the
 * mission Board and the shared short-label helper (`@buildd/core/task-label`),
 * so every tile, bar and side-rail row draws the same words.
 */
import { taskDisplayLabel } from '@buildd/core/task-label';

export interface BoardLabel {
  scope: string | null;
  label: string;
}

export function boardTaskLabel(task: { label?: string | null; title: string }): BoardLabel {
  return taskDisplayLabel(task);
}
