import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * `release-refresh.yml` recomputes the open release PR's version as dev moves.
 * Its decision script contains no `${{ }}` interpolation, so it is extracted
 * and run for real against a scratch repo with a bare origin and a `gh` stub
 * that records what the workflow asked GitHub to do.
 */

const WORKFLOW = '.github/workflows/release-refresh.yml';
const HELPER = join(import.meta.dir, 'release-bump.ts');
const PACKAGE_FILES = ['apps/web/package.json', 'packages/core/package.json'];

const wf = (): any => Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8'));
const refreshScript = (): string => {
  const s = wf().jobs.refresh.steps.find((x: any) => x.name === 'Refresh the open release PR');
  expect(s).toBeDefined();
  expect(s.run).not.toContain('${{'); // else this harness is not running what CI runs
  return s.run;
};

function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}
const git = (cwd: string, ...args: string[]) => {
  const r = sh(cwd, 'git', args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

interface Fixture {
  work: string;
  origin: string;
  bin: string;
  ghLog: string;
  prFile: string;
  stateFile: string;
}

/** dev: tagged v1.2.0, then a fix, then the cut's bump to 1.2.1 — PR "Release v1.2.1". */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'release-refresh-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  sh(root, 'git', ['init', '-q', '--bare', origin]);
  sh(root, 'git', ['init', '-q', '-b', 'dev', work]);
  git(work, 'config', 'user.email', 't@t.test');
  git(work, 'config', 'user.name', 'T');
  git(work, 'config', 'commit.gpgsign', 'false');
  const writePkgs = (v: string) => {
    for (const p of PACKAGE_FILES) {
      mkdirSync(join(work, p, '..'), { recursive: true });
      writeFileSync(join(work, p), JSON.stringify({ name: p, version: v }, null, 2) + '\n');
    }
  };
  writePkgs('1.2.0');
  writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - d\n\n- old\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'initial');
  git(work, 'tag', 'v1.2.0');
  writeFileSync(join(work, 'a.txt'), 'a');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'fix: a');
  writePkgs('1.2.1');
  writeFileSync(
    join(work, 'CHANGELOG.md'),
    '# Changelog\n\n## [Unreleased]\n\n## [1.2.1] - d\n\n- fix: a\n\n## [1.2.0] - d\n\n- old\n',
  );
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'chore: bump version to v1.2.1');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'dev', '--tags');

  const ghLog = join(root, 'gh.log');
  const prFile = join(root, 'prs.json');
  const stateFile = join(root, 'state');
  writeFileSync(ghLog, '');
  writeFileSync(prFile, JSON.stringify([{ number: 7, title: 'Release v1.2.1', body: 'old body' }]));
  writeFileSync(stateFile, 'OPEN');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
# One record per call: args separated by \\x1f, records by \\x1e (bodies are multi-line).
{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\036'; } >> "${ghLog}"
case "$1 $2" in
  "pr list") cat "${prFile}" ;;
  "pr view") cat "${stateFile}" ;;
  "api --method") ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { work, origin, bin, ghLog, prFile, stateFile };
}

function refresh(f: Fixture, env: Record<string, string> = {}) {
  return sh(f.work, 'bash', ['-c', refreshScript()], {
    PATH: `${f.bin}:${process.env.PATH}`,
    RELEASE_BUMP: HELPER,
    REPO: 'o/r',
    GH_TOKEN: 'unused',
    PUSH_TRIGGERS_CI: 'true',
    PACKAGE_FILES: PACKAGE_FILES.join(' '),
    ...env,
  });
}

function landOnDev(f: Fixture, subject: string) {
  writeFileSync(join(f.work, `${Math.random()}.txt`), subject);
  git(f.work, 'add', '-A');
  git(f.work, 'commit', '-qm', subject);
  git(f.work, 'push', '-q', 'origin', 'dev');
}

const version = (f: Fixture, p: string) => JSON.parse(readFileSync(join(f.work, p), 'utf8')).version;
/** Each recorded `gh api --method PATCH` call, args joined with spaces. */
const patchCalls = (f: Fixture) =>
  readFileSync(f.ghLog, 'utf8')
    .split('\x1e')
    .filter(Boolean)
    .map((rec) => rec.split('\x1f').slice(0, -1))
    .filter((a) => a[0] === 'api' && a[1] === '--method' && a[2] === 'PATCH')
    .map((a) => a.join(' '));
const patchBody = (call: string) => /-f body=([\s\S]*) --silent$/.exec(call)?.[1] ?? '';

