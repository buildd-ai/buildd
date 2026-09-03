import { describe, expect, test } from 'bun:test';
import { BUILDD_MCP_TOOL_NAME, extractBuilddAction } from '../../src/action-events';

describe('extractBuilddAction', () => {
  test('extracts the action from a buildd MCP tool_use', () => {
    expect(extractBuilddAction(BUILDD_MCP_TOOL_NAME, { action: 'create_pr' })).toBe('create_pr');
  });

  test('extracts a different action name', () => {
    expect(extractBuilddAction(BUILDD_MCP_TOOL_NAME, { action: 'update_progress', progress: 50 })).toBe(
      'update_progress',
    );
  });

  test('returns null for a non-buildd tool', () => {
    expect(extractBuilddAction('Bash', { command: 'ls' })).toBeNull();
  });

  test('returns null for a different MCP server', () => {
    expect(extractBuilddAction('mcp__buildd__recall', { query: 'foo' })).toBeNull();
  });

  test('returns null when action is missing', () => {
    expect(extractBuilddAction(BUILDD_MCP_TOOL_NAME, { workspaceId: 'ws-1' })).toBeNull();
  });

  test('returns null when action is non-string', () => {
    expect(extractBuilddAction(BUILDD_MCP_TOOL_NAME, { action: 42 })).toBeNull();
  });

  test('returns null when action is an empty string', () => {
    expect(extractBuilddAction(BUILDD_MCP_TOOL_NAME, { action: '' })).toBeNull();
  });

  test('returns null for null/undefined input', () => {
    expect(extractBuilddAction(BUILDD_MCP_TOOL_NAME, null)).toBeNull();
    expect(extractBuilddAction(BUILDD_MCP_TOOL_NAME, undefined)).toBeNull();
  });

  test('returns null for an empty tool name', () => {
    expect(extractBuilddAction('', { action: 'create_pr' })).toBeNull();
  });
});
