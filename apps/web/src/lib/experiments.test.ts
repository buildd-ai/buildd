import { describe, it, expect } from 'bun:test';
import {
  canViewExperiment,
  isExperimentAdmin,
  parseCreateExperiment,
  planExperimentPatch,
  toExperimentDTO,
  type ExperimentState,
} from './experiments';

const NOW = new Date('2026-01-02T03:04:05.000Z');
const EARLIER = new Date('2026-01-01T00:00:00.000Z');

const state = (over: Partial<ExperimentState> = {}): ExperimentState => ({
  status: 'draft',
  treatmentFraction: 0.5,
  policyVersion: 1,
  config: { arms: { treatment: { tier: 'premium' } } },
  startedAt: null,
  decision: null,
  ...over,
});

function plan(current: ExperimentState, body: unknown) {
  const r = planExperimentPatch(current, body, NOW);
  return r;
}

describe('visibility', () => {
  it('team experiments are visible to every role', () => {
    for (const role of ['member', 'admin', 'owner'] as const) expect(canViewExperiment('team', role)).toBe(true);
  });
  it('admins experiments are visible to admin and owner only', () => {
    expect(canViewExperiment('admins', 'member')).toBe(false);
    expect(canViewExperiment('admins', 'admin')).toBe(true);
    expect(canViewExperiment('admins', 'owner')).toBe(true);
    expect(canViewExperiment('admins', null)).toBe(false);
  });
  it('isExperimentAdmin', () => {
    expect(isExperimentAdmin('member')).toBe(false);
    expect(isExperimentAdmin('admin')).toBe(true);
    expect(isExperimentAdmin('owner')).toBe(true);
  });
});

