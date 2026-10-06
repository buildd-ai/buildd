import { describe, expect, it } from 'bun:test';
import { computeReadiness, type ReadinessInput } from '../workspace-readiness';
import { discoverScoutCapabilities, type ScoutCapabilityProfile } from '../scout-capabilities';
import { generateScoutCandidates, SCOUT_EVIDENCE_REQUIREMENTS, type ScoutProbeCandidate } from '../quality-scout/candidates';
import { recordScoutFailure, scoutProbeRecord, startScoutRun, type ScoutCandidateLike, type ScoutFindingStore } from '../quality-scout/ledger';
import {
  parseCommandExpectation,
  parseHttpExpectation,
  planScoutProbe,
  runScoutProbe,
  scoutEvidenceCoverage,
  unsafeCommandRule,
  type ScoutCaptureShot,
  type ScoutCommandOutput,
  type ScoutCommandRequest,
  type ScoutHttpRequest,
  type ScoutProbePorts,
} from '../quality-scout/executors';
import type { ScoutFinding, ScoutProbeRecord, ScoutRun } from '../quality-scout/types';

const SHA = 'c'.repeat(40);
const T0 = new Date('2026-10-05T10:00:00Z');
const now = () => T0;

function scoutRun(ref = 'main'): ScoutRun {
  const r = startScoutRun({ id: 'run-x', workspaceId: 'ws-x', trigger: 'manual', mode: 'shadow', candidate: { ref, sha: SHA }, now: T0 });
  if (!r.ok) throw new Error(r.reason);
  return r.run;
}

const SELECTED = { status: 'selected', via: 'decision', reasonCode: 'changed_surface', decisionSource: 'model' } as const;

function probeFor(executor: string | null, over: Partial<ScoutCandidateLike> = {}): ScoutProbeRecord {
  return scoutProbeRecord(
    {
      id: 'cand-x',
      family: 'contract',
      probeKind: 'api_contract',
      title: 'Contract holds',
      invariant: 'The declared journey succeeds with its documented outcome.',
      sourceSignals: [{ type: 'change', ref: 'src' }],
      preconditions: ['cli-journey'],
      executor,
      estimatedCost: 'low',
      severity: 'high',
      evidenceRequirements: [...SCOUT_EVIDENCE_REQUIREMENTS.api_contract],
      ...over,
    },
    SELECTED,
  );
}

// ─── Fixture workspaces ──────────────────────────────────────────────────────

/** A Python CLI: no UI, no web framework, nothing Buildd-shaped. */
const pythonCli: ReadinessInput = {
  files: ['pyproject.toml', 'uv.lock', 'README.md', 'src/tool/__init__.py', 'src/tool/cli.py', 'tests/test_cli.py'],
  manifests: { 'pyproject.toml': '[project]\nname = "tool"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' },
};
const cliProfile: ScoutCapabilityProfile = discoverScoutCapabilities({
  readiness: computeReadiness(pythonCli),
  extension: {
    journeys: [
      { name: 'help', kind: 'cli', command: 'uv run tool --help', mutates: false, expect: 'exit 0 and stdout contains Usage' },
      { name: 'bad-flag', kind: 'cli', command: 'uv run tool --nope', mutates: false, expect: 'exits non-zero' },
      { name: 'vague', kind: 'cli', command: 'uv run tool report', mutates: false, expect: 'looks right' },
      { name: 'ship', kind: 'cli', command: 'git push origin HEAD', mutates: false },
      { name: 'seed', kind: 'cli', command: 'uv run tool seed' },
    ],
  },
});

