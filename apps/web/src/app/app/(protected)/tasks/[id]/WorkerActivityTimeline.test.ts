import { describe, test, expect } from 'bun:test';
import { collapseWorkspacePath, milestoneLabel } from './WorkerActivityTimeline';

describe('collapseWorkspacePath', () => {
  test('collapses Ran: cd /path && command into ~/basename command', () => {
    expect(collapseWorkspacePath('Ran: cd /home/runner/project && bun test'))
      .toBe('Ran: ~/project bun test');
  });

  test('collapses cd /path && command (no Ran: prefix)', () => {
    expect(collapseWorkspacePath('cd /home/runner/project && bun test'))
      .toBe('~/project bun test');
  });

  test('collapses bare cd /path alone', () => {
    expect(collapseWorkspacePath('cd /home/runner/project'))
      .toBe('~/project');
  });

  test('collapses Ran: cd /path alone', () => {
    expect(collapseWorkspacePath('Ran: cd /home/runner/project'))
      .toBe('Ran: ~/project');
  });

  test('collapses inline cd /path occurrences in longer strings', () => {
    expect(collapseWorkspacePath('First cd /some/long/path then do stuff'))
      .toBe('First cd ~/path then do stuff');
  });

  test('returns empty string unchanged', () => {
    expect(collapseWorkspacePath('')).toBe('');
  });

  test('returns non-path strings unchanged', () => {
    const label = 'Writing tests for the API endpoint';
    expect(collapseWorkspacePath(label)).toBe(label);
  });

  test('uses last path segment', () => {
    expect(collapseWorkspacePath('cd /a/b/c/d && ls'))
      .toBe('~/d ls');
  });

  test('handles deeply nested path', () => {
    expect(collapseWorkspacePath('Ran: cd /home/user/workspace/projects/myapp && npm install'))
      .toBe('Ran: ~/myapp npm install');
  });
});

describe('milestoneLabel', () => {
  test('returns the label when present', () => {
    expect(milestoneLabel({ type: 'action', label: 'Ran: bun test' })).toBe('Ran: bun test');
  });

  // Sensitive-dataClass workspaces (e.g. cue) have labels stripped server-side and
  // arrive as { type, ts } only. Every row renderer used to dereference the missing
  // label, throwing "Cannot read properties of undefined (reading 'length')" and
  // taking down the whole task page.
  test('falls back to the activity type when the label was stripped', () => {
    expect(milestoneLabel({ type: 'phase' })).toBe('Phase');
    expect(milestoneLabel({ type: 'status' })).toBe('Status update');
    expect(milestoneLabel({ type: 'checkpoint' })).toBe('Checkpoint');
    expect(milestoneLabel({ type: 'action' })).toBe('Action');
  });

  test('treats blank and whitespace-only labels as stripped', () => {
    expect(milestoneLabel({ type: 'status', label: '' })).toBe('Status update');
    expect(milestoneLabel({ type: 'status', label: '   ' })).toBe('Status update');
    expect(milestoneLabel({ type: 'status', label: null })).toBe('Status update');
  });

  test('falls back to a generic label for unrecognised types', () => {
    expect(milestoneLabel({ type: 'statusTransition' })).toBe('Activity');
  });

  test('trims surrounding whitespace on real labels', () => {
    expect(milestoneLabel({ type: 'action', label: '  Read file  ' })).toBe('Read file');
  });
});
