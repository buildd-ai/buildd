/**
 * A worker session must only ever be pointed at its own worktree — never at
 * the primary clone the worktree is nested inside.
 *
 * Worktrees live at `<primary>/.buildd-worktrees/<slug>`. With the `project`
 * setting source, the Claude CLI loads CLAUDE.md from the cwd AND every
 * ancestor directory, so the primary clone's CLAUDE.md reached every worker's
 * system prompt under the heading `Contents of <primary>/CLAUDE.md` — the
 * primary path, labelled as the project, and whatever stale instructions that
 * checkout happened to have on disk. Workers then ran `cd <primary> && …`.
 *
 * This drives one real claim→session through WorkerManager and pins the
 * assembled options: the primary clone's memory files are excluded, nothing
 * the runner itself supplies names the primary path, and the PreToolUse chain
 * refuses a `cd` into it while leaving the worktree usable.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/primary-clone-exposure.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';
import * as realRoles from '../../src/roles';
import * as realGitOps from '../../src/git-operations';

const PRIMARY = '/tmp/test-primary-clone';
const WORKTREE = `${PRIMARY}/.buildd-worktrees/buildd-w-conf`;

let lastQueryOpts: any = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    lastQueryOpts = opts;
    const msgs = [
      { type: 'system', subtype: 'init', session_id: 'sess-conf' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'result', subtype: 'success', session_id: 'sess-conf' },
    ];
    let idx = 0;
    return {
      streamInput: mock(() => {}),
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (idx < msgs.length) return { value: msgs[idx++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
  },
}));

const mockClaimTask = mock(async () => ({ workers: [] as any[] }));
mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mock(async () => ({}));
    claimTask = mockClaimTask;
    getWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
    getCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
    searchObservations = mock(async () => []);
    getBatchObservations = mock(async () => []);
    createObservation = mock(async () => ({}));
    listWorkspaces = mock(async () => []);
    sendHeartbeat = mock(async () => ({}));
    runCleanup = mock(async () => ({}));
    searchFeedbackMemories = mock(async () => []);
    getWorkerRemote = mock(async () => null);
  },
}));

mock.module('../../src/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: () => PRIMARY,
    debugResolve: () => ({}),
    listLocalDirectories: () => [],
    getPathOverrides: () => ({}),
    setPathOverride: () => {},
    scanGitRepos: () => [],
    getProjectRoots: () => ['/tmp'],
  }),
}));

mock.module('pusher-js', () => ({
  default: class {
    subscribe() { return { bind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

mock.module('fs', () => ({
  existsSync: (p: string) => String(p).endsWith('/.git'),
  readFileSync: () => '{}',
  writeFileSync: () => {},
  mkdirSync: () => {},
  chmodSync: () => {},
  unlinkSync: () => {},
  renameSync: () => {},
  readdirSync: () => [],
  appendFileSync: () => {},
  statSync: () => ({ size: 0, mtimeMs: 0 }),
  copyFileSync: () => {},
  rmSync: () => {},
  realpathSync: (p: string) => p,
}));

mock.module('../../src/roles', () => ({
  ...realRoles,
  syncRoleToLocal: async () => ({ cwd: '/tmp/role-dir' }),
  overlayRoleFiles: async () => {},
  resolveRoleCwd: async (_rc: any, _t: any, workspacePath: string) => ({ cwd: workspacePath }),
  resolveRoleEnv: async () => ({ resolved: {}, missing: [] }),
}));

mock.module('../../src/git-operations', () => ({
  ...realGitOps,
  setupWorktree: async (_repo: string, branch: string) => ({ path: WORKTREE, branch, base: 'origin/main' }),
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => [],
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {},
  loadWorker: () => null,
  deleteWorker: () => {},
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [], mcp: [], mcpServers: [], labels: { type: 'local', os: 'linux', arch: 'x64', hostname: 'test' }, scannedAt: new Date(0).toISOString() }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

const { WorkerManager } = await import('../../src/workers');

/** Everything the runner itself hands the agent, with the worktree path blanked out. */
function withoutWorktree(text: string): string {
  return text.split(WORKTREE).join('<WORKTREE>');
}

