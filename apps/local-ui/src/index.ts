import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { LocalUIConfig, LLMProvider, ProviderConfig } from './types';
import { BuilddClient } from './buildd';
import { WorkerManager } from './workers';
import { createWorkspaceResolver, parseProjectRoots } from './workspace';
import { Outbox } from './outbox';
import { scanSkills } from './skills';

const PORT = parseInt(process.env.PORT || '8766');
const CONFIG_FILE = process.env.BUILDD_CONFIG || join(homedir(), '.buildd', 'config.json');
const REPOS_CACHE_FILE = join(homedir(), '.buildd', 'repos-cache.json');
const BROWSER_OPEN_FILE = join(homedir(), '.buildd', '.last-browser-open');

// Parse project roots (supports ~/path, comma-separated, auto-discovery)
const projectRoots = parseProjectRoots(process.env.PROJECTS_ROOT);

if (projectRoots.length === 0) {
  console.error('No valid project roots found. Set PROJECTS_ROOT env var (e.g., ~/projects,~/work)');
  process.exit(1);
}

// =============================================================================
// CONFIG MANAGEMENT
// =============================================================================
// Single source of truth: ~/.buildd/config.json
// Env vars (BUILDD_API_KEY, etc.) override for CI/Docker but are NOT recommended
// for normal use. The web UI handles API key setup via OAuth.
// =============================================================================

interface SavedConfig {
  apiKey?: string;
  serverless?: boolean;
  model?: string;
  maxConcurrent?: number; // Max concurrent workers (default: 3)
  acceptRemoteTasks?: boolean; // Accept task assignments from dashboard (default: true)
  bypassPermissions?: boolean; // Bypass permission prompts (dangerous commands still blocked)
  openBrowser?: boolean; // Auto-open browser on startup
  builddServer?: string; // Server URL override
  localUiUrl?: string; // Direct access URL override (Tailscale IP, Coder subdomain, etc.)
  pusherKey?: string; // Pusher public key for realtime events
  pusherCluster?: string; // Pusher cluster (e.g. 'us2')
  // LLM provider settings
  llmProvider?: LLMProvider; // 'anthropic' or 'openrouter'
  llmApiKey?: string; // Provider-specific API key (OpenRouter key, etc.)
  llmBaseUrl?: string; // Custom base URL
}

function loadSavedConfig(): SavedConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      return {
        apiKey: data.apiKey?.trim(), // Always trim to avoid whitespace issues
        serverless: data.serverless,
        model: data.model,
        maxConcurrent: data.maxConcurrent,
        acceptRemoteTasks: data.acceptRemoteTasks,
        bypassPermissions: data.bypassPermissions,
        openBrowser: data.openBrowser,
        builddServer: data.builddServer,
        localUiUrl: data.localUiUrl,
        pusherKey: data.pusherKey,
        pusherCluster: data.pusherCluster,
        llmProvider: data.llmProvider,
        llmApiKey: data.llmApiKey,
        llmBaseUrl: data.llmBaseUrl,
      };
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
  return {};
}

// Create clickable terminal link using OSC 8 escape sequence
function terminalLink(url: string, text?: string): string {
  const displayText = text || url;
  return `\x1b]8;;${url}\x07${displayText}\x1b]8;;\x07`;
}

