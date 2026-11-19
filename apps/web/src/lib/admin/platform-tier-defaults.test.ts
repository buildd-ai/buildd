/**
 * The one function behind the platform tier default (lib/admin/platform-tier-defaults.ts):
 * who may write, the guard rails, the audit row around every write, and the
 * one-step revert. Deps are in-memory; no DB.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import type { CatalogEntry } from '@buildd/core/model-catalog';
import type { ModelCertification } from '@buildd/core/model-certification';
import type { Tier, TierEntry } from '@buildd/core/model-tier-defaults';
import type { PlatformTierDefault } from '@buildd/core/model-tier-platform-default';
import {
  applyPlatformTierDefaultChange,
  parsePlatformTierChange,
  readPlatformTierDefaults,
  type PlatformTierCaller,
  type PlatformTierChange,
  type PlatformTierDefaultsDeps,
} from './platform-tier-defaults';

const NOW = Date.UTC(2026, 10, 14, 12);
const entry = (id: string, input: number, created: number): CatalogEntry => ({
  id, canonicalId: null, openRouterId: `anthropic/${id}`, provider: 'anthropic', displayName: id,
  contextLength: 1_000_000, created, input, output: input * 5, cacheRead: input / 10, cacheWrite: input * 1.25,
});
const CATALOG: CatalogEntry[] = [
  entry('claude-fable-5-1', 10, 1_788_000_000),
  entry('claude-fable-5-9', 8, 1_794_000_000), // newer than the table knows
  entry('claude-opus-5-5', 4, 1_790_000_000),
  entry('claude-sonnet-5-5', 2, 1_790_600_000),
  entry('claude-haiku-5-5', 0.1, 1_791_000_000),
];

const operator: PlatformTierCaller = { user: { id: 'op-user', email: 'op@example.com' }, account: null, principal: 'person' };
const teamAdmin: PlatformTierCaller = { user: { id: 'admin-user', email: 'admin@example.com' }, account: null, principal: 'person' };
const platformKey: PlatformTierCaller = { user: null, account: { id: 'acct-platform', level: 'admin' }, principal: 'key' };
const taskToken: PlatformTierCaller = { user: null, account: { id: 'acct-platform', level: 'admin' }, principal: 'task_token' };

interface Harness {
  deps: PlatformTierDefaultsDeps;
  rows: Map<Tier, PlatformTierDefault>;
  audits: Array<{ id: string; event: Record<string, unknown>; completed: Record<string, unknown> | null }>;
  certs: Map<string, ModelCertification>;
  catalog: CatalogEntry[];
  writeLands: boolean;
  intentThrows: boolean;
}

function harness(): Harness {
  const h: Harness = {
    rows: new Map(), audits: [], certs: new Map(), catalog: CATALOG, writeLands: true, intentThrows: false,
    deps: null as unknown as PlatformTierDefaultsDeps,
  };
  h.deps = {
    now: () => NOW,
    catalog: async () => h.catalog,
    certifications: async () => h.certs,
    resolveEffective: async (tier): Promise<TierEntry> => {
      const row = h.rows.get(tier);
      if (row) return { provider: row.provider, model: row.model, source: 'platform' };
      // The catalog pick, as production would answer with no row.
      const byTier: Record<Tier, string> = { 'premium-plus': 'claude-fable-5-1', premium: 'claude-opus-5-5', standard: 'claude-sonnet-5-5', budget: 'claude-haiku-5-5' };
      return { provider: 'anthropic', model: byTier[tier], source: 'catalog' };
    },
    readRow: async (tier) => h.rows.get(tier) ?? null,
    writeRow: async (tier, prev, next) => {
      if (!h.writeLands) return false;
      const cur = h.rows.get(tier) ?? null;
      if (JSON.stringify(cur) !== JSON.stringify(prev)) return false;
      if (next) h.rows.set(tier, next); else h.rows.delete(tier);
      return true;
    },
    isOperator: async (caller) => caller.principal !== 'task_token' && (caller.user?.email === 'op@example.com' || caller.account?.id === 'acct-platform'),
    auditIntent: async (event) => {
      if (h.intentThrows) throw new Error('db down');
      const id = `audit-${h.audits.length + 1}`;
      h.audits.push({ id, event: event as unknown as Record<string, unknown>, completed: null });
      return id;
    },
    auditComplete: async (id, after) => {
      const a = h.audits.find((x) => x.id === id);
      if (!a) return false;
      a.completed = after;
      return true;
    },
  };
  return h;
}

const change = (over: Partial<PlatformTierChange> & { op: PlatformTierChange['op']; tier: Tier }): PlatformTierChange => ({
  confirm: true, confirmBandChange: false, via: 'mcp', reason: null, ...over,
});

let h: Harness;
beforeEach(() => { h = harness(); });

describe('parsePlatformTierChange', () => {
  it('accepts a set with confirm flags and a via, defaulting via to api', () => {
    const r = parsePlatformTierChange({ op: 'set', tier: 'premium', model: ' claude-opus-5-5 ', confirm: true, reason: 'move' });
    expect(r).toEqual({ ok: true, change: { op: 'set', tier: 'premium', model: 'claude-opus-5-5', reason: 'move', confirm: true, confirmBandChange: false, via: 'api' } });
    expect(parsePlatformTierChange({ op: 'clear', tier: 'budget', via: 'ui' })).toMatchObject({ ok: true, change: { via: 'ui', confirm: false } });
  });

  it('refuses a bad op, tier, missing model or unknown via with 400', () => {
    expect(parsePlatformTierChange({ op: 'nuke', tier: 'premium' })).toMatchObject({ ok: false, status: 400 });
    expect(parsePlatformTierChange({ op: 'set', tier: 'ultra', model: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(parsePlatformTierChange({ op: 'set', tier: 'premium' })).toMatchObject({ ok: false, error: 'model is required for set' });
    expect(parsePlatformTierChange({ op: 'set', tier: 'premium', model: 'x', via: 'cron' })).toMatchObject({ ok: false });
    expect(parsePlatformTierChange(null)).toMatchObject({ ok: false });
  });
});

describe('who may write', () => {
  it('a team admin who is not a platform operator is refused with 403 and nothing is written or audited', async () => {
    const r = await applyPlatformTierDefaultChange(teamAdmin, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5' }), h.deps);
    expect(r).toMatchObject({ ok: false, status: 403, code: 'operator_only' });
    expect(h.rows.size).toBe(0);
    expect(h.audits).toEqual([]);
  });

  it('a per-task token is refused even when minted from a platform admin account', async () => {
    const r = await applyPlatformTierDefaultChange(taskToken, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5' }), h.deps);
    expect(r).toMatchObject({ ok: false, status: 403, code: 'operator_only' });
    expect(h.audits).toEqual([]);
  });

  it('a signed-in operator and a platform admin key may write', async () => {
    expect((await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5' }), h.deps)).ok).toBe(true);
    expect((await applyPlatformTierDefaultChange(platformKey, change({ op: 'set', tier: 'standard', model: 'claude-sonnet-5-5' }), h.deps)).ok).toBe(true);
  });
});

describe('set: guard rails, audit and the stored row', () => {
  it('writes the row with who, via and reason, and one completed audit row with before and after', async () => {
    const r = await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium-plus', model: 'claude-fable-5-1', via: 'ui', reason: 'pin the fleet' }), h.deps);
    expect(r).toMatchObject({
      ok: true, op: 'set', tier: 'premium-plus', before: null,
      after: { model: 'claude-fable-5-1', setBy: { userId: 'op-user', accountId: null, via: 'ui' }, reason: 'pin the fleet' },
      effective: { model: 'claude-fable-5-1', source: 'platform' },
      facts: { floor: '2.1.251', price: { input: 10, output: 50 } },
    });
    expect(h.rows.get('premium-plus')).toMatchObject({ model: 'claude-fable-5-1', previous: null, setAt: new Date(NOW).toISOString() });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].event).toMatchObject({
      action: 'platform_tier_default.set', targetType: 'platform_tier_default', targetId: 'premium-plus', teamId: null, actorAccountId: null,
      before: {}, after: { op: 'set', via: 'ui', reason: 'pin the fleet', model: 'claude-fable-5-1', actor: { userId: 'op-user' } },
    });
    expect(h.audits[0].completed).toMatchObject({ model: 'claude-fable-5-1', via: 'ui' });
  });

  it('refuses without confirm, and says so after the model checks out', async () => {
    const r = await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5', confirm: false }), h.deps);
    expect(r).toMatchObject({ ok: false, status: 409, code: 'confirm_required', detail: { floor: '2.1.280' } });
    expect(h.audits).toEqual([]);
  });

  it('refuses a model outside the live catalog, one with no certified floor, and the catalog being down', async () => {
    expect(await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-opus-9' }), h.deps)).toMatchObject({ ok: false, status: 422, code: 'model_not_in_catalog' });
    expect(await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium-plus', model: 'claude-fable-5-9' }), h.deps)).toMatchObject({ ok: false, status: 422, code: 'not_certified' });
    h.catalog = [];
    expect(await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5' }), h.deps)).toMatchObject({ ok: false, status: 503, code: 'catalog_unavailable' });
    expect(h.rows.size).toBe(0);
    expect(h.audits).toEqual([]);
  });

  it('lowering a tier\'s spend band needs an explicit band confirm', async () => {
    const down = await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium-plus', model: 'claude-opus-5-5' }), h.deps);
    expect(down).toMatchObject({ ok: false, status: 409, code: 'spend_band_change', detail: { direction: 'below' } });
    const ok = await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium-plus', model: 'claude-opus-5-5', confirmBandChange: true }), h.deps);
    expect(ok.ok).toBe(true);
  });

  it('setting the model already in place is a no-op refusal, not a new audit row', async () => {
    await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5' }), h.deps);
    const r = await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5' }), h.deps);
    expect(r).toMatchObject({ ok: false, status: 409, code: 'no_change' });
    expect(h.audits).toHaveLength(1);
  });

  it('a second write keeps the snapshot it replaced, so revert has somewhere to go', async () => {
    await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5' }), h.deps);
    const r = await applyPlatformTierDefaultChange(platformKey, change({ op: 'set', tier: 'premium', model: 'claude-fable-5-1', confirmBandChange: true, via: 'mcp' }), h.deps);
    expect(r).toMatchObject({ ok: true, before: { model: 'claude-opus-5-5' }, after: { model: 'claude-fable-5-1', setBy: { accountId: 'acct-platform', via: 'mcp' } } });
    expect(h.rows.get('premium')?.previous).toMatchObject({ model: 'claude-opus-5-5', setBy: { userId: 'op-user' } });
    expect(h.audits[1].event).toMatchObject({ actorAccountId: 'acct-platform', before: { model: 'claude-opus-5-5' } });
  });
});

describe('revert and clear', () => {
  it('revert restores the previous model in one step, audited, and a second revert goes back again', async () => {
    await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5' }), h.deps);
    await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-fable-5-1', confirmBandChange: true }), h.deps);
    const r = await applyPlatformTierDefaultChange(operator, change({ op: 'revert', tier: 'premium' }), h.deps);
    expect(r).toMatchObject({ ok: true, op: 'revert', before: { model: 'claude-fable-5-1' }, after: { model: 'claude-opus-5-5' }, effective: { model: 'claude-opus-5-5', source: 'platform' } });
    expect(h.audits[2].event).toMatchObject({ action: 'platform_tier_default.revert' });
    const again = await applyPlatformTierDefaultChange(operator, change({ op: 'revert', tier: 'premium' }), h.deps);
    expect(again).toMatchObject({ ok: true, after: { model: 'claude-fable-5-1' } });
  });

  it('reverting the first write removes the row: the tier follows the catalog again', async () => {
    await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'budget', model: 'claude-haiku-5-5' }), h.deps);
    const r = await applyPlatformTierDefaultChange(operator, change({ op: 'revert', tier: 'budget' }), h.deps);
    expect(r).toMatchObject({ ok: true, after: null, effective: { source: 'catalog' } });
    expect(h.rows.has('budget')).toBe(false);
    expect(h.audits[1].completed).toMatchObject({ cleared: true, op: 'revert' });
  });

  it('revert and clear need confirm and refuse when there is nothing stored', async () => {
    expect(await applyPlatformTierDefaultChange(operator, change({ op: 'revert', tier: 'budget', confirm: false }), h.deps)).toMatchObject({ ok: false, status: 409, code: 'confirm_required' });
    expect(await applyPlatformTierDefaultChange(operator, change({ op: 'revert', tier: 'budget' }), h.deps)).toMatchObject({ ok: false, status: 409, code: 'nothing_to_revert' });
    expect(await applyPlatformTierDefaultChange(operator, change({ op: 'clear', tier: 'budget' }), h.deps)).toMatchObject({ ok: false, status: 409, code: 'no_change' });
    expect(h.audits).toEqual([]);
  });

  it('clear removes the row with an audit row', async () => {
    await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'standard', model: 'claude-sonnet-5-5' }), h.deps);
    const r = await applyPlatformTierDefaultChange(operator, change({ op: 'clear', tier: 'standard', reason: 'let the catalog decide' }), h.deps);
    expect(r).toMatchObject({ ok: true, op: 'clear', after: null });
    expect(h.audits[1].event).toMatchObject({ action: 'platform_tier_default.clear', after: { reason: 'let the catalog decide' } });
  });
});

describe('apply: the suggestion, never an auto-move', () => {
  it('applies the liveness audit\'s newer model only once it is certified, through the same guard rails', async () => {
    // Fable 5.9 is newer than the effective Fable 5.1 but not certified: refused.
    const held = await applyPlatformTierDefaultChange(operator, change({ op: 'apply', tier: 'premium-plus' }), h.deps);
    expect(held).toMatchObject({ ok: false, status: 422, code: 'not_certified' });
    h.certs.set('claude-fable-5-9', { model: 'claude-fable-5-9', state: 'certified', minCliVersion: '2.1.330', certifiedAt: '2026-11-10T00:00:00.000Z', probe: { attempts: 1 } });
    const r = await applyPlatformTierDefaultChange(operator, change({ op: 'apply', tier: 'premium-plus' }), h.deps);
    expect(r).toMatchObject({ ok: true, op: 'apply', after: { model: 'claude-fable-5-9', reason: 'apply suggestion' }, facts: { floor: '2.1.330' } });
    expect(h.audits.at(-1)?.event).toMatchObject({ action: 'platform_tier_default.apply' });
  });

  it('refuses when nothing newer is suggested', async () => {
    const r = await applyPlatformTierDefaultChange(operator, change({ op: 'apply', tier: 'premium' }), h.deps);
    expect(r).toMatchObject({ ok: false, status: 409, code: 'no_suggestion' });
  });
});

describe('audit and concurrency', () => {
  it('when the audit intent cannot be written nothing changes', async () => {
    h.intentThrows = true;
    const r = await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5' }), h.deps);
    expect(r).toMatchObject({ ok: false, status: 500, code: 'audit_failed' });
    expect(h.rows.size).toBe(0);
  });

  it('a write that lost the race answers 409 and completes its intent as aborted', async () => {
    h.writeLands = false;
    const r = await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5' }), h.deps);
    expect(r).toMatchObject({ ok: false, status: 409, code: 'conflict' });
    expect(h.audits[0].completed).toMatchObject({ phase: 'aborted', abortReason: 'conflict' });
  });
});

describe('readPlatformTierDefaults', () => {
  it('shows per tier the effective model, where it came from, price, floor, the stored row and the suggestion', async () => {
    await applyPlatformTierDefaultChange(operator, change({ op: 'set', tier: 'premium', model: 'claude-opus-5-5' }), h.deps);
    const view = await readPlatformTierDefaults(teamAdmin, h.deps);
    expect(view.catalogChecked).toBe(true);
    expect(view.canWrite).toBe(false);
    expect(view.tiers.map((t) => t.tier)).toEqual(['premium-plus', 'premium', 'standard', 'budget']);
    const premium = view.tiers.find((t) => t.tier === 'premium')!;
    expect(premium).toMatchObject({
      effective: { model: 'claude-opus-5-5', source: 'platform', facts: { price: { input: 4, output: 20 }, floor: '2.1.280', certification: 'baseline' } },
      platform: { model: 'claude-opus-5-5' }, canRevert: true, suggestion: null, band: { minInput: 4, maxInput: 8 },
    });
    const pp = view.tiers.find((t) => t.tier === 'premium-plus')!;
    expect(pp).toMatchObject({ effective: { source: 'catalog' }, platform: null, canRevert: false, suggestion: { kind: 'newer', newer: 'claude-fable-5-9', applicable: false } });
    expect((await readPlatformTierDefaults(operator, h.deps)).canWrite).toBe(true);
  });

  it('with no catalog the view still answers, with no suggestions and catalogChecked false', async () => {
    h.catalog = [];
    const view = await readPlatformTierDefaults(operator, h.deps);
    expect(view.catalogChecked).toBe(false);
    expect(view.tiers.every((t) => t.suggestion === null)).toBe(true);
  });
});
