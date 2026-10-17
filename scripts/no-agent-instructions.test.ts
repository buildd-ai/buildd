import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const script = resolve(import.meta.dir, 'check-no-agent-instructions.sh');

describe('check-no-agent-instructions.sh', () => {
  let dir: string;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf-8' });
  const run = () => spawnSync('bash', [script, 'base'], { cwd: dir, encoding: 'utf-8' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'no-instr-'));
    g('init', '-q');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'CLAUDE.md'), 'rules\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base'); g('branch', 'base');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('passes a clean diff', () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    g('add', '-A'); g('commit', '-q', '-m', 'w');
    expect(run().status).toBe(0);
  });

  test('fails when CLAUDE.md gains the block, including in a later commit', () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    g('add', '-A'); g('commit', '-q', '-m', 'w');
    writeFileSync(join(dir, 'CLAUDE.md'), 'rules\n<!-- BEGIN buildd agent instructions (auto-generated; do not edit) -->\nrole\n');
    g('add', '-A'); g('commit', '-q', '-m', 'later push');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('agent instructions block');
  });

  test('a removed block is not flagged', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'rules\n');
    g('add', '-A');
    expect(run().status).toBe(0);
  });
});
