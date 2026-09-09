import type { GoalCriterion } from '@buildd/shared';

/**
 * Human-readable label for a goal criterion, used everywhere one is shown —
 * the criteria list, the decision sheet's "fix" form, and a filed task's
 * prefilled description. Kept in one place so those three never drift.
 */
export function criterionLabel(c: GoalCriterion): string {
  if (c.label) return c.label;
  // Agents sometimes store a human-readable description instead of label — use it as fallback
  if ((c as any).description) return (c as any).description;
  if (c.type === 'metric') return `${c.query} ${c.operator} ${c.threshold}${c.unit ? ' ' + c.unit : ''}`;
  if (c.type === 'command') return c.command.length > 60 ? c.command.slice(0, 60) + '…' : c.command;
  if (c.type === 'artifact_exists') return c.key ? `Artifact: ${c.key}` : `Artifact type: ${c.artifactType ?? 'any'}`;
  if (c.type === 'description') return c.description.length > 80 ? c.description.slice(0, 80) + '…' : c.description;
  const TYPE_LABELS: Record<string, string> = {
    all_prs_merged: 'All PRs merged',
    no_open_tasks: 'No open tasks',
    artifact_exists: 'Artifact exists',
    command: 'Command',
    metric: 'Metric',
    description: 'Description',
  };
  return TYPE_LABELS[c.type] ?? c.type;
}
