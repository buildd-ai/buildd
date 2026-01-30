import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { workers, tasks } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { workerManager } from '../services/worker-runner.js';
import { v4 as uuidv4 } from 'uuid';

const CreateSchema = z.object({
  workspaceId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  name: z.string().optional(),
  branch: z.string().optional(),
});

const StartSchema = z.object({
  prompt: z.string().min(1),
  attachments: z.array(z.string()).optional(),
});

const MessageSchema = z.object({
  content: z.string().min(1),
  attachments: z.array(z.string()).optional(),
});

export async function workerRoutes(fastify: FastifyInstance) {
  fastify.get('/api/workers', async (req) => {
    const { workspaceId, taskId, status } = req.query as { workspaceId?: string; taskId?: string; status?: string };
    let results = await db.query.workers.findMany({
      with: { task: true, workspace: true, artifacts: { orderBy: (a, { desc }) => [desc(a.createdAt)], limit: 5 } },
      orderBy: (w, { desc }) => [desc(w.updatedAt)],
    });
    if (workspaceId) results = results.filter(w => w.workspaceId === workspaceId);
    if (taskId) results = results.filter(w => w.taskId === taskId);
    if (status) results = results.filter(w => w.status === status);
    return results;
  });

  fastify.get('/api/workers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, id),
      with: {
        task: true,
        workspace: true,
        artifacts: { with: { comments: true }, orderBy: (a, { desc }) => [desc(a.createdAt)] },
        messages: { orderBy: (m, { desc }) => [desc(m.createdAt)], limit: 50 },
      },
    });
    if (!worker) return reply.status(404).send({ error: 'Not found' });
    return worker;
  });

  fastify.post('/api/workers', async (req, reply) => {
    const result = CreateSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.issues });
    
    const { workspaceId, taskId, name, branch } = result.data;
    const workerName = name || `worker-${uuidv4().slice(0, 8)}`;
    
    const [worker] = await db.insert(workers).values({
      workspaceId,
      taskId: taskId || null,
      name: workerName,
      branch: branch || workerName,
    }).returning();

    if (taskId) {
      await db.update(tasks).set({ status: 'assigned', updatedAt: new Date() }).where(eq(tasks.id, taskId));
    }

    return reply.status(201).send(worker);
  });

  fastify.post('/api/workers/:id/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = StartSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.issues });

    const worker = await db.query.workers.findFirst({ where: eq(workers.id, id) });
    if (!worker) return reply.status(404).send({ error: 'Not found' });
    if (worker.status === 'running') return reply.status(400).send({ error: 'Already running' });

    workerManager.startWorker(id, result.data.prompt).catch(console.error);

    if (worker.taskId) {
      await db.update(tasks).set({ status: 'in_progress', updatedAt: new Date() }).where(eq(tasks.id, worker.taskId));
    }

    return { status: 'starting' };
  });

  fastify.post('/api/workers/:id/message', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = MessageSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.issues });
    // TODO: implement message sending to running worker
    return { status: 'sent' };
  });

  fastify.post('/api/workers/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string };
    workerManager.cancelWorker(id);
    await db.update(workers).set({ status: 'paused', updatedAt: new Date() }).where(eq(workers.id, id));
    return { status: 'paused' };
  });

  fastify.post('/api/workers/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    workerManager.cancelWorker(id);
    await db.update(workers).set({ status: 'error', error: 'Cancelled', updatedAt: new Date() }).where(eq(workers.id, id));
    return { status: 'cancelled' };
  });

  fastify.delete('/api/workers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    workerManager.cancelWorker(id);
    const [del] = await db.delete(workers).where(eq(workers.id, id)).returning();
    if (!del) return reply.status(404).send({ error: 'Not found' });
    return { success: true };
  });
}
