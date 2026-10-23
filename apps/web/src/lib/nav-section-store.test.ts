import { describe, expect, it } from 'bun:test';
import { claimNavSection, navSectionSnapshot } from './nav-section-store';

describe('nav-section-store', () => {
  it('nothing claimed: the nav goes by the path', () => {
    expect(navSectionSnapshot()).toBeNull();
  });

  it('the latest claim wins and releasing it restores the one before', () => {
    const a = claimNavSection('/app/missions');
    const b = claimNavSection('/app/health');
    expect(navSectionSnapshot()).toBe('/app/health');
    b();
    expect(navSectionSnapshot()).toBe('/app/missions');
    a();
    expect(navSectionSnapshot()).toBeNull();
  });

  it('release is idempotent and drops only its own hold', () => {
    const a = claimNavSection('/app/missions');
    const b = claimNavSection('/app/missions');
    a();
    a();
    expect(navSectionSnapshot()).toBe('/app/missions');
    b();
    expect(navSectionSnapshot()).toBeNull();
  });
});
