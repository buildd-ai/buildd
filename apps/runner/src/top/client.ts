/**
 * `buildd top`'s side of the runner socket contract (runner-socket.ts): HTTP
 * over the owner-only unix socket, no token. Reads, the /api/events stream and
 * the worker actions, each answered with the server's status and body.
 */

export interface SocketClient {
  get<T = any>(path: string): Promise<{ status: number; body: T }>;
  post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  /** Open /api/events and call onEvent per frame until the stream ends or `signal` aborts. */
  events(onEvent: (event: any) => void, signal: AbortSignal): Promise<void>;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

export function socketClient(socketPath: string, opts: { timeoutMs?: number } = {}): SocketClient {
  const timeout = opts.timeoutMs ?? 15_000;
  const init = (extra: RequestInit = {}): RequestInit => ({ unix: socketPath, ...extra } as RequestInit);
  return {
    async get(path) {
      const res = await fetch(`http://localhost${path}`, init({ signal: AbortSignal.timeout(timeout) }));
      return { status: res.status, body: (await readBody(res)) as any };
    },
    async post(path, body) {
      const res = await fetch(`http://localhost${path}`, init({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // A claim starts a worker (clone, worktree); give it room.
        signal: AbortSignal.timeout(Math.max(timeout, 60_000)),
      }));
      return { status: res.status, body: await readBody(res) };
    },
    async events(onEvent, signal) {
      const res = await fetch('http://localhost/api/events', init({ signal }));
      if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
      const parser = sseParser(onEvent);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser(decoder.decode(value, { stream: true }));
      }
    },
  };
}

/** Feed SSE text in chunks; calls onEvent with each `data:` frame's JSON. */
export function sseParser(onEvent: (event: any) => void): (chunk: string) => void {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try { onEvent(JSON.parse(data)); } catch { /* skip a malformed frame */ }
    }
  };
}
