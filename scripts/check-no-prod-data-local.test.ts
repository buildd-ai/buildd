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

describe('--staged / --message-file', () => {
  // Built at run time so this file carries no UUID literal itself.
  const uuid = ['0a1b2c3d', '4e5f', '4a6b', '8c7d', '9e0f1a2b3c4d'].join('-');
  let repo: string;

  function run(...args: string[]) {
    return spawnSync('bash', [join(repo, 'scripts/check-no-prod-data-local.sh'), 'origin/dev', ...args], {
      cwd: repo,
      encoding: 'utf8',
    });
  }
  function g(...args: string[]) {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'npd-staged-'));
    g('init', '-q', '-b', 'dev');
    mkdirSync(join(repo, 'scripts'));
    for (const f of ['check-no-prod-data-local.sh', 'check_no_prod_data.py']) {
      copyFileSync(resolve(import.meta.dir, f), join(repo, 'scripts', f));
    }
    writeFileSync(join(repo, 'a.ts'), '// base\n');
    g('add', '.');
    g('commit', '-q', '-m', 'base');
    g('update-ref', 'refs/remotes/origin/dev', 'HEAD');
    g('checkout', '-q', '-b', 'task');
    writeFileSync(join(repo, 'a.ts'), `// ref ${uuid}\n`);
    g('commit', '-qam', 'add ref');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test('committed HEAD still fails; staged removal of the UUID passes', () => {
    expect(run().status).not.toBe(0);
    writeFileSync(join(repo, 'a.ts'), '// fixed\n');
    g('add', 'a.ts');
    expect(run('--staged').status).toBe(0);
  });

  test('staged addition is caught', () => {
    writeFileSync(join(repo, 'a.ts'), `// new ${uuid}\n`);
    g('add', 'a.ts');
    expect(run('--staged').status).not.toBe(0);
    writeFileSync(join(repo, 'a.ts'), '// fixed\n');
    g('add', 'a.ts');
  });

  test('candidate commit message is scanned', () => {
    const f = join(repo, 'msg.txt');
    writeFileSync(f, `fix: task ${uuid}\n`);
    expect(run('--staged', '--message-file', f).status).not.toBe(0);
    writeFileSync(f, 'fix: task 8237cfa9\n# comment\n');
    expect(run('--staged', '--message-file', f).status).toBe(0);
  });
});
