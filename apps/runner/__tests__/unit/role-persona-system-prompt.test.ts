/**
 * The role persona must actually reach a Claude session.
 *
 * It did not. `overlayRoleFiles` skipped CLAUDE.md on the grounds that "role
 * instructions come via the system prompt", and nothing ever put them there:
 * `systemPrompt.append` carried skills, retry continuity, connector notices,
 * the tool-channel policy and the CBM block — never the role. The only code
 * that read a persona at all was the Codex path, which read the role dir's
 * CLAUDE.md off disk, so a role with no packaged bundle had no persona on
 * either backend.
 *
 * `buildRoleSystemPromptSection` is pinned in the pure tests below; the rest of
 * this file pins that the call site actually appends it, exactly once, on both
 * backends and with or without a bundle.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { join } from 'path';
import type { LocalUIConfig } from '../../src/types';

import * as realRoles from '../../src/roles';
import * as realGitOps from '../../src/git-operations';
import { buildRoleSystemPromptSection } from '../../src/roles';

// ─── Pure: the rendered section ─────────────────────────────────────────────

describe('buildRoleSystemPromptSection', () => {
  test('renders a heading with the role name and the persona body', () => {
    expect(buildRoleSystemPromptSection({ slug: 'builder', name: 'Builder', content: '# You ship code.' }))
      .toBe('\n\n## Role: Builder\n# You ship code.');
  });

  test('falls back to the slug when the name is blank', () => {
    expect(buildRoleSystemPromptSection({ slug: 'builder', name: '  ', content: 'persona' }))
      .toBe('\n\n## Role: builder\npersona');
  });

  // A bare "## Role: X" heading reads as if it should say something.
  test('renders nothing for an absent or blank persona', () => {
    expect(buildRoleSystemPromptSection(undefined)).toBe('');
    expect(buildRoleSystemPromptSection(null)).toBe('');
    expect(buildRoleSystemPromptSection({ slug: 'b', name: 'B', content: '   \n ' })).toBe('');
  });
});

// ─── Behavioural: the assembled prompt ──────────────────────────────────────

let lastQueryOpts: any = null;
let mockMessages: any[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    lastQueryOpts = opts;
    const msgs = [...mockMessages];
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

const mockUpdateWorker = mock(async () => ({}));
const mockClaimTask = mock(async () => ({ workers: [] as any[] }));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
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
    resolve: () => '/tmp/test-workspace',
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

/**
 * Two files matter here: the session cwd's CLAUDE.md, which drives the
 * de-duplication branch, and `.git`, whose absence would (correctly) block a
 * repo task from starting at all. Everything else reads as absent.
 */
let claudeMdInCwd: string | null = null;
mock.module('fs', () => ({
  existsSync: (p: string) => {
    const path = String(p);
    if (path.endsWith('/CLAUDE.md')) return claudeMdInCwd !== null;
    return path.endsWith('/.git');
  },
  readFileSync: (p: string) => (String(p).endsWith('/CLAUDE.md') && claudeMdInCwd !== null ? claudeMdInCwd : '{}'),
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
}));

/**
 * `resolveRoleCwd` is stubbed (it is pinned directly in
 * role-cwd-resolution.test.ts, and the real one would fetch a bundle from R2);
 * `buildRoleSystemPromptSection` — the function under test — is the real one.
 */
mock.module('../../src/roles', () => ({
  ...realRoles,
  syncRoleToLocal: async () => ({ cwd: '/tmp/role-dir' }),
  overlayRoleFiles: async () => {},
  resolveRoleCwd: async (_rc: any, _t: any, workspacePath: string) => ({ cwd: workspacePath }),
  resolveRoleEnv: async () => ({ resolved: {}, missing: [] }),
}));

