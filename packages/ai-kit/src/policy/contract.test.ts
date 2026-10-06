/**
 * Contract test: the standalone policy against buildd's own tier registry
 * (`packages/core/model-tier-defaults.ts`, `model-tier-registry.ts`), so the
 * protocol reuses buildd's vocabulary and precedence instead of drifting from
 * it. Loaded by computed path so the kit's `tsc` never checks buildd code;
 * skipped in a checkout without `packages/core` (the published package).
 */
import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODEL_POLICY } from './defaults';
import { toPolicySurface } from './protocol';
import { resolveModelPolicy } from './resolve';
import { KIT_TIERS, POLICY_SURFACES, type ModelPolicy } from './types';

const coreDir = join(import.meta.dir, '../../../core');
const available = existsSync(join(coreDir, 'model-tier-defaults.ts'));

interface CoreDefaults {
  TIERS: readonly string[];
  TIER_SURFACES: readonly ('agent' | 'chat')[];
  TIER_DEFAULTS: Record<string, { provider: string; model: string }>;
}

describe.skipIf(!available)('policy ↔ buildd tier registry', () => {
  const load = async () => (await import(join(coreDir, 'model-tier-defaults.ts'))) as CoreDefaults;

  it('one tier vocabulary', async () => {
    const core = await load();
    expect([...KIT_TIERS] as string[]).toEqual([...core.TIERS]);
  });

  it('the bundled fallback is buildd\'s code-level default', async () => {
    const core = await load();
    for (const tier of KIT_TIERS) {
      expect(DEFAULT_MODEL_POLICY.tiers[tier]).toEqual({ provider: core.TIER_DEFAULTS[tier].provider as never, model: core.TIER_DEFAULTS[tier].model });
    }
  });

  it('every buildd surface maps onto exactly one protocol surface, agent → coding', async () => {
    const core = await load();
    const mapped = core.TIER_SURFACES.map(toPolicySurface);
    expect(mapped).toEqual(['coding', 'chat']);
    expect([...new Set(mapped)].sort()).toEqual([...POLICY_SURFACES].sort());
  });

  it('precedence matches pickRegistryRow: workspace+surface → workspace → team+surface → team', async () => {
    // pickRegistryRow imports the DB client at module load; the order is restated
    // here as the same four rows, resolved by both. The registry's "team" level
    // is the policy's base map, and its workspace rows are overrides.
    const route = (model: string) => ({ provider: 'anthropic' as const, model });
    const all: ModelPolicy = {
      version: 'v',
      tiers: { standard: route('team') },
      surfaces: { coding: { standard: route('team+surface') } },
      overrides: [
        { match: { workspaceId: 'w' }, tier: 'standard', route: route('workspace') },
        { match: { workspaceId: 'w' }, surface: 'coding', tier: 'standard', route: route('workspace+surface') },
      ],
    };
    const at = (p: ModelPolicy, ws?: string) => resolveModelPolicy(p, { surface: 'coding', tier: 'standard', ...(ws ? { workspaceId: ws } : {}) }).model;
    expect(at(all, 'w')).toBe('workspace+surface');
    expect(at({ ...all, overrides: all.overrides!.slice(0, 1) }, 'w')).toBe('workspace');
    expect(at(all)).toBe('team+surface');
    expect(at({ ...all, surfaces: {} })).toBe('team');
  });
});