/** A Go HTTP API against a persistent (non-ephemeral) QA environment. */
const goService: ReadinessInput = {
  files: ['go.mod', 'go.sum', 'main.go', 'Makefile', 'README.md'],
  manifests: { 'go.mod': 'module example.com/svc\n', Makefile: 'test:\n\tgo test ./...\nrun:\n\tgo run .\n' },
};
const apiProfile = discoverScoutCapabilities({
  readiness: computeReadiness(goService),
  extension: {
    testEnvironment: { baseUrl: 'https://qa.example.test', ephemeral: false },
    journeys: [
      { name: 'invoices', kind: 'api', method: 'GET', path: '/invoices', expect: 'status 200 and body contains "items"' },
      { name: 'create', kind: 'api', method: 'POST', path: '/invoices' },
    ],
  },
});

/** A node web app with declared UI routes rendered in the sandbox. */
const nodeApp: ReadinessInput = {
  files: ['package.json', 'pnpm-lock.yaml', 'src/index.ts'],
  manifests: { 'package.json': JSON.stringify({ scripts: { test: 'vitest run', dev: 'vite' } }) },
};
const uiProfile = discoverScoutCapabilities({ readiness: computeReadiness(nodeApp), extension: { uiRoutes: ['/', '/items/:id', '/settings'] } });

// ─── Fake read-only ports ────────────────────────────────────────────────────

function commandPort(out: Partial<ScoutCommandOutput> | ((req: ScoutCommandRequest, n: number) => Partial<ScoutCommandOutput>)) {
  const calls: ScoutCommandRequest[] = [];
  return {
    calls,
    port: {
      async run(req: ScoutCommandRequest): Promise<ScoutCommandOutput> {
        calls.push(req);
        const o = typeof out === 'function' ? out(req, calls.length) : out;
        return { exitCode: 0, timedOut: false, evidenceRef: `log:${calls.length}`, ...o };
      },
    },
  };
}

describe('expectations are parsed, never guessed', () => {
  it('reads exit-code and output clauses', () => {
    expect(parseCommandExpectation(undefined)).toEqual({ exit: 0 });
    expect(parseCommandExpectation('exits non-zero')).toEqual({ exit: 'nonzero' });
    expect(parseCommandExpectation('exit 2; stdout contains "bad flag"')).toEqual({ exit: 2, outputIncludes: 'bad flag' });
    expect(parseCommandExpectation('looks right')).toBeNull();
  });

  it('reads status and body clauses', () => {
    expect(parseHttpExpectation(undefined)).toEqual({ status: '2xx' });
    expect(parseHttpExpectation('404')).toEqual({ status: 404 });
    expect(parseHttpExpectation('status 2xx and body contains ok')).toEqual({ status: '2xx', bodyIncludes: 'ok' });
    expect(parseHttpExpectation('fast')).toBeNull();
  });
});

describe('unsafe commands are never run', () => {
  it.each([
    ['git push origin main', 'git_write'],
    ['gh pr merge 12 --squash', 'forge_write'],
    ['npm publish', 'publish'],
    ['bun run deploy', 'deploy'],
    ['bun db:push', 'schema_write'],
    ['npx prisma migrate deploy', 'schema_write'],
    ['eslint . --fix', 'auto_fix'],
    ['prettier --write src', 'auto_fix'],
    ['jest --updateSnapshot', 'auto_fix'],
    ['curl -X DELETE https://api/x', 'http_write'],
  ])('%s → %s', (cmd, rule) => {
    expect(unsafeCommandRule(cmd)).toBe(rule);
  });

  it.each(['go test ./...', 'uv run pytest', 'bun run test', 'pytest tests/test_deploy.py', 'cargo test', 'make check'])('%s is allowed', (cmd) => {
    expect(unsafeCommandRule(cmd)).toBeNull();
  });
});

describe('evidence mapping', () => {
  it('a command can supply api_contract evidence but never a screenshot', () => {
    const keys = [...SCOUT_EVIDENCE_REQUIREMENTS.api_contract, ...SCOUT_EVIDENCE_REQUIREMENTS.visual, 'owner-specific-key'];
    const cov = scoutEvidenceCoverage(keys, 'command', 'complete');
    expect(cov[SCOUT_EVIDENCE_REQUIREMENTS.api_contract[0]]).toBe('complete');
    expect(cov[SCOUT_EVIDENCE_REQUIREMENTS.visual[0]]).toBe('absent');
    expect(cov['owner-specific-key']).toBe('absent');
    expect(scoutEvidenceCoverage(['command-output'], 'command', 'partial')).toEqual({ 'command-output': 'partial' });
  });
});

