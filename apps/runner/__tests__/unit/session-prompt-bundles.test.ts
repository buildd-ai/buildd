/**
 * A resumed session has the same role and skill files as a fresh one.
 *
 * Since #3536 the role/skill payload lives in memory on the worker and on disk
 * only for one session. The persisted worker record carries none of it, so a
 * worker restored after a runner restart (or a park → reattach) used to resume
 * with no skills. rehydratePromptBundles re-fetches it; writeSessionPromptFiles
 * is what both fresh and resumed sessions write.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { rehydratePromptBundles, writeSessionPromptFiles, type PromptBundlesPayload } from '../../src/session-prompt-bundles';
import { cleanupSessionPromptFiles, sessionPromptRoot } from '../../src/session-prompt-files';
import { saveWorker, loadWorker, __resetWorkerStoreRoot } from '../../src/worker-store';
import type { RoleBundle, RoleConfig } from '../../src/roles';
import type { LocalWorker } from '../../src/types';

let sandbox = '';
const realBuilddHome = process.env.BUILDD_HOME;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'prompt-bundles-'));
  process.env.BUILDD_HOME = join(sandbox, 'buildd-home');
  __resetWorkerStoreRoot();
});

afterEach(() => {
  rmSync(sessionPromptRoot(), { recursive: true, force: true });
  if (realBuilddHome === undefined) delete process.env.BUILDD_HOME; else process.env.BUILDD_HOME = realBuilddHome;
  __resetWorkerStoreRoot();
  rmSync(sandbox, { recursive: true, force: true });
});

const roleConfig: RoleConfig = {
  slug: 'builder', configHash: 'h1', configUrl: 'https://r2.example/presigned/builder', type: 'builder',
  model: 'inherit', allowedTools: [], canDelegateTo: [], background: false, maxTurns: null,
};
const roleBundle: RoleBundle = {
  slug: 'builder', type: 'builder', claudeMd: '# role', mcpConfig: {}, envMapping: {},
  skills: [{ slug: 'role-review', name: 'Role Review', content: 'review steps' }],
};
const payload: PromptBundlesPayload = {
  skillBundles: [
    { slug: 'ship-it', name: 'Ship It', content: 'ship body' } as any,
    { slug: 'changelog', name: 'Changelog', content: 'changelog body' } as any,
  ],
  roleConfig,
  roleInstructions: { slug: 'builder', name: 'Builder', content: 'You build.' },
};

function freshWorker(id = 'w-resume-1'): LocalWorker {
  return {
    id, taskId: 't-1', taskTitle: 'T', taskDescription: 'D', workspaceId: 'ws', workspaceName: 'ws',
    branch: 'b', status: 'working', hasNewActivity: false, lastActivity: Date.now(), milestones: [],
    currentAction: '', commits: [], output: [], toolCalls: [], messages: [],
    phaseText: null, phaseStart: null, phaseToolCount: 0, phaseTools: [],
  } as LocalWorker;
}

/** Every SKILL.md under <cwd>/.claude/skills, slug → content. */
function skillSet(cwd: string): Record<string, string> {
  const root = join(cwd, '.claude', 'skills');
  if (!existsSync(root)) return {};
  const out: Record<string, string> = {};
  for (const slug of readdirSync(root).sort()) out[slug] = readFileSync(join(root, slug, 'SKILL.md'), 'utf-8');
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

function cwdNamed(name: string): string {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('a resumed session gets the same skill set as a fresh one', () => {
  test('restored from disk after a restart: re-fetched, written, removed at session end, nothing in ~/.claude/skills', async () => {
    // Fresh session: the claim delivered the payload in memory.
    const fresh = freshWorker();
    Object.assign(fresh, { skillBundles: payload.skillBundles, roleConfig, roleBundle, roleInstructions: payload.roleInstructions, promptBundlesLoaded: true });
    const freshCwd = cwdNamed('fresh');
    const freshWrite = await writeSessionPromptFiles(fresh, freshCwd);
    const freshSkills = skillSet(freshCwd);
    expect(Object.keys(freshSkills)).toEqual(['changelog', 'role-review', 'ship-it']);
    expect(freshWrite.wroteSkills).toBe(true);
    saveWorker(fresh);
    cleanupSessionPromptFiles(fresh.id);
    expect(skillSet(freshCwd)).toEqual({});

    // Runner restart: the persisted record carries none of the payload.
    const restored = loadWorker(fresh.id)!;
    expect(restored).toBeTruthy();
    expect(restored.skillBundles).toBeUndefined();
    expect(restored.roleBundle).toBeUndefined();
    expect(restored.roleConfig).toBeUndefined();
    expect(restored.roleInstructions).toBeUndefined();
    expect(restored.promptBundlesLoaded).toBeUndefined();

    const fetched: string[] = [];
    const roleFetches: string[] = [];
    const outcome = await rehydratePromptBundles(restored, {
      fetchPromptBundles: async (id) => { fetched.push(id); return payload; },
      fetchRoleBundle: async (rc) => { roleFetches.push(rc.configUrl); return roleBundle; },
    });
    expect(fetched).toEqual([fresh.id]);
    expect(roleFetches).toEqual([roleConfig.configUrl]);
    expect(outcome).toEqual({ kind: 'restored', skills: ['ship-it', 'changelog'], role: 'builder' });
    expect(restored.roleInstructions?.content).toBe('You build.');
    expect(restored.roleConfig?.slug).toBe('builder');

    const resumedCwd = cwdNamed('resumed');
    await writeSessionPromptFiles(restored, resumedCwd);
    expect(skillSet(resumedCwd)).toEqual(freshSkills);

    // Every SKILL.md written, fresh or resumed, is under a session cwd — none
    // under BUILDD_HOME or anywhere else (the user's ~/.claude/skills is never a target).
    const written = walk(sandbox).filter(p => p.endsWith('/SKILL.md'));
    expect(written.length).toBe(3);
    for (const p of written) expect(p.startsWith(join(resumedCwd, '.claude', 'skills') + '/')).toBe(true);

    cleanupSessionPromptFiles(restored.id);
    expect(skillSet(resumedCwd)).toEqual({});
  });

  test('a worker this process claimed is not re-fetched', async () => {
    const w = freshWorker();
    w.promptBundlesLoaded = true;
    let calls = 0;
    const outcome = await rehydratePromptBundles(w, { fetchPromptBundles: async () => { calls++; return payload; } });
    expect(outcome).toEqual({ kind: 'present' });
    expect(calls).toBe(0);
  });

  test('a task with no role and no skills restores to nothing, and is not asked again', async () => {
    const w = freshWorker();
    let calls = 0;
    const deps = { fetchPromptBundles: async () => { calls++; return {}; } };
    expect(await rehydratePromptBundles(w, deps)).toEqual({ kind: 'restored', skills: [] });
    expect(await rehydratePromptBundles(w, deps)).toEqual({ kind: 'present' });
    expect(calls).toBe(1);
    const cwd = cwdNamed('empty');
    expect(await writeSessionPromptFiles(w, cwd)).toEqual({ wroteSkills: false, syncedSkills: [] });
  });

  test('fail-open: an unreachable server or role bundle never throws, and the next resume tries again', async () => {
    const w = freshWorker();
    expect((await rehydratePromptBundles(w, { fetchPromptBundles: async () => null })).kind).toBe('failed');
    expect((await rehydratePromptBundles(w, { fetchPromptBundles: async () => { throw new Error('ECONNRESET'); } })).kind).toBe('failed');
    expect((await rehydratePromptBundles(w, {
      fetchPromptBundles: async () => payload,
      fetchRoleBundle: async () => { throw new Error('403 expired'); },
    })).kind).toBe('failed');
    expect(w.promptBundlesLoaded).toBeUndefined();
    expect(w.skillBundles).toBeUndefined();

    const ok = await rehydratePromptBundles(w, { fetchPromptBundles: async () => payload, fetchRoleBundle: async () => roleBundle });
    expect(ok.kind).toBe('restored');
  });
});
