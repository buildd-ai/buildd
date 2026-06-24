import { describe, test, expect } from 'bun:test';
import { collapseWorkspacePath } from './WorkerActivityTimeline';

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
