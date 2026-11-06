import { describe, it, expect } from 'bun:test';
import { adminActions, workerActions } from '../mcp-tools';

describe('get_embedding_usage', () => {
  it('is admin level only', () => {
    expect((adminActions as readonly string[]).includes('get_embedding_usage')).toBe(true);
    expect((workerActions as readonly string[]).includes('get_embedding_usage')).toBe(false);
  });
});
