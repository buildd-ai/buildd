import { describe, it, expect } from 'bun:test';

// Unit tests for the 401 detection logic implemented in handleMessage (workers.ts).
// The detection pattern:
//   1. block.is_error === true
//   2. text matches /\b(401|unauthorized|authentication.*failed|invalid.*token|token.*expired|access.*denied)\b/i
//   3. source tool name starts with 'mcp__' → extract serverKey = source.split('__')[1]
//   4. find connector where name.toLowerCase().replace(/[^a-z0-9_]/g, '_') === serverKey

const AUTH_401_PATTERN = /\b(401|unauthorized|authentication.*failed|invalid.*token|token.*expired|access.*denied)\b/i;

function toServerKey(connectorName: string): string {
  return connectorName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

function extractServerKey(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  return toolName.split('__')[1];
}

interface Connector { id: string; name: string; url: string }

function findConnectorFor(
  source: string | undefined,
  connectors: Connector[],
): Connector | undefined {
  if (!source || !source.startsWith('mcp__')) return undefined;
  const serverKey = extractServerKey(source);
  return connectors.find(c => toServerKey(c.name) === serverKey);
}

describe('401 detection regex', () => {
  it('matches plain 401', () => {
    expect(AUTH_401_PATTERN.test('HTTP 401 Unauthorized')).toBe(true);
  });

  it('matches "unauthorized" (case-insensitive)', () => {
    expect(AUTH_401_PATTERN.test('Error: Unauthorized')).toBe(true);
    expect(AUTH_401_PATTERN.test('401 UNAUTHORIZED')).toBe(true);
  });

  it('matches "authentication failed"', () => {
    expect(AUTH_401_PATTERN.test('authentication failed: bad credentials')).toBe(true);
  });

  it('matches "invalid token"', () => {
    expect(AUTH_401_PATTERN.test('invalid token provided')).toBe(true);
  });

  it('matches "token expired"', () => {
    expect(AUTH_401_PATTERN.test('token expired, please reauthenticate')).toBe(true);
  });

  it('matches "access denied"', () => {
    expect(AUTH_401_PATTERN.test('access denied for user')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(AUTH_401_PATTERN.test('Connection refused')).toBe(false);
    expect(AUTH_401_PATTERN.test('Not found')).toBe(false);
    expect(AUTH_401_PATTERN.test('Internal server error')).toBe(false);
    expect(AUTH_401_PATTERN.test('rate limited')).toBe(false);
  });

  it('does not trigger on 4010 or similar numbers', () => {
    expect(AUTH_401_PATTERN.test('Error code 4010')).toBe(false);
    expect(AUTH_401_PATTERN.test('account 401023')).toBe(false);
  });
});

describe('connector name → server key mapping', () => {
  it('lowercases the name', () => {
    expect(toServerKey('GitHub')).toBe('github');
  });

  it('replaces spaces with underscores', () => {
    expect(toServerKey('My Connector')).toBe('my_connector');
  });

  it('replaces hyphens with underscores', () => {
    expect(toServerKey('my-connector')).toBe('my_connector');
  });

  it('replaces dots with underscores', () => {
    expect(toServerKey('acme.corp')).toBe('acme_corp');
  });

  it('strips other special characters', () => {
    expect(toServerKey('Linear (Tasks)')).toBe('linear__tasks_');
  });

  it('preserves existing underscores and digits', () => {
    expect(toServerKey('my_connector_v2')).toBe('my_connector_v2');
  });
});

describe('MCP tool source → connector lookup', () => {
  const connectors: Connector[] = [
    { id: 'conn-gh', name: 'GitHub', url: 'https://mcp.github.com/' },
    { id: 'conn-ln', name: 'Linear', url: 'https://mcp.linear.app/' },
    { id: 'conn-sl', name: 'My Slack', url: 'https://mcp.slack.com/' },
  ];

  it('finds connector by tool name mcp__github__list_repos', () => {
    const c = findConnectorFor('mcp__github__list_repos', connectors);
    expect(c?.id).toBe('conn-gh');
  });

  it('finds connector by tool name mcp__linear__create_issue', () => {
    const c = findConnectorFor('mcp__linear__create_issue', connectors);
    expect(c?.id).toBe('conn-ln');
  });

  it('maps "My Slack" connector to tool prefix mcp__my_slack__', () => {
    const c = findConnectorFor('mcp__my_slack__send_message', connectors);
    expect(c?.id).toBe('conn-sl');
  });

  it('returns undefined for non-MCP tools', () => {
    expect(findConnectorFor('Bash', connectors)).toBeUndefined();
    expect(findConnectorFor('Read', connectors)).toBeUndefined();
    expect(findConnectorFor(undefined, connectors)).toBeUndefined();
  });

  it('returns undefined when no connector matches the server key', () => {
    const c = findConnectorFor('mcp__jira__create_ticket', connectors);
    expect(c).toBeUndefined();
  });
});
