/**
 * The startup banner, `buildd top`'s header and `buildd service install` say
 * what each backend's sandbox is on this host, in the shared verdict's words
 * (isolation-check.ts sandboxPosture over isolationVerdict), so no surface can
 * word it differently from doctor, install.sh or Health.
 */
import { describe, expect, test } from 'bun:test';
import type { BackendConfinement, RunnerIsolationRecord } from '@buildd/shared';
import { renderBanner, type BannerInfo } from '../../src/banner';
import { sandboxPosture } from '../../src/isolation-check';
import { sandboxPostureText } from '../../src/service';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { renderFrame } from '../../src/top/render';
import { reduce, sandboxLines } from '../../src/top/state';
import { NOW, fixtureState } from './top-fixture';

const plain = createPalette('night', 'none');
const none = (reason: BackendConfinement['reason']): BackendConfinement => ({ mechanism: 'none', scope: [], reason });
const winToken: BackendConfinement = { mechanism: 'windows_restricted_token', scope: ['write'] };
const bwrap: BackendConfinement = { mechanism: 'bwrap', scope: ['write', 'network'] };

const record = (over: Partial<RunnerIsolationRecord>): RunnerIsolationRecord => ({
  platform: 'linux',
  evidence: [],
  claude: { mechanism: 'bwrap', scope: ['write', 'network', 'env'] },
  codex: { 'read-only': bwrap, 'workspace-write': bwrap },
  probeAt: '2026-10-20T00:00:05.000Z',
  processStartedAt: '2026-10-20T00:00:00.000Z',
  runnerVersion: '0.0.0-test',
  ...over,
});
const WINDOWS = record({ platform: 'windows', claude: none('unsupported_platform'), codex: { 'read-only': winToken, 'workspace-write': winToken } });
const LINUX = record({});

const INFO: BannerInfo = {
  version: '0.0.0', commit: '', debug: false, port: 8766, server: 'https://buildd.dev', apiKey: 'bld_test_1234',
  repos: 1, reposCached: false, roots: 1, serverless: false, localUrl: 'http://localhost:8766',
};

const topText = (rec: RunnerIsolationRecord) => {
  const s = reduce(fixtureState(), { type: 'config', sandbox: sandboxPosture(rec) });
  return renderFrame(s, { cols: 200, rows: 40, now: NOW, palette: plain }).map(l => stripAnsi(l)).join('\n');
};

describe('every surface prints the shared per-backend lines', () => {
  const lines = sandboxPosture(WINDOWS).backends.map(b => b.line);

  test('Windows lines say what Claude and Codex can do here', () => {
    expect(lines[0]).toBe('Claude: no sandbox on Windows — its tasks go to other runners; run the runner in WSL2 to take them');
    expect(lines[1]).toContain("Codex: confined by Codex's Windows sandbox (writes only; network is open)");
  });

  test('startup banner', () => {
    const out = renderBanner({ ...INFO, sandbox: sandboxPosture(WINDOWS).backends }, plain).map(l => stripAnsi(l)).join('\n');
    for (const l of lines) expect(out).toContain(l);
    expect(out).toContain('sandbox');
  });

  test('buildd top header: each line when a backend is less than fully confined', () => {
    const out = topText(WINDOWS);
    for (const l of lines) expect(out).toContain(l);
  });

  test('buildd top header: one summary line when every backend is fully confined', () => {
    const s = reduce(fixtureState(), { type: 'config', sandbox: sandboxPosture(LINUX) });
    expect(sandboxLines(s)).toEqual([{ text: 'Sandbox: bubblewrap confines Claude and Codex on this host', warn: false }]);
    expect(topText(LINUX)).toContain('Sandbox: bubblewrap confines Claude and Codex on this host');
  });

  test('buildd top keeps its posture when a runner that predates it sends none', () => {
    const s = reduce(reduce(fixtureState(), { type: 'config', sandbox: sandboxPosture(WINDOWS) }), { type: 'config', maxConcurrent: 2 });
    expect(sandboxLines(s)).toHaveLength(2);
    expect(sandboxLines(fixtureState())).toEqual([]);
  });

  test('buildd service install', () => {
    const out = sandboxPostureText(sandboxPosture(WINDOWS).backends);
    expect(out.split('\n')[0]).toBe('Sandbox on this host:');
    for (const l of lines) expect(out).toContain(l);
  });
});
