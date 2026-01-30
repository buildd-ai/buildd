import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { artifacts, comments } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const CommentSchema = z.object({
  content: z.string().min(1),
  selection: z.object({ start: z.number(), end: z.number(), text: z.string().optional() }).optional(),
});

export async function artifactRoutes(fastify: FastifyInstance) {
  fastify.get('/api/workers/:workerId/artifacts', async (req) => {
    const { workerId } = req.params as { workerId: string };
    return db.query.artifacts.findMany({
      where: eq(artifacts.workerId, workerId),
      with: { comments: { orderBy: (c, { asc }) => [asc(c.createdAt)] } },
      orderBy: (a, { desc }) => [desc(a.createdAt)],
    });
  });

  fastify.get('/api/artifacts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const artifact = await db.query.artifacts.findFirst({
      where: eq(artifacts.id, id),
      with: { comments: { orderBy: (c, { asc }) => [asc(c.createdAt)] }, worker: true },
    });
    if (!artifact) return reply.status(404).send({ error: 'Not found' });
    return artifact;
  });

  fastify.post('/api/artifacts/:id/comments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = CommentSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.issues });

    const artifact = await db.query.artifacts.findFirst({ where: eq(artifacts.id, id) });
    if (!artifact) return reply.status(404).send({ error: 'Not found' });

    const [comment] = await db.insert(comments).values({
      artifactId: id,
      workerId: artifact.workerId,
      content: result.data.content,
      selection: result.data.selection || null,
    }).returning();

    return reply.status(201).send(comment);
  });

  fastify.patch('/api/comments/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [comment] = await db.update(comments).set({ resolved: true }).where(eq(comments.id, id)).returning();
    if (!comment) return reply.status(404).send({ error: 'Not found' });
    return comment;
  });
}
