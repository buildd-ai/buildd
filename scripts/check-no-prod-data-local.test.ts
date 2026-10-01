import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(import.meta.dir, 'check-no-prod-data-local.sh');

let dir: string;

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(msg: string) {
  writeFileSync(join(dir, 'f.txt'), msg + Math.random());
  git('add', 'f.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg);
}

function resolveBase(...extra: string[]) {
  const r = spawnSync('bash', [join(dir, 'scripts/check-no-prod-data-local.sh'), '--resolve-only', ...extra], {
    cwd: dir,
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'npd-local-'));
  git('init', '-q', '-b', 'dev');
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(SCRIPT, join(dir, 'scripts/check-no-prod-data-local.sh'));
  commit('base');
  git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
  commit('mission work');
  git('update-ref', 'refs/remotes/origin/mission/m1', 'HEAD');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('check-no-prod-data-local.sh base resolution', () => {
  test('defaults to origin/dev when no mission branch is nearer', () => {
    git('checkout', '-q', '-b', 'task-a', 'origin/dev');
    commit('task a');
    expect(resolveBase()).toBe('origin/dev');
  });

  test('picks the mission branch a task branch was cut from', () => {
    git('checkout', '-q', '-b', 'task-b', 'origin/mission/m1');
    commit('task b');
    expect(resolveBase()).toBe('origin/mission/m1');
  });

  test('an explicit base-ref wins', () => {
    expect(resolveBase('origin/dev')).toBe('origin/dev');
  });
});
