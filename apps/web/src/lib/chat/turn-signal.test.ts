import { describe, expect, it } from 'bun:test';
import { mergeTurnSignal, parseTurnSignalPost, readTurnSignal, turnSignalSuppressedBy, withTurnRef, type TurnSignal } from './turn-signal';

const AID = '0a0a0a0a-0000-4000-8000-000000000001';
const full = { at: 1_790_000_000_000, startMs: 800, contentMs: 2000, renderMs: 2100, endMs: 5000, assistantId: AID, outcome: 'ready', hidden: true };

describe('parseTurnSignalPost: refs, offsets, a label and flags, nothing else', () => {
  it('accepts the full shape', () => {
    const r = parseTurnSignalPost({ ref: 'Ab_c-12', signal: full });
    expect(r).toEqual({ ok: true, ref: 'Ab_c-12', signal: full as TurnSignal });
  });

  it('refuses any text payload, however it is smuggled', () => {
    for (const body of [
      { ref: 'r', signal: { text: 'what is stuck?' } },
      { ref: 'r', signal: { at: 1, message: 'hi' } },
      { ref: 'r', signal: { outcome: 'the answer never showed up' } },
      { ref: 'r', signal: { hidden: 'because I switched tabs' } },
      { ref: 'r', signal: { assistantId: 'not a uuid, a sentence' } },
      { ref: 'what is stuck right now?', signal: { at: 1 } },
      { ref: 'r', signal: { at: 1 }, note: 'extra' },
      { ref: 'r', signal: { ref: 'r2' } },
    ]) {
      expect(parseTurnSignalPost(body).ok).toBe(false);
    }
  });

  it('refuses nonsense numbers and an empty signal', () => {
    expect(parseTurnSignalPost({ ref: 'r', signal: { startMs: -1 } }).ok).toBe(false);
    expect(parseTurnSignalPost({ ref: 'r', signal: { endMs: 9e9 } }).ok).toBe(false);
    expect(parseTurnSignalPost({ ref: 'r', signal: { at: 1.5 } }).ok).toBe(false);
    expect(parseTurnSignalPost({ ref: 'r', signal: {} }).ok).toBe(false);
    expect(parseTurnSignalPost({ ref: 'r', signal: { hidden: false } }).ok).toBe(false);
  });
});

describe('mergeTurnSignal: duplicates and reconnects change nothing', () => {
  it('first value wins per key; a repeat is a no-op', () => {
    const first: TurnSignal = { ref: 'r', at: 1, endMs: 5000, outcome: 'ready' };
    const again = mergeTurnSignal(first, { at: 1, endMs: 5000, outcome: 'ready' });
    expect(again).toEqual(first);
  });

  it('a later post fills only what was missing, and a flag once set stays', () => {
    const beacon: TurnSignal = { ref: 'r', at: 1, pagehide: true };
    const late = mergeTurnSignal(beacon, { at: 2, endMs: 7000, renderMs: 3000 });
    expect(late).toEqual({ ref: 'r', at: 1, pagehide: true, endMs: 7000, renderMs: 3000 });
    // Reordered: the same two posts the other way round agree on every key both carry.
    const reordered = mergeTurnSignal(mergeTurnSignal({ ref: 'r' }, { at: 2, endMs: 7000, renderMs: 3000 }), { at: 1, pagehide: true });
    expect(reordered.pagehide).toBe(true);
    expect(turnSignalSuppressedBy(late)).toBe('pagehide');
    expect(turnSignalSuppressedBy(reordered)).toBe('pagehide');
  });
});

describe('suppression', () => {
  it('every away flag suppresses, and so does a missing end record', () => {
    for (const k of ['hidden', 'pagehide', 'offline', 'left', 'stopped', 'paneHidden'] as const) {
      expect(turnSignalSuppressedBy({ endMs: 1, [k]: true })).toBe(k);
    }
    expect(turnSignalSuppressedBy({ at: 1 })).toBe('no_end');
    expect(turnSignalSuppressedBy({ at: 1, endMs: 5 })).toBeNull();
  });
});

describe('the server-written ref', () => {
  it('lands under usage.turn next to the routing record, or not at all', () => {
    const usage = { inputTokens: 3, outputTokens: 1, costUsd: null, routing: { outcome: 'ok' } };
    expect(withTurnRef(usage, 'abc123')).toEqual({ ...usage, turn: { ref: 'abc123' } });
    expect(withTurnRef(null, 'abc123')).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: null, turn: { ref: 'abc123' } });
    expect(withTurnRef(usage, 'has spaces in it')).toBe(usage);
    expect(withTurnRef(usage, undefined)).toBe(usage);
    expect(readTurnSignal({ turn: { ref: 'x' } })).toEqual({ ref: 'x' });
    expect(readTurnSignal(null)).toBeNull();
    expect(readTurnSignal({ turn: 'x' })).toBeNull();
  });
});
