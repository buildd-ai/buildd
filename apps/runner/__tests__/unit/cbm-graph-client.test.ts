/**
 * The runner's own CBM graph client (cbm-graph-client.ts): payload parsing
 * against the shapes CBM 0.10.x returns, and a fake stdio server end to end —
 * initialise, project resolution, the three-call lookup, and stop.
 */
import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { CbmGraphClient, parseSearchGraph, parseTracePath, toolPayload } from '../../src/cbm-graph-client';

const P = 'proj';

const searchPayload = (rows: Array<{ prefix: string; file: string; name: string; label: string; lines: string }>) => ({
  total: rows.length,
  cols: ['name', 'label', 'lines', 'in', 'out'],
  groups: rows.map(r => ({ qn_prefix: r.prefix, file: r.file, rows: [[r.name, r.label, r.lines, 1, 1]] })),
  has_more: false,
});

describe('payload parsing', () => {
  it('reads structuredContent, else a JSON text block; isError is null', () => {
    expect(toolPayload({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(toolPayload({ content: [{ type: 'text', text: '{"b":2}' }] })).toEqual({ b: 2 });
    expect(toolPayload({ content: [{ type: 'text', text: 'rows: 2' }] })).toBeNull();
    expect(toolPayload({ isError: true, structuredContent: { a: 1 } })).toBeNull();
  });

  it('flattens search_graph groups into qualified rows with line ranges', () => {
    const rows = parseSearchGraph(searchPayload([{ prefix: `${P}.src.a`, file: 'src/a.ts', name: 'fooBar', label: 'Function', lines: '10-20' }]));
    expect(rows).toEqual([{ qn: `${P}.src.a.fooBar`, file: 'src/a.ts', name: 'fooBar', label: 'Function', lines: [10, 20] }]);
  });

  it('flattens trace_path callers with their hop', () => {
    const out = parseTracePath({
      function: 'fooBar',
      callers: { cols: ['name', 'hop'], groups: [{ qn_prefix: `${P}.src.b.Cls`, rows: [['useIt', 1], ['outer', 2]] }] },
    });
    expect(out).toEqual([
      { qn: `${P}.src.b.Cls.useIt`, name: 'useIt', hop: 1 },
      { qn: `${P}.src.b.Cls.outer`, name: 'outer', hop: 2 },
    ]);
  });
});

/** A fake `codebase-memory-mcp mcp`: newline-delimited JSON-RPC over pipes. */
function fakeServer(handler: (method: string, params: any) => unknown) {
  const calls: Array<{ method: string; params: any }> = [];
  const spawnProcess = (() => {
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => { child.emit('exit', 0); return true; };
    let buf = '';
    child.stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.id === undefined) continue;
        calls.push({ method: msg.method, params: msg.params });
        const result = handler(msg.method, msg.params);
        child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      }
    });
    return child;
  }) as any;
  return { spawnProcess, calls };
}

const tool = (payload: unknown) => ({ structuredContent: payload });

async function until(cond: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('never ready');
}

describe('CbmGraphClient over a fake stdio server', () => {
  it('resolves its project from list_projects by worktree root, then looks a symbol up', async () => {
    const { spawnProcess, calls } = fakeServer((method, params) => {
      if (method === 'initialize') return { protocolVersion: '2024-11-05' };
      const { name, arguments: args } = params;
      if (name === 'list_projects') return tool({ projects: [{ name: 'other', root_path: '/x' }, { name: P, root_path: '/work/tree' }] });
      if (name === 'trace_path') return tool({ callers: { cols: ['name', 'hop'], groups: [{ qn_prefix: `${P}.src.b`, rows: [['useIt', 1]] }] } });
      if (name === 'search_graph' && args.name_pattern === '^fooBar$') {
        return tool(searchPayload([{ prefix: `${P}.src.a`, file: 'src/a.ts', name: 'fooBar', label: 'Function', lines: '10-20' }]));
      }
      if (name === 'search_graph') {
        return tool(searchPayload([
          { prefix: `${P}.src.b`, file: 'src/b.ts', name: 'useIt', label: 'Function', lines: '3-9' },
          { prefix: `${P}.src.unrelated`, file: 'src/u.ts', name: 'useIt', label: 'Function', lines: '1-2' },
        ]));
      }
      return null;
    });
    const client = new CbmGraphClient({ binaryPath: 'cbm', env: {}, worktreePath: '/work/tree/', spawnProcess });
    expect(await client.isReady()).toBe(false);
    client.start();
    await until(() => client.isReady());

    const answer = await client.lookup('fooBar', { depth: 1, timeoutMs: 1000 });
    expect(answer).toEqual({
      definitions: [{ path: 'src/a.ts', startLine: 10, endLine: 20, relation: 'definition', name: 'fooBar', label: 'Function' }],
      // Matched by qualified name: the same-named function elsewhere is not a caller.
      callers: [{ path: 'src/b.ts', startLine: 3, endLine: 9, relation: 'caller', name: 'useIt', label: 'Function', hop: 1 }],
    });
    const trace = calls.find(c => c.params?.name === 'trace_path')!;
    expect(trace.params.arguments).toMatchObject({ project: P, function_name: 'fooBar', direction: 'inbound', depth: 1 });
    client.stop();
    expect(await client.isReady()).toBe(false);
  });

  it('returns null when the graph has no definition by that exact name', async () => {
    const { spawnProcess } = fakeServer((method, params) => {
      if (method === 'initialize') return {};
      if (params.name === 'search_graph') return tool(searchPayload([{ prefix: `${P}.a`, file: 'a.ts', name: 'fooBarBaz', label: 'Function', lines: '1-2' }]));
      return tool({ callers: { cols: ['name', 'hop'], groups: [] } });
    });
    const client = new CbmGraphClient({ binaryPath: 'cbm', env: {}, worktreePath: '/w', project: P, spawnProcess });
    client.start();
    await until(() => client.isReady());
    expect(await client.lookup('fooBar', { depth: 1, timeoutMs: 500 })).toBeNull();
    client.stop();
  });

  it('a project that has not landed keeps the client not-ready', async () => {
    const { spawnProcess } = fakeServer((method) => (method === 'initialize' ? {} : tool({ projects: [] })));
    const client = new CbmGraphClient({ binaryPath: 'cbm', env: {}, worktreePath: '/w', spawnProcess });
    client.start();
    await new Promise(r => setTimeout(r, 30));
    expect(await client.isReady()).toBe(false);
    client.stop();
  });
});
