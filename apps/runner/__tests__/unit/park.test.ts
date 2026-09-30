/**
 * Park bundles (park.ts): what a --once runner uploads when its worker parks
 * on a question, and how a new container puts it back. Real git, real tar.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  MAX_PARKS,
  ParkRestoreError,
  applyParkRepo,
  buildParkBundle,
  findTranscriptFiles,
  parkingEnabled,
  parkWorkerNow,
  readParkBundle,
  readParkCount,
  restoreParkFiles,
  parkCountPath,
  type ParkPaths,
} from '../../src/park';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
/** `git status --porcelain` lines, untrimmed (the first column is significant). */
const status = (cwd: string) =>
  execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf-8' }).split('\n').filter(Boolean).sort();
const commit = (cwd: string, msg: string) => git(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', msg);

const WORKER = 'worker-1234';
const TASK = 'task-5678';
const SESSION = 'sess-abcdef';

let dir: string;
let origin: string;
let clonePath: string;
let worktree: string;
let paths: ParkPaths;

/** A base clone + task worktree the way setupWorktree leaves them. */
function setUpRun(root: string): { clonePath: string; worktree: string; paths: ParkPaths } {
  const cp = join(root, 'buildd-home', 'once-workspaces', 'ws-1');
  execFileSync('git', ['clone', '-q', origin, cp], { stdio: 'pipe' });
  const wt = join(cp, '.buildd-worktrees', 'buildd_task');
  git(cp, 'worktree', 'add', '-q', '-b', 'buildd/task', wt, 'origin/main');
  const p: ParkPaths = {
    builddHome: join(root, 'buildd-home'),
    claudeConfigDirs: [join(root, 'home', '.claude')],
    tmpDir: join(root, 'tmp'),
  };
  return { clonePath: cp, worktree: wt, paths: p };
}

function writeRunnerState(p: ParkPaths, wt: string) {
  mkdirSync(join(p.builddHome, 'workers'), { recursive: true });
  writeFileSync(join(p.builddHome, 'workers', `${WORKER}.json`), JSON.stringify({ id: WORKER, taskId: TASK, status: 'waiting', worktreePath: wt, sessionId: SESSION }));
  writeFileSync(join(p.builddHome, `outbox-once-${TASK}.json`), '[]');
  // Unrelated state that must NOT travel.
  writeFileSync(join(p.builddHome, 'config.json'), '{"apiKey":"bld_should_not_travel"}');
  writeFileSync(join(p.builddHome, 'workers', 'other-worker.json'), '{}');
  const projects = join(p.claudeConfigDirs[0]!, 'projects', wt.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(join(projects, SESSION, 'subagents'), { recursive: true });
  writeFileSync(join(projects, `${SESSION}.jsonl`), '{"type":"user","message":"hi"}\n');
  writeFileSync(join(projects, SESSION, 'subagents', 'agent-1.jsonl'), '{"sub":1}\n');
  writeFileSync(join(projects, 'some-other-session.jsonl'), 'other\n');
  writeFileSync(join(p.claudeConfigDirs[0]!, '.credentials.json'), '{"token":"sk-ant-should-not-travel"}');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'park-'));
  origin = join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(dir, 'seed');
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'pipe' });
  git(seed, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  git(seed, 'add', '.');
  commit(seed, 'initial');
  git(seed, 'push', '-q', 'origin', 'main');
  ({ clonePath, worktree, paths } = setUpRun(join(dir, 'run1')));
  writeRunnerState(paths, worktree);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function park(kind: 'waiting' | 'orphan' = 'waiting', parks = 0) {
  return buildParkBundle({
    worker: { id: WORKER, taskId: TASK, workspaceId: 'ws-1', worktreePath: worktree, sessionId: SESSION },
    paths, kind, parks, now: 1_700_000_000_000,
  });
}

/** A second "container": same absolute paths, fresh disk. */
function freshContainer() {
  rmSync(join(dir, 'run1'), { recursive: true, force: true });
  const again = setUpRun(join(dir, 'run1'));
  // setUpRun made a worktree; a resumed container has only the base clone.
  git(again.clonePath, 'worktree', 'remove', '--force', again.worktree);
  git(again.clonePath, 'branch', '-D', 'buildd/task');
  return again;
}

describe('parkingEnabled', () => {
  test('BUILDD_ONCE_PARK=1 and a snapshot URL', () => {
    expect(parkingEnabled({ BUILDD_ONCE_PARK: '1', BUILDD_SNAPSHOT_URL: 'https://buildd-snapshots.invalid' })).toBe(true);
    expect(parkingEnabled({ BUILDD_ONCE_PARK: '1' })).toBe(false);
    expect(parkingEnabled({})).toBe(false);
    expect(MAX_PARKS).toBe(3);
  });
});

describe('findTranscriptFiles', () => {
  test("the session's jsonl and its subagent directory, nothing else", () => {
    const files = findTranscriptFiles(paths.claudeConfigDirs, SESSION).map(f => f.split('/').slice(-2).join('/'));
    expect(files.sort()).toEqual(['subagents/agent-1.jsonl', `${worktree.replace(/[^A-Za-z0-9]/g, '-')}/${SESSION}.jsonl`].sort());
  });
});

describe('park → restore round trip', () => {
  test('uncommitted changes, untracked files, commits and the transcript all come back at the same paths', () => {
    writeFileSync(join(worktree, 'feature.ts'), 'export const x = 1;\n');
    git(worktree, 'add', 'feature.ts');
    commit(worktree, 'committed work');
    writeFileSync(join(worktree, 'README.md'), 'hello\nuncommitted edit\n');
    writeFileSync(join(worktree, 'new-untracked.txt'), 'untracked\n');
    writeFileSync(join(worktree, 'feature.ts'), 'export const x = 2;\n');
    const headBefore = git(worktree, 'rev-parse', 'HEAD');

    const built = park();
    expect(built.manifest).toMatchObject({ kind: 'waiting', workerId: WORKER, taskId: TASK, branch: 'buildd/task', parks: 1, worktreePath: worktree, clonePath, sessionId: SESSION });
    expect(built.manifest.wipSha).toBeTruthy();
    // Parking never touches the working tree.
    expect(status(worktree)).toEqual([' M README.md', ' M feature.ts', '?? new-untracked.txt']);

    const tar = readFileSync(built.tarPath);
    expect(tar.includes(Buffer.from('bld_should_not_travel'))).toBe(false);
    expect(tar.includes(Buffer.from('sk-ant-should-not-travel'))).toBe(false);
    expect(tar.includes(Buffer.from('other\n'))).toBe(false);
    const saved = join(dir, 'park.tar');
    writeFileSync(saved, tar);

    const again = freshContainer();
    rmSync(paths.builddHome + '/workers', { recursive: true, force: true });
    rmSync(paths.claudeConfigDirs[0]!, { recursive: true, force: true });

    const opened = readParkBundle(saved, join(dir, 'stage'));
    restoreParkFiles(opened, paths);
    applyParkRepo(opened, again.clonePath);

    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('buildd/task');
    expect(readFileSync(join(worktree, 'README.md'), 'utf-8')).toBe('hello\nuncommitted edit\n');
    expect(readFileSync(join(worktree, 'feature.ts'), 'utf-8')).toBe('export const x = 2;\n');
    expect(readFileSync(join(worktree, 'new-untracked.txt'), 'utf-8')).toBe('untracked\n');
    // Unstaged, as they were: the resumed agent sees the same `git status`.
    expect(status(worktree)).toEqual([' M README.md', ' M feature.ts', '?? new-untracked.txt']);

    const record = JSON.parse(readFileSync(join(paths.builddHome, 'workers', `${WORKER}.json`), 'utf-8'));
    expect(record).toMatchObject({ id: WORKER, sessionId: SESSION, worktreePath: worktree });
    expect(existsSync(join(paths.builddHome, `outbox-once-${TASK}.json`))).toBe(true);
    const transcript = findTranscriptFiles(paths.claudeConfigDirs, SESSION);
    expect(transcript).toHaveLength(2);
    // Nothing else from the first container's BUILDD_HOME or Claude config came along.
    expect(existsSync(join(paths.builddHome, 'config.json'))).toBe(false);
    expect(existsSync(join(paths.builddHome, 'workers', 'other-worker.json'))).toBe(false);
    expect(existsSync(join(paths.claudeConfigDirs[0]!, '.credentials.json'))).toBe(false);
  });

  test('a clean worktree with no new commits parks without a git bundle and restores the branch', () => {
    const built = park();
    expect(built.manifest.hasBundle).toBe(false);
    expect(built.manifest.wipSha).toBeNull();
    const saved = join(dir, 'park.tar');
    writeFileSync(saved, readFileSync(built.tarPath));
    const again = freshContainer();
    const opened = readParkBundle(saved, join(dir, 'stage'));
    applyParkRepo(opened, again.clonePath);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('buildd/task');
    expect(status(worktree)).toEqual([]);
  });

  test('parks count carries forward; the orphan kind is recorded', () => {
    expect(park('orphan', 2).manifest).toMatchObject({ kind: 'orphan', parks: 3 });
    expect(readParkCount(paths.builddHome, WORKER)).toBe(3);
  });

  test('the park count travels with the bundle', () => {
    const built = park('waiting', 1);
    const saved = join(dir, 'park.tar');
    writeFileSync(saved, readFileSync(built.tarPath));
    const again = freshContainer();
    expect(readParkCount(paths.builddHome, WORKER)).toBe(0);
    const opened = readParkBundle(saved, join(dir, 'stage'));
    restoreParkFiles(opened, paths);
    applyParkRepo(opened, again.clonePath);
    expect(readParkCount(paths.builddHome, WORKER)).toBe(2);
  });
});

describe('restore refuses what it should', () => {
  test('a clone at a different path (the transcript is keyed by cwd)', () => {
    const built = park();
    const opened = readParkBundle(built.tarPath, join(dir, 'stage'));
    expect(() => applyParkRepo(opened, join(dir, 'elsewhere'))).toThrow(ParkRestoreError);
  });

  test('a corrupt tarball', () => {
    const bad = join(dir, 'bad.tar');
    writeFileSync(bad, 'not a tar');
    expect(() => readParkBundle(bad, join(dir, 'stage'))).toThrow(ParkRestoreError);
  });

  test('a manifest listing a file outside the allowed paths is not written anywhere', () => {
    const built = park();
    const opened = readParkBundle(built.tarPath, join(dir, 'stage'));
    const evil = join(dir, 'evil-target');
    opened.manifest.files.push(evil);
    mkdirSync(join(opened.stageDir, 'files', dirname(evil).slice(1)), { recursive: true });
    writeFileSync(join(opened.stageDir, 'files', evil.slice(1)), 'pwned');
    expect(() => restoreParkFiles(opened, paths)).toThrow(ParkRestoreError);
    expect(existsSync(evil)).toBe(false);
  });

  test('a tar member with .. is refused before anything is extracted', () => {
    const stage = join(dir, 'mk');
    mkdirSync(join(stage, 'a'), { recursive: true });
    writeFileSync(join(stage, 'x.txt'), 'x');
    const tarPath = join(dir, 'dotdot.tar');
    execFileSync('tar', ['-cf', tarPath, '-C', join(stage, 'a'), '../x.txt']);
    expect(() => readParkBundle(tarPath, join(dir, 'stage2'))).toThrow(ParkRestoreError);
  });
});

describe('parkWorkerNow', () => {
  const worker = () => ({ id: WORKER, taskId: TASK, workspaceId: 'ws-1', worktreePath: worktree, sessionId: SESSION });
  function deps() {
    const calls = { uploads: [] as string[], marks: [] as string[], phases: [] as string[], metrics: [] as string[] };
    return {
      calls,
      d: {
        paths,
        uploader: { upload: (path: string, file: string) => { calls.uploads.push(`${path} ${existsSync(file)}`); return { status: 201, body: {} }; } },
        client: { parkWorker: async (id: string) => { calls.marks.push(id); return { parkedUntil: '2030-01-01T00:00:00.000Z' }; } },
        emitPhase: (p: string) => { calls.phases.push(p); },
        emitMetric: (m: string) => { calls.metrics.push(m); },
        log: () => {},
      },
    };
  }

  test('uploads the bundle to /park, marks the worker, and counts the park', async () => {
    writeRunnerState(paths, worktree);
    const { d, calls } = deps();
    expect(await parkWorkerNow(worker(), 'waiting', d)).toBe(true);
    expect(calls.uploads).toEqual(['/park true']);
    expect(calls.marks).toEqual([WORKER]);
    expect(calls.phases).toEqual(['park_start', 'park_end']);
    expect(calls.metrics).toEqual(['park_bytes']);
    expect(readParkCount(paths.builddHome, WORKER)).toBe(1);
  });

  test(`refuses a worker that has parked ${MAX_PARKS} times already, before building anything`, async () => {
    writeRunnerState(paths, worktree);
    mkdirSync(dirname(parkCountPath(paths.builddHome, WORKER)), { recursive: true });
    writeFileSync(parkCountPath(paths.builddHome, WORKER), JSON.stringify({ parks: MAX_PARKS }));
    const { d, calls } = deps();
    expect(await parkWorkerNow(worker(), 'waiting', d)).toBe(false);
    expect(calls.uploads).toEqual([]);
    expect(calls.marks).toEqual([]);
  });

  test(`parks at ${MAX_PARKS - 1} earlier parks (the bound is inclusive of the ${MAX_PARKS}rd)`, async () => {
    writeRunnerState(paths, worktree);
    mkdirSync(dirname(parkCountPath(paths.builddHome, WORKER)), { recursive: true });
    writeFileSync(parkCountPath(paths.builddHome, WORKER), JSON.stringify({ parks: MAX_PARKS - 1 }));
    const { d } = deps();
    expect(await parkWorkerNow(worker(), 'waiting', d)).toBe(true);
    expect(readParkCount(paths.builddHome, WORKER)).toBe(MAX_PARKS);
  });

  test('a failed upload does not mark the worker parked', async () => {
    writeRunnerState(paths, worktree);
    const { d, calls } = deps();
    d.uploader = { upload: () => ({ status: 503, body: null }) };
    expect(await parkWorkerNow(worker(), 'waiting', d)).toBe(false);
    expect(calls.marks).toEqual([]);
  });

  test('an orphan park uploads but leaves the mark to the agent (the container may have lost its route to buildd)', async () => {
    writeRunnerState(paths, worktree);
    const { d, calls } = deps();
    expect(await parkWorkerNow(worker(), 'orphan', d)).toBe(true);
    expect(calls.uploads).toEqual(['/park true']);
    expect(calls.marks).toEqual([]);
    expect(readParkCount(paths.builddHome, WORKER)).toBe(1);
  });

  test('no worktree, no park', async () => {
    const { d, calls } = deps();
    expect(await parkWorkerNow({ ...worker(), worktreePath: undefined }, 'waiting', d)).toBe(false);
    expect(calls.uploads).toEqual([]);
  });
});
