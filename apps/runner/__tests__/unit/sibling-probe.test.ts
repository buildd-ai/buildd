import { describe, test, expect, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { conflictHunks, enqueueSiblingProbes, findMergirafBinary, isSafeBranchName, parseMergeTreeOutput, runSiblingProbe } from '../../src/sibling-probe';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** `mine` (checked out) and `theirs` both edit m.ts from one base. */
function repo(base: string, mine: string, theirs: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sibling-probe-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'm.ts'), base);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'theirs');
  writeFileSync(join(dir, 'm.ts'), theirs);
  git(dir, 'commit', '-qam', 'theirs');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-qb', 'mine');
  writeFileSync(join(dir, 'm.ts'), mine);
  git(dir, 'commit', '-qam', 'mine');
  return dir;
}

const req = (mergiraf = false) => ({ probeId: 'p1', otherBranch: 'theirs', sharedFiles: ['m.ts'], mergiraf });

describe('runSiblingProbe', () => {
  test('a clean merge-tree (edits far apart in one file) is clean', async () => {
    const base = Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    const dir = repo(base, base.replace('v1 = 1', 'v1 = 100'), base.replace('v18 = 18', 'v18 = 180'));
    const r = await runSiblingProbe(dir, req(), { otherRef: 'theirs' });
    expect(r.outcome).toBe('clean');
    expect(r.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.otherSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('a real conflict names the file and its conflict lines, and does not touch the worktree', async () => {
    const dir = repo('export const x = 1;\n', 'export const x = 2;\n', 'export const x = 3;\n');
    const r = await runSiblingProbe(dir, req(), { otherRef: 'theirs' });
    expect(r.outcome).toBe('conflict');
    expect(r.conflicts).toEqual([{ path: 'm.ts', hunks: [{ startLine: 1, endLine: 5 }] }]);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('mine');
  });

  const hasMergiraf = !!findMergirafBinary();
  const importsBase = 'import { a } from "./a";\n\nexport const x = 1;\n';
  const importsMine = 'import { a } from "./a";\nimport { b } from "./b";\n\nexport const x = 1;\n';
  const importsTheirs = 'import { a } from "./a";\nimport { c } from "./c";\n\nexport const x = 1;\n';

  test.skipIf(!hasMergiraf)('a conflict mergiraf resolves structurally is mergiraf_resolved, not a conflict', async () => {
    const dir = repo(importsBase, importsMine, importsTheirs);
    const r = await runSiblingProbe(dir, req(true), { otherRef: 'theirs' });
    expect(r.outcome).toBe('mergiraf_resolved');
    expect(r.resolvedByMergiraf).toEqual(['m.ts']);
  });

  test.skipIf(!hasMergiraf)('mergiraf does not hide a real same-line conflict', async () => {
    const dir = repo('export const x = 1;\n', 'export const x = 2;\n', 'export const x = 3;\n');
    expect((await runSiblingProbe(dir, req(true), { otherRef: 'theirs' })).outcome).toBe('conflict');
  });

  test('mergiraf is not tried unless the workspace enables it', async () => {
    const dir = repo(importsBase, importsMine, importsTheirs);
    expect((await runSiblingProbe(dir, req(false), { otherRef: 'theirs', mergirafPath: '/nonexistent/mergiraf' })).outcome).toBe('conflict');
  });

  test('enabled but not installed: a plain conflict', async () => {
    const dir = repo(importsBase, importsMine, importsTheirs);
    expect((await runSiblingProbe(dir, req(true), { otherRef: 'theirs', mergirafPath: null })).outcome).toBe('conflict');
  });

  test('a missing branch is an error result, never a throw', async () => {
    const dir = repo('a\n', 'b\n', 'c\n');
    const r = await runSiblingProbe(dir, { ...req(), otherBranch: 'nope' }, { otherRef: 'nope' });
    expect(r.outcome).toBe('error');
    expect(r.error).toBeTruthy();
  });
});

describe('review finding: the fetch never touches the agent\'s FETCH_HEAD and never trusts the branch name', () => {
  /** `repo()` with an `origin` remote (the repo itself) so the real fetch path runs. */
  function repoWithOrigin(base: string, mine: string, theirs: string): string {
    const dir = repo(base, mine, theirs);
    git(dir, 'remote', 'add', 'origin', dir);
    writeFileSync(join(dir, '.git', 'FETCH_HEAD'), 'agent-owned-sentinel\n');
    return dir;
  }
  const fetchHead = (dir: string) => readFileSync(join(dir, '.git', 'FETCH_HEAD'), 'utf-8');
  const probeRefs = (dir: string) => git(dir, 'for-each-ref', '--format=%(refname)', 'refs/buildd/probe/');

  test('fetches into a private ref, leaves FETCH_HEAD alone, and cleans the ref up', async () => {
    const dir = repoWithOrigin('export const x = 1;\n', 'export const x = 2;\n', 'export const x = 3;\n');
    const r = await runSiblingProbe(dir, { ...req(), probeId: '6f1c2b0e-9d7a-4c1e-8f00-000000000001' });
    expect(r.outcome).toBe('conflict');
    expect(r.otherSha).toBe(git(dir, 'rev-parse', 'theirs'));
    expect(fetchHead(dir)).toBe('agent-owned-sentinel\n');
    expect(probeRefs(dir)).toBe('');
  });

  test.each([
    '--upload-pack=touch /tmp/pwned',
    '-x',
    'a..b',
    'has space',
    'refs/heads/x:refs/heads/y',
    'x\nmain',
    '',
  ])('a branch name like %p is refused before any git runs', async (otherBranch) => {
    const dir = repoWithOrigin('a\n', 'b\n', 'c\n');
    const r = await runSiblingProbe(dir, { ...req(), otherBranch });
    expect(r.outcome).toBe('error');
    expect(r.error).toContain('invalid');
    expect(fetchHead(dir)).toBe('agent-owned-sentinel\n');
    expect(probeRefs(dir)).toBe('');
  });

  test('a probe id that is not a plain token is refused', async () => {
    const dir = repoWithOrigin('a\n', 'b\n', 'c\n');
    const r = await runSiblingProbe(dir, { ...req(), probeId: '../../heads/main' });
    expect(r.outcome).toBe('error');
    expect(r.error).toContain('invalid');
  });

  test('isSafeBranchName accepts ordinary branch names', () => {
    expect(isSafeBranchName('buildd/1141e62e-feat-coordination-same-file-ov')).toBe(true);
    expect(isSafeBranchName('mission/x_y.z')).toBe(true);
    expect(isSafeBranchName('-rf')).toBe(false);
    expect(isSafeBranchName('a/../b')).toBe(false);
    expect(isSafeBranchName('x.lock')).toBe(false);
  });
});

describe('review finding: the mergiraf path runs in CI with a stub driver', () => {
  function stub(exitCode: number): { path: string; log: string } {
    const d = mkdtempSync(join(tmpdir(), 'mergiraf-stub-'));
    dirs.push(d);
    const log = join(d, 'calls.log');
    const path = join(d, 'mergiraf');
    writeFileSync(path, `#!/bin/sh\necho "$@" >> '${log}'\nexit ${exitCode}\n`);
    chmodSync(path, 0o755);
    return { path, log };
  }
  const importsBase = 'import { a } from "./a";\n\nexport const x = 1;\n';
  const importsMine = 'import { a } from "./a";\nimport { b } from "./b";\n\nexport const x = 1;\n';
  const importsTheirs = 'import { a } from "./a";\nimport { c } from "./c";\n\nexport const x = 1;\n';

  test('a driver that merges cleanly (exit 0) makes it mergiraf_resolved, called with the three stages', async () => {
    const s = stub(0);
    const dir = repo(importsBase, importsMine, importsTheirs);
    const r = await runSiblingProbe(dir, req(true), { otherRef: 'theirs', mergirafPath: s.path });
    expect(r.outcome).toBe('mergiraf_resolved');
    expect(r.resolvedByMergiraf).toEqual(['m.ts']);
    const call = readFileSync(s.log, 'utf-8').trim();
    expect(call).toMatch(/^merge -p m\.ts -o \S+out\.m\.ts \S+base\.m\.ts \S+ours\.m\.ts \S+theirs\.m\.ts$/);
  });

  test('a driver that leaves conflicts (non-zero) keeps it a conflict', async () => {
    const s = stub(1);
    const dir = repo(importsBase, importsMine, importsTheirs);
    const r = await runSiblingProbe(dir, req(true), { otherRef: 'theirs', mergirafPath: s.path });
    expect(r.outcome).toBe('conflict');
    expect(r.conflicts?.map(c => c.path)).toEqual(['m.ts']);
  });
});

describe('parsers', () => {
  test('parseMergeTreeOutput reads the tree and the conflicted stages', () => {
    const out = 'abc\n100644 111 1\tm.ts\n100644 222 2\tm.ts\n100644 333 3\tm.ts\n\nAuto-merging m.ts\n';
    const p = parseMergeTreeOutput(out);
    expect(p.tree).toBe('abc');
    expect([...p.conflicted.get('m.ts')!.entries()]).toEqual([[1, '111'], [2, '222'], [3, '333']]);
  });

  test('conflictHunks finds each marker region', () => {
    expect(conflictHunks('a\n<<<<<<< x\nb\n=======\nc\n>>>>>>> y\nd\n<<<<<<< x\ne\n>>>>>>> y\n')).toEqual([
      { startLine: 2, endLine: 6 },
      { startLine: 8, endLine: 10 },
    ]);
  });
});

describe('enqueueSiblingProbes', () => {
  const probe = (id: string) => ({ probeId: id, otherBranch: 'b', sharedFiles: [], mergiraf: false });

  test('runs each handed-out probe once, in order, and parks the results for the next sync', async () => {
    const worker: any = { worktreePath: '/wt' };
    const ran: string[] = [];
    const run = async (_cwd: string, r: any) => { ran.push(r.probeId); return { probeId: r.probeId, outcome: 'clean' as const }; };
    const drain = enqueueSiblingProbes(worker, [probe('p1'), probe('p2')], run);
    // Handed out again while running: not queued twice.
    expect(enqueueSiblingProbes(worker, [probe('p2')], run)).toBeNull();
    await drain;
    expect(ran).toEqual(['p1', 'p2']);
    expect(worker.pendingSiblingProbeResults.map((r: any) => r.probeId)).toEqual(['p1', 'p2']);
    expect(worker.siblingProbeRunning).toBe(false);
  });

  test('no worktree or no probes: nothing runs', () => {
    expect(enqueueSiblingProbes({}, [probe('p1')])).toBeNull();
    expect(enqueueSiblingProbes({ worktreePath: '/wt' }, undefined)).toBeNull();
  });
});
