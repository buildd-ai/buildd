/**
 * One tier authority: the model policy (packages/core/model-policy.ts over
 * @builddai/ai-kit/policy). This scans the tracked source for the ways a call
 * site used to pick a tier's concrete model on its own, so a new one fails here
 * instead of quietly becoming a second source of truth.
 *
 * Model-id literals are policed separately (scripts/lint-model-ids.ts); this
 * covers the indirect routes: indexing the code-level defaults table, and
 * reading the registry table to resolve a tier outside the policy loader.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '../../..');
const files = Bun.spawnSync(['git', 'ls-files', 'apps', 'packages'], { cwd: repo })
  .stdout.toString()
  .split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/__tests__|\.test\.|\.spec\.|\.d\.ts$/.test(f));

/** Source with comments blanked, so prose about a symbol is not a use of it. */
function code(file: string): string {
  return readFileSync(join(repo, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function offenders(pattern: RegExp, allowed: readonly string[]): string[] {
  return files.filter((f) => !allowed.includes(f) && pattern.test(code(f)));
}

describe('the model policy is the only tier resolver', () => {
  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('packages/core/model-policy.ts');
  });

  it('nothing indexes the code-level defaults table; callers ask bundledTierEntry (the policy\'s fallback)', () => {
    expect(offenders(/\bTIER_DEFAULTS\s*[[.]|\(\s*TIER_DEFAULTS\b/, ['packages/core/model-tier-defaults.ts'])).toEqual([]);
  });

  it('only the policy loader reads registry rows to resolve a tier', () => {
    const allowed = [
      // The loader: one team's rows become the policy document.
      'packages/core/model-tier-registry.ts',
      // Admin CRUD behind Settings and manage_model_tiers: writes rows, never resolves.
      'apps/web/src/app/api/model-tiers/route.ts',
      'apps/web/src/app/api/model-tiers/pools/route.ts',
      // Inventory of every model a team could route to (endpoint verify), not a resolution.
      'apps/web/src/lib/agent-endpoint-settings.ts',
    ];
    expect(offenders(/db\.query\.modelTierRegistry\.|from\(\s*modelTierRegistry\s*\)/, allowed)).toEqual([]);
  });

  it('every buildd surface reaches the policy through resolveTierEntry, not the kit resolver directly', () => {
    // Calling the kit's resolver directly would skip the registry document and
    // the default layer. Only the adapter and the bundled-default helper may.
    const allowed = ['packages/core/model-policy.ts', 'packages/core/model-tier-defaults.ts'];
    const direct = offenders(/\bresolveModelPolicy\s*\(|\bpickRoute\s*\(/, allowed)
      .filter((f) => !f.startsWith('packages/ai-kit/') && !f.startsWith('apps/model-policy/'));
    expect(direct).toEqual([]);
  });
});
