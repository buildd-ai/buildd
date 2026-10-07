import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { WorkerSync } from '../../src/worker-sync';
import { observeGitProgress } from '../../src/git-observe';

describe('observed git progress', () => {
  test('observes actual commits and a pushed head, including remote descendants', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-evidence-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git('init', '-b', 'work');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('commit', '--allow-empty', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      const updates: any[] = [];
      const worker: any = { id: 'test-worker', status: 'working', milestones: [], subagentTasks: [], worktreePath: root, prBaseRef: base, branch: 'work', checkpointEvents: new Set() };
      const sync = new WorkerSync({ config: {}, buildd: { updateWorker: async (_id: string, update: any) => { updates.push(update); return {}; } }, workers: new Map(), dirtyForDisk: new Set(), emit: () => {} } as any);
      expect(observeGitProgress(root, base, 'work')).toMatchObject({ commitCount: 0, pushed: false });
      writeFileSync(join(root, 'file'), 'change');
      git('add', 'file');
      git('commit', '-m', 'change');
      const head = git('rev-parse', 'HEAD');
      await sync.syncWorkerToServer(worker);
      expect(updates[0]).toMatchObject({ lastCommitSha: head, commitCount: 1 });
      expect(updates[0].milestones).toContainEqual(expect.objectContaining({ type: 'checkpoint', event: 'first_commit' }));
      await sync.syncWorkerToServer(worker);
      expect(updates[1].lastCommitSha).toBeUndefined();
      expect(observeGitProgress(root, base, 'work')).toEqual({ lastCommitSha: head, commitCount: 1, pushed: false });
      git('init', '--bare', join(root, 'remote.git'));
      git('remote', 'add', 'origin', join(root, 'remote.git'));
      git('push', 'origin', 'work');
      expect(observeGitProgress(root, base, 'work')?.pushed).toBe(true);
      // A push changes the remote ref without changing HEAD; the next observation window picks it up.
      (sync as any).gitObservations.get(worker.id).at = 0;
      await sync.syncWorkerToServer(worker);
      expect(updates.at(-1).milestones).toContainEqual(expect.objectContaining({ event: 'first_push' }));
      git('commit', '--allow-empty', '-m', 'next');
      git('push', 'origin', 'work');
      git('reset', '--hard', head);
      expect(observeGitProgress(root, base, 'work')?.pushed).toBe(true);
      expect(observeGitProgress(root, 'missing-base', 'work')).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('command narration cannot fire first_commit', () => {
    const source = readFileSync(join(import.meta.dir, '../../src/workers.ts'), 'utf8');
    const detector = source.slice(source.indexOf('// Detect git commits'), source.indexOf("} else if (toolName === 'Glob'"));
    expect(detector).not.toContain('addCheckpoint');
  });
});
