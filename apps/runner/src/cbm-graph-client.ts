/**
 * The runner's own connection to the codebase graph, for CBM search injection
 * (docs/design/cbm-search-injection.md, Flow 2).
 *
 * The agent's CBM server belongs to the SDK (stdio, owned by the agent
 * process), so the runner cannot borrow it. It runs its own
 * `codebase-memory-mcp mcp` against the same cache dir and speaks MCP
 * JSON-RPC to it over stdio.
 *
 * Why a long-lived process and not `codebase-memory-mcp cli <tool>`: the CLI
 * pays process start-up and memory init on every call — seconds — while a warm
 * server answers an exact-name `search_graph` or a depth-1 `trace_path` in tens
 * of milliseconds. The injection hook's whole budget is 1.5s, so only the warm
 * server fits. Start-up is several seconds too, which is why `start()` is
 * fire-and-forget at session start and every lookup before it finishes is a
 * `no_index` rather than a wait.
 *
 * Calls made here are NOT agent tool calls: nothing in this file touches
 * `cbmToolCounts` / `cbmFileAccessCounts` / `toolCounts` (CBM-17/18).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

/** One location the graph knows. Paths are repo-relative, as CBM stores them. */
export interface GraphLocation {
  path: string;
  startLine: number;
  endLine: number;
  relation: 'definition' | 'caller';
  /** Function/method name (callers) or label (definition). Shown to the agent, never stored. */
  name: string;
  /** Graph label (`Function`, `Method`, …). */
  label: string | null;
  /** Hops from the symbol (callers only). */
  hop?: number;
}

export interface GraphAnswer {
  definitions: GraphLocation[];
  callers: GraphLocation[];
}