describe('parseCreateExperiment', () => {
  it('fills defaults: draft-only fields, admins visibility, half fraction, explicit config', () => {
    const r = parseCreateExperiment({ key: 'premium-vs-standard', title: '  Premium vs standard ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe('Premium vs standard');
    expect(r.value.visibility).toBe('admins');
    expect(r.value.treatmentFraction).toBe(0.5);
    expect(r.value.kind).toBe('model_routing');
    expect((r.value.config as any).arms.treatment.tier).toBe('premium');
    expect((r.value.config as any).eligibility.maxBudgetPressure).toBe(0.5);
  });

  it.each([
    [{ title: 't' }, 'key'],
    [{ key: 'Bad Key', title: 't' }, 'key'],
    [{ key: 'k' }, 'title'],
    [{ key: 'k', title: 't', treatmentFraction: 0 }, 'treatmentFraction'],
    [{ key: 'k', title: 't', treatmentFraction: 1 }, 'treatmentFraction'],
    [{ key: 'k', title: 't', treatmentFraction: '0.5' }, 'treatmentFraction'],
    [{ key: 'k', title: 't', visibility: 'public' }, 'visibility'],
    [{ key: 'k', title: 't', kind: 'other' }, 'kind'],
    [{ key: 'k', title: 't', config: [] }, 'config'],
  ])('rejects %j (%s)', (body, field) => {
    const r = parseCreateExperiment(body);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain(field);
    }
  });

  it('ignores a caller-supplied status: every experiment starts as a draft', () => {
    const r = parseCreateExperiment({ key: 'k', title: 't', status: 'running' });
    expect(r.ok).toBe(true);
    if (r.ok) expect('status' in r.value).toBe(false);
  });
});

describe('planExperimentPatch — status transitions', () => {
  it('draft → running stamps startedAt and does not bump the version', () => {
    const r = plan(state(), { status: 'running' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.set.status).toBe('running');
    expect(r.value.set.startedAt).toEqual(NOW);
    expect(r.value.bumpedPolicyVersion).toBe(false);
    expect('policyVersion' in r.value.set).toBe(false);
  });

  it('running → paused → running keeps the original startedAt', () => {
    const paused = plan(state({ status: 'running', startedAt: EARLIER }), { status: 'paused' });
    expect(paused.ok && paused.value.set.status).toBe('paused');
    const resumed = plan(state({ status: 'paused', startedAt: EARLIER }), { status: 'running' });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.set.status).toBe('running');
    expect('startedAt' in resumed.value.set).toBe(false);
  });

  it('running → concluded requires a decision and stamps concludedAt', () => {
    const missing = plan(state({ status: 'running', startedAt: EARLIER }), { status: 'concluded' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(400);

    const blank = plan(state({ status: 'running', startedAt: EARLIER }), { status: 'concluded', decision: '   ' });
    expect(blank.ok).toBe(false);

    const ok = plan(state({ status: 'running', startedAt: EARLIER }), { status: 'concluded', decision: 'Keep routing as is.' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.set.decision).toBe('Keep routing as is.');
    expect(ok.value.set.concludedAt).toEqual(NOW);
  });

  it('paused and draft can be concluded (with a decision)', () => {
    expect(plan(state({ status: 'paused', startedAt: EARLIER }), { status: 'concluded', decision: 'd' }).ok).toBe(true);
    expect(plan(state(), { status: 'concluded', decision: 'abandoned before start' }).ok).toBe(true);
  });

  it.each([
    ['draft', 'paused'],
    ['running', 'draft'],
    ['paused', 'draft'],
  ] as const)('%s → %s is illegal (409)', (from, to) => {
    const r = plan(state({ status: from, startedAt: from === 'draft' ? null : EARLIER }), { status: to });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('concluded is terminal: every patch is 409', () => {
    for (const body of [{ status: 'running' }, { status: 'paused' }, { title: 'x' }, { decision: 'y' }]) {
      const r = plan(state({ status: 'concluded', startedAt: EARLIER, decision: 'd' }), body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(409);
    }
  });

  it('moving to the current status is a 409, not a silent no-op', () => {
    const r = plan(state({ status: 'running', startedAt: EARLIER }), { status: 'running' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('rejects an unknown status value', () => {
    const r = plan(state(), { status: 'archived' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('decision without concluding is rejected', () => {
    const r = plan(state({ status: 'running', startedAt: EARLIER }), { decision: 'early call' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

describe('planExperimentPatch — policyVersion', () => {
  it('a fraction change while running bumps the version', () => {
    const r = plan(state({ status: 'running', startedAt: EARLIER, policyVersion: 3 }), { treatmentFraction: 0.25 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.bumpedPolicyVersion).toBe(true);
    expect(r.value.set.policyVersion).toBe(4);
    expect(r.value.set.treatmentFraction).toBe(0.25);
  });

  it('a config change while running bumps the version', () => {
    const r = plan(state({ status: 'running', startedAt: EARLIER }), { config: { arms: { treatment: { tier: 'premium-plus' } } } });
    expect(r.ok && r.value.set.policyVersion).toBe(2);
  });

  it('a change while paused also bumps — units drawn before the pause stay under the old version', () => {
    const r = plan(state({ status: 'paused', startedAt: EARLIER }), { treatmentFraction: 0.3 });
    expect(r.ok && r.value.set.policyVersion).toBe(2);
  });

  it('a change in draft does not bump: nothing has been drawn yet', () => {
    const r = plan(state(), { treatmentFraction: 0.3, config: { a: 1 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.bumpedPolicyVersion).toBe(false);
    expect('policyVersion' in r.value.set).toBe(false);
  });

  it('re-sending the same fraction or a key-reordered config does not bump', () => {
    const current = state({ status: 'running', startedAt: EARLIER, config: { a: 1, b: { c: 2, d: 3 } } });
    const r = plan(current, { treatmentFraction: 0.5, config: { b: { d: 3, c: 2 }, a: 1 }, title: 'renamed' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.bumpedPolicyVersion).toBe(false);
    expect(r.value.set.title).toBe('renamed');
  });

  it('title / hypothesis / visibility edits never bump', () => {
    const r = plan(state({ status: 'running', startedAt: EARLIER }), { title: 't', hypothesis: 'h', visibility: 'team' });
    expect(r.ok && r.value.bumpedPolicyVersion).toBe(false);
  });

  it('rejects edits to immutable fields', () => {
    for (const f of ['key', 'kind', 'policyVersion', 'startedAt']) {
      const r = plan(state({ status: 'running', startedAt: EARLIER }), { [f]: 'x' });
      expect(r.ok).toBe(false);
    }
  });
});

describe('toExperimentDTO', () => {
  it('omits teamId/createdBy and coerces dates and the fraction', () => {
    const dto = toExperimentDTO({
      id: 'e', key: 'k', title: 't', hypothesis: null, status: 'running', kind: 'model_routing',
      treatmentFraction: '0.5', policyVersion: 1, config: null, visibility: 'team', decision: null,
      startedAt: EARLIER, concludedAt: null, createdAt: EARLIER, updatedAt: NOW,
      ...( { teamId: 'secret-team', createdBy: 'u' } as any),
    });
    expect(dto.treatmentFraction).toBe(0.5);
    expect(dto.startedAt).toBe(EARLIER.toISOString());
    expect(dto.config).toEqual({});
    expect('teamId' in dto).toBe(false);
    expect('createdBy' in dto).toBe(false);
  });
});
