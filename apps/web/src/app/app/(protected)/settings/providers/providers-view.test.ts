import { describe, expect, it } from 'bun:test';
import { PROVIDER_REGISTRY } from '@buildd/core/providers';
import { PROVIDER_API_SCOPES, writePermissions, writeStorage } from '@buildd/core/providers/manage';
import { fixtureResponse } from '../../../dev/fixtures/providers-fixture-data';
import {
  ADMINS_ONLY,
  MINE_NEEDS_PERSON,
  POLICY_BLOCKS_MINE,
  POLICY_OPTIONS,
  POLICY_UNSET,
  cardView,
  explainAs,
  explainLine,
  explainUrl,
  policySentence,
  servesLine,
  surfaceList,
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
    expect(surfaceList(['cloud-egress', 'chat'])).toBe('Chat · cloud runs');
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
    const unset = fixtureResponse({ credentialPolicy: null });
    expect(cardView(listing(unset, 'anthropic'), 'mine', unset).readOnly).toBe(POLICY_BLOCKS_MINE);
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

describe('policy copy', () => {
  it('offers the three policies in plain words', () => {
    expect(POLICY_OPTIONS.map((o) => o.label)).toEqual(['Team key only', "Your key first, then the team's", 'Your key only (no team key)']);
  });
  it('says an unset policy leaves agents on team keys', () => {
    expect(policySentence({ credentialPolicy: null })).toBe(POLICY_UNSET);
    expect(POLICY_UNSET).toContain('agents use team keys');
    expect(policySentence({ credentialPolicy: 'personal_first' })).toBe("Agent runs and chat: your key first, then the team's.");
  });
  it('never uses an em dash', () => {
    for (const o of POLICY_OPTIONS) expect(`${o.label}${o.hint}`).not.toContain('—');
  });
});

describe('explain', () => {
  const label = (id: string) => ({ anthropic: 'Anthropic' } as Record<string, string>)[id] ?? id;
  it('names the provider, shape and whose key, never a value', () => {
    expect(explainLine({
      surface: 'agent-claude',
      result: { resolved: true, provider: 'anthropic', shape: 'api_key', scope: 'team', source: { scope: 'team', secretId: 's', purpose: 'anthropic_api_key', label: null, legacy: true } },
    }, label)).toBe('Claude runs use Anthropic: API key, team key.');
    expect(explainLine({
      surface: 'chat',
      result: { resolved: true, provider: 'anthropic', shape: 'api_key', scope: 'personal', source: { scope: 'personal', secretId: 's', purpose: 'inference_key', label: 'anthropic', legacy: false } },
    }, label)).toBe('Chat uses Anthropic: API key, your key.');
  });
  it('passes the resolver reason through when nothing resolves', () => {
    expect(explainLine({ surface: 'agent-codex', result: { resolved: false, reason: 'No Codex credential is set.' } }, label))
      .toBe('Codex runs: No Codex credential is set.');
  });
  it('explains as you on Mine, as team work elsewhere', () => {
    expect(explainAs('mine', true)).toBe('self');
    expect(explainAs('mine', false)).toBe('team');
    expect(explainAs('team', true)).toBe('team');
    expect(explainUrl({ teamId: 't', provider: 'openai', surface: 'chat', workspaceId: 'w', as: 'team' }))
      .toBe('/api/providers/explain?teamId=t&provider=openai&surface=chat&as=team&workspaceId=w');
  });
});
