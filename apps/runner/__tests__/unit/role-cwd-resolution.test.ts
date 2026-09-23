/**
 * Where a role-assigned session runs, and where its role files land.
 *
 * Two defects met here. (1) cwd was keyed off the role bundle's `type`, which
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

import { resolveRoleCwd, overlayRoleFiles, getRoleDir, type RoleConfig } from '../../src/roles';

let sandbox = '';

/**
 * Role dirs resolve under the injected per-process `BUILDD_HOME`, so seeding
 * one here cannot reach the operator's real `~/.buildd/roles`. The sandbox
 * below only holds the fake worktrees.
 */
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'role-cwd-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(getRoleDir('builder'), { recursive: true, force: true });
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

/**
 * Materialize a role dir at the already-synced hash, so `syncRoleToLocal`
 * short-circuits on its hash file instead of fetching the bundle from R2.
 */
function seedLocalRole(slug: string, hash: string | null, skill = 'demo') {
  const dir = getRoleDir(slug);
  const skillDir = join(dir, '.claude', 'skills', skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `# ${skill}`);
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { url: 'https://x.test' } } }));
  writeFileSync(join(dir, 'CLAUDE.md'), '# persona');
  if (hash) writeFileSync(join(dir, '.buildd-hash'), hash);
  return dir;
}

const repoTask = { roleSlug: 'builder', workspace: { repo: 'acme/widgets' } };
const serviceTask = { roleSlug: 'builder', workspace: { repo: null } };

describe('resolveRoleCwd — packaged role', () => {
  // The headline regression: a `service`-typed bundle on a repo workspace.
  test('a service-typed bundle on a repo task still runs in the repo', async () => {
    const roleDir = seedLocalRole('builder', 'hash-1');
    const result = await resolveRoleCwd(roleConfig({ type: 'service' }), repoTask, '/repos/widgets');

    expect(result.cwd).toBe('/repos/widgets');
    expect(result.overlayFrom).toBe(roleDir);
  });

  test('a builder-typed bundle on a repo task runs in the repo', async () => {
    const roleDir = seedLocalRole('builder', 'hash-1');
    const result = await resolveRoleCwd(roleConfig({ type: 'builder', repoUrl: 'https://github.com/acme/widgets' }), repoTask, '/repos/widgets');

    expect(result.cwd).toBe('/repos/widgets');
    expect(result.overlayFrom).toBe(roleDir);
  });

  // The role dir is the cwd only when there is no repo to run in — a
  // coordination workspace, where it carries the .mcp.json and env mapping the
  // session would otherwise have nowhere to read.
  test('a task with no repo runs in the role dir, with nothing to overlay', async () => {
    const roleDir = seedLocalRole('builder', 'hash-1');
    const result = await resolveRoleCwd(roleConfig({ type: 'builder' }), serviceTask, '/repos/coordination');

    expect(result.cwd).toBe(roleDir);
    expect(result.overlayFrom).toBeUndefined();
  });
});

describe('resolveRoleCwd — unpackaged role (no bundle on the claim)', () => {
  test('a repo task overlays the locally-synced role dir into the repo', async () => {
    const roleDir = seedLocalRole('builder', 'hash-1');
    const result = await resolveRoleCwd(undefined, repoTask, '/repos/widgets');

    expect(result.cwd).toBe('/repos/widgets');
    expect(result.overlayFrom).toBe(roleDir);
  });

  test('a task with no repo falls back to the locally-synced role dir as cwd', async () => {
    const roleDir = seedLocalRole('builder', 'hash-1');
    const result = await resolveRoleCwd(undefined, serviceTask, '/repos/coordination');

    expect(result.cwd).toBe(roleDir);
    expect(result.overlayFrom).toBeUndefined();
  });

  test('nothing local and no bundle leaves the workspace path alone', async () => {
    const result = await resolveRoleCwd(undefined, repoTask, '/repos/widgets');

    expect(result.cwd).toBe('/repos/widgets');
    expect(result.overlayFrom).toBeUndefined();
  });

  test('a task with no role at all leaves the workspace path alone', async () => {
    seedLocalRole('builder', 'hash-1');
    const result = await resolveRoleCwd(undefined, { workspace: { repo: 'acme/widgets' } }, '/repos/widgets');

    expect(result.cwd).toBe('/repos/widgets');
    expect(result.overlayFrom).toBeUndefined();
  });
});

describe('overlayRoleFiles into a worktree', () => {
  test('role skills and .mcp.json land under the session cwd', async () => {
    const roleDir = seedLocalRole('builder', 'hash-1', 'buildd-workflow');
    const worktree = join(sandbox, 'worktrees', 'task-1');
    mkdirSync(worktree, { recursive: true });

    await overlayRoleFiles(roleDir, worktree);

    expect(existsSync(join(worktree, '.claude', 'skills', 'buildd-workflow', 'SKILL.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(worktree, '.mcp.json'), 'utf-8')).mcpServers.demo).toBeDefined();
  });

  // The repo's own CLAUDE.md is the project's, not the role's; the persona
  // travels via the system prompt instead.
  test('does not clobber the project CLAUDE.md', async () => {
    const roleDir = seedLocalRole('builder', 'hash-1');
    const worktree = join(sandbox, 'worktrees', 'task-2');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'CLAUDE.md'), '# project instructions');

    await overlayRoleFiles(roleDir, worktree);

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
    // carried byte-identical copies of the branching this replaces.
    expect(countOccurrences(workersSrc, 'resolveRoleCwd(')).toBe(2);
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
});
