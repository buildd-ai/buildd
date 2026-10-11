import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  POLICY_DEFAULTS,
  parsePolicyOverrides,
  installPolicyOverrides,
  resetPolicyOverrides,
  policyValue,
  setPolicyRefresher,
  type PolicyKey,
} from './policy-overrides';
import { loadPolicyOverrides, resetPolicyOverridesLoader, POLICY_OVERRIDES_TTL_MS } from './policy-overrides-source';
import { evaluateTreadmillBound } from './pr-landing';
import { buildConflictRetryTask } from './conflict-retry';
import { buildCIRetryTask } from './ci-retry';
import { isGreenAutoMergePending } from './auto-merge-grace';
import { classifyDeadZoneAction } from './dead-zone-sweep';

// Arbitrary values that differ from every default — the point is "an override
// wins", not any particular tuning.
const OVERRIDE: Record<PolicyKey, number> = {
  treadmillMaxBaseCommits: 11,
  treadmillMaxRefreshes: 12,
  maxConflictIterations: 13,
  autoMergeGreenGraceMs: 14_000,
  maxCiRetries: 15,
  taskRoleMinConfidencePct: 93,
};

const KEYS = Object.keys(POLICY_DEFAULTS) as PolicyKey[];

beforeEach(() => {
  resetPolicyOverrides();
  resetPolicyOverridesLoader();
});
afterEach(() => resetPolicyOverrides());

describe('policyValue: override → default', () => {
  it('the test overrides differ from every default', () => {
    for (const k of KEYS) expect(OVERRIDE[k]).not.toBe(POLICY_DEFAULTS[k]);
  });

  for (const key of KEYS) {
    it(`${key}: returns the default with no record`, () => {
      expect(policyValue(key)).toBe(POLICY_DEFAULTS[key]);
    });

    it(`${key}: returns the override when one is installed`, () => {
      installPolicyOverrides(parsePolicyOverrides({ values: { [key]: OVERRIDE[key] } }, () => {}));
      expect(policyValue(key)).toBe(OVERRIDE[key]);
    });

    it(`${key}: an invalid override falls back to the default and is logged`, () => {
      for (const bad of ['7', -1, 1.5, null, Number.MAX_SAFE_INTEGER]) {
        const logs: string[] = [];
        installPolicyOverrides(parsePolicyOverrides({ values: { [key]: bad } }, (m) => logs.push(m)));
        expect(policyValue(key)).toBe(POLICY_DEFAULTS[key]);
        expect(logs.some(l => l.includes(key))).toBe(true);
      }
    });
  }

  it('one bad key does not discard the good ones', () => {
    const logs: string[] = [];
    installPolicyOverrides(parsePolicyOverrides({ values: { maxCiRetries: 'x', maxConflictIterations: 9, bogus: 1 } }, (m) => logs.push(m)));
    expect(policyValue('maxCiRetries')).toBe(POLICY_DEFAULTS.maxCiRetries);
    expect(policyValue('maxConflictIterations')).toBe(9);
    expect(logs.some(l => l.includes('bogus'))).toBe(true);
  });

  it('a record that is not an object is logged and yields defaults', () => {
    const logs: string[] = [];
    expect(parsePolicyOverrides('nope', (m) => logs.push(m))).toEqual({ values: {}, roles: {} });
    expect(parsePolicyOverrides({ values: [], roles: 3 }, (m) => logs.push(m))).toEqual({ values: {}, roles: {} });
    expect(logs).toHaveLength(3);
  });

  it('a log line never echoes the rejected value', () => {
    const logs: string[] = [];
    parsePolicyOverrides({ values: { maxCiRetries: 'SECRET-ish' }, roles: { builder: { content: 42 } } }, (m) => logs.push(m));
    expect(logs.join('\n')).not.toContain('SECRET-ish');
    expect(logs.join('\n')).not.toContain('42');
  });

  it('pokes the registered refresher on read', () => {
    let pokes = 0;
    setPolicyRefresher(() => { pokes++; });
    policyValue('maxCiRetries');
    expect(pokes).toBe(1);
  });

  // Next.js compiles instrumentation.ts (which installs the overrides at boot)
  // separately from the route handlers that read them, so this module can exist
  // twice in one process. A query string makes Bun load a second instance.
  it('an override installed through one module copy is read through another', async () => {
    const href = fileURLToPath(new URL('./policy-overrides.ts', import.meta.url));
    const boot = (await import(`${href}?copy=boot`)) as typeof import('./policy-overrides');
    const route = (await import(`${href}?copy=route`)) as typeof import('./policy-overrides');
    expect(route.policyValue).not.toBe(boot.policyValue);
    let pokes = 0;
    boot.setPolicyRefresher(() => { pokes++; });
    boot.installPolicyOverrides(parsePolicyOverrides({ values: { maxCiRetries: OVERRIDE.maxCiRetries } }, () => {}));
    expect(route.policyValue('maxCiRetries')).toBe(OVERRIDE.maxCiRetries);
    expect(pokes).toBe(1);
    expect(policyValue('maxCiRetries')).toBe(OVERRIDE.maxCiRetries);
  });
});

describe('parsePolicyOverrides: roles', () => {
  it('keeps valid fields and drops invalid ones with a log', () => {
    const logs: string[] = [];
    const hash = 'a'.repeat(64);
    const out = parsePolicyOverrides({
      roles: {
        builder: { content: 'X', description: '', version: 0, supersededContentHashes: [hash] },
        reviewer: { content: 5 },
        organizer: 'nope',
      },
    }, (m) => logs.push(m));
    expect(out.roles).toEqual({ builder: { content: 'X', supersededContentHashes: [hash] } });
    expect(logs.length).toBe(4);
  });
});

