/**
 * End-to-end tests for the §4 delta gate CLI (docs/design/spec-conformance.md).
 *
 * Spawns the real script against a throwaway git repo and a fake buildd
 * artifacts API (Bun.serve), so this exercises the actual argv parsing,
 * git plumbing, and HTTP calls — not just the pure `isWatched` logic already
 * covered in packages/core/__tests__/spec-conformance.test.ts.
 *
 * Run: bun run scripts/run-unit-tests.ts scripts/spec-conformance-delta-gate.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'spec-conformance-delta-gate.ts');
const WORKSPACE_ID = 'ws-test-1';

let repo: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
// key -> content, mimics the artifacts_workspace_key_idx (workspaceId, key) upsert.
let store: Map<string, string>;
let lastPostBody: any = null;

function git(args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(message: string) {
  git(['add', '-A']);
  git(['-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

// Bun.spawnSync would block this process's event loop for the whole child
// lifetime — including the fake server's own fetch handler running in
// beforeAll above, on that same event loop. A child that calls out to that
// server (as `check`/`record` do) then deadlocks: it waits on an HTTP
// response the parent can never produce while synchronously blocked waiting
// on the child. Bun.spawn + awaiting `exited` yields the loop instead.
async function runGate(subcommand: 'check' | 'record', extraEnv: Record<string, string> = {}, extraArgs: string[] = []) {
  const outFile = join(mkdtempSync(join(tmpdir(), 'gh-output-')), 'out');
  writeFileSync(outFile, '');
  const proc = Bun.spawn(
    ['bun', 'run', SCRIPT, subcommand, '--repo-root', repo, '--workspace-id', WORKSPACE_ID, '--server', baseUrl, ...extraArgs],
    {
      env: { ...process.env, GITHUB_OUTPUT: outFile, ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const outputs = Object.fromEntries(
    readFileSync(outFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { code, outputs, stdout, stderr };
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
        lastPostBody = body;
        store.set(body.key, body.content);
        return Response.json({ artifact: { id: 'a1', key: body.key, content: body.content }, upserted: store.size > 0 });
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
  lastPostBody = null;
  repo = mkdtempSync(join(tmpdir(), 'delta-gate-repo-'));
  git(['init', '-q']);
  mkdirSync(join(repo, 'docs', 'design'), { recursive: true });
  mkdirSync(join(repo, 'apps'), { recursive: true });
  writeFileSync(
    join(repo, 'docs', 'design', 'watched.md'),
    ['---', 'status: proposed', 'assertions:', '  - id: sym', '    type: symbol', '    name: foo', '    path: apps/foo.ts', '---', '# Watched', ''].join('\n'),
  );
  writeFileSync(join(repo, 'apps', 'foo.ts'), 'export function foo() {}\n');
  writeFileSync(join(repo, 'apps', 'unrelated.ts'), 'export function unrelated() {}\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('spec-conformance-delta-gate check', () => {
  test('fails open (skip=false) with no prior artifact — cold start', async () => {
    commit('initial');
    const { outputs } = await runGate('check');
    expect(outputs.skip).toBe('false');
  });

  test('fails open (skip=false) when WORKSPACE_ID/BUILDD_API_KEY are unset', async () => {
    commit('initial');
    const outFile = join(mkdtempSync(join(tmpdir(), 'gh-output-')), 'out');
    writeFileSync(outFile, '');
    const proc = Bun.spawn(['bun', 'run', SCRIPT, 'check', '--repo-root', repo], {
      env: { ...process.env, GITHUB_OUTPUT: outFile, BUILDD_API_KEY: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    const outputs = Object.fromEntries(
      readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(code).toBe(0);
    expect(outputs.skip).toBe('false');
  });

  test('skips when only unwatched files changed since the recorded sha', async () => {
    const firstSha = commit('initial');
    store.set('spec-conformance-last-sha', firstSha);

    writeFileSync(join(repo, 'apps', 'unrelated.ts'), 'export function unrelated() { return 1; }\n');
    commit('touch unrelated file');

    const { outputs } = await runGate('check', { BUILDD_API_KEY: 'test-key' });
    expect(outputs.skip).toBe('true');
    expect(outputs['changed-count']).toBe('0');
  });

  test('runs when a watched file (referenced by an assertion) changed', async () => {
    const firstSha = commit('initial');
    store.set('spec-conformance-last-sha', firstSha);

    writeFileSync(join(repo, 'apps', 'foo.ts'), 'export function foo() { return 1; }\n');
    commit('touch watched file');

    const { outputs } = await runGate('check', { BUILDD_API_KEY: 'test-key' });
    expect(outputs.skip).toBe('false');
    expect(outputs['changed-count']).toBe('1');
  });

  test('runs when a file under docs/design/** changed even with no assertion referencing it', async () => {
    const firstSha = commit('initial');
    store.set('spec-conformance-last-sha', firstSha);

    writeFileSync(join(repo, 'docs', 'design', 'watched.md'), readFileSync(join(repo, 'docs', 'design', 'watched.md'), 'utf8') + '\nmore text\n');
    commit('touch design doc');

    const { outputs } = await runGate('check', { BUILDD_API_KEY: 'test-key' });
    expect(outputs.skip).toBe('false');
  });

  test('fails open when the recorded sha is not reachable in this checkout', async () => {
    commit('initial');
    store.set('spec-conformance-last-sha', '0000000000000000000000000000000000dead');

    const { outputs } = await runGate('check', { BUILDD_API_KEY: 'test-key' });
    expect(outputs.skip).toBe('false');
  });
});

describe('spec-conformance-delta-gate record', () => {
  test('POSTs the current HEAD sha keyed as spec-conformance-last-sha', async () => {
    const sha = commit('initial');
    await runGate('record', { BUILDD_API_KEY: 'test-key' });

    expect(lastPostBody).not.toBeNull();
    expect(lastPostBody.key).toBe('spec-conformance-last-sha');
    expect(lastPostBody.content).toBe(sha);
    expect(store.get('spec-conformance-last-sha')).toBe(sha);
  });

  test('no-ops without BUILDD_API_KEY — does not throw or write', async () => {
    commit('initial');
    const res = await runGate('record', { BUILDD_API_KEY: '' });
    expect(res.code).toBe(0);
    expect(lastPostBody).toBeNull();
  });
});
