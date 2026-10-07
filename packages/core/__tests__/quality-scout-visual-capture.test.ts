import { describe, expect, it } from 'bun:test';
import { deflateRawSync } from 'zlib';
import { computeReadiness } from '../workspace-readiness';
import { discoverScoutCapabilities } from '../scout-capabilities';
import { SCOUT_EVIDENCE_REQUIREMENTS } from '../quality-scout/candidates';
import { scoutProbeRecord, startScoutRun } from '../quality-scout/ledger';
import { runScoutProbe } from '../quality-scout/executors';
import {
  captureRecordsToShots,
  createVisualQaCapturePort,
  limitScoutCapturePort,
  readZipEntry,
  resolveScoutCapturePort,
  revokeInstallationToken,
  tokenVisualQaActions,
  type ScoutCaptureCredential,
  type VisualQaActions,
  type VisualQaCaptureRecord,
  type VisualQaRun,
} from '../quality-scout/visual-capture';

const SHA = 'c'.repeat(40);
const REPO = 'acme/web';
const T0 = Date.parse('2026-10-05T10:00:00Z');

// ─── A minimal zip writer, so the reader is tested against real archive bytes ─

function zip(files: Record<string, string>, deflate = true): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(text);
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) { out.set(part, p); p += part.length; }
  return out;
}

describe('readZipEntry', () => {
  it('reads a deflated and a stored entry by path or path suffix', () => {
    const z = zip({ 'screenshots/root.png': 'png', 'captures.json': '[{"a":1}]' });
    expect(new TextDecoder().decode(readZipEntry(z, 'captures.json')!)).toBe('[{"a":1}]');
    const stored = zip({ 'qa/captures.json': '[]' }, false);
    expect(new TextDecoder().decode(readZipEntry(stored, 'captures.json')!)).toBe('[]');
  });

  it('is null for a missing entry and throws on something that is not a zip', () => {
    expect(readZipEntry(zip({ 'a.txt': 'x' }), 'captures.json')).toBeNull();
    expect(() => readZipEntry(new TextEncoder().encode('not a zip at all, definitely not'), 'x')).toThrow('not a zip');
  });
});

// ─── captures.json → shots ───────────────────────────────────────────────────

const rec = (path: string, over: Partial<VisualQaCaptureRecord> = {}): VisualQaCaptureRecord => ({
  path,
  url: `http://localhost:3000${path}`,
  finalUrl: `http://localhost:3000${path}`,
  status: 200,
  pageErrors: 0,
  screenshotFile: `${path === '/' ? 'root' : path.slice(1)}.png`,
  ...over,
});

describe('captureRecordsToShots', () => {
  const ctx = { routes: ['/', '/settings'], viewport: 'phone' as const, ref: 'feature', runId: 42, repoFullName: REPO };

  it('maps base shots of requested routes, with the run artifact as evidence', () => {
    const shots = captureRecordsToShots([rec('/'), rec('/settings'), rec('/other')], ctx);
    expect(shots.map((s) => s.route)).toEqual(['/', '/settings']);
    expect(shots[0]).toMatchObject({
      viewport: 'phone',
      status: 200,
      pageErrors: 0,
      ref: 'feature',
      evidenceRef: `gh-actions:${REPO}/runs/42/qa-screenshots/screenshots/root.png`,
    });
  });

  it('drops plan state shots and skipped routes; never invents a status', () => {
    const shots = captureRecordsToShots([
      rec('/', { state: 'menu-open' }),
      rec('/', { skipped: true }),
      rec('/settings', { status: undefined }),
      rec('/', { error: 'net::ERR_CONNECTION_REFUSED', screenshotFile: undefined }),
    ], ctx);
    expect(shots).toHaveLength(2);
    expect(shots.every((s) => s.status === null)).toBe(true);
    expect(shots.find((s) => s.route === '/')!.evidenceRef).toBeNull();
  });

  it('carries the capture\'s own auth-wall verdict', () => {
    const [s] = captureRecordsToShots([rec('/', { configError: 'app_auth_not_configured', screenshotFile: undefined })], ctx);
    expect(s.configError).toBe('app_auth_not_configured');
  });

  it('a malformed file yields no shots', () => {
    expect(captureRecordsToShots({ not: 'an array' }, ctx)).toEqual([]);
  });
});

