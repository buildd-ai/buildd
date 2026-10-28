import { describe, test, expect } from 'bun:test';
import { generateApiKey } from '../src/api-key';

describe('generateApiKey', () => {
  test('bld_ + 64 lowercase hex chars', () => {
    expect(generateApiKey()).toMatch(/^bld_[0-9a-f]{64}$/);
  });
  test('keys are unique', () => {
    expect(new Set(Array.from({ length: 50 }, generateApiKey)).size).toBe(50);
  });
});
