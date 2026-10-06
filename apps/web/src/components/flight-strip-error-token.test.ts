import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FLIGHT_STRIP_FAILURE_FILL } from './FlightStrip';

describe('flight strip failure color', () => {
  it('resolves to the canonical --status-error token, not a static hex', () => {
    expect(FLIGHT_STRIP_FAILURE_FILL).toBe('var(--status-error)');
    expect(FLIGHT_STRIP_FAILURE_FILL).not.toMatch(/#[0-9a-f]{3,8}/i);
    const css = readFileSync(join(import.meta.dir, '../app/globals.css'), 'utf8');
    expect(css).toMatch(/--status-error:\s*#[0-9a-f]{6}/i);
  });
});