// Prompt user for yes/no input
async function promptYesNo(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/n]: `);

  return new Promise((resolve) => {
    const onData = (data: Buffer) => {
      const input = data.toString().trim().toLowerCase();
      if (input === 'y' || input === 'yes') {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(true);
      } else if (input === 'n' || input === 'no') {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(false);
      } else {
        process.stdout.write('Please enter y or n: ');
      }
    };

    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

function saveConfig(data: Partial<SavedConfig>) {
  try {
    const dir = join(homedir(), '.buildd');
    if (!existsSync(dir)) {
      const { mkdirSync } = require('fs');
      mkdirSync(dir, { recursive: true });
    }
    // Merge with existing, but don't recursively call loadSavedConfig
    let existing: SavedConfig = {};
    if (existsSync(CONFIG_FILE)) {
      try {
        existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      } catch { /* ignore */ }
    }
    const merged = { ...existing, ...data };
    // Clean up: remove empty/null values
    if (!merged.apiKey) delete merged.apiKey;
    writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
    console.log(`Config saved to ${CONFIG_FILE}`);
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

// Load config with clear priority logging
const savedConfig = loadSavedConfig();
const envApiKey = process.env.BUILDD_API_KEY?.trim();

// Determine API key source
let apiKeySource: 'env' | 'config' | 'none' = 'none';
let resolvedApiKey = '';
if (envApiKey) {
  resolvedApiKey = envApiKey;
  apiKeySource = 'env';
} else if (savedConfig.apiKey) {
  resolvedApiKey = savedConfig.apiKey;
  apiKeySource = 'config';
}

// Log config source clearly
console.log('');
console.log('Config:');
console.log(`  File: ${CONFIG_FILE}`);
if (apiKeySource === 'env') {
  console.log(`  API Key: from BUILDD_API_KEY env var (${resolvedApiKey.slice(0, 10)}...${resolvedApiKey.slice(-4)})`);
  console.log('  Note: Env var overrides config.json. Unset BUILDD_API_KEY to use saved config.');
} else if (apiKeySource === 'config') {
  console.log(`  API Key: from config.json (${resolvedApiKey.slice(0, 10)}...${resolvedApiKey.slice(-4)})`);
} else {
  console.log('  API Key: not configured');
}
console.log(`  Serverless: ${savedConfig.serverless || false}`);
console.log('');

// Repos cache
interface CachedRepo {
  path: string;
  remoteUrl: string | null;
  normalizedUrl: string | null;
}

let cachedRepos: CachedRepo[] | null = null;

function loadReposCache(): CachedRepo[] | null {
  try {
    if (existsSync(REPOS_CACHE_FILE)) {
      const data = JSON.parse(readFileSync(REPOS_CACHE_FILE, 'utf-8'));
      if (data.repos && Array.isArray(data.repos)) {
        console.log(`Loaded ${data.repos.length} repos from cache`);
        return data.repos;
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

function saveReposCache(repos: CachedRepo[]) {
  try {
    const dir = join(homedir(), '.buildd');
    if (!existsSync(dir)) {
      const { mkdirSync } = require('fs');
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(REPOS_CACHE_FILE, JSON.stringify({ repos, updatedAt: Date.now() }, null, 2));
    console.log(`Saved ${repos.length} repos to cache`);
  } catch (err) {
    console.error('Failed to save repos cache:', err);
  }
}

let reposLoadedFromCache = false;

function getRepos(forceRescan = false): CachedRepo[] {
  if (!forceRescan && cachedRepos) {
    return cachedRepos;
  }

  if (!forceRescan) {
    const cached = loadReposCache();
    if (cached) {
      cachedRepos = cached;
      reposLoadedFromCache = true;
      return cached;
    }
  }

  // Scan fresh
  console.log('Scanning for git repositories...');
  const scanned = resolver.scanGitRepos();
  cachedRepos = scanned;
  reposLoadedFromCache = false;
  saveReposCache(scanned);
  return scanned;
}

// Auto-detect Tailscale IPv4 (runs once at startup, fails silently)
function detectTailscaleIp(): string | null {
  try {
    const result = Bun.spawnSync(['tailscale', 'ip', '-4']);
    if (result.exitCode === 0) {
      const ip = new TextDecoder().decode(result.stdout).trim();
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    }
  } catch {
    // tailscale not installed or not running — that's fine
  }
  return null;
}

// Resolve localUiUrl: env var > config.json > Tailscale auto-detect > localhost
function resolveLocalUiUrl(): string {
  if (process.env.LOCAL_UI_URL) return process.env.LOCAL_UI_URL;
  if (savedConfig.localUiUrl) return savedConfig.localUiUrl;
  const tsIp = detectTailscaleIp();
  if (tsIp) {
    console.log(`  Tailscale IP detected: ${tsIp}`);
    return `http://${tsIp}:${PORT}`;
  }
  return `http://localhost:${PORT}`;
}

const resolvedLocalUiUrl = resolveLocalUiUrl();

// Build LLM provider config
function buildProviderConfig(): ProviderConfig | undefined {
  const provider = (process.env.LLM_PROVIDER || savedConfig.llmProvider || 'anthropic') as LLMProvider;
  if (provider === 'anthropic') {
    // Default Anthropic - no special config needed (uses ANTHROPIC_API_KEY or Claude OAuth)
    return undefined;
  }

  // OpenRouter or custom provider
  return {
    provider,
    apiKey: process.env.LLM_API_KEY || savedConfig.llmApiKey,
    baseUrl: process.env.LLM_BASE_URL || savedConfig.llmBaseUrl ||
      (provider === 'openrouter' ? 'https://openrouter.ai/api' : undefined),
  };
}

// Build runtime config
const config: LocalUIConfig = {
  projectsRoot: projectRoots[0], // Primary for backwards compat
  projectRoots, // All roots
  builddServer: process.env.BUILDD_SERVER || savedConfig.builddServer || 'https://buildd.dev',
  apiKey: resolvedApiKey,
  maxConcurrent: savedConfig.maxConcurrent || parseInt(process.env.MAX_CONCURRENT || '3'),
  model: process.env.MODEL || savedConfig.model || 'claude-opus-4-6',
  // LLM provider (OpenRouter, etc.)
  llmProvider: buildProviderConfig(),
  // Serverless only if no API key configured
  serverless: resolvedApiKey ? false : (savedConfig.serverless || false),
  // Direct access URL (auto-detected or explicit override)
  localUiUrl: resolvedLocalUiUrl,
  // Pusher config for command relay from server
  pusherKey: process.env.PUSHER_KEY || process.env.NEXT_PUBLIC_PUSHER_KEY || savedConfig.pusherKey,
  pusherCluster: process.env.PUSHER_CLUSTER || process.env.NEXT_PUBLIC_PUSHER_CLUSTER || savedConfig.pusherCluster,
  // Accept remote task assignments (default: true)
  acceptRemoteTasks: savedConfig.acceptRemoteTasks !== false,
  // Bypass permission prompts (default: false)
  bypassPermissions: savedConfig.bypassPermissions || false,
};

const resolver = createWorkspaceResolver(projectRoots);

// Initialize clients (null if no API key - will show setup UI)
let buildd: BuilddClient | null = config.apiKey ? new BuilddClient(config) : null;
let workerManager: WorkerManager | null = config.apiKey ? new WorkerManager(config, resolver) : null;

// Offline outbox for queuing failed mutations (not used in permanent serverless)
const outbox = new Outbox();

// Auto-update state
interface UpdateState {
  currentCommit: string | null;
  latestCommit: string | null;
  updateAvailable: boolean;
  updating: boolean;
}

const updateState: UpdateState = {
  currentCommit: getCurrentCommit(),
  latestCommit: null,
  updateAvailable: false,
  updating: false,
};