// ─── The port against a fake Actions API ─────────────────────────────────────

interface FakeOpts {
  exists?: boolean;
  headSha?: string;
  records?: (viewport: string, routes: string[]) => VisualQaCaptureRecord[] | null;
  /** Polls before a dispatched run shows up / completes. */
  appearAfter?: number;
  completeAfter?: number;
}

function fakeActions(opts: FakeOpts = {}) {
  let clock = T0;
  const dispatches: Array<{ ref: string; inputs: Record<string, string> }> = [];
  const runs: Array<VisualQaRun & { polls: number; inputs: Record<string, string>; listed: number }> = [];
  // A stale run on the same ref, from before any dispatch: must never be picked up.
  runs.push({ id: 1, status: 'completed', conclusion: 'success', headSha: SHA, headBranch: 'feature', createdAt: new Date(T0 - 3_600_000).toISOString(), polls: 0, inputs: {}, listed: 99 });
  const actions: VisualQaActions = {
    repoFullName: REPO,
    async workflowExists() { return opts.exists ?? true; },
    async dispatch(ref, inputs) {
      dispatches.push({ ref, inputs });
      runs.push({ id: 100 + dispatches.length, status: 'queued', conclusion: null, headSha: opts.headSha ?? SHA, headBranch: ref, createdAt: new Date(clock).toISOString(), polls: 0, inputs, listed: 0 });
    },
    async listDispatchRuns() {
      for (const r of runs) r.listed++;
      return runs.filter((r) => r.listed > (opts.appearAfter ?? 0)).slice().reverse();
    },
    async getRun(id) {
      const r = runs.find((x) => x.id === id)!;
      r.polls++;
      if (r.polls >= (opts.completeAfter ?? 1)) { r.status = 'completed'; r.conclusion = 'success'; }
      return { ...r };
    },
    async readArtifactFile(runId, name, path) {
      expect(name).toBe('qa-screenshots');
      expect(path).toBe('captures.json');
      const r = runs.find((x) => x.id === runId)!;
      const records = (opts.records ?? ((_, routes) => routes.map((p) => rec(p))))(r.inputs.viewport, r.inputs.routes.split(','));
      return records === null ? null : JSON.stringify(records);
    },
  };
  const portOpts = { sleep: async (ms: number) => { clock += ms; }, now: () => clock, pollMs: 10_000, timeoutMs: 60_000 };
  return { actions, dispatches, portOpts };
}

const req = { routes: ['/', '/settings'], viewports: ['phone', 'desktop'] as Array<'phone' | 'desktop'>, ref: 'feature', sha: SHA, pageSource: 'sandbox' };

describe('createVisualQaCapturePort', () => {
  it('dispatches the Visual QA workflow once per viewport, capture only, and reads its captures back', async () => {
    const f = fakeActions({ appearAfter: 1, completeAfter: 2 });
    const shots = await createVisualQaCapturePort(f.actions, f.portOpts).capture(req);
    expect(f.dispatches).toEqual([
      { ref: 'feature', inputs: { routes: '/,/settings', viewport: 'mobile', judge: 'false' } },
      { ref: 'feature', inputs: { routes: '/,/settings', viewport: 'desktop', judge: 'false' } },
    ]);
    expect(shots.map((s) => `${s.route}@${s.viewport}`)).toEqual(['/@phone', '/settings@phone', '/@desktop', '/settings@desktop']);
    // Never the stale pre-dispatch run.
    expect(shots.every((s) => !s.evidenceRef!.includes('/runs/1/'))).toBe(true);
  });

  it('a run on another commit (the branch moved) is never read: the capture throws', async () => {
    const f = fakeActions({ headSha: 'd'.repeat(40) });
    await expect(createVisualQaCapturePort(f.actions, f.portOpts).capture(req)).rejects.toThrow('appeared');
  });

  it('a run that never finishes times out instead of returning partial shots', async () => {
    const f = fakeActions({ completeAfter: 1_000 });
    await expect(createVisualQaCapturePort(f.actions, f.portOpts).capture(req)).rejects.toThrow('did not finish');
  });

  it('a preview page source is not this port\'s to capture', async () => {
    const f = fakeActions();
    await expect(createVisualQaCapturePort(f.actions, f.portOpts).capture({ ...req, pageSource: 'vercel-preview' })).rejects.toThrow('browser runner');
    expect(f.dispatches).toHaveLength(0);
  });
});

