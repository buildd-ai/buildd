import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SCAN_ROOTS = ['apps', 'packages'];
const IGNORED = /(^|\/)(node_modules|\.next|dist|\.turbo)\//;
const SKIP_SELF = /^packages\/core\/(tuning\/|__tests__\/tuning)/;

const IMPORTS_TUNING = /from\s+['"](?:@buildd\/core\/tuning|[^'"]*\/core\/tuning|[^'"]*\/tuning(?:\/index)?)['"]|import\(\s*['"](?:@buildd\/core\/tuning|[^'"]*\/core\/tuning)['"]\s*\)/;
const USE_CLIENT = /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use client['"]/;

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const rel of new Glob(`${root}/**/*.{ts,tsx,js,jsx,mjs}`).scanSync({ cwd: REPO_ROOT })) {
      if (IGNORED.test(rel) || SKIP_SELF.test(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

describe('private tuning stays server-side', () => {
  it('no "use client" file imports packages/core/tuning', () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      if (USE_CLIENT.test(src) && IMPORTS_TUNING.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the detector flags a client file that imports tuning', () => {
    const bad = `'use client';\nimport { getTuning } from '@buildd/core/tuning';\n`;
    expect(USE_CLIENT.test(bad) && IMPORTS_TUNING.test(bad)).toBe(true);
    const server = `import { getTuning } from '@buildd/core/tuning';\n`;
    expect(USE_CLIENT.test(server)).toBe(false);
  });

  it('the tuning source is never exposed through a NEXT_PUBLIC_ variable', () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      if (/NEXT_PUBLIC_BUILDD_TUNING/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
