import { describe, it, expect } from 'bun:test';
import {
  compareCliVersions,
  checkModelClientCapability,
  MODEL_MIN_CLI_VERSION,
  makeCatalogServabilityCheck,
} from '../model-capability-requirements';

describe('compareCliVersions', () => {
  it('reports equal versions as 0', () => {
    expect(compareCliVersions('2.1.251', '2.1.251')).toBe(0);
  });

  it('reports a lower patch as -1', () => {
    expect(compareCliVersions('2.1.238', '2.1.251')).toBe(-1);
  });

  it('reports a higher patch as 1', () => {
    expect(compareCliVersions('2.1.272', '2.1.251')).toBe(1);
  });

  it('compares minor/major components before patch', () => {
    expect(compareCliVersions('2.0.999', '2.1.0')).toBe(-1);
    expect(compareCliVersions('3.0.0', '2.1.251')).toBe(1);
  });

  it('treats missing trailing components as 0', () => {
    expect(compareCliVersions('2.1', '2.1.0')).toBe(0);
  });
});

describe('checkModelClientCapability', () => {
  const requiredVersion = MODEL_MIN_CLI_VERSION['claude-fable-5-1'];

  it('refuses a runner whose CLI predates the model floor', () => {
    const result = checkModelClientCapability('claude-fable-5-1', '2.1.238');
    expect(result).toEqual({ ok: false, requiredVersion });
  });

  it('allows a runner whose CLI meets the model floor exactly', () => {
    expect(checkModelClientCapability('claude-fable-5-1', requiredVersion)).toEqual({ ok: true });
  });

  it('allows a runner whose CLI exceeds the model floor', () => {
    expect(checkModelClientCapability('claude-fable-5-1', '2.1.272')).toEqual({ ok: true });
  });

  it('fails open when the model has no known floor', () => {
    expect(checkModelClientCapability('claude-sonnet-5', '0.0.1')).toEqual({ ok: true });
  });

  it('fails open when the runner reports no CLI version', () => {
    expect(checkModelClientCapability('claude-fable-5-1', undefined)).toEqual({ ok: true });
    expect(checkModelClientCapability('claude-fable-5-1', null)).toEqual({ ok: true });
  });
});

describe('claude-opus-5-5 floor', () => {
  // A catalog-picked premium model with no floor here passes the claim gate and
  // then 400s on every attempt from an older runner CLI.
  it('refuses a runner below the floor the API names for it', () => {
    expect(checkModelClientCapability('claude-opus-5-5', '2.1.272')).toEqual({
      ok: false,
      requiredVersion: '2.1.280',
    });
  });

  it('allows a runner at the floor', () => {
    expect(checkModelClientCapability('claude-opus-5-5', '2.1.280')).toEqual({ ok: true });
  });
});

