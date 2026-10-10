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
    expect(credentialBlockFromDeferral('provider_unavailable', { attemptedBackend: 'codex', flipFailure: 'no_credential' }))
      .toEqual({ route: 'codex', scope: 'team' });
  });
  it('states no key when Codex is paused or its slot is taken', () => {
    expect(credentialBlockFromDeferral('provider_unavailable', { attemptedBackend: 'codex', flipFailure: 'paused' })).toBeNull();
    expect(credentialBlockFromDeferral('provider_unavailable', { attemptedBackend: 'codex', flipFailure: 'slot_taken' })).toBeNull();
    expect(credentialBlockFromDeferral('provider_unavailable', { attemptedBackend: 'codex' })).toBeNull();
  });
  it('clears the stamp key on claim', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../app/api/workers/claim/route.ts'), 'utf8');
    expect(src).toContain('delete (patchedContext as Record<string, unknown>)[CREDENTIAL_BLOCK_CONTEXT_KEY]');
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
