import { describe, it, expect } from 'bun:test';
import { claudeLoginUsed, buildTerminalAttributionPayload } from '../../src/terminal-attribution';
import type { LocalWorker } from '../../src/types';

// The server scopes a Claude session/weekly wall to the runner that hit it when
// the run says it used that machine's own login, so one machine's limit never
// holds another runner's work. These pin what the runner reports.
describe('claudeLoginUsed', () => {
  const base = { isCodexTask: false, cloud: false, machineLoginUsed: false, machineLogin: null, injected: [] as string[], claudeCredentialUsed: false };

  it("names this machine's login (claude login) or token (CLAUDE_CODE_OAUTH_TOKEN)", () => {
    expect(claudeLoginUsed({ ...base, machineLoginUsed: true, machineLogin: 'login' })).toBe('machine_login');
    expect(claudeLoginUsed({ ...base, machineLoginUsed: true, machineLogin: 'env' })).toBe('machine_token');
  });

  it('names a stored team credential when the claim handed one to the run', () => {
    expect(claudeLoginUsed({ ...base, injected: ['serverOauthToken'] })).toBe('stored');
    expect(claudeLoginUsed({ ...base, claudeCredentialUsed: true })).toBe('stored');
  });

  it('says nothing for Codex, cloud runs, API keys and endpoints', () => {
    expect(claudeLoginUsed({ ...base, isCodexTask: true, machineLoginUsed: true, machineLogin: 'login' })).toBeUndefined();
    expect(claudeLoginUsed({ ...base, cloud: true, machineLoginUsed: true, machineLogin: 'login' })).toBeUndefined();
    expect(claudeLoginUsed({ ...base, injected: ['serverApiKey'] })).toBeUndefined();
    expect(claudeLoginUsed(base)).toBeUndefined();
  });
});

describe('the terminal report carries it', () => {
  it('sends claudeLoginUsed when the run recorded one, and omits it otherwise', () => {
    expect(buildTerminalAttributionPayload({ claudeLoginUsed: 'machine_login' } as LocalWorker).claudeLoginUsed).toBe('machine_login');
    expect('claudeLoginUsed' in buildTerminalAttributionPayload({} as LocalWorker)).toBe(false);
  });
});