describe('command / CLI-contract probes — no-UI, non-Buildd repo', () => {
  it('the profile has no UI; its verification command and declared journey run in a throwaway checkout of the candidate', async () => {
    expect(cliProfile.hasUi).toBe('no');
    const { port, calls } = commandPort({ exitCode: 0, stdoutTail: 'Usage: tool [OPTIONS]' });
    const exec = await runScoutProbe(scoutRun(), probeFor('cli-journey:help'), cliProfile, { command: port }, { now });
    expect(calls).toEqual([{ command: 'uv run tool --help', timeoutMs: expect.any(Number), ref: 'main', sha: SHA }]);
    expect(exec.probe.result!.verdict).toBe('pass');
    expect(exec.probe.result!.evidenceRefs).toEqual([{ kind: 'command-output', ref: 'log:1' }]);
    expect(exec.probe.result!.subject).toEqual({ kind: 'candidate-sha', ref: SHA });
    expect(exec.probe.result!.provenance.executor).toBe('scout-command');
    expect(exec.reproduction).toEqual({ adapter: 'command', ref: 'main', sha: SHA, capabilityId: 'cli-journey:help', command: 'uv run tool --help' });
  });

  it('the readiness-detected verification command runs too', async () => {
    const { port, calls } = commandPort({ exitCode: 0 });
    const exec = await runScoutProbe(scoutRun(), probeFor('verification-command'), cliProfile, { command: port }, { now });
    expect(calls[0].command).toContain('pytest');
    expect(exec.probe.result!.verdict).toBe('pass');
  });

  it('a broken contract fails with a stable signature and the stderr tail', async () => {
    const { port } = commandPort({ exitCode: 0, stdoutTail: 'ok' });
    const exec = await runScoutProbe(scoutRun(), probeFor('cli-journey:bad-flag'), cliProfile, { command: port }, { now });
    const r = exec.probe.result!;
    expect(r.verdict).toBe('fail');
    expect(r.severity).toBe('high');
    expect(r.observed).toContain('exit 0 (expected non-zero)');

    const again = await runScoutProbe(scoutRun(), probeFor('cli-journey:bad-flag'), cliProfile, { command: commandPort({ exitCode: 0 }).port }, { now });
    expect(again.probe.result!.signature).toBe(r.signature);
  });

  it('a timeout or missing exit code is inconclusive, never pass or fail', async () => {
    for (const out of [{ timedOut: true, exitCode: null }, { exitCode: null }]) {
      const exec = await runScoutProbe(scoutRun(), probeFor('cli-journey:help'), cliProfile, { command: commandPort(out).port }, { now });
      expect(exec.probe.result!.verdict).toBe('inconclusive');
    }
  });

  it('output that was not stored is partial evidence → inconclusive', async () => {
    const exec = await runScoutProbe(scoutRun(), probeFor('cli-journey:help'), cliProfile, {
      command: commandPort({ exitCode: 0, stdoutTail: 'Usage', evidenceRef: null }).port,
    }, { now });
    expect(exec.probe.result!.verdict).toBe('inconclusive');
    expect(exec.probe.result!.reason).toMatch(/^evidence_insufficient/);
  });

  it('a port that throws is inconclusive and never leaks the error', async () => {
    const exec = await runScoutProbe(scoutRun(), probeFor('cli-journey:help'), cliProfile, {
      command: { run: async () => { throw new Error('token=SECRET'); } },
    }, { now });
    expect(exec.probe.result!.verdict).toBe('inconclusive');
    expect(JSON.stringify(exec)).not.toContain('SECRET');
  });

  it('a host with no command port is unsupported, and nothing runs', async () => {
    const exec = await runScoutProbe(scoutRun(), probeFor('cli-journey:help'), cliProfile, {}, { now });
    expect(exec.probe.result!.verdict).toBe('unsupported');
    expect(exec.probe.result!.reason).toBe('missing_capability:host:command');
  });

  it('an expectation it cannot check mechanically is unsupported, not approximated by exit 0', async () => {
    const { port, calls } = commandPort({ exitCode: 0 });
    const exec = await runScoutProbe(scoutRun(), probeFor('cli-journey:vague'), cliProfile, { command: port }, { now });
    expect(calls).toHaveLength(0);
    expect(exec.plan).toMatchObject({ status: 'refused', disposition: 'unsupported', code: 'unparseable_expectation' });
    expect(exec.probe.result!.verdict).toBe('unsupported');
  });

  it('a command that pushes is needs-human and never reaches the port', async () => {
    const { port, calls } = commandPort({ exitCode: 0 });
    const exec = await runScoutProbe(scoutRun(), probeFor('cli-journey:ship'), cliProfile, { command: port }, { now });
    expect(calls).toHaveLength(0);
    expect(exec.needsHuman).toBe(true);
    expect(exec.plan).toMatchObject({ status: 'refused', disposition: 'needs-human', code: 'unsafe_command:git_write' });
    expect(exec.probe.result!.verdict).toBe('unsupported');
    expect(exec.probe.result!.reason).toContain('needs-human:unsafe_command:git_write');
  });

  it('a mutating journey with no ephemeral environment is needs-human (blocked by the profile)', async () => {
    const plan = planScoutProbe(probeFor('cli-journey:seed'), cliProfile);
    expect(plan).toMatchObject({ status: 'refused', disposition: 'needs-human', code: 'capability_blocked' });
  });

  it('even with an ephemeral environment, a write needs an explicit opt-in', () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness(pythonCli),
      extension: { testEnvironment: { ephemeral: true }, journeys: [{ name: 'seed', kind: 'cli', command: 'uv run tool seed' }] },
    });
    expect(planScoutProbe(probeFor('cli-journey:seed'), profile)).toMatchObject({ code: 'mutating_probe_requires_opt_in', disposition: 'needs-human' });
    expect(planScoutProbe(probeFor('cli-journey:seed'), profile, { allowEphemeralWrites: true }).status).toBe('runnable');
  });

  it('repeats a failure to tell deterministic from intermittent', async () => {
    const steady = await runScoutProbe(scoutRun(), probeFor('cli-journey:help'), cliProfile, { command: commandPort({ exitCode: 3 }).port }, { now, attempts: 3 });
    expect(steady.probe.result!.verdict).toBe('fail');
    expect(steady.attempts).toBe(3);
    expect(steady.reproducibility).toBe('deterministic');

    const flaky = await runScoutProbe(scoutRun(), probeFor('cli-journey:help'), cliProfile, {
      command: commandPort((_, n) => (n === 1 ? { exitCode: 1 } : { exitCode: 0, stdoutTail: 'Usage' })).port,
    }, { now, attempts: 2 });
    expect(flaky.probe.result!.verdict).toBe('fail');
    expect(flaky.reproducibility).toBe('intermittent');

    const once = await runScoutProbe(scoutRun(), probeFor('cli-journey:help'), cliProfile, { command: commandPort({ exitCode: 3 }).port }, { now });
    expect(once.reproducibility).toBe('unknown');
  });

  it('redacts output before it is judged or recorded', async () => {
    const exec = await runScoutProbe(scoutRun(), probeFor('cli-journey:help'), cliProfile, {
      command: commandPort({ exitCode: 1, stderrTail: 'auth failed for sk-live-123' }).port,
    }, { now, redact: (s) => s.replace(/sk-live-\w+/g, '[REDACTED]') });
    expect(exec.probe.result!.observed).toContain('[REDACTED]');
    expect(exec.probe.result!.observed).not.toContain('sk-live-123');
  });
});

