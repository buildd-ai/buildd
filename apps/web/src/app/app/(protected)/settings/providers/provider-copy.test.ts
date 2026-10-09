import { describe, expect, it } from 'bun:test';
import { PROVIDERS_DESCRIPTION } from './provider-copy';

describe('PROVIDERS_DESCRIPTION', () => {
  it('covers agent runs, not chat alone, and recommends no provider', () => {
    expect(PROVIDERS_DESCRIPTION).toContain('agent runs');
    expect(PROVIDERS_DESCRIPTION).not.toMatch(/recommended|chat only/i);
    expect(PROVIDERS_DESCRIPTION).not.toContain('—');
  });
});