// Cached models from Anthropic API (auto-refreshes every hour)
let modelsCache: { models: { id: string; name: string }[]; fetchedAt: number } | null = null;
const MODELS_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const FALLBACK_MODELS = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
];

async function fetchAnthropicModels(): Promise<{ id: string; name: string }[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return FALLBACK_MODELS;

  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!res.ok) return FALLBACK_MODELS;

    const data = await res.json() as { data?: { id: string; display_name?: string }[] };
    const models = (data.data || [])
      .filter((m) => m.id.startsWith('claude-') && !m.id.includes('claude-2') && !m.id.includes('claude-3'))
      .map((m) => ({ id: m.id, name: m.display_name || m.id }));

    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

async function getCachedModels(): Promise<{ id: string; name: string }[]> {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL) {
    return modelsCache.models;
  }
  const models = await fetchAnthropicModels();
  modelsCache = { models, fetchedAt: Date.now() };
  return models;
}

function setLatestCommit(sha: string) {
  if (updateState.latestCommit === sha) return;
  updateState.latestCommit = sha;
  const wasAvailable = updateState.updateAvailable;
  updateState.updateAvailable = checkForUpdate(updateState.currentCommit, sha);
  if (updateState.updateAvailable && !wasAvailable) {
    console.log(`Update available: ${updateState.currentCommit?.slice(0, 7)} → ${sha.slice(0, 7)}`);
    broadcast({ type: 'update_available', currentCommit: updateState.currentCommit, latestCommit: sha });
  }
}

// Serverless mode version polling (every 30 minutes)
let versionPollInterval: Timer | undefined;
async function pollVersion() {
  try {
    const res = await fetch(`${config.builddServer}/api/version`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.latestCommit) {
        setLatestCommit(data.latestCommit);
      }
    }
  } catch {
    // Non-fatal
  }
}

function attachOutbox(client: BuilddClient | null) {
  if (client && !config.serverless) {
    client.setOutbox(outbox);
    // Set up flush handler to replay entries via raw fetch
    outbox.setFlushHandler(async (entry) => {
      try {
        const res = await fetch(`${config.builddServer}${entry.endpoint}`, {
          method: entry.method,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          },
          body: entry.body,
        });
        // 2xx or 409 (already completed) = success
        return res.ok || res.status === 409;
      } catch {
        return false;
      }
    });
  }
}

attachOutbox(buildd);

// Try flushing outbox on startup if connected
if (buildd && outbox.count() > 0) {
  setTimeout(() => outbox.flush(), 5_000);
}

// Current account info (fetched when clients initialize)
let currentAccountId: string | null = null;

// Fetch and store account info
async function fetchAccountInfo() {
  if (buildd) {
    const info = await buildd.getAccountInfo();
    if (info) {
      currentAccountId = info.id;
      console.log(`Account: ${info.name} (${info.id.slice(0, 8)}...)`);
    }
  }
}