describe('API / state-contract probes', () => {
  function httpPort(res: { status: number | null; bodyExcerpt?: string; finalUrl?: string; evidenceRef?: string | null }) {
    const calls: ScoutHttpRequest[] = [];
    return { calls, port: { request: async (req: ScoutHttpRequest) => (calls.push(req), { evidenceRef: 'http:1', ...res }) } };
  }

  it('sends the declared read-only request to the declared environment only', async () => {
    const { port, calls } = httpPort({ status: 200, bodyExcerpt: '{"items":[]}' });
    const probe = probeFor('api-journey:invoices');
    const exec = await runScoutProbe(scoutRun(), probe, apiProfile, { http: port }, { now });
    expect(calls).toEqual([{ method: 'GET', url: 'https://qa.example.test/invoices', timeoutMs: expect.any(Number) }]);
    expect(exec.probe.result!.verdict).toBe('pass');
    expect(exec.probe.result!.evidenceRefs).toEqual([{ kind: 'http-exchange', ref: 'http:1' }]);
  });

  it('a wrong status fails with the status in the signature', async () => {
    const a = await runScoutProbe(scoutRun(), probeFor('api-journey:invoices'), apiProfile, { http: httpPort({ status: 500 }).port }, { now });
    const b = await runScoutProbe(scoutRun(), probeFor('api-journey:invoices'), apiProfile, { http: httpPort({ status: 404 }).port }, { now });
    expect(a.probe.result!.verdict).toBe('fail');
    expect(b.probe.result!.verdict).toBe('fail');
    expect(a.probe.result!.signature).not.toBe(b.probe.result!.signature);
  });

  it('a sign-in redirect is an auth wall: unsupported + needs-human, never a defect', async () => {
    const exec = await runScoutProbe(scoutRun(), probeFor('api-journey:invoices'), apiProfile, {
      http: httpPort({ status: 200, finalUrl: 'https://qa.example.test/login' }).port,
    }, { now });
    expect(exec.probe.result!.verdict).toBe('unsupported');
    expect(exec.needsHuman).toBe(true);
  });

  it('a write against a persistent environment never leaves the plan', async () => {
    const { port, calls } = httpPort({ status: 201 });
    const exec = await runScoutProbe(scoutRun(), probeFor('api-journey:create'), apiProfile, { http: port }, { now, allowEphemeralWrites: true });
    expect(calls).toHaveLength(0);
    expect(exec.plan).toMatchObject({ status: 'refused', disposition: 'needs-human' });
    expect(exec.probe.result!.verdict).toBe('unsupported');
  });

  it('an app-boot journey without a booted app is unsupported, not sent anywhere', async () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness(goService),
      extension: { journeys: [{ name: 'health', kind: 'api', method: 'GET', path: '/health' }] },
    });
    const { port, calls } = httpPort({ status: 200 });
    const exec = await runScoutProbe(scoutRun(), probeFor('api-journey:health'), profile, { http: port }, { now });
    expect(calls).toHaveLength(0);
    expect(exec.probe.result!.verdict).toBe('inconclusive');
    const booted = await runScoutProbe(scoutRun(), probeFor('api-journey:health'), profile, {
      http: { ...port, appBaseUrl: 'http://127.0.0.1:8080' },
    }, { now });
    expect(calls[0].url).toBe('http://127.0.0.1:8080/health');
    expect(booted.probe.result!.verdict).toBe('pass');
  });
});

