/**
 * End-to-end tests for scripts/spec-conformance-contradiction-watch.ts.
 *
 * Spawns the real script against a throwaway git repo and a fake buildd API
 * (Bun.serve) covering both the artifacts endpoint (state) and /api/tasks
 * (friction filing), so this exercises the actual evaluateAllDocs wiring and
 * HTTP calls — not just the pure contradiction logic already covered in
 * packages/core/__tests__/spec-conformance.test.ts.
 *
 * Run: bun run scripts/run-unit-tests.ts scripts/spec-conformance-contradiction-watch.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'spec-conformance-contradiction-watch.ts');
const WORKSPACE_ID = 'ws-test-1';

let repo: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let store: Map<string, string>;
let createdTasks: any[];

function git(args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(message: string) {
  git(['add', '-A']);
  git(['-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

// Same rationale as spec-conformance-delta-gate.test.ts: Bun.spawnSync would
// block this process's event loop, deadlocking the child against the fake
// server running on that same loop. Bun.spawn + awaiting `exited` yields it.
async function runWatch(extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(
    ['bun', 'run', SCRIPT, '--repo-root', repo, '--workspace-id', WORKSPACE_ID, '--server', baseUrl],
    { env: { ...process.env, ...extraEnv }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function writeContradictingDoc() {
  // status: proposed (non-terminal) + a symbol assertion that resolves →
  // derived 'implemented' → derived-ahead-of-declared contradiction, same
  // fixture shape as the delta-gate test.
  writeFileSync(
    join(repo, 'docs', 'design', 'watched.md'),
    ['---', 'status: proposed', 'assertions:', '  - id: sym', '    type: symbol', '    name: foo', '    path: apps/foo.ts', '---', '# Watched', ''].join('\n'),
  );
  writeFileSync(join(repo, 'apps', 'foo.ts'), 'export function foo() {}\n');
}

function writeCleanDoc() {
  // status already promoted to match the derived (terminal) status — no contradiction.
  writeFileSync(
    join(repo, 'docs', 'design', 'watched.md'),
    ['---', 'status: implemented', 'assertions:', '  - id: sym', '    type: symbol', '    name: foo', '    path: apps/foo.ts', '---', '# Watched', ''].join('\n'),
  );
  writeFileSync(join(repo, 'apps', 'foo.ts'), 'export function foo() {}\n');
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === `/api/workspaces/${WORKSPACE_ID}/artifacts`) {
        const key = url.searchParams.get('key');
        const content = key ? store.get(key) : undefined;
        return Response.json({ artifacts: content !== undefined ? [{ content }] : [] });
      }
      if (req.method === 'POST' && url.pathname === `/api/workspaces/${WORKSPACE_ID}/artifacts`) {
        const body = await req.json();
        store.set(body.key, body.content);
        return Response.json({ artifact: { id: 'a1', key: body.key, content: body.content } });
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const body = await req.json();
        createdTasks.push(body);
        return Response.json({ id: `task-${createdTasks.length}` });
      }
      return new Response('not found', { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

beforeEach(() => {
  store = new Map();
  createdTasks = [];
  repo = mkdtempSync(join(tmpdir(), 'contradiction-watch-repo-'));
  git(['init', '-q']);
  mkdirSync(join(repo, 'docs', 'design'), { recursive: true });
  mkdirSync(join(repo, 'apps'), { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('spec-conformance-contradiction-watch', () => {
  test('cold start: records the current set without filing anything', async () => {
    writeContradictingDoc();
    commit('initial');

    const { code } = await runWatch({ BUILDD_API_KEY: 'test-key' });
    expect(code).toBe(0);
    expect(createdTasks).toHaveLength(0);
    expect(JSON.parse(store.get('spec-conformance-contradiction-docs')!)).toEqual(['docs/design/watched.md']);
  });

  test('files a friction task when a new contradiction appears since the recorded set', async () => {
    store.set('spec-conformance-contradiction-docs', JSON.stringify([]));
    writeContradictingDoc();
    commit('introduce contradiction');

    const { code } = await runWatch({ BUILDD_API_KEY: 'test-key' });
    expect(code).toBe(0);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].title).toContain('[friction] spec-conformance:');
    expect(createdTasks[0].title).toContain('derived-ahead-of-declared');
    expect(createdTasks[0].context.frictionSignature).toBe('spec-conformance-contradiction:docs/design/watched.md');
    expect(createdTasks[0].workspaceId).toBe(WORKSPACE_ID);
    expect(JSON.parse(store.get('spec-conformance-contradiction-docs')!)).toEqual(['docs/design/watched.md']);
  });

  test('does not re-file when the contradiction was already in the recorded set', async () => {
    store.set('spec-conformance-contradiction-docs', JSON.stringify(['docs/design/watched.md']));
    writeContradictingDoc();
    commit('still contradicting');

    const { code } = await runWatch({ BUILDD_API_KEY: 'test-key' });
    expect(code).toBe(0);
    expect(createdTasks).toHaveLength(0);
  });

  test('records a shrunk set when a contradiction resolves, without filing anything', async () => {
    store.set('spec-conformance-contradiction-docs', JSON.stringify(['docs/design/watched.md']));
    writeCleanDoc();
    commit('resolve contradiction');

    const { code } = await runWatch({ BUILDD_API_KEY: 'test-key' });
    expect(code).toBe(0);
    expect(createdTasks).toHaveLength(0);
    expect(JSON.parse(store.get('spec-conformance-contradiction-docs')!)).toEqual([]);
  });

  test('no-ops without BUILDD_API_KEY — does not throw or call the network', async () => {
    writeContradictingDoc();
    commit('initial');

    const { code } = await runWatch({ BUILDD_API_KEY: '' });
    expect(code).toBe(0);
    expect(createdTasks).toHaveLength(0);
    expect(store.size).toBe(0);
  });
});
