import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

/**
 * The production Next.js server (`next start`) must run under Node, as it does
 * on Vercel. Under Bun, whether it works depends on the Bun version: Next
 * 16.3's compiled server runtime (app-page-turbo.runtime.prod.js) fails to load
 * on Bun 1.3.x with "Expected CommonJS module to have a function wrapper", so
 * every request returns 500. The post-merge integration job hit exactly that on
 * a test machine whose Bun was older than the version CI pins, and failed on
 * every dev push after the Next 16.3.6 bump.
 *
 * Bun stays the package manager, test runner and `next dev` runtime. This pins
 * only the prod server.
 */

const repoRoot = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/** Matches a `next start` run by Bun: `bun --bun next start`, `bunx --bun next start`, `$BUN --bun next start`. */
const BUN_NEXT_START = /--bun\s+next\s+start/;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

describe('prod server runtime', () => {
  it('apps/web `start` runs next under node, explicitly', () => {
    const pkg = JSON.parse(read('apps/web/package.json'));
    // `bun --bun next start` forces Bun. Plain `next start` follows the bin's
    // `#!/usr/bin/env node` shebang, which reads as Node but `bun run`
    // substitutes Bun when node is not on PATH. Naming node states the intent;
    // integration.yml additionally rejects a `node` that is really Bun.
    expect(pkg.scripts.start).toMatch(/^node\s+\S*next\/dist\/bin\/next\s+start\b/);
  });

  it('no tracked script or workflow starts the prod server under bun', () => {
    const offenders = trackedFiles()
      .filter(f => /\.(sh|ya?ml|json|ts|mjs|js)$/.test(f))
      .filter(f => !f.includes('node_modules/') && f !== 'scripts/prod-server-runtime.test.ts')
      .filter(f => {
        try {
          return BUN_NEXT_START.test(read(f));
        } catch {
          return false;
        }
      });
    expect(offenders).toEqual([]);
  });

  it('the integration job starts the server via the package script and checks it came up', () => {
    const wf = read('.github/workflows/integration.yml');
    expect(wf).toContain('bun run start');
    // Node must be resolved before the server starts, so a missing node is a
    // named error rather than a 150s readiness timeout.
    expect(wf).toMatch(/command -v node/);
    // The readiness probe must fail fast on the known crash signature and must
    // render a page, not just an API route.
    expect(wf).toContain('Failed to load external module');
    expect(wf).toMatch(/PAGE_CODE/);
  });

  it('the demo harness serves with node', () => {
    const sh = read('scripts/demo/serve.sh');
    expect(sh).toMatch(/NODE_BIN.*next\/dist\/bin\/next.*start/);
  });
});