describe('call sites read the live value', () => {
  it('evaluateTreadmillBound limits on treadmillMaxBaseCommits', () => {
    const input = {
      marker: { pendingHeadSha: 'h' } as never,
      liveHeadSha: 'h',
      baseCommitsSince: POLICY_DEFAULTS.treadmillMaxBaseCommits + 1,
      baseFiles: ['a.ts'],
      prFiles: ['b.ts'],
    };
    expect(evaluateTreadmillBound(input).accepted).toBe(false);
    installPolicyOverrides({ values: { treadmillMaxBaseCommits: OVERRIDE.treadmillMaxBaseCommits }, roles: {} });
    expect(evaluateTreadmillBound(input).accepted).toBe(true);
  });

  it('buildConflictRetryTask stops at maxConflictIterations', () => {
    const at = (iteration: number) => buildConflictRetryTask({
      originalTask: { id: 't', title: 'T', description: null, workspaceId: 'w', context: { conflictIteration: iteration }, missionId: null, pathManifest: null },
      worker: { id: 'wk', branch: 'b', prNumber: 1 },
      headSha: 'abc1234',
      repoFullName: 'o/r',
    } as never);
    expect(at(POLICY_DEFAULTS.maxConflictIterations)).toBeNull();
    installPolicyOverrides({ values: { maxConflictIterations: OVERRIDE.maxConflictIterations }, roles: {} });
    expect(at(POLICY_DEFAULTS.maxConflictIterations)).not.toBeNull();
    expect(at(OVERRIDE.maxConflictIterations)).toBeNull();
  });

  it('buildCIRetryTask stops at maxCiRetries when the workspace sets none', () => {
    const at = (attemptsUsed: number) => buildCIRetryTask({
      originalTask: { id: 't', title: 'T', description: null, workspaceId: 'w', context: {}, missionId: null },
      worker: { id: 'wk', branch: 'b', prNumber: 1 },
      failureContext: 'boom',
      repoFullName: 'o/r',
      attemptsUsed,
    } as never);
    expect(at(POLICY_DEFAULTS.maxCiRetries)).toBeNull();
    installPolicyOverrides({ values: { maxCiRetries: OVERRIDE.maxCiRetries }, roles: {} });
    expect(at(POLICY_DEFAULTS.maxCiRetries)).not.toBeNull();
    expect(at(OVERRIDE.maxCiRetries)).toBeNull();
  });

  it('isGreenAutoMergePending uses autoMergeGreenGraceMs', () => {
    const now = 1_000_000_000;
    // Green for a span between the override and the default window.
    const age = (OVERRIDE.autoMergeGreenGraceMs + POLICY_DEFAULTS.autoMergeGreenGraceMs) / 2;
    const overrideIsShorter = OVERRIDE.autoMergeGreenGraceMs < POLICY_DEFAULTS.autoMergeGreenGraceMs;
    expect(isGreenAutoMergePending('ci_green', new Date(now - age), now)).toBe(overrideIsShorter);
    installPolicyOverrides({ values: { autoMergeGreenGraceMs: OVERRIDE.autoMergeGreenGraceMs }, roles: {} });
    expect(isGreenAutoMergePending('ci_green', new Date(now - age), now)).toBe(!overrideIsShorter);
  });

  it('classifyDeadZoneAction defaults to maxConflictIterations', () => {
    expect(classifyDeadZoneAction(0, POLICY_DEFAULTS.maxConflictIterations)).toBe('exhaust');
    installPolicyOverrides({ values: { maxConflictIterations: OVERRIDE.maxConflictIterations }, roles: {} });
    expect(classifyDeadZoneAction(0, POLICY_DEFAULTS.maxConflictIterations)).toBe('spark');
  });
});

describe('loadPolicyOverrides', () => {
  it('installs a stored record', async () => {
    await loadPolicyOverrides({ read: async () => ({ values: { maxCiRetries: 9 } }) });
    expect(policyValue('maxCiRetries')).toBe(9);
  });

  it('a missing record leaves the defaults and logs once', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    try {
      let t = 0;
      await loadPolicyOverrides({ read: async () => undefined, now: () => t });
      t += POLICY_OVERRIDES_TTL_MS + 1;
      await loadPolicyOverrides({ read: async () => undefined, now: () => t });
      expect(policyValue('maxCiRetries')).toBe(POLICY_DEFAULTS.maxCiRetries);
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
    }
  });

  it('a failed read keeps the values in effect and logs', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await loadPolicyOverrides({ read: async () => ({ values: { maxCiRetries: 9 } }), now: () => 0 });
      await loadPolicyOverrides({ force: true, read: async () => { throw new Error('db down'); } });
      expect(policyValue('maxCiRetries')).toBe(9);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('an invalid stored value falls back to the default and logs', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await loadPolicyOverrides({ read: async () => ({ values: { maxCiRetries: -4 } }) });
      expect(policyValue('maxCiRetries')).toBe(POLICY_DEFAULTS.maxCiRetries);
      expect(warn.mock.calls.some(c => String(c[0]).includes('maxCiRetries'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads at most once per TTL', async () => {
    let reads = 0;
    let t = 1;
    const read = async () => { reads++; return {}; };
    await loadPolicyOverrides({ read, now: () => t });
    t += POLICY_OVERRIDES_TTL_MS - 1;
    await loadPolicyOverrides({ read, now: () => t });
    expect(reads).toBe(1);
    t += 2;
    await loadPolicyOverrides({ read, now: () => t });
    expect(reads).toBe(2);
  });
});
