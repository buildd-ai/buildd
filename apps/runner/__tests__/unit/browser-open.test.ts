/**
 * The runner opens its debug page in a browser only on the first interactive
 * start; never after an update restart, a crash restart, a service start or
 * without a terminal (spec c7410e76 R-28, AC-13).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RESTART_MARKER, consumeRestartMarker, shouldAutoOpenBrowser, writeRestartMarker, type BrowserOpenInput } from '../../src/browser-open';

const base: BrowserOpenInput = { preference: true, isTTY: true, env: {}, restartMarkerPresent: false, lastOpenAt: null, now: 1_000_000 };

describe('shouldAutoOpenBrowser', () => {
  test('opens on the first interactive start', () => {
    expect(shouldAutoOpenBrowser(base)).toBe(true);
  });
  test('keeps the preference: off means never', () => {
    expect(shouldAutoOpenBrowser({ ...base, preference: false })).toBe(false);
    expect(shouldAutoOpenBrowser({ ...base, preference: undefined })).toBe(false);
  });
  test('does not open after an update restart', () => {
    expect(shouldAutoOpenBrowser({ ...base, restartMarkerPresent: true })).toBe(false);
    expect(shouldAutoOpenBrowser({ ...base, env: { BUILDD_RESTART: 'update' } })).toBe(false);
  });
  test('does not open without a terminal', () => {
    expect(shouldAutoOpenBrowser({ ...base, isTTY: false })).toBe(false);
  });
  test('does not open when a service manager started it', () => {
    expect(shouldAutoOpenBrowser({ ...base, env: { INVOCATION_ID: 'x' } })).toBe(false);
    expect(shouldAutoOpenBrowser({ ...base, env: { XPC_SERVICE_NAME: 'dev.buildd.runner' } })).toBe(false);
    expect(shouldAutoOpenBrowser({ ...base, env: { XPC_SERVICE_NAME: '0' } })).toBe(true);
  });
  test('still debounces a quick second start', () => {
    expect(shouldAutoOpenBrowser({ ...base, lastOpenAt: base.now - 5_000 })).toBe(false);
    expect(shouldAutoOpenBrowser({ ...base, lastOpenAt: base.now - 120_000 })).toBe(true);
  });
});

describe('restart marker', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  test('an exit-for-restart silences exactly the next start', () => {
    dir = mkdtempSync(join(tmpdir(), 'buildd-restart-'));
    writeRestartMarker(dir, 1000);
    expect(consumeRestartMarker(dir, 2000)).toBe(true);
    expect(existsSync(join(dir, RESTART_MARKER))).toBe(false);
    expect(consumeRestartMarker(dir, 3000)).toBe(false);
  });
  test('a stale marker from a run that never came back is ignored', () => {
    dir = mkdtempSync(join(tmpdir(), 'buildd-restart-'));
    writeRestartMarker(dir, 1000);
    expect(consumeRestartMarker(dir, 1000 + 60 * 60_000)).toBe(false);
  });
  test('no marker means a fresh start', () => {
    dir = mkdtempSync(join(tmpdir(), 'buildd-restart-'));
    expect(consumeRestartMarker(dir, 1)).toBe(false);
  });
});