// Reinitialize clients after API key is set
async function initializeClients() {
  if (config.apiKey) {
    buildd = new BuilddClient(config);
    attachOutbox(buildd);
    workerManager = new WorkerManager(config, resolver);
    workerManager.onEvent(broadcast);
    console.log('API key configured, clients initialized');
    await fetchAccountInfo();
    // Flush any queued mutations now that we're connected
    if (outbox.count() > 0) {
      outbox.flush();
    }
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

// Fetch account info on startup if already configured
if (buildd) {
  fetchAccountInfo();
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
  development: false, // Disable Bun's HTML error overlay; we handle errors in JSON
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

    // viewerToken auth for remote access to worker data endpoints
    // Localhost and private IP requests bypass auth; remote requests need ?token= or Authorization header
    const isPrivateOrLocalhost = (hostname: string): boolean => {
      // localhost variants
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;

      // Private IPv4 ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 100.64-127.x.x (CGNAT/Tailscale)
      const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (ipv4Match) {
        const [, a, b] = ipv4Match.map(Number);
        return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 100 && b >= 64 && b <= 127;
      }

      // Private IPv6 (fc00::/7, fe80::/10)
      if (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')) return true;

      return false;
    };

    const viewerProtectedPaths = ['/api/workers', '/api/events', '/health'];
    const needsViewerAuth = !isPrivateOrLocalhost(url.hostname) && viewerProtectedPaths.some(p => path === p || path.startsWith(p + '/'));
    if (needsViewerAuth) {
      const expectedToken = workerManager?.getViewerToken();
      const providedToken = url.searchParams.get('token') || req.headers.get('authorization')?.replace('Bearer ', '');
      if (!expectedToken || providedToken !== expectedToken) {
        return Response.json({ error: 'Unauthorized - invalid viewer token' }, { status: 401, headers: corsHeaders });
      }
    }

    // Health check for browser-side capacity pings
    if (path === '/health' && req.method === 'GET') {
      const activeCount = workerManager
        ? Array.from(workerManager.getWorkers()).filter(
            (w: any) => w.status === 'working' || w.status === 'waiting'
          ).length
        : 0;
      return Response.json({
        alive: true,
        activeWorkers: activeCount,
        maxConcurrent: config.maxConcurrent,
        capacity: Math.max(0, config.maxConcurrent - activeCount),
      }, { headers: corsHeaders });
    }

    // Auth & Config endpoints (work without API key)

    // Check if configured
    if (path === '/api/config' && req.method === 'GET') {
      const authStatus = workerManager?.getAuthStatus() || { hasCredentials: false };
      return Response.json({
        configured: !!config.apiKey,
        serverless: config.serverless || false,
        builddServer: config.builddServer,
        projectRoots: config.projectRoots,
        hasClaudeCredentials: authStatus.hasCredentials,
        model: config.model,
        maxConcurrent: config.maxConcurrent,
        acceptRemoteTasks: config.acceptRemoteTasks !== false,
        bypassPermissions: config.bypassPermissions || false,
        openBrowser: savedConfig.openBrowser !== false, // default true
        accountId: currentAccountId,
        viewerToken: workerManager?.getViewerToken() || null,
        outboxCount: outbox.count(),
        // LLM provider info
        llmProvider: config.llmProvider?.provider || 'anthropic',
        llmBaseUrl: config.llmProvider?.baseUrl,
        hasLlmApiKey: !!config.llmProvider?.apiKey,
      }, { headers: corsHeaders });
    }

    // Enable serverless mode (local-only, no server) - preserves API key for easy reconnect
    if (path === '/api/config/serverless' && req.method === 'POST') {
      config.serverless = true;
      buildd = null;
      workerManager = null;
      saveConfig({ serverless: true });

      return Response.json({ ok: true, serverless: true }, { headers: corsHeaders });
    }

    // Disable serverless mode - reconnect to server if API key is available
    if (path === '/api/config/serverless' && req.method === 'DELETE') {
      config.serverless = false;
      saveConfig({ serverless: false });

      // Restore server connection if API key exists
      if (config.apiKey) {
        buildd = new BuilddClient(config);
        attachOutbox(buildd);
        workerManager = new WorkerManager(config, resolver);
        workerManager.onEvent(broadcast);
        console.log('Server connection restored');
        await fetchAccountInfo();
        // Flush any queued mutations from when server was unreachable
        if (outbox.count() > 0) {
          outbox.flush();
        }
      }

      return Response.json({ ok: true, serverless: false, connected: !!config.apiKey }, { headers: corsHeaders });
    }

    // Update server URL
    if (path === '/api/config/server' && req.method === 'POST') {
      const body = await parseBody(req);
      const { server } = body;

      if (!server || typeof server !== 'string') {
        return Response.json({ error: 'server URL required' }, { status: 400, headers: corsHeaders });
      }

      // Basic URL validation
      const trimmed = server.trim().replace(/\/+$/, ''); // Remove trailing slashes
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        return Response.json({ error: 'Server URL must start with http:// or https://' }, { status: 400, headers: corsHeaders });
      }

      config.builddServer = trimmed;
      saveConfig({ builddServer: trimmed });

      // Reinitialize clients with new server URL
      if (config.apiKey) {
        buildd = new BuilddClient(config);
        attachOutbox(buildd);
        workerManager = new WorkerManager(config, resolver);
        workerManager.onEvent(broadcast);
        await fetchAccountInfo();
        // Flush queued mutations to the new server
        if (outbox.count() > 0) {
          outbox.flush();
        }
      }

      console.log(`Server URL updated to: ${trimmed}`);
      return Response.json({ ok: true, builddServer: trimmed }, { headers: corsHeaders });
    }

    // List available models (fetched from Anthropic API, cached 1hr)
    if (path === '/api/config/models' && req.method === 'GET') {
      const models = await getCachedModels();
      return Response.json({ models }, { headers: corsHeaders });
    }

    // Update model setting
    if (path === '/api/config/model' && req.method === 'POST') {
      const body = await parseBody(req);
      const { model } = body;

      if (typeof model !== 'string') {
        return Response.json({ error: 'Invalid model' }, { status: 400, headers: corsHeaders });
      }

      config.model = model;
      saveConfig({ model });

      return Response.json({ ok: true, model }, { headers: corsHeaders });
    }

    // Toggle accept remote tasks setting
    if (path === '/api/config/accept-remote-tasks' && req.method === 'POST') {
      const body = await parseBody(req);
      const { enabled } = body;

      config.acceptRemoteTasks = enabled !== false;
      saveConfig({ acceptRemoteTasks: config.acceptRemoteTasks });

      // Notify worker manager to update Pusher subscriptions
      if (workerManager) {
        workerManager.setAcceptRemoteTasks(config.acceptRemoteTasks);
      }

      return Response.json({ ok: true, acceptRemoteTasks: config.acceptRemoteTasks }, { headers: corsHeaders });
    }

    // Toggle bypass permissions setting
    if (path === '/api/config/bypass-permissions' && req.method === 'POST') {
      const body = await parseBody(req);
      const { enabled } = body;

      config.bypassPermissions = enabled === true;
      saveConfig({ bypassPermissions: config.bypassPermissions });

      return Response.json({ ok: true, bypassPermissions: config.bypassPermissions }, { headers: corsHeaders });
    }

    // Toggle open browser setting
    if (path === '/api/config/open-browser' && req.method === 'POST') {
      const body = await parseBody(req);
      const { enabled } = body;

      saveConfig({ openBrowser: enabled !== false });

      return Response.json({ ok: true, openBrowser: enabled !== false }, { headers: corsHeaders });
    }

    // Update max concurrent setting
    if (path === '/api/config/max-concurrent' && req.method === 'POST') {
      const body = await parseBody(req);
      const { maxConcurrent } = body;

      if (typeof maxConcurrent !== 'number' || maxConcurrent < 1 || maxConcurrent > 20) {
        return Response.json({ error: 'maxConcurrent must be 1-20' }, { status: 400, headers: corsHeaders });
      }

      config.maxConcurrent = maxConcurrent;
      saveConfig({ maxConcurrent });

      return Response.json({ ok: true, maxConcurrent }, { headers: corsHeaders });
    }

    // Update LLM provider settings (OpenRouter, etc.)
    if (path === '/api/config/llm-provider' && req.method === 'POST') {
      const body = await parseBody(req);
      const { provider, apiKey: llmApiKey, baseUrl } = body;

      const validProviders = ['anthropic', 'openrouter'];
      if (!provider || !validProviders.includes(provider)) {
        return Response.json({ error: 'Invalid provider. Must be: anthropic, openrouter' }, { status: 400, headers: corsHeaders });
      }

      if (provider === 'openrouter' && !llmApiKey) {
        return Response.json({ error: 'OpenRouter requires an API key (sk-or-...)' }, { status: 400, headers: corsHeaders });
      }

      // Update config
      if (provider === 'anthropic') {
        config.llmProvider = undefined;
        saveConfig({ llmProvider: 'anthropic', llmApiKey: undefined, llmBaseUrl: undefined });
      } else {
        config.llmProvider = {
          provider,
          apiKey: llmApiKey,
          baseUrl: baseUrl || 'https://openrouter.ai/api',
        };
        saveConfig({
          llmProvider: provider,
          llmApiKey: llmApiKey,
          llmBaseUrl: baseUrl || 'https://openrouter.ai/api',
        });
      }

      // Reinitialize worker manager with new provider config
      if (workerManager) {
        workerManager.destroy();
        workerManager = new WorkerManager(config, resolver);
        workerManager.onEvent(broadcast);
      }

      return Response.json({
        ok: true,
        provider,
        baseUrl: config.llmProvider?.baseUrl,
      }, { headers: corsHeaders });
    }

    // Get LLM provider info
    if (path === '/api/config/llm-provider' && req.method === 'GET') {
      return Response.json({
        provider: config.llmProvider?.provider || 'anthropic',
        baseUrl: config.llmProvider?.baseUrl,
        hasApiKey: !!config.llmProvider?.apiKey,
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
      const loginUrl = `${config.builddServer}/api/auth/cli?client=local-ui&callback=${encodeURIComponent(callbackUrl)}`;
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
      let sseController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          sseController = controller;
          sseClients.add(controller);

          // Send initial state (must include all config fields that the frontend uses)
          const init = {
            type: 'init',
            configured: !!config.apiKey,
            workers: workerManager?.getWorkers() || [],
            config: {
              projectsRoot: config.projectsRoot,
              builddServer: config.builddServer,
              maxConcurrent: config.maxConcurrent,
              model: config.model,
              bypassPermissions: config.bypassPermissions || false,
              acceptRemoteTasks: config.acceptRemoteTasks !== false,
              openBrowser: savedConfig.openBrowser !== false,
            },
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(init)}\n\n`));
        },
        cancel() {
          if (sseController) sseClients.delete(sseController);
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

    // API endpoints that require authentication (unless serverless)
    if (!buildd || !workerManager) {
      // In serverless mode, allow local workspace operations
      if (config.serverless) {
        // Allow combined-workspaces and local-repos in serverless
        if (path === '/api/combined-workspaces' || path === '/api/local-repos') {
          // Will be handled below
        } else if (['/api/tasks', '/api/workspaces', '/api/workers', '/api/claim', '/api/abort', '/api/retry', '/api/done', '/api/read'].some(p => path.startsWith(p))) {
          return Response.json({ error: 'Server features not available in local-only mode', serverless: true }, { status: 400, headers: corsHeaders });
        }
      } else {
        if (['/api/tasks', '/api/workspaces', '/api/workers', '/api/claim', '/api/abort', '/api/retry', '/api/done', '/api/read'].some(p => path.startsWith(p))) {
          return Response.json({ error: 'Not configured. Set API key first.', needsSetup: true }, { status: 401, headers: corsHeaders });
        }
      }
    }

    if (path === '/api/tasks' && req.method === 'GET') {
      try {
        const tasks = await buildd!.listTasks();
        return Response.json({ tasks }, { headers: corsHeaders });
      } catch (err: any) {
        // If 401, API key is invalid - clear and show setup
        if (err.message?.includes('401')) {
          console.log('API key rejected by server, clearing config');
          config.apiKey = '';
          buildd = null;
          workerManager = null;
          // Also clear saved config so restart doesn't reuse bad key
          saveConfig({ apiKey: '' });
          return Response.json({ error: 'API key invalid', needsSetup: true }, { status: 401, headers: corsHeaders });
        }
        console.error('Failed to list tasks:', err.message);
        return Response.json({ error: err.message || 'Failed to load tasks', tasks: [] }, { status: 502, headers: corsHeaders });
      }
    }

    if (path === '/api/workspaces' && req.method === 'GET') {
      try {
        const workspaces = await buildd!.listWorkspaces();
        return Response.json({ workspaces }, { headers: corsHeaders });
      } catch (err: any) {
        console.error('Failed to list workspaces:', err.message);
        return Response.json({ error: err.message || 'Failed to load workspaces', workspaces: [] }, { status: 502, headers: corsHeaders });
      }
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

      try {
        const worker = await workerManager!.claimAndStart(task);
        if (!worker) {
          return Response.json({ error: 'Failed to claim' }, { status: 400, headers: corsHeaders });
        }
        return Response.json({ worker }, { headers: corsHeaders });
      } catch (err: any) {
        return Response.json({ error: err.message || 'Failed to claim' }, { status: 400, headers: corsHeaders });
      }
    }

    if (path === '/api/abort' && req.method === 'POST') {
      const body = await parseBody(req);
      await workerManager!.abort(body.workerId);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (path === '/api/retry' && req.method === 'POST') {
      const body = await parseBody(req);
      await workerManager!.retry(body.workerId);
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
      try {
        const task = await buildd!.createTask(body);
        return Response.json({ task }, { headers: corsHeaders });
      } catch (err: any) {
        console.error('Failed to create task:', err.message);
        return Response.json({ error: err.message || 'Failed to create task' }, { status: 502, headers: corsHeaders });
      }
    }

    // Delete a task
    const deleteTaskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (deleteTaskMatch && req.method === 'DELETE') {
      const taskId = deleteTaskMatch[1];
      try {
        const result = await buildd!.deleteTask(taskId);
        if (!result.success) {
          // Check for auth error
          if (result.error?.includes('401')) {
            console.log('API key rejected by server, clearing config');
            config.apiKey = '';
            buildd = null;
            workerManager = null;
            saveConfig({ apiKey: '' });
            return Response.json({ error: 'API key invalid', needsSetup: true }, { status: 401, headers: corsHeaders });
          }
          return Response.json({ error: result.error || 'Failed to delete task' }, { status: 400, headers: corsHeaders });
        }
        return Response.json({ success: true }, { headers: corsHeaders });
      } catch (err: any) {
        return Response.json({ error: err.message || 'Failed to delete task' }, { status: 400, headers: corsHeaders });
      }
    }

    // Takeover an assigned task (force reassign + claim)
    if (path === '/api/takeover' && req.method === 'POST') {
      const body = await parseBody(req);
      const { taskId } = body;

      if (!taskId) {
        return Response.json({ error: 'taskId required' }, { status: 400, headers: corsHeaders });
      }

      try {
        // Force reassign the task (resets it to pending)
        const reassignResult = await buildd!.reassignTask(taskId, true);

        if (!reassignResult.reassigned) {
          return Response.json({
            error: reassignResult.reason || 'Cannot take over task',
            canTakeover: reassignResult.canTakeover,
            isStale: reassignResult.isStale,
          }, { status: 400, headers: corsHeaders });
        }

        // Refetch task and claim it
        const tasks = await buildd!.listTasks();
        const task = tasks.find((t: any) => t.id === taskId);

        if (!task) {
          return Response.json({ error: 'Task not found after reassign' }, { status: 404, headers: corsHeaders });
        }

        const worker = await workerManager!.claimAndStart(task);
        if (!worker) {
          return Response.json({ error: 'Failed to claim task after reassign' }, { status: 400, headers: corsHeaders });
        }

        return Response.json({ worker, reassigned: true }, { headers: corsHeaders });
      } catch (err: any) {
        // Check for auth error
        if (err.message?.includes('401')) {
          console.log('API key rejected by server, clearing config');
          config.apiKey = '';
          buildd = null;
          workerManager = null;
          saveConfig({ apiKey: '' });
          return Response.json({ error: 'API key invalid', needsSetup: true }, { status: 401, headers: corsHeaders });
        }
        return Response.json({ error: err.message || 'Failed to take over task' }, { status: 400, headers: corsHeaders });
      }
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

    // Team state endpoint (P2P — dashboard fetches directly from local-ui)
    if (path.startsWith('/api/workers/') && path.endsWith('/team') && req.method === 'GET') {
      if (!workerManager) {
        return Response.json({ error: 'Not configured' }, { status: 401, headers: corsHeaders });
      }
      const workerId = path.split('/')[3];
      const worker = workerManager.getWorker(workerId);
      if (!worker) {
        return Response.json({ error: 'Worker not found' }, { status: 404, headers: corsHeaders });
      }
      return Response.json({ team: worker.teamState || null }, { headers: corsHeaders });
    }

    // Trace endpoint — returns tool calls and messages for a worker
    if (path.startsWith('/api/workers/') && path.endsWith('/trace') && req.method === 'GET') {
      if (!workerManager) {
        return Response.json({ error: 'Not configured' }, { status: 401, headers: corsHeaders });
      }
      const workerId = path.split('/')[3];
      const worker = workerManager.getWorker(workerId);
      if (!worker) {
        return Response.json({ error: 'Worker not found' }, { status: 404, headers: corsHeaders });
      }
      return Response.json({ toolCalls: worker.toolCalls, messages: worker.messages }, { headers: corsHeaders });
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

    // Outbox status (pending sync items)
    if (path === '/api/outbox' && req.method === 'GET') {
      return Response.json({
        count: outbox.count(),
        entries: outbox.getEntries(),
      }, { headers: corsHeaders });
    }

    // Manual outbox flush
    if (path === '/api/outbox/flush' && req.method === 'POST') {
      if (outbox.count() === 0) {
        return Response.json({ flushed: 0, failed: 0, remaining: 0 }, { headers: corsHeaders });
      }
      const result = await outbox.flush();
      return Response.json(result, { headers: corsHeaders });
    }

    // Clear outbox
    if (path === '/api/outbox' && req.method === 'DELETE') {
      outbox.clear();
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    // Rescan local repos
    if (path === '/api/rescan' && req.method === 'POST') {
      const repos = getRepos(true); // Force rescan
      return Response.json({ ok: true, count: repos.length }, { headers: corsHeaders });
    }

    // Combined workspaces endpoint - merges server workspaces with local repos
    if (path === '/api/combined-workspaces' && req.method === 'GET') {
      const localRepos = getRepos(); // Use cached
      let serverWorkspaces: any[] = [];
      let serverError: string | null = null;
      if (buildd) {
        try {
          serverWorkspaces = await buildd.listWorkspaces();
        } catch (err: any) {
          serverError = err.message || 'Server unreachable';
          console.error('Failed to fetch server workspaces:', serverError);
        }
      }
      const isServerless = config.serverless || !config.apiKey;

      // Normalize git URL for comparison
      const normalizeUrl = (url: string | null) => {
        if (!url) return null;
        return url.toLowerCase()
          .replace(/\.git$/, '')
          .replace(/^https?:\/\/[^/]+\//, '')
          .replace(/^git@[^:]+:/, '');
      };

      // Extract org/owner from normalized URL
      const getOwner = (url: string | null) => {
        const normalized = normalizeUrl(url);
        if (!normalized) return null;
        const parts = normalized.split('/');
        return parts.length >= 2 ? parts[0] : null;
      };

      // Get set of orgs/owners from server workspaces
      const serverOwners = new Set<string>();
      for (const ws of serverWorkspaces) {
        const owner = getOwner(ws.repo);
        if (owner) serverOwners.add(owner);
      }

      // Build combined list
      const combined: any[] = [];
      const matchedLocalPaths = new Set<string>();

      // Process server workspaces
      for (const ws of serverWorkspaces) {
        const normalizedWsRepo = normalizeUrl(ws.repo);

        // Find matching local repo
        const localMatch = localRepos.find(r => r.normalizedUrl === normalizedWsRepo);

        if (localMatch) {
          matchedLocalPaths.add(localMatch.path);
          combined.push({
            id: ws.id,
            name: ws.name,
            repo: ws.repo,
            localPath: localMatch.path,
            status: 'ready', // Both server and local
            source: 'matched',
          });
        } else {
          combined.push({
            id: ws.id,
            name: ws.name,
            repo: ws.repo,
            localPath: null,
            status: 'needs-clone', // Server only, needs clone
            source: 'server',
          });
        }
      }

      // Add local-only repos (filtered by matching orgs, unless serverless)
      for (const repo of localRepos) {
        if (!matchedLocalPaths.has(repo.path) && repo.normalizedUrl) {
          const owner = getOwner(repo.remoteUrl);

          // Show all local repos when serverless, server unreachable, or no server workspaces
          // In server mode with workspaces, only show repos from matching orgs
          const shouldInclude = isServerless || serverError || serverOwners.size === 0 || (owner && serverOwners.has(owner));

          if (shouldInclude) {
            combined.push({
              id: null,
              name: repo.path.split('/').pop(),
              repo: repo.remoteUrl,
              localPath: repo.path,
              normalizedUrl: repo.normalizedUrl,
              status: 'local-only', // Local only, can sync to server
              source: 'local',
            });
          }
        }
      }

      // Sort: ready first, then needs-clone, then local-only
      const order = { ready: 0, 'needs-clone': 1, 'local-only': 2 };
      combined.sort((a, b) => order[a.status as keyof typeof order] - order[b.status as keyof typeof order]);

      return Response.json({
        workspaces: combined,
        serverless: isServerless,
        serverOwners: Array.from(serverOwners),
        ...(serverError ? { serverError } : {}),
      }, { headers: corsHeaders });
    }

    // Clone a server workspace locally
    if (path === '/api/workspaces/clone' && req.method === 'POST') {
      const body = await parseBody(req);
      const { workspaceId, repoUrl, targetPath } = body;

      if (!repoUrl) {
        return Response.json({ error: 'repoUrl required' }, { status: 400, headers: corsHeaders });
      }

      const clonePath = targetPath || `${config.projectRoots?.[0] || config.projectsRoot}/${repoUrl.split('/').pop()?.replace('.git', '')}`;

      try {
        const { execSync } = require('child_process');
        execSync(`git clone ${repoUrl} "${clonePath}"`, { encoding: 'utf-8', timeout: 120000 });

        return Response.json({ ok: true, path: clonePath }, { headers: corsHeaders });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // Legacy local repos endpoint
    if (path === '/api/local-repos' && req.method === 'GET') {
      const repos = getRepos(); // Use cached
      return Response.json({ repos }, { headers: corsHeaders });
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

    // Scan local skills from a project path
    if (path === '/api/skills/scan' && req.method === 'POST') {
      const body = await parseBody(req);
      const localPath = body.localPath || config.projectsRoot;

      if (!localPath || !existsSync(localPath)) {
        return Response.json({ error: 'Invalid or missing localPath' }, { status: 400, headers: corsHeaders });
      }

      const skills = scanSkills(localPath);
      return Response.json({ skills }, { headers: corsHeaders });
    }

    // List workspace skills
    if (path === '/api/skills/list' && req.method === 'POST') {
      if (!buildd) {
        return Response.json({ error: 'Not configured', needsSetup: true }, { status: 401, headers: corsHeaders });
      }

      const body = await parseBody(req);
      const { workspaceId, enabled } = body;

      if (!workspaceId) {
        return Response.json({ error: 'workspaceId required' }, { status: 400, headers: corsHeaders });
      }

      try {
        const skills = await buildd.listWorkspaceSkills(workspaceId, enabled);
        return Response.json({ skills }, { headers: corsHeaders });
      } catch (err: any) {
        return Response.json({ error: err.message || 'Failed to list skills' }, { status: 502, headers: corsHeaders });
      }
    }

    // Toggle skill enabled status
    if (path === '/api/skills/toggle' && req.method === 'POST') {
      if (!buildd) {
        return Response.json({ error: 'Not configured', needsSetup: true }, { status: 401, headers: corsHeaders });
      }

      const body = await parseBody(req);
      const { workspaceId, skillId, enabled } = body;

      if (!workspaceId || !skillId || typeof enabled !== 'boolean') {
        return Response.json({ error: 'workspaceId, skillId, and enabled (boolean) required' }, { status: 400, headers: corsHeaders });
      }

      try {
        const skill = await buildd.patchWorkspaceSkill(workspaceId, skillId, { enabled });
        return Response.json({ skill }, { headers: corsHeaders });
      } catch (err: any) {
        return Response.json({ error: err.message || 'Failed to toggle skill' }, { status: 502, headers: corsHeaders });
      }
    }

    // Delete a workspace skill
    if (path === '/api/skills/delete' && req.method === 'DELETE') {
      if (!buildd) {
        return Response.json({ error: 'Not configured', needsSetup: true }, { status: 401, headers: corsHeaders });
      }

      const body = await parseBody(req);
      const { workspaceId, skillId } = body;

      if (!workspaceId || !skillId) {
        return Response.json({ error: 'workspaceId and skillId required' }, { status: 400, headers: corsHeaders });
      }

      try {
        await buildd.deleteWorkspaceSkill(workspaceId, skillId);
        return Response.json({ success: true }, { headers: corsHeaders });
      } catch (err: any) {
        return Response.json({ error: err.message || 'Failed to delete skill' }, { status: 502, headers: corsHeaders });
      }
    }

    // Register a discovered skill to a workspace
    if (path === '/api/skills/register' && req.method === 'POST') {
      if (!buildd) {
        return Response.json({ error: 'Not configured', needsSetup: true }, { status: 401, headers: corsHeaders });
      }

      const body = await parseBody(req);
      const { workspaceId, skill } = body;

      if (!workspaceId || !skill?.slug || !skill?.name || !skill?.content || !skill?.contentHash) {
        return Response.json({ error: 'workspaceId and skill (slug, name, content, contentHash) required' }, { status: 400, headers: corsHeaders });
      }

      try {
        const result = await buildd.syncWorkspaceSkills(workspaceId, [{
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          content: skill.content,
          contentHash: skill.contentHash,
          source: skill.source || 'local-scan',
        }]);
        return Response.json(result, { headers: corsHeaders });
      } catch (err: any) {
        return Response.json({ error: err.message || 'Failed to register skill' }, { status: 502, headers: corsHeaders });
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
    if (path === '/icon.png') {
      return serveStatic('icon.png');
    }

    // SPA routing: /worker/:id routes to index.html (client handles routing)
    // Exclude /worker/api/ to avoid silently serving HTML for misrouted API calls
    if (path.startsWith('/worker/') && !path.includes('/api/')) {
      return serveStatic('index.html');
    }

    return new Response('Not found', { status: 404 });
  },
  error(err) {
    // Return JSON errors instead of Bun's HTML error overlay
    console.error('Unhandled server error:', err.message);
    return Response.json(
      { error: err.message || 'Internal server error' },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  },
});

const localUrl = `http://localhost:${PORT}`;

console.log('');
console.log(`╔════════════════════════════════════════════╗`);
console.log(`║  buildd local-ui                           ║`);
console.log(`╚════════════════════════════════════════════╝`);
console.log(`  URL:        ${terminalLink(localUrl)}`);
if (config.localUiUrl && config.localUiUrl !== localUrl) {
  console.log(`  External:   ${terminalLink(config.localUiUrl)}`);
}
console.log(`  Server:     ${config.builddServer}`);
console.log(`  API Key:    ${config.apiKey ? 'bld_***' + config.apiKey.slice(-4) : 'not set'}`);
console.log(`  Serverless: ${config.serverless ? 'yes' : 'no'}`);
console.log(`  Config:     ${CONFIG_FILE}`);
console.log('');
console.log(`Project root(s): ${projectRoots.join(', ')}`);
const repos = getRepos(); // Use cached, will scan only if no cache
console.log(`${repos.length} git repositories${reposLoadedFromCache ? ' (cached)' : ''}`);

if (!config.apiKey && !config.serverless) {
  console.log('');
  console.log(`⚠ No API key configured. Visit ${terminalLink(localUrl)} to set up.`);
}

// Handle browser auto-open preference (debounce to avoid re-opening on crash-restart)
function shouldOpenBrowser(): boolean {
  try {
    if (existsSync(BROWSER_OPEN_FILE)) {
      const lastOpen = parseInt(readFileSync(BROWSER_OPEN_FILE, 'utf-8').trim(), 10);
      if (Date.now() - lastOpen < 60_000) return false; // Skip if opened within last 60s
    }
  } catch {}
  return true;
}

function markBrowserOpened() {
  try {
    writeFileSync(BROWSER_OPEN_FILE, String(Date.now()));
  } catch {}
}

(async () => {
  // Check if this is first run (openBrowser preference not set)
  if (savedConfig.openBrowser === undefined) {
    // Skip interactive prompt when running without a TTY (e.g. in screen, CI)
    const isTTY = process.stdin.isTTY ?? false;
    if (!isTTY) {
      saveConfig({ openBrowser: false });
    } else {
      console.log('');
      const shouldOpen = await promptYesNo('Auto-open browser on startup?');
      saveConfig({ openBrowser: shouldOpen });

      if (shouldOpen && shouldOpenBrowser()) {
        console.log('Opening browser...');
        Bun.spawn(['open', localUrl]);
        markBrowserOpened();
      }
      console.log(`Preference saved. Change anytime in ${CONFIG_FILE}`);
    }
  } else if (savedConfig.openBrowser && shouldOpenBrowser()) {
    Bun.spawn(['open', localUrl]);
    markBrowserOpened();
  }
})();
