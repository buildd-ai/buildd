import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { fail, type SpecCaller, type SpecError } from './store';

/**
 * Who may change what a spec's criteria and their test cases say. A builder
 * implements against the acceptance criteria and must not be able to rewrite
 * the bar it is judged by, so a task-scoped caller whose task runs the builder
 * role is refused; organizer and researcher tasks, people and unscoped keys
 * keep the ordinary workspace-write check.
 */
const REFUSED_ROLES = new Set(['builder']);

export const mayAuthorAcceptance = (roleSlug: string | null | undefined): boolean =>
  !roleSlug || !REFUSED_ROLES.has(roleSlug.trim().toLowerCase());

async function taskRole(taskId: string): Promise<string | null> {
  const [row] = await db.select({ roleSlug: tasks.roleSlug }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row?.roleSlug ?? null;
}

/** A 403 when the caller is a task-scoped builder, else null. `roleOf` is injectable for tests. */
export async function acceptanceRoleRefusal(
  caller: SpecCaller,
  roleOf: (taskId: string) => Promise<string | null> = taskRole,
): Promise<SpecError | null> {
  if (caller.kind !== 'account' || !caller.account.taskScope) return null;
  const taskId = (caller.account.taskScope as { taskId?: string }).taskId;
  if (!taskId) return null;
  return mayAuthorAcceptance(await roleOf(taskId))
    ? null
    : fail(403, 'The builder role cannot change acceptance criteria or their test cases; ask an organizer or researcher.', { code: 'acceptance_role_forbidden' });
}
