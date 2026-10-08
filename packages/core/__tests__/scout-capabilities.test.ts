import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeReadiness, type ReadinessInput, type ReadinessItemId } from '../workspace-readiness';
import {
  discoverScoutCapabilities,
  resolveScoutExtension,
  scoutCapabilityStatus,
  IGNORED_READINESS_ITEMS,
  PROJECTED_READINESS_ITEMS,
  type ScoutCapability,
  type ScoutCapabilityProfile,
} from '../scout-capabilities';

const cap = (p: ScoutCapabilityProfile, id: string): ScoutCapability => {
  const found = p.capabilities.find((c) => c.id === id);
  if (!found) throw new Error(`no capability ${id}; have ${p.capabilities.map((c) => c.id).join(', ')}`);
  return found;
};

// ─── Fixture repos (no buildd paths, no web framework) ───────────────────────

/** A Python CLI with no UI at all. */
const pythonCli: ReadinessInput = {
  files: ['pyproject.toml', 'uv.lock', 'README.md', 'src/tool/__init__.py', 'src/tool/cli.py', 'tests/test_cli.py'],
  manifests: {
    'pyproject.toml': '[project]\nname = "tool"\n[project.scripts]\ntool = "tool.cli:main"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
  },
};

/** A Go HTTP service: serves an API, no browser UI, a Makefile with `run`. */
const goService: ReadinessInput = {
  files: ['go.mod', 'go.sum', 'main.go', 'Makefile', 'README.md'],
  manifests: { 'go.mod': 'module example.com/svc\n', Makefile: 'test:\n\tgo test ./...\nrun:\n\tgo run .\n' },
};

/** A node web app with a dev script and no deployments. */
const nodeApp: ReadinessInput = {
  files: ['package.json', 'pnpm-lock.yaml', 'src/index.ts'],
  manifests: { 'package.json': JSON.stringify({ scripts: { test: 'vitest run', dev: 'vite' } }) },
};

const truncatedEmpty: ReadinessInput = { files: ['README.md'], truncated: true, manifests: {} };
const noRepo: ReadinessInput = { files: null };

describe('discoverScoutCapabilities — projection of readiness', () => {
  it('a no-UI CLI repo still exposes its verification command and declared CLI journeys', () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness(pythonCli),
      extension: { journeys: [{ name: 'help', kind: 'cli', command: 'uv run tool --help', mutates: false }] },
    });

    const verify = cap(profile, 'verification-command');
    expect(verify.status).toBe('available');
    expect(verify.source).toBe('readiness');
    expect(verify.readinessItemId).toBe('test-command');
    expect(verify.value).toContain('pytest');
    expect(verify.usable).toBe(true);

    expect(cap(profile, 'ui-surface').status).toBe('absent');
    expect(profile.hasUi).toBe('no');

    const journey = cap(profile, 'cli-journey:help');
    expect(journey.status).toBe('available');
    expect(journey.source).toBe('declared');
    expect(journey.usable).toBe(true);
    expect(journey.journey).toEqual({ name: 'help', kind: 'cli', command: 'uv run tool --help', mutates: false });
  });

  it('a Go API service with no declared journeys exposes command capabilities and its bootable app', () => {
    const profile = discoverScoutCapabilities({ readiness: computeReadiness(goService) });
    expect(cap(profile, 'verification-command').value).toBe('go test ./...');
    // Readiness says it can boot in the sandbox (`make run`); scout reports what readiness found.
    expect(cap(profile, 'ui-surface').status).toBe('available');
    expect(profile.capabilities.some((c) => c.kind === 'cli-journey' || c.kind === 'api-journey')).toBe(false);
  });

  it('a truncated tree reports unknown, never absent', () => {
    const profile = discoverScoutCapabilities({ readiness: computeReadiness(truncatedEmpty) });
    expect(profile.truncated).toBe(true);
    for (const c of profile.capabilities.filter((c) => c.source === 'readiness')) {
      expect(c.status).toBe('unknown');
      expect(c.usable).toBe(false);
    }
    expect(profile.hasUi).toBe('unknown');
  });

  it('no linked repo: every readiness capability is unknown, declarations still apply', () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness(noRepo),
      extension: { verificationCommand: 'make check' },
    });
    expect(cap(profile, 'ui-surface').status).toBe('unknown');
    expect(cap(profile, 'migrations').status).toBe('unknown');
    const verify = cap(profile, 'verification-command');
    expect(verify.status).toBe('available');
    expect(verify.source).toBe('declared');
    expect(verify.value).toBe('make check');
  });

  it('an unreadable manifest keeps the command capability unknown', () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness({ files: ['package.json', 'src/index.ts'], manifests: {} }),
    });
    expect(cap(profile, 'verification-command').status).toBe('unknown');
  });

  it('a waived readiness item is absent, with the owner reason as evidence', () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness({
        ...goService,
        gitConfig: { onboarding: { waived: { 'build-command': { reason: 'interpreted only', at: '2026-01-01' } } } },
      }),
    });
    const build = cap(profile, 'build-command');
    expect(build.status).toBe('absent');
    expect(build.evidence.join(' ')).toContain('interpreted only');
  });

  it('a declared verification command wins over the detected one; readiness evidence is kept', () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness(nodeApp),
      extension: { verificationCommand: 'pnpm test:safe' },
    });
    const verify = cap(profile, 'verification-command');
    expect(verify.value).toBe('pnpm test:safe');
    expect(verify.source).toBe('declared');
    expect(verify.evidence.some((e) => e.includes('Overrides the detected `pnpm run test`'))).toBe(true);
    expect(verify.readinessItemId).toBe('test-command');
  });

  it('UI routes attach to the UI surface the readiness report found', () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness(nodeApp),
      extension: { uiRoutes: ['/', '/items/:id'] },
    });
    const ui = cap(profile, 'ui-surface');
    expect(ui.status).toBe('available');
    expect(ui.value).toBe('sandbox');
    expect(ui.routes).toEqual(['/', '/items/:id']);
    expect(profile.hasUi).toBe('yes');
  });

  it('declared UI routes with no detected page source stay unknown, not available', () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness(pythonCli),
      extension: { uiRoutes: ['/dashboard'] },
    });
    const ui = cap(profile, 'ui-surface');
    expect(ui.status).toBe('unknown');
    expect(ui.routes).toEqual(['/dashboard']);
    expect(ui.usable).toBe(false);
  });

  it('every readiness item is either projected or deliberately ignored', () => {
    const report = computeReadiness(nodeApp);
    const covered = new Set<ReadinessItemId>([...PROJECTED_READINESS_ITEMS, ...IGNORED_READINESS_ITEMS]);
    for (const item of report.items) expect(covered.has(item.id)).toBe(true);
  });

  it('does not mutate the readiness report', () => {
    const report = computeReadiness(nodeApp);
    const before = JSON.stringify(report);
    discoverScoutCapabilities({ readiness: report, extension: { verificationCommand: 'x', uiRoutes: ['/'] } });
    expect(JSON.stringify(report)).toBe(before);
  });

  it('is deterministic', () => {
    const input = { readiness: computeReadiness(goService), extension: { journeys: [{ name: 'a', kind: 'cli', command: 'svc --version' }] } };
    expect(discoverScoutCapabilities(input)).toEqual(discoverScoutCapabilities(input));
  });
});

