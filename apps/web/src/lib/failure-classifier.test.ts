import { describe, it, expect } from 'bun:test';
import { classifyFailure } from './failure-classifier';

describe('classifyFailure', () => {
  it('treats a CLI model-id rejection as environmental: the same runner rejects it every time', () => {
    expect(classifyFailure('[claude-code:unrecognized_model] {"model":"claude-sonnet-5-5","query_source":"sdk"}')).toBe('environmental');
  });

  it('treats the CLI version gate the same way', () => {
    expect(classifyFailure('Claude Code 2.1.0 does not support this model; version 2.2.0 or newer is required.')).toBe('environmental');
  });

  it('wins over a transient word that happens to be in the same text', () => {
    expect(classifyFailure('Claude Code process exited after a timeout\n[claude-code:unrecognized_model] {"model":"x"}')).toBe('environmental');
  });

  it('leaves unrelated classes alone', () => {
    expect(classifyFailure('ECONNRESET')).toBe('transient');
    expect(classifyFailure('assertion failed')).toBe('logic');
    expect(classifyFailure('')).toBe('unknown');
  });
});
