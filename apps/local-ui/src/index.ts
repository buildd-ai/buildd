import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { LocalUIConfig } from './types';
import { BuilddClient } from './buildd';
import { WorkerManager } from './workers';
import { createWorkspaceResolver, parseProjectRoots } from './workspace';

const PORT = parseInt(process.env.PORT || '8766');
const CONFIG_FILE = process.env.BUILDD_CONFIG || join(homedir(), '.buildd', 'config.json');

// Parse project roots (supports ~/path, comma-separated, auto-discovery)
const projectRoots = parseProjectRoots(process.env.PROJECTS_ROOT);

if (projectRoots.length === 0) {
  console.error('No valid project roots found. Set PROJECTS_ROOT env var (e.g., ~/projects,~/work)');
  process.exit(1);
}

// Load saved config
function loadSavedConfig(): { apiKey?: string } {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {
    // Ignore
  }
  return {};
}

// Save config
function saveConfig(data: { apiKey?: string }) {
  try {
    const dir = join(homedir(), '.buildd');
    if (!existsSync(dir)) {
      require('fs').mkdirSync(dir, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

const savedConfig = loadSavedConfig();

// Load config from env, falling back to saved config
const config: LocalUIConfig = {
  projectsRoot: projectRoots[0], // Primary for backwards compat
  projectRoots, // All roots
  builddServer: process.env.BUILDD_SERVER || 'https://buildd-three.vercel.app',
  apiKey: process.env.BUILDD_API_KEY || savedConfig.apiKey || '',
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '3'),
  model: process.env.MODEL || 'claude-sonnet-4-5-20250929',
  // Direct access URL (set this to your Coder subdomain or Tailscale IP)
  localUiUrl: process.env.LOCAL_UI_URL,
  // Pusher config for command relay from server
  pusherKey: process.env.PUSHER_KEY,
  pusherCluster: process.env.PUSHER_CLUSTER,
};

// Allow running without API key - will show setup UI
let buildd: BuilddClient | null = config.apiKey ? new BuilddClient(config) : null;
let workerManager: WorkerManager | null = config.apiKey ? new WorkerManager(config, createWorkspaceResolver(projectRoots)) : null;
const resolver = createWorkspaceResolver(projectRoots);

// Reinitialize clients after API key is set
function initializeClients() {
  if (config.apiKey) {
    buildd = new BuilddClient(config);
    workerManager = new WorkerManager(config, resolver);
    workerManager.onEvent(broadcast);
    console.log('API key configured, clients initialized');
  }
}

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

// Subscribe to worker events (if configured)
if (workerManager) {
  workerManager.onEvent(broadcast);
}

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
  idleTimeout: 120, // 2 minutes for long-running requests
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

    // Auth & Config endpoints (work without API key)

    // Check if configured
    if (path === '/api/config' && req.method === 'GET') {
      return Response.json({
        configured: !!config.apiKey,
        builddServer: config.builddServer,
        projectRoots: config.projectRoots,
      }, { headers: corsHeaders });
    }

    // Set API key
    if (path === '/api/config' && req.method === 'POST') {
      const body = await parseBody(req);
      const { apiKey } = body;

      if (!apiKey || !apiKey.startsWith('bld_')) {
        return Response.json({ error: 'Invalid API key format (should start with bld_)' }, { status: 400, headers: corsHeaders });
      }

      // Test the API key
      const testConfig = { ...config, apiKey };
      const testClient = new BuilddClient(testConfig);
      try {
        await testClient.listWorkspaces();
      } catch (err) {
        return Response.json({ error: 'Invalid API key - failed to connect to server' }, { status: 401, headers: corsHeaders });
      }

      // Save and activate
      config.apiKey = apiKey;
      saveConfig({ apiKey });
      initializeClients();

      return Response.json({ ok: true, configured: true }, { headers: corsHeaders });
    }

    // OAuth: Redirect to server login
    if (path === '/auth/login') {
      const callbackUrl = `http://localhost:${PORT}/auth/callback`;
      const loginUrl = `${config.builddServer}/api/auth/local-ui?callback=${encodeURIComponent(callbackUrl)}`;
      return Response.redirect(loginUrl, 302);
    }

    // OAuth: Callback from server with token
    if (path === '/auth/callback') {
      const token = url.searchParams.get('token');
      const error = url.searchParams.get('error');

      if (error) {
        return new Response(`
          <!DOCTYPE html>
          <html>
          <head><title>Auth Error</title></head>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1>Authentication Failed</h1>
            <p>${error}</p>
            <a href="/">Go back</a>
          </body>
          </html>
        `, { headers: { 'Content-Type': 'text/html' } });
      }

      if (token && token.startsWith('bld_')) {
        config.apiKey = token;
        saveConfig({ apiKey: token });
        initializeClients();

        return new Response(`
          <!DOCTYPE html>
          <html>
          <head><title>Auth Success</title></head>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1>Success!</h1>
            <p>API key configured. Redirecting...</p>
            <script>setTimeout(() => window.location.href = '/', 1000);</script>
          </body>
          </html>
        `, { headers: { 'Content-Type': 'text/html' } });
      }

      return new Response(`
        <!DOCTYPE html>
        <html>
        <head><title>Auth Error</title></head>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1>Invalid Token</h1>
          <p>No valid token received</p>
          <a href="/">Go back</a>
        </body>
        </html>
      `, { headers: { 'Content-Type': 'text/html' } });
    }

    // SSE endpoint
    if (path === '/api/events') {
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);

          // Send initial state
          const init = {
            type: 'init',
            configured: !!config.apiKey,
            workers: workerManager?.getWorkers() || [],
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

    // API endpoints that require authentication
    if (!buildd || !workerManager) {
      if (['/api/tasks', '/api/workspaces', '/api/workers', '/api/claim', '/api/abort', '/api/done', '/api/read'].some(p => path.startsWith(p))) {
        return Response.json({ error: 'Not configured. Set API key first.', needsSetup: true }, { status: 401, headers: corsHeaders });
      }
    }

    if (path === '/api/tasks' && req.method === 'GET') {
      try {
        const tasks = await buildd!.listTasks();
        return Response.json({ tasks }, { headers: corsHeaders });
      } catch (err: any) {
        // If 401, API key is invalid - clear and show setup
        if (err.message?.includes('401')) {
          config.apiKey = '';
          buildd = null;
          workerManager = null;
          return Response.json({ error: 'API key invalid', needsSetup: true }, { status: 401, headers: corsHeaders });
        }
        throw err;
      }
    }

    if (path === '/api/workspaces' && req.method === 'GET') {
      const workspaces = await buildd!.listWorkspaces();
      return Response.json({ workspaces }, { headers: corsHeaders });
    }

    if (path === '/api/workers' && req.method === 'GET') {
      return Response.json({ workers: workerManager!.getWorkers() }, { headers: corsHeaders });
    }

    if (path === '/api/claim' && req.method === 'POST') {
      const body = await parseBody(req);
      const { taskId } = body;

      // Get the task first
      const tasks = await buildd!.listTasks();
      const task = tasks.find((t: any) => t.id === taskId);

      if (!task) {
        return Response.json({ error: 'Task not found' }, { status: 404, headers: corsHeaders });
      }

      const worker = await workerManager!.claimAndStart(task);
      if (!worker) {
        return Response.json({ error: 'Failed to claim' }, { status: 400, headers: corsHeaders });
      }

      return Response.json({ worker }, { headers: corsHeaders });
    }

    if (path === '/api/abort' && req.method === 'POST') {
      const body = await parseBody(req);
      await workerManager!.abort(body.workerId);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (path === '/api/done' && req.method === 'POST') {
      const body = await parseBody(req);
      await workerManager!.markDone(body.workerId);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (path === '/api/read' && req.method === 'POST') {
      const body = await parseBody(req);
      workerManager!.markRead(body.workerId);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (path === '/api/tasks' && req.method === 'POST') {
      const body = await parseBody(req);
      const task = await buildd!.createTask(body);
      return Response.json({ task }, { headers: corsHeaders });
    }

    // Send message to running worker session
    if (path.startsWith('/api/workers/') && path.endsWith('/send') && req.method === 'POST') {
      if (!workerManager) {
        return Response.json({ error: 'Not configured', needsSetup: true }, { status: 401, headers: corsHeaders });
      }
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
      if (!workerManager) {
        return Response.json({ error: 'Not configured', needsSetup: true }, { status: 401, headers: corsHeaders });
      }
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
      if (!workerManager) {
        return Response.json({ error: 'Not configured', needsSetup: true }, { status: 401, headers: corsHeaders });
      }
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

    // Local repositories endpoint - shows all git repos found locally
    if (path === '/api/local-repos' && req.method === 'GET') {
      const repos = resolver.scanGitRepos();
      // Enrich with workspace match info if configured
      const workspaces = buildd ? await buildd.listWorkspaces() : [];

      const enrichedRepos = repos.map(repo => {
        const matchedWorkspace = workspaces.find((ws: any) => {
          const normalizedWs = ws.repo?.toLowerCase().replace(/\.git$/, '').split('/').slice(-2).join('/');
          return normalizedWs === repo.normalizedUrl;
        });

        return {
          ...repo,
          name: repo.path.split('/').pop(),
          workspaceId: matchedWorkspace?.id || null,
          workspaceName: matchedWorkspace?.name || null,
          synced: !!matchedWorkspace,
        };
      });

      return Response.json({ repos: enrichedRepos }, { headers: corsHeaders });
    }

    // Create workspace from local repo
    if (path === '/api/local-repos/sync' && req.method === 'POST') {
      if (!buildd) {
        return Response.json({ error: 'Not configured', needsSetup: true }, { status: 401, headers: corsHeaders });
      }

      const body = await parseBody(req);
      const { repoPath, name } = body;

      if (!repoPath) {
        return Response.json({ error: 'repoPath required' }, { status: 400, headers: corsHeaders });
      }

      // Get git remote for this repo
      const repos = resolver.scanGitRepos();
      const repo = repos.find(r => r.path === repoPath);

      if (!repo || !repo.remoteUrl) {
        return Response.json({ error: 'Not a git repository or no remote configured' }, { status: 400, headers: corsHeaders });
      }

      // Create workspace on server
      try {
        const workspace = await buildd.createWorkspace({
          name: name || repo.path.split('/').pop() || 'unnamed',
          repoUrl: repo.remoteUrl,
        });
        return Response.json({ workspace }, { headers: corsHeaders });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // Debug endpoints for workspace resolution testing
    if (path === '/api/debug/directories' && req.method === 'GET') {
      return Response.json({
        projectRoots: resolver.getProjectRoots(),
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
      const workspaces = buildd ? await buildd.listWorkspaces() : [];
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
console.log(`Scanning ${projectRoots.length} project root(s)...`);
const repos = resolver.scanGitRepos();
console.log(`Found ${repos.length} git repositories:`);
for (const repo of repos) {
  if (repo.normalizedUrl) {
    console.log(`  ${repo.normalizedUrl} -> ${repo.path}`);
  }
}
if (!config.apiKey) {
  console.log('');
  console.log('No API key configured. Visit http://localhost:' + PORT + ' to set up.');
}
