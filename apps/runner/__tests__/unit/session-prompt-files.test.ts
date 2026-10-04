/**
 * Role and skill text is never left on the runner's disk between sessions.
 *
 * Before: role bundles were cached at `~/.buildd/roles/<slug>/` behind a hash
 * file, and skill bundles at `~/.claude/skills/<slug>/` — the user's own skills
 * directory — and both survived every task. A later task reused them from disk.
 *
 * Now: every file is written for one session (into the session cwd's
 * `.claude/skills`, which the SDK reads via the `project` setting source, or
 * into `<BUILDD_HOME>/session-prompts/<workerId>/`), recorded in a manifest,
 * and removed at session end; a crashed runner's leftovers go at next start.
 * Only runner-written dirs are ever removed.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { syncSkillToLocal } from '../../src/skills';
import {
  cleanupSessionPromptFiles,
  sweepStaleSessionPromptFiles,
  sessionPromptDir,
  sessionPromptRoot,
  sessionRoleDir,
  projectMemoryExcludes,
  claimPromptDir,
} from '../../src/session-prompt-files';
import { resolveRoleCwd, writeSessionRoleFiles, overlayRoleFiles, type RoleConfig, type RoleBundle } from '../../src/roles';

let sandbox = '';
let fakeHome = '';
const realFetch = globalThis.fetch;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'session-prompts-'));
  fakeHome = join(sandbox, 'home');
  mkdirSync(fakeHome, { recursive: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(sessionPromptRoot(), { recursive: true, force: true });
});

const bundle = (content = '# Changelog\nWrite entries.') => ({
  slug: 'changelog-generator',
  name: 'Changelog Generator',
  content,
});

function worktree(name = 'wt'): string {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('syncSkillToLocal writes into the session cwd', () => {
  test('lands in <cwd>/.claude/skills/<slug>/SKILL.md with frontmatter the SDK needs', async () => {
    const cwd = worktree();
    const res = await syncSkillToLocal(bundle(), { sessionCwd: cwd, workerId: 'w1' });

    const skillMd = join(cwd, '.claude', 'skills', 'changelog-generator', 'SKILL.md');
    expect(res.path).toBe(join(cwd, '.claude', 'skills', 'changelog-generator'));
    expect(readFileSync(skillMd, 'utf-8')).toStartWith('---\nname: changelog-generator\n');
  });

  test('never caches: a second session with new content rewrites it', async () => {
    const cwd = worktree();
    await syncSkillToLocal(bundle('v1 body'), { sessionCwd: cwd, workerId: 'w1' });
    await syncSkillToLocal(bundle('v2 body'), { sessionCwd: cwd, workerId: 'w1' });

    const text = readFileSync(join(cwd, '.claude', 'skills', 'changelog-generator', 'SKILL.md'), 'utf-8');
    expect(text).toContain('v2 body');
    expect(existsSync(join(cwd, '.claude', 'skills', 'changelog-generator', '.buildd-hash'))).toBe(false);
  });

  test('git ignores the written skill, so `git add -A` cannot commit it', async () => {
    const cwd = worktree();
    spawnSync('git', ['init', '-q'], { cwd });
    await syncSkillToLocal(bundle(), { sessionCwd: cwd, workerId: 'w1' });

    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf-8' });
    expect(status.status).toBe(0);
    expect(status.stdout.trim()).toBe('');
  });

  test('a skill the repo already ships at that path is left untouched', async () => {
    const cwd = worktree();
    const repoSkill = join(cwd, '.claude', 'skills', 'changelog-generator');
    mkdirSync(repoSkill, { recursive: true });
    writeFileSync(join(repoSkill, 'SKILL.md'), '# the repo version');

    const res = await syncSkillToLocal(bundle(), { sessionCwd: cwd, workerId: 'w1' });
    expect(res.skipped).toBe('exists');
    cleanupSessionPromptFiles('w1');

    expect(readFileSync(join(repoSkill, 'SKILL.md'), 'utf-8')).toBe('# the repo version');
  });

  test('rejects a slug that escapes the skills dir', async () => {
    const cwd = worktree();
    await expect(syncSkillToLocal({ ...bundle(), slug: '../../evil' }, { sessionCwd: cwd, workerId: 'w1' })).rejects.toThrow();
    expect(existsSync(join(sandbox, 'evil'))).toBe(false);
  });
});

describe('cleanupSessionPromptFiles', () => {
  test('removes every skill dir the session wrote, and the session dir', async () => {
    const cwd = worktree();
    await syncSkillToLocal(bundle(), { sessionCwd: cwd, workerId: 'w1' });
    await syncSkillToLocal({ ...bundle(), slug: 'second' }, { sessionCwd: cwd, workerId: 'w1' });
    expect(existsSync(sessionPromptDir('w1'))).toBe(true);

    const removed = cleanupSessionPromptFiles('w1');

    expect(removed.length).toBe(2);
    expect(readdirSync(join(cwd, '.claude', 'skills'))).toEqual([]);
    expect(existsSync(sessionPromptDir('w1'))).toBe(false);
  });

  test("leaves the user's own skills and another worker's skills alone", async () => {
    const cwd = worktree();
    const userSkill = join(cwd, '.claude', 'skills', 'mine');
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(userSkill, 'SKILL.md'), '# mine');
    await syncSkillToLocal(bundle(), { sessionCwd: cwd, workerId: 'w1' });
    await syncSkillToLocal({ ...bundle(), slug: 'other' }, { sessionCwd: cwd, workerId: 'w2' });

    cleanupSessionPromptFiles('w1');

    expect(existsSync(join(userSkill, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(cwd, '.claude', 'skills', 'other', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(cwd, '.claude', 'skills', 'changelog-generator'))).toBe(false);
  });

  test('a recorded path whose marker was replaced by someone else is not removed', async () => {
    const cwd = worktree();
    const res = await syncSkillToLocal(bundle(), { sessionCwd: cwd, workerId: 'w1' });
    // The dir was replaced by a user's own skill mid-session.
    rmSync(res.path, { recursive: true, force: true });
    mkdirSync(res.path, { recursive: true });
    writeFileSync(join(res.path, 'SKILL.md'), '# user');

    cleanupSessionPromptFiles('w1');

    expect(readFileSync(join(res.path, 'SKILL.md'), 'utf-8')).toBe('# user');
  });

  test('is a no-op for a worker that wrote nothing', () => {
    expect(cleanupSessionPromptFiles('never-ran')).toEqual([]);
  });
});

describe('sweepStaleSessionPromptFiles (crash recovery at runner start)', () => {
  test("removes a dead process's session dir and the paths its manifest lists", async () => {
    const cwd = worktree();
    await syncSkillToLocal(bundle(), { sessionCwd: cwd, workerId: 'crashed' });
    // Pretend the writer was another process that has since died.
    const manifestPath = join(sessionPromptDir('crashed'), 'manifest.json');
    const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    writeFileSync(manifestPath, JSON.stringify({ ...m, pid: 999_999_999 }));

    const res = sweepStaleSessionPromptFiles({ isAlive: () => false, homeDir: fakeHome });

    expect(res.sessions).toContain(sessionPromptDir('crashed'));
    expect(existsSync(join(cwd, '.claude', 'skills', 'changelog-generator'))).toBe(false);
    expect(existsSync(sessionPromptDir('crashed'))).toBe(false);
  });

  test("leaves a live runner's session alone", async () => {
    const cwd = worktree();
    await syncSkillToLocal(bundle(), { sessionCwd: cwd, workerId: 'live' });
    const manifestPath = join(sessionPromptDir('live'), 'manifest.json');
    const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    writeFileSync(manifestPath, JSON.stringify({ ...m, pid: 424242 }));

    sweepStaleSessionPromptFiles({ isAlive: pid => pid === 424242, homeDir: fakeHome });

    expect(existsSync(join(cwd, '.claude', 'skills', 'changelog-generator', 'SKILL.md'))).toBe(true);
  });

  test('removes the legacy persistent caches, never a user skill', () => {
    const legacyRole = join(process.env.BUILDD_HOME!, 'roles', 'builder');
    mkdirSync(legacyRole, { recursive: true });
    writeFileSync(join(legacyRole, 'CLAUDE.md'), '# persona');
    const runnerSkill = join(fakeHome, '.claude', 'skills', 'synced');
    mkdirSync(runnerSkill, { recursive: true });
    writeFileSync(join(runnerSkill, 'SKILL.md'), '# synced');
    writeFileSync(join(runnerSkill, '.buildd-hash'), 'abc');
    const userSkill = join(fakeHome, '.claude', 'skills', 'mine');
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(userSkill, 'SKILL.md'), '# mine');

    sweepStaleSessionPromptFiles({ isAlive: () => false, homeDir: fakeHome });

    expect(existsSync(join(process.env.BUILDD_HOME!, 'roles'))).toBe(false);
    expect(existsSync(runnerSkill)).toBe(false);
    expect(readFileSync(join(userSkill, 'SKILL.md'), 'utf-8')).toBe('# mine');
  });
});

// ─── Roles ───────────────────────────────────────────────────────────────────

const ROLE_BUNDLE: RoleBundle = {
  slug: 'builder',
  type: 'service',
  claudeMd: '# persona text',
  mcpConfig: { mcpServers: { demo: { url: 'https://x.test' } } },
  envMapping: { API_KEY: 'LABEL' },
  skills: [{ slug: 'buildd-workflow', name: 'Buildd workflow', content: '# workflow' }],
};

function roleConfig(): RoleConfig {
  return {
    slug: 'builder', configHash: 'h', configUrl: 'https://r2.test/builder.json', type: 'service',
    model: 'inherit', allowedTools: [], canDelegateTo: [], background: false, maxTurns: null,
  };
}

function stubFetch(): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = (async () => {
    counter.calls++;
    return new Response(JSON.stringify(ROLE_BUNDLE), { status: 200 });
  }) as unknown as typeof fetch;
  return counter;
}

describe('role bundles are fetched per claim and written per session', () => {
  test('every claim re-fetches the bundle (no hash-keyed disk cache)', async () => {
    const counter = stubFetch();
    await resolveRoleCwd(roleConfig(), { workspace: { repo: 'acme/widgets' } }, '/repos/widgets', 'w1');
    await resolveRoleCwd(roleConfig(), { workspace: { repo: 'acme/widgets' } }, '/repos/widgets', 'w2');
    expect(counter.calls).toBe(2);
  });

  test('a leftover legacy role dir is never reused for a role with no bundle', async () => {
    const legacy = join(process.env.BUILDD_HOME!, 'roles', 'builder');
    mkdirSync(join(legacy, '.claude', 'skills', 'demo'), { recursive: true });
    const res = await resolveRoleCwd(undefined, { roleSlug: 'builder', workspace: { repo: null } }, '/repos/coord', 'w1');
    expect(res).toEqual({ cwd: '/repos/coord' });
  });

  test('a repo task overlays role skills into the worktree for the session only', async () => {
    stubFetch();
    const cwd = worktree();
    const res = await resolveRoleCwd(roleConfig(), { workspace: { repo: 'acme/widgets' } }, cwd, 'w1');
    expect(res.cwd).toBe(cwd);
    expect(res.overlay).toBe(true);

    await overlayRoleFiles(res.roleBundle!, cwd);
    await writeSessionRoleFiles(res.roleBundle!, cwd, 'w1');
    expect(readFileSync(join(cwd, '.claude', 'skills', 'buildd-workflow', 'SKILL.md'), 'utf-8')).toBe('# workflow');
    expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8')).mcpServers.demo).toBeDefined();
    expect(existsSync(join(cwd, 'CLAUDE.md'))).toBe(false);

    cleanupSessionPromptFiles('w1');
    expect(existsSync(join(cwd, '.claude', 'skills', 'buildd-workflow'))).toBe(false);
  });

  test('a repo-less task runs in the session role dir, which goes at session end', async () => {
    stubFetch();
    const res = await resolveRoleCwd(roleConfig(), { workspace: { repo: null } }, '/repos/coord', 'w1');
    expect(res.cwd).toBe(sessionRoleDir('w1'));

    await writeSessionRoleFiles(res.roleBundle!, res.cwd, 'w1');
    expect(readFileSync(join(res.cwd, 'CLAUDE.md'), 'utf-8')).toBe('# persona text');
    expect(existsSync(join(res.cwd, '.claude', 'skills', 'buildd-workflow', 'SKILL.md'))).toBe(true);

    cleanupSessionPromptFiles('w1');
    expect(existsSync(res.cwd)).toBe(false);
  });

  test('a resumed session re-writes from the in-memory bundle', async () => {
    const cwd = worktree();
    await writeSessionRoleFiles(ROLE_BUNDLE, cwd, 'w1');
    cleanupSessionPromptFiles('w1');
    await writeSessionRoleFiles(ROLE_BUNDLE, cwd, 'w1');
    expect(existsSync(join(cwd, '.claude', 'skills', 'buildd-workflow', 'SKILL.md'))).toBe(true);
  });
});

describe('claimPromptDir', () => {
  test('records outside paths in the manifest before any text is written', () => {
    const dir = join(worktree(), '.claude', 'skills', 'x');
    claimPromptDir('w1', dir);
    const m = JSON.parse(readFileSync(join(sessionPromptDir('w1'), 'manifest.json'), 'utf-8'));
    expect(m.paths).toEqual([dir]);
    expect(m.pid).toBe(process.pid);
  });
});

describe('projectMemoryExcludes', () => {
  test('covers the cwd and every ancestor', () => {
    const ex = projectMemoryExcludes('/a/b');
    expect(ex).toContain('/a/b/CLAUDE.md');
    expect(ex).toContain('/a/CLAUDE.md');
    expect(ex).toContain('/CLAUDE.md');
    expect(ex).toContain('/a/b/.claude/rules/**');
    expect(ex).toContain('/a/b/CLAUDE.local.md');
  });
});

// ─── Source-shape guards on workers.ts ───────────────────────────────────────
const workersSrc = await Bun.file(join(import.meta.dir, '../../src/workers.ts')).text();

describe('workers.ts wiring', () => {
  test('skills are written into the session cwd, never the user skills dir', () => {
    // startSession writes through writeSessionPromptFiles (fresh and resumed alike).
    expect(workersSrc).toContain('writeSessionPromptFiles(worker, cwd,');
    const bundlesSrc = readFileSync(join(import.meta.dir, '../../src/session-prompt-bundles.ts'), 'utf-8');
    expect(bundlesSrc).toContain('syncSkillToLocal(bundle, { sessionCwd: cwd, workerId: worker.id })');
    expect(bundlesSrc).not.toContain("'.claude', 'skills'");
    expect(workersSrc).not.toContain("'.claude', 'skills'");
  });

  test('startSession cleans the prompt files in its finally', () => {
    const fin = workersSrc.indexOf('cleanupAgentRunnerHome(agentRunnerHome);');
    const clean = workersSrc.indexOf('cleanupSessionPromptFiles(worker.id);');
    expect(clean).toBeGreaterThan(fin);
    expect(clean - fin).toBeLessThan(600);
  });

  test("the 'project' source is on whenever the session wrote skills", () => {
    expect(workersSrc).toContain("settingSources: useClaudeMd || wroteSessionSkills ? ['user', 'project'] : ['user']");
    expect(workersSrc).toContain('projectMemoryExcludes(cwd)');
  });
});
