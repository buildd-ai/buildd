import { describe, it, expect } from 'bun:test';
import { PR_LIFECYCLE, derivePrLifecycle } from './pr-presentation';

describe('PR_LIFECYCLE map', () => {
  // AC-3: ci_green must be in the map so it renders as a CI state, never as Open
  it('contains ci_green (AC-3)', () => {
    expect(PR_LIFECYCLE.ci_green).toBeDefined();
    expect(PR_LIFECYCLE.ci_green.label).not.toBe('Open');
  });

  it('ci_green label contains CI-related text', () => {
    expect(PR_LIFECYCLE.ci_green.label.toLowerCase()).toContain('ci');
  });

  it('all CI states (ci_running, ci_failed, ci_green) are present', () => {
    expect(PR_LIFECYCLE.ci_running).toBeDefined();
    expect(PR_LIFECYCLE.ci_failed).toBeDefined();
    expect(PR_LIFECYCLE.ci_green).toBeDefined();
  });
});

describe('derivePrLifecycle', () => {
  // AC-6: #2010 regression — ci_green must not fall back to Open
  it('AC-6: ci_green prLifecycleStatus renders as CI badge, not Open', () => {
    const result = derivePrLifecycle('ci_green', true);
    expect(result).not.toBeNull();
    expect(result?.label).not.toBe('Open');
    expect(result?.label.toLowerCase()).toContain('ci');
  });

  it('ci_failed renders as CI failing badge', () => {
    const result = derivePrLifecycle('ci_failed', true);
    expect(result?.label.toLowerCase()).toContain('ci');
  });

  it('ci_running renders as CI running badge', () => {
    const result = derivePrLifecycle('ci_running', true);
    expect(result?.label.toLowerCase()).toContain('ci');
  });

  it('unknown status with PR falls back to Open', () => {
    const result = derivePrLifecycle('unknown_status', true);
    expect(result?.label).toBe('Open');
  });

  it('null status with PR falls back to Open', () => {
    const result = derivePrLifecycle(null, true);
    expect(result?.label).toBe('Open');
  });

  it('null status with no PR returns null', () => {
    expect(derivePrLifecycle(null, false)).toBeNull();
  });

  it('merged renders correctly', () => {
    const result = derivePrLifecycle('merged', true);
    expect(result?.label).toBe('Merged');
  });
});
