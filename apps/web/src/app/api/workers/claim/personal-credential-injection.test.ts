import { describe, it, expect, mock } from 'bun:test';
import type { ClaimTasksResponse } from '@buildd/shared';
import type { ProviderCredentialResult, ResolveProviderCredentialInput } from '@buildd/core/providers/resolve';
import {
  PERSONAL_CREDENTIAL_RUNNER_FEATURE,
  attachPersonalCredentials,
  decidePersonalCredential,
  type PersonalCredentialDecision,
  type PersonalCredentialDeps,
  type PersonalCredentialInput,
} from './personal-credential-injection';

const ALICE = 'user-alice';

function personalResult(value = 'sk-ant-alice', provider: 'anthropic' | 'openai' = 'anthropic'): ProviderCredentialResult {
  return {
    credential: { provider, shape: 'api_key', value, tokenExpiresAt: null },
    provider,
    scope: 'personal',
    source: { scope: 'personal', secretId: 'sec-alice', purpose: 'inference_key', label: provider, legacy: false },
    why: [],
  };
}
function teamResult(): ProviderCredentialResult {
  return {
    credential: { provider: 'anthropic', shape: 'api_key', value: 'sk-ant-team', tokenExpiresAt: null },
    provider: 'anthropic',
    scope: 'team',
    source: { scope: 'team', secretId: 'sec-team', purpose: 'anthropic_api_key', label: null, legacy: true },
    why: [],
  };
}
const none: ProviderCredentialResult = { none: true, reason: 'no_credential', why: [] };

function deps(opts: {
  policy?: unknown;
  requester?: string | null;
  result?: ProviderCredentialResult;
  teamThrows?: boolean;
}) {
  const resolve = mock(async (_i: ResolveProviderCredentialInput) => opts.result ?? none);
  const requesterOf = mock(async () => opts.requester ?? null);
  const loadTeam = mock(async () => {
    if (opts.teamThrows) throw new Error('db down');
    return opts.policy === undefined ? null : { credentialPolicy: opts.policy };
  });
  return { resolve, requesterOf, loadTeam, d: { resolve, requesterOf, loadTeam } as PersonalCredentialDeps };
}

function input(over: Partial<PersonalCredentialInput> = {}): PersonalCredentialInput {
  return {
    task: { id: 'task-1', backend: 'claude', createdByUserId: ALICE },
    teamId: 'team-1',
    workspaceId: 'ws-1',
    accountId: 'acct-runner',
    runnerFeatures: [PERSONAL_CREDENTIAL_RUNNER_FEATURE],
    cloud: false,
    interactive: false,
    ...over,
  };
}