describe('discoverScoutCapabilities — safety', () => {
  const readiness = computeReadiness(goService);

  it('a CLI journey with undeclared effects is treated as mutating and is not usable without an ephemeral env', () => {
    const profile = discoverScoutCapabilities({
      readiness,
      extension: { journeys: [{ name: 'sync', kind: 'cli', command: 'svc sync' }] },
    });
    const j = cap(profile, 'cli-journey:sync');
    expect(j.status).toBe('available');
    expect(j.mutates).toBe(true);
    expect(j.usable).toBe(false);
    expect(j.blockedReason).toContain('ephemeral');
  });

  it('a read-only API journey runs against the declared test environment', () => {
    const profile = discoverScoutCapabilities({
      readiness,
      extension: {
        testEnvironment: { baseUrl: 'https://qa.example.test', ephemeral: false },
        journeys: [{ name: 'health', kind: 'api', path: '/healthz' }],
      },
    });
    const j = cap(profile, 'api-journey:health');
    expect(j.journey).toEqual({ name: 'health', kind: 'api', method: 'GET', path: '/healthz', mutates: false });
    expect(j.usable).toBe(true);
    expect(j.target).toBe('test-environment');
  });

  it('a read-only API journey with no test environment targets the sandbox app boot when readiness found one', () => {
    const profile = discoverScoutCapabilities({
      readiness,
      extension: { journeys: [{ name: 'health', kind: 'api', path: '/healthz' }] },
    });
    expect(cap(profile, 'api-journey:health').target).toBe('app-boot');
    expect(cap(profile, 'api-journey:health').usable).toBe(true);
  });

  it('an API journey with nothing to call is available but not usable', () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness(pythonCli),
      extension: { journeys: [{ name: 'health', kind: 'api', path: '/healthz' }] },
    });
    const j = cap(profile, 'api-journey:health');
    expect(j.usable).toBe(false);
    expect(j.blockedReason).toBeTruthy();
  });

  it('a mutating API journey is usable only against an ephemeral test environment', () => {
    const journeys = [{ name: 'create', kind: 'api', method: 'POST', path: '/items' }];
    const persistent = discoverScoutCapabilities({
      readiness,
      extension: { testEnvironment: { baseUrl: 'https://qa.example.test' }, journeys },
    });
    expect(cap(persistent, 'api-journey:create').mutates).toBe(true);
    expect(cap(persistent, 'api-journey:create').usable).toBe(false);

    const ephemeral = discoverScoutCapabilities({
      readiness,
      extension: { testEnvironment: { baseUrl: 'https://qa.example.test', ephemeral: true }, journeys },
    });
    expect(cap(ephemeral, 'api-journey:create').usable).toBe(true);
  });

  it('allowWrites "never" blocks every mutating capability even in an ephemeral env', () => {
    const profile = discoverScoutCapabilities({
      readiness,
      extension: {
        testEnvironment: { baseUrl: 'https://qa.example.test', ephemeral: true },
        fixtureSetup: { command: 'make seed' },
        journeys: [{ name: 'create', kind: 'api', method: 'POST', path: '/items' }],
        constraints: { allowWrites: 'never' },
      },
    });
    expect(cap(profile, 'fixture-setup').usable).toBe(false);
    expect(cap(profile, 'api-journey:create').usable).toBe(false);
    expect(profile.constraints.allowWrites).toBe('never');
  });

  it('fixture setup is a mutating capability, usable with an ephemeral env', () => {
    const profile = discoverScoutCapabilities({
      readiness,
      extension: { testEnvironment: { ephemeral: true }, fixtureSetup: { command: 'make seed' } },
    });
    const f = cap(profile, 'fixture-setup');
    expect(f.mutates).toBe(true);
    expect(f.usable).toBe(true);
    expect(cap(profile, 'test-environment').status).toBe('available');
  });

  it('a forbidden pattern blocks any command that contains it, detected or declared', () => {
    const profile = discoverScoutCapabilities({
      readiness,
      extension: {
        constraints: { forbiddenPatterns: ['go test', 'rm -rf'] },
        journeys: [{ name: 'clean', kind: 'cli', command: 'rm -rf build', mutates: false }],
      },
    });
    expect(cap(profile, 'verification-command').usable).toBe(false);
    expect(cap(profile, 'verification-command').blockedReason).toContain('go test');
    expect(cap(profile, 'cli-journey:clean').usable).toBe(false);
  });

  it('scoutCapabilityStatus answers absent for an undeclared declaration-only kind', () => {
    const profile = discoverScoutCapabilities({ readiness });
    expect(scoutCapabilityStatus(profile, 'cli-journey')).toBe('absent');
    expect(scoutCapabilityStatus(profile, 'verification-command')).toBe('available');
    const unknown = discoverScoutCapabilities({ readiness: computeReadiness(truncatedEmpty) });
    expect(scoutCapabilityStatus(unknown, 'migrations')).toBe('unknown');
  });
});

