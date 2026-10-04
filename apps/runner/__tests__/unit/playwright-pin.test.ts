import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getPlaywrightPin,
  installedPinnedBuilds,
  isPinnedBuildPath,
  pinnedBuildDirNames,
  setPlaywrightPinForTests,
} from '../../src/playwright-pin';

const runnerDir = join(import.meta.dir, '..', '..');
const declared = JSON.parse(readFileSync(join(runnerDir, 'package.json'), 'utf8')).devDependencies.playwright;

afterEach(() => setPlaywrightPinForTests());

describe('getPlaywrightPin', () => {
  it('resolves the installed playwright to the version apps/runner pins, with its Chromium build', () => {
    setPlaywrightPinForTests();
    const pin = getPlaywrightPin(join(runnerDir, 'src'));
    expect(pin?.version).toBe(declared);
    expect(pin?.chromiumRevision).toMatch(/^\d+$/);
  });

  it('honours a test override, including "unresolvable"', () => {
    setPlaywrightPinForTests(null);
    expect(getPlaywrightPin(join(runnerDir, 'src'))).toBeUndefined();
  });
});

describe('pinned build paths', () => {
  const pin = { version: '1.61.1', chromiumRevision: '1228', headlessShellRevision: '1228' };

  it('names the headless shell first, then full Chromium', () => {
    expect(pinnedBuildDirNames(pin)).toEqual(['chromium_headless_shell-1228', 'chromium-1228']);
    expect(pinnedBuildDirNames({ version: 'x', chromiumRevision: '9' })).toEqual(['chromium-9']);
  });

  it('matches a binary inside a pinned build dir and nothing else', () => {
    expect(isPinnedBuildPath('/c/ms-playwright/chromium-1228/chrome-linux64/chrome', pin)).toBe(true);
    expect(isPinnedBuildPath('/c/ms-playwright/chromium-12280/chrome-linux64/chrome', pin)).toBe(false);
    expect(isPinnedBuildPath('/c/ms-playwright/chromium_headless_shell-1243/x/headless_shell', pin)).toBe(false);
  });

  it('lists only the pinned build dirs that exist', () => {
    const present = new Set(['/b/chromium-1228']);
    expect(installedPinnedBuilds(['/a', '/b'], pin, p => present.has(p))).toEqual(['/b/chromium-1228']);
  });
});
