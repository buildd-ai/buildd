import { describe, test, expect, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  candidateVersionOf,
  isShippable,
  latestSemverTag,
  parseCandidateMeta,
  planVersion,
  prNumbersIn,
  promoteChangelog,
  reconcileChangelog,
  renderCandidateBody,
  replaceExcluded,
  type CandidateMeta,
} from './release-candidate';

// Real git subprocesses per test; the unmodified 5000ms bun default flakes
// under full-suite concurrent load even though each test is fast in isolation.
setDefaultTimeout(30_000);

/**
 * The release PR used to be dev → main: its head moved with every merge, so
 * what CI verified and what a reviewer approved was never what merged. These
 * run the real candidate engine against a scratch repo with a bare origin and a
 * stateful `gh` stub, and assert on what ended up on origin and on "GitHub".
 */

const SCRIPT = join(import.meta.dir, 'release-candidate.ts');
const PACKAGE_FILES = ['apps/runner/package.json', 'apps/web/package.json', 'packages/core/package.json', 'packages/shared/package.json'];

function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}, input?: string) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', input, env: { ...process.env, ...env } });
}
const git = (cwd: string, ...args: string[]) => {
  const r = sh(cwd, 'git', args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// A stateful stand-in for the gh CLI: PRs live in a JSON file, head SHAs are
// read live from the bare origin, and every call is logged.
const GH_STUB = `#!/usr/bin/env bun
const fs = require('fs');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const STATE = process.env.GH_STUB_STATE;
fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(args) + '\\n');
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const oid = (h) => spawnSync('git', ['-C', process.env.GH_STUB_ORIGIN, 'rev-parse', '--verify', '-q', 'refs/heads/' + h], { encoding: 'utf8' }).stdout.trim();
const visible = () => st.prs.filter((p) => !p.hidden);
const view = (p) => ({ number: p.number, title: p.title, headRefName: p.head, headRefOid: oid(p.head), body: p.body, url: 'https://github.com/o/r/pull/' + p.number, isCrossRepository: false, state: p.state });
const [a, b] = args;
if (a === 'repo' && b === 'view') { console.log('o/r'); process.exit(0); }
if (a === 'pr' && b === 'list') {
  if (process.env.GH_LIST_FAIL) { console.error('gh: api down'); process.exit(1); }
  let prs = visible();
  if ((flag('--state') || 'open') !== 'all') prs = prs.filter((p) => p.state === 'OPEN');
  if (flag('--base')) prs = prs.filter((p) => p.base === flag('--base'));
  if (flag('--head')) prs = prs.filter((p) => p.head === flag('--head'));
  console.log(JSON.stringify(prs.map(view)));
  process.exit(0);
}
if (a === 'pr' && b === 'create') {
  if (process.env.GH_PR_CREATE_FAIL) { console.error('gh: network down'); process.exit(1); }
  const number = st.next++;
  st.prs.push({ number, title: flag('--title'), head: flag('--head'), base: flag('--base'), body: fs.readFileSync(flag('--body-file'), 'utf8'), state: 'OPEN' });
  for (const p of st.prs) if (p.hiddenUntilCreate) p.hidden = false;
  save();
  console.log('https://github.com/o/r/pull/' + number);
  process.exit(0);
}
const find = (n) => st.prs.find((p) => p.number === Number(n));
if (a === 'pr' && b === 'close') { const p = find(args[2]); p.state = 'CLOSED'; p.closeComment = flag('--comment'); save(); process.exit(0); }
if (a === 'pr' && b === 'comment') { const p = find(args[2]); (p.comments ||= []).push(flag('--body')); save(); process.exit(0); }
if (a === 'api') {
  const method = flag('--method') || 'GET';
  const path = args.find((x, i) => i > 0 && x.startsWith('repos/'));
  let m;
  if (method === 'PATCH' && (m = /pulls\\/(\\d+)$/.exec(path))) {
    const p = find(m[1]); p.body = JSON.parse(fs.readFileSync(0, 'utf8')).body; save(); process.exit(0);
  }
  if (method === 'GET' && (m = /pulls\\/(\\d+)\\/reviews/.exec(path))) { console.log(JSON.stringify(find(m[1]).reviews || [])); process.exit(0); }
  if (method === 'PUT' && (m = /pulls\\/(\\d+)\\/reviews\\/(\\d+)\\/dismissals/.exec(path))) {
    const r = find(m[1]).reviews.find((x) => x.id === Number(m[2])); r.state = 'DISMISSED'; save(); process.exit(0);
  }
}
console.error('gh stub: unhandled ' + args.join(' '));
process.exit(1);
`;

interface StubPr {
  number: number;
  title: string;
  head: string;
  base: string;
  body: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  hidden?: boolean;
  hiddenUntilCreate?: boolean;
  reviews?: Array<{ id: number; state: string }>;
  comments?: string[];
  closeComment?: string;
}

interface Fixture {
  root: string;
  work: string;
  origin: string;
  env: Record<string, string>;
  state: string;
  log: string;
}

const CHANGELOG = (v: string) =>
  `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- a fix\n\n## [${v}] - 2000-01-01\n\n- old\n\n[Unreleased]: https://github.com/o/r/compare/v${v}...HEAD\n[${v}]: https://github.com/o/r/compare/v0.0.1...v${v}\n`;

/** main = dev = v1.2.3 (tagged, unless `tag: false`), then one fix commit on dev. */
function fixture(opts: { version?: string; tag?: boolean } = {}): Fixture {
  const version = opts.version ?? '1.2.3';
  const root = mkdtempSync(join(tmpdir(), 'release-candidate-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  sh(root, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  sh(root, 'git', ['init', '-q', '-b', 'main', work]);
  for (const [k, v] of [['user.email', 't@t.test'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) {
    git(work, 'config', k, v);
  }
  for (const p of PACKAGE_FILES) {
    mkdirSync(join(work, p, '..'), { recursive: true });
    writeFileSync(join(work, p), JSON.stringify({ name: p, version }, null, 2) + '\n');
  }
  writeFileSync(join(work, 'CHANGELOG.md'), CHANGELOG(version));
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'initial');
  if (opts.tag !== false) git(work, 'tag', `v${version}`);
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main', '--tags');
  git(work, 'checkout', '-qb', 'dev');
  git(work, 'push', '-q', 'origin', 'dev');

  const state = join(root, 'gh-state.json');
  const log = join(root, 'gh.log');
  writeFileSync(state, JSON.stringify({ next: 100, prs: [] }));
  writeFileSync(log, '');
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'gh'), 0o755);
  const f: Fixture = {
    root,
    work,
    origin,
    state,
    log,
    env: { PATH: `${bin}:${process.env.PATH}`, GH_STUB_STATE: state, GH_STUB_LOG: log, GH_STUB_ORIGIN: origin, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
  };
  devCommit(f, 'fix: a thing (#10)');
  return f;
}

let counter = 0;
function devCommit(f: Fixture, subject: string): string {
  git(f.work, 'checkout', '-q', 'dev');
  writeFileSync(join(f.work, `change-${++counter}.txt`), subject);
  git(f.work, 'add', '-A');
  git(f.work, 'commit', '-qm', subject);
  git(f.work, 'push', '-q', 'origin', 'dev');
  return git(f.work, 'rev-parse', 'HEAD');
}

const originSha = (f: Fixture, ref: string) => {
  const r = sh(f.origin, 'git', ['rev-parse', '--verify', '-q', ref]);
  return r.status === 0 ? r.stdout.trim() : null;
};
const devHead = (f: Fixture) => originSha(f, 'refs/heads/dev')!;
const prs = (f: Fixture): StubPr[] => JSON.parse(readFileSync(f.state, 'utf8')).prs;
const setPrs = (f: Fixture, list: StubPr[], next = 100) => writeFileSync(f.state, JSON.stringify({ next, prs: list }));
const ghCalls = (f: Fixture): string[][] => readFileSync(f.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const showAt = (f: Fixture, rev: string, path: string) => git(f.origin, 'show', `${rev}:${path}`);

function run(f: Fixture, cmd: string, args: string[], env: Record<string, string> = {}) {
  const out = join(f.root, `out-${++counter}`);
  writeFileSync(out, '');
  const r = sh(f.work, 'bun', [SCRIPT, cmd, '--repo', 'o/r', '--today', '2026-01-02', ...args], { ...f.env, GITHUB_OUTPUT: out, ...env });
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { status: r.status, log: r.stdout + r.stderr, outputs };
}
const cut = (f: Fixture, source: string, extra: string[] = [], env: Record<string, string> = {}) => run(f, 'cut', ['--source', source, ...extra], env);

describe('cut: the first candidate', () => {
  test('is dev@SHA plus exactly one release-only commit, on its own branch, and dev is untouched', () => {
    const f = fixture();
    const source = devCommit(f, 'feat: something new (#11)');
    const r = cut(f, source);
    expect(r.status, r.log).toBe(0);
    expect(r.outputs.status).toBe('created');
    expect(r.outputs.version).toBe('1.3.0');

    const head = originSha(f, 'refs/heads/release/v1.3.0')!;
    expect(r.outputs.candidate_sha).toBe(head);
    expect(git(f.origin, 'rev-parse', `${head}^`)).toBe(source);
    expect(git(f.origin, 'rev-list', '--count', `${source}..${head}`)).toBe('1');
    expect(git(f.origin, 'log', '-1', '--format=%s', head)).toBe('chore: bump version to v1.3.0');
    expect(git(f.origin, 'log', '-1', '--format=%b', head)).toContain(`Release-Source: dev@${source}`);
    const files = git(f.origin, 'diff-tree', '--no-commit-id', '--name-only', '-r', head).split('\n').sort();
    expect(files).toEqual(['CHANGELOG.md', ...PACKAGE_FILES].sort());
    for (const p of PACKAGE_FILES) expect(JSON.parse(showAt(f, head, p)).version).toBe('1.3.0');
    expect(showAt(f, head, 'CHANGELOG.md')).toContain('## [Unreleased]\n\n## [1.3.0] - 2026-01-02\n');

    // dev did not get a bump commit, a changelog commit, or anything else.
    expect(devHead(f)).toBe(source);
    expect(JSON.parse(showAt(f, 'refs/heads/dev', 'apps/web/package.json')).version).toBe('1.2.3');
  });

  test('opens one release/vX.Y.Z → main PR whose body pins both SHAs and lists what is in it', () => {
    const f = fixture();
    const source = devCommit(f, 'feat: something new (#11)');
    const r = cut(f, source);
    expect(r.status, r.log).toBe(0);
    const [pr] = prs(f);
    expect(pr).toMatchObject({ number: 100, title: 'Release v1.3.0', head: 'release/v1.3.0', base: 'main', state: 'OPEN' });
    const meta = parseCandidateMeta(pr.body)!;
    expect(meta).toMatchObject({ version: '1.3.0', branch: 'release/v1.3.0', sourceRef: 'dev', sourceSha: source, previousTag: 'v1.2.3', bump: 'minor', amendment: 0 });
    expect(meta.candidateSha).toBe(originSha(f, 'refs/heads/release/v1.3.0')!);
    expect(meta.baseSha).toBe(originSha(f, 'refs/heads/main')!);
    expect(pr.body).toContain(`| Captured \`dev\` SHA | \`${source}\` |`);
    expect(pr.body).toContain('- #10\n- #11');
    expect(pr.body).toContain('`release candidate verified`');
    expect(pr.body).toContain('`build`');
  });
});

describe('cut: re-runs never move an existing candidate', () => {
  test('the same captured SHA again is a no-op', () => {
    const f = fixture();
    const source = devCommit(f, 'feat: x (#11)');
    expect(cut(f, source).status).toBe(0);
    const head = originSha(f, 'refs/heads/release/v1.3.0');
    const r = cut(f, source);
    expect(r.status, r.log).toBe(0);
    expect(r.outputs.status).toBe('existing');
    expect(originSha(f, 'refs/heads/release/v1.3.0')).toBe(head);
    expect(prs(f)).toHaveLength(1);
    expect(ghCalls(f).filter((c) => c[1] === 'create')).toHaveLength(1);
  });

  test('dev moving on (even with a feat) changes neither the candidate nor its version; it is listed as excluded', () => {
    const f = fixture();
    const source = devCommit(f, 'fix: y (#11)');
    expect(cut(f, source).outputs.version).toBe('1.2.4');
    const head = originSha(f, 'refs/heads/release/v1.2.4');
    const later = devCommit(f, 'feat: landed after the cut (#12)');

    const r = cut(f, later);
    expect(r.status, r.log).toBe(0);
    expect(r.outputs).toMatchObject({ status: 'existing', version: '1.2.4', source_sha: source });
    expect(originSha(f, 'refs/heads/release/v1.2.4')).toBe(head);
    expect(originSha(f, 'refs/heads/release/v1.3.0')).toBeNull();
    const [pr] = prs(f);
    expect(pr.title).toBe('Release v1.2.4');
    expect(parseCandidateMeta(pr.body)!.sourceSha).toBe(source);
    expect(pr.body).toContain('feat: landed after the cut (#12)');
    // The included list did not absorb it.
    expect(pr.body.split('### Not in this candidate')[0]).not.toContain('landed after the cut');
  });

  test('a run whose PR create died is resumed: the pushed candidate is published unchanged', () => {
    const f = fixture();
    const source = devCommit(f, 'feat: x (#11)');
    const first = cut(f, source, [], { GH_PR_CREATE_FAIL: '1' });
    expect(first.status).not.toBe(0);
    const head = originSha(f, 'refs/heads/release/v1.3.0')!;
    expect(head).not.toBeNull();
    expect(prs(f)).toHaveLength(0);

    // dev moved in between; the resume must not fold that in.
    devCommit(f, 'fix: after the interrupted run (#12)');
    const second = cut(f, devHead(f));
    expect(second.status, second.log).toBe(0);
    expect(second.outputs).toMatchObject({ status: 'created', candidate_sha: head, source_sha: source });
    expect(originSha(f, 'refs/heads/release/v1.3.0')).toBe(head);
    expect(parseCandidateMeta(prs(f)[0].body)!.sourceSha).toBe(source);
  });

  test('an abandoned candidate branch (closed PR) is refused, not deleted or reused', () => {
    const f = fixture();
    const source = devCommit(f, 'feat: x (#11)');
    expect(cut(f, source).status).toBe(0);
    const head = originSha(f, 'refs/heads/release/v1.3.0');
    setPrs(f, prs(f).map((p) => ({ ...p, state: 'CLOSED' as const })), 101);
    const r = cut(f, devCommit(f, 'fix: z (#12)'));
    expect(r.status).not.toBe(0);
    expect(r.log).toContain('abandoned or shipped candidate');
    expect(originSha(f, 'refs/heads/release/v1.3.0')).toBe(head);
  });

  test('a release/v* branch that is not a candidate commit is never reused', () => {
    const f = fixture();
    const source = devCommit(f, 'feat: x (#11)');
    git(f.work, 'push', '-q', 'origin', `${source}:refs/heads/release/v1.3.0`);
    const r = cut(f, source);
    expect(r.status).not.toBe(0);
    expect(r.log).toContain('not a candidate commit');
    expect(prs(f)).toHaveLength(0);
  });
});

describe('cut: exactly one candidate, collision-safe', () => {
  test('a parallel cut that opened its PR first wins; this run closes its own duplicate', () => {
    const f = fixture();
    const source = devCommit(f, 'feat: x (#11)');
    // Another run's candidate (different version, so a different branch) shows
    // up only after this run's create — the window the pre-check cannot see.
    setPrs(f, [{ number: 99, title: 'Release v1.2.4', head: 'release/v1.2.4', base: 'main', body: '', state: 'OPEN', hidden: true, hiddenUntilCreate: true }]);
    const r = cut(f, source);
    expect(r.status).not.toBe(0);
    expect(r.outputs.status).toBe('lost-race');
    const mine = prs(f).find((p) => p.number === 100)!;
    expect(mine.state).toBe('CLOSED');
    expect(mine.closeComment).toContain('#99');
    expect(prs(f).find((p) => p.number === 99)!.state).toBe('OPEN');
  });

  test('more than one open candidate is refused outright', () => {
    const f = fixture();
    setPrs(f, [
      { number: 1, title: 'Release v1.2.4', head: 'release/v1.2.4', base: 'main', body: '', state: 'OPEN' },
      { number: 2, title: 'Release v1.3.0', head: 'release/v1.3.0', base: 'main', body: '', state: 'OPEN' },
    ]);
    const r = cut(f, devHead(f));
    expect(r.status).not.toBe(0);
    expect(r.log).toContain('more than one open release candidate');
  });

  test('an open Hotfix PR claiming the version is a refusal, and nothing is pushed', () => {
    const f = fixture();
    setPrs(f, [{ number: 7, title: 'Hotfix v1.2.4', head: 'hotfix/x', base: 'main', body: '', state: 'OPEN' }]);
    const r = cut(f, devHead(f));
    expect(r.status).not.toBe(0);
    expect(r.log).toContain('already claims v1.2.4');
    expect(originSha(f, 'refs/heads/release/v1.2.4')).toBeNull();
  });

  test('cannot list PRs → fails closed', () => {
    const f = fixture();
    const r = cut(f, devHead(f), [], { GH_LIST_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(originSha(f, 'refs/heads/release/v1.2.4')).toBeNull();
  });
});

describe('cut: what it refuses to cut from', () => {
  test('a legacy dev → main release PR is left alone and blocks the first cut', () => {
    const f = fixture();
    setPrs(f, [{ number: 5, title: 'Release v1.2.4', head: 'dev', base: 'main', body: 'old', state: 'OPEN' }]);
    const r = cut(f, devHead(f));
    expect(r.status, r.log).toBe(0);
    expect(r.outputs.status).toBe('legacy-open');
    expect(r.log).toContain('#5');
    expect(prs(f)).toEqual([{ number: 5, title: 'Release v1.2.4', head: 'dev', base: 'main', body: 'old', state: 'OPEN' }]);
    expect(ghCalls(f).every((c) => c[0] === 'pr' && c[1] === 'list')).toBe(true);
    expect(originSha(f, 'refs/heads/release/v1.2.4')).toBeNull();
  });

  test('a SHA that is not on dev', () => {
    const f = fixture();
    git(f.work, 'checkout', '-qb', 'feature');
    writeFileSync(join(f.work, 'side.txt'), 'x');
    git(f.work, 'add', '-A');
    git(f.work, 'commit', '-qm', 'feat: unreviewed');
    git(f.work, 'push', '-q', 'origin', 'feature');
    const r = cut(f, git(f.work, 'rev-parse', 'HEAD'));
    expect(r.status).not.toBe(0);
    expect(r.log).toContain('is not on dev');
  });

  test('main carrying a hotfix dev has not merged back yet', () => {
    const f = fixture();
    git(f.work, 'checkout', '-q', 'main');
    writeFileSync(join(f.work, 'hotfix.txt'), 'x');
    git(f.work, 'add', '-A');
    git(f.work, 'commit', '-qm', 'fix: urgent hotfix');
    git(f.work, 'push', '-q', 'origin', 'main');
    const r = cut(f, devHead(f));
    expect(r.status).not.toBe(0);
    expect(r.log).toContain('fix: urgent hotfix');
    expect(r.log).toContain('sync-dev');
    expect(originSha(f, 'refs/heads/release/v1.2.4')).toBeNull();
  });

  test('nothing new since main → nothing; chores only → nothing unless forced', () => {
    const f = fixture();
    expect(cut(f, originSha(f, 'refs/heads/main')!).outputs.status).toBe('nothing');

    const g = fixture();
    git(g.work, 'reset', '-q', '--hard', 'main');
    git(g.work, 'push', '-q', '--force', 'origin', 'dev');
    const chore = devCommit(g, 'chore: tidy');
    expect(cut(g, chore).outputs.status).toBe('nothing');
    expect(originSha(g, 'refs/heads/release/v1.2.4')).toBeNull();
    const forced = cut(g, chore, ['--force']);
    expect(forced.status, forced.log).toBe(0);
    expect(forced.outputs).toMatchObject({ status: 'created', version: '1.2.4' });
  });

  test('--dry-run pushes nothing and opens nothing', () => {
    const f = fixture();
    const r = cut(f, devCommit(f, 'feat: x (#11)'), ['--dry-run']);
    expect(r.status, r.log).toBe(0);
    expect(r.outputs).toMatchObject({ status: 'dry-run', version: '1.3.0' });
    expect(r.log).toContain('## Release v1.3.0 (frozen candidate)');
    expect(originSha(f, 'refs/heads/release/v1.3.0')).toBeNull();
    expect(prs(f)).toHaveLength(0);
  });
});

describe('cut: version correctness', () => {
  test.each([
    ['fix: a', '1.2.4'],
    ['feat(scope): a', '1.3.0'],
    ['feat!: drop it', '2.0.0'],
    ['refactor: BREAKING CHANGE in config', '2.0.0'],
  ])('%s → v%s', (subject, want) => {
    const f = fixture();
    const r = cut(f, devCommit(f, subject));
    expect(r.status, r.log).toBe(0);
    expect(r.outputs.version).toBe(want);
    expect(originSha(f, `refs/heads/release/v${want}`)).not.toBeNull();
  });

  test('first release, no tags at all: bumps from main’s package.json', () => {
    const f = fixture({ version: '0.1.0', tag: false });
    const r = cut(f, devCommit(f, 'feat: first'));
    expect(r.status, r.log).toBe(0);
    expect(r.outputs.version).toBe('0.2.0');
    expect(parseCandidateMeta(prs(f)[0].body)!.previousTag).toBeNull();
  });

  test('a tag only origin has (a concurrent release) is seen', () => {
    const f = fixture();
    const other = join(f.root, 'other');
    sh(f.root, 'git', ['clone', '-q', f.origin, other]);
    git(other, 'tag', 'v1.2.4', 'origin/main');
    git(other, 'push', '-q', 'origin', 'v1.2.4');
    const r = cut(f, devHead(f));
    expect(r.status, r.log).toBe(0);
    expect(r.outputs.version).toBe('1.2.5');
  });

  test('release automation subjects never decide the bump', () => {
    expect(planVersion({ latestTag: 'v1.2.3', mainVersion: '1.2.3', subjects: ['chore: bump version to v9.0.0', 'fix: a'] }).version).toBe('1.2.4');
    expect(isShippable(['chore: bump version to v1.0.0', 'docs: promote CHANGELOG for upcoming release'])).toBe(false);
  });

  test('main already ahead of the latest tag (an untagged ship) is not re-issued', () => {
    expect(planVersion({ latestTag: 'v1.2.3', mainVersion: '1.2.4', subjects: ['fix: a'] }).version).toBe('1.2.5');
  });
});

describe('amend: the only way a candidate moves', () => {
  function withCandidate(subject = 'fix: y (#11)') {
    const f = fixture();
    const source = devCommit(f, subject);
    const r = cut(f, source);
    expect(r.status, r.log).toBe(0);
    return { f, source, version: r.outputs.version, head: r.outputs.candidate_sha };
  }

  test('without the version typed twice, nothing happens', () => {
    const { f, version, head } = withCandidate();
    const later = devCommit(f, 'fix: z (#12)');
    const r = run(f, 'amend', ['--candidate', `v${version}`, '--confirm', 'v9.9.9', '--source', later]);
    expect(r.status).not.toBe(0);
    expect(r.log).toContain('does not match');
    expect(originSha(f, `refs/heads/release/v${version}`)).toBe(head);
  });

  test('same version: new SHA on the same branch, metadata bumped, approvals dismissed, a comment says why', () => {
    const { f, source, version, head } = withCandidate();
    setPrs(f, prs(f).map((p) => ({ ...p, reviews: [{ id: 1, state: 'APPROVED' }, { id: 2, state: 'COMMENTED' }] })), 101);
    const later = devCommit(f, 'fix: z (#12)');
    const r = run(f, 'amend', ['--candidate', `v${version}`, '--confirm', `v${version}`, '--source', later]);
    expect(r.status, r.log).toBe(0);
    expect(r.outputs.status).toBe('amended');

    const newHead = originSha(f, `refs/heads/release/v${version}`)!;
    expect(newHead).not.toBe(head);
    expect(git(f.origin, 'rev-parse', `${newHead}^`)).toBe(later);
    const [pr] = prs(f);
    const meta = parseCandidateMeta(pr.body)!;
    expect(meta).toMatchObject({ sourceSha: later, candidateSha: newHead, amendment: 1, previousCandidateSha: head });
    expect(meta.sourceSha).not.toBe(source);
    expect(pr.reviews).toEqual([{ id: 1, state: 'DISMISSED' }, { id: 2, state: 'COMMENTED' }]);
    expect(pr.comments?.[0]).toContain('void');
  });

  test('a range that now needs a new version becomes a new candidate; the old PR is closed, its branch kept', () => {
    const { f, version, head } = withCandidate('fix: y (#11)');
    const later = devCommit(f, 'feat: bigger (#12)');
    const r = run(f, 'amend', ['--candidate', `v${version}`, '--confirm', `v${version}`, '--source', later]);
    expect(r.status, r.log).toBe(0);
    expect(r.outputs).toMatchObject({ status: 'created', version: '1.3.0' });
    const [old, fresh] = prs(f);
    expect(old.state).toBe('CLOSED');
    expect(old.closeComment).toContain('release/v1.3.0');
    expect(fresh).toMatchObject({ title: 'Release v1.3.0', head: 'release/v1.3.0', state: 'OPEN' });
    expect(parseCandidateMeta(fresh.body)).toMatchObject({ supersedes: old.number, amendment: 1, previousCandidateSha: head });
    expect(originSha(f, `refs/heads/release/v${version}`)).toBe(head);
  });

  test('an amendment never goes backwards', () => {
    const f = fixture();
    const early = devHead(f);
    const source = devCommit(f, 'fix: y (#11)');
    const r0 = cut(f, source);
    const r = run(f, 'amend', ['--candidate', `v${r0.outputs.version}`, '--confirm', `v${r0.outputs.version}`, '--source', early]);
    expect(r.status).not.toBe(0);
    expect(r.log).toContain('only moves forward');
  });
});

describe('pure helpers', () => {
  test('candidate branch names', () => {
    expect(candidateVersionOf('release/v1.2.3')).toBe('1.2.3');
    expect(candidateVersionOf('release/v1.2')).toBeNull();
    expect(candidateVersionOf('dev')).toBeNull();
    expect(candidateVersionOf('release/v1.2.3-rc1')).toBeNull();
  });

  test('latestSemverTag sorts numerically and ignores odd tags', () => {
    expect(latestSemverTag(['v0.9.0', 'v0.10.0', 'v1.0.0-rc1', 'nightly', ''])).toBe('v0.10.0');
    expect(latestSemverTag([])).toBeNull();
  });

  test('prNumbersIn', () => {
    expect(prNumbersIn('feat: x (#12)')).toEqual([12]);
    expect(prNumbersIn('Merge pull request #4026 from o/dev')).toEqual([4026]);
    expect(prNumbersIn('fix: no number')).toEqual([]);
  });

  test('promoteChangelog skips an empty [Unreleased]', () => {
    const empty = '# C\n\n## [Unreleased]\n\n## [1.0.0] - x\n\n- a\n';
    expect(promoteChangelog(empty, '1.1.0', '2026-01-02', 'v1.0.0', 'o/r')).toBe(empty);
  });

  test('replaceExcluded touches only the excluded section', () => {
    const meta = { schema: 1, version: '1.0.0', branch: 'release/v1.0.0', sourceRef: 'dev', sourceSha: 'a'.repeat(40), candidateSha: 'b'.repeat(40), baseRef: 'main', baseSha: 'c'.repeat(40), previousTag: null, bump: 'minor', amendment: 0, previousCandidateSha: null, supersedes: null, cutAt: 'now' } as CandidateMeta;
    const body = renderCandidateBody(meta, [{ sha: 'd'.repeat(40), subject: 'feat: in (#1)' }], [], 'o/r');
    const next = replaceExcluded(body, [{ sha: 'e'.repeat(40), subject: 'fix: later (#2)' }]);
    expect(next).toContain('fix: later (#2)');
    expect(parseCandidateMeta(next)).toEqual(meta);
    expect(next.replace(/<!-- release-candidate:excluded:start -->[\s\S]*<!-- release-candidate:excluded:end -->/, '')).toBe(
      body.replace(/<!-- release-candidate:excluded:start -->[\s\S]*<!-- release-candidate:excluded:end -->/, ''),
    );
  });
});

describe('reconcileChangelog: main’s promoted CHANGELOG back into dev', () => {
  const base = '# C\n\n## [Unreleased]\n\n### Fixed\n\n- a fix\n\n## [1.0.0] - x\n\n- old\n\n[Unreleased]: u/v1.0.0...HEAD\n';
  const theirs = '# C\n\n## [Unreleased]\n\n## [1.1.0] - y\n\n### Fixed\n\n- a fix\n\n## [1.0.0] - x\n\n- old\n\n[Unreleased]: u/v1.1.0...HEAD\n[1.1.0]: u/v1.0.0...v1.1.0\n';

  test('keeps dev’s new entries, drops the released ones, takes main’s sections and links', () => {
    const ours = '# C\n\n## [Unreleased]\n\n### Added\n\n- new thing\n  continued\n\n### Fixed\n\n- a fix\n\n## [1.0.0] - x\n\n- old\n\n[Unreleased]: u/v1.0.0...HEAD\n';
    expect(reconcileChangelog(base, ours, theirs)).toBe(
      '# C\n\n## [Unreleased]\n\n### Added\n\n- new thing\n  continued\n\n## [1.1.0] - y\n\n### Fixed\n\n- a fix\n\n## [1.0.0] - x\n\n- old\n\n[Unreleased]: u/v1.1.0...HEAD\n[1.1.0]: u/v1.0.0...v1.1.0\n',
    );
  });

  test('nothing new on dev → main’s file exactly', () => {
    expect(reconcileChangelog(base, base, theirs)).toBe(theirs);
  });

  test('dev edited a released section → refuses rather than pick a side', () => {
    const ours = base.replace('- old', '- old, corrected');
    expect(() => reconcileChangelog(base, ours, theirs)).toThrow('outside [Unreleased]');
  });
});
