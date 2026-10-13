import { describe, expect, it } from 'bun:test';
import { PROVIDER_REGISTRY } from '@buildd/core/providers';
import { PROVIDER_API_SCOPES, writePermissions, writeStorage } from '@buildd/core/providers/manage';
import { fixtureResponse } from '../../../dev/fixtures/providers-fixture-data';
import {
  ADMINS_ONLY,
  MINE_NEEDS_PERSON,
  POLICY_BLOCKS_MINE,
  cardView,
  connectedProviders,
  loneProviderLine,
  usedForView,
  detectPaste,
  groupProviders,
  keyRuleLine,
  maskedValue,
  providersTitle,
  rowState,
  teamKeyWord,
  usesTeamLine,
  storedPolicyLine,
  servesLine,
  surfaceList,
  usedFor,
  writePermissionsFor,
} from './providers-view';

const listing = (res: ReturnType<typeof fixtureResponse>, id: string) => res.providers.find((p) => p.id === id)!;

describe('writePermissionsFor', () => {
  it('is every permission the server rule asks for, for every shape at every scope', () => {
    const res = fixtureResponse({ workspaceId: 'ws-a' });
    for (const p of PROVIDER_REGISTRY) {
      const l = listing(res, p.id);
      for (const shape of p.shapes) {
        const s = l.shapes.find((x) => x.id === shape.id)!;
        for (const scope of PROVIDER_API_SCOPES) {
          if (!s.writesTo[scope]) continue;
          const expected = scope === 'mine' ? [] : writePermissions(shape, writeStorage(p.id, shape, scope));
          expect(`${p.id}/${shape.id}/${scope}:${writePermissionsFor(s, scope).join('+')}`)
            .toBe(`${p.id}/${shape.id}/${scope}:${expected.join('+')}`);
        }
      }
    }
  });

  it('an Anthropic or OpenAI team key needs both the model-key and the team-credential permission', () => {
    const res = fixtureResponse({});
    for (const id of ['anthropic', 'openai']) {
      const s = listing(res, id).shapes.find((x) => x.id === 'api_key')!;
      expect(writePermissionsFor(s, 'team')).toEqual(['manage_team_model_keys', 'manage_team_credentials']);
    }
  });
});

describe('cardView follows every permission a write needs', () => {
  const only = (perm: string) => ({ manage_team_model_keys: false, manage_team_credentials: false, manage_inference_providers: false, manage_team_settings: false, [perm]: true });

  it('the model-key permission alone cannot change a key agent runs read, and says so', () => {
    const res = { ...fixtureResponse({ workspaceId: 'ws-a' }) };
    res.caller = { ...res.caller, can: only('manage_team_model_keys') };
    for (const id of ['anthropic', 'openai']) {
      for (const scope of ['team', 'workspace'] as const) {
        const v = cardView(listing(res, id), scope, res);
        expect(v.edit.kind).toBe('none');
        expect(v.readOnly).toBe(ADMINS_ONLY);
      }
    }
    expect(cardView(listing(res, 'openrouter'), 'team', res).edit).toEqual({ kind: 'paste', shape: 'api_key' });
  });

  it('the team-credential permission alone cannot change it either', () => {
    const res = { ...fixtureResponse({}) };
    res.caller = { ...res.caller, can: only('manage_team_credentials') };
    expect(cardView(listing(res, 'anthropic'), 'team', res).readOnly).toBe(ADMINS_ONLY);
  });
});

describe('servesLine', () => {
  it('renders the registry surfaces verbatim, with its reason for each surface it cannot serve', () => {
    const res = fixtureResponse({});
    for (const p of res.providers) {
      const line = servesLine(p);
      expect(line.serves.length + line.not.length).toBe(4);
      for (const n of line.not) {
        const s = p.surfaces[n.surface];
        expect(s.ok).toBe(false);
        expect(n.reason).toBe((s as { reason: string }).reason);
      }
    }
    const openai = servesLine(listing(res, 'openai'));
    expect(openai.serves).toEqual(['chat', 'agent-codex']);
    expect(openai.not.map((n) => n.surface)).toEqual(['agent-claude', 'cloud-egress']);
  });

  it('follows the surfaces the API returns, not a copy of them', () => {
    const p = { surfaces: { chat: { ok: false as const, reason: 'nope' }, 'agent-claude': { ok: true as const, via: 'x' }, 'agent-codex': { ok: true as const, via: 'x' }, 'cloud-egress': { ok: true as const, via: 'x' } } };
    expect(servesLine(p).serves).toEqual(['agent-claude', 'agent-codex', 'cloud-egress']);
    expect(surfaceList(['cloud-egress', 'chat'])).toBe('chat and cloud agents');
    expect(usedFor(['chat', 'agent-claude', 'cloud-egress'])).toBe('Used for chat, Claude agents and cloud agents.');
    expect(usedFor([])).toBe('Not used by anything.');
  });
});

