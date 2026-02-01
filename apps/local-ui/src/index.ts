import { readFileSync } from 'fs';
import { join } from 'path';
import type { LocalUIConfig } from './types';
import { BuilddClient } from './buildd';
import { WorkerManager } from './workers';
import { createWorkspaceResolver } from './workspace';

const PORT = parseInt(process.env.PORT || '8766');

// Load config from env
const config: LocalUIConfig = {
  projectsRoot: process.env.PROJECTS_ROOT || '/home/coder/project',
  builddServer: process.env.BUILDD_SERVER || 'https://buildd-three.vercel.app',
  apiKey: process.env.BUILDD_API_KEY || '',
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '3'),
  model: process.env.MODEL || 'claude-sonnet-4-5-20250929',
  // Direct access URL (set this to your Coder subdomain or Tailscale IP)
  localUiUrl: process.env.LOCAL_UI_URL,
  // Pusher config for command relay from server
  pusherKey: process.env.PUSHER_KEY,
  pusherCluster: process.env.PUSHER_CLUSTER,
};

if (!config.apiKey) {
  console.error('BUILDD_API_KEY is required');
  process.exit(1);
}

const buildd = new BuilddClient(config);
const resolver = createWorkspaceResolver(config.projectsRoot);
const workerManager = new WorkerManager(config, resolver);

// SSE clients
const sseClients = new Set<ReadableStreamDefaultController>();

// Broadcast to all SSE clients
function broadcast(event: any) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const controller of sseClients) {
    try {
      controller.enqueue(new TextEncoder().encode(data));
    } catch {
      sseClients.delete(controller);
    }
  }
}

// Subscribe to worker events
workerManager.onEvent(broadcast);