describe('decidePersonalCredential', () => {
  describe('credential_policy NULL (the default): nothing changes', () => {
    for (const policy of [undefined, null, 'garbage']) {
      it(`policy ${String(policy)}: legacy, no marker, and no requester or credential lookup`, async () => {
        const x = deps({ policy, requester: ALICE, result: personalResult() });
        const d = await decidePersonalCredential(input(), x.d);
        expect(d).toEqual({ kind: 'legacy' });
        expect(x.requesterOf).not.toHaveBeenCalled();
        expect(x.resolve).not.toHaveBeenCalled();
      });
    }

    it('a team-policy lookup failure reads as no policy', async () => {
      const x = deps({ teamThrows: true, result: personalResult() });
      expect(await decidePersonalCredential(input(), x.d)).toEqual({ kind: 'legacy' });
      expect(x.resolve).not.toHaveBeenCalled();
    });
  });

  it('policy team: legacy with a marker, never a personal lookup', async () => {
    const x = deps({ policy: 'team', requester: ALICE, result: personalResult() });
    const d = await decidePersonalCredential(input(), x.d);
    expect(d).toEqual({ kind: 'legacy', marker: { surface: 'agent-claude', policy: 'team', scope: 'team', runnerLocalAllowed: true } });
    expect(x.resolve).not.toHaveBeenCalled();
  });

  describe('personal_first', () => {
    it('the requester has a key: it is used', async () => {
      const x = deps({ policy: 'personal_first', requester: ALICE, result: personalResult() });
      const d = await decidePersonalCredential(input(), x.d);
      expect(d.kind).toBe('personal');
      expect((d as any).value).toBe('sk-ant-alice');
      expect((d as any).marker).toEqual({ surface: 'agent-claude', policy: 'personal_first', scope: 'personal', provider: 'anthropic', runnerLocalAllowed: true });
      // The resolver is asked for exactly the requester, the API-key provider and the claim's scope.
      expect(x.resolve.mock.calls[0][0]).toMatchObject({
        teamId: 'team-1', workspaceId: 'ws-1', accountId: 'acct-runner', requesterUserId: ALICE,
        surface: 'agent-claude', provider: 'anthropic', team: { credentialPolicy: 'personal_first' },
      });
    });

    it('a Codex task asks for the requester\'s OpenAI key', async () => {
      const x = deps({ policy: 'personal_first', requester: ALICE, result: personalResult('sk-oai-alice', 'openai') });
      const d = await decidePersonalCredential(input({ task: { id: 't', backend: 'codex', createdByUserId: ALICE } }), x.d);
      expect(x.resolve.mock.calls[0][0]).toMatchObject({ surface: 'agent-codex', provider: 'openai' });
      expect(d.kind).toBe('personal');
    });

    it('the requester has no key: team credentials, as before', async () => {
      const x = deps({ policy: 'personal_first', requester: ALICE, result: none });
      expect((await decidePersonalCredential(input(), x.d)).kind).toBe('legacy');
    });

    it('the resolver found only a team key: the legacy path picks team credentials (resolver result unused)', async () => {
      const x = deps({ policy: 'personal_first', requester: ALICE, result: teamResult() });
      const d = await decidePersonalCredential(input(), x.d);
      expect(d.kind).toBe('legacy');
      expect(JSON.stringify(d)).not.toContain('sk-ant-team');
    });

    it('no requester: team credentials, and no personal lookup at all', async () => {
      const x = deps({ policy: 'personal_first', requester: null, result: personalResult() });
      expect((await decidePersonalCredential(input({ task: { id: 't', backend: 'claude' } }), x.d)).kind).toBe('legacy');
      expect(x.resolve).not.toHaveBeenCalled();
    });

    it('a runner without the feature never receives the personal key', async () => {
      const x = deps({ policy: 'personal_first', requester: ALICE, result: personalResult() });
      const d = await decidePersonalCredential(input({ runnerFeatures: ['agent_endpoint'] }), x.d);
      expect(d.kind).toBe('legacy');
      expect(JSON.stringify(d)).not.toContain('sk-ant-alice');
    });

    it('a cloud claim is left to cloud egress: legacy, no lookup, no key on the claim', async () => {
      const x = deps({ policy: 'personal_first', requester: ALICE, result: personalResult() });
      expect(await decidePersonalCredential(input({ cloud: true }), x.d)).toEqual({ kind: 'legacy' });
      expect(x.resolve).not.toHaveBeenCalled();
    });
  });

  describe('personal_only', () => {
    it('the requester has a key: it is used, and a machine login may not displace it', async () => {
      const x = deps({ policy: 'personal_only', requester: ALICE, result: personalResult() });
      const d = await decidePersonalCredential(input(), x.d);
      expect(d.kind).toBe('personal');
      expect((d as any).marker.runnerLocalAllowed).toBe(false);
    });

    const refusals: Array<[string, Partial<PersonalCredentialInput>, { requester?: string | null; result?: ProviderCredentialResult }, string]> = [
      ['no requester', { task: { id: 't', backend: 'claude' } }, { requester: null, result: personalResult() }, 'no_requester'],
      ['requester has no key', {}, { requester: ALICE, result: none }, 'requester_has_no_key'],
      ['resolver offers only a team key', {}, { requester: ALICE, result: teamResult() }, 'requester_has_no_key'],
      ['runner lacks the feature', { runnerFeatures: undefined }, { requester: ALICE, result: personalResult() }, 'runner_lacks_feature'],
      ['cloud claim, egress would find no personal route', { cloud: true }, { requester: ALICE, result: teamResult() }, 'requester_has_no_key'],
      ['cloud claim, no requester', { cloud: true, task: { id: 't', backend: 'claude' } }, { requester: null, result: personalResult() }, 'no_requester'],
    ];
    for (const [name, over, o, cause] of refusals) {
      it(`${name}: refused (${cause}), never a team fallback`, async () => {
        const x = deps({ policy: 'personal_only', ...o });
        const d = await decidePersonalCredential(input(over), x.d);
        expect(d).toEqual({ kind: 'refuse', detail: { cause: cause as any, policy: 'personal_only', surface: 'agent-claude' } });
      });
    }

    it('a cloud claim whose requester has a personal egress route is claimed, carrying no key', async () => {
      const x = deps({ policy: 'personal_only', requester: ALICE, result: personalResult() });
      const d = await decidePersonalCredential(input({ cloud: true }), x.d);
      expect(d).toEqual({ kind: 'legacy' });
      expect(x.resolve.mock.calls[0][0]).toMatchObject({ surface: 'cloud-egress', requesterUserId: ALICE });
      expect(x.resolve.mock.calls[0][0].provider).toBeUndefined();
    });

    it('a resolver failure refuses rather than falling back to team keys', async () => {
      const x = deps({ policy: 'personal_only', requester: ALICE });
      x.resolve.mockImplementation(async () => { throw new Error('boom'); });
      expect((await decidePersonalCredential(input(), x.d)).kind).toBe('refuse');
    });

    it('an interactive session runs on the person\'s own login: no model credential, not refused', async () => {
      const x = deps({ policy: 'personal_only', requester: ALICE, result: personalResult() });
      const d = await decidePersonalCredential(input({ interactive: true }), x.d);
      expect(d).toEqual({ kind: 'withhold', marker: { surface: 'agent-claude', policy: 'personal_only', scope: 'none', runnerLocalAllowed: true } });
    });
  });
});