describe('cardView', () => {
  it('an admin can paste an API key at team, workspace and mine', () => {
    const res = fixtureResponse({ workspaceId: 'ws-a', credentialPolicy: 'personal_first' });
    for (const scope of PROVIDER_API_SCOPES) {
      expect(cardView(listing(res, 'anthropic'), scope, res).edit).toEqual({ kind: 'paste', shape: 'api_key' });
    }
  });

  it('a member reads team and workspace rows with "Admins can change this"', () => {
    const res = fixtureResponse({ admin: false, workspaceId: 'ws-a', rows: [{ provider: 'anthropic', scope: 'team' }] });
    const v = cardView(listing(res, 'anthropic'), 'team', res);
    expect(v.edit.kind).toBe('none');
    expect(v.readOnly).toBe(ADMINS_ONLY);
    expect(v.rows).toHaveLength(1);
    expect(cardView(listing(res, 'anthropic'), 'workspace', res).readOnly).toBe(ADMINS_ONLY);
  });

  it('a workspace with no override shows the team rows it inherits', () => {
    const res = fixtureResponse({ workspaceId: 'ws-a', rows: [{ provider: 'openrouter', scope: 'team' }] });
    const v = cardView(listing(res, 'openrouter'), 'workspace', res);
    expect(v.rows).toHaveLength(0);
    expect(v.inherited).toHaveLength(1);
  });

  it('a scope the registry closes shows its reason and no controls', () => {
    const res = fixtureResponse({ credentialPolicy: 'personal_first' });
    const v = cardView(listing(res, 'litellm'), 'mine', res);
    expect(v.closed).toBe((listing(res, 'litellm').scopes.mine as { reason: string }).reason);
    expect(v.edit.kind).toBe('none');
    expect(cardView(listing(res, 'claude-subscription'), 'mine', res).closed).toBeTruthy();
  });

  it('Mine is read-only under team-only policy, and for a caller who is not a person', () => {
    const team = fixtureResponse({ credentialPolicy: 'team' });
    expect(cardView(listing(team, 'anthropic'), 'mine', team).readOnly).toBe(POLICY_BLOCKS_MINE);
    // Unset is the default, your own key first: a person may add one.
    const unset = fixtureResponse({ credentialPolicy: null });
    expect(cardView(listing(unset, 'anthropic'), 'mine', unset).readOnly).toBeNull();
    const key = fixtureResponse({ canSetMine: false, credentialPolicy: 'personal_first' });
    expect(cardView(listing(key, 'anthropic'), 'mine', key).readOnly).toBe(MINE_NEEDS_PERSON);
  });

  it('subscription seats paste a setup token where one exists, and always offer the browser flow', () => {
    const res = fixtureResponse({});
    const claude = cardView(listing(res, 'claude-subscription'), 'team', res);
    expect(claude.edit).toEqual({ kind: 'paste', shape: 'setup_token' });
    expect(claude.connectInBrowser).toBe(true);
    const codex = cardView(listing(res, 'codex-subscription'), 'team', res);
    expect(codex.edit.kind).toBe('none');
    expect(codex.connectInBrowser).toBe(true);
  });

  it('gateways and endpoints are set up with their own forms', () => {
    const res = fixtureResponse({});
    expect(cardView(listing(res, 'litellm'), 'team', res).edit.kind).toBe('form');
    expect(cardView(listing(res, 'custom-endpoint'), 'team', res).edit.kind).toBe('form');
    const member = fixtureResponse({ admin: false });
    expect(cardView(listing(member, 'litellm'), 'team', member).readOnly).toBe(ADMINS_ONLY);
  });
});

