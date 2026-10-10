import { describe, expect, it } from 'bun:test';
import { credentialBlockFromDeferral, credentialBlockCopy, parseCredentialBlock } from './credential-block';

describe('credentialBlockFromDeferral', () => {
  it('names the Claude route for a personal-key refusal on agent-claude', () => {
    expect(credentialBlockFromDeferral('no_personal_credential', { surface: 'agent-claude', policy: 'personal_only' }))
      .toEqual({ route: 'claude', scope: 'personal' });
  });
  it('names Codex and cloud routes', () => {
    expect(credentialBlockFromDeferral('no_personal_credential', { surface: 'agent-codex', policy: 'personal_only' })?.route).toBe('codex');
    expect(credentialBlockFromDeferral('no_personal_credential', { surface: 'cloud-egress', policy: 'personal_only' })?.route).toBe('cloud');
  });
  it('treats a Codex task with no Codex credential as a team-key need', () => {
    expect(credentialBlockFromDeferral('provider_unavailable', { attemptedBackend: 'codex' }))
      .toEqual({ route: 'codex', scope: 'team' });
  });
  it('ignores unrelated deferrals', () => {
    expect(credentialBlockFromDeferral('workspace_cap', {})).toBeNull();
    expect(credentialBlockFromDeferral('provider_unavailable', { backend: 'claude', reason: 'pinned' })).toBeNull();
  });
});

describe('credentialBlockCopy', () => {
  it('says what is missing and links to the keys section', () => {
    expect(credentialBlockCopy({ route: 'claude', scope: 'team' })).toEqual({
      line: 'Needs a Claude key', cta: 'Add a Claude key', href: '/app/settings/models#keys',
    });
    expect(credentialBlockCopy({ route: 'codex', scope: 'team' }).line).toBe('Needs a Codex key');
    expect(credentialBlockCopy({ route: 'cloud', scope: 'team' }).line).toBe('Needs a cloud route key');
  });
  it('opens the Mine tab under a personal-only policy', () => {
    expect(credentialBlockCopy({ route: 'claude', scope: 'personal' }).href).toBe('/app/settings/models?scope=mine#keys');
  });
});

describe('parseCredentialBlock', () => {
  it('round-trips and rejects junk', () => {
    expect(parseCredentialBlock({ route: 'codex', scope: 'personal', at: 'x' })).toEqual({ route: 'codex', scope: 'personal' });
    expect(parseCredentialBlock({ route: 'gpt' })).toBeNull();
    expect(parseCredentialBlock(null)).toBeNull();
  });
});
