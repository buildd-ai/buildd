import { db } from '@buildd/core/db';
import { accounts, workers, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

export type CreationSource = 'dashboard' | 'api' | 'mcp' | 'github' | 'local_ui';

const VALID_CREATION_SOURCES: CreationSource[] = ['dashboard', 'api', 'mcp', 'github', 'local_ui'];

export interface CreateTaskCreatorParams {
  // Auth context - one of these should be provided
  apiAccount?: { id: string } | null;
  userId?: string | null;
  // Optional creator tracking from request
  createdByWorkerId?: string;
  parentTaskId?: string;
  creationSource?: string;
}

export interface ResolvedCreatorContext {
  createdByAccountId: string | null;
  createdByWorkerId: string | null;
  creationSource: CreationSource;
  parentTaskId: string | null;
}

/**
 * Resolves the creator context for a new task based on authentication and request params.
 *
 * Logic:
 * - createdByAccountId: From API account or user's primary account
 * - creationSource: Explicit value > 'dashboard' for session auth > 'api' default
 * - createdByWorkerId: Validated to belong to authenticated account
 * - parentTaskId: Explicit value > derived from worker's current task
 */
export async function resolveCreatorContext(
  params: CreateTaskCreatorParams
): Promise<ResolvedCreatorContext> {
  // Resolve account ID
  const createdByAccountId = await resolveAccountId(params.apiAccount, params.userId);

  // Determine creation source
  const creationSource = resolveCreationSource(
    params.creationSource,
    params.apiAccount,
    params.userId
  );

  // Validate worker and derive parent task
  const { validatedWorkerId, derivedParentTaskId } = await validateWorkerContext(
    params.createdByWorkerId,
    params.parentTaskId,
    params.apiAccount,
    params.userId
  );

  return {
    createdByAccountId,
    createdByWorkerId: validatedWorkerId,
    creationSource,
    parentTaskId: derivedParentTaskId,
  };
}

/**
 * Resolves the account ID from API account or user's primary account
 */
async function resolveAccountId(
  apiAccount?: { id: string } | null,
  userId?: string | null
): Promise<string | null> {
  if (apiAccount) {
    return apiAccount.id;
  }

  if (userId) {
    const userAccount = await db.query.accounts.findFirst({
      where: eq(accounts.ownerId, userId),
    });
    return userAccount?.id || null;
  }

  return null;
}

/**
 * Determines the creation source based on explicit value or auth type
 */
export function resolveCreationSource(
  requestedSource?: string,
  apiAccount?: { id: string } | null,
  userId?: string | null
): CreationSource {
  // Use explicit source if valid
  if (requestedSource && VALID_CREATION_SOURCES.includes(requestedSource as CreationSource)) {
    return requestedSource as CreationSource;
  }

  // Session auth (no API account, has user) implies dashboard
  if (!apiAccount && userId) {
    return 'dashboard';
  }

  // Default to API
  return 'api';
}

/**
 * Validates that a worker belongs to the authenticated account and derives parent task
 */
async function validateWorkerContext(
  createdByWorkerId?: string,
  parentTaskId?: string,
  apiAccount?: { id: string } | null,
  userId?: string | null
): Promise<{ validatedWorkerId: string | null; derivedParentTaskId: string | null }> {
  let validatedWorkerId: string | null = null;
  let derivedParentTaskId: string | null = parentTaskId || null;

  if (!createdByWorkerId) {
    return { validatedWorkerId, derivedParentTaskId };
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, createdByWorkerId),
  });

  if (!worker) {
    return { validatedWorkerId, derivedParentTaskId };
  }

  // For API key auth: worker must belong to the authenticated account
  if (apiAccount && worker.accountId === apiAccount.id) {
    validatedWorkerId = createdByWorkerId;
    if (!derivedParentTaskId && worker.taskId) {
      derivedParentTaskId = worker.taskId;
    }
    return { validatedWorkerId, derivedParentTaskId };
  }

  // For session auth: worker must be in a workspace owned by the user
  if (userId) {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, worker.workspaceId),
    });
    if (workspace?.ownerId === userId) {
      validatedWorkerId = createdByWorkerId;
      if (!derivedParentTaskId && worker.taskId) {
        derivedParentTaskId = worker.taskId;
      }
    }
  }

  return { validatedWorkerId, derivedParentTaskId };
}
