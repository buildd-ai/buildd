import { FastifyInstance } from 'fastify';
import { workerManager } from '../services/worker-runner.js';
import type { SSEEvent } from '@buildd/shared';

export async function eventRoutes(fastify: FastifyInstance) {
  fastify.get('/api/events', async (req, reply) => {
    const { workspaceId } = req.query as { workspaceId?: string };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (event: SSEEvent) => {
      if (workspaceId && event.workspaceId !== workspaceId) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const keepalive = setInterval(() => reply.raw.write(': keepalive\n\n'), 30000);

    workerManager.onEvent(sendEvent);

    req.raw.on('close', () => {
      clearInterval(keepalive);
      workerManager.offEvent(sendEvent);
    });
  });

  fastify.get('/api/workers/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (event: SSEEvent) => {
      if (event.workerId !== id) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const keepalive = setInterval(() => reply.raw.write(': keepalive\n\n'), 30000);

    workerManager.onEvent(sendEvent);

    req.raw.on('close', () => {
      clearInterval(keepalive);
      workerManager.offEvent(sendEvent);
    });
  });
}
