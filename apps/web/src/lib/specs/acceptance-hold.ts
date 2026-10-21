import { acceptanceEditOf, dropUnacceptedTestResults } from '@buildd/spec-contract/acceptance-edit';
import { isUuid } from '@/lib/uuid';

/**
 * The task an acceptance-test verdict came from: its evidence `recordedBy` is
 * `check:<taskId>` (R-80, AC-126). Anything else has no task to hold it by.
 */
export function checkTaskIdOf(evidence: unknown): string | null {
  const recordedBy = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>).recordedBy : undefined;
  if (typeof recordedBy !== 'string' || !recordedBy.startsWith('check:')) return null;
  const taskId = recordedBy.slice('check:'.length);
  return isUuid(taskId) ? taskId : null;
}

/**
 * Drop test-source rows whose task still has an unaccepted acceptance edit
 * (R-80, AC-126); every other row is kept. Pure: `contexts` maps task id to
 * its context blob, `evidenceById` maps a row id to its stored evidence.
 */
export function holdUnacceptedTestRows<T extends { id: string; source?: string }>(
  rows: readonly T[],
  evidenceById: ReadonlyMap<string, unknown>,
  contexts: ReadonlyMap<string, unknown>,
): T[] {
  return rows.filter((r) => {
    if (r.source !== 'test') return true;
    const taskId = checkTaskIdOf(evidenceById.get(r.id));
    if (!taskId) return true;
    return dropUnacceptedTestResults([{ source: 'test' }], acceptanceEditOf(contexts.get(taskId))).length > 0;
  });
}
