/**
 * Runner-hosted Quality Scout surface probes (design `quality-scout-runner-host`
 * §8, slice 2): a claim that carries a run-scoped capture token lets the
 * runner capture through `visual-qa.yml`, against a real throwaway git repo
 * and real probe subprocesses, with GitHub replaced by a fake fetch.
 *
 *  - the capture token never reaches a probe's environment;
 *  - shots from a workflow run on another commit are never returned;
 *  - no grant (or no capture probe) means no capture port: `unsupported`;
 *  - at most `budget.maxCaptureProbes` captures per run;
 *  - the token is revoked when the run ends, released runs included;
 *  - the poller offers `ports.capture` unless BUILDD_SCOUT_CAPTURE=0.
 *
 * No runner process is started; the server is a fake object.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ScoutCaptureGrant, ScoutHostedProbeResult, ScoutRunClaimRequest, ScoutRunClaimResponse } from '@buildd/shared';
import { computeReadiness } from '@buildd/core/workspace-readiness';
import { discoverScoutCapabilities } from '@buildd/core/scout-capabilities';
import { exec } from '@buildd/core/quality-scout/local-host';
import { hostClaimedScoutRun, type ScoutClaimed, type ScoutHostApi } from '@buildd/core/quality-scout/runner-host';
import type { ScoutProbeRecord } from '@buildd/core/quality-scout/types';
import { resolveScoutCapture, ScoutHostPoller, scoutHostAdvert } from '../../src/scout-host';

const TOKEN = 'ghs_runscopedcapturetoken0123456789';
const GH_REPO = 'acme/tool';

let root: string;
let repo: string;
let headSha: string;

async function sh(cmd: string, cwd = repo) {
  const r = await exec('bash', ['-c', cmd], { cwd });
  if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'scout-capture-test-'));
  repo = join(root, 'repo');
  await sh(`mkdir -p ${repo}`, root);
  await sh('git init -q -b main && git config user.email t@example.invalid && git config user.name t && git config commit.gpgsign false');
  writeFileSync(join(repo, 'README.md'), 'tool\n');
  await sh('git add -A && git commit -qm c0');
  headSha = await sh('git rev-parse HEAD');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// The probe fails (exit 3) when the capture token is anywhere in its environment.
const TOKEN_CHECK = `if env | grep -qF '${TOKEN}'; then echo leaked; exit 3; fi; if env | grep -qE '^(GITHUB_TOKEN|GH_TOKEN)='; then exit 4; fi`;

const profile = discoverScoutCapabilities({
  readiness: computeReadiness({
    files: ['package.json', 'src/index.ts'],
    manifests: { 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) },
  }),
  extension: {
    uiRoutes: ['/', '/settings'],
    journeys: [{ name: 'env', kind: 'cli', command: TOKEN_CHECK, mutates: false, expect: 'exit 0' }],
  },
});

const base = {
  family: 'contract', title: 't', invariant: 'i', sourceSignals: [], preconditions: [], estimatedCost: 'low', risk: 'medium',
  mutates: false, evidenceRequirements: [], unsupportedReason: null, host: 'runner', result: null,
  selection: { status: 'selected', via: 'decision', reasonCode: 'test', decisionSource: null },
} as const;

const commandProbe = (id: string): ScoutProbeRecord => ({ ...base, candidateId: id, probeKind: 'cli-journey', executor: 'cli-journey:env' } as unknown as ScoutProbeRecord);
const surfaceProbe = (id: string): ScoutProbeRecord => ({
  ...base, candidateId: id, family: 'surface', probeKind: 'visual', executor: 'ui-surface', risk: 'high',
} as unknown as ScoutProbeRecord);

function claimed(probes: ScoutProbeRecord[], over: Partial<ScoutClaimed> = {}, budget: Record<string, unknown> = {}): ScoutClaimed {
  const far = new Date(Date.now() + 3_600_000).toISOString();
  return {
    run: {
      id: 'run-22222222', workspaceId: 'ws-1', missionId: null, trigger: 'manual', mode: 'shadow', status: 'awaiting_host',
      candidate: { ref: 'main', sha: headSha }, prior: null, budget: { maxProbes: 4, maxCostUsd: null, ...budget },
      policyVersion: 'v', startedAt: new Date().toISOString(), completedAt: null, error: null,
    },
    probes: probes as never,
    profile: profile as never,
    lease: { leaseId: 'lease-1', expiresAt: far, runnerMaxDurationMs: 600_000, hostDeadline: far },
    repo: GH_REPO,
    ...over,
  };
}

const grant = (over: Partial<ScoutCaptureGrant> = {}): ScoutCaptureGrant => ({
  token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), repository: GH_REPO, pageSource: 'sandbox', ...over,
});

function fakeApi() {
  const calls = { claims: [] as ScoutRunClaimRequest[], releases: [] as string[], posts: [] as ScoutHostedProbeResult[][] };
  const api: ScoutHostApi = {
    claim: async (req) => { calls.claims.push(req); return { run: null, reason: 'none' }; },
    postResults: async (_id, _lease, results) => {
      calls.posts.push(results);
      return { ok: true, body: { accepted: results.map((r) => r.candidateId), remaining: 0, finalized: false } };
    },
    release: async (_id, _lease, reason) => { calls.releases.push(reason); return true; },
  };
  return { api, calls };
}

/** A stored (uncompressed) zip with one file. */
function zipOf(name: string, text: string): Uint8Array {
  const enc = new TextEncoder();
  const n = enc.encode(name);
  const d = enc.encode(text);
  const local = new Uint8Array(30 + n.length + d.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint32(18, d.length, true);
  lv.setUint32(22, d.length, true);
  lv.setUint16(26, n.length, true);
  local.set(n, 30);
  local.set(d, 30 + n.length);
  const central = new Uint8Array(46 + n.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint32(20, d.length, true);
  cv.setUint32(24, d.length, true);
  cv.setUint16(28, n.length, true);
  cv.setUint32(42, 0, true);
  central.set(n, 46);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);
  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out;
}

/** GitHub's Actions API for one repo, as the capture port and the revoke call use it. */
function fakeGitHub(opts: { headSha?: () => string } = {}) {
  const seen = { auth: new Set<string>(), dispatches: [] as Array<Record<string, string>>, revoked: 0, paths: [] as string[] };
  const runs: Array<{ id: number; inputs: Record<string, string>; created_at: string; head_sha: string }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization ?? '';
    seen.auth.add(auth);
    seen.paths.push(`${init.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/installation/token' && init.method === 'DELETE') { seen.revoked++; return new Response(null, { status: 204 }); }
    const prefix = `/repos/${GH_REPO}/actions`;
    if (!url.pathname.startsWith(prefix)) return json({ message: 'Not Found' }, 404);
    const rest = url.pathname.slice(prefix.length);
    if (rest === '/workflows/visual-qa.yml/dispatches') {
      const body = JSON.parse(String(init.body));
      seen.dispatches.push(body.inputs);
      runs.push({ id: 500 + runs.length, inputs: body.inputs, created_at: new Date().toISOString(), head_sha: opts.headSha?.() ?? headSha });
      return new Response(null, { status: 204 });
    }
    const toRaw = (r: (typeof runs)[number]) => ({ id: r.id, status: 'completed', conclusion: 'success', head_sha: r.head_sha, head_branch: 'main', created_at: r.created_at });
    if (rest === '/workflows/visual-qa.yml/runs') return json({ workflow_runs: runs.slice().reverse().map(toRaw) });
    let m = rest.match(/^\/runs\/(\d+)$/);
    if (m) return json(toRaw(runs.find((r) => r.id === Number(m![1]))!));
    m = rest.match(/^\/runs\/(\d+)\/artifacts$/);
    if (m) return json({ artifacts: [{ id: Number(m[1]) * 10, name: 'qa-screenshots', expired: false }] });
    m = rest.match(/^\/artifacts\/(\d+)\/zip$/);
    if (m) {
      const r = runs.find((x) => x.id * 10 === Number(m![1]))!;
      const records = r.inputs.routes.split(',').map((path) => ({ path, url: `http://localhost:3000${path}`, status: 200, pageErrors: 0, screenshotFile: `${path.replace(/\W/g, '_')}.png` }));
      return new Response(zipOf('captures.json', JSON.stringify(records)), { status: 200 });
    }
    return json({ message: 'Not Found' }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const quick = { pollMs: 1, sleep: async () => {}, timeoutMs: 5_000 };

describe('hostClaimedScoutRun with a capture grant', () => {
  test('the capture token never reaches a probe env, and a surface probe captures through visual-qa.yml with it', async () => {
    const gh = fakeGitHub();
    const { api, calls } = fakeApi();
    const out = await hostClaimedScoutRun({
      claimed: claimed([commandProbe('cmd'), surfaceProbe('ui')], { capture: grant() }),
      repoPath: repo, api, tmpRoot: mkdtempSync(join(root, 'tmp-')), log: () => {},
      sourceEnv: { ...process.env, GITHUB_TOKEN: 'ghp_hostsecretsecret' },
      capture: { ...quick, fetchImpl: gh.fetchImpl },
    });
    expect(out.status).toBe('reported');
    const byId = Object.fromEntries(calls.posts.map((p) => [p[0].candidateId, p[0].result]));
    // The command probe ran in the scrubbed env: the token and the host's GitHub vars were absent.
    expect(byId.cmd.verdict).toBe('pass');
    expect(byId.ui.verdict).toBe('pass');
    // One dispatch per viewport, capture only, with the run-scoped token and nothing else.
    expect(gh.seen.dispatches.map((d) => d.viewport)).toEqual(['mobile', 'desktop']);
    expect(gh.seen.dispatches.every((d) => d.judge === 'false')).toBe(true);
    expect([...gh.seen.auth]).toEqual([`Bearer ${TOKEN}`]);
    // Revoked once the run ended.
    expect(gh.seen.revoked).toBe(1);
    // Nothing the runner posted carries the token.
    expect(JSON.stringify(calls.posts)).not.toContain(TOKEN);
  });

  test('shots from a workflow run on another commit are never returned: inconclusive, not pass', async () => {
    const gh = fakeGitHub({ headSha: () => 'd'.repeat(40) });
    const { api, calls } = fakeApi();
    let t = Date.now();
    await hostClaimedScoutRun({
      claimed: claimed([surfaceProbe('ui')], { capture: grant() }),
      repoPath: repo, api, tmpRoot: mkdtempSync(join(root, 'tmp-')), log: () => {},
      now: () => new Date(t),
      capture: { pollMs: 1_000, timeoutMs: 10_000, sleep: async (ms) => { t += ms; }, fetchImpl: gh.fetchImpl },
    });
    const r = calls.posts[0][0].result;
    expect(r.verdict).toBe('inconclusive');
    expect(gh.seen.paths.some((p) => p.includes('/artifacts'))).toBe(false);
    expect(gh.seen.revoked).toBe(1);
  });

  test('no grant: the surface probe has no capture port and is unsupported; nothing calls GitHub', async () => {
    const gh = fakeGitHub();
    const { api, calls } = fakeApi();
    await hostClaimedScoutRun({
      claimed: claimed([surfaceProbe('ui')], { captureUnavailable: 'permissions_unavailable' }),
      repoPath: repo, api, tmpRoot: mkdtempSync(join(root, 'tmp-')), log: () => {},
      capture: { ...quick, fetchImpl: gh.fetchImpl },
    });
    expect(calls.posts[0][0].result.verdict).toBe('unsupported');
    expect(gh.seen.paths).toEqual([]);
  });

  test('at most budget.maxCaptureProbes captures per run (default 1): the next surface probe is not captured', async () => {
    const gh = fakeGitHub();
    const { api, calls } = fakeApi();
    await hostClaimedScoutRun({
      claimed: claimed([surfaceProbe('ui-1'), surfaceProbe('ui-2')], { capture: grant() }),
      repoPath: repo, api, tmpRoot: mkdtempSync(join(root, 'tmp-')), log: () => {},
      capture: { ...quick, fetchImpl: gh.fetchImpl },
    });
    expect(calls.posts.map((p) => p[0].result.verdict)).toEqual(['pass', 'inconclusive']);
    expect(gh.seen.dispatches).toHaveLength(2); // one probe, two viewports
  });

  test('a grant past its expiry is never used', async () => {
    const gh = fakeGitHub();
    const { api, calls } = fakeApi();
    await hostClaimedScoutRun({
      claimed: claimed([surfaceProbe('ui')], { capture: grant({ expiresAt: new Date(Date.now() - 1_000).toISOString() }) }),
      repoPath: repo, api, tmpRoot: mkdtempSync(join(root, 'tmp-')), log: () => {},
      capture: { ...quick, fetchImpl: gh.fetchImpl },
    });
    expect(calls.posts[0][0].result.verdict).toBe('inconclusive');
    expect(gh.seen.dispatches).toHaveLength(0);
  });

  test('a run released before it starts still revokes the token', async () => {
    const gh = fakeGitHub();
    const { api, calls } = fakeApi();
    const c = claimed([surfaceProbe('ui')], { capture: grant() });
    c.run.candidate = { ref: 'main', sha: 'main' };
    const out = await hostClaimedScoutRun({ claimed: c, repoPath: repo, api, tmpRoot: mkdtempSync(join(root, 'tmp-')), log: () => {}, capture: { ...quick, fetchImpl: gh.fetchImpl } });
    expect(out.status).toBe('released');
    expect(calls.releases).toHaveLength(1);
    expect(gh.seen.revoked).toBe(1);
    expect(gh.seen.dispatches).toHaveLength(0);
  });
});

describe('capture advert and claim', () => {
  test('BUILDD_SCOUT_CAPTURE=0 opts out; anything else offers capture', () => {
    expect(resolveScoutCapture({})).toBe(true);
    expect(resolveScoutCapture({ BUILDD_SCOUT_CAPTURE: '0' })).toBe(false);
  });

  test('the advert says capture only when asked to', () => {
    expect(scoutHostAdvert({ mode: 'bwrap' }, [GH_REPO], true)).toEqual({ repos: [GH_REPO], command: true, capture: true });
    expect(scoutHostAdvert({ mode: null, reason: 'no_sandbox' }, [GH_REPO], true)).toBeUndefined();
  });

  test('a capture-capable poller offers ports.capture on its claim', async () => {
    const calls: ScoutRunClaimRequest[] = [];
    const none: ScoutRunClaimResponse = { run: null, reason: 'none' };
    const p = new ScoutHostPoller({
      api: { claim: async (r) => { calls.push(r); return none; }, postResults: async () => ({ ok: false, status: 500, code: null }), release: async () => false },
      scanRepos: () => [{ path: '/repos/tool', normalizedUrl: GH_REPO }] as never,
      sandbox: () => ({ mode: 'bwrap' }),
      isBusy: () => false,
      capture: () => true,
      log: () => {},
    });
    expect(await p.poll()).toBe('idle');
    expect(calls[0].ports).toEqual({ command: true, capture: true, browser: false });
    expect(p.advert()).toEqual({ repos: [GH_REPO], command: true, capture: true });
  });
});