describe('whose key copy', () => {
  it('the default needs no line on Models; You › Keys states the rule', () => {
    for (const credentialPolicy of [null, 'personal_first'] as const) {
      expect(storedPolicyLine({ credentialPolicy })).toBeNull();
      expect(keyRuleLine({ credentialPolicy })).toBe("Your key goes first. The team's key is the fallback.");
    }
  });
  it('a stored exception is one plain line', () => {
    expect(storedPolicyLine({ credentialPolicy: 'team' })).toBe('This team uses team keys only.');
    expect(storedPolicyLine({ credentialPolicy: 'personal_only' })).toBe('This team uses personal keys only.');
    expect(keyRuleLine({ credentialPolicy: 'team' })).toBe('This team uses team keys only.');
  });
  it('never says who pays, never uses an em dash', () => {
    for (const p of [null, 'team', 'personal_first', 'personal_only'] as const) {
      expect(keyRuleLine({ credentialPolicy: p })).not.toMatch(/who pays|—/i);
    }
  });
});

describe('rows', () => {
  it('groups Claude and OpenAI, in registry order', () => {
    const res = fixtureResponse({});
    expect(groupProviders(res.providers).map((g) => [g.id, g.label, g.members.map((m) => m.id)])).toEqual([
      ['claude', 'Claude', ['anthropic', 'claude-subscription']],
      ['openai', 'OpenAI', ['openai', 'codex-subscription']],
      ['openrouter', 'OpenRouter', ['openrouter']],
      ['litellm', 'LiteLLM gateway', ['litellm']],
      ['custom-endpoint', 'Custom endpoint', ['custom-endpoint']],
    ]);
  });

  it('reads the pasted format: Claude key, Claude setup token, OpenAI key', () => {
    expect(detectPaste('claude', ' sk-ant-api03-x ')).toEqual({ provider: 'anthropic', shape: 'api_key' });
    expect(detectPaste('claude', 'sk-ant-oat01-x')).toEqual({ provider: 'claude-subscription', shape: 'setup_token' });
    expect(detectPaste('openai', 'sk-proj-x')).toEqual({ provider: 'openai', shape: 'api_key' });
    expect('error' in detectPaste('claude', 'sk-proj-x')).toBe(true);
    expect('error' in detectPaste('openai', 'nope')).toBe(true);
  });

  it('one status word per row', () => {
    const r = (o: Record<string, unknown>) => ({ health: 'unknown', lastVerificationError: null, ...o }) as never;
    expect(rowState([r({ health: 'healthy' })], [], null).word).toBe('Working');
    expect(rowState([r({ health: 'revoked' })], [], null).word).toBe('Needs attention');
    expect(rowState([r({ lastVerificationError: 'bad' })], [], null).word).toBe('Needs attention');
    expect(rowState([], [r({})], null).word).toBe('Team key');
    expect(rowState([], [], 'team only').word).toBe('Not available');
    expect(rowState([], [], null).word).toBe('Not set');
    expect(rowState([], [r({})], null, 'Acme').word).toBe("Acme's key");
  });

  it('names the team: its key, its settings, and the Providers heading when the caller is in several', () => {
    expect(teamKeyWord('Acme')).toBe("Acme's key");
    expect(teamKeyWord(null)).toBe('Team key');
    expect(teamKeyWord('  ')).toBe('Team key');
    expect(usesTeamLine('Acme')).toBe("Uses Acme's settings.");
    expect(usesTeamLine(undefined)).toBe('Uses team settings.');
    expect(providersTitle({ teamName: 'Acme', teamCount: 2 })).toBe('Providers · Acme');
    expect(providersTitle({ teamName: 'Acme', teamCount: 1 })).toBe('Providers');
    expect(providersTitle({ teamName: null, teamCount: 3 })).toBe('Providers');
    expect(providersTitle(null)).toBe('Providers');
  });

  it('masks a key by its last four, and names a subscription', () => {
    expect(maskedValue({ shape: 'api_key', last4: 'a1b2' })).toBe('…a1b2');
    expect(maskedValue({ shape: 'setup_token', last4: 'bAAA' })).toBe('Subscription …bAAA');
    expect(maskedValue({ shape: 'oauth_managed', last4: null })).toBe('Subscription');
    expect(maskedValue({ shape: 'gateway', last4: 'zz' })).toBe('Configured');
  });
});

