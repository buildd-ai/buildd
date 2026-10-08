import { describe, expect, test } from 'bun:test';
import { LEGACY_BUILDD_ACTION_TOOL } from '@buildd/shared';
import { BUILDD_MCP_TOOL_MATCHER, extractBuilddAction, withBuilddActionTools } from '../../src/action-events';

describe('extractBuilddAction', () => {
  test('extracts the action from a buildd MCP tool_use', () => {
    expect(extractBuilddAction(LEGACY_BUILDD_ACTION_TOOL, { action: 'create_pr' })).toBe('create_pr');
  });

  test('extracts a different action name', () => {
    expect(extractBuilddAction(LEGACY_BUILDD_ACTION_TOOL, { action: 'update_progress', progress: 50 })).toBe(
      'update_progress',
    );
  });

  test('returns null for a non-buildd tool', () => {
    expect(extractBuilddAction('Bash', { command: 'ls' })).toBeNull();
  });

  test('extracts the action from a group tool (the standard surface)', () => {
    expect(extractBuilddAction('mcp__buildd__buildd_work', { action: 'create_pr' })).toBe('create_pr');
    expect(extractBuilddAction('mcp__buildd__buildd_analytics', { action: 'get_usage_stats' })).toBe('get_usage_stats');
    // Codex reports MCP tools through its codex_apps server.
    expect(extractBuilddAction('mcp__codex_apps__buildd.buildd_work', { action: 'complete_task' })).toBe('complete_task');
  });

  test('returns null for buildd tools that are not action tools', () => {
    expect(extractBuilddAction('mcp__buildd__buildd_memory', { action: 'search' })).toBeNull();
    expect(extractBuilddAction('mcp__buildd__buildd_nope', { action: 'create_pr' })).toBeNull();
    expect(extractBuilddAction('mcp__other__buildd_work', { action: 'create_pr' })).toBeNull();
  });

  test('the hook matcher names the legacy tool and every group tool', () => {
    const names = BUILDD_MCP_TOOL_MATCHER.split('|');
    expect(names).toContain(LEGACY_BUILDD_ACTION_TOOL);
    expect(names).toContain('mcp__buildd__buildd_work');
    expect(/^[\w|]+$/.test(BUILDD_MCP_TOOL_MATCHER)).toBe(true);
  });

  test('returns null for a different MCP server', () => {
    expect(extractBuilddAction('mcp__buildd__recall', { query: 'foo' })).toBeNull();
  });

  test('returns null when action is missing', () => {
    expect(extractBuilddAction(LEGACY_BUILDD_ACTION_TOOL, { workspaceId: 'ws-1' })).toBeNull();
  });

  test('returns null when action is non-string', () => {
    expect(extractBuilddAction(LEGACY_BUILDD_ACTION_TOOL, { action: 42 })).toBeNull();
  });

  test('returns null when action is an empty string', () => {
    expect(extractBuilddAction(LEGACY_BUILDD_ACTION_TOOL, { action: '' })).toBeNull();
  });

  test('returns null for null/undefined input', () => {
    expect(extractBuilddAction(LEGACY_BUILDD_ACTION_TOOL, null)).toBeNull();
    expect(extractBuilddAction(LEGACY_BUILDD_ACTION_TOOL, undefined)).toBeNull();
  });

  test('returns null for an empty tool name', () => {
    expect(extractBuilddAction('', { action: 'create_pr' })).toBeNull();
  });
});

describe('withBuilddActionTools', () => {
  test('a role naming the legacy tool gets every group tool too', () => {
    const tools = withBuilddActionTools(['Read', LEGACY_BUILDD_ACTION_TOOL]);
    expect(tools).toContain('Read');
    expect(tools).toContain(LEGACY_BUILDD_ACTION_TOOL);
    expect(tools).toContain('mcp__buildd__buildd_work');
    expect(tools).toContain('mcp__buildd__buildd_prs');
    expect(new Set(tools).size).toBe(tools.length);
  });

  test('a list without the legacy tool is unchanged', () => {
    expect(withBuilddActionTools(['Read', 'mcp__buildd__buildd_analytics'])).toEqual(['Read', 'mcp__buildd__buildd_analytics']);
  });
});
