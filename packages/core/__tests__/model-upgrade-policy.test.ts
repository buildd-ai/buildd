import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_SOAK_HOURS,
  adoptPolicy,
  buildUpgradePolicy,
  explainTierAdoption,
  readUpgradePolicy,
  resolveUpgradePolicy,
} from '../model-upgrade-policy';
import type { CatalogEntry } from '../model-catalog';
import type { ModelCertification } from '../model-certification';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const DAY = 86_400;
const ANCHOR = 1_780_000_000;

const entry = (id: string, created: number, input = 1, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, canonicalId: null, openRouterId: `anthropic/${id}`, provider: 'anthropic', displayName: id,
  contextLength: 1_000_000, created, input, output: input * 5, cacheRead: input / 10, cacheWrite: input * 1.25, ...extra,
});
const CATALOG = [
  entry('claude-sonnet-5-5', ANCHOR, 3),
  entry('claude-haiku-4-5', ANCHOR - 200 * DAY, 1),
  entry('claude-haiku-5-5', ANCHOR + 30 * DAY, 1),
];
const cert = (certifiedAt: number): ModelCertification => ({
  model: 'claude-haiku-5-5', state: 'certified', certifiedAt: new Date(certifiedAt).toISOString(), minVerifiedCliVersion: '2.1.290', probe: { attempts: 1 },
});

describe('policy inheritance', () => {
  it('workspace beats team beats default', () => {
    expect(resolveUpgradePolicy(null, null)).toEqual({ policy: { mode: 'latest-compatible' }, source: 'default' });
    expect(resolveUpgradePolicy({ mode: 'soak' }, null).source).toBe('team');
    expect(resolveUpgradePolicy({ mode: 'soak' }, { mode: 'manual', setAt: 'x' }).source).toBe('workspace');
  });
  it('a malformed stored value reads as inherit', () => {
    expect(readUpgradePolicy({ mode: 'yolo' })).toBeNull();
    expect(resolveUpgradePolicy({ mode: 'manual', setAt: '2026-01-01T00:00:00Z' }, { mode: 42 }).source).toBe('team');
  });
  it('soak defaults its window', () => {
    expect(readUpgradePolicy({ mode: 'soak' })?.soakHours).toBe(DEFAULT_SOAK_HOURS);
  });
});

describe('buildUpgradePolicy / adoptPolicy', () => {
  it('validates mode and soak hours', () => {
    expect('error' in buildUpgradePolicy({ mode: 'pinned' }, null, NOW)).toBe(true);
    expect('error' in buildUpgradePolicy({ mode: 'soak', soakHours: -1 }, null, NOW)).toBe(true);
    const ok = buildUpgradePolicy({ mode: 'soak', soakHours: 24 }, 'user-1', NOW);
    expect('policy' in ok && ok.policy).toMatchObject({ mode: 'soak', soakHours: 24, setBy: 'user-1' });
  });
  it('manual freezes at the moment it is set; adopt moves the line', () => {
    const r = buildUpgradePolicy({ mode: 'manual' }, null, NOW);
    if (!('policy' in r)) throw new Error('expected policy');
    expect(r.policy.adoptedThrough).toBe(new Date(NOW).toISOString());
    expect(adoptPolicy(r.policy, 'u', NOW + 1000).adoptedThrough).toBe(new Date(NOW + 1000).toISOString());
  });
});

describe('explainTierAdoption', () => {
  const certs = new Map([['claude-haiku-5-5', cert(NOW - 3_600_000)]]);

  it('latest-compatible on the newest model: nothing newer, nothing withheld', () => {
    const r = explainTierAdoption({
      tier: 'budget', current: { model: 'claude-haiku-5-5', source: 'catalog' },
      policy: { policy: { mode: 'latest-compatible' }, source: 'default' }, catalog: CATALOG, certifications: certs, now: NOW,
    });
    expect(r.newer).toBeNull();
    expect(r.withheld).toBeNull();
    expect(r.selectedBy).toBe('catalog');
  });

  it('manual: names the newer certified model and why it was withheld', () => {
    const r = explainTierAdoption({
      tier: 'budget', current: { model: 'claude-haiku-4-5', source: 'catalog' },
      policy: { policy: { mode: 'manual', adoptedThrough: new Date(NOW - DAY * 1000).toISOString() }, source: 'team' },
      catalog: CATALOG, certifications: certs, now: NOW,
    });
    expect(r.newer?.model).toBe('claude-haiku-5-5');
    expect(r.withheld).toEqual({ reason: 'manual', eligibleAt: null });
  });

  it('soak: says when it will adopt', () => {
    const r = explainTierAdoption({
      tier: 'budget', current: { model: 'claude-haiku-4-5', source: 'catalog' },
      policy: { policy: { mode: 'soak', soakHours: 48 }, source: 'workspace' },
      catalog: CATALOG, certifications: certs, now: NOW,
    });
    expect(r.withheld?.reason).toBe('soak');
    expect(r.withheld?.eligibleAt).toBe(new Date(NOW - 3_600_000 + 48 * 3_600_000).toISOString());
  });

  it('pinned: newer model is withheld by the pin, whatever the policy', () => {
    const r = explainTierAdoption({
      tier: 'budget', current: { model: 'claude-haiku-4-5', source: 'team' },
      policy: { policy: { mode: 'latest-compatible' }, source: 'default' }, catalog: CATALOG, certifications: certs, now: NOW,
    });
    expect(r.selectedBy).toBe('pinned_team');
    expect(r.withheld?.reason).toBe('pinned');
  });

  it('flags a deprecated current model', () => {
    const catalog = [CATALOG[0], entry('claude-haiku-4-5', ANCHOR - 200 * DAY, 1, { expiresAt: Math.floor(NOW / 1000) + 10 * DAY }), CATALOG[2]];
    const r = explainTierAdoption({
      tier: 'budget', current: { model: 'claude-haiku-4-5', source: 'team' },
      policy: { policy: { mode: 'latest-compatible' }, source: 'default' }, catalog, certifications: certs, now: NOW,
    });
    expect(r.deprecated?.source).toBe('catalog');
    expect(r.deprecated?.retired).toBe(false);
  });

  it('an uncertified newer release is not offered as newer', () => {
    const r = explainTierAdoption({
      tier: 'budget', current: { model: 'claude-haiku-4-5', source: 'catalog' },
      policy: { policy: { mode: 'manual', adoptedThrough: new Date(0).toISOString() }, source: 'team' },
      catalog: CATALOG, certifications: new Map(), now: NOW,
    });
    expect(r.newer).toBeNull();
  });
});