// ─── End to end through the Scout executor ───────────────────────────────────

const uiProfile = discoverScoutCapabilities({
  readiness: computeReadiness({
    files: ['package.json', 'pnpm-lock.yaml', 'src/index.ts'],
    manifests: { 'package.json': JSON.stringify({ scripts: { test: 'vitest run', dev: 'vite' } }) },
  }),
  extension: { uiRoutes: ['/', '/settings'] },
});

function scoutRun() {
  const r = startScoutRun({ id: 'run-x', workspaceId: 'ws-x', trigger: 'manual', mode: 'shadow', candidate: { ref: 'feature', sha: SHA }, now: new Date(T0) });
  if (!r.ok) throw new Error(r.reason);
  return r.run;
}

const visualProbe = () => scoutProbeRecord(
  {
    id: 'cand-v',
    family: 'surface',
    probeKind: 'visual',
    title: 'Settings renders',
    invariant: 'Changed routes render without error at phone and desktop width.',
    sourceSignals: [{ type: 'change', ref: 'src' }],
    preconditions: ['ui-surface'],
    executor: 'ui-surface',
    estimatedCost: 'medium',
    severity: 'high',
    evidenceRequirements: [...SCOUT_EVIDENCE_REQUIREMENTS.visual],
  },
  { status: 'selected', via: 'decision', reasonCode: 'changed_surface', decisionSource: 'model' },
);

describe('runScoutProbe with the Visual QA capture port', () => {
  it('passes on real capture records, with every screenshot as evidence', async () => {
    const f = fakeActions();
    const resolved = await resolveScoutCapturePort({ gitConfig: {}, actions: f.actions, port: f.portOpts });
    expect(resolved.port).not.toBeNull();
    const exec = await runScoutProbe(scoutRun(), visualProbe(), uiProfile, { capture: resolved.port! }, { now: () => new Date(T0) });
    expect(exec.probe.result!.verdict).toBe('pass');
    expect(exec.probe.result!.evidenceRefs).toHaveLength(4);
    expect(exec.reproduction).toMatchObject({ adapter: 'surface', ref: 'feature', sha: SHA });
  });

  it('a 500 recorded by capture fails the probe', async () => {
    const f = fakeActions({ records: (vp, routes) => routes.map((p) => rec(p, p === '/settings' && vp === 'desktop' ? { status: 500 } : {})) });
    const exec = await runScoutProbe(scoutRun(), visualProbe(), uiProfile, { capture: createVisualQaCapturePort(f.actions, f.portOpts) }, { now: () => new Date(T0) });
    expect(exec.probe.result!.verdict).toBe('fail');
    expect(exec.probe.result!.observed).toContain('/settings (desktop) 500');
  });

  it('a capture script that records no status is inconclusive, not a pass', async () => {
    const f = fakeActions({ records: (_, routes) => routes.map((p) => rec(p, { status: undefined })) });
    const exec = await runScoutProbe(scoutRun(), visualProbe(), uiProfile, { capture: createVisualQaCapturePort(f.actions, f.portOpts) }, { now: () => new Date(T0) });
    expect(exec.probe.result!.verdict).toBe('inconclusive');
  });

  it('no artifact (expired or never uploaded) is inconclusive', async () => {
    const f = fakeActions({ records: () => null });
    const exec = await runScoutProbe(scoutRun(), visualProbe(), uiProfile, { capture: createVisualQaCapturePort(f.actions, f.portOpts) }, { now: () => new Date(T0) });
    expect(exec.probe.result!.verdict).toBe('inconclusive');
  });

  it('a repo without the workflow (any non-Buildd repo) gets no port, so the probe is unsupported', async () => {
    const f = fakeActions({ exists: false });
    const resolved = await resolveScoutCapturePort({ gitConfig: null, actions: f.actions });
    expect(resolved).toMatchObject({ port: null, reason: 'no_visual_qa_workflow' });
    const exec = await runScoutProbe(scoutRun(), visualProbe(), uiProfile, {}, { now: () => new Date(T0) });
    expect(exec.probe.result!.verdict).toBe('unsupported');
    expect(f.dispatches).toHaveLength(0);
  });

  it('a Vercel-preview workspace gets no port from this host', async () => {
    const f = fakeActions();
    const resolved = await resolveScoutCapturePort({ gitConfig: { visualQa: { pageSource: 'vercel-preview' } }, actions: f.actions });
    expect(resolved).toMatchObject({ port: null, reason: 'page_source_not_sandbox' });
  });
});