describe('UI / surface probes — reuse the Visual Auditor capture', () => {
  const shot = (route: string, viewport: 'phone' | 'desktop', over: Partial<ScoutCaptureShot> = {}): ScoutCaptureShot => ({
    route,
    viewport,
    requestedUrl: `http://127.0.0.1:3000${route}`,
    finalUrl: `http://127.0.0.1:3000${route}`,
    status: 200,
    ref: 'main',
    refSource: 'trunk',
    evidenceRef: `shot:${route}:${viewport}`,
    ...over,
  });
  const visualProbe = () =>
    probeFor('ui-surface', { family: 'surface', probeKind: 'visual', evidenceRequirements: [...SCOUT_EVIDENCE_REQUIREMENTS.visual] });
  const capturePort = (fn: (routes: string[]) => ScoutCaptureShot[]) => ({ capture: async (req: { routes: string[] }) => fn(req.routes) });

  it('captures concrete routes only (no invented :id values) at phone and desktop', async () => {
    const plan = planScoutProbe(visualProbe(), uiProfile);
    expect(plan).toMatchObject({ status: 'runnable', action: { adapter: 'surface', routes: ['/', '/settings'], viewports: ['phone', 'desktop'] } });
    const exec = await runScoutProbe(scoutRun(), visualProbe(), uiProfile, {
      capture: capturePort((routes) => routes.flatMap((r) => [shot(r, 'phone'), shot(r, 'desktop')])),
    }, { now });
    expect(exec.probe.result!.verdict).toBe('pass');
    expect(exec.probe.result!.evidenceRefs).toHaveLength(4);
    expect(exec.probe.result!.observed).toContain('layout not judged');
  });

  it('a 500 or a page error fails', async () => {
    const exec = await runScoutProbe(scoutRun(), visualProbe(), uiProfile, {
      capture: capturePort(() => [shot('/', 'phone'), shot('/', 'desktop'), shot('/settings', 'phone', { status: 500 }), shot('/settings', 'desktop', { pageErrors: 2 })]),
    }, { now });
    expect(exec.probe.result!.verdict).toBe('fail');
    expect(exec.probe.result!.observed).toContain('/settings');
  });

  it('a shot from a different ref does not count: missing captures are inconclusive', async () => {
    const exec = await runScoutProbe(scoutRun(), visualProbe(), uiProfile, {
      capture: capturePort((routes) => routes.flatMap((r) => [shot(r, 'phone', { ref: 'dev' }), shot(r, 'desktop')])),
    }, { now });
    expect(exec.probe.result!.verdict).toBe('inconclusive');
  });

  it('a preview auth wall is the owner\'s config: unsupported + needs-human', async () => {
    const exec = await runScoutProbe(scoutRun(), visualProbe(), uiProfile, {
      capture: capturePort((routes) => routes.flatMap((r) => [shot(r, 'phone', { finalUrl: 'https://vercel.com/login?next=x' }), shot(r, 'desktop')])),
    }, { now });
    expect(exec.probe.result!.verdict).toBe('unsupported');
    expect(exec.needsHuman).toBe(true);
  });

  it('a wall the capture itself classified is honoured even when the fields alone look fine', async () => {
    const exec = await runScoutProbe(scoutRun(), visualProbe(), uiProfile, {
      capture: capturePort((routes) => routes.flatMap((r) => [shot(r, 'phone', { status: 401, configError: 'protection_bypass_missing' }), shot(r, 'desktop')])),
    }, { now });
    expect(exec.probe.result!.verdict).toBe('unsupported');
    expect(exec.probe.result!.observed).toContain('protection bypass missing');
    expect(exec.needsHuman).toBe(true);
  });

  it('a no-UI workspace never reaches capture', async () => {
    const plan = planScoutProbe(probeFor('ui-surface', { family: 'surface', probeKind: 'visual' }), cliProfile);
    expect(plan).toMatchObject({ status: 'refused', disposition: 'unsupported', code: 'capability_unavailable' });
  });
});

