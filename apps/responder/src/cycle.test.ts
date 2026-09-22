import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { decideNotifications, renderPage, runCycle } from './cycle';
import { EMPTY_STATE, evidenceFileName, loadState, readEvidence } from './evidence';
import type { EvidenceRecord, ResponderState } from './evidence';
import type { Page, NotifyResult } from './notify';
import type { Detector, Snapshot, Verdict } from './types';

const T0 = Date.parse('2026-01-02T12:00:00.000Z');
const HOUR = 3_600_000;
const RENOTIFY_HOURS = 24;

function verdict(over: Partial<Verdict> & { state: Verdict['state'] }): Verdict {
  return {
    detector: 'test-detector',
    conditionKey: over.state === 'blind' ? 'test-detector:blind' : 'test-detector',
    summary: 'Test condition tripped at 2026-01-02T10:00:00.000Z',
    onsetAt: '2026-01-02T10:00:00.000Z',
    facts: { alarmStreak: 2 },
    ...over,
  };
}

function stateWithPage(conditionKey: string, lastNotifiedAt: string): ResponderState {
  return {
    ...EMPTY_STATE,
    notified: {
      [conditionKey]: {
        firstNotifiedAt: lastNotifiedAt,
        lastNotifiedAt,
        onsetAt: '2026-01-02T10:00:00.000Z',
        pageCount: 1,
      },
    },
  };
}

describe('onset pages, persistence does not', () => {
  test('a newly firing condition pages', () => {
    const [decision] = decideNotifications([verdict({ state: 'firing' })], EMPTY_STATE, T0, RENOTIFY_HOURS);
    expect(decision!.action).toBe('notify');
    expect(decision!.trigger).toBe('onset');
  });

  test('the same condition inside the renotify window is suppressed', () => {
    // The outage that motivated this ran fourteen hourly ticks. Paging on each
    // of them is how a detector earns itself an ignored channel.
    const state = stateWithPage('test-detector', new Date(T0 - 2 * HOUR).toISOString());
    const [decision] = decideNotifications([verdict({ state: 'firing' })], state, T0, RENOTIFY_HOURS);
    expect(decision!.action).toBe('suppress');
    expect(decision!.reason).toBe('within_renotify_window');
    expect(decision!.nextEligibleAt).toBe(
      new Date(T0 - 2 * HOUR + RENOTIFY_HOURS * HOUR).toISOString(),
    );
  });

  test('past the renotify window it pages again', () => {
    const state = stateWithPage('test-detector', new Date(T0 - RENOTIFY_HOURS * HOUR).toISOString());
    const [decision] = decideNotifications([verdict({ state: 'firing' })], state, T0, RENOTIFY_HOURS);
    expect(decision!.action).toBe('notify');
    expect(decision!.trigger).toBe('renotify');
  });

  test('the renotify window matches the queue-stall convention', () => {
    // apps/web/src/app/api/cron/queue-stall/route.ts → RENOTIFY_HOURS = 24.
    // One convention across the codebase, not a second one invented here.
    const justInside = stateWithPage('c', new Date(T0 - (RENOTIFY_HOURS * HOUR - 60_000)).toISOString());
    expect(
      decideNotifications([verdict({ state: 'firing', conditionKey: 'c' })], justInside, T0, 24)[0]!.action,
    ).toBe('suppress');
  });
});

describe('clearing resets the window', () => {
  test('a clear verdict for a paged condition records a clear and drops the window', () => {
    const state = stateWithPage('test-detector', new Date(T0 - HOUR).toISOString());
    const [decision] = decideNotifications([verdict({ state: 'clear', onsetAt: null })], state, T0, RENOTIFY_HOURS);
    expect(decision!.action).toBe('clear');
    expect(decision!.nextState.notified['test-detector']).toBeUndefined();
  });

  test('a clear verdict for a condition that never paged decides nothing at all', () => {
    const decisions = decideNotifications([verdict({ state: 'clear', onsetAt: null })], EMPTY_STATE, T0, RENOTIFY_HOURS);
    expect(decisions).toEqual([]);
  });

  test('after clearing, a recurrence pages immediately rather than waiting out the window', () => {
    let state = stateWithPage('test-detector', new Date(T0 - HOUR).toISOString());
    state = decideNotifications([verdict({ state: 'clear', onsetAt: null })], state, T0, RENOTIFY_HOURS)[0]!.nextState;
    const [again] = decideNotifications([verdict({ state: 'firing' })], state, T0 + 60_000, RENOTIFY_HOURS);
    expect(again!.action).toBe('notify');
    expect(again!.trigger).toBe('onset');
  });
});

