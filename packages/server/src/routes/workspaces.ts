import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { workspaces, tasks, workers } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

const CreateSchema = z.object({
  name: z.string().min(1),
  repo: z.string().optional(),
  localPath: z.string().optional(),
});

export async function workspaceRoutes(fastify: FastifyInstance) {
  fastify.get('/api/workspaces', async () => {
    const results = await db.query.workspaces.findMany({
      orderBy: (w, { desc }) => [desc(w.updatedAt)],
    });

    return Promise.all(results.map(async (ws) => {
      const [tc] = await db.select({ count: sql<number>`count(*)` }).from(tasks).where(eq(tasks.workspaceId, ws.id));
      const [wc] = await db.select({ count: sql<number>`count(*)` }).from(workers).where(eq(workers.workspaceId, ws.id));
      return { ...ws, taskCount: Number(tc?.count || 0), activeWorkerCount: Number(wc?.count || 0) };
    }));
  });

  fastify.get('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, id), with: { sources: true } });
    if (!ws) return reply.status(404).send({ error: 'Not found' });
    return ws;
  });

  fastify.post('/api/workspaces', async (req, reply) => {
    const result = CreateSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.issues });
    const [ws] = await db.insert(workspaces).values(result.data).returning();
    return reply.status(201).send(ws);
  });

  fastify.patch('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [ws] = await db.update(workspaces).set({ ...(req.body as any), updatedAt: new Date() }).where(eq(workspaces.id, id)).returning();
    if (!ws) return reply.status(404).send({ error: 'Not found' });
    return ws;
  });

  fastify.delete('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [del] = await db.delete(workspaces).where(eq(workspaces.id, id)).returning();
    if (!del) return reply.status(404).send({ error: 'Not found' });
    return { success: true };
  });
}
