import { describe, it, expect } from 'bun:test';
import {
  parseLoopConfig,
  LOOP_MAX_LOOPS_DEFAULT,
  LOOP_MAX_LOOPS_MIN,
  LOOP_MAX_LOOPS_MAX,
  LOOP_BACKOFF_MINUTES_DEFAULT,
  LOOP_BACKOFF_MINUTES_MAX,
} from '../loop-config';

// ─────────────────────────────────────────────────────────────────────────────
// Backward compat: null loopConfig must be a no-op
// ─────────────────────────────────────────────────────────────────────────────

describe('null path — backward compatibility', () => {
  it('returns null for null input', () => {
    expect(parseLoopConfig(null)).toBe(null);
  });

  it('returns null for undefined input', () => {
    expect(parseLoopConfig(undefined)).toBe(null);
  });

  it('null result is byte-identical whether called or not (no side effects)', () => {
    const result = parseLoopConfig(null);
    expect(result).toBe(null);
    // A task with loopConfig=null has no loop columns set and behaves as today.
    // The dispatcher checks `if (task.loopConfig != null)` before entering loop paths.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Type-level rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('top-level shape validation', () => {
  it('rejects non-object input', () => {
    expect(() => parseLoopConfig(42)).toThrow('loopConfig must be an object');
    expect(() => parseLoopConfig('string')).toThrow('loopConfig must be an object');
    expect(() => parseLoopConfig([])).toThrow('loopConfig must be an object');
  });

  it('rejects unknown keys', () => {
    expect(() =>
      parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, unknownField: true })
    ).toThrow('Unknown loopConfig key(s): unknownField');
  });

  it('requires exitCondition', () => {
    expect(() => parseLoopConfig({ maxLoops: 3 })).toThrow('loopConfig.exitCondition is required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exitCondition: command
// ─────────────────────────────────────────────────────────────────────────────

describe('exitCondition type=command', () => {
  it('accepts a valid command', () => {
    const result = parseLoopConfig({ exitCondition: { type: 'command', command: 'bun test' } });
    expect(result).toMatchObject({ exitCondition: { type: 'command', command: 'bun test' } });
  });

  it('trims command whitespace', () => {
    const result = parseLoopConfig({ exitCondition: { type: 'command', command: '  bun test  ' } });
    expect(result?.exitCondition).toMatchObject({ command: 'bun test' });
  });

  it('falls back to verificationCommand when command is absent', () => {
    const result = parseLoopConfig(
      { exitCondition: { type: 'command' } },
      'bun run verify'
    );
    expect(result?.exitCondition).toMatchObject({ type: 'command', command: 'bun run verify' });
  });

  it('rejects when both command and verificationCommand are absent', () => {
    expect(() =>
      parseLoopConfig({ exitCondition: { type: 'command' } })
    ).toThrow('exitCondition.command is required');
  });

  it('rejects conflicting command vs verificationCommand', () => {
    expect(() =>
      parseLoopConfig(
        { exitCondition: { type: 'command', command: 'bun test' } },
        'bun run other-check'
      )
    ).toThrow('conflicts with context.verificationCommand');
  });

  it('allows matching command and verificationCommand', () => {
    const result = parseLoopConfig(
      { exitCondition: { type: 'command', command: 'bun test' } },
      'bun test'
    );
    expect(result?.exitCondition).toMatchObject({ command: 'bun test' });
  });

  it('rejects unknown keys in exitCondition', () => {
    expect(() =>
      parseLoopConfig({ exitCondition: { type: 'command', command: 'bun test', extra: 1 } })
    ).toThrow('Unknown exitCondition key(s): extra');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exitCondition: pr_checks_green
// ─────────────────────────────────────────────────────────────────────────────

describe('exitCondition type=pr_checks_green', () => {
  it('accepts valid pr_checks_green', () => {
    const result = parseLoopConfig({ exitCondition: { type: 'pr_checks_green' } });
    expect(result?.exitCondition).toEqual({ type: 'pr_checks_green' });
  });

  it('rejects unknown keys', () => {
    expect(() =>
      parseLoopConfig({ exitCondition: { type: 'pr_checks_green', extra: true } })
    ).toThrow('Unknown exitCondition key(s): extra');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exitCondition: structured_predicate
// ─────────────────────────────────────────────────────────────────────────────

describe('exitCondition type=structured_predicate', () => {
  it('accepts a valid predicate', () => {
    const result = parseLoopConfig({
      exitCondition: {
        type: 'structured_predicate',
        predicate: { path: '/score', operator: 'gte', value: 0.8 },
      },
    });
    expect(result?.exitCondition).toMatchObject({
      type: 'structured_predicate',
      predicate: { path: '/score', operator: 'gte', value: 0.8 },
    });
  });

  it('accepts predicate with no value (exists check)', () => {
    const result = parseLoopConfig({
      exitCondition: {
        type: 'structured_predicate',
        predicate: { path: '/output', operator: 'exists' },
      },
    });
    expect(result?.exitCondition).toMatchObject({
      type: 'structured_predicate',
      predicate: { path: '/output', operator: 'exists' },
    });
  });

  it('accepts null value', () => {
    const result = parseLoopConfig({
      exitCondition: {
        type: 'structured_predicate',
        predicate: { path: '/field', operator: 'eq', value: null },
      },
    });
    expect((result?.exitCondition as { predicate?: { value?: unknown } })?.predicate?.value).toBe(null);
  });

  it('rejects missing predicate', () => {
    expect(() =>
      parseLoopConfig({ exitCondition: { type: 'structured_predicate' } })
    ).toThrow('exitCondition.predicate is required');
  });

  it('rejects blank path', () => {
    expect(() =>
      parseLoopConfig({
        exitCondition: { type: 'structured_predicate', predicate: { path: '', operator: 'eq' } },
      })
    ).toThrow('predicate.path is required');
  });

  it('rejects invalid operator', () => {
    expect(() =>
      parseLoopConfig({
        exitCondition: { type: 'structured_predicate', predicate: { path: '/x', operator: 'LIKE' } },
      })
    ).toThrow('predicate.operator must be one of');
  });

  it('rejects invalid value type', () => {
    expect(() =>
      parseLoopConfig({
        exitCondition: {
          type: 'structured_predicate',
          predicate: { path: '/x', operator: 'eq', value: { nested: true } },
        },
      })
    ).toThrow('predicate.value must be a string, number, boolean, or null');
  });

  it('rejects unknown keys in predicate', () => {
    expect(() =>
      parseLoopConfig({
        exitCondition: {
          type: 'structured_predicate',
          predicate: { path: '/x', operator: 'eq', value: 1, extra: 2 },
        },
      })
    ).toThrow('Unknown exitCondition.predicate key(s): extra');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maxLoops normalization
// ─────────────────────────────────────────────────────────────────────────────

describe('maxLoops', () => {
  it('defaults to 5 when omitted', () => {
    const result = parseLoopConfig({ exitCondition: { type: 'pr_checks_green' } });
    expect(result?.maxLoops).toBe(LOOP_MAX_LOOPS_DEFAULT);
  });

  it('accepts values within bounds', () => {
    expect(parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, maxLoops: 1 })?.maxLoops).toBe(1);
    expect(parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, maxLoops: 50 })?.maxLoops).toBe(50);
  });

  it('rejects 0', () => {
    expect(() =>
      parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, maxLoops: 0 })
    ).toThrow(`between ${LOOP_MAX_LOOPS_MIN} and ${LOOP_MAX_LOOPS_MAX}`);
  });

  it('rejects 51', () => {
    expect(() =>
      parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, maxLoops: 51 })
    ).toThrow(`between ${LOOP_MAX_LOOPS_MIN} and ${LOOP_MAX_LOOPS_MAX}`);
  });

  it('rejects non-integer', () => {
    expect(() =>
      parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, maxLoops: 2.5 })
    ).toThrow('must be an integer');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backoffMinutes normalization
// ─────────────────────────────────────────────────────────────────────────────

describe('backoffMinutes', () => {
  it('defaults to 0 when omitted', () => {
    const result = parseLoopConfig({ exitCondition: { type: 'pr_checks_green' } });
    expect(result?.backoffMinutes).toBe(LOOP_BACKOFF_MINUTES_DEFAULT);
  });

  it('accepts 0', () => {
    expect(parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, backoffMinutes: 0 })?.backoffMinutes).toBe(0);
  });

  it('accepts max value (10080 = 7 days)', () => {
    expect(
      parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, backoffMinutes: 10080 })?.backoffMinutes
    ).toBe(LOOP_BACKOFF_MINUTES_MAX);
  });

  it('rejects negative', () => {
    expect(() =>
      parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, backoffMinutes: -1 })
    ).toThrow(`between 0 and ${LOOP_BACKOFF_MINUTES_MAX}`);
  });

  it('rejects above max', () => {
    expect(() =>
      parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, backoffMinutes: 10081 })
    ).toThrow(`between 0 and ${LOOP_BACKOFF_MINUTES_MAX}`);
  });

  it('rejects non-integer', () => {
    expect(() =>
      parseLoopConfig({ exitCondition: { type: 'pr_checks_green' }, backoffMinutes: 1.5 })
    ).toThrow('must be an integer');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full valid config round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('full config round-trip', () => {
  it('normalizes a complete command config', () => {
    const result = parseLoopConfig({
      exitCondition: { type: 'command', command: 'bun test' },
      maxLoops: 10,
      backoffMinutes: 5,
    });
    expect(result).toEqual({
      exitCondition: { type: 'command', command: 'bun test' },
      maxLoops: 10,
      backoffMinutes: 5,
    });
  });

  it('normalizes a complete pr_checks_green config with defaults', () => {
    const result = parseLoopConfig({ exitCondition: { type: 'pr_checks_green' } });
    expect(result).toEqual({
      exitCondition: { type: 'pr_checks_green' },
      maxLoops: LOOP_MAX_LOOPS_DEFAULT,
      backoffMinutes: LOOP_BACKOFF_MINUTES_DEFAULT,
    });
  });
});
