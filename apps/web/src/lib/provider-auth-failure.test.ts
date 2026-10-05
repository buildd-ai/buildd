import { describe, expect, it } from 'bun:test';
import { AGENT_CREDENTIAL_HREF, explainProviderAuthFailure } from './provider-auth-failure';

describe('explainProviderAuthFailure: a provider sign-in failure reads as a plain next step', () => {
  it('maps the Claude CLI "Not logged in · Please run /login" text to the credential setting', () => {
    const out = explainProviderAuthFailure('Not logged in · Please run /login', 'claude');
    expect(out).not.toBeNull();
    expect(out!.href).toBe(AGENT_CREDENTIAL_HREF);
    expect(out!.href).toBe('/app/settings/runners#agent-backends');
    // Plain words: no CLI slash command, nothing telling a web user to run /login.
    expect(out!.message).not.toContain('/login');
    expect(out!.message.toLowerCase()).toContain('key');
    expect(out!.linkLabel.length).toBeGreaterThan(0);
  });

  it('matches regardless of case and surrounding stderr', () => {
    const raw = '[mcp-sdk] some noise\nError: NOT LOGGED IN · please run /login\nmore noise';
    expect(explainProviderAuthFailure(raw, null)).not.toBeNull();
  });

  it('maps other provider-auth failures (invalid key, 401, expired OAuth)', () => {
    for (const raw of ['Invalid API key · Fix external API key', 'API Error: 401 Unauthorized', 'OAuth token has expired']) {
      expect(explainProviderAuthFailure(raw, 'claude')).not.toBeNull();
    }
  });

  it('says the key was revoked when the provider invalidated it', () => {
    const out = explainProviderAuthFailure('invalid_grant: refresh token is invalid', 'claude');
    expect(out!.message.toLowerCase()).toContain('revoked');
  });

  it('points a Codex task at Codex sign-in, not the Anthropic key', () => {
    const out = explainProviderAuthFailure('No Codex auth found', 'codex');
    expect(out).not.toBeNull();
    expect(out!.href).toBe(AGENT_CREDENTIAL_HREF);
    expect(out!.message).toContain('Codex');
    expect(out!.message).not.toContain('Anthropic');
  });

  it('names bring-your-own-key options and never promotes a Claude subscription', () => {
    const out = explainProviderAuthFailure('Not logged in · Please run /login', 'claude')!;
    const text = `${out.message} ${out.linkLabel}`;
    expect(text).toContain('Anthropic');
    expect(text).toContain('OpenRouter');
    expect(text).toContain('LiteLLM');
    expect(text.toLowerCase()).not.toMatch(/subscription|seat|claude pro|claude max/);
    expect(text).not.toContain('—');
  });

  it('leaves unrelated failures alone', () => {
    expect(explainProviderAuthFailure('Tests failed: 3 of 12', 'claude')).toBeNull();
    expect(explainProviderAuthFailure('rate limit exceeded', 'claude')).toBeNull();
    expect(explainProviderAuthFailure(null, 'claude')).toBeNull();
    expect(explainProviderAuthFailure('   ', 'claude')).toBeNull();
  });
});
