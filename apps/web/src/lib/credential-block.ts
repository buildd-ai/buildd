/**
 * A pending task whose backend has no credential to run on says so: the claim
 * stamps `context.credentialBlock`, the task page reads it as its waiting line
 * ("Needs a Claude key" + an Add-a-key link). Cleared when the task is claimed.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';

export * from './credential-block-copy';
import { CREDENTIAL_BLOCK_CONTEXT_KEY, type CredentialBlock } from './credential-block-copy';

/** Best-effort: record why a pending task cannot be claimed. */
export async function stampCredentialBlock(taskId: string, block: CredentialBlock): Promise<void> {
  try {
    await db.update(tasks)
      .set({ context: sql`COALESCE(${tasks.context}, '{}'::jsonb) || ${JSON.stringify({ [CREDENTIAL_BLOCK_CONTEXT_KEY]: block })}::jsonb` })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')));
  } catch (err) {
    console.warn(`[credential-block] failed to stamp task ${taskId}:`, err);
  }
}