describe('blind and firing are separate pages', () => {
  test('a detector going blind mid-outage does not read as the outage clearing', () => {
    const state = stateWithPage('test-detector', new Date(T0 - HOUR).toISOString());
    const decisions = decideNotifications([verdict({ state: 'blind' })], state, T0, RENOTIFY_HOURS);
    const keys = decisions.map(d => d.verdict.conditionKey);
    expect(keys).toContain('test-detector:blind');
    // The firing window is NOT cleared -- nothing observed the condition
    // stopping, so claiming it did would be a lie.
    const blindDecision = decisions.find(d => d.action === 'notify')!;
    expect(blindDecision.nextState.notified['test-detector']).toBeDefined();
  });

  test('a blind condition has its own renotify window', () => {
    const state = stateWithPage('test-detector:blind', new Date(T0 - HOUR).toISOString());
    const [decision] = decideNotifications([verdict({ state: 'blind' })], state, T0, RENOTIFY_HOURS);
    expect(decision!.action).toBe('suppress');
  });
});

describe('warming is silent', () => {
  test('a warming verdict never pages and never suppresses', () => {
    const decisions = decideNotifications([verdict({ state: 'warming', onsetAt: null })], EMPTY_STATE, T0, RENOTIFY_HOURS);
    expect(decisions.map(d => d.action)).toEqual(['record']);
  });
});

describe('the page stands alone without a model', () => {
  test('renderPage names the condition and the onset with no narrative', () => {
    const page = renderPage(verdict({ state: 'firing' }), null, {
      appVersion: null,
      runnerVersion: null,
    });
    expect(page.title).toContain('test-detector');
    expect(page.message).toContain('2026-01-02T10:00:00.000Z');
    expect(page.message).toContain('Test condition tripped');
    expect(page.priority).toBe(1);
  });

  test('a narrative is appended, never substituted for the summary', () => {
    const page = renderPage(verdict({ state: 'firing' }), 'A model wrote this.', {
      appVersion: null,
      runnerVersion: null,
    });
    expect(page.message).toContain('Test condition tripped');
    expect(page.message).toContain('A model wrote this.');
  });

  test('deployed version is carried when known — the release-correlation hook', () => {
    const page = renderPage(verdict({ state: 'firing' }), null, {
      appVersion: { latestCommit: 'abc1234' },
      runnerVersion: { version: '0.0.0-illustrative' },
    });
    expect(page.message).toContain('abc1234');
    expect(page.message).toContain('0.0.0-illustrative');
  });
});