// ─── Runner side: run-scoped token, deadline, cap, revoke ────────────────────

describe('tokenVisualQaActions', () => {
  const cred = (over: Partial<ScoutCaptureCredential> = {}): ScoutCaptureCredential => ({
    token: 'ghs_runtoken', expiresAt: new Date(T0 + 60_000).toISOString(), repository: REPO, ...over,
  });
  function recordingFetch(status = 200, body: unknown = { workflow_runs: [] }) {
    const calls: Array<{ url: string; method: string; auth: string | undefined }> = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', auth: (init.headers as Record<string, string>)?.Authorization });
      return new Response(status === 204 ? null : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  it('calls only the one repository\'s Actions API, with the run-scoped token', async () => {
    const { f, calls } = recordingFetch();
    const a = tokenVisualQaActions({ repoFullName: REPO, credential: () => cred(), fetchImpl: f, now: () => T0 });
    await a.listDispatchRuns('feature');
    expect(calls).toEqual([{ url: `https://api.github.com/repos/${REPO}/actions/workflows/visual-qa.yml/runs?event=workflow_dispatch&branch=feature&per_page=10`, method: 'GET', auth: 'Bearer ghs_runtoken' }]);
  });

  it('refuses to call once the credential is dropped, expired, or for another repository', async () => {
    const { f, calls } = recordingFetch();
    let c: ScoutCaptureCredential | null = cred();
    const a = tokenVisualQaActions({ repoFullName: REPO, credential: () => c, fetchImpl: f, now: () => T0 });
    c = null;
    await expect(a.listDispatchRuns('x')).rejects.toThrow('no capture credential');
    c = cred({ expiresAt: new Date(T0).toISOString() });
    await expect(a.listDispatchRuns('x')).rejects.toThrow('expired');
    c = cred({ repository: 'acme/other' });
    await expect(a.listDispatchRuns('x')).rejects.toThrow('no capture credential');
    expect(calls).toEqual([]);
    expect(() => tokenVisualQaActions({ repoFullName: '../evil', credential: () => cred() })).toThrow('owner/name');
  });

  it('a missing workflow reads as absent, not as an error', async () => {
    const { f } = recordingFetch(404, { message: 'Not Found' });
    expect(await tokenVisualQaActions({ repoFullName: REPO, credential: () => cred(), fetchImpl: f, now: () => T0 }).workflowExists()).toBe(false);
  });

  it('revokeInstallationToken deletes the token and never throws', async () => {
    const { f, calls } = recordingFetch(204);
    expect(await revokeInstallationToken('ghs_runtoken', f)).toBe(true);
    expect(calls).toEqual([{ url: 'https://api.github.com/installation/token', method: 'DELETE', auth: 'Bearer ghs_runtoken' }]);
    const boom = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await revokeInstallationToken('x', boom)).toBe(false);
  });
});

describe('capture port bounds', () => {
  it('a run deadline cuts a capture short even inside the per-viewport timeout', async () => {
    const f = fakeActions({ completeAfter: 1_000 });
    const port = createVisualQaCapturePort(f.actions, { ...f.portOpts, timeoutMs: 600_000, deadlineMs: T0 + 30_000 });
    await expect(port.capture(req)).rejects.toThrow('did not finish');
  });

  it('nothing is dispatched once the deadline has passed', async () => {
    const f = fakeActions();
    await expect(createVisualQaCapturePort(f.actions, { ...f.portOpts, deadlineMs: T0 - 1 }).capture(req)).rejects.toThrow('deadline');
    expect(f.dispatches).toHaveLength(0);
  });

  it('limitScoutCapturePort allows max captures, then throws', async () => {
    const f = fakeActions();
    const port = limitScoutCapturePort(createVisualQaCapturePort(f.actions, f.portOpts), 1);
    await port.capture(req);
    await expect(port.capture(req)).rejects.toThrow('capture cap');
    expect(f.dispatches).toHaveLength(2);
  });
});
