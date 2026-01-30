import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { taskRoutes } from './routes/tasks.js';
import { workerRoutes } from './routes/workers.js';
import { artifactRoutes } from './routes/artifacts.js';
import { eventRoutes } from './routes/events.js';

async function main() {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, { origin: true });
  await fastify.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  await fastify.register(workspaceRoutes);
  await fastify.register(taskRoutes);
  await fastify.register(workerRoutes);
  await fastify.register(artifactRoutes);
  await fastify.register(eventRoutes);

  fastify.get('/health', async () => ({ status: 'ok' }));

  try {
    await fastify.listen({ port: config.port, host: config.host });
    console.log(`buildd server running at http://${config.host}:${config.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main();
