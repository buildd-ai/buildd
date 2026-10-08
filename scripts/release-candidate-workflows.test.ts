import { describe, test, expect, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promoteChangelog } from './release-candidate';

// Real git subprocesses per test; the unmodified 5000ms bun default flakes
// under full-suite concurrent load even though each test is fast in isolation.
setDefaultTimeout(30_000);

/**
 * The workflows around frozen release candidates. Their `run:` scripts carry no
 * `${{ }}` interpolation (inputs arrive through env), so each is extracted and
 * executed for real; structure that cannot be executed is asserted on the
 * parsed YAML.
 */

const y = (file: string): any => Bun.YAML.parse(readFileSync(file, 'utf8'));
const RELEASE = '.github/workflows/release.yml';
const SYNC_DEV = '.github/workflows/sync-dev.yml';
const REFRESH = '.github/workflows/release-refresh.yml';
const BUILD = '.github/workflows/build.yml';

function step(file: string, job: string, match: (s: any) => boolean): any {
  const s = y(file).jobs[job].steps.find(match);
  expect(s, `${file} ${job}`).toBeDefined();
  if (typeof s.run === 'string') expect(s.run).not.toContain('${{'); // else this harness is not running what CI runs
  return s;
}

function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}
const git = (cwd: string, ...args: string[]) => {
  const r = sh(cwd, 'git', args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function runScript(script: string, cwd: string, env: Record<string, string>) {
  const out = join(mkdtempSync(join(tmpdir(), 'wf-out-')), 'out');
  writeFileSync(out, '');
  const r = sh(cwd, 'bash', ['-e', '-c', script], { GITHUB_OUTPUT: out, ...env });
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { status: r.status, log: r.stdout + r.stderr, outputs };
}

describe('release.yml: the flow switch', () => {
  const wf = y(RELEASE);
  const mode = () => step(RELEASE, 'mode', (s) => s.id === 'flow').run as string;

  test.each([
    [{ SWITCH: 'enabled' }, 'candidate'],
    [{ SWITCH: '' }, 'legacy'],
    [{ SWITCH: 'yes' }, 'legacy'],
    [{ SWITCH: '', DRY_RUN: 'true' }, 'candidate'],
  ])('%o → %s', (env, flow) => {
    const r = runScript(mode(), tmpdir(), { DRY_RUN: '', AMEND: '', ...env });
    expect(r.status, r.log).toBe(0);
    expect(r.outputs.flow).toBe(flow);
  });

  test('an amend request without the candidate flow is refused, not run as a legacy release', () => {
    const r = runScript(mode(), tmpdir(), { SWITCH: '', DRY_RUN: '', AMEND: 'v1.2.3' });
    expect(r.status).not.toBe(0);
    expect(r.outputs.flow).toBeUndefined();
  });

  test('legacy jobs run only in the legacy flow; the cut job only in the candidate flow', () => {
    expect(wf.jobs['prepare-changelog'].if).toBe("needs.mode.outputs.flow == 'legacy'");
    expect(wf.jobs.release.if).toBe("needs.mode.outputs.flow == 'legacy'");
    expect(wf.jobs.release.uses).toBe('buildd-ai/.github/.github/workflows/release.yml@main');
    expect(wf.jobs.cut.if).toBe("needs.mode.outputs.flow == 'candidate'");
    expect(wf.jobs.cut.uses).toBeUndefined();
  });

  test('least privilege: nothing by default, write only where a job pushes', () => {
    expect(wf.permissions).toEqual({});
    expect(wf.jobs.mode.permissions).toEqual({});
    expect(wf.jobs.cut.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
  });

  test('cuts are serialised and never cancelled half-way', () => {
    expect(wf.concurrency).toEqual({ group: 'release-cut', 'cancel-in-progress': false });
  });

  test('the captured SHA is github.sha (stable across re-runs), checked out and passed to the engine', () => {
    const checkout = wf.jobs.cut.steps.find((s: any) => String(s.uses).startsWith('actions/checkout'));
    expect(checkout.with.ref).toBe('${{ github.sha }}');
    expect(checkout.with['fetch-depth']).toBe(0);
    const cut = step(RELEASE, 'cut', (s) => s.id === 'cut');
    expect(cut.env.SOURCE_SHA).toBe('${{ github.sha }}');
    // Inputs reach the shell only as env, never interpolated into the script.
    for (const k of ['FORCE', 'DRY_RUN', 'AMEND', 'AMEND_CONFIRM']) expect(String(cut.env[k])).toMatch(/^\$\{\{ inputs\.\w+ \}\}$/);
  });

  test('the App key is used only to mint a token, and only outside dry runs', () => {
    const text = readFileSync(RELEASE, 'utf8');
    const uses = text.split('\n').filter((l) => l.includes('${{ secrets.RELEASE_APP_PRIVATE_KEY }}'));
    expect(uses).toHaveLength(2); // the mint step + the legacy reusable passthrough
    const mint = wf.jobs.cut.steps.find((s: any) => s.id === 'app-token');
    expect(mint.if).toContain("inputs.dry_run != 'true'");
  });

  describe('guard', () => {
    const guard = () => step(RELEASE, 'cut', (s) => s.id === 'guard').run as string;
    function withDate(dow: string) {
      const bin = mkdtempSync(join(tmpdir(), 'fake-date-'));
      writeFileSync(join(bin, 'date'), `#!/bin/sh\necho ${dow}\n`);
      chmodSync(join(bin, 'date'), 0o755);
      return { PATH: `${bin}:${process.env.PATH}` };
    }
    test('refuses any ref but dev', () => {
      const r = runScript(guard(), tmpdir(), { EVENT: 'workflow_dispatch', REF: 'refs/heads/feature' });
      expect(r.status).not.toBe(0);
    });
    test('scheduled cuts skip weekends; dispatches do not', () => {
      expect(runScript(guard(), tmpdir(), { EVENT: 'schedule', REF: 'refs/heads/dev', ...withDate('6') }).outputs.skip).toBe('true');
      expect(runScript(guard(), tmpdir(), { EVENT: 'schedule', REF: 'refs/heads/dev', ...withDate('3') }).outputs.skip).toBeUndefined();
      expect(runScript(guard(), tmpdir(), { EVENT: 'workflow_dispatch', REF: 'refs/heads/dev', ...withDate('7') }).outputs.skip).toBeUndefined();
    });
  });
});

describe('release-refresh.yml is off under the candidate flow', () => {
  test('its only job is gated on the switch', () => {
    expect(String(y(REFRESH).jobs.refresh.if)).toContain("vars.RELEASE_CANDIDATE_CUT != 'enabled'");
  });
  test('and it only ever reads a PR whose head is dev', () => {
    expect(step(REFRESH, 'refresh', (s) => s.name === 'Refresh the open release PR').run).toContain('--head dev');
  });
});

describe('release candidates: one integration job, one aggregate (build.yml)', () => {
  const wf = y(BUILD);
  const CANDIDATE_CHECK = 'candidate integration';

  test('exactly one job in any workflow tests a candidate, so two runs never fight over the test machine', () => {
    const owners: string[] = [];
    for (const f of readdirSync('.github/workflows').filter((n) => /\.ya?ml$/.test(n))) {
      for (const [id, job] of Object.entries<any>(y(join('.github/workflows', f)).jobs ?? {})) {
        const neon = String(job.with?.neon_branch ?? '');
        if (job.name === CANDIDATE_CHECK || neon.startsWith('ci/candidate-pr-')) owners.push(`${f}:${id}`);
      }
    }
    expect(owners).toEqual(['build.yml:candidate-integration']);
  });

  test('that job is the full API + runner suite at the exact head SHA, keyed on the release/v prefix', () => {
    const j = wf.jobs['candidate-integration'];
    expect(j.uses).toBe('./.github/workflows/integration.yml');
    expect(j.with).toMatchObject({ api: true, runner: true, e2e: false, checkout_sha: '${{ github.event.pull_request.head.sha }}', source: 'release-candidate' });
    expect(j.if).toContain("startsWith(github.head_ref, 'release/v')");
  });

  test('the hotfix integration job does not also book the test machine for a candidate', () => {
    expect(wf.jobs.integration.if).toContain("!startsWith(github.head_ref, 'release/v')");
  });

  test('`release candidate verified` reads that job, and is reported on every PR into main', () => {
    const v = wf.jobs['candidate-verified'];
    expect(v.name).toBe('release candidate verified');
    expect([...v.needs].sort()).toEqual(['candidate-identify', 'candidate-integration']);
    expect(v.if).toBe("always() && github.event_name == 'pull_request' && github.base_ref == 'main'");
    expect(wf.jobs['candidate-identify'].if).toBe("github.event_name == 'pull_request' && github.base_ref == 'main'");
  });

  test.each([
    ['release/v1.2.3', 'o/r', 0, 'true'],
    ['dev', 'o/r', 0, 'false'],
    ['hotfix/x', 'fork/r', 0, 'false'],
    ['release/v1.2', 'o/r', 1, undefined],
    ['release/v1.2.3', 'fork/r', 1, undefined],
  ])('identify %s from %s → exit %d, candidate=%s', (ref, headRepo, code, want) => {
    const r = runScript(step(BUILD, 'candidate-identify', (s) => s.id === 'id').run, tmpdir(), {
      HEAD_REF: ref, HEAD_SHA: 'a'.repeat(40), HEAD_REPO: headRepo, REPO: 'o/r',
    });
    expect(r.status, r.log).toBe(code);
    expect(r.outputs.candidate).toBe(want);
  });

  test.each([
    [{ IDENTIFY: 'success', CANDIDATE: 'false', INTEGRATION: 'skipped' }, 0],
    [{ IDENTIFY: 'success', CANDIDATE: 'true', INTEGRATION: 'success' }, 0],
    [{ IDENTIFY: 'success', CANDIDATE: 'true', INTEGRATION: 'failure' }, 1],
    [{ IDENTIFY: 'success', CANDIDATE: 'true', INTEGRATION: 'skipped' }, 1],
    [{ IDENTIFY: 'success', CANDIDATE: 'true', INTEGRATION: 'cancelled' }, 1],
    [{ IDENTIFY: 'failure', CANDIDATE: '', INTEGRATION: 'success' }, 1],
  ])('verified %o → exit %d', (env, code) => {
    const run = step(BUILD, 'candidate-verified', () => true).run as string;
    expect(runScript(run, tmpdir(), { SHA: 'x', ...env }).status).toBe(code);
  });
});

describe('sync-dev.yml merges main into dev and never rewrites it', () => {
  const script = () => step(SYNC_DEV, 'sync', (s) => s.name === 'Bring main into dev without rewriting it').run as string;
  const CL = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- a fix\n\n## [1.2.3] - 2000-01-01\n\n- old\n\n[Unreleased]: https://github.com/o/r/compare/v1.2.3...HEAD\n';

  /** origin: main = dev = v1.2.3 (with the engine committed, as it will be). */
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'sync-dev-'));
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    sh(root, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
    sh(root, 'git', ['init', '-q', '-b', 'main', work]);
    for (const [k, v] of [['user.email', 't@t.test'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
    mkdirSync(join(work, 'scripts'));
    copyFileSync(join(import.meta.dir, 'release-candidate.ts'), join(work, 'scripts/release-candidate.ts'));
    copyFileSync(join(import.meta.dir, 'release-bump.ts'), join(work, 'scripts/release-bump.ts'));
    writeFileSync(join(work, 'version.txt'), '1.2.3\n');
    writeFileSync(join(work, 'CHANGELOG.md'), CL);
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'initial');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', 'origin', 'main', 'main:dev');
    return { root, origin, work };
  }
  const commit = (dir: string, files: Record<string, string>, msg: string) => {
    for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', msg);
  };
  /** Cut a candidate from dev's head, merge it into main (merge commit, as GitHub does). */
  function shipCandidate(f: { work: string }) {
    git(f.work, 'checkout', '-q', '-B', 'release/v1.2.4', 'origin/dev');
    commit(f.work, { 'version.txt': '1.2.4\n', 'CHANGELOG.md': promoteChangelog(CL, '1.2.4', '2026-01-02', 'v1.2.3', 'o/r') }, 'chore: bump version to v1.2.4');
    git(f.work, 'checkout', '-q', 'main');
    git(f.work, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #9 from o/release/v1.2.4', 'release/v1.2.4');
    git(f.work, 'push', '-q', 'origin', 'main');
  }
  function sync(f: { root: string; origin: string }) {
    const runner = join(f.root, `runner-${Math.random().toString(36).slice(2)}`);
    sh(f.root, 'git', ['clone', '-q', '-b', 'main', f.origin, runner]);
    return runScript(script(), runner, {});
  }
  const originSha = (f: { origin: string }, ref: string) => git(f.origin, 'rev-parse', ref);

  test('dev moved on after the cut: main is merged in, dev’s later work and its new CHANGELOG entries survive', () => {
    const f = fixture();
    git(f.work, 'fetch', '-q', 'origin');
    shipCandidate(f);
    git(f.work, 'checkout', '-q', '-B', 'dev', 'origin/dev');
    commit(f.work, { 'later.txt': 'x', 'CHANGELOG.md': CL.replace('## [Unreleased]\n\n', '## [Unreleased]\n\n### Added\n\n- landed after the cut\n\n') }, 'feat: later (#12)');
    git(f.work, 'push', '-q', 'origin', 'dev');
    const devBefore = originSha(f, 'refs/heads/dev');

    const r = sync(f);
    expect(r.status, r.log).toBe(0);
    const devAfter = originSha(f, 'refs/heads/dev');
    // Not a rewrite: the old dev head and main are both ancestors of the new one.
    expect(sh(f.origin, 'git', ['merge-base', '--is-ancestor', devBefore, devAfter]).status).toBe(0);
    expect(sh(f.origin, 'git', ['merge-base', '--is-ancestor', 'refs/heads/main', devAfter]).status).toBe(0);
    expect(git(f.origin, 'show', `${devAfter}:version.txt`)).toBe('1.2.4');
    expect(git(f.origin, 'show', `${devAfter}:later.txt`)).toBe('x');
    const cl = git(f.origin, 'show', `${devAfter}:CHANGELOG.md`);
    expect(cl).toContain('## [Unreleased]\n\n### Added\n\n- landed after the cut\n\n## [1.2.4] - 2026-01-02\n\n### Fixed\n\n- a fix');
    expect(cl.split('## [1.2.4]')[0]).not.toContain('- a fix');
    expect(cl).toContain('[1.2.4]: https://github.com/o/r/compare/v1.2.3...v1.2.4');
  });

  test('dev did not move: fast-forward', () => {
    const f = fixture();
    git(f.work, 'fetch', '-q', 'origin');
    shipCandidate(f);
    const r = sync(f);
    expect(r.status, r.log).toBe(0);
    expect(originSha(f, 'refs/heads/dev')).toBe(originSha(f, 'refs/heads/main'));
  });

  test('a real code conflict fails loudly and leaves dev exactly where it was', () => {
    const f = fixture();
    git(f.work, 'checkout', '-q', 'main');
    commit(f.work, { 'version.txt': 'hotfix\n' }, 'fix: hotfix on main');
    git(f.work, 'push', '-q', 'origin', 'main');
    git(f.work, 'fetch', '-q', 'origin');
    git(f.work, 'checkout', '-q', '-B', 'dev', 'origin/dev');
    commit(f.work, { 'version.txt': 'dev change\n' }, 'fix: dev change');
    git(f.work, 'push', '-q', 'origin', 'dev');
    const devBefore = originSha(f, 'refs/heads/dev');

    const r = sync(f);
    expect(r.status).not.toBe(0);
    expect(r.log).toContain('version.txt');
    expect(originSha(f, 'refs/heads/dev')).toBe(devBefore);
  });

  test('dev missing → recreated from main', () => {
    const f = fixture();
    git(f.work, 'push', '-q', 'origin', '--delete', 'dev');
    const r = sync(f);
    expect(r.status, r.log).toBe(0);
    expect(originSha(f, 'refs/heads/dev')).toBe(originSha(f, 'refs/heads/main'));
  });

  test('the workflow pushes dev without force', () => {
    const pushes = script().split('\n').filter((l) => /git push/.test(l) && !/^\s*#/.test(l));
    expect(pushes.length).toBeGreaterThan(0);
    for (const l of pushes) expect(l).not.toMatch(/--force|\s-f\b|\+refs|\+HEAD/);
  });
});

describe('local scripts no longer reset dev', () => {
  test('release.sh --finalize and --finalize-force refuse', () => {
    for (const flag of ['--finalize', '--finalize-force']) {
      const r = sh(tmpdir(), 'bash', [join(import.meta.dir, 'release.sh'), flag]);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain('is gone');
    }
  });
  test('no force-push or hard reset of dev remains in the local release scripts', () => {
    for (const file of ['release.sh', 'sync-dev.sh']) {
      const code = readFileSync(join(import.meta.dir, file), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l) && !/echo /.test(l));
      expect(code.filter((l) => /reset --hard|push (--force|-f\b)|--force-with-lease/.test(l)), file).toEqual([]);
    }
  });
  test('package.json: release:finalize is gone; release:candidate runs the engine', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    expect(scripts['release:finalize']).toBeUndefined();
    expect(scripts['release:candidate']).toBe('bun scripts/release-candidate.ts');
  });
});
