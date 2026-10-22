import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const webRoot = join(import.meta.dir, '../..');
const build: string = JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8')).scripts.build;

// Turbopack's native side sizes its Rayon pool to the core count. On the 8-core
// / 16 GB Vercel Enhanced builder that pool alone pushed the release build into
// an out_of_memory SIGKILL during compile (the same commit passed in about five
// minutes with the pool capped at 2). The cap lives in the script, so every
// `bun run build` gets it; an operator can still override it per deployment.
describe('apps/web build script', () => {
  const run = (env: Record<string, string>) => {
    const expansion = build.match(/RAYON_NUM_THREADS="?(\$\{[^}]+\})"?/)?.[1];
    expect(expansion).toBeDefined();
    const r = Bun.spawnSync(['bash', '-c', `printf %s "${expansion}"`], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    return r.stdout.toString();
  };

  it('caps the Rayon thread pool at 2 by default', () => {
    expect(run({})).toBe('2');
  });

  it('lets a deployment override the cap', () => {
    expect(run({ RAYON_NUM_THREADS: '4' })).toBe('4');
  });

  it('still migrates, seeds and type-checks (no typecheck bypass)', () => {
    expect(build).toContain('db:migrate');
    expect(build).toContain('prompts:seed');
    expect(build).toMatch(/next build$/);
    expect(build).not.toContain('ignoreBuildErrors');
  });
});
