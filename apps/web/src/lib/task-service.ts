import { db } from '@buildd/core/db';
import { accounts, workers, workspaces, type missions } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { getUserTeamIds } from '@/lib/team-access';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { resolveTaskRequesterUserId } from '@buildd/core/task-requester';
import { requestingPerson } from '@/lib/request-person';

export type CreationSource = 'dashboard' | 'api' | 'mcp' | 'github' | 'local_ui' | 'schedule';

const VALID_CREATION_SOURCES: CreationSource[] = ['dashboard', 'api', 'mcp', 'github', 'local_ui', 'schedule'];

export interface CreateTaskCreatorParams {
  // Auth context - one of these should be provided. The whole authenticated
  // account: requestingPerson reads its taskScope / actsAs as well.
  apiAccount?: { id: string; sessionUserId?: string; taskScope?: unknown; actsAs?: unknown } | null;
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
  /** The authenticated person the task is for, or null for the trigger to derive; see tasks.createdByUserId. */
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

  const createdByUserId = resolveRequesterUserId(params);

  return {
    createdByAccountId,
    createdByWorkerId: validatedWorkerId,
    creationSource,
    parentTaskId: derivedParentTaskId,
    createdByUserId,
  };
}

/**
 * The authenticated person a new task is for: the signed-in user, or the person
 * behind their own OAuth session (lib/request-person.ts). A per-task token, an
 * API key or an 'agent' grant is never a person, and a bearer decides over a
 * cookie riding along. A task an agent, retry, schedule or mission files gets
 * its person from the `tasks_resolve_requester` trigger (parent -> mission ->
 * schedule), which records it as derived rather than as named by the writer.
 */
function resolveRequesterUserId(params: CreateTaskCreatorParams): string | null {
  return requestingPerson(params.userId ? { id: params.userId } : null, params.apiAccount);
}

type MissionRequesterSource = NonNullable<typeof missions.$inferInsert['requesterSource']>;

export interface ResolvedMissionCreator {
  /** The person the mission is for; its tasks inherit them. */
  createdByUserId: string | null;
  requesterSource: MissionRequesterSource;
  /** Who filed it: the authenticated account, and for an agent its worker and task. */
  createdByAccountId: string | null;
  createdByWorkerId: string | null;
  createdByTaskId: string | null;
}

/**
 * Who filed a new mission and who it is for, as distinct facts (spec 7702c32a
 * R-1/R-2). A person filing it themselves is 'explicit'. An agent filing it
 * (identified by its own worker, validated as for tasks) records the worker and
 * its task as the actor and lineage, and the person is that task's requester,
 * recorded as 'parent': never as the person's own action, and never the
 * runner's owner, the key's creator or an agent grant's user.
 */
export async function resolveMissionCreator(params: {
  user: { id: string } | null | undefined;
  apiAccount: CreateTaskCreatorParams['apiAccount'];
  createdByWorkerId?: string;
}): Promise<ResolvedMissionCreator> {
  const ctx = await resolveCreatorContext({
    apiAccount: params.apiAccount,
    userId: params.user?.id ?? null,
    createdByWorkerId: params.createdByWorkerId,
  });
  const actor = {
    createdByAccountId: ctx.createdByAccountId,
    createdByWorkerId: ctx.createdByWorkerId,
    createdByTaskId: ctx.createdByWorkerId ? ctx.parentTaskId : null,
  };
  if (ctx.createdByUserId) return { createdByUserId: ctx.createdByUserId, requesterSource: 'explicit', ...actor };
  const derived = actor.createdByTaskId
    ? await resolveTaskRequesterUserId({ parentTaskId: actor.createdByTaskId }).catch(() => null)
    : null;
  return { createdByUserId: derived, requesterSource: derived ? 'parent' : 'none', ...actor };
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
        where: sqlWhere(inArray(accounts.teamId, teamIds)),
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
    where: sqlWhere(eq(workers.id, createdByWorkerId)),
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
      where: sqlWhere(eq(workspaces.id, worker.workspaceId)),
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
