import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hasTrackedChanges } from '../../src/updater';

describe('updater git env', () => {
  test('an inherited GIT_DIR does not redirect git away from the install dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'upd-git-'));
    const run = (c: string) => execSync(c, { cwd: dir, stdio: 'pipe' });
    run('git init -q && git config user.email a@b.c && git config user.name t');
    writeFileSync(join(dir, 'f'), '1');
    run('git add f && git commit -qm init');
    writeFileSync(join(dir, 'f'), '2');
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = join(tmpdir(), 'not-a-repo-xyz');
    try {
      expect(hasTrackedChanges(dir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prev;
    }
  });
});