describe('makeCatalogServabilityCheck — unknown models fail closed', () => {
  const DAY = 86_400;
  const T0 = 1_780_000_000;
  const entry = (id: string, created: number) => ({ id, canonicalId: null, created });
  // The newest model the floor table knows about anchors "recognized".
  const newestKnown = entry('claude-opus-5-5', T0);

  it('refuses a catalog model released after the newest recorded model, from an old CLI', () => {
    const catalog = [entry('claude-sonnet-5', T0 - 30 * DAY), newestKnown, entry('claude-opus-6', T0 + 10 * DAY)];
    expect(makeCatalogServabilityCheck(catalog, '2.1.272')('claude-opus-6')).toBe(false);
  });

  it('refuses it from a current CLI too — its floor is unknown, not absent', () => {
    const catalog = [newestKnown, entry('claude-opus-6', T0 + 10 * DAY)];
    expect(makeCatalogServabilityCheck(catalog, '2.1.280')('claude-opus-6')).toBe(false);
  });

  it('refuses it when the runner reports no CLI version', () => {
    const catalog = [newestKnown, entry('claude-opus-6', T0 + 10 * DAY)];
    expect(makeCatalogServabilityCheck(catalog, undefined)('claude-opus-6')).toBe(false);
  });

  it('keeps an unknown model released before the newest recorded model servable', () => {
    const catalog = [entry('claude-sonnet-5', T0 - 30 * DAY), newestKnown];
    expect(makeCatalogServabilityCheck(catalog, '0.0.1')('claude-sonnet-5')).toBe(true);
  });

  it('treats a same-day sibling of the newest recorded model as recognized', () => {
    const catalog = [newestKnown, entry('claude-sonnet-6', T0 + 60)];
    expect(makeCatalogServabilityCheck(catalog, '2.1.280')('claude-sonnet-6')).toBe(true);
  });

  it('still applies the recorded floor to a known model', () => {
    const catalog = [newestKnown];
    expect(makeCatalogServabilityCheck(catalog, '2.1.272')('claude-opus-5-5')).toBe(false);
    expect(makeCatalogServabilityCheck(catalog, '2.1.280')('claude-opus-5-5')).toBe(true);
  });

  it('recognizes a table model by its canonical id', () => {
    const catalog = [
      { id: 'claude-opus-5-5-alias', canonicalId: 'claude-opus-5-5', created: T0 },
      entry('claude-opus-6', T0 + 10 * DAY),
    ];
    expect(makeCatalogServabilityCheck(catalog, '2.1.280')('claude-opus-6')).toBe(false);
  });

  it('fails closed on every unknown model when no recorded model is in the catalog', () => {
    const catalog = [entry('claude-sonnet-5', T0)];
    expect(makeCatalogServabilityCheck(catalog, '2.1.280')('claude-sonnet-5')).toBe(false);
  });

  it('refuses an id that is not in the catalog at all', () => {
    expect(makeCatalogServabilityCheck([newestKnown], '2.1.280')('claude-ghost')).toBe(false);
  });

  it('refuses an unrecorded model with no release time — missing data is not "old"', () => {
    const catalog = [newestKnown, entry('claude-mystery', 0)];
    expect(makeCatalogServabilityCheck(catalog, '2.1.280')('claude-mystery')).toBe(false);
  });

  it('does not mistake an Object.prototype key for a recorded model', () => {
    const catalog = [newestKnown, entry('constructor', T0 + 10 * DAY), entry('toString', T0 + 10 * DAY)];
    const check = makeCatalogServabilityCheck(catalog, '2.1.280');
    expect(check('constructor')).toBe(false);
    expect(check('toString')).toBe(false);
  });

  it('reports each refused unrecognized id with the reason', () => {
    const seen: Array<[string, string]> = [];
    const onUnrecognized = (id: string, reason: string) => { seen.push([id, reason]); };
    const catalog = [newestKnown, entry('claude-opus-6', T0 + 10 * DAY), entry('claude-mystery', 0)];
    const check = makeCatalogServabilityCheck(catalog, '2.1.280', { onUnrecognized });
    check('claude-opus-6');
    check('claude-mystery');
    check('claude-opus-5-5');
    expect(seen).toEqual([
      ['claude-opus-6', 'newer_than_floor_table'],
      ['claude-mystery', 'missing_release_time'],
    ]);

    const orphaned: Array<[string, string]> = [];
    makeCatalogServabilityCheck([entry('claude-sonnet-5', T0)], '2.1.280', {
      onUnrecognized: (id, reason) => { orphaned.push([id, reason]); },
    })('claude-sonnet-5');
    expect(orphaned).toEqual([['claude-sonnet-5', 'no_recorded_model_in_catalog']]);
  });
});

describe('checkModelClientCapability — prototype keys', () => {
  it('treats an Object.prototype key as having no recorded floor', () => {
    expect(checkModelClientCapability('constructor', '2.1.0')).toEqual({ ok: true });
    expect(checkModelClientCapability('toString', '2.1.0')).toEqual({ ok: true });
  });
});

