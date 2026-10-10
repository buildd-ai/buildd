import { describe, expect, it } from 'bun:test';
import { copyViolations } from '../../../../../../../../packages/core/copy-rules';
import { PROVIDERS_DESCRIPTION } from './provider-copy';

describe('PROVIDERS_DESCRIPTION', () => {
  it('names agents and chat, recommends no provider, and breaks no copy rule', () => {
    expect(PROVIDERS_DESCRIPTION).toBe('Keys and subscriptions your agents and chat use.');
    expect(PROVIDERS_DESCRIPTION).not.toMatch(/recommended|chat only/i);
    expect(copyViolations(PROVIDERS_DESCRIPTION)).toEqual([]);
  });
});
