/**
 * Runner-hosted Quality Scout command probes (design `quality-scout-runner-host`
 * §6): the poller's gates (sandbox, opt-out, busy, back-off) and the hosting
 * pipeline's guarantees, the latter against a real throwaway git repo with
 * real child processes:
 *
 *  - the probe's environment carries no runner, GitHub, Claude or Codex
 *    credential and no git credential helper, even when the host has them;
 *  - a runner that cannot sandbox never claims, unless the operator opted in;
 *  - a non-SHA candidate is released, never run;
 *  - a probe that dirties the checkout makes the next one refuse it;
 *  - fixture-setup failure is `inconclusive: fixture_setup_failed`, never `fail`;
 *  - the worktree is removed whatever happens.
 *
 * No runner process is started; the server is a fake object.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ScoutHostedProbeResult, ScoutRunClaimRequest, ScoutRunClaimResponse } from '@buildd/shared';
import { computeReadiness } from '@buildd/core/workspace-readiness';
import { discoverScoutCapabilities, type ScoutCapabilityProfile } from '@buildd/core/scout-capabilities';
import { exec } from '@buildd/core/quality-scout/local-host';
import {
  buildScoutProbeEnv,
  hostClaimedScoutRun,
  SCOUT_FIXTURE_FAILED,
  type ScoutClaimed,
  type ScoutHostApi,
} from '@buildd/core/quality-scout/runner-host';
import type { ScoutProbeRecord } from '@buildd/core/quality-scout/types';
import { verificationSignature } from '@buildd/core/verification-check';
import {
  buildScoutBwrapArgv,
  resolveScoutSandbox,
  ScoutHostPoller,
  SCOUT_UNFETCHABLE_BACKOFF_MS,
  scoutHostAdvert,
} from '../../src/scout-host';

/** Every credential-shaped variable a runner host may hold. None may reach a probe. */
const HOST_SECRETS: Record<string, string> = {
  BUILDD_API_KEY: 'bld_secretsecretsecret',
  BUILDD_SERVER: 'https://buildd.invalid',
  GITHUB_TOKEN: 'ghp_secretsecretsecret',
  GH_TOKEN: 'gho_secretsecretsecret',
  GH_ENTERPRISE_TOKEN: 'ghe_secretsecretsecret',
  ANTHROPIC_API_KEY: 'sk-ant-secretsecret',
  ANTHROPIC_AUTH_TOKEN: 'secretsecretsecret',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secretsecret',
  OPENAI_API_KEY: 'sk-secretsecretsecret',
  CODEX_HOME: '/home/runner/.codex',
  DISPATCH_API_KEY: 'secretsecretsecret',
  TENANT_MASTER_KEY: 'secretsecretsecret',
  DATABASE_URL: 'postgres://u:p@db.invalid/x',
  AWS_SECRET_ACCESS_KEY: 'secretsecretsecret',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
  GIT_ASKPASS: '/usr/bin/askpass',
  HTTPS_PROXY: 'http://user:pw@proxy.invalid:3128',
};
const SECRET_NAMES = Object.keys(HOST_SECRETS);