describe('claude-sonnet-5-5 floor', () => {
  it('refuses a runner immediately below the first supporting CLI release', () => {
    expect(checkModelClientCapability('claude-sonnet-5-5', '2.1.283')).toEqual({
      ok: false, requiredVersion: '2.1.284',
    });
  });

  it('allows runners at or above the floor', () => {
    for (const version of ['2.1.284', '2.1.290']) {
      expect(checkModelClientCapability('claude-sonnet-5-5', version)).toEqual({ ok: true });
    }
  });

  it('applies the floor when selecting a catalog model', () => {
    const catalog = [{ id: 'claude-sonnet-5-5', canonicalId: null, created: 1_790_000_000 }];
    expect(makeCatalogServabilityCheck(catalog, '2.1.283')('claude-sonnet-5-5')).toBe(false);
    expect(makeCatalogServabilityCheck(catalog, '2.1.284')('claude-sonnet-5-5')).toBe(true);
  });
});

// Fable 5.2 first shipped in Claude Code 2.1.321:
// https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21321
// It is the premium-plus default, so a runner whose CLI serves Fable 5.1
// (floor 2.1.251) but predates 2.1.321 must be DEFERRED by the claim gate, not
// handed a worker that 400s at launch.
describe('claude-fable-5-2 floor', () => {
  it('refuses a runner immediately below the first supporting CLI release', () => {
    expect(checkModelClientCapability('claude-fable-5-2', '2.1.320')).toEqual({
      ok: false, requiredVersion: '2.1.321',
    });
  });

  it('refuses a runner that serves Fable 5.1 but predates 5.2', () => {
    const serves51 = '2.1.316';
    expect(checkModelClientCapability('claude-fable-5-1', serves51)).toEqual({ ok: true });
    expect(checkModelClientCapability('claude-fable-5-2', serves51)).toEqual({
      ok: false, requiredVersion: '2.1.321',
    });
  });

  it('allows runners at or above the floor', () => {
    for (const version of ['2.1.321', '2.1.325']) {
      expect(checkModelClientCapability('claude-fable-5-2', version)).toEqual({ ok: true });
    }
  });

  it('applies the floor when selecting a catalog model', () => {
    const catalog = [{ id: 'claude-fable-5-2', canonicalId: null, created: 1_794_253_781 }];
    expect(makeCatalogServabilityCheck(catalog, '2.1.320')('claude-fable-5-2')).toBe(false);
    expect(makeCatalogServabilityCheck(catalog, '2.1.321')('claude-fable-5-2')).toBe(true);
  });

  it('the old premium-plus model keeps its own floor, so a pin to it is still served', () => {
    expect(checkModelClientCapability('claude-fable-5-1', '2.1.251')).toEqual({ ok: true });
  });
});

// Haiku 5.5 first shipped in Claude Code 2.1.293:
// https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21293
// Without the row, a registry row naming it was refused as newer_than_floor_table
// on every claim and silently served Haiku 4.5.
describe('claude-haiku-5-5 floor', () => {
  it('refuses a runner immediately below the first supporting CLI release', () => {
    expect(checkModelClientCapability('claude-haiku-5-5', '2.1.292')).toEqual({
      ok: false, requiredVersion: '2.1.293',
    });
    expect(checkModelClientCapability('claude-haiku-5-5', '2.1.290')).toEqual({
      ok: false, requiredVersion: '2.1.293',
    });
  });

  it('allows runners at or above the floor', () => {
    for (const version of ['2.1.293', '2.1.296', '2.1.310']) {
      expect(checkModelClientCapability('claude-haiku-5-5', version)).toEqual({ ok: true });
    }
  });

  it('applies the floor when selecting a catalog model', () => {
    const catalog = [{ id: 'claude-haiku-5-5', canonicalId: null, created: 1_795_000_000 }];
    expect(makeCatalogServabilityCheck(catalog, '2.1.292')('claude-haiku-5-5')).toBe(false);
    expect(makeCatalogServabilityCheck(catalog, '2.1.293')('claude-haiku-5-5')).toBe(true);
  });
});
