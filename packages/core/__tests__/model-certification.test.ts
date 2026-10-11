import { describe, it, expect } from 'bun:test';
import {
  applyAdminMark,
  applyCompatibilityIncident,
  applyProbeReport,
  classifyProbeError,
  leaseCertification,
  needsProbe,
  newCertification,
  parseRequiredCliVersion,
  runnerMeetsCertification,
  type ModelCertification,
} from '../model-certification';
import { checkModelClientCapability, makeCatalogServabilityCheck } from '../model-capability-requirements';
import { checkDispatchModel } from '../dispatch-model-guard';
import { describeCertification, probeCandidates } from '../model-certification-candidates';
import type { CatalogEntry } from '../model-catalog';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const DAY = 86_400;
const ANCHOR = 1_780_000_000;

const entry = (id: string, created: number, input = 1, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id,
  canonicalId: null,
  openRouterId: `anthropic/${id}`,
  provider: 'anthropic',
  displayName: id,
  contextLength: 1_000_000,
  created,
  input,
  output: input * 5,
  cacheRead: input / 10,
  cacheWrite: input * 1.25,
  ...extra,
});

const CATALOG = [
  entry('claude-sonnet-5-5', ANCHOR, 3), // newest row of MODEL_MIN_CLI_VERSION
  entry('claude-haiku-4-5', ANCHOR - 200 * DAY, 1),
  entry('claude-haiku-5-5', ANCHOR + 30 * DAY, 1),
];

const VERSION_GATE_ERROR =
  'API Error: 400 Claude Code 2.1.284 does not support this model; version 2.1.291 or newer is required.';

const leased = (): ModelCertification => leaseCertification(newCertification('claude-haiku-5-5', CATALOG[2]), 'lease-1', NOW);

describe('probe error parsing', () => {
  it('reads the floor from the provider version gate', () => {
    expect(parseRequiredCliVersion(VERSION_GATE_ERROR)).toBe('2.1.291');
    expect(classifyProbeError(VERSION_GATE_ERROR)).toBe('version_gate');
  });
  it('tells an unknown id from a transient failure', () => {
    expect(classifyProbeError('[claude-code:unrecognized_model] no such model')).toBe('unknown_model');
    expect(classifyProbeError('429 rate_limit_error')).toBe('transient');
  });
});

describe('certification state machine', () => {
  it('discovered → probing → certified records the verifying CLI', () => {
    const lease = leased();
    expect(lease.state).toBe('probing');
    const done = applyProbeReport(lease, { model: lease.model, cliVersion: '2.1.290', ok: true }, NOW);
    expect(done.state).toBe('certified');
    expect(done.minVerifiedCliVersion).toBe('2.1.290');
    expect(done.certifiedAt).toBe(new Date(NOW).toISOString());
    expect(done.probe.leaseId).toBeNull();
  });

  it('a version-gate error marks the model incompatible with the provider floor', () => {
    const r = applyProbeReport(leased(), { model: 'claude-haiku-5-5', cliVersion: '2.1.284', ok: false, error: VERSION_GATE_ERROR }, NOW);
    expect(r.state).toBe('incompatible');
    expect(r.minCliVersion).toBe('2.1.291');
    // A runner below the floor is not asked again; one at the floor is.
    expect(needsProbe(r, '2.1.290', NOW)).toBe(false);
    expect(needsProbe(r, '2.1.291', NOW)).toBe(true);
  });

  it('a transient failure is failed with backoff, and never blocks other models', () => {
    const r = applyProbeReport(leased(), { model: 'claude-haiku-5-5', cliVersion: '2.1.290', ok: false, error: 'ECONNRESET' }, NOW);
    expect(r.state).toBe('failed');
    expect(needsProbe(r, '2.1.290', NOW)).toBe(false);
    expect(needsProbe(r, '2.1.290', NOW + 2 * 3_600_000)).toBe(true);
    expect(needsProbe(null, '2.1.290', NOW)).toBe(true);
  });

  it('a transient failure never uncertifies a certified model', () => {
    const ok = applyProbeReport(leased(), { model: 'claude-haiku-5-5', cliVersion: '2.1.290', ok: true }, NOW);
    const again = applyProbeReport(leaseCertification(ok, 'l2', NOW), { model: ok.model, cliVersion: '2.1.280', ok: false, error: 'timeout' }, NOW);
    expect(again.state).toBe('certified');
  });

  it('a certified model is re-probed by an older runner to learn whether the floor is lower', () => {
    const ok = applyProbeReport(leased(), { model: 'claude-haiku-5-5', cliVersion: '2.1.290', ok: true }, NOW);
    expect(needsProbe(ok, '2.1.295', NOW)).toBe(false);
    expect(needsProbe(ok, '2.1.285', NOW)).toBe(true);
    const lower = applyProbeReport(leaseCertification(ok, 'l2', NOW), { model: ok.model, cliVersion: '2.1.285', ok: true }, NOW);
    expect(lower.minVerifiedCliVersion).toBe('2.1.285');
  });

  it('a live lease is not handed to a second runner; an expired one is', () => {
    const lease = leased();
    expect(needsProbe(lease, '2.1.290', NOW + 60_000)).toBe(false);
    expect(needsProbe(lease, '2.1.290', NOW + 11 * 60_000)).toBe(true);
  });

  it('a worker incident restarts soak and only ever raises the floor', () => {
    const ok = applyProbeReport(leased(), { model: 'claude-haiku-5-5', cliVersion: '2.1.290', ok: true }, NOW);
    const hit = applyCompatibilityIncident(ok, VERSION_GATE_ERROR, NOW + 1000);
    expect(hit.minCliVersion).toBe('2.1.291');
    expect(hit.lastIncidentAt).toBe(new Date(NOW + 1000).toISOString());
    const lower = applyCompatibilityIncident({ ...hit, minCliVersion: '2.1.300' }, VERSION_GATE_ERROR, NOW);
    expect(lower.minCliVersion).toBe('2.1.300');
  });

  it('an admin mark overrides the probe and can deprecate', () => {
    const marked = applyAdminMark(leased(), { by: 'acct', state: 'certified', deprecated: true, retiresAt: '2027-01-01T00:00:00Z' }, NOW);
    expect(marked.state).toBe('certified');
    expect(marked.override?.by).toBe('acct');
    expect(marked.deprecated?.source).toBe('admin');
    expect(needsProbe(marked, '2.1.300', NOW)).toBe(false);
  });
});