describe('runCycle end to end', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'responder-cycle-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const firingDetector: Detector = {
    id: 'always-firing',
    describes: 'A detector that always fires, for testing the cycle wiring.',
    evaluate: () =>
      verdict({ state: 'firing', detector: 'always-firing', conditionKey: 'always-firing' }),
  };

  function snapshot(): Snapshot {
    return {
      at: new Date(T0).toISOString(),
      claimSamples: [],
      cronRuns: [],
      appVersion: null,
      runnerVersion: null,
      samplingSince: null,
    };
  }

  function records(): EvidenceRecord[] {
    return readEvidence(dir, evidenceFileName(new Date(T0).toISOString()));
  }

  test('pages on the first cycle, records evidence, and persists the window', async () => {
    const sent: Page[] = [];
    const notify = async (page: Page): Promise<NotifyResult> => {
      sent.push(page);
      return { ok: true, status: 200 };
    };

    await runCycle({
      stateDir: dir,
      detectors: [firingDetector],
      snapshot: snapshot(),
      state: EMPTY_STATE,
      now: T0,
      renotifyHours: RENOTIFY_HOURS,
      notify,
      narrate: async () => null,
      narrativeTimeoutMs: 100,
      hasNarrativeCredential: false,
    });

    expect(sent).toHaveLength(1);
    expect(loadState(dir).notified['always-firing']?.pageCount).toBe(1);

    const kinds = records().map(r => r.kind);
    expect(kinds).toContain('cycle');
    expect(kinds).toContain('notified');

    const notified = records().find(r => r.kind === 'notified')!;
    expect(notified).toMatchObject({ trigger: 'onset', narrative: 'no-credential' });
  });

  test('the second cycle suppresses and says so in the evidence log', async () => {
    const sent: Page[] = [];
    const notify = async (page: Page): Promise<NotifyResult> => {
      sent.push(page);
      return { ok: true, status: 200 };
    };
    const common = {
      stateDir: dir,
      detectors: [firingDetector],
      snapshot: snapshot(),
      renotifyHours: RENOTIFY_HOURS,
      notify,
      narrate: async () => null,
      narrativeTimeoutMs: 100,
      hasNarrativeCredential: false,
    };

    const first = await runCycle({ ...common, state: EMPTY_STATE, now: T0 });
    await runCycle({ ...common, state: first.state, now: T0 + HOUR });

    expect(sent).toHaveLength(1);
    const suppressed = records().filter(r => r.kind === 'suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({
      conditionKey: 'always-firing',
      reason: 'within_renotify_window',
    });
  });

  test('a failed page is recorded, and does NOT open a renotify window', async () => {
    // Otherwise a transport failure would be indistinguishable from a
    // delivered page and would silence the condition for a whole window.
    const result = await runCycle({
      stateDir: dir,
      detectors: [firingDetector],
      snapshot: snapshot(),
      state: EMPTY_STATE,
      now: T0,
      renotifyHours: RENOTIFY_HOURS,
      notify: async () => ({ ok: false, status: 500, error: 'pushover returned 500' }),
      narrate: async () => null,
      narrativeTimeoutMs: 100,
      hasNarrativeCredential: false,
    });

    expect(result.state.notified['always-firing']).toBeUndefined();
    expect(records().map(r => r.kind)).toContain('notify_failed');
  });

  test('a narrator that throws does not stop the page', async () => {
    const sent: Page[] = [];
    await runCycle({
      stateDir: dir,
      detectors: [firingDetector],
      snapshot: snapshot(),
      state: EMPTY_STATE,
      now: T0,
      renotifyHours: RENOTIFY_HOURS,
      notify: async page => {
        sent.push(page);
        return { ok: true, status: 200 };
      },
      narrate: async () => {
        throw new Error('model credential expired');
      },
      narrativeTimeoutMs: 100,
      hasNarrativeCredential: true,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain('Test condition tripped');
    expect(records().find(r => r.kind === 'notified')).toMatchObject({
      narrative: 'unavailable',
    });
  });

  test('a narrator that hangs past its budget does not stop the page', async () => {
    const sent: Page[] = [];
    await runCycle({
      stateDir: dir,
      detectors: [firingDetector],
      snapshot: snapshot(),
      state: EMPTY_STATE,
      now: T0,
      renotifyHours: RENOTIFY_HOURS,
      notify: async page => {
        sent.push(page);
        return { ok: true, status: 200 };
      },
      narrate: () => new Promise(() => {}),
      narrativeTimeoutMs: 20,
      hasNarrativeCredential: true,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain('Test condition tripped');
  });

  test('a detector that throws does not take the cycle down with it', async () => {
    const sent: Page[] = [];
    const exploding: Detector = {
      id: 'exploding',
      describes: 'Throws, to prove one bad detector cannot silence the others.',
      evaluate: () => {
        throw new Error('bad snapshot shape');
      },
    };
    const result = await runCycle({
      stateDir: dir,
      detectors: [exploding, firingDetector],
      snapshot: snapshot(),
      state: EMPTY_STATE,
      now: T0,
      renotifyHours: RENOTIFY_HOURS,
      notify: async page => {
        sent.push(page);
        return { ok: true, status: 200 };
      },
      narrate: async () => null,
      narrativeTimeoutMs: 100,
      hasNarrativeCredential: false,
    });

    // The healthy detector still paged...
    expect(sent.map(p => p.title).join()).toContain('always-firing');
    // ...and the broken one is reported as blind rather than swallowed.
    const blind = result.verdicts.find(v => v.detector === 'exploding');
    expect(blind?.state).toBe('blind');
    expect(sent.map(p => p.title).join()).toContain('exploding');
  });

  test('observe-only: the cycle exposes no action surface at all', () => {
    // A guard against the next phase leaking in early. runCycle returns state
    // and verdicts; there is nothing here that can restart, roll back or
    // mutate anything.
    expect(Object.keys(runCycle)).toEqual([]);
    expect(runCycle.length).toBe(1);
  });
});