// A repo task whose worktree setup fails no longer runs in the shared clone,
// so the harness has to hand back a worktree. The path is the workspace so the
// cwd-CLAUDE.md cases below read the same directory either way.
mock.module('../../src/git-operations', () => ({
  ...realGitOps,
  setupWorktree: async (_repo: string, branch: string) => ({ path: '/tmp/test-workspace', branch, base: 'origin/main' }),
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

const PERSONA = '# Builder\nYou ship code, tests first.';
const ROLE_INSTRUCTIONS = { slug: 'builder', name: 'Builder', content: PERSONA };

function makeConfig(): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
  } as LocalUIConfig;
}

/** Drives one claim→session and returns the assembled systemPrompt.append. */
async function runTask(
  manager: InstanceType<typeof WorkerManager>,
  claimExtra: Record<string, unknown>,
  workerId = 'w-role-1',
): Promise<string> {
  mockMessages = [
    { type: 'system', subtype: 'init', session_id: `sess-${workerId}` },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'result', subtype: 'success', session_id: `sess-${workerId}` },
  ];
  const task = {
    id: 'task-role-1',
    title: 'Role persona task',
    description: 'assemble a prompt',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace', repo: 'acme/widgets' },
    roleSlug: 'builder',
    status: 'waiting',
    priority: 1,
  };
  mockClaimTask.mockImplementation(async () => ({ workers: [{
    id: workerId,
    branch: `buildd/${workerId}`,
    worktreePath: '/tmp/test-workspace',
    task,
    ...claimExtra,
  }] }));
  await manager.claimAndStart(task as any);
  await new Promise(r => setTimeout(r, 250));
  return (lastQueryOpts?.options?.systemPrompt?.append ?? '') as string;
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { n++; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

describe('assembled system prompt: role persona', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    lastQueryOpts = null;
    claudeMdInCwd = null;
    mockUpdateWorker.mockClear();
    manager = new WorkerManager(makeConfig());
  });

  afterEach(() => {
    manager?.destroy?.();
  });

  // The seeded-default-role case: no configStorageKey, so no bundle, so the
  // claim carries the persona and nothing else role-shaped.
  test('appends the persona when the claim carries no role bundle', async () => {
    const append = await runTask(manager, { roleInstructions: ROLE_INSTRUCTIONS });

    expect(append).toContain('## Role: Builder');
    expect(append).toContain('You ship code, tests first.');
  });

  // The other half of the acceptance criterion: a role that DID package, but
  // as `service` (the dashboard editor never sends repoUrl), on a repo task.
  test('appends the persona when a service-typed bundle is present', async () => {
    const append = await runTask(manager, {
      roleInstructions: ROLE_INSTRUCTIONS,
      roleConfig: {
        slug: 'builder', configHash: 'h', configUrl: 'https://r2.test/b.json',
        type: 'service', model: 'inherit', allowedTools: [], canDelegateTo: [],
        background: false, maxTurns: null,
      },
    }, 'w-role-2');

    expect(append).toContain('## Role: Builder');
    expect(countOccurrences(append, '## Role: Builder')).toBe(1);
  });

  test('appends nothing when the task resolved no role', async () => {
    const append = await runTask(manager, {}, 'w-role-3');

    expect(append).not.toContain('## Role:');
  });

  // Ordering is load-bearing for the one instruction that must not be talked
  // over: a persona appended after the tool-channel policy reads as the last
  // word on it.
  test('sits before the tool-channel policy', async () => {
    const append = await runTask(manager, { roleInstructions: ROLE_INSTRUCTIONS }, 'w-role-4');

    expect(append.indexOf('## Role: Builder')).toBeLessThan(append.indexOf('## Tool Channel Policy'));
  });

  // A service-role session runs with cwd = the role dir, whose CLAUDE.md IS
  // this text and is already loaded via settingSources: ['project'].
  test('does not duplicate a persona the session cwd already supplies', async () => {
    claudeMdInCwd = PERSONA;
    const append = await runTask(manager, { roleInstructions: ROLE_INSTRUCTIONS }, 'w-role-5');

    expect(append).not.toContain('## Role: Builder');
  });

  // 'user' stays in settingSources for ~/.claude/skills; the host operator's
  // own memory file must not ride along (see host-memory-excludes.ts).
  test('excludes the host user CLAUDE.md from the session', async () => {
    await runTask(manager, { roleInstructions: ROLE_INSTRUCTIONS }, 'w-role-7');

    expect(lastQueryOpts?.options?.settingSources).toContain('user');
    // Shape only: the exact path is the host home, which this file must not
    // read (scripts/test-home-isolation.test.ts).
    const excludes: string[] = lastQueryOpts?.options?.settings?.claudeMdExcludes ?? [];
    expect(excludes.some(p => p.endsWith('/.claude/CLAUDE.md'))).toBe(true);
  });

  test('still appends when the cwd CLAUDE.md is the project, not the role', async () => {
    claudeMdInCwd = '# Widgets\nThis is the project.';
    const append = await runTask(manager, { roleInstructions: ROLE_INSTRUCTIONS }, 'w-role-6');

    expect(append).toContain('## Role: Builder');
  });
});

// ─── Source-shape guard: the Codex path reads the same source ───────────────
const workersSrc = await Bun.file(join(import.meta.dir, '../../src/workers.ts')).text();

describe('workers.ts persona call sites', () => {
  test('appends the persona through the shared helper exactly once', () => {
    expect(countOccurrences(workersSrc, 'buildRoleSystemPromptSection(')).toBe(1);
  });

  // Codex used to read the role dir's CLAUDE.md off disk, which exists only for
  // a role that was packaged to R2 — so the two backends disagreed about
  // whether the agent had a persona at all.
  test('Codex no longer reads the persona off the role directory', () => {
    expect(workersSrc).not.toContain("join(getRoleDir(worker.roleConfig.slug), 'CLAUDE.md')");
  });

  test('Codex builds its persona from roleInstructions', () => {
    const doc = workersSrc.indexOf('buildCodexInstructionDoc(');
    const persona = workersSrc.lastIndexOf('roleInstructions', doc);
    expect(persona).toBeGreaterThan(-1);
    expect(doc - persona).toBeLessThan(2000);
  });
});
