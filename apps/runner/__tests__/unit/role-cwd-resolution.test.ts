/**
 * Where a role-assigned session runs, and where its role files land.
 *
 * Two defects met here (and since: no role file outlives its session — see
 * session-prompt-files.test.ts). (1) cwd was keyed off the role bundle's `type`, which
 * is derived from the role row's `repoUrl` — a field the dashboard role editor
 * never sends. So every role saved from the UI packaged as `'service'`, and the
 * runner then pointed repo tasks at `~/.buildd/roles/<slug>`: not a git
 * checkout, none of the task's code in it. (2) the role overlay was written
 * into the base clone BEFORE `git worktree add` cut the session cwd, and
 * `worktree add` only checks out tracked content — so the skills and .mcp.json
 * never arrived.
 *
 * `resolveRoleCwd` keys on the WORKSPACE instead (repo ⇒ repo, always) and
 * hands back the directory to overlay so the caller can do it after the
 * worktree exists.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { resolveRoleCwd, overlayRoleFiles, type RoleConfig, type RoleBundle } from '../../src/roles';
import { sessionRoleDir, sessionPromptRoot } from '../../src/session-prompt-files';

let sandbox = '';
const realFetch = globalThis.fetch;

const BUNDLE: RoleBundle = {
  slug: 'builder',
  type: 'service',
  claudeMd: '# persona',
  mcpConfig: { mcpServers: { demo: { url: 'https://x.test' } } },
  envMapping: {},
  skills: [{ slug: 'demo', name: 'demo', content: '# demo' }],
};

/**
 * The bundle is fetched from its presigned URL on every claim (there is no
 * disk cache); stub the fetch. Session dirs resolve under the injected
 * per-process `BUILDD_HOME`, never the operator's real one.
 */
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'role-cwd-'));
  globalThis.fetch = (async () => new Response(JSON.stringify(BUNDLE), { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(sessionPromptRoot(), { recursive: true, force: true });
});

function roleConfig(overrides: Partial<RoleConfig> = {}): RoleConfig {
  return {
    slug: 'builder',
    configHash: 'hash-1',
    configUrl: 'https://r2.test/builder.json',
    type: 'service',
    model: 'inherit',
    allowedTools: [],
    canDelegateTo: [],
    background: false,
    maxTurns: null,
    ...overrides,
  };
}

const repoTask = { roleSlug: 'builder', workspace: { repo: 'acme/widgets' } };
const serviceTask = { roleSlug: 'builder', workspace: { repo: null } };

describe('resolveRoleCwd — packaged role', () => {
  // The headline regression: a `service`-typed bundle on a repo workspace.
  test('a service-typed bundle on a repo task still runs in the repo', async () => {
    const result = await resolveRoleCwd(roleConfig({ type: 'service' }), repoTask, '/repos/widgets', 'w1');

    expect(result.cwd).toBe('/repos/widgets');
    expect(result.overlay).toBe(true);
    expect(result.roleBundle?.slug).toBe('builder');
  });

  test('a builder-typed bundle on a repo task runs in the repo', async () => {
    const result = await resolveRoleCwd(roleConfig({ type: 'builder', repoUrl: 'https://github.com/acme/widgets' }), repoTask, '/repos/widgets', 'w1');

    expect(result.cwd).toBe('/repos/widgets');
    expect(result.overlay).toBe(true);
  });

  // The role dir is the cwd only when there is no repo to run in — a
  // coordination workspace. It is this worker's session dir, not a cache.
  test('a task with no repo runs in the session role dir, with nothing to overlay', async () => {
    const result = await resolveRoleCwd(roleConfig({ type: 'builder' }), serviceTask, '/repos/coordination', 'w1');

    expect(result.cwd).toBe(sessionRoleDir('w1'));
    expect(existsSync(result.cwd)).toBe(true);
    expect(result.overlay).toBeUndefined();
  });

  test('a failed bundle download is an error, not a stale local copy', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 403, statusText: 'Forbidden' })) as unknown as typeof fetch;
    await expect(resolveRoleCwd(roleConfig(), repoTask, '/repos/widgets', 'w1')).rejects.toThrow('403');
  });
});

describe('resolveRoleCwd — unpackaged role (no bundle on the claim)', () => {
  test('a repo task runs in the repo with no role files', async () => {
    const result = await resolveRoleCwd(undefined, repoTask, '/repos/widgets', 'w1');
    expect(result).toEqual({ cwd: '/repos/widgets' });
  });

  test('a task with no repo runs in the workspace path — nothing is reused from disk', async () => {
    const result = await resolveRoleCwd(undefined, serviceTask, '/repos/coordination', 'w1');
    expect(result).toEqual({ cwd: '/repos/coordination' });
  });

  test('a task with no role at all leaves the workspace path alone', async () => {
    const result = await resolveRoleCwd(undefined, { workspace: { repo: 'acme/widgets' } }, '/repos/widgets', 'w1');
    expect(result).toEqual({ cwd: '/repos/widgets' });
  });
});

describe('overlayRoleFiles into a worktree', () => {
  test('.mcp.json lands under the session cwd; skills wait for the session', async () => {
    const worktree = join(sandbox, 'worktrees', 'task-1');
    mkdirSync(worktree, { recursive: true });

    await overlayRoleFiles(BUNDLE, worktree);

    expect(JSON.parse(readFileSync(join(worktree, '.mcp.json'), 'utf-8')).mcpServers.demo).toBeDefined();
    expect(existsSync(join(worktree, '.claude', 'skills', 'demo'))).toBe(false);
  });

  // The repo's own CLAUDE.md is the project's, not the role's; the persona
  // travels via the system prompt instead.
  test('does not clobber the project CLAUDE.md', async () => {
    const worktree = join(sandbox, 'worktrees', 'task-2');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'CLAUDE.md'), '# project instructions');

    await overlayRoleFiles(BUNDLE, worktree);

    expect(readFileSync(join(worktree, 'CLAUDE.md'), 'utf-8')).toBe('# project instructions');
  });
});

// ─── Source-shape guards on the call sites ──────────────────────────────────
// Read via Bun.file so this stays independent of any fs stub.
const workersSrc = await Bun.file(join(import.meta.dir, '../../src/workers.ts')).text();

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { n++; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

describe('workers.ts call sites', () => {
  test('both claim entry points resolve cwd through resolveRoleCwd', () => {
    // startClaimedWorker (poll claim) and claimAndStart (nudge/resume claim)
    // carried byte-identical copies of the branching this replaces. Both now
    // go through prepareClaimedWorker, the single call site.
    expect(countOccurrences(workersSrc, 'resolveRoleCwd(')).toBe(1);
    expect(countOccurrences(workersSrc, 'this.prepareClaimedWorker(')).toBe(2);
  });

  test('cwd is never keyed off the bundle type again', () => {
    expect(workersSrc).not.toContain("roleConfig.type === 'service'");
  });

  test('the overlay runs after worktree setup, not before', () => {
    const setup = workersSrc.indexOf('await setupWorktree(');
    const overlay = workersSrc.indexOf('overlayRoleFiles(');
    expect(setup).toBeGreaterThan(-1);
    expect(overlay).toBeGreaterThan(setup);
  });

  test('the overlay targets the session cwd', () => {
    const call = workersSrc.slice(workersSrc.indexOf('overlayRoleFiles('));
    expect(call.slice(0, 120)).toContain('sessionCwd');
  });

  test('role files are not read off a persistent per-slug dir', () => {
    expect(workersSrc).not.toContain('getRoleDir(');
    expect(workersSrc).not.toContain('syncRoleToLocal(');
  });
});