describe('spec and readiness probes — reuse spec comparison and readiness state', () => {
  const specProfile = discoverScoutCapabilities({
    readiness: computeReadiness({
      files: ['package.json', 'docs/specs/billing.md', 'src/index.ts'],
      manifests: { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) },
    }),
  });
  const specProbe = () =>
    probeFor('spec', { probeKind: 'spec_invariant', sourceSignals: [{ type: 'spec', ref: 'disc-1' }], evidenceRequirements: [...SCOUT_EVIDENCE_REQUIREMENTS.spec_invariant] });

  it('a failing spec assertion fails deterministically; all-suppressed is inconclusive', async () => {
    if (!specProfile.capabilities.find((c) => c.id === 'spec')?.usable) throw new Error('fixture: spec capability not usable');
    const fail = await runScoutProbe(scoutRun(), specProbe(), specProfile, {
      spec: { evaluate: async () => ({ results: [{ id: 'a1', type: 'symbol', outcome: 'fail', detail: 'missing' }], evidenceRef: 'spec:1' }) },
    }, { now });
    expect(fail.probe.result!.verdict).toBe('fail');
    expect(fail.reproducibility).toBe('deterministic');

    const suppressed = await runScoutProbe(scoutRun(), specProbe(), specProfile, {
      spec: { evaluate: async () => ({ results: [{ id: 'a1', type: 'symbol', outcome: 'suppressed', detail: 'later' }], evidenceRef: 'spec:1' }) },
    }, { now });
    expect(suppressed.probe.result!.verdict).toBe('inconclusive');
  });

  it('a release probe reads the recomputed readiness report at the candidate', async () => {
    const releaseProfile = discoverScoutCapabilities({
      readiness: computeReadiness({
        files: ['go.mod', 'main.go', 'Makefile'],
        manifests: { 'go.mod': 'module x\n', Makefile: 'test:\n\tgo test ./...\nrelease:\n\tgoreleaser\n' },
      }),
    });
    const release = releaseProfile.capabilities.find((c) => c.id === 'release');
    if (!release?.usable) throw new Error(`fixture: release capability not usable (${release?.blockedReason})`);
    const probe = probeFor('release', { family: 'release', probeKind: 'spec_invariant', evidenceRequirements: [...SCOUT_EVIDENCE_REQUIREMENTS.spec_invariant] });
    const report = computeReadiness({ files: ['go.mod', 'main.go', 'Makefile'], manifests: { 'go.mod': 'module x\n', Makefile: 'test:\n\tgo test ./...\n' } });
    const read = (r: typeof report) => ({ readiness: { read: async () => ({ report: r, evidenceRef: 'readiness:1' }) } });

    // Readiness cannot prove a release path absent; neither does the probe.
    const unknown = await runScoutProbe(scoutRun(), probe, releaseProfile, read(report), { now });
    expect(unknown.probe.result!.verdict).toBe('inconclusive');

    const missing = { ...report, items: report.items.map((i) => (i.id === 'release-path' ? { ...i, status: 'missing' as const } : i)) };
    const exec = await runScoutProbe(scoutRun(), probe, releaseProfile, read(missing), { now });
    expect(exec.probe.result!.verdict).toBe('fail');
    expect(exec.probe.result!.observed).toContain('release-path');
    expect(exec.reproducibility).toBe('deterministic');

    const ok = await runScoutProbe(scoutRun(), probe, releaseProfile, read(computeReadiness({
      files: ['go.mod', 'main.go', 'Makefile'],
      manifests: { 'go.mod': 'module x\n', Makefile: 'release:\n\tgoreleaser\n' },
    })), { now });
    expect(ok.probe.result!.verdict).toBe('pass');

    const truncated = { ...report, truncated: true };
    const t = await runScoutProbe(scoutRun(), probe, releaseProfile, { readiness: { read: async () => ({ report: truncated, evidenceRef: 'r' }) } }, { now });
    expect(t.probe.result!.verdict).toBe('inconclusive');
  });

  it('capabilities with no executor yet (migrations) are unsupported, not run as something else', () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness({ files: ['go.mod', 'migrations/0001_init.sql', 'main.go'], manifests: { 'go.mod': 'module x\n' } }),
    });
    const cap = profile.capabilities.find((c) => c.id === 'migrations');
    if (!cap?.usable) throw new Error('fixture: migrations not usable');
    expect(planScoutProbe(probeFor('migrations', { family: 'persistence' }), profile)).toMatchObject({ code: 'no_adapter:migrations', disposition: 'unsupported' });
  });
});

