import { describe, it, expect } from 'bun:test';
import { modelAuthLabel, codexAuthLabel } from './model-auth-label';

describe('modelAuthLabel (docs/specs/runner-model-auth-source.md AC-7)', () => {
  it('names each reported source in words', () => {
    expect(modelAuthLabel('machine_token')).toEqual({ text: 'Uses a Claude token set on this machine', warning: false });
    expect(modelAuthLabel('machine_login')).toEqual({ text: "Uses this machine's Claude login", warning: false });
    expect(modelAuthLabel('api_key')).toEqual({ text: 'Uses an API key (billed per token)', warning: false });
  });

  it('turns none into the fix-it line, as a warning', () => {
    expect(modelAuthLabel('none')).toEqual({ text: 'No model login on this machine. Run', command: 'claude login', warning: true });
  });

  it('says not reported for an older runner, never none', () => {
    expect(modelAuthLabel(null)).toEqual({ text: 'Model login: not reported', warning: false });
    expect(modelAuthLabel(undefined)).toEqual({ text: 'Model login: not reported', warning: false });
  });

  it('treats an unlisted value as not reported', () => {
    expect(modelAuthLabel('sk-something' as never)).toEqual({ text: 'Model login: not reported', warning: false });
  });
});

describe('codexAuthLabel (docs/specs/runner-model-auth-source.md R-13, AC-13)', () => {
  it('names a reported Codex login in words', () => {
    expect(codexAuthLabel('machine_login')).toBe("Codex: uses this machine's Codex login");
    expect(codexAuthLabel('api_key')).toBe('Codex: uses an OpenAI API key (billed per token)');
  });

  it('shows nothing for none or not reported, so a Claude-only runner looks unchanged', () => {
    expect(codexAuthLabel('none')).toBeNull();
    expect(codexAuthLabel(null)).toBeNull();
    expect(codexAuthLabel(undefined)).toBeNull();
    expect(codexAuthLabel('sk-something' as never)).toBeNull();
  });
});
