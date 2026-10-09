import { db } from '@buildd/core/db';
import { accounts, workers, workspaces, teamMembers, tasks } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { getUserTeamIds } from '@/lib/team-access';

export type CreationSource = 'dashboard' | 'api' | 'mcp' | 'github' | 'local_ui' | 'schedule';

const VALID_CREATION_SOURCES: CreationSource[] = ['dashboard', 'api', 'mcp', 'github', 'local_ui', 'schedule'];

export interface CreateTaskCreatorParams {
  // Auth context - one of these should be provided
  apiAccount?: { id: string; sessionUserId?: string } | null;
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
  /** The person the task is for; see tasks.createdByUserId. */
  createdByUserId: string | null;
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

  const createdByUserId = await resolveRequesterUserId(params, derivedParentTaskId);

  return {
    createdByAccountId,
    createdByWorkerId: validatedWorkerId,
    creationSource,
    parentTaskId: derivedParentTaskId,
    createdByUserId,
  };
}

/**
 * The person a new task is for: the signed-in user, or the person behind an
 * OAuth session, or — for a task an agent files — whoever its parent task was
 * for. Tasks filed by other paths (retries, schedules, missions) are resolved
 * at read time by `resolveTaskRequesterUserId`.
 */
async function resolveRequesterUserId(
  params: CreateTaskCreatorParams,
  parentTaskId: string | null,
): Promise<string | null> {
  if (params.userId) return params.userId;
  if (params.apiAccount?.sessionUserId) return params.apiAccount.sessionUserId;
  if (!parentTaskId) return null;
  try {
    const parent = await db.query.tasks.findFirst({
      where: eq(tasks.id, parentTaskId),
      columns: { createdByUserId: true },
    });
    return parent?.createdByUserId ?? null;
  } catch {
    return null;
  }
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
    const teamIds = await getUserTeamIds(userId);
    if (teamIds.length > 0) {
      const userAccount = await db.query.accounts.findFirst({
        where: inArray(accounts.teamId, teamIds),
      });
      return userAccount?.id || null;
    }
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

  // For session auth: worker must be in a workspace the user can access via team
  if (userId) {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, worker.workspaceId),
      columns: { teamId: true },
    });
    if (workspace) {
      const teamIds = await getUserTeamIds(userId);
      if (teamIds.includes(workspace.teamId)) {
        validatedWorkerId = createdByWorkerId;
        if (!derivedParentTaskId && worker.taskId) {
          derivedParentTaskId = worker.taskId;
        }
      }
    }
  }

  return { validatedWorkerId, derivedParentTaskId };
}
