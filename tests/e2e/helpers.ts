/**
 * E2E Test Helpers
 *
 * API clients, polling utilities, and subprocess management
 * for server + runner integration tests.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Subprocess } from 'bun';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface BuilddConfig {
  apiKey?: string;
  builddServer?: string;
}

export function readApiKey(): string {
  // 1. Env var takes priority
  if (process.env.BUILDD_API_KEY) return process.env.BUILDD_API_KEY;

  // 2. Fall back to ~/.buildd/config.json
  const configPath = join(homedir(), '.buildd', 'config.json');
  if (existsSync(configPath)) {
    try {
      const cfg: BuilddConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (cfg.apiKey) return cfg.apiKey;
    } catch { /* ignore */ }
  }

  throw new Error(
    'No API key found. Set BUILDD_API_KEY env var or configure ~/.buildd/config.json',
  );
}

// ---------------------------------------------------------------------------
// Server Client — talks directly to the remote buildd server
// ---------------------------------------------------------------------------

export class ServerClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async fetch<T = any>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...(init?.headers || {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Server ${init?.method || 'GET'} ${path} → ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  listWorkspaces() {
    return this.fetch<{ workspaces: any[] }>('/api/workspaces');
  }

  listTasks() {
    return this.fetch<{ tasks: any[] }>('/api/tasks');
  }

  getTask(id: string) {
    return this.fetch<any>(`/api/tasks/${id}`);
  }

  createTask(data: { workspaceId: string; title: string; description: string; creationSource?: string }) {
    return this.fetch<any>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  deleteTask(id: string) {
    return this.fetch<any>(`/api/tasks/${id}`, { method: 'DELETE' });
  }
}

// ---------------------------------------------------------------------------
// Runner Client — talks to the runner HTTP API
// ---------------------------------------------------------------------------

export class LocalUIClient {
  constructor(private baseUrl: string) {}

  async fetch<T = any>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Runner ${init?.method || 'GET'} ${path} → ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  getConfig() {
    return this.fetch<{
      configured: boolean;
      serverless: boolean;
      hasClaudeCredentials: boolean;
      builddServer: string;
      model: string;
      acceptRemoteTasks: boolean;
      accountId: string | null;
    }>('/api/config');
  }

  setServer(server: string) {
    return this.fetch('/api/config/server', {
      method: 'POST',
      body: JSON.stringify({ server }),
    });
  }

  setAcceptRemoteTasks(enabled: boolean) {
    return this.fetch('/api/config/accept-remote-tasks', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  }

  setModel(model: string) {
    return this.fetch('/api/config/model', {
      method: 'POST',
      body: JSON.stringify({ model }),
    });
  }

  listWorkers() {
    return this.fetch<{ workers: any[] }>('/api/workers');
  }

  claimTask(taskId: string) {
    return this.fetch<{ worker: any }>('/api/claim', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    });
  }

  abortWorker(workerId: string) {
    return this.fetch('/api/abort', {
      method: 'POST',
      body: JSON.stringify({ workerId }),
    });
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export interface PollOptions {
  /** Max wait time in ms (default: 60_000) */
  timeout?: number;
  /** Interval between polls in ms (default: 2_000) */
  interval?: number;
  /** Label for error messages */
  label?: string;
}

/**
 * Poll `fn` until it returns a truthy value or times out.
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: PollOptions = {},
): Promise<T> {
  const { timeout = 60_000, interval = 2_000, label = 'condition' } = opts;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await Bun.sleep(interval);
  }

  throw new Error(`Timed out waiting for ${label} after ${timeout}ms`);
}

// ---------------------------------------------------------------------------
// Runner Subprocess Management
// ---------------------------------------------------------------------------

let localUIProc: Subprocess | null = null;

/**
 * Start runner as a subprocess.
 * Prefers the repo's apps/runner/ (latest code), falls back to ~/.buildd/apps/runner/.
 * Waits for the health-check endpoint before returning.
 */
export async function startLocalUI(localUIUrl: string): Promise<void> {
  if (process.env.SKIP_LOCAL_UI_START === '1') {
    console.log('  SKIP_LOCAL_UI_START=1 → assuming runner is already running');
    return;
  }

  // Prefer repo version (has latest code), fall back to installed version
  const repoDir = join(import.meta.dir, '..', '..', 'apps', 'runner');
  const installedDir = join(homedir(), '.buildd', 'apps', 'runner');
  const localUIDir = existsSync(join(repoDir, 'package.json')) ? repoDir : installedDir;

  if (!existsSync(join(localUIDir, 'package.json'))) {
    throw new Error(`runner not found at ${repoDir} or ${installedDir}`);
  }

  console.log(`  Starting runner from ${localUIDir} ...`);

  localUIProc = Bun.spawn(['bun', 'start'], {
    cwd: localUIDir,
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      ...process.env,
      PORT: new URL(localUIUrl).port || '8766',
      PROJECTS_ROOT: process.env.PROJECTS_ROOT || join(homedir(), 'buildd'),
    },
  });

  // Wait for health check
  await pollUntil(
    async () => {
      try {
        const res = await fetch(`${localUIUrl}/api/config`);
        return res.ok || null;
      } catch {
        return null;
      }
    },
    { timeout: 15_000, interval: 500, label: 'runner startup' },
  );

  console.log('  runner is up');
}

export async function stopLocalUI(): Promise<void> {
  if (localUIProc) {
    console.log('  Stopping runner subprocess ...');
    localUIProc.kill();
    localUIProc = null;
  }
}
