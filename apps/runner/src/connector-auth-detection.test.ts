import { describe, it, expect } from 'bun:test';
import {
  AUTH_401_PATTERN,
  AUTH_403_PERMISSION_PATTERN,
  toServerKey,
  extractServerKey,
  findConnectorFor,
  shouldFireCircuitBreaker,
  is401Error,
  is403PermissionError,
  type ConnectorRef,
} from './connector-auth-detection';

// Unit tests for connector auth detection helpers (connector-auth-detection.ts).
// These helpers are used in workers.ts handleMessage to detect auth failures from
// MCP connector tool results and fire the appropriate circuit breaker / event.
//
// 401 detection pattern:
//   1. block.is_error === true
//   2. text matches AUTH_401_PATTERN
//   3. source tool name starts with 'mcp__' → extract serverKey = source.split('__')[1]
//   4. find connector where name.toLowerCase().replace(/[^a-z0-9_]/g, '_') === serverKey
//
// 403 detection pattern:
//   1. block.is_error === true
//   2. text matches AUTH_403_PERMISSION_PATTERN ("resource not accessible by integration")
//   3. same source → connector resolution as 401
//   → emits connector_permission_insufficient (token is valid; App lacks permission scope)
//
// Assertion-mode reconciliation (§F.2):
//   - If the connector is assertion-mode AND assertionReAuthFailed does NOT contain the server name
//     → skip circuit breaker (silent re-auth is in progress or succeeded)
//   - If the connector is assertion-mode AND assertionReAuthFailed contains the server name
//     → fire circuit breaker (re-exchange exhausted)
//   - If the connector is NOT assertion-mode → fire circuit breaker immediately

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

describe('is401Error helper', () => {
  it('returns true for a 401 message', () => {
    expect(is401Error('HTTP 401 Unauthorized')).toBe(true);
  });

  it('returns false for an unrelated error', () => {
    expect(is401Error('Connection refused')).toBe(false);
  });

  it('returns false for a 403 permission error', () => {
    expect(is401Error('HTTP 403 Resource not accessible by integration')).toBe(false);
  });
});

describe('403 permission detection', () => {
  it('matches the exact GitHub App permission-gap phrase', () => {
    expect(AUTH_403_PERMISSION_PATTERN.test('HTTP 403 Resource not accessible by integration')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(AUTH_403_PERMISSION_PATTERN.test('resource not accessible by integration')).toBe(true);
    expect(AUTH_403_PERMISSION_PATTERN.test('RESOURCE NOT ACCESSIBLE BY INTEGRATION')).toBe(true);
  });

  it('matches when the phrase is embedded in a longer message', () => {
    expect(AUTH_403_PERMISSION_PATTERN.test(
      'RequestError: Resource not accessible by integration – https://docs.github.com/...'
    )).toBe(true);
  });

  it('does not match unrelated 403 errors', () => {
    expect(AUTH_403_PERMISSION_PATTERN.test('HTTP 403 Forbidden')).toBe(false);
    expect(AUTH_403_PERMISSION_PATTERN.test('403 rate limit exceeded')).toBe(false);
  });

  it('does not match 401 auth errors', () => {
    expect(AUTH_403_PERMISSION_PATTERN.test('HTTP 401 Unauthorized')).toBe(false);
    expect(AUTH_403_PERMISSION_PATTERN.test('authentication failed')).toBe(false);
  });
});

describe('is403PermissionError helper', () => {
  it('returns true for the GitHub App permission-gap message', () => {
    expect(is403PermissionError('HTTP 403 Resource not accessible by integration')).toBe(true);
  });

  it('returns false for a plain 403 Forbidden', () => {
    expect(is403PermissionError('HTTP 403 Forbidden')).toBe(false);
  });

  it('returns false for a 401 error', () => {
    expect(is403PermissionError('HTTP 401 Unauthorized')).toBe(false);
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
  const connectors: ConnectorRef[] = [
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

describe('circuit breaker gate — assertion-mode vs oauth/static', () => {
  const oauthConnector: ConnectorRef = { id: 'conn-gh', name: 'GitHub', url: 'https://mcp.github.com/' };
  const assertionConnector: ConnectorRef = { id: 'conn-cue', name: 'Cue', url: 'https://cue.buildd.dev/api/mcp' };
  const assertionMeta = [{ name: 'Cue', mintApiUrl: 'https://buildd.dev/api/connectors/x/assertion', tokenEndpoint: 'https://cue.buildd.dev/token' }];

  it('fires circuit breaker immediately for oauth/static connectors', () => {
    expect(shouldFireCircuitBreaker(oauthConnector, [], new Set())).toBe(true);
  });

  it('does NOT fire circuit breaker for assertion connector when re-auth has not failed', () => {
    expect(shouldFireCircuitBreaker(assertionConnector, assertionMeta, new Set())).toBe(false);
  });

  it('fires circuit breaker for assertion connector when re-auth has failed', () => {
    const failed = new Set(['Cue']);
    expect(shouldFireCircuitBreaker(assertionConnector, assertionMeta, failed)).toBe(true);
  });

  it('only targets the specific connector that failed — others remain gated', () => {
    const failed = new Set(['Cue']);
    const otherAssertionConnector: ConnectorRef = { id: 'conn-dispatch', name: 'Dispatch', url: 'https://dispatch.buildd.dev/api/mcp' };
    const otherMeta = [...assertionMeta, { name: 'Dispatch', mintApiUrl: 'https://buildd.dev/api/connectors/y/assertion', tokenEndpoint: 'https://dispatch.buildd.dev/token' }];
    expect(shouldFireCircuitBreaker(otherAssertionConnector, otherMeta, failed)).toBe(false);
  });
});
