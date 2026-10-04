/**
 * The Playwright version this repo pins, and the Chromium build it needs.
 *
 * One Playwright version needs exactly one Chromium build, and
 * `playwright install` run from any other version garbage-collects every build
 * it does not own from the shared browsers directory (~/.cache/ms-playwright or
 * PLAYWRIGHT_BROWSERS_PATH). So every install path on a runner — install.sh,
 * the updater, the runner image in the infrastructure repo — must go through
 * the repo's own pinned package (`bun run browser:install` in apps/runner),
 * never a bare `bunx`/`npx playwright`, which resolves whatever version happens
 * to be cached globally.
 *
 * The pin itself is the exact `playwright` version in apps/runner/package.json;
 * scripts/playwright-pin.test.ts keeps every other declaration and bun.lock
 * equal to it.
 */
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

export interface PlaywrightPin {
  /** Resolved `playwright` package version, e.g. "1.61.1". */
  version: string;
  /** Chromium build that version installs, e.g. "1228". */
  chromiumRevision: string;
  /** Headless-shell build (same as chromium on current Playwright). */
  headlessShellRevision?: string;
}

/** Command that installs the pinned build, run from apps/runner. */
export const BROWSER_INSTALL_COMMAND = 'bun run browser:install';

let cached: PlaywrightPin | null | undefined;

/** Test hook: override (or with no argument, forget) the resolved pin. */
export function setPlaywrightPinForTests(pin?: PlaywrightPin | null): void {
  cached = pin;
}

/**
 * Resolve the pinned Playwright the way the runner's own node_modules does
 * (playwright → its playwright-core → browsers.json). Undefined when the
 * package is not installed or unreadable — callers degrade to the old
 * any-build discovery rather than fail.
 */
export function getPlaywrightPin(fromDir: string = import.meta.dir): PlaywrightPin | undefined {
  if (cached !== undefined) return cached ?? undefined;
  try {
    const req = createRequire(join(fromDir, 'noop.js'));
    const pwPkgPath = req.resolve('playwright/package.json');
    const version = JSON.parse(readFileSync(pwPkgPath, 'utf8')).version as string;
    const coreReq = createRequire(pwPkgPath);
    const browsersPath = join(dirname(coreReq.resolve('playwright-core/package.json')), 'browsers.json');
    const browsers = JSON.parse(readFileSync(browsersPath, 'utf8')).browsers as Array<{ name: string; revision: string }>;
    const chromium = browsers.find(b => b.name === 'chromium')?.revision;
    const shell = browsers.find(b => b.name === 'chromium-headless-shell')?.revision;
    cached = version && chromium ? { version, chromiumRevision: chromium, headlessShellRevision: shell } : null;
  } catch {
    cached = null;
  }
  return cached ?? undefined;
}

/** Directory names the pinned builds install under, headless shell first. */
export function pinnedBuildDirNames(pin: PlaywrightPin): string[] {
  const names: string[] = [];
  if (pin.headlessShellRevision) names.push(`chromium_headless_shell-${pin.headlessShellRevision}`);
  names.push(`chromium-${pin.chromiumRevision}`);
  return names;
}

/** True when `path` sits inside one of the pinned build directories. */
export function isPinnedBuildPath(path: string, pin: PlaywrightPin): boolean {
  return pinnedBuildDirNames(pin).some(name => path.includes(`/${name}/`));
}

/** Pinned build directories that exist under any of `roots`. */
export function installedPinnedBuilds(
  roots: string[],
  pin: PlaywrightPin,
  exists: (p: string) => boolean = existsSync,
): string[] {
  return roots.flatMap(root => pinnedBuildDirNames(pin).map(name => join(root, name))).filter(p => exists(p));
}