describe('resolveScoutExtension', () => {
  it('absent or non-object config resolves to nothing, without warnings', () => {
    expect(resolveScoutExtension(undefined)).toEqual({ config: { journeys: [], uiRoutes: [], constraints: { allowWrites: 'ephemeral-only', forbiddenPatterns: [] } }, warnings: [] });
    expect(resolveScoutExtension(null).warnings).toEqual([]);
    expect(resolveScoutExtension('nope').warnings.length).toBe(1);
  });

  it('drops malformed entries with a warning instead of throwing', () => {
    const { config, warnings } = resolveScoutExtension({
      verificationCommand: '   ',
      testEnvironment: { baseUrl: 'ftp://x' },
      uiRoutes: ['/ok', 'no-slash', 7],
      journeys: [
        { name: 'ok', kind: 'cli', command: 'tool --help' },
        { name: 'ok', kind: 'cli', command: 'dup' },
        { name: 'abs', kind: 'api', path: 'https://prod.example.com/api' },
        { name: 'nocmd', kind: 'cli' },
        { name: 'weird', kind: 'grpc', command: 'x' },
        { name: 'badmethod', kind: 'api', method: 'FETCH', path: '/x' },
        'string',
      ],
      fixtureSetup: { command: '' },
      constraints: { allowWrites: 'always', forbiddenPatterns: ['ok', 3, ''] },
    });
    expect(config.verificationCommand).toBeUndefined();
    expect(config.testEnvironment?.baseUrl).toBeUndefined();
    expect(config.uiRoutes).toEqual(['/ok']);
    expect(config.journeys.map((j) => j.name)).toEqual(['ok']);
    expect(config.fixtureSetup).toBeUndefined();
    expect(config.constraints).toEqual({ allowWrites: 'ephemeral-only', forbiddenPatterns: ['ok'] });
    expect(warnings.length).toBeGreaterThanOrEqual(9);
  });

  it('surfaces resolution warnings on the profile', () => {
    const profile = discoverScoutCapabilities({
      readiness: computeReadiness(goService),
      extension: { journeys: [{ name: 'abs', kind: 'api', path: 'https://prod.example.com' }] },
    });
    expect(profile.warnings.some((w) => w.includes('abs'))).toBe(true);
  });
});

describe('generic: no stack assumptions in the scout capability module', () => {
  it('names no framework, host, ORM, database vendor or runtime', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'scout-capabilities.ts'), 'utf8');
    expect(src).not.toMatch(/vercel|drizzle|neon|next\.?js|\bbun\b|docs\/|\/api\/workspaces/i);
  });
});