describe('runner capability against certification', () => {
  const cert: ModelCertification = {
    model: 'claude-haiku-5-5', state: 'certified', minCliVersion: '2.1.291', certifiedAt: new Date(NOW).toISOString(), probe: { attempts: 1 },
  };
  const certs = new Map([[cert.model, cert]]);

  it('meets: at/above floor; fails closed with no runner version', () => {
    expect(runnerMeetsCertification(cert, '2.1.291')).toBe(true);
    expect(runnerMeetsCertification(cert, '2.1.290')).toBe(false);
    expect(runnerMeetsCertification(cert, null)).toBe(false);
  });

  it('the claim-time capability gate uses the learned floor for a model the static table never named', () => {
    expect(checkModelClientCapability('claude-haiku-5-5', '2.1.290')).toEqual({ ok: true });
    expect(checkModelClientCapability('claude-haiku-5-5', '2.1.290', certs)).toEqual({ ok: false, requiredVersion: '2.1.291' });
  });

  it('the catalog servability check admits a certified newer-than-table release', () => {
    const without = makeCatalogServabilityCheck(CATALOG, '2.1.300');
    const withCerts = makeCatalogServabilityCheck(CATALOG, '2.1.300', { certifications: certs });
    expect(without('claude-haiku-5-5')).toBe(false);
    expect(withCerts('claude-haiku-5-5')).toBe(true);
    expect(makeCatalogServabilityCheck(CATALOG, '2.1.290', { certifications: certs })('claude-haiku-5-5')).toBe(false);
  });

  it('the dispatch guard accepts a certified id it would otherwise refuse', () => {
    expect(checkDispatchModel('claude-haiku-5-5', CATALOG)).toEqual({ ok: false, reason: 'newer_than_floor_table' });
    expect(checkDispatchModel('claude-haiku-5-5', CATALOG, certs)).toEqual({ ok: true });
  });
});

describe('probe candidates and the certification view', () => {
  it('only unrecognized in-band releases are probed; baseline models never are', () => {
    const ids = probeCandidates(CATALOG, new Map(), '2.1.290', NOW).map((e) => e.id);
    expect(ids).toEqual(['claude-haiku-5-5']);
  });

  it('a retired release is not probed', () => {
    const retiring = [...CATALOG.slice(0, 2), entry('claude-haiku-5-5', ANCHOR + 30 * DAY, 1, { expiresAt: Math.floor(NOW / 1000) - 10 })];
    expect(probeCandidates(retiring, new Map(), '2.1.290', NOW)).toHaveLength(0);
  });

  it('describes baseline, discovered and catalog-deprecated models', () => {
    expect(describeCertification('claude-haiku-4-5', CATALOG, new Map(), NOW).state).toBe('baseline');
    expect(describeCertification('claude-haiku-5-5', CATALOG, new Map(), NOW).state).toBe('discovered');
    const expiring = [entry('claude-sonnet-5-5', ANCHOR, 3), entry('claude-haiku-4-5', ANCHOR - 200 * DAY, 1, { expiresAt: Math.floor(NOW / 1000) + 30 * DAY })];
    const view = describeCertification('claude-haiku-4-5', expiring, new Map(), NOW);
    expect(view.deprecated?.source).toBe('catalog');
    expect(view.retired).toBe(false);
  });
});
