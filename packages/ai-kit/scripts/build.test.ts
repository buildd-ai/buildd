import { describe, expect, it } from 'bun:test';
import { distExports, distPackageJson } from './build';
import pkg from '../package.json';

describe('dist package.json', () => {
  it('maps every source export to compiled ESM + .d.ts', () => {
    const out = distExports(pkg.exports) as Record<string, unknown>;
    expect(out['./chat/contract']).toEqual({ types: './chat/contract/index.d.ts', import: './chat/contract/index.js' });
    expect(out['./chat/theme.css']).toBe('./chat/theme.css');
    expect(Object.keys(out).sort()).toEqual(Object.keys(pkg.exports).sort());
  });
  it('has the entry points the design names', () => {
    for (const e of ['./models', './decide', './chat/contract', './chat/server', './chat/react', './chat/theme.css', './surfaces']) {
      expect(pkg.exports).toHaveProperty([e]);
    }
  });
  it('publishes public with provenance, with no dev-only fields', () => {
    const out = distPackageJson(pkg as never);
    expect(out.publishConfig).toEqual({ access: 'public', provenance: true });
    expect(out).not.toHaveProperty('scripts');
    expect(out).not.toHaveProperty('devDependencies');
    expect(out.name).toBe('@buildd/ai-kit');
    expect((out.repository as { url: string }).url).toContain('github.com/buildd-ai/buildd');
  });
  it('is an exact semver version, independent of buildd', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