describe('end to end on a generic no-UI workspace: generate → execute → dedupe', () => {
  it('a candidate from the generator executes through the ledger and repeated failure updates one finding', async () => {
    const { candidates } = generateScoutCandidates({ candidateRef: 'main', changedPaths: ['src/tool/cli.py'] }, cliProfile);
    const c = candidates.find((x) => x.family === 'contract') as ScoutProbeCandidate;
    expect(c.supported).toBe(true);
    const probe = scoutProbeRecord(c, SELECTED);

    const rows = new Map<string, ScoutFinding>();
    const store: ScoutFindingStore = {
      find: async (_w, s) => rows.get(s) ?? null,
      insert: async (f) => (rows.has(f.signature) ? false : (rows.set(f.signature, f), true)),
      update: async (f, n) => (rows.get(f.signature)?.occurrenceCount === n ? (rows.set(f.signature, f), true) : false),
    };
    const ports: ScoutProbePorts = { command: commandPort({ exitCode: 2, stderrTail: 'boom' }).port };
    for (const id of ['run-a', 'run-b']) {
      const r = startScoutRun({ id, workspaceId: 'ws-x', trigger: 'manual', mode: 'shadow', candidate: { ref: 'main', sha: SHA }, now: T0 });
      if (!r.ok) throw new Error(r.reason);
      const exec = await runScoutProbe(r.run, probe, cliProfile, ports, { now });
      expect(exec.probe.result!.verdict).toBe('fail');
      expect(exec.probe.invariant).toBe(c.invariant);
      await recordScoutFailure(r.run, exec.probe, { store, now });
    }
    expect(rows.size).toBe(1);
    expect([...rows.values()][0].occurrenceCount).toBe(2);
  });

  it('two hypotheses that run the same command are one finding, not one each', async () => {
    const { candidates } = generateScoutCandidates(
      { candidateRef: 'main', changedPaths: ['src/tool/cli.py', 'src/report/render.py', 'scripts/check.sh'] },
      cliProfile,
    );
    const contract = candidates.filter((x) => x.family === 'contract' && x.supported);
    expect(contract.length).toBeGreaterThan(1);
    expect(new Set(contract.map((x) => x.executor)).size).toBe(1);

    const ports: ScoutProbePorts = { command: commandPort({ exitCode: 2, stderrTail: 'boom' }).port };
    const results = await Promise.all(contract.map((x) => runScoutProbe(scoutRun(), scoutProbeRecord(x, SELECTED), cliProfile, ports, { now })));
    const sigs = new Set(results.map((r) => r.probe.result!.signature));
    expect(results.every((r) => r.probe.result!.verdict === 'fail')).toBe(true);
    expect(sigs.size).toBe(1);
    expect(results[0].probe.result!.checkId).toMatch(/^quality-scout:exec:command_/);
  });

  it('a different command is a different check', async () => {
    const run = scoutRun();
    const help = await runScoutProbe(run, probeFor('cli-journey:help'), cliProfile, { command: commandPort({ exitCode: 1 }).port }, { now });
    const bad = await runScoutProbe(run, probeFor('cli-journey:bad-flag'), cliProfile, { command: commandPort({ exitCode: 0 }).port }, { now });
    expect(help.probe.result!.verdict).toBe('fail');
    expect(bad.probe.result!.verdict).toBe('fail');
    expect(help.probe.result!.checkId).not.toBe(bad.probe.result!.checkId);
  });

  it('an unselected probe is a caller error', async () => {
    const skipped: ScoutProbeRecord = { ...probeFor('verification-command'), selection: { status: 'skipped', reason: 'budget', reasonCode: null } };
    await expect(runScoutProbe(scoutRun(), skipped, cliProfile, {})).rejects.toThrow(/selected/);
  });
});