describe('release-refresh workflow', () => {
  test('a feat merged after a patch cut raises dev and the PR to the next minor', () => {
    const f = fixture();
    landOnDev(f, 'feat(x): new thing');
    const r = refresh(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);

    for (const p of PACKAGE_FILES) expect(version(f, p)).toBe('1.3.0');
    expect(readFileSync(join(f.work, 'CHANGELOG.md'), 'utf8')).toContain('## [1.3.0] - d');
    expect(git(f.work, 'log', '-1', '--format=%s')).toBe('chore: bump version to v1.3.0');
    // Pushed, not just committed locally.
    expect(git(f.origin, 'rev-parse', 'refs/heads/dev')).toBe(git(f.work, 'rev-parse', 'HEAD'));

    const [call] = patchCalls(f);
    expect(call).toContain('repos/o/r/pulls/7');
    expect(call).toContain('title=Release v1.3.0');
    expect(call).toContain('feat(x): new thing');
    expect(call).not.toContain('- chore: bump version');
  });

  test('a fix merged after the cut refreshes the change list but keeps the version', () => {
    const f = fixture();
    landOnDev(f, 'fix: b');
    const before = git(f.work, 'rev-parse', 'HEAD');
    const r = refresh(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(f.work, 'rev-parse', 'HEAD')).toBe(before); // no bump commit
    const [call] = patchCalls(f);
    expect(call).toContain('title=Release v1.2.1');
    expect(call).toContain('- fix: b');
  });

  test('idempotent: a second run after the raise changes nothing', () => {
    const f = fixture();
    landOnDev(f, 'feat: x');
    expect(refresh(f).status).toBe(0);
    const [first] = patchCalls(f);
    const body = patchBody(first);
    expect(body).toContain('## v1.3.0');
    writeFileSync(f.prFile, JSON.stringify([{ number: 7, title: 'Release v1.3.0', body }]));
    const head = git(f.work, 'rev-parse', 'HEAD');

    const again = refresh(f);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(git(f.work, 'rev-parse', 'HEAD')).toBe(head);
    expect(patchCalls(f)).toHaveLength(1);
  });

  test('heals a run that pushed the bump but died before retitling', () => {
    const f = fixture();
    landOnDev(f, 'feat: x');
    expect(refresh(f).status).toBe(0);
    const head = git(f.work, 'rev-parse', 'HEAD');
    // Title still says the old version (the PATCH never happened).
    writeFileSync(f.ghLog, '');
    const r = refresh(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(f.work, 'rev-parse', 'HEAD')).toBe(head); // no second bump
    expect(patchCalls(f)[0]).toContain('title=Release v1.3.0');
  });

  test('never lowers a version someone raised by hand', () => {
    const f = fixture();
    writeFileSync(f.prFile, JSON.stringify([{ number: 7, title: 'Release v2.0.0', body: '' }]));
    landOnDev(f, 'fix: b');
    const r = refresh(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(patchCalls(f)[0]).toContain('title=Release v2.0.0');
  });

  test('no open release PR → no-op', () => {
    const f = fixture();
    writeFileSync(f.prFile, '[]');
    landOnDev(f, 'feat: x');
    const head = git(f.work, 'rev-parse', 'HEAD');
    const r = refresh(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(f.work, 'rev-parse', 'HEAD')).toBe(head);
    expect(patchCalls(f)).toHaveLength(0);
  });

  test('a hand-edited title is left alone', () => {
    const f = fixture();
    writeFileSync(f.prFile, JSON.stringify([{ number: 7, title: 'Release v1.2.1 (hold)', body: '' }]));
    landOnDev(f, 'feat: x');
    const r = refresh(f);
    expect(r.status).toBe(0);
    expect(version(f, 'apps/web/package.json')).toBe('1.2.1');
    expect(patchCalls(f)).toHaveLength(0);
  });

  test('does not bump dev when the PR merged while the run was in flight', () => {
    const f = fixture();
    writeFileSync(f.stateFile, 'MERGED');
    landOnDev(f, 'feat: x');
    const head = git(f.work, 'rev-parse', 'HEAD');
    const r = refresh(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(f.origin, 'rev-parse', 'refs/heads/dev')).toBe(head);
    expect(patchCalls(f)).toHaveLength(0);
  });

  test('a rejected push (dev moved) exits cleanly and does not retitle', () => {
    const f = fixture();
    landOnDev(f, 'feat: x');
    // Someone else pushes to origin/dev first.
    const other = join(f.work, '..', 'other');
    sh(join(f.work, '..'), 'git', ['clone', '-q', '-b', 'dev', f.origin, other]);
    git(other, 'config', 'user.email', 't@t.test');
    git(other, 'config', 'user.name', 'T');
    writeFileSync(join(other, 'z.txt'), 'z');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'fix: z');
    git(other, 'push', '-q', 'origin', 'dev');

    const r = refresh(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('dev moved');
    expect(patchCalls(f)).toHaveLength(0);
  });

  test('warns when the bump push cannot trigger CI', () => {
    const f = fixture();
    landOnDev(f, 'feat: x');
    const r = refresh(f, { PUSH_TRIGGERS_CI: 'false' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::');
  });
});

describe('release-refresh workflow wiring', () => {
  test('runs on dev pushes, newest wins', () => {
    const w = wf();
    const on = w.on ?? w[true as unknown as string];
    expect(on.push.branches).toEqual(['dev']);
    expect(w.concurrency).toEqual({ group: 'release-refresh', 'cancel-in-progress': true });
  });

  test('pushes with the release App token when configured, like ci-fix.yml', () => {
    const steps = wf().jobs.refresh.steps;
    const app = steps.find((s: any) => s.id === 'app-token');
    expect(app.with['private-key']).toBe('${{ secrets.RELEASE_APP_PRIVATE_KEY }}');
    const checkout = steps.find((s: any) => String(s.uses).startsWith('actions/checkout'));
    expect(checkout.with.token).toContain('steps.app-token.outputs.token');
    expect(checkout.with.ref).toBe('dev');
  });

  test('never echoes a secret', () => {
    const text = readFileSync(WORKFLOW, 'utf8');
    // Naming a secret in a hint is fine; expanding one into the log is not.
    expect(text).not.toMatch(/echo[^\n]*(\$\{?GH_TOKEN|\$\{\{\s*secrets\.)/);
  });
});
