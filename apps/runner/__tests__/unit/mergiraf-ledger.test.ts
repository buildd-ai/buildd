import { describe, test, expect, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  registerMergeDrivers,
  mergeBaseWithDerivedFiles,
  planMergeDrivers,
  planPreMerge,
  readMergirafLedger,
  looksLikeMergeCommand,
  formatAgentMergeMilestones,
  formatAgentMergeContext,
  collectAgentMergeReport,
  MERGIRAF_LEDGER,
} from '../../src/merge-drivers';
import { HookFactory } from '../../src/hook-factory';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

let dir = '';
let bin = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (bin) rmSync(bin, { recursive: true, force: true });
  dir = '';
  bin = '';
});

/** Takes theirs and succeeds, except for paths containing "fail/" (exits 1, file untouched). Names the file from -p like the real one. */
function fakeMergiraf(): string {
  bin = mkdtempSync(join(tmpdir(), 'fake-mergiraf-'));
  const path = join(bin, 'mergiraf');
  writeFileSync(path, [
    '#!/bin/sh',
    'ours="$4"; theirs="$5"; name=""',
    'while [ $# -gt 0 ]; do [ "$1" = "-p" ] && name="$2"; shift; done',
    'case "$name" in *fail/*) exit 1;; esac',
    'cp "$theirs" "$ours"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(path, 0o755);
  return path;
}

function write(root: string, rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** feature and main edit the same line of a/x.ts, fail/x.ts and src/deep/x.ts; they edit different lines of clean.ts. */
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'merge-ledger-'));
  const files = ['a/x.ts', 'fail/x.ts', 'src/deep/x.ts'];
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 'T');
  git(d, 'config', 'commit.gpgsign', 'false');
  for (const f of files) write(d, f, 'export const v = 0;\n');
  write(d, 'clean.ts', 'one\ntwo\nthree\nfour\nfive\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'base');
  git(d, 'checkout', '-qb', 'feature');
  for (const f of files) write(d, f, 'export const v = 1;\n');
  write(d, 'clean.ts', 'ONE\ntwo\nthree\nfour\nfive\n');
  git(d, 'commit', '-qam', 'feature');
  git(d, 'checkout', '-q', 'main');
  for (const f of files) write(d, f, 'export const v = 2;\n');
  write(d, 'clean.ts', 'one\ntwo\nthree\nfour\nFIVE\n');
  git(d, 'commit', '-qam', 'main');
  git(d, 'checkout', '-q', 'feature');
  return d;
}

/** A merge the agent runs itself (not the runner's pre-merge). Conflicts leave a non-zero exit. */
function agentMerge(d: string) {
  try { git(d, 'merge', '--no-edit', 'main'); } catch { /* a conflict is expected in some tests */ }
}

