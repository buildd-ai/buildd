import { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { accounts, accountWorkspaces, tasks, workers } from '../db/schema.js';
import { eq, and, or, isNull, sql, inArray, lt } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import type {
  CreateAccountInput,
  ClaimTasksInput,
  ClaimTasksResponse,
  Account,
  AccountTypeValue
} from '@buildd/shared';

export async function accountsRoutes(fastify: FastifyInstance) {
  // Create account
  fastify.post<{ Body: CreateAccountInput }>('/api/accounts', async (request, reply) => {
    const { type, name, githubId, maxConcurrentWorkers = 3, maxCostPerDay = 50 } = request.body;

    const apiKey = `buildd_${randomBytes(32).toString('hex')}`;

    const [account] = await db.insert(accounts).values({
      type,
      name,
      apiKey,
      githubId: githubId || null,
      maxConcurrentWorkers,
      maxCostPerDay: maxCostPerDay.toString(),
    }).returning();

    return account;
  });

  // List accounts
  fastify.get('/api/accounts', async (request, reply) => {
    const allAccounts = await db.query.accounts.findMany({
      orderBy: (accounts, { desc }) => [desc(accounts.createdAt)],
    });
    return allAccounts;
  });

  // Get account by ID
  fastify.get<{ Params: { id: string } }>('/api/accounts/:id', async (request, reply) => {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, request.params.id),
      with: { accountWorkspaces: { with: { workspace: true } } },
    });

    if (!account) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    return account;
  });

  // Grant workspace access
  fastify.post<{
    Params: { id: string };
    Body: { workspaceId: string; canClaim?: boolean; canCreate?: boolean };
  }>('/api/accounts/:id/workspaces', async (request, reply) => {
    const { id } = request.params;
    const { workspaceId, canClaim = true, canCreate = false } = request.body;

    const [aw] = await db.insert(accountWorkspaces).values({
      accountId: id,
      workspaceId,
      canClaim,
      canCreate,
    }).returning();

    return aw;
  });

  // Middleware: Extract account from API key
  const authenticateAgent = async (request: any, reply: any) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const apiKey = authHeader.substring(7);
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, apiKey),
    });

    if (!account) {
      return reply.status(401).send({ error: 'Invalid API key' });
    }

    request.account = account;
  };

  // Claim tasks (for agents to pull work)
  fastify.post<{ Body: ClaimTasksInput }>(
    '/api/workers/claim',
    { preHandler: authenticateAgent },
    async (request: any, reply) => {
      const account = request.account as Account;
      const { workspaceId, capabilities = [], maxTasks = 3 } = request.body;

      // Check current active workers for this account
      const activeWorkers = await db.query.workers.findMany({
        where: and(
          eq(workers.accountId, account.id),
          inArray(workers.status, ['running', 'starting', 'waiting_input'])
        ),
      });

      if (activeWorkers.length >= account.maxConcurrentWorkers) {
        return reply.status(429).send({
          error: 'Max concurrent workers limit reached',
          limit: account.maxConcurrentWorkers,
          current: activeWorkers.length,
        });
      }

      const availableSlots = Math.min(
        maxTasks,
        account.maxConcurrentWorkers - activeWorkers.length
      );

      if (availableSlots === 0) {
        return { workers: [] };
      }

      // Get workspaces this account can claim from
      const allowedWorkspaces = await db.query.accountWorkspaces.findMany({
        where: and(
          eq(accountWorkspaces.accountId, account.id),
          eq(accountWorkspaces.canClaim, true),
          workspaceId ? eq(accountWorkspaces.workspaceId, workspaceId) : undefined
        ),
      });

      const workspaceIds = allowedWorkspaces.map((aw) => aw.workspaceId);
      if (workspaceIds.length === 0) {
        return { workers: [] };
      }

      // Find claimable tasks
      const now = new Date();
      const claimableConditions = [
        inArray(tasks.workspaceId, workspaceIds),
        eq(tasks.status, 'pending'),
        or(isNull(tasks.claimedBy), lt(tasks.expiresAt, now)),
      ];

      // Filter by runner preference
      if (account.type !== 'user') {
        claimableConditions.push(
          or(
            eq(tasks.runnerPreference, 'any'),
            eq(tasks.runnerPreference, account.type)
          )
        );
      }

      const claimableTasks = await db.query.tasks.findMany({
        where: and(...claimableConditions),
        orderBy: (tasks, { desc, asc }) => [desc(tasks.priority), asc(tasks.createdAt)],
        limit: availableSlots,
        with: { workspace: true },
      });

      // Filter by capabilities if specified
      const filteredTasks = claimableTasks.filter((task) => {
        if (capabilities.length === 0) return true;
        if (task.requiredCapabilities.length === 0) return true;
        return task.requiredCapabilities.every((cap) => capabilities.includes(cap));
      });

      // Claim tasks and create workers
      const claimedWorkers: ClaimTasksResponse['workers'] = [];

      for (const task of filteredTasks) {
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min claim expiry

        // Update task as claimed
        await db.update(tasks)
          .set({
            claimedBy: account.id,
            claimedAt: now,
            expiresAt,
            status: 'assigned',
          })
          .where(eq(tasks.id, task.id));

        // Create worker
        const branch = `buildd/${task.id.substring(0, 8)}-${task.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .substring(0, 30)}`;

        const [worker] = await db.insert(workers).values({
          taskId: task.id,
          workspaceId: task.workspaceId,
          accountId: account.id,
          name: `${account.name}-${task.id.substring(0, 8)}`,
          branch,
          status: 'idle',
        }).returning();

        claimedWorkers.push({
          id: worker.id,
          taskId: task.id,
          branch,
          task,
        });
      }

      return { workers: claimedWorkers };
    }
  );

  // Release task (if agent can't complete it)
  fastify.post<{ Params: { taskId: string } }>(
    '/api/tasks/:taskId/release',
    { preHandler: authenticateAgent },
    async (request: any, reply) => {
      const account = request.account as Account;
      const { taskId } = request.params;

      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
      });

      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      if (task.claimedBy !== account.id) {
        return reply.status(403).send({ error: 'Task not claimed by this account' });
      }

      await db.update(tasks)
        .set({
          claimedBy: null,
          claimedAt: null,
          expiresAt: null,
          status: 'pending',
        })
        .where(eq(tasks.id, taskId));

      return { success: true };
    }
  );
}
