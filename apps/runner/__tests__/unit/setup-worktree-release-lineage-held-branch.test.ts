/**
 * M1 (docs/design/pr-merge-reliability.md): a retry's resume branch is still
 * checked out in the prior, terminal attempt's retained worktree. Today
 * setupWorktree diverts to a fresh branch (-> new PR, old one superseded).
 * With BUILDD_RELEASE_LINEAGE_HELD_BRANCH on, a terminal in-lineage holder is
 * detached and the retry resumes the branch. Off (default) = shadow: same
 * diversion as today, plus a log line saying what it would have done.
 *
 * Real git (temp repo + bare origin). Deps are injected with the REAL
 * child_process/fs so only sessionLog is captured — no mock.module.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as cp from 'child_process';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupWorktree, __setGitOpsDeps, __resetGitOpsDeps } from '../../src/git-operations';
import type { LineageHolderRecord } from '../../src/worktree-utils';

const FLAG = 'BUILDD_RELEASE_LINEAGE_HELD_BRANCH';
const RESUME = 'buildd/aaaa1111-fix';
const RETRY_BRANCH = 'buildd/bbbb2222-retry';

function sh(cmd: string, cwd: string): string {
  return cp.execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

let dirs: string[] = [];
let logs: Array<{ event: string; detail?: string }> = [];

function makeFixture(): { repoPath: string; holderPath: string } {
  const bare = fs.mkdtempSync(join(tmpdir(), 'buildd-m1-bare-'));
  dirs.push(bare);
  const barePath = join(bare, 'origin.git');
  sh(`git init --bare -b main "${barePath}"`, bare);
  const repoPath = join(bare, 'clone');
  sh(`git clone "${barePath}" "${repoPath}"`, bare);
  sh('git config user.email test@buildd.dev', repoPath);
  sh('git config user.name buildd-test', repoPath);
  sh('git commit --allow-empty -m init', repoPath);
  sh('git push origin main', repoPath);

  // Prior attempt: its worktree holds RESUME, pushed (the open PR's head).
  const holderPath = join(repoPath, '.buildd-worktrees', 'buildd_aaaa1111-fix');
  sh(`git worktree add -b "${RESUME}" "${holderPath}" origin/main`, repoPath);
  fs.writeFileSync(join(holderPath, 'work.txt'), 'prior attempt\n');
  sh('git add work.txt && git commit -m "prior work"', holderPath);
  sh(`git push -u origin "${RESUME}"`, holderPath);
  return { repoPath, holderPath };
}

function registry(holderPath: string, over: Partial<LineageHolderRecord> = {}): Map<string, LineageHolderRecord> {
  return new Map([['w-prior-00', { worktreePath: holderPath, status: 'done', taskId: 'task-A', ...over }]]);
}

function run(repoPath: string, workers: Map<string, LineageHolderRecord>, released: string[] = [], lineage: { taskId: string; parentTaskId?: string } = { taskId: 'task-B', parentTaskId: 'task-A' }) {
  return setupWorktree(
    repoPath, RETRY_BRANCH, 'main', 'w-new-1234',
    { resumeBranch: RESUME, baseBranch: 'main' },
    workers, undefined,
    { ...lineage, onHolderReleased: (id: string) => released.push(id) },
  );
}

const headOf = (p: string) => sh('git rev-parse --abbrev-ref HEAD', p);
const heldLog = () => logs.filter(l => l.event === 'resume_branch_held').map(l => JSON.parse(l.detail!));

beforeEach(() => {
  logs = [];
  __setGitOpsDeps({
    execSync: cp.execSync, execFile: cp.execFile, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync,
    appendFileSync: fs.appendFileSync, readFileSync: fs.readFileSync, rmSync: fs.rmSync,
    sessionLog: (_w, _l, event, detail) => { logs.push({ event, detail }); },
  });
});
afterEach(() => {
  __resetGitOpsDeps();
  delete process.env[FLAG];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('setupWorktree — lineage-held resume branch', () => {
  test('flag on: terminal parent holder is detached and the retry resumes the branch', async () => {
    process.env[FLAG] = '1';
    const { repoPath, holderPath } = makeFixture();
    const released: string[] = [];
    const r = await run(repoPath, registry(holderPath), released);
    expect(r).not.toBeNull();
    expect(r!.branch).toBe(RESUME);
    expect(r!.sharedBranch).toBeUndefined();
    expect(headOf(holderPath)).toBe('HEAD'); // detached
    expect(fs.readFileSync(join(holderPath, 'work.txt'), 'utf-8')).toBe('prior attempt\n');
    expect(fs.readFileSync(join(r!.path, 'work.txt'), 'utf-8')).toBe('prior attempt\n');
    expect(released).toEqual(['w-prior-00']);
    expect(heldLog()).toEqual([expect.objectContaining({ mode: 'release', decision: 'released', released: true, holderWorkerId: 'w-prior-00' })]);
  }, 60_000);

  test('flag off (kill switch, shadow): diverts as today and logs would_release', async () => {
    process.env[FLAG] = '0';
    const { repoPath, holderPath } = makeFixture();
    const released: string[] = [];
    const r = await run(repoPath, registry(holderPath), released);
    expect(r!.branch).toBe(RETRY_BRANCH);
    expect(r!.sharedBranch?.reason).toBe('checked_out');
    expect(headOf(holderPath)).toBe(RESUME);
    expect(released).toEqual([]);
    expect(heldLog()).toEqual([expect.objectContaining({ mode: 'shadow', decision: 'would_release', released: false })]);
  }, 60_000);

  const refusals: Array<[string, (h: string) => Map<string, LineageHolderRecord>, string, ((h: string) => void)?]> = [
    ['waiting holder', h => registry(h, { status: 'waiting' }), 'holder_live'],
    ['live (working) holder', h => registry(h, { status: 'working' }), 'holder_live'],
    ['holder outside the lineage', h => registry(h, { taskId: 'task-Z' }), 'outside_lineage'],
    ['holder unknown to the registry', () => new Map(), 'no_registry_owner'],
    ['dirty holder', h => registry(h), 'holder_dirty', h => fs.writeFileSync(join(h, 'work.txt'), 'uncommitted\n')],
    ['holder with unpushed commits', h => registry(h), 'holder_unpushed', h => {
      fs.writeFileSync(join(h, 'more.txt'), 'x\n');
      sh('git add more.txt && git commit -m unpushed', h);
    }],
  ];
  for (const [name, workersFor, reason, prep] of refusals) {
    test(`flag on, ${name}: keeps today's diversion and logs released:false`, async () => {
      process.env[FLAG] = '1';
      const { repoPath, holderPath } = makeFixture();
      prep?.(holderPath);
      const released: string[] = [];
      const r = await run(repoPath, workersFor(holderPath), released);
      expect(r!.branch).toBe(RETRY_BRANCH);
      expect(r!.sharedBranch?.reason).toBe('checked_out');
      expect(headOf(holderPath)).toBe(RESUME);
      expect(released).toEqual([]);
      expect(heldLog()).toEqual([expect.objectContaining({ decision: 'refused', reason, released: false })]);
      if (reason === 'holder_dirty') {
        expect(fs.readFileSync(join(holderPath, 'work.txt'), 'utf-8')).toBe('uncommitted\n');
      }
    }, 60_000);
  }
});
