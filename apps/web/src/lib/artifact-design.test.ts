import { describe, it, expect } from 'bun:test';
import { validateDesignMetadata } from './artifact-design';

const screen = (o: Record<string, unknown> = {}) => ({ id: 'nav/home#1', name: 'Home', viewport: '1440x900', ...o });

describe('validateDesignMetadata', () => {
  it('passes metadata that is not a design, whatever it holds', () => {
    expect(validateDesignMetadata(undefined)).toBeNull();
    expect(validateDesignMetadata({ qa: { route: '/' }, screens: 'anything' })).toBeNull();
  });

  it('accepts a design with screens and lets unknown keys through', () => {
    expect(validateDesignMetadata({ kind: 'design', screens: [screen(), screen({ id: 'a.b_c:d-e' })], tool: 'figma', extra: 1 })).toBeNull();
  });

  it('requires a non-empty screens array', () => {
    expect(validateDesignMetadata({ kind: 'design' })).toContain('metadata.screens');
    expect(validateDesignMetadata({ kind: 'design', screens: [] })).toContain('metadata.screens');
  });

  it('names the field of a bad screen', () => {
    expect(validateDesignMetadata({ kind: 'design', screens: [screen(), screen({ id: 'has space' })] })).toContain('metadata.screens[1].id');
    expect(validateDesignMetadata({ kind: 'design', screens: [screen({ name: '' })] })).toContain('metadata.screens[0].name');
    expect(validateDesignMetadata({ kind: 'design', screens: [screen({ viewport: 'mobile' })] })).toContain('metadata.screens[0].viewport');
    expect(validateDesignMetadata({ kind: 'design', screens: [screen({ viewport: '0x900' })] })).toContain('metadata.screens[0].viewport');
    expect(validateDesignMetadata({ kind: 'design', screens: ['home'] })).toContain('metadata.screens[0]');
  });

  it('refuses duplicate screen ids', () => {
    expect(validateDesignMetadata({ kind: 'design', screens: [screen(), screen()] })).toContain('metadata.screens[1].id');
  });
});