describe('mergiraf ledger (real git, fake mergiraf)', () => {
  test('the driver is wrapped, and still passes every argument to mergiraf', () => {
    const plan = planMergeDrivers([], { mergiraf: true, mergirafPath: '/usr/local/bin/mergiraf' });
    const driver = plan.config.find(([k]) => k === 'merge.mergiraf.driver')?.[1] ?? '';
    expect(driver).toContain(MERGIRAF_LEDGER);
    expect(driver).toContain('/usr/local/bin/mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L');
  });

  test('a mergiraf path that is not shell-safe is never registered', () => {
    const plan = planMergeDrivers([], { mergiraf: true, mergirafPath: "/opt/my bin/mergiraf'" });
    expect(plan.config.some(([k]) => k.startsWith('merge.mergiraf'))).toBe(false);
    expect(plan.attributes.some(l => l.includes('mergiraf'))).toBe(false);
  });

  test('every merge appends exact repo-relative paths: resolved, conflict, and clean (a line merge would not have conflicted)', () => {
    dir = repo();
    registerMergeDrivers(dir, [], { mergiraf: true, mergirafPath: fakeMergiraf() });
    agentMerge(dir);
    const { entries } = readMergirafLedger(dir, 0);
    const byPath = Object.fromEntries(entries.map(e => [e.path, e.status]));
    expect(byPath).toEqual({
      'a/x.ts': 'resolved',
      'fail/x.ts': 'conflict',
      'src/deep/x.ts': 'resolved',
      'clean.ts': 'clean',
    });
    // mergiraf's exit code reached git: the failed file is still unmerged.
    expect(git(dir, 'diff', '--name-only', '--diff-filter=U')).toBe('fail/x.ts');
    expect(existsSync(join(git(dir, 'rev-parse', '--absolute-git-dir'), MERGIRAF_LEDGER))).toBe(true);
  });

  test('the pre-merge reports exactly the files mergiraf resolved; same basename in different dirs is not ambiguous', () => {
    dir = repo();
    registerMergeDrivers(dir, [], { mergiraf: true, mergirafPath: fakeMergiraf() });
    const result = mergeBaseWithDerivedFiles(dir, 'main', []);
    expect(result.status).toBe('conflicts');
    expect(result.conflicted).toEqual(['fail/x.ts']);
    expect(result.structurallyResolved).toEqual(['a/x.ts', 'src/deep/x.ts']);
  });

  test('the pre-merge counts only its own merge, not entries an earlier merge left in the ledger', () => {
    dir = repo();
    registerMergeDrivers(dir, [], { mergiraf: true, mergirafPath: fakeMergiraf() });
    agentMerge(dir);
    git(dir, 'merge', '--abort');
    // A fresh conflict-free merge: nothing new for mergiraf to resolve.
    git(dir, 'checkout', '-qb', 'side', 'main');
    const result = mergeBaseWithDerivedFiles(dir, 'main', []);
    expect(result.structurallyResolved).toEqual([]);
  });

  test('an agent merge yields milestones and a review instruction, once', () => {
    dir = repo();
    registerMergeDrivers(dir, [], { mergiraf: true, mergirafPath: fakeMergiraf() });
    agentMerge(dir);
    const first = collectAgentMergeReport(dir, 0);
    expect(first.milestones).toEqual([
      'Merge: mergiraf resolved 2 file(s): a/x.ts, src/deep/x.ts',
      'Merge: mergiraf left 1 file(s) conflicted: fail/x.ts',
    ]);
    expect(first.context).toContain('a/x.ts');
    expect(first.context).toContain('src/deep/x.ts');
    expect(first.context).toMatch(/review/i);
    expect(first.context).toMatch(/test/i);
    const again = collectAgentMergeReport(dir, first.offset);
    expect(again.milestones).toEqual([]);
    expect(again.context).toBeNull();
    expect(again.offset).toBe(first.offset);
  });

  test('no ledger yet: an empty report at offset 0', () => {
    dir = repo();
    expect(collectAgentMergeReport(dir, 0)).toEqual({ offset: 0, milestones: [], context: null });
  });
});

function realMergiraf(): string | null {
  try {
    return execFileSync('sh', ['-c', 'command -v mergiraf'], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

describe('mergiraf ledger (real git, real mergiraf)', () => {
  // Skipped where the binary is not installed.
  test.skipIf(!realMergiraf())('a conflict only mergiraf can merge is logged as resolved, with its path', () => {
    dir = mkdtempSync(join(tmpdir(), 'merge-ledger-real-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    write(dir, 'src/a.ts', "import { a } from 'a';\n\nexport const x = a;\n");
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'feature');
    write(dir, 'src/a.ts', "import { a } from 'a';\nimport { o } from 'o';\n\nexport const x = a;\n");
    git(dir, 'commit', '-qam', 'feature');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'src/a.ts', "import { a } from 'a';\nimport { t } from 't';\n\nexport const x = a;\n");
    git(dir, 'commit', '-qam', 'main');
    git(dir, 'checkout', '-q', 'feature');
    registerMergeDrivers(dir, [], { mergiraf: true, mergirafPath: realMergiraf() });
    agentMerge(dir);
    expect(readMergirafLedger(dir, 0).entries).toEqual([{ status: 'resolved', path: 'src/a.ts' }]);
    expect(git(dir, 'diff', '--name-only', '--diff-filter=U')).toBe('');
  });
});

describe('createMergeLedgerHook (PostToolUse after the agent merges)', () => {
  function factory(labels: string[]) {
    return new HookFactory({
      config: {},
      buildd: {} as any,
      addMilestone: (_w: unknown, m: { label: string }) => { labels.push(m.label); },
      emit: () => {},
      pendingPermissionRequests: new Map(),
    } as any);
  }
  const post = (command: string) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command } });

  test('a merge the agent ran: milestones recorded, review instruction returned as additionalContext, once', async () => {
    dir = repo();
    registerMergeDrivers(dir, [], { mergiraf: true, mergirafPath: fakeMergiraf() });
    const worker: any = { id: 'w1', worktreePath: dir, mergirafLedgerOffset: 0 };
    const labels: string[] = [];
    const hook = factory(labels).createMergeLedgerHook(worker);
    agentMerge(dir);
    const out: any = await hook(post('git merge origin/main') as any, undefined, { signal: new AbortController().signal } as any);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('a/x.ts');
    expect(labels).toEqual([
      'Merge: mergiraf resolved 2 file(s): a/x.ts, src/deep/x.ts',
      'Merge: mergiraf left 1 file(s) conflicted: fail/x.ts',
    ]);
    const again: any = await hook(post('git merge origin/main') as any, undefined, { signal: new AbortController().signal } as any);
    expect(again).toEqual({});
    expect(labels.length).toBe(2);
  });

  test('a non-merge command, or a worker without drivers, returns nothing', async () => {
    dir = repo();
    registerMergeDrivers(dir, [], { mergiraf: true, mergirafPath: fakeMergiraf() });
    agentMerge(dir);
    const labels: string[] = [];
    const withDrivers: any = { id: 'w1', worktreePath: dir, mergirafLedgerOffset: 0 };
    expect(await factory(labels).createMergeLedgerHook(withDrivers)(post('git status') as any, undefined, {} as any)).toEqual({});
    const noDrivers: any = { id: 'w2', worktreePath: dir };
    expect(await factory(labels).createMergeLedgerHook(noDrivers)(post('git merge main') as any, undefined, {} as any)).toEqual({});
    expect(labels).toEqual([]);
  });
});