// Serve static files
function serveStatic(path: string): Response {
  const uiDir = join(import.meta.dir, '..', 'ui');
  try {
    const content = readFileSync(join(uiDir, path));
    const ext = path.split('.').pop();
    const types: Record<string, string> = {
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      png: 'image/png',
      jpg: 'image/jpeg',
      svg: 'image/svg+xml',
    };
    return new Response(content, {
      headers: { 'Content-Type': types[ext || 'html'] || 'text/plain' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// Parse JSON body
async function parseBody(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// Handle requests
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // SSE endpoint
    if (path === '/api/events') {
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);

          // Send initial state
          const init = {
            type: 'init',
            workers: workerManager.getWorkers(),
            config: {
              projectsRoot: config.projectsRoot,
              builddServer: config.builddServer,
              maxConcurrent: config.maxConcurrent,
            },
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(init)}\n\n`));
        },
        cancel() {
          // Client disconnected
        },
      });

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // API endpoints
    if (path === '/api/tasks' && req.method === 'GET') {
      const tasks = await buildd.listTasks();
      return Response.json({ tasks }, { headers: corsHeaders });
    }

    if (path === '/api/workspaces' && req.method === 'GET') {
      const workspaces = await buildd.listWorkspaces();
      return Response.json({ workspaces }, { headers: corsHeaders });
    }

    if (path === '/api/workers' && req.method === 'GET') {
      return Response.json({ workers: workerManager.getWorkers() }, { headers: corsHeaders });
    }

    if (path === '/api/claim' && req.method === 'POST') {
      const body = await parseBody(req);
      const { taskId } = body;

      // Get the task first
      const tasks = await buildd.listTasks();
      const task = tasks.find((t: any) => t.id === taskId);

      if (!task) {
        return Response.json({ error: 'Task not found' }, { status: 404, headers: corsHeaders });
      }

      const worker = await workerManager.claimAndStart(task);
      if (!worker) {
        return Response.json({ error: 'Failed to claim' }, { status: 400, headers: corsHeaders });
      }

      return Response.json({ worker }, { headers: corsHeaders });
    }

    if (path === '/api/abort' && req.method === 'POST') {
      const body = await parseBody(req);
      await workerManager.abort(body.workerId);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (path === '/api/done' && req.method === 'POST') {
      const body = await parseBody(req);
      await workerManager.markDone(body.workerId);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (path === '/api/read' && req.method === 'POST') {
      const body = await parseBody(req);
      workerManager.markRead(body.workerId);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (path === '/api/tasks' && req.method === 'POST') {
      const body = await parseBody(req);
      const task = await buildd.createTask(body);
      return Response.json({ task }, { headers: corsHeaders });
    }

    // Send message to running worker session
    if (path.startsWith('/api/workers/') && path.endsWith('/send') && req.method === 'POST') {
      const workerId = path.split('/')[3];
      const body = await parseBody(req);
      const success = await workerManager.sendMessage(workerId, body.message);
      if (!success) {
        return Response.json({ error: 'Worker not found or not running' }, { status: 404, headers: corsHeaders });
      }
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    // Command endpoint for direct access (when server relays or user accesses directly)
    if (path === '/cmd' && req.method === 'POST') {
      const body = await parseBody(req);
      const { workerId, action, text } = body;

      if (!workerId || !action) {
        return Response.json({ error: 'workerId and action required' }, { status: 400, headers: corsHeaders });
      }

      const validActions = ['pause', 'resume', 'abort', 'message'];
      if (!validActions.includes(action)) {
        return Response.json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` }, { status: 400, headers: corsHeaders });
      }

      if (action === 'abort') {
        await workerManager.abort(workerId);
      } else if (action === 'message' && text) {
        const success = await workerManager.sendMessage(workerId, text);
        if (!success) {
          return Response.json({ error: 'Worker not found or not running' }, { status: 404, headers: corsHeaders });
        }
      }
      // pause/resume would need SDK support

      return Response.json({ ok: true, action }, { headers: corsHeaders });
    }

    // Worker-specific command shorthand
    if (path.startsWith('/api/workers/') && path.endsWith('/cmd') && req.method === 'POST') {
      const workerId = path.split('/')[3];
      const body = await parseBody(req);
      const { action, text } = body;

      if (!action) {
        return Response.json({ error: 'action required' }, { status: 400, headers: corsHeaders });
      }

      if (action === 'abort') {
        await workerManager.abort(workerId);
      } else if (action === 'message' && text) {
        const success = await workerManager.sendMessage(workerId, text);
        if (!success) {
          return Response.json({ error: 'Worker not found or not running' }, { status: 404, headers: corsHeaders });
        }
      }

      return Response.json({ ok: true, action }, { headers: corsHeaders });
    }

    // Debug endpoints for workspace resolution testing
    if (path === '/api/debug/directories' && req.method === 'GET') {
      return Response.json({
        projectsRoot: config.projectsRoot,
        directories: resolver.listLocalDirectories(),
        pathOverrides: resolver.getPathOverrides(),
        gitRepos: resolver.scanGitRepos(),
      }, { headers: corsHeaders });
    }

    if (path === '/api/debug/resolve' && req.method === 'POST') {
      const body = await parseBody(req);
      const { id, name, repo } = body;
      if (!name) {
        return Response.json({ error: 'name is required' }, { status: 400, headers: corsHeaders });
      }
      const debug = resolver.debugResolve({ id: id || '', name, repo });
      return Response.json(debug, { headers: corsHeaders });
    }

    if (path === '/api/debug/resolve-all' && req.method === 'GET') {
      // Fetch all workspaces from API and try to resolve each one
      const workspaces = await buildd.listWorkspaces();
      const results = workspaces.map((ws: any) => ({
        workspace: { id: ws.id, name: ws.name, repo: ws.repo },
        ...resolver.debugResolve({ id: ws.id, name: ws.name, repo: ws.repo }),
      }));
      return Response.json({
        projectsRoot: config.projectsRoot,
        localDirectories: resolver.listLocalDirectories(),
        pathOverrides: resolver.getPathOverrides(),
        workspaces: results,
      }, { headers: corsHeaders });
    }

    if (path === '/api/debug/override' && req.method === 'POST') {
      const body = await parseBody(req);
      const { workspaceName, localPath } = body;
      if (!workspaceName || !localPath) {
        return Response.json({ error: 'workspaceName and localPath required' }, { status: 400, headers: corsHeaders });
      }
      resolver.setPathOverride(workspaceName, localPath);
      return Response.json({ ok: true, overrides: resolver.getPathOverrides() }, { headers: corsHeaders });
    }

    // Static files
    if (path === '/' || path === '/index.html') {
      return serveStatic('index.html');
    }
    if (path === '/styles.css') {
      return serveStatic('styles.css');
    }
    if (path === '/app.js') {
      return serveStatic('app.js');
    }

    // SPA routing: /worker/:id routes to index.html (client handles routing)
    if (path.startsWith('/worker/')) {
      return serveStatic('index.html');
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`buildd local-ui running at http://localhost:${PORT}`);
