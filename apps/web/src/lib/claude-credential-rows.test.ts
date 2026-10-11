import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_CREDENTIAL_PURPOSES,
  backendCredentialLabel,
  claudeCredentialRank,
  isBackendHealthRow,
  isTeamClaudeCredential,
} from './claude-credential-rows';

describe('team Claude credential rows', () => {
  it('reads the seat token and both Anthropic key storages', () => {
    expect([...CLAUDE_CREDENTIAL_PURPOSES].sort()).toEqual(['anthropic_api_key', 'inference_key', 'oauth_token']);
  });

  it('a team Anthropic key in canonical storage is one; another provider\'s key and a personal key are not', () => {
    expect(isTeamClaudeCredential({ purpose: 'inference_key', label: 'anthropic', userId: null })).toBe(true);
    expect(isTeamClaudeCredential({ purpose: 'inference_key', label: 'Anthropic' })).toBe(true);
    expect(isTeamClaudeCredential({ purpose: 'anthropic_api_key' })).toBe(true);
    expect(isTeamClaudeCredential({ purpose: 'oauth_token' })).toBe(true);
    expect(isTeamClaudeCredential({ purpose: 'inference_key', label: 'openrouter' })).toBe(false);
    expect(isTeamClaudeCredential({ purpose: 'inference_key', label: 'openai' })).toBe(false);
    expect(isTeamClaudeCredential({ purpose: 'inference_key', label: 'anthropic', userId: 'u-1' })).toBe(false);
  });

  it('ranks seat, then canonical, then legacy', () => {
    const rank = (r: { purpose: string; label?: string }) => claudeCredentialRank(r);
    expect(rank({ purpose: 'oauth_token' })).toBeLessThan(rank({ purpose: 'inference_key', label: 'anthropic' }));
    expect(rank({ purpose: 'inference_key', label: 'anthropic' })).toBeLessThan(rank({ purpose: 'anthropic_api_key' }));
    expect(rank({ purpose: 'inference_key', label: 'openrouter' })).toBe(-1);
  });
});

describe('Health page backend credential rows', () => {
  it('lists the canonical Anthropic key beside the legacy one and Codex, nothing else', () => {
    expect(isBackendHealthRow({ purpose: 'inference_key', label: 'anthropic' })).toBe(true);
    expect(isBackendHealthRow({ purpose: 'codex_credential' })).toBe(true);
    expect(isBackendHealthRow({ purpose: 'inference_key', label: 'openrouter' })).toBe(false);
    expect(isBackendHealthRow({ purpose: 'mcp_credential', label: 'X' })).toBe(false);
  });

  it('names the canonical row as the Anthropic API key', () => {
    expect(backendCredentialLabel('inference_key')).toBe('Anthropic API key');
    expect(backendCredentialLabel('anthropic_api_key')).toBe('Anthropic API key');
    expect(backendCredentialLabel('oauth_token')).toBe('Claude OAuth token');
  });
});