describe('agent-merge formatting and detection', () => {
  test('milestones cap the file list at 10 and say how many more', () => {
    const paths = Array.from({ length: 13 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`);
    const [m] = formatAgentMergeMilestones(paths.map(path => ({ status: 'resolved' as const, path })));
    expect(m).toBe(`Merge: mergiraf resolved 13 file(s): ${paths.slice(0, 10).join(', ')} +3 more`);
  });

  test('clean entries are not mergiraf work and produce nothing', () => {
    expect(formatAgentMergeMilestones([{ status: 'clean', path: 'a.ts' }])).toEqual([]);
    expect(formatAgentMergeContext([])).toBeNull();
  });

  test('merge-shaped git commands are recognised; others are not', () => {
    for (const c of ['git merge origin/dev', 'git pull --no-rebase origin dev', 'cd x && git rebase origin/dev',
      'git cherry-pick abc123', 'git am < p.patch', 'git stash pop', 'git -C repo merge main', 'git revert HEAD']) {
      expect(looksLikeMergeCommand(c)).toBe(true);
    }
    for (const c of ['git status', 'git log --merges', 'echo merge', 'git diff --name-only', 'bun run test', 'git merge-base a b']) {
      expect(looksLikeMergeCommand(c)).toBe(false);
    }
  });
});

describe('planPreMerge prefers the server-stated PR base (context.prBase)', () => {
  const conflict = { errorType: 'merge_conflict' };

  test('used for an ordinary retry and for a ship-PR retry', () => {
    expect(planPreMerge({ resumeBranch: 'buildd/a', prBase: 'release', failureContext: conflict }, 'origin/dev', 'dev'))
      .toEqual({ ref: 'origin/release', kind: 'retry', mayFinishWithoutAgent: true });
    expect(planPreMerge({ resumeBranch: 'mission/x', prBase: 'dev', failureContext: conflict }, 'origin/mission/x', 'main'))
      .toEqual({ ref: 'origin/dev', kind: 'retry', mayFinishWithoutAgent: true });
  });

  test('an invalid prBase is ignored and the old rule applies', () => {
    expect(planPreMerge({ resumeBranch: 'buildd/a', prBase: '--upload-pack=x', failureContext: conflict }, 'origin/dev', 'dev'))
      .toEqual({ ref: 'origin/dev', kind: 'retry', mayFinishWithoutAgent: true });
    expect(planPreMerge({ resumeBranch: 'mission/x', prBase: 42, failureContext: conflict }, 'origin/mission/x', 'dev'))
      .toEqual({ ref: 'origin/dev', kind: 'mission_pr_retry', mayFinishWithoutAgent: true });
  });

  test('a mission refresh still merges refreshTrunk', () => {
    expect(planPreMerge({ refreshTrunk: 'dev', prBase: 'mission/x', failureContext: conflict }, 'origin/mission/x', 'dev'))
      .toEqual({ ref: 'origin/dev', kind: 'mission_refresh', mayFinishWithoutAgent: false });
  });
});
