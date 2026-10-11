import { describe, expect, it } from 'bun:test';
import {
  admitsNoteToNeedsYou,
  admitsToNeedsYou,
  noteQuestionNeedsDisposition,
  parkedDispositionOf,
} from '../needs-you';

const NOW = Date.parse('2026-10-08T12:00:00Z');

describe('parkedDispositionOf', () => {
  it('reads the three dispositions and nothing else', () => {
    expect(parkedDispositionOf({ disposition: 'ask' })).toBe('ask');
    expect(parkedDispositionOf({ disposition: 'hold' })).toBe('hold');
    expect(parkedDispositionOf({ disposition: 'recovered' })).toBe('recovered');
    expect(parkedDispositionOf({ disposition: 'decide' })).toBeNull();
    expect(parkedDispositionOf({ type: 'question', prompt: 'x' } as never)).toBeNull();
    expect(parkedDispositionOf(null)).toBeNull();
  });
});

describe('admitsToNeedsYou', () => {
  it('admits an ask, question or permission', () => {
    expect(admitsToNeedsYou({ type: 'question', disposition: 'ask' }, NOW)).toBe(true);
    expect(admitsToNeedsYou({ type: 'permission', disposition: 'ask' }, NOW)).toBe(true);
  });

  it('never admits a park with no disposition — the gate has not said a person owns it', () => {
    expect(admitsToNeedsYou({ type: 'question' }, NOW)).toBe(false);
    expect(admitsToNeedsYou({ type: 'permission' }, NOW)).toBe(false);
    expect(admitsToNeedsYou(null, NOW)).toBe(false);
  });

  it('never admits a recovered blocker — its repair task owns the next move', () => {
    expect(admitsToNeedsYou({ type: 'question', disposition: 'recovered' }, NOW)).toBe(false);
  });

  it('admits a hold only once its deadline passed or it resurfaced', () => {
    const ahead = new Date(NOW + 60_000).toISOString();
    const past = new Date(NOW - 60_000).toISOString();
    expect(admitsToNeedsYou({ type: 'question', disposition: 'hold', resurfaceAt: ahead }, NOW)).toBe(false);
    expect(admitsToNeedsYou({ type: 'question', disposition: 'hold', resurfaceAt: past }, NOW)).toBe(true);
    expect(admitsToNeedsYou({ type: 'question', disposition: 'hold', resurfaceAt: ahead, holdOutcome: 'resurfaced' }, NOW)).toBe(true);
    expect(admitsToNeedsYou({ type: 'question', disposition: 'hold' }, NOW)).toBe(false);
  });
});

describe('note admission', () => {
  it('agent and outside-caller question notes need a disposition; system and user notes do not', () => {
    expect(noteQuestionNeedsDisposition({ type: 'question', authorType: 'agent' })).toBe(true);
    expect(noteQuestionNeedsDisposition({ type: 'question', authorType: 'mcp' })).toBe(true);
    expect(noteQuestionNeedsDisposition({ type: 'question', authorType: 'system' })).toBe(false);
    expect(noteQuestionNeedsDisposition({ type: 'warning', authorType: 'agent' })).toBe(false);
  });

  it('admits an agent question note only with disposition ask', () => {
    expect(admitsNoteToNeedsYou({ type: 'question', authorType: 'agent', disposition: 'ask' })).toBe(true);
    expect(admitsNoteToNeedsYou({ type: 'question', authorType: 'agent', disposition: 'recovered' })).toBe(false);
    expect(admitsNoteToNeedsYou({ type: 'question', authorType: 'agent', disposition: null })).toBe(false);
    expect(admitsNoteToNeedsYou({ type: 'question', authorType: 'system', disposition: null })).toBe(true);
  });
});
