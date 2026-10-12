/**
 * Claim-time spec criteria for a `[surface audit]` task (docs/specs/living-specs.md
 * §11). For each task the audit depends on that is pinned to a Living Spec,
 * the criteria that task answers for, read from its pinned revision, and how
 * to record a visual verdict on each. Computed at claim, like the required
 * routes, because the audit's dependencies grow after it is filed.
 * Best-effort: a failure attaches nothing, and the audit runs as before.
 */
import type { ClaimTasksResponse } from '@buildd/shared';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { specCriteria } from '@buildd/spec-contract/requirements';
import { inScope } from '@buildd/spec-contract/scope';
import { readPinnedSpecRevision } from '@/lib/specs/pin';
import { MAX_VISUAL_SHOTS } from '@/lib/specs/visual-limits';
import { appendContextBlock } from './context-injection';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export const VISUAL_AUDIT_SPEC_CRITERIA_CONTEXT_KEY = 'visualAuditSpecCriteria';

type AuditTask = { id: string; roleSlug?: string | null; dependsOn?: unknown };

export interface SubjectCriteria {
  taskId: string;
  taskTitle: string;
  specTitle: string;
  revision: number;
  criteria: Array<{ id: string; text: string }>;
}

const pinOf = (context: unknown): Record<string, unknown> | null => {
  const c = context && typeof context === 'object' ? (context as Record<string, unknown>).specSource : null;
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
};

/** The prompt block. Null when no dependency is pinned to a spec. */
export function renderVisualAuditSpecCriteria(subjects: readonly SubjectCriteria[]): string | null {
  const withCriteria = subjects.filter((s) => s.criteria.length > 0);
  if (withCriteria.length === 0) return null;
  return [
    '## Spec criteria to judge (computed at claim)',
    'These tasks are built to an approved Living Spec. For each criterion below that a page can show, record one verdict with what you captured:',
    '',
    `\`manage_specs\` action=verdict { taskId, checker: "visual", criterionId, verdict: pass | fail | inconclusive, capturedSha: <the full commit your shots were taken at>, screenshotIds: [1-${MAX_VISUAL_SHOTS} of your own screenshot artifact ids], observed: <one line on what you saw> }`,
    '',
    '- Judge layout, content and states against the criterion text, not pixels. A pixel difference alone is not a fail; a state or step the criterion asks for that is missing or wrong is.',
    '- Skip a criterion nothing on screen can show. The code reviewer grades it, and your verdict would replace theirs.',
    '- inconclusive needs `observed` saying what you could not see; pass and fail need at least one screenshot.',
    '- A verdict is refused while the task\'s PR is not in the commit you captured. Say so in your summary rather than retrying.',
    ...withCriteria.flatMap((s) => [
      '',
      `### ${s.taskTitle}`,
      `taskId \`${s.taskId}\`, spec "${s.specTitle}" revision ${s.revision}`,
      ...s.criteria.map((c) => `- **${c.id}** ${c.text}`),
    ]),
  ].join('\n');
}

export async function loadVisualAuditSpecCriteria(dependsOn: readonly string[]): Promise<SubjectCriteria[]> {
  if (dependsOn.length === 0) return [];
  const rows = await db.query.tasks.findMany({
    where: sqlWhere(inArray(tasks.id, [...dependsOn])),
    columns: { id: true, title: true, context: true },
  });
  const out: SubjectCriteria[] = [];
  for (const row of rows) {
    const pin = pinOf(row.context);
    if (!pin || typeof pin.specId !== 'string') continue;
    const read = await readPinnedSpecRevision(pin);
    if (!read.ok) continue;
    out.push({
      taskId: row.id,
      taskTitle: row.title,
      specTitle: read.title,
      revision: read.revision,
      criteria: inScope(pin, specCriteria(read.body)).map((c) => ({ id: c.id, text: c.text })),
    });
  }
  return out;
}

export async function attachVisualAuditSpecCriteria(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly AuditTask[],
  load: (dependsOn: readonly string[]) => Promise<SubjectCriteria[]> = loadVisualAuditSpecCriteria,
): Promise<void> {
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find((t) => t.id === cw.taskId);
    if (!task || task.roleSlug !== VISUAL_AUDITOR_ROLE_SLUG) continue;
    try {
      const deps = Array.isArray(task.dependsOn) ? (task.dependsOn as string[]) : [];
      const subjects = await load(deps);
      const block = renderVisualAuditSpecCriteria(subjects);
      if (!block) continue;
      const taskObj = cw.task as any;
      if (taskObj) {
        taskObj.context = taskObj.context ?? {};
        taskObj.context[VISUAL_AUDIT_SPEC_CRITERIA_CONTEXT_KEY] = subjects.filter((s) => s.criteria.length > 0)
          .map((s) => ({ taskId: s.taskId, revision: s.revision, criteria: s.criteria.map((c) => c.id) }));
      }
      appendContextBlock(cw, block);
    } catch (err) {
      console.warn('[claim] visual audit spec criteria injection failed:', err);
    }
  }
}