/** What the injector needs from the graph. Faked in tests. */
export interface CbmGraph {
  /** False until the server is initialised AND the session's project is indexed. */
  isReady(): Promise<boolean>;
  /** Definitions + inbound callers to `depth`. Null when the graph does not know the symbol. */
  lookup(symbol: string, opts: { depth: number; timeoutMs: number }): Promise<GraphAnswer | null>;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/** At most this many callers are resolved to a location per lookup. */
const MAX_CALLERS = 40;
/** At most this many definitions are kept per symbol. */
const MAX_DEFINITIONS = 5;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `"1190-1224"` → [1190, 1224]. */
function parseLines(v: unknown): [number, number] | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)(?:-(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const a = Number(m[1]);
  return [a, m[2] ? Number(m[2]) : a];
}

/** The JSON payload of a CBM tool result: `structuredContent`, else the first text block parsed. */
export function toolPayload(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  if (r.isError) return null;
  if (r.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent as Record<string, unknown>;
  const text = r.content?.find(c => c.type === 'text')?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

interface SearchRow { qn: string; file: string; name: string; label: string | null; lines: [number, number] }

/** Flatten a `search_graph format=json` payload into rows. */
export function parseSearchGraph(payload: Record<string, unknown> | null): SearchRow[] {
  if (!payload) return [];
  const cols = Array.isArray(payload.cols) ? payload.cols as string[] : [];
  const iName = cols.indexOf('name');
  const iLabel = cols.indexOf('label');
  const iLines = cols.indexOf('lines');
  if (iName < 0 || iLines < 0) return [];
  const out: SearchRow[] = [];
  for (const g of (Array.isArray(payload.groups) ? payload.groups : []) as Array<{ qn_prefix?: string; file?: string; rows?: unknown[][] }>) {
    if (typeof g.file !== 'string') continue;
    for (const row of g.rows ?? []) {
      const name = row[iName];
      const lines = parseLines(row[iLines]);
      if (typeof name !== 'string' || !lines) continue;
      out.push({
        qn: `${g.qn_prefix ?? ''}.${name}`,
        file: g.file,
        name,
        label: iLabel >= 0 && typeof row[iLabel] === 'string' ? row[iLabel] as string : null,
        lines,
      });
    }
  }
  return out;
}

/** Flatten a `trace_path format=json` payload into caller qualified names with their hop. */
export function parseTracePath(payload: Record<string, unknown> | null): Array<{ qn: string; name: string; hop: number }> {
  if (!payload) return [];
  const callers = payload.callers as { cols?: string[]; groups?: Array<{ qn_prefix?: string; rows?: unknown[][] }> } | undefined;
  if (!callers) return [];
  const cols = callers.cols ?? [];
  const iName = cols.indexOf('name');
  const iHop = cols.indexOf('hop');
  if (iName < 0) return [];
  const out: Array<{ qn: string; name: string; hop: number }> = [];
  for (const g of callers.groups ?? []) {
    for (const row of g.rows ?? []) {
      const name = row[iName];
      if (typeof name !== 'string') continue;
      const hop = iHop >= 0 && typeof row[iHop] === 'number' ? row[iHop] as number : 1;
      out.push({ qn: `${g.qn_prefix ?? ''}.${name}`, name, hop });
    }
  }
  return out;
}

export interface CbmGraphClientOptions {
  binaryPath: string;
  env: Record<string, string>;
  /** Absolute root the session's project was indexed at (the worktree), for a per-task index. */
  worktreePath: string;
  /** Known project name (shared seed). Unset ⇒ resolved from `list_projects`. */
  project?: string;
  /** Test seam. */
  spawnProcess?: typeof spawn;
  log?: (msg: string) => void;
}

/**
 * A minimal MCP client over stdio. Newline-delimited JSON-RPC 2.0, which is
 * what CBM speaks. Never throws out of a public method.
 */
export class CbmGraphClient implements CbmGraph {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private initialised = false;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private project: string | undefined;

  constructor(private readonly opts: CbmGraphClientOptions) {
    this.project = opts.project;
  }

  /** Spawn and initialise in the background. Idempotent; never throws. */
  start(): void {
    if (this.starting || this.stopped) return;
    this.starting = this.init().catch(err => {
      this.opts.log?.(`CBM injection: graph client failed to start (${err instanceof Error ? err.message : String(err)})`);
      this.stop();
    });
  }

  private async init(): Promise<void> {
    const spawnProcess = this.opts.spawnProcess ?? spawn;
    const child = spawnProcess(this.opts.binaryPath, ['mcp'], {
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'ignore'],
    }) as unknown as ChildProcessWithoutNullStreams;
    this.child = child;
    child.on('error', () => this.stop());
    child.on('exit', () => {
      this.child = null;
      this.initialised = false;
      this.failAll('graph server exited');
    });
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (d: string | Buffer) => this.onData(String(d)));
    // The runner must never wait on this process to exit.
    (child as unknown as { unref?: () => void }).unref?.();
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'buildd-runner-cbm-injection', version: '1' },
    }, 60_000);
    this.notify('notifications/initialized', {});
    this.initialised = true;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id !== 'number') continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'rpc error'));
      else p.resolve(msg.result);
    }
  }

  private failAll(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('graph server not running'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try { this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* best-effort */ }
  }

  private async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return toolPayload(result);
  }

  /**
   * Ready = initialised and the project is known. A per-task index that has not
   * landed has no project yet; this re-checks `list_projects` until it does.
   */
  async isReady(): Promise<boolean> {
    if (!this.initialised || !this.child) return false;
    if (this.project) return true;
    try {
      const payload = await this.callTool('list_projects', {}, 300);
      const projects = (payload?.projects ?? []) as Array<{ name?: string; root_path?: string }>;
      const root = this.opts.worktreePath.replace(/\/+$/, '');
      const match = projects.find(p => typeof p.root_path === 'string' && p.root_path.replace(/\/+$/, '') === root);
      if (match?.name) this.project = match.name;
    } catch {
      return false;
    }
    return !!this.project;
  }

  async lookup(symbol: string, opts: { depth: number; timeoutMs: number }): Promise<GraphAnswer | null> {
    const project = this.project;
    if (!project) throw new Error('graph not ready');
    const deadline = Date.now() + opts.timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());

    const [defsPayload, tracePayload] = await Promise.all([
      this.callTool('search_graph', { project, name_pattern: `^${escapeRegex(symbol)}$`, format: 'json', limit: MAX_DEFINITIONS }, left()),
      this.callTool('trace_path', { project, function_name: symbol, direction: 'inbound', depth: opts.depth, format: 'json', limit: MAX_CALLERS }, left()),
    ]);
    const defRows = parseSearchGraph(defsPayload).filter(r => r.name === symbol).slice(0, MAX_DEFINITIONS);
    if (defRows.length === 0) return null;

    const definitions: GraphLocation[] = defRows.map(r => ({
      path: r.file, startLine: r.lines[0], endLine: r.lines[1], relation: 'definition', name: r.name, label: r.label,
    }));

    const traced = parseTracePath(tracePayload).slice(0, MAX_CALLERS);
    if (traced.length === 0) return { definitions, callers: [] };

    // trace_path names callers but not where they live; one batched search
    // resolves them, matched back by qualified name.
    const names = [...new Set(traced.map(t => t.name))];
    const resolved = parseSearchGraph(await this.callTool('search_graph', {
      project,
      name_pattern: `^(${names.map(escapeRegex).join('|')})$`,
      format: 'json',
      limit: MAX_CALLERS * 2,
    }, left()));
    const byQn = new Map(resolved.map(r => [r.qn, r]));
    const callers: GraphLocation[] = [];
    for (const t of traced) {
      const r = byQn.get(t.qn);
      if (!r) continue;
      callers.push({ path: r.file, startLine: r.lines[0], endLine: r.lines[1], relation: 'caller', name: r.name, label: r.label, hop: t.hop });
    }
    return { definitions, callers };
  }

  /** Kill the server. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.initialised = false;
    this.failAll('stopped');
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.stdin.end(); } catch { /* already closed */ }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }
}
