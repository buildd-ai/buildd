import { describe, expect, it } from 'bun:test';
import {
  CHAT_PROVIDER_INFO,
  checkKeyShape,
  effectiveKeySource,
  formatCheckedAgo,
  keyHealthPill,
  normalizeProviderKeys,
  toKeyStatus,
} from './provider-keys-client';

// Illustrative fixtures only. Nothing here is a real key.
const NOW = new Date('2026-09-26T12:00:00Z');

const masked = (over: Record<string, unknown> = {}) => ({
  id: 'k1', provider: 'anthropic', scope: 'team', last4: '4f2a', health: 'healthy',
  lastVerifiedAt: '2026-09-26T10:00:00Z', lastVerificationError: null,
  updatedAt: '2026-09-26T10:00:00Z', source: 'inference_key', ...over,
});

describe('CHAT_PROVIDER_INFO', () => {
  it('covers exactly the providers chat accepts, in display order', () => {
    expect(CHAT_PROVIDER_INFO.map((p) => p.id)).toEqual(['anthropic', 'openai', 'openrouter']);
  });
});

describe('effectiveKeySource: which key a chat turn uses', () => {
  it('prefers your own key over the workspace and team keys', () => {
    expect(effectiveKeySource({ own: true, workspace: true, team: true })).toBe('own');
  });

  it('falls back to the workspace key, then the team key', () => {
    expect(effectiveKeySource({ own: false, workspace: true, team: true })).toBe('workspace');
    expect(effectiveKeySource({ own: false, workspace: false, team: true })).toBe('team');
  });

  it('returns none when no key resolves, so chat never starts a turn', () => {
    expect(effectiveKeySource({ own: false, workspace: false, team: false })).toBe('none');
  });

  it('skips a key the provider rejected', () => {
    expect(effectiveKeySource({ own: true, ownFailing: true, workspace: false, team: true })).toBe('team');
  });
});

describe('checkKeyShape', () => {
  it('rejects an empty value', () => {
    expect(checkKeyShape('anthropic', '   ').ok).toBe(false);
  });

  it('rejects a Claude subscription token, which cannot make API calls', () => {
    const r = checkKeyShape('anthropic', 'sk-ant-oat01-example-example');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/subscription/i);
  });

  it('accepts an Anthropic API key', () => {
    expect(checkKeyShape('anthropic', 'sk-ant-api03-example-example').ok).toBe(true);
  });

  it('warns but accepts an unexpected prefix, since providers change formats', () => {
    const r = checkKeyShape('openrouter', 'abc-example-example-example');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/sk-or-/);
  });

  it('strips a wrapping pair of quotes before checking', () => {
    const r = checkKeyShape('openai', '"sk-proj-example-example"');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('sk-proj-example-example');
  });
});

describe('toKeyStatus', () => {
  it('shows only the last four characters', () => {
    expect(toKeyStatus(masked() as never)).toMatchObject({ masked: '…4f2a', health: 'ok', managedHere: true });
  });

  it('maps provider health to the UI states', () => {
    expect(toKeyStatus(masked({ health: 'revoked', lastVerificationError: 'HTTP 401' }) as never))
      .toMatchObject({ health: 'failing', error: 'HTTP 401' });
    expect(toKeyStatus(masked({ health: 'degraded' }) as never).health).toBe('degraded');
    expect(toKeyStatus(masked({ health: 'unknown' }) as never).health).toBe('unknown');
  });

  it('marks a key that serves chat from elsewhere as not managed here', () => {
    const s = toKeyStatus(masked({ source: 'anthropic_api_key' }) as never)!;
    expect(s.managedHere).toBe(false);
    expect(s.sourceNote).toMatch(/Agent backends/);
  });

  it('returns null for no key', () => {
    expect(toKeyStatus(null)).toBeNull();
  });
});

describe('keyHealthPill', () => {
  it('maps each state to a pill tone and label', () => {
    expect(keyHealthPill(null)).toEqual({ tone: 'idle', label: 'not connected' });
    expect(keyHealthPill({ health: 'ok' })).toEqual({ tone: 'ok', label: 'working' });
    expect(keyHealthPill({ health: 'failing' })).toEqual({ tone: 'err', label: 'rejected' });
    expect(keyHealthPill({ health: 'degraded' })).toEqual({ tone: 'warn', label: 'degraded' });
    expect(keyHealthPill({ health: 'unknown' })).toEqual({ tone: 'warn', label: 'not tested' });
  });
});

describe('formatCheckedAgo', () => {
  it('says never when the key was not checked', () => {
    expect(formatCheckedAgo(null, NOW)).toBe('never checked');
  });

  it('rounds to the largest sensible unit', () => {
    expect(formatCheckedAgo('2026-09-26T11:59:40Z', NOW)).toBe('checked just now');
    expect(formatCheckedAgo('2026-09-26T11:55:00Z', NOW)).toBe('checked 5m ago');
    expect(formatCheckedAgo('2026-09-26T10:00:00Z', NOW)).toBe('checked 2h ago');
    expect(formatCheckedAgo('2026-09-23T12:00:00Z', NOW)).toBe('checked 3d ago');
  });
});

describe('normalizeProviderKeys', () => {
  it('returns one card per chat provider in display order, filling gaps', () => {
    const out = normalizeProviderKeys({
      teamId: 't', canManageTeamKeys: true,
      providers: [
        { provider: 'openrouter', team: masked({ provider: 'openrouter', last4: '91c0' }), mine: null, membersWithOwnKey: 2 },
      ],
    });
    expect(out.canManageTeamKeys).toBe(true);
    expect(out.providers.map((p) => p.provider)).toEqual(['anthropic', 'openai', 'openrouter']);
    expect(out.providers[0]).toEqual({ provider: 'anthropic', team: null, mine: null, membersWithOwnKey: null });
    expect(out.providers[2]).toMatchObject({ team: { masked: '…91c0' }, membersWithOwnKey: 2 });
  });

  it('keeps your own key separate from the team key', () => {
    const out = normalizeProviderKeys({
      teamId: 't', canManageTeamKeys: false,
      providers: [{ provider: 'anthropic', team: masked(), mine: masked({ id: 'k2', scope: 'user', last4: '7d31' }), membersWithOwnKey: null }],
    });
    expect(out.providers[0].mine?.masked).toBe('…7d31');
    expect(out.providers[0].team?.masked).toBe('…4f2a');
  });

  it('survives a malformed body', () => {
    const out = normalizeProviderKeys(null);
    expect(out.canManageTeamKeys).toBe(false);
    expect(out.providers.every((p) => !p.team && !p.mine)).toBe(true);
  });
});
