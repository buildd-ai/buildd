/**
 * The chat eval's two promises: it never runs a write against live buildd,
 * and it never spends Anthropic API tokens (claude children are OAuth only).
 */
import { describe, expect, it } from 'bun:test';
import { oauthOnlyEnv } from './lib/env';
import { allActions } from '@buildd/core/mcp-tools';
import { ALL_CHAT_TOOL_SPECS, isExposed } from '../../src/lib/chat/registry';
import {
  chatToolDefs, groupRouterReply, isWrite, MCP_ONLY_CLASS, mcpServerInstructionsFor, mcpToolDefs, parseMcpTools, runIdFor,
} from './lib/surfaces';

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

describe('isWrite (mcp surface): actions chat does not expose', () => {
  const both = (action: string, params: Record<string, unknown> = {}) => [
    isWrite('mcp', 'buildd', { action, params }),
    isWrite('mcp', 'buildd_runners', { action, params }),
  ];

  it('runs MCP reads that chat defers (list_runners, get_usage_stats)', () => {
    expect(both('list_runners')).toEqual([false, false]);
    expect(both('get_usage_stats')).toEqual([false, false]);
  });

  it('still blocks the writes chat defers or never offers', () => {
    for (const a of ['merge_pr', 'close_pr', 'request_pr_review', 'update_artifact', 'manage_model_tiers', 'manage_secrets', 'claim_task', 'create_pr', 'post_note']) {
      expect(isWrite('mcp', 'buildd', { action: a, params: {} })).toBe(true);
    }
  });

  it('classifies every MCP action exactly once: by the chat registry when chat exposes it, else by MCP_ONLY_CLASS', () => {
    for (const a of allActions) {
      const spec = ALL_CHAT_TOOL_SPECS[a];
      const byChat = !!spec && isExposed(spec);
      expect({ action: a, byChat, byMcp: a in MCP_ONLY_CLASS }).toEqual({ action: a, byChat, byMcp: !byChat });
    }
    // No stale entries for actions that no longer exist.
    for (const a of Object.keys(MCP_ONLY_CLASS)) expect(allActions as readonly string[]).toContain(a);
  });

  it('every MCP action is classified as a read or a write, and unknown ones stay blocked', () => {
    for (const a of allActions) expect(typeof isWrite('mcp', 'buildd', { action: a, params: {} })).toBe('boolean');
    expect(isWrite('mcp', 'buildd_runners', { action: 'list_runnerz', params: {} })).toBe(true);
    expect(isWrite('mcp', 'buildd', { action: '', params: {} })).toBe(true);
  });
});

describe('groupRouterReply (mcp group tools)', () => {
  it("answers a malformed group call with the server's own error, not as a blocked write", () => {
    const r = groupRouterReply('buildd_missions', { action: 'list', params: {} });
    expect(r?.isError).toBe(true);
    // The server names the right call for a sub-action instead of "Unknown action".
    expect(r?.text).toContain('"list" is a sub-action');
    expect(groupRouterReply('buildd_missions', { action: 'list_runners', params: {} })?.text).toContain('buildd_runners');
    expect(groupRouterReply('buildd_work', { action: 'help', params: {} })?.isError).toBe(false);
  });

  it('returns null for a call the router dispatches, so isWrite still decides it', () => {
    expect(groupRouterReply('buildd_missions', { action: 'manage_missions', params: { action: 'update' } })).toBeNull();
    expect(isWrite('mcp', 'buildd_missions', { action: 'manage_missions', params: { action: 'update' } })).toBe(true);
    expect(groupRouterReply('buildd', { action: 'list_tasks', params: {} })).toBeNull();
    expect(groupRouterReply('learn', {})).toBeNull();
  });
});

describe('mcp tool surface option', () => {
  it('defaults to groups and accepts legacy', () => {
    expect(parseMcpTools(undefined)).toBe('groups');
    expect(parseMcpTools('groups')).toBe('groups');
    expect(parseMcpTools('legacy')).toBe('legacy');
    expect(() => parseMcpTools('mega')).toThrow();
  });

  it('puts the mcp tool surface in the run id', () => {
    const at = new Date('2026-01-02T03:04:05Z');
    expect(runIdFor({ at, surface: 'mcp', mcpTools: 'legacy', routing: 'jev', model: 'haiku' })).toBe('2026-01-02T03-04-05-mcp-legacy-haiku');
    expect(runIdFor({ at, surface: 'mcp', mcpTools: 'groups', routing: 'jev', model: 'haiku', label: 'x' })).toBe('2026-01-02T03-04-05-mcp-groups-haiku-x');
    expect(runIdFor({ at, surface: 'chat', mcpTools: 'groups', routing: 'jev', model: 'sonnet' })).toBe('2026-01-02T03-04-05-chat-jev-sonnet');
  });

  it('sends the matching server instructions', () => {
    expect(mcpServerInstructionsFor('legacy')).not.toBe(mcpServerInstructionsFor('groups'));
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
