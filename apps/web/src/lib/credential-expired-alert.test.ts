import { describe, it, expect } from 'bun:test';
import { credentialExpiredAlert } from './credential-expired-alert';

const all = (a: ReturnType<typeof credentialExpiredAlert>) => `${a.title} ${a.message}`;

describe('credentialExpiredAlert', () => {
  it('machine_login: re-run the login on that runner, not Settings', () => {
    const a = credentialExpiredAlert({ name: 'box-1', backend: 'claude', authSource: 'machine_login' }, 'Task: x');
    expect(a.message).toContain('`claude login`');
    expect(a.message).toContain('on box-1');
    expect(a.message).toContain('Task: x');
    expect(a.url).toBe('https://buildd.dev/app/settings/runners');
  });
  it('machine_token: names the token to replace', () => {
    const a = credentialExpiredAlert({ name: 'box-1', backend: 'claude', authSource: 'machine_token' }, '');
    expect(a.message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(a.message).not.toContain('Task:');
  });
  it('codex names Codex and codex login', () => {
    const a = credentialExpiredAlert({ name: 'box-2', backend: 'codex', authSource: 'machine_login' }, '');
    expect(a.title).toContain('Codex');
    expect(a.message).toContain('`codex login`');
  });
  it('api_key: points to where keys are configured', () => {
    const a = credentialExpiredAlert({ name: 'box-1', backend: 'claude', authSource: 'api_key' }, '');
    expect(a.message).toContain('API key');
    expect(a.url).toBe('https://buildd.dev/app/settings/models');
  });
  it('unknown auth / runner: generic, no guess', () => {
    const a = credentialExpiredAlert(undefined, '');
    expect(a.message).toContain('on that runner');
    expect(a.message).toContain('`claude login`');
  });
  it('no copy tells anyone to set a login in Settings', () => {
    for (const authSource of ['machine_login', 'machine_token', 'none', null] as const) {
      expect(all(credentialExpiredAlert({ name: 'r', backend: 'claude', authSource }, ''))).not.toMatch(/set it again|Settings, Runners/);
    }
  });
});