async function runPreToolUse(input: Record<string, unknown>): Promise<string | undefined> {
  const groups = lastQueryOpts?.options?.hooks?.PreToolUse ?? [];
  for (const g of groups) {
    for (const h of g.hooks) {
      const r = await h({ hook_event_name: 'PreToolUse', cwd: WORKTREE, ...input }, undefined, { signal: new AbortController().signal });
      const d = r?.hookSpecificOutput?.permissionDecision;
      if (d === 'deny') return 'deny';
    }
  }
  return undefined;
}

describe('worker session never exposes the primary clone', () => {
  let manager: InstanceType<typeof WorkerManager>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // A runner started from inside the primary clone carries it in these.
    for (const k of ['PWD', 'OLDPWD', 'INIT_CWD', 'PROJECTS_ROOT']) {
      savedEnv[k] = process.env[k];
      process.env[k] = PRIMARY;
    }
    manager = new WorkerManager({
      projectsRoot: '/tmp',
      builddServer: 'http://localhost:3000',
      apiKey: 'test-key',
      maxConcurrent: 2,
      model: 'claude-sonnet-4-5-20250929',
      serverless: true,
    } as LocalUIConfig);
    const task = {
      id: 'task-conf-1',
      title: 'Confinement task',
      description: 'do a UI change',
      workspaceId: 'ws-1',
      workspace: { name: 'demo', repo: 'acme/widgets' },
      status: 'waiting',
      priority: 1,
    };
    mockClaimTask.mockImplementation(async () => ({ workers: [{
      id: 'w-conf',
      branch: 'buildd/w-conf',
      task,
    }] }));
    await manager.claimAndStart(task as any);
    await new Promise(r => setTimeout(r, 250));
  });

  afterAll(() => {
    manager?.destroy?.();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('the session runs in the worktree', () => {
    expect(lastQueryOpts?.options?.cwd).toBe(WORKTREE);
  });

  test('the primary clone CLAUDE.md (an ancestor of the worktree) is excluded', () => {
    const excludes: string[] = lastQueryOpts?.options?.settings?.claudeMdExcludes ?? [];
    expect(excludes).toContain(`${PRIMARY}/CLAUDE.md`);
    expect(excludes).toContain(`${PRIMARY}/CLAUDE.local.md`);
    expect(excludes).toContain(`${PRIMARY}/.claude/CLAUDE.md`);
    expect(excludes).toContain(`${PRIMARY}/.claude/rules/**`);
    // ...but never the worktree's own project memory.
    expect(excludes.some(p => p.startsWith(`${WORKTREE}/`))).toBe(false);
  });

  test('the agent env carries no primary path', () => {
    const env: Record<string, string> = lastQueryOpts?.options?.env ?? {};
    for (const [k, v] of Object.entries(env)) {
      expect(`${k}=${withoutWorktree(String(v))}`).not.toContain(PRIMARY);
    }
  });

  test('the appended system prompt names no primary path', () => {
    const append = String(lastQueryOpts?.options?.systemPrompt?.append ?? '');
    expect(withoutWorktree(append)).not.toContain(PRIMARY);
  });

  test('the PreToolUse chain denies cd into the primary clone', async () => {
    expect(await runPreToolUse({ tool_name: 'Bash', tool_input: { command: `cd ${PRIMARY} && bun run test` } })).toBe('deny');
    expect(await runPreToolUse({ tool_name: 'Edit', tool_input: { file_path: `${PRIMARY}/src/a.ts`, old_string: 'a', new_string: 'b' } })).toBe('deny');
  });

  test('...and leaves the worktree usable', async () => {
    expect(await runPreToolUse({ tool_name: 'Bash', tool_input: { command: `cd ${WORKTREE} && git status` } })).toBeUndefined();
    expect(await runPreToolUse({ tool_name: 'Edit', tool_input: { file_path: `${WORKTREE}/src/a.ts`, old_string: 'a', new_string: 'b' } })).toBeUndefined();
  });
});
