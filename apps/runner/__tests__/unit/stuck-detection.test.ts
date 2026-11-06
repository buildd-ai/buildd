/**
 * Acceptance tests for "In-session stuck detection: error streaks and alternation"
 * (Living Spec 773d2851, revision 1). Written before the build: they import the
 * pure module apps/runner/src/stuck-detection.ts (R-2), which does not exist yet.
 *
 * Contract these tests pin (the builder implements to it):
 *   - createStuckState(): per-worker scenario state (latches, R-8). Mutated by evaluateStuck.
 *   - parseStuckMode(raw): 'off' | 'log' | 'nudge'; anything else/undefined -> 'log' (R-6).
 *   - evaluateStuck({ calls, state, mode, redact? }) ->
 *       { action: 'none' | 'signal' | 'nudge', scenario?, message?, signal? }
 *       'signal' = log-only (nothing to inject), 'nudge' = inject `message`.
 *       signal = { scenario: 'error_streak' | 'alternation', length, tools: string[], callIndex }
 *       (no inputs, no result text; R-10). Never an abort, never an error (R-9).
 *   - StuckCall = { id, name, timestamp, input?, isError?, resultSignature?, errorLine?,
 *       nonExecutionKind? }; `calls` is worker.toolCalls (oldest first).
 *   - detectRepetitiveToolCalls(calls): the existing repeat guard, moved unchanged (R-1).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/stuck-detection.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  createStuckState,
  detectRepetitiveToolCalls,
  evaluateStuck,
  parseStuckMode,
  resultSignature,
  type StuckCall,
} from '../../src/stuck-detection';

let seq = 0;
function call(
  name: string,
  input: Record<string, unknown>,
  opts: Partial<StuckCall> & { fail?: boolean } = {},
): StuckCall {
  const { fail, ...rest } = opts;
  seq += 1;
  return {
    id: `toolu_${seq}`,
    name,
    timestamp: seq,
    input,
    isError: fail ?? false,
    resultSignature: `sig:${name}:${JSON.stringify(input)}`,
    errorLine: fail ? `error ${seq}: something failed` : undefined,
    ...rest,
  };
}
const failBash = (n: number, opts: Partial<StuckCall> = {}) => call('Bash', { command: `make target-${n}` }, { fail: true, ...opts });
const failEdit = (n: number) => call('Edit', { file_path: '/src/a.ts', old_string: `a${n}`, new_string: `b${n}` }, { fail: true });
const run = (calls: StuckCall[], mode: 'off' | 'log' | 'nudge' = 'nudge', redact?: (s: string) => string) =>
  evaluateStuck({ calls, state: createStuckState(), mode, redact });

describe('stuck detection', () => {
  test('AC-1: the repeat guard is exported from the module and keeps its behaviour', () => {
    expect(typeof detectRepetitiveToolCalls).toBe('function');
    expect(detectRepetitiveToolCalls([]).action).toBe('none');
    const same = Array.from({ length: 5 }, () => ({ name: 'Read', timestamp: 1, input: { file_path: '/a.ts' } }));
    expect(detectRepetitiveToolCalls(same).action).toBe('nudge');
  });

  test('AC-2: 6 failing counted calls with 3+ distinct inputs report an error streak', () => {
    const calls = [failBash(1), failBash(2), failBash(3), failBash(4), failEdit(1), failEdit(2)];
    const r = run(calls);
    expect(r.action).toBe('nudge');
    expect(r.signal?.scenario).toBe('error_streak');
    expect(r.signal?.length).toBe(6);
  });

  test('AC-2: 5 failures do not report an error streak', () => {
    expect(run([failBash(1), failBash(2), failBash(3), failBash(4), failBash(5)]).action).toBe('none');
  });

  test('AC-2: 6 failures with only 2 distinct inputs do not report an error streak', () => {
    const calls = [failBash(1), failBash(2), failBash(1), failBash(2), failBash(1), failBash(2)];
    expect(run(calls).signal?.scenario).not.toBe('error_streak');
    expect(run(calls).action === 'none' || run(calls).signal?.scenario === 'alternation').toBe(true);
  });

  test('AC-3: 6 failing calls with one identical input: no error streak, existing check nudges at 5', () => {
    const calls = Array.from({ length: 6 }, () => call('Bash', { command: 'make build' }, { fail: true }));
    const r = run(calls);
    expect(r.action).toBe('none');
    const existing = detectRepetitiveToolCalls(calls.slice(0, 5));
    expect(existing.action).toBe('nudge');
  });

  test('AC-4: 20 failing exploration calls, a silent failing grep and denied calls fire neither scenario', () => {
    const noise: StuckCall[] = [];
    for (let i = 0; i < 5; i++) {
      noise.push(call('Read', { file_path: `/missing/${i}.ts` }, { fail: true }));
      noise.push(call('Grep', { pattern: `p${i}` }, { fail: true }));
      noise.push(call('Glob', { pattern: `**/*.x${i}` }, { fail: true }));
      noise.push(call('Bash', { command: `ls /nope${i}` }, { fail: true }));
    }
    noise.push(call('Bash', { command: 'grep -r needle src' }, { fail: true, errorLine: '' }));
    noise.push(call('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' }, { fail: true, nonExecutionKind: 'permission_denied' }));
    noise.push(call('Bash', { command: 'make denied' }, { fail: true, nonExecutionKind: 'permission_denied' }));
    expect(run(noise).action).toBe('none');
  });

  test('AC-4: interleaved exploration neither completes nor resets a 5-failure action streak', () => {
    const noise = (i: number) => call('Read', { file_path: `/missing/${i}` }, { fail: true });
    const five = [failBash(1), noise(1), failBash(2), noise(2), failEdit(3), noise(3), failBash(4), noise(4), failBash(5), noise(5)];
    expect(run(five).action).toBe('none'); // noise does not complete it to 6
    const six = [failBash(1), noise(1), failBash(2), noise(2), failEdit(3), noise(3), failBash(4), noise(4), failBash(5), noise(5), failBash(6)];
    expect(run(six).signal?.scenario).toBe('error_streak'); // noise did not reset it
  });

  test('AC-5: 5 failures, a successful Edit, then 5 failures is no error streak', () => {
    const calls = [
      failBash(1), failBash(2), failBash(3), failBash(4), failBash(5),
      call('Edit', { file_path: '/src/a.ts', old_string: 'q', new_string: 'r' }),
      failBash(6), failBash(7), failBash(8), failBash(9), failBash(10),
    ];
    expect(run(calls).action).toBe('none');
  });

  const A = (): StuckCall => call('Bash', { command: 'pnpm build' });
  const B = (): StuckCall => call('Edit', { file_path: '/src/a.ts', old_string: 'x', new_string: 'y' });
  const alt = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? A() : B()));

  test('AC-6: A,B x4 with a stable result signature per key reports alternation', () => {
    const r = run(alt(8));
    expect(r.action).toBe('nudge');
    expect(r.signal?.scenario).toBe('alternation');
    expect(r.message).toContain('Bash');
    expect(r.message).toContain('Edit');
  });

  test('AC-6: 7 alternating calls do not report alternation', () => {
    expect(run(alt(7)).action).toBe('none');
  });

  test('AC-6: a third key inside the window does not report alternation', () => {
    const calls = alt(8);
    calls[3] = call('Bash', { command: 'something else' });
    expect(run(calls).action).toBe('none');
  });

  test('AC-7: alternating gh run view and sleep 60 (polling) never fires', () => {
    const calls = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0 ? call('Bash', { command: 'gh run view 123' }) : call('Bash', { command: 'sleep 60' }));
    expect(run(calls).action).toBe('none');
  });

  test('AC-7: alternation whose result signatures change between repeats never fires', () => {
    const calls = alt(8).map((c, i) => ({ ...c, resultSignature: `sig-${i}` }));
    expect(run(calls).action).toBe('none');
  });

  test('AC-8: mode log records one signal and enqueues nothing', () => {
    const calls = [failBash(1), failBash(2), failBash(3), failBash(4), failEdit(1), failEdit(2)];
    const r = run(calls, 'log');
    expect(r.action).toBe('signal');
    expect(r.message).toBeUndefined();
    expect(r.signal).toMatchObject({ scenario: 'error_streak', length: 6 });
    expect(typeof r.signal?.callIndex).toBe('number');
    expect(r.signal?.tools).toContain('Bash');
    // R-10: the record carries no inputs and no result text.
    const serialized = JSON.stringify(r.signal);
    expect(serialized).not.toContain('make target');
    expect(serialized).not.toContain('something failed');
  });

  test('AC-8: mode off evaluates nothing', () => {
    const calls = [failBash(1), failBash(2), failBash(3), failBash(4), failEdit(1), failEdit(2)];
    const r = run(calls, 'off');
    expect(r.action).toBe('none');
    expect(r.signal).toBeUndefined();
  });

  test('AC-8: mode nudge enqueues one message', () => {
    const calls = [failBash(1), failBash(2), failBash(3), failBash(4), failEdit(1), failEdit(2)];
    const r = run(calls, 'nudge');
    expect(r.action).toBe('nudge');
    expect(typeof r.message).toBe('string');
  });

  test('AC-8: BUILDD_STUCK_DETECTION defaults to log and parses off/log/nudge', () => {
    expect(parseStuckMode(undefined)).toBe('log');
    expect(parseStuckMode('')).toBe('log');
    expect(parseStuckMode('bogus')).toBe('log');
    expect(parseStuckMode('off')).toBe('off');
    expect(parseStuckMode('log')).toBe('log');
    expect(parseStuckMode('nudge')).toBe('nudge');
  });

  test('AC-9: a streak that nudged does not nudge again at 12; a new streak after a success nudges once more', () => {
    const state = createStuckState();
    const calls: StuckCall[] = [];
    let nudges = 0;
    const push = (c: StuckCall) => {
      calls.push(c);
      if (evaluateStuck({ calls, state, mode: 'nudge' }).action === 'nudge') nudges += 1;
    };
    for (let i = 1; i <= 12; i++) push(i % 2 ? failBash(i) : failEdit(i));
    expect(nudges).toBe(1);
    push(call('Edit', { file_path: '/src/ok.ts', old_string: 'o', new_string: 'k' })); // success ends the streak
    expect(nudges).toBe(1);
    for (let i = 20; i < 26; i++) push(i % 2 ? failBash(i) : failEdit(i));
    expect(nudges).toBe(2);
  });

  test('AC-10: nudge names tool and count, truncates the last error line to 160 chars and redacts secrets', () => {
    const secret = 'sk-live-SUPERSECRETVALUE123';
    const long = `boom ${secret} ${'x'.repeat(300)} TAILMARKER`;
    const calls = [failBash(1), failBash(2), failBash(3), failBash(4), failBash(5), failBash(6, { errorLine: long })];
    const redact = (s: string) => s.split(secret).join('[REDACTED]');
    const r = run(calls, 'nudge', redact);
    expect(r.action).toBe('nudge');
    expect(r.message).toContain('Bash');
    expect(r.message).toContain('6');
    expect(r.message).toContain('[REDACTED]');
    expect(r.message).not.toContain(secret);
    expect(r.message).not.toContain('SUPERSECRET');
    expect(r.message).not.toContain('TAILMARKER');
    const line = (r.message as string).match(/Latest error: (.*?)\. Stop repeating/s)?.[1] ?? '';
    expect(line.length).toBeGreaterThan(0);
    expect(line.length).toBeLessThanOrEqual(160);
  });

  test('AC-11: 100 failing varied calls never produce an abort or error, in any mode', () => {
    for (const mode of ['off', 'log', 'nudge'] as const) {
      const state = createStuckState();
      const calls: StuckCall[] = [];
      for (let i = 0; i < 100; i++) {
        calls.push(i % 2 ? failBash(i) : failEdit(i));
        const r = evaluateStuck({ calls, state, mode }) as Record<string, unknown>;
        expect(r.action).not.toBe('abort');
        expect(r.abort).toBeUndefined();
        expect(r.error).toBeUndefined();
        expect(r.reason).toBeUndefined();
      }
    }
  });

  test('AC-11: 100 alternating calls never produce an abort or error, in any mode', () => {
    for (const mode of ['off', 'log', 'nudge'] as const) {
      const state = createStuckState();
      const calls: StuckCall[] = [];
      for (let i = 0; i < 100; i++) {
        calls.push(i % 2 === 0 ? call('Bash', { command: 'pnpm build' }) : call('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' }));
        const r = evaluateStuck({ calls, state, mode }) as Record<string, unknown>;
        expect(r.action).not.toBe('abort');
        expect(r.abort).toBeUndefined();
        expect(r.error).toBeUndefined();
      }
      expect(detectRepetitiveToolCalls(calls).action).not.toBe('abort');
    }
  });

  // Polling and read-only calls are "ignored" by both outcome scenarios (shared predicate).
  const POLLING_BASH = ['sleep 60', 'gh run watch 123', 'gh run view 123', 'gh pr checks 45', 'gh pr view 45'];
  const POLLING_BUILDD = ['get_task', 'list_tasks', 'get_mission'];
  const pollingCalls = (): Array<[string, StuckCall]> => [
    ...POLLING_BASH.map(cmd => [cmd, call('Bash', { command: cmd })] as [string, StuckCall]),
    ...POLLING_BUILDD.map(action => [`buildd ${action}`, call('mcp__buildd__buildd_tasks', { action })] as [string, StuckCall]),
  ];

  for (const [label, poll] of pollingCalls()) {
    test(`R-5: failing polling call ${label} does not count toward an error streak`, () => {
      const failingPoll = { ...poll, isError: true, resultSignature: 'sig:fail', errorLine: 'boom' };
      const five = [failBash(1), failBash(2), failEdit(3), failBash(4), failBash(5)];
      expect(run([...five, failingPoll]).action).toBe('none');
      // Polling between failures neither completes nor resets the streak.
      const six = [failBash(1), failingPoll, failBash(2), failEdit(3), failingPoll, failBash(4), failBash(5), failBash(6)];
      expect(run(six).signal?.scenario).toBe('error_streak');
    });

    test(`R-5: successful polling call ${label} does not end an error streak`, () => {
      const okPoll = { ...poll, isError: false, resultSignature: 'sig:ok' };
      const six = [failBash(1), failBash(2), okPoll, failEdit(3), failBash(4), failBash(5), failBash(6)];
      expect(run(six).signal?.scenario).toBe('error_streak');
    });

    test(`R-5: polling call ${label} interleaved in an alternation does not break it`, () => {
      const calls: StuckCall[] = [];
      for (let i = 0; i < 8; i++) {
        calls.push(i % 2 === 0 ? A() : B());
        calls.push({ ...poll, id: `${poll.id}-${i}`, resultSignature: 'sig:poll' });
      }
      expect(run(calls).signal?.scenario).toBe('alternation');
    });
  }

  test('R-5: a Read interleaved between A,B alternation steps does not break it', () => {
    const calls: StuckCall[] = [];
    for (let i = 0; i < 8; i++) {
      calls.push(i % 2 === 0 ? A() : B());
      calls.push(call('Read', { file_path: '/src/a.ts' }, { resultSignature: 'sig:read' }));
    }
    const r = run(calls);
    expect(r.signal?.scenario).toBe('alternation');
    expect(r.message).toContain('Bash');
    expect(r.message).toContain('Edit');
  });

  test('R-5: Grep, Glob and benign Bash interleaved in an alternation do not break it', () => {
    const noise = [
      call('Grep', { pattern: 'x' }, { resultSignature: 'sig:grep' }),
      call('Glob', { pattern: '**/*.ts' }, { resultSignature: 'sig:glob' }),
      call('Bash', { command: 'git status' }, { resultSignature: 'sig:status' }),
    ];
    const calls: StuckCall[] = [];
    for (let i = 0; i < 8; i++) {
      calls.push(i % 2 === 0 ? A() : B());
      calls.push(noise[i % noise.length]);
    }
    expect(run(calls).signal?.scenario).toBe('alternation');
  });

  test('R-5: a Read interleaved in an error streak neither extends nor breaks it', () => {
    const calls = [failBash(1), call('Read', { file_path: '/x' }, { resultSignature: 'r' }), failBash(2), failEdit(3), failBash(4), failBash(5), failBash(6)];
    expect(run(calls).signal?.scenario).toBe('error_streak');
  });

  test('R-10: result signature ignores digits and whitespace, keeps no text', () => {
    expect(resultSignature('failed at 12:01:05  count=7')).toBe(resultSignature('failed at 99:59:00 count=1'));
    expect(resultSignature('failed')).not.toBe(resultSignature('passed'));
    expect(resultSignature('secret-text')).not.toContain('secret');
  });
});

describe('counted-tool whitelist (R-3)', () => {
  const others = [
    ['LS', { path: '/x' }],
    ['TodoWrite', { todos: [] }],
    ['WebFetch', { url: 'https://example.com' }],
    ['Task', { prompt: 'p' }],
  ] as const;

  for (const [name] of others) {
    test(`six failing ${name} calls report no error streak`, () => {
      const calls = Array.from({ length: 6 }, (_, i) => call(name, { n: i }, { fail: true }));
      expect(run(calls).action).toBe('none');
    });
  }

  test('other tools neither count nor break an error streak', () => {
    const calls = [failBash(1), failBash(2), call('LS', { path: '/' }), failEdit(3), call('TodoWrite', {}), failBash(4), call('WebFetch', { url: 'u' }), failEdit(5), failBash(6)];
    expect(run(calls).action).not.toBe('none');
  });

  test('other tools are skipped by alternation', () => {
    const a = (i: number) => call('Bash', { command: 'make a' }, { resultSignature: 'a' });
    const b = (i: number) => call('Edit', { file_path: '/f', old_string: 'x', new_string: 'y' }, { resultSignature: 'b' });
    const calls: StuckCall[] = [];
    for (let i = 0; i < 4; i++) calls.push(a(i), call('LS', { path: `/${i}` }), b(i), call('Task', { prompt: `${i}` }));
    expect(run(calls).scenario).toBe('alternation');
  });
});