describe('attachPersonalCredentials', () => {
  const worker = (id: string, taskId: string) => ({ id, taskId, branch: 'b', task: { id: taskId } }) as unknown as ClaimTasksResponse['workers'][number];
  const marker = { surface: 'agent-claude', policy: 'personal_first', scope: 'personal', provider: 'anthropic', runnerLocalAllowed: true } as const;

  it('writes only the owner\'s key onto the owner\'s worker, and nothing onto anyone else\'s', () => {
    const workers = [worker('w-alice', 't-alice'), worker('w-bob', 't-bob'), worker('w-null', 't-null')];
    const decisions = new Map<string, PersonalCredentialDecision>([
      ['t-alice', { kind: 'personal', provider: 'anthropic', value: 'sk-ant-alice', marker }],
      ['t-bob', { kind: 'legacy', marker: { ...marker, scope: 'team', provider: undefined } }],
    ]);
    const owned = attachPersonalCredentials(workers, decisions);
    expect([...owned]).toEqual(['w-alice']);
    expect((workers[0] as any).serverApiKey).toBe('sk-ant-alice');
    expect((workers[0] as any).credentialDecision).toEqual(marker);
    for (const w of workers.slice(1)) expect(JSON.stringify(w)).not.toContain('sk-ant-alice');
    // NULL-policy worker: untouched.
    expect(Object.keys(workers[2]).sort()).toEqual(['branch', 'id', 'task', 'taskId']);
  });

  it('a Codex worker gets the key in the api_key codexCredential shape', () => {
    const w = worker('w', 't');
    attachPersonalCredentials([w], new Map([[ 't', { kind: 'personal', provider: 'openai', value: 'sk-oai', marker: { ...marker, surface: 'agent-codex', provider: 'openai' } } as PersonalCredentialDecision ]]));
    expect((w as any).codexCredential).toEqual({ credentialType: 'api_key', apiKey: 'sk-oai', expiresAt: null });
    expect((w as any).serverApiKey).toBeUndefined();
  });

  it('withhold owns the worker without attaching anything', () => {
    const w = worker('w', 't');
    const owned = attachPersonalCredentials([w], new Map([[ 't', { kind: 'withhold', marker: { ...marker, policy: 'personal_only', scope: 'none' } } as PersonalCredentialDecision ]]));
    expect(owned.has('w')).toBe(true);
    expect((w as any).serverApiKey).toBeUndefined();
  });
});
