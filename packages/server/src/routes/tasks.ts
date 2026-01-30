import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { tasks } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const CreateSchema = z.object({
  workspaceId: z.string().uuid(),
  sourceId: z.string().uuid().optional(),
  externalId: z.string().optional(),
  externalUrl: z.string().url().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  priority: z.number().int().optional(),
});

export async function taskRoutes(fastify: FastifyInstance) {
  fastify.get('/api/tasks', async (req) => {
    const { workspaceId, status } = req.query as { workspaceId?: string; status?: string };
    let results = await db.query.tasks.findMany({
      with: { source: true, workers: { limit: 1, orderBy: (w, { desc }) => [desc(w.createdAt)] } },
      orderBy: (t, { desc }) => [desc(t.priority), desc(t.createdAt)],
    });
    if (workspaceId) results = results.filter(t => t.workspaceId === workspaceId);
    if (status) results = results.filter(t => t.status === status);
    return results.map(t => ({ ...t, worker: t.workers[0] || null }));
  });

  fastify.get('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      with: { workspace: true, source: true, workers: { with: { artifacts: true }, orderBy: (w, { desc }) => [desc(w.createdAt)] } },
    });
    if (!task) return reply.status(404).send({ error: 'Not found' });
    return { ...task, worker: task.workers[0] || null };
  });

  fastify.post('/api/tasks', async (req, reply) => {
    const result = CreateSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.issues });
    const [task] = await db.insert(tasks).values(result.data).returning();
    return reply.status(201).send(task);
  });

  fastify.patch('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [task] = await db.update(tasks).set({ ...(req.body as any), updatedAt: new Date() }).where(eq(tasks.id, id)).returning();
    if (!task) return reply.status(404).send({ error: 'Not found' });
    return task;
  });

  fastify.delete('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [del] = await db.delete(tasks).where(eq(tasks.id, id)).returning();
    if (!del) return reply.status(404).send({ error: 'Not found' });
    return { success: true };
  });
}
