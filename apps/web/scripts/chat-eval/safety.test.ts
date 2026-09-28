/**
 * The chat eval's two promises: it never runs a write against live buildd,
 * and it never spends Anthropic API tokens (claude children are OAuth only).
 */
import { describe, expect, it } from 'bun:test';
import { oauthOnlyEnv } from './lib/env';
import { chatToolDefs, isWrite, mcpToolDefs } from './lib/surfaces';

describe('isWrite (chat surface)', () => {
  it('lets reads through', () => {
    expect(isWrite('chat', 'list_tasks', {})).toBe(false);
    expect(isWrite('chat', 'get_task', { taskId: 'x' })).toBe(false);
    expect(isWrite('chat', 'manage_missions', { action: 'list' })).toBe(false);
  });

  it('stops every write op chat offers', () => {
    expect(isWrite('chat', 'create_task', { title: 't', description: 'd' })).toBe(true);
    expect(isWrite('chat', 'manage_missions', { action: 'create' })).toBe(true);
    expect(isWrite('chat', 'hold_task', { taskId: 'x' })).toBe(true);
    expect(isWrite('chat', 'trigger_release', {})).toBe(true);
  });
});

describe('isWrite (mcp surface)', () => {
  const call = (action: string, params: Record<string, unknown> = {}) => isWrite('mcp', 'buildd', { action, params });

  it('lets registry reads through', () => {
    expect(call('list_tasks')).toBe(false);
    expect(call('manage_missions', { action: 'list' })).toBe(false);
    expect(isWrite('mcp', 'recall', { query: 'x' })).toBe(false);
  });

  it('treats writes, unknown actions and other tools as writes', () => {
    expect(call('create_task')).toBe(true);
    expect(call('manage_missions', { action: 'create' })).toBe(true);
    // Worker lifecycle actions aren't in the chat registry: fail closed.
    expect(call('claim_task')).toBe(true);
    expect(call('complete_task')).toBe(true);
    expect(call('no_such_action')).toBe(true);
    expect(isWrite('mcp', 'learn', {})).toBe(true);
    expect(isWrite('mcp', 'send_worker_message', {})).toBe(true);
  });

  it('classifies group tool calls like buildd calls; help is a read', () => {
    expect(isWrite('mcp', 'buildd_missions', { action: 'manage_missions', params: { action: 'list' } })).toBe(false);
    expect(isWrite('mcp', 'buildd_missions', { action: 'manage_missions', params: { action: 'create' } })).toBe(true);
    expect(isWrite('mcp', 'buildd_work', { action: 'claim_task', params: {} })).toBe(true);
    expect(isWrite('mcp', 'buildd_work', { action: 'help', params: { action: 'claim_task' } })).toBe(false);
  });
});

describe('surfaces', () => {
  it('builds chat tool definitions with JSON schemas', () => {
    const defs = chatToolDefs();
    expect(defs.length).toBeGreaterThan(10);
    for (const d of defs) {
      expect(d.inputSchema.type).toBe('object');
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  it('advertises the group tools on the mcp surface, and buildd on legacy', () => {
    expect(mcpToolDefs().map(d => d.name)).toContain('buildd_missions');
    expect(mcpToolDefs().map(d => d.name)).not.toContain('buildd');
    expect(mcpToolDefs('legacy').map(d => d.name)).toContain('buildd');
  });
});

describe('oauthOnlyEnv', () => {
  it('drops Anthropic API credentials and cloud-provider switches', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u',
        CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', KEEP_ME: 'yes',
      });
      const env = oauthOnlyEnv();
      for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
        expect(env[k]).toBeUndefined();
      }
      expect(env.KEEP_ME).toBe('yes');
    } finally {
      process.env = saved;
    }
  });
});
