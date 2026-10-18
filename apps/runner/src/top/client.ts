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

/** Reads the runner tags (local-etag.ts): top sends the tag it holds, and a 304 is the body it has. */
const TAGGED_READS = new Set(['/api/tasks', '/api/missions/recent', '/api/queue']);

export function socketClient(socketPath: string, opts: { timeoutMs?: number } = {}): SocketClient {
  const timeout = opts.timeoutMs ?? 15_000;
  const init = (extra: RequestInit = {}): RequestInit => ({ unix: socketPath, ...extra } as RequestInit);
  const held = new Map<string, { etag: string; body: unknown }>();
  return {
    async get(path) {
      const mine = TAGGED_READS.has(path) ? held.get(path) : undefined;
      const res = await fetch(`http://localhost${path}`, init({
        signal: AbortSignal.timeout(timeout),
        ...(mine ? { headers: { 'If-None-Match': mine.etag } } : {}),
      }));
      if (res.status === 304 && mine) return { status: 200, body: structuredClone(mine.body) as any };
      const body = await readBody(res);
      const etag = res.headers.get('etag');
      if (TAGGED_READS.has(path)) {
        if (res.status === 200 && etag) held.set(path, { etag, body: structuredClone(body) });
        else held.delete(path);
      }
      return { status: res.status, body: body as any };
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