describe('Used for: a choice only once there is one', () => {
  it('nothing or one provider connected: no rows; one provider says what it is used for', () => {
    expect(usedForView(fixtureResponse({}), {})).toBeNull();
    const one = fixtureResponse({ rows: [{ provider: 'openrouter', scope: 'team' }] });
    expect(usedForView(one, {})).toBeNull();
    expect(loneProviderLine(one)).toMatch(/^OpenRouter is used for chat/);
    expect(loneProviderLine(fixtureResponse({}))).toBeNull();
  });

  it('a personal key alone is not a team provider', () => {
    const res = fixtureResponse({ rows: [{ provider: 'openai', scope: 'mine' }, { provider: 'openrouter', scope: 'team' }] });
    expect(connectedProviders(res).map((p) => p.id)).toEqual(['openrouter']);
    expect(usedForView(res, {})).toBeNull();
  });

  it('two connected: one row per surface, impossible options disabled with what they need', () => {
    const res = fixtureResponse({ rows: [{ provider: 'openrouter', scope: 'team' }, { provider: 'codex-subscription', scope: 'team', shape: 'oauth_managed' }] });
    const rows = usedForView(res, {})!;
    expect(rows.map((r) => r.surface)).toEqual(['chat', 'agent-claude', 'agent-codex', 'cloud-egress']);
    const chat = rows.find((r) => r.surface === 'chat')!;
    const seat = chat.options.find((o) => o.value === 'codex-subscription')!;
    expect(seat.disabled).toBe(true);
    expect(seat.description).toBeTruthy();
    expect(chat.options.find((o) => o.value === 'openrouter')!.disabled).toBe(false);
    expect(rows.every((r) => r.value === null)).toBe(true);
  });

  it('options are named like the rows, and a provider whose team keys all fail cannot be picked', () => {
    const res = fixtureResponse({ rows: [
      { provider: 'anthropic', scope: 'team' },
      { provider: 'openrouter', scope: 'team' },
      { provider: 'openai', scope: 'team', health: 'revoked' },
    ] });
    const chat = usedForView(res, {})!.find((r) => r.surface === 'chat')!;
    expect(chat.options.find((o) => o.value === 'anthropic')!.label).toBe('Claude');
    expect(chat.options.find((o) => o.value === 'openai')).toMatchObject({ label: 'OpenAI', disabled: true, description: 'Needs a working key' });
    // Two of one group serving the same surface: each by its own name.
    const both = fixtureResponse({ rows: [{ provider: 'anthropic', scope: 'team' }, { provider: 'claude-subscription', scope: 'team', shape: 'setup_token' }] });
    const claude = usedForView(both, {})!.find((r) => r.surface === 'agent-claude')!;
    expect(claude.options.map((o) => o.label).sort()).toEqual(['Anthropic', 'Claude subscription'].sort());
  });

  it('a group appears once per surface: a member that cannot serve it is left out when another can', () => {
    const both = fixtureResponse({ rows: [{ provider: 'anthropic', scope: 'team' }, { provider: 'claude-subscription', scope: 'team', shape: 'setup_token' }, { provider: 'openrouter', scope: 'team' }] });
    const rows = usedForView(both, {})!;
    const chat = rows.find((r) => r.surface === 'chat')!;
    expect(chat.options.filter((o) => o.label === 'Claude')).toEqual([{ value: 'anthropic', label: 'Claude', disabled: false }]);
    expect(chat.options.some((o) => o.value === 'claude-subscription')).toBe(false);
    // Where no member serves, the group still shows once, disabled with what it needs.
    for (const r of rows) {
      const labels = r.options.map((o) => o.label);
      expect(labels).toEqual([...new Set(labels)]);
    }
  });

  it('a stored pick shows; a pick the surface cannot use reads as automatic', () => {
    const res = fixtureResponse({ rows: [{ provider: 'openrouter', scope: 'team' }, { provider: 'anthropic', scope: 'team' }] });
    const rows = usedForView(res, { chat: 'openrouter', 'agent-codex': 'anthropic' })!;
    expect(rows.find((r) => r.surface === 'chat')!.value).toBe('openrouter');
    expect(rows.find((r) => r.surface === 'agent-codex')!.value).toBeNull();
  });
});
