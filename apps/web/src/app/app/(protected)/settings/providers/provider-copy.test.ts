import { describe, expect, it } from 'bun:test';
import { copyViolations } from '../../../../../../../../packages/core/copy-rules';
import { PROVIDERS_DESCRIPTION } from './provider-copy';

describe('PROVIDERS_DESCRIPTION', () => {
  it('names agents and chat, no subscription, recommends no provider, and breaks no copy rule', () => {
    expect(PROVIDERS_DESCRIPTION).toBe('API keys and gateways for your agents and chat.');
    expect(PROVIDERS_DESCRIPTION).not.toMatch(/recommended|chat only|subscription/i);
    expect(copyViolations(PROVIDERS_DESCRIPTION)).toEqual([]);
  });
});