describe('buildScoutProbeEnv', () => {
  test('is an allowlist: no credential the host holds reaches the probe', () => {
    const env = buildScoutProbeEnv({ ...HOST_SECRETS, PATH: '/usr/bin:/bin', HOME: '/home/runner', LANG: 'C.UTF-8', SOME_APP_VAR: 'x' }, { home: '/t/home', tmp: '/t/home/tmp' });
    for (const k of SECRET_NAMES) expect(env[k]).toBeUndefined();
    expect(env.SOME_APP_VAR).toBeUndefined();
    expect(env).toMatchObject({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/t/home', TMPDIR: '/t/home/tmp', CI: '1', GIT_TERMINAL_PROMPT: '0' });
    // An empty credential.helper at command-line level beats every config file, repo-local included.
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' });
  });

  test('a proxy without userinfo passes; one carrying a password does not', () => {
    expect(buildScoutProbeEnv({ HTTPS_PROXY: 'http://proxy.invalid:3128' }, { home: '/h', tmp: '/t' }).HTTPS_PROXY).toBe('http://proxy.invalid:3128');
    expect(buildScoutProbeEnv({ HTTPS_PROXY: 'http://u:p@proxy.invalid:3128' }, { home: '/h', tmp: '/t' }).HTTPS_PROXY).toBeUndefined();
  });
});

describe('sandbox resolution and advert', () => {
  const yes = () => true;
  const no = () => false;
  test('bwrap when it holds', () => {
    expect(resolveScoutSandbox({}, yes)).toEqual({ mode: 'bwrap' });
  });
  test('no bwrap and no operator opt-in: refuses', () => {
    expect(resolveScoutSandbox({}, no)).toEqual({ mode: null, reason: 'no_sandbox' });
    expect(resolveScoutSandbox({ BUILDD_SCOUT_UNSANDBOXED: 'true' }, no)).toEqual({ mode: null, reason: 'no_sandbox' });
  });
  test('BUILDD_SCOUT_UNSANDBOXED=1 is the only way to run unsandboxed', () => {
    expect(resolveScoutSandbox({ BUILDD_SCOUT_UNSANDBOXED: '1' }, no)).toEqual({ mode: 'unsandboxed' });
  });
  test('BUILDD_SCOUT_HOST=0 opts out even with bwrap', () => {
    expect(resolveScoutSandbox({ BUILDD_SCOUT_HOST: '0' }, yes)).toEqual({ mode: null, reason: 'opted_out' });
  });
  test('advertises command only when it can sandbox, and only for repos it holds', () => {
    expect(scoutHostAdvert({ mode: 'bwrap' }, ['acme/tool'])).toEqual({ repos: ['acme/tool'], command: true, capture: false });
    expect(scoutHostAdvert({ mode: null, reason: 'no_sandbox' }, ['acme/tool'])).toBeUndefined();
    expect(scoutHostAdvert({ mode: null, reason: 'opted_out' }, ['acme/tool'])).toBeUndefined();
    expect(scoutHostAdvert({ mode: 'bwrap' }, [])).toBeUndefined();
  });
});

describe('buildScoutBwrapArgv', () => {
  const ctx = {
    worktree: '/work/scout-1/wt',
    home: '/work/scout-1/home',
    repoPath: '/repos/tool',
    bunInstallPath: '/home/runner/.bun',
    pathExists: () => true,
  };
  const argv = buildScoutBwrapArgv(ctx);
  const binds = (flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

  test('worktree and probe home are writable; the clone\'s .git is read-only', () => {
    expect(binds('--bind')).toContain('/work/scout-1/wt');
    expect(binds('--bind')).toContain('/work/scout-1/home');
    expect(binds('--ro-bind')).toContain('/repos/tool/.git');
    expect(binds('--bind')).not.toContain('/repos/tool/.git');
  });

  test('nothing of the runner\'s home is writable, and its credentials are never mounted', () => {
    const all = [...binds('--bind'), ...binds('--ro-bind')];
    expect(all.some((p) => p.includes('/home/runner/.claude') || p.includes('.buildd') || p.includes('.config/gh'))).toBe(false);
    expect(binds('--bind').some((p) => p.startsWith('/home/runner'))).toBe(false);
    expect(binds('--ro-bind')).toContain('/home/runner/.bun');
  });

  test('masks the shared bun cache with a tmpfs after the read-only ~/.bun bind exposes it', () => {
    // Removing the cache's rw bind alone left it readable through the ~/.bun ro bind
    // (caught by apps/runner/src/__tests__/scout-sandbox.e2e.ts in a real namespace).
    const cache = '/home/runner/.bun/install/cache';
    const tmpfsAt = argv.findIndex((a, i) => a === '--tmpfs' && argv[i + 1] === cache);
    const bunBindAt = argv.findIndex((a, i) => a === '--ro-bind' && argv[i + 1] === '/home/runner/.bun');
    expect(tmpfsAt).toBeGreaterThan(bunBindAt);
    expect(bunBindAt).toBeGreaterThan(-1);
    expect([...binds('--bind'), ...binds('--ro-bind')]).not.toContain(cache);
    // No cache on disk: no mask (its mountpoint could not be created inside the ro bind).
    const none = buildScoutBwrapArgv({ ...ctx, pathExists: (p) => p !== cache });
    expect(none).not.toContain(cache);
  });

  test('starts in the worktree', () => {
    expect(argv.slice(-2)).toEqual(['--chdir', '/work/scout-1/wt']);
  });
});

// ── Poller gates (fake API, fake hosting) ─────────────────────────────────

const SHA = 'a'.repeat(40);

function fakeClaim(over: Partial<ScoutClaimed> = {}): ScoutClaimed {
  return {
    run: {
      id: 'run-11111111', workspaceId: 'ws-1', missionId: null, trigger: 'manual', mode: 'shadow', status: 'awaiting_host',
      candidate: { ref: 'main', sha: SHA }, prior: null, budget: { maxProbes: 4, maxCostUsd: null }, policyVersion: 'v', startedAt: new Date().toISOString(),
      completedAt: null, error: null,
    },
    probes: [],
    profile: {},
    lease: { leaseId: 'lease-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), runnerMaxDurationMs: 600_000, hostDeadline: new Date(Date.now() + 3_600_000).toISOString() },
    repo: 'acme/tool',
    ...over,
  };
}

function fakeApi(claim: ScoutRunClaimResponse = { run: null, reason: 'none' }) {
  const calls = { claims: [] as ScoutRunClaimRequest[], releases: [] as string[], posts: [] as ScoutHostedProbeResult[][] };
  const api: ScoutHostApi = {
    claim: async (req) => { calls.claims.push(req); return claim; },
    postResults: async (_id, _lease, results) => {
      calls.posts.push(results);
      return { ok: true, body: { accepted: results.map((r) => r.candidateId), remaining: 0, finalized: false } };
    },
    release: async (_id, _lease, reason) => { calls.releases.push(reason); return true; },
  };
  return { api, calls };
}

const REPOS = [{ path: '/repos/tool', normalizedUrl: 'Acme/Tool' }];

describe('ScoutHostPoller', () => {
  test('a runner that cannot sandbox never claims', async () => {
    const { api, calls } = fakeApi();
    const p = new ScoutHostPoller({ api, scanRepos: () => REPOS, sandbox: () => resolveScoutSandbox({}, () => false), isBusy: () => false, log: () => {} });
    expect(await p.poll()).toBe('no_sandbox');
    expect(calls.claims).toHaveLength(0);
    expect(p.advert()).toBeUndefined();
  });

  test('opted out: never claims, never advertises', async () => {
    const { api, calls } = fakeApi();
    const p = new ScoutHostPoller({ api, scanRepos: () => REPOS, sandbox: () => resolveScoutSandbox({ BUILDD_SCOUT_HOST: '0' }, () => true), isBusy: () => false, log: () => {} });
    expect(await p.poll()).toBe('disabled');
    expect(calls.claims).toHaveLength(0);
    expect(p.advert()).toBeUndefined();
  });

  test('a busy runner does not claim', async () => {
    const { api, calls } = fakeApi();
    const p = new ScoutHostPoller({ api, scanRepos: () => REPOS, sandbox: () => ({ mode: 'bwrap' }), isBusy: () => true, log: () => {} });
    expect(await p.poll()).toBe('busy');
    expect(calls.claims).toHaveLength(0);
  });

  test('offers its clones and only the command port', async () => {
    const { api, calls } = fakeApi();
    const p = new ScoutHostPoller({ api, scanRepos: () => REPOS, sandbox: () => ({ mode: 'bwrap' }), isBusy: () => false, log: () => {} });
    expect(await p.poll()).toBe('idle');
    expect(calls.claims[0]).toEqual({ repos: ['acme/tool'], ports: { command: true, capture: false, browser: false } });
    expect(p.advert()).toEqual({ repos: ['acme/tool'], command: true, capture: false });
  });

  test('a runner that became busy after claiming hands the run back without checking out', async () => {
    const { api, calls } = fakeApi(fakeClaim());
    let busy = false;
    let hosted = 0;
    const p = new ScoutHostPoller({
      api, scanRepos: () => REPOS, sandbox: () => ({ mode: 'bwrap' }), log: () => {},
      isBusy: () => { const b = busy; busy = true; return b; },
      hostRun: async () => { hosted++; return { status: 'reported', posted: [], fixtureFailed: false, finalized: false, stopped: null }; },
    });
    expect(await p.poll()).toBe('released');
    expect(calls.releases).toEqual(['runner became busy']);
    expect(hosted).toBe(0);
  });

  test('bwrap mode wraps every probe command; unsandboxed mode does not', async () => {
    const seen: Array<((argv: string[]) => string[]) | undefined> = [];
    for (const mode of ['bwrap', 'unsandboxed'] as const) {
      const { api } = fakeApi(fakeClaim());
      const p = new ScoutHostPoller({
        api, scanRepos: () => REPOS, sandbox: () => ({ mode }), isBusy: () => false, log: () => {},
        bwrap: { pathExists: () => true },
        hostRun: async (o) => { seen.push(o.wrapFor?.({ worktree: '/w/wt', home: '/w/home', repoPath: '/repos/tool' })); return { status: 'reported', posted: [], fixtureFailed: false, finalized: false, stopped: null }; },
      });
      expect(await p.poll()).toBe('ran');
    }
    const wrapped = seen[0]!(['bash', '-c', 'true']);
    expect(wrapped[0]).toBe('bwrap');
    expect(wrapped.slice(-4)).toEqual(['--', 'bash', '-c', 'true']);
    expect(seen[1]).toBeUndefined();
  });

  test('a clone that cannot fetch the SHA is released and left out of offers for the back-off', async () => {
    const { api, calls } = fakeApi(fakeClaim());
    let t = 1_000_000;
    const p = new ScoutHostPoller({
      api, scanRepos: () => REPOS, sandbox: () => ({ mode: 'bwrap' }), isBusy: () => false, log: () => {}, now: () => t,
      hostRun: async () => ({ status: 'released', reason: 'fetch failed', unfetchable: true }),
    });
    expect(await p.poll()).toBe('released');
    expect(await p.poll()).toBe('idle');
    expect(calls.claims).toHaveLength(1);
    t += SCOUT_UNFETCHABLE_BACKOFF_MS + 1;
    await p.poll();
    expect(calls.claims).toHaveLength(2);
  });
});

// ── Hosting pipeline on a real repo ───────────────────────────────────────

let root: string;
let repo: string;
let headSha: string;

async function sh(cmd: string, cwd = repo) {
  const r = await exec('bash', ['-c', cmd], { cwd });
  if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'scout-host-test-'));
  repo = join(root, 'repo');
  await sh(`mkdir -p ${repo}`, root);
  await sh('git init -q -b main && git config user.email t@example.invalid && git config user.name t && git config commit.gpgsign false');
  // A repo-local credential helper: the probe must not see it.
  await sh('git config credential.helper store');
  writeFileSync(join(repo, 'pyproject.toml'), '[project]\nname = "tool"\n');
  writeFileSync(join(repo, 'README.md'), 'tool\n');
  await sh('git add -A && git commit -qm c0');
  headSha = await sh('git rev-parse HEAD');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENV_CHECK = [
  `if env | grep -qE '^(${SECRET_NAMES.join('|')})='; then echo leaked; env | cut -d= -f1; exit 3; fi`,
  'test "$CI" = 1 || exit 4',
  'case "$HOME" in */home) ;; *) exit 5 ;; esac',
  'test -z "$(git config --get credential.helper)" || exit 6',
].join('; ');

function profileWith(journeys: Array<{ name: string; command: string }>, fixtureSetup?: string): ScoutCapabilityProfile {
  return discoverScoutCapabilities({
    readiness: computeReadiness({ files: ['pyproject.toml', 'README.md'], manifests: { 'pyproject.toml': '[project]\nname = "tool"\n' } }),
    extension: {
      journeys: journeys.map((j) => ({ ...j, kind: 'cli', mutates: false, expect: 'exit 0' })),
      ...(fixtureSetup ? { fixtureSetup: { command: fixtureSetup } } : {}),
    },
  });
}

function probe(id: string, journey: string): ScoutProbeRecord {
  return {
    candidateId: id, family: 'contract', probeKind: 'cli-journey', title: id, invariant: 'exits 0', sourceSignals: [], preconditions: [],
    executor: `cli-journey:${journey}`, estimatedCost: 'low', risk: 'medium', mutates: false, evidenceRequirements: [], unsupportedReason: null,
    selection: { status: 'selected', via: 'decision', reasonCode: 'test', decisionSource: null }, host: 'runner', result: null,
  };
}

function claimFor(profile: ScoutCapabilityProfile, probes: ScoutProbeRecord[], sha = headSha): ScoutClaimed {
  const c = fakeClaim({ probes: probes as never, profile: profile as never });
  c.run.candidate = { ref: 'main', sha };
  return c;
}

function tmpRoot() {
  return mkdtempSync(join(root, 'tmp-'));
}

async function worktrees() {
  return (await sh('git worktree list --porcelain')).split('\n').filter((l) => l.startsWith('worktree ')).length;
}

describe('hostClaimedScoutRun', () => {
  test('the probe child env carries none of the host\'s credentials and no credential helper', async () => {
    const profile = profileWith([{ name: 'env', command: ENV_CHECK }]);
    const { api, calls } = fakeApi();
    const out = await hostClaimedScoutRun({
      claimed: claimFor(profile, [probe('p-env', 'env')]), repoPath: repo, api,
      sourceEnv: { ...process.env, ...HOST_SECRETS }, tmpRoot: tmpRoot(), log: () => {},
    });
    expect(out.status).toBe('reported');
    const r = calls.posts[0][0].result;
    expect({ verdict: r.verdict, observed: r.observed }).toEqual({ verdict: 'pass', observed: expect.stringContaining('exit 0') });
  });

  test('sends the check id plus signature parts the server can derive the signature from', async () => {
    const profile = profileWith([{ name: 'boom', command: 'exit 9' }]);
    const { api, calls } = fakeApi();
    await hostClaimedScoutRun({ claimed: claimFor(profile, [probe('p-boom', 'boom')]), repoPath: repo, api, tmpRoot: tmpRoot(), attempts: 1, log: () => {} });
    const r = calls.posts[0][0].result;
    expect(r.verdict).toBe('fail');
    expect(r.signatureParts!.length).toBeGreaterThan(0);
    expect(verificationSignature([r.checkId, ...r.signatureParts!])).toBe(r.signature!);
  });

  test('a non-SHA candidate is released and nothing is checked out', async () => {
    const profile = profileWith([{ name: 'ok', command: 'true' }]);
    const { api, calls } = fakeApi();
    const before = await worktrees();
    const out = await hostClaimedScoutRun({ claimed: claimFor(profile, [probe('p', 'ok')], 'main'), repoPath: repo, api, tmpRoot: tmpRoot(), log: () => {} });
    expect(out).toEqual({ status: 'released', reason: 'candidate is not a full commit SHA', unfetchable: false });
    expect(calls.releases).toHaveLength(1);
    expect(calls.posts).toHaveLength(0);
    expect(await worktrees()).toBe(before);
  });

  test('a SHA the clone cannot get is released as unfetchable, never run against another commit', async () => {
    const profile = profileWith([{ name: 'ok', command: 'true' }]);
    const { api, calls } = fakeApi();
    const out = await hostClaimedScoutRun({
      claimed: claimFor(profile, [probe('p', 'ok')], 'b'.repeat(40)), repoPath: repo, api, tmpRoot: tmpRoot(), log: () => {},
      checkCheckout: async () => ({ ok: false, reason: 'not on origin' }),
    });
    expect(out).toMatchObject({ status: 'released', unfetchable: true });
    expect(calls.posts).toHaveLength(0);
  });

  test('a probe that dirties the checkout makes the next probe refuse it (inconclusive, not run)', async () => {
    const profile = profileWith([{ name: 'dirty', command: 'echo x > stray.txt' }, { name: 'ok', command: 'true' }]);
    const { api, calls } = fakeApi();
    await hostClaimedScoutRun({ claimed: claimFor(profile, [probe('p-dirty', 'dirty'), probe('p-ok', 'ok')]), repoPath: repo, api, tmpRoot: tmpRoot(), log: () => {} });
    expect(calls.posts.map((p) => p[0].result.verdict)).toEqual(['pass', 'inconclusive']);
  });

  test('fixture setup failure makes every probe inconclusive: fixture_setup_failed, never fail', async () => {
    const profile = profileWith([{ name: 'boom', command: 'exit 9' }, { name: 'ok', command: 'true' }], 'exit 7');
    const { api, calls } = fakeApi();
    const out = await hostClaimedScoutRun({ claimed: claimFor(profile, [probe('a', 'boom'), probe('b', 'ok')]), repoPath: repo, api, tmpRoot: tmpRoot(), log: () => {} });
    expect(out).toMatchObject({ status: 'reported', fixtureFailed: true });
    expect(calls.posts.map((p) => [p[0].result.verdict, p[0].result.reason])).toEqual([
      ['inconclusive', SCOUT_FIXTURE_FAILED],
      ['inconclusive', SCOUT_FIXTURE_FAILED],
    ]);
  });

  test('a fixture that succeeds runs once, in the scrubbed env, before the probes', async () => {
    const profile = profileWith([{ name: 'seen', command: 'test -f "$HOME/fixture-ran"' }], `${ENV_CHECK}; touch "$HOME/fixture-ran"`);
    const { api, calls } = fakeApi();
    const out = await hostClaimedScoutRun({ claimed: claimFor(profile, [probe('s', 'seen')]), repoPath: repo, api, sourceEnv: { ...process.env, ...HOST_SECRETS }, tmpRoot: tmpRoot(), log: () => {} });
    expect(out).toMatchObject({ status: 'reported', fixtureFailed: false });
    expect(calls.posts[0][0].result.verdict).toBe('pass');
  });

  test('the worktree and temp dir are removed when posting throws', async () => {
    const profile = profileWith([{ name: 'ok', command: 'true' }]);
    const { api } = fakeApi();
    api.postResults = async () => { throw new Error('server down'); };
    const tr = tmpRoot();
    const before = await worktrees();
    await expect(hostClaimedScoutRun({ claimed: claimFor(profile, [probe('p', 'ok')]), repoPath: repo, api, tmpRoot: tr, log: () => {} })).rejects.toThrow('server down');
    expect(await worktrees()).toBe(before);
    expect(readdirSync(tr)).toEqual([]);
  });

  test('the worktree is removed after a normal run too', async () => {
    const profile = profileWith([{ name: 'ok', command: 'true' }]);
    const { api } = fakeApi();
    const tr = tmpRoot();
    const before = await worktrees();
    await hostClaimedScoutRun({ claimed: claimFor(profile, [probe('p', 'ok')]), repoPath: repo, api, tmpRoot: tr, log: () => {} });
    expect(await worktrees()).toBe(before);
    expect(readdirSync(tr)).toEqual([]);
  });
});
