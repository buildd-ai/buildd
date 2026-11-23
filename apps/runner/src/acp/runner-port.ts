/**
 * The bridge's RunnerPort over the runner's owner-only socket (runner-socket.ts),
 * through the same client `buildd top` uses (top/client.ts). No token: who may
 * connect to the socket is the boundary.
 *
 * Actions go where top's keys go: answer / message / pause / stop are relayed
 * by the runner to the buildd server route the dashboard uses for the same
 * button; a follow-up on a finished run is the runner's local /send, which
 * resumes the worker's session.
 */
import type { PublicWorker } from '../public-worker';
import { socketClient, type SocketClient } from '../top/client';
import type { BuilddWorkspace, RunnerPort, ThreadNote, WorkerActionName } from './bridge';

const RECONNECT_MS = 1_000;

export function socketRunnerPort(socketPath: string, client: SocketClient = socketClient(socketPath)): RunnerPort {
  const listeners = new Set<(w: PublicWorker) => void>();
  const snapshotListeners = new Set<(ids: Set<string>) => void>();
  let stream: AbortController | null = null;

  const fan = (w: unknown) => {
    if (!w || typeof w !== 'object' || typeof (w as any).id !== 'string') return;
    for (const fn of listeners) fn(w as PublicWorker);
  };

  const open = () => {
    if (stream) return;
    const ctrl = new AbortController();
    stream = ctrl;
    void (async () => {
      while (!ctrl.signal.aborted) {
        try {
          await client.events((event) => {
            if (event?.worker) fan(event.worker);
            if (Array.isArray(event?.workers)) {
              event.workers.forEach(fan);
              const ids = new Set<string>(event.workers.map((w: any) => w?.id).filter((id: unknown) => typeof id === 'string'));
              for (const fn of [...snapshotListeners]) fn(ids);
            }
          }, ctrl.signal);
        } catch (err) {
          if (ctrl.signal.aborted) return;
          console.error(`[buildd acp] runner event stream dropped: ${(err as Error)?.message ?? err}`);
        }
        if (!ctrl.signal.aborted) await new Promise(r => setTimeout(r, RECONNECT_MS));
      }
    })();
  };

  return {
    async listWorkers() {
      const r = await client.get<{ workers?: PublicWorker[]; error?: string }>('/api/workers');
      if (r.status >= 400) throw new Error(`runner refused /api/workers (${r.status}): ${r.body?.error ?? ''}`);
      return r.body?.workers ?? [];
    },
    act(workerId: string, action: WorkerActionName, message?: string) {
      const id = encodeURIComponent(workerId);
      if (action === 'followup') return client.post(`/api/workers/${id}/send`, { message: message ?? '' });
      return client.post(`/api/workers/${id}/${action}`, message === undefined ? {} : { message });
    },
    async listWorkspaces() {
      const r = await client.get<{ workspaces?: BuilddWorkspace[]; error?: string }>('/api/workspaces');
      if (r.status >= 400) throw new Error(r.body?.error ?? `runner refused /api/workspaces (${r.status})`);
      return (r.body?.workspaces ?? []).map(ws => ({ id: ws.id, name: ws.name, repo: ws.repo ?? null, teamName: ws.teamName ?? null }));
    },
    createTask(input) {
      return client.post('/api/tasks', input);
    },
    claim(taskId) {
      return client.post('/api/claim', { taskId });
    },
    async threadEvents(threadId) {
      const r = await client.get<{ events?: ThreadNote[] }>(`/api/tasks/thread-events?threadId=${encodeURIComponent(threadId)}`);
      if (r.status >= 400) throw new Error(`thread events refused (${r.status})`);
      return r.body?.events ?? [];
    },
    async runnerInfo() {
      const r = await client.get<{ builddServer?: string; accountId?: string | null }>('/api/config');
      if (r.status >= 400) return null;
      return { server: r.body?.builddServer ?? '', accountId: r.body?.accountId ?? null };
    },
    subscribe(fn, onSnapshot) {
      listeners.add(fn);
      if (onSnapshot) snapshotListeners.add(onSnapshot);
      open();
      return () => {
        listeners.delete(fn);
        if (onSnapshot) snapshotListeners.delete(onSnapshot);
        if (listeners.size === 0 && stream) {
          stream.abort();
          stream = null;
        }
      };
    },
  };
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore' });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && out ? out : null;
  } catch {
    return null;
  }
}

/** The main checkout a worktree belongs to (`git rev-parse --git-common-dir`), or null. */
export async function gitRepoRoot(path: string): Promise<string | null> {
  const out = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return out ? out.replace(/[\\/]\.git[\\/]?$/, '') : null;
}

/** `C:\code\app` -> `/mnt/c/code/app` when this process runs on Linux (a runner in WSL). */
export function localPathFor(path: string, platform: string = process.platform): string {
  const m = path.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m || platform === 'win32') return path;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/** `git@github.com:acme/app.git`, `https://github.com/acme/app` -> ['app', 'acme/app']. */
export function repoNamesFromRemote(url: string): string[] {
  const m = url.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? [m[2], `${m[1]}/${m[2]}`] : [];
}

/** `git@github.com:acme/app.git`, `https://github.com/acme/app` -> 'acme/app'; null for any other host. */
export function githubRepoFromRemote(url: string): string | null {
  const m = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The project's GitHub repo, from `origin`. */
export async function githubRepo(cwd: string): Promise<string | null> {
  const remote = await git(localPathFor(cwd), ['remote', 'get-url', 'origin']);
  return remote ? githubRepoFromRemote(remote) : null;
}

export async function projectNames(cwd: string): Promise<string[]> {
  const folder = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const remote = await git(localPathFor(cwd), ['remote', 'get-url', 'origin']);
  const names = [folder, ...(remote ? repoNamesFromRemote(remote) : [])].filter(Boolean).map(n => n.toLowerCase());
  return [...new Set(names)];
}
