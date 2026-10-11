import { describe, expect, it } from 'bun:test';
import {
  CREDENTIAL_POLICIES,
  NO_PERSONAL_CREDENTIAL,
  SURFACES,
  appliedPolicy,
  hasRequester,
  normalizeRequester,
  personalRowEligible,
  policyAllowsScope,
  policyScopeReason,
  surfacePolicy,
  type CredentialPolicy,
  type PolicyScope,
  type Surface,
} from '../providers';

const AGENT_SURFACES: Surface[] = ['agent-claude', 'agent-codex', 'cloud-egress'];
const SHARED: PolicyScope[] = ['workspace', 'account', 'team', 'env'];

describe('surfacePolicy', () => {
  it('agent surfaces follow credentialPolicy only when it is set', () => {
    for (const surface of AGENT_SURFACES) {
      expect(surfacePolicy(null, surface)).toEqual({ policy: 'team', enforced: false, source: 'default' });
      expect(surfacePolicy({ credentialPolicy: null, inferenceKeyPolicy: 'own' }, surface))
        .toEqual({ policy: 'team', enforced: false, source: 'default' });
      expect(surfacePolicy({ credentialPolicy: 'bogus', inferenceKeyPolicy: 'team_or_own' }, surface).enforced).toBe(false);
      for (const policy of CREDENTIAL_POLICIES) {
        expect(surfacePolicy({ credentialPolicy: policy, inferenceKeyPolicy: 'team' }, surface))
          .toEqual({ policy, enforced: true, source: 'credential_policy' });
      }
    }
  });

  it('chat keeps effectiveKeyPolicy semantics: credentialPolicy, else inferenceKeyPolicy, else personal_first', () => {
    expect(surfacePolicy({ credentialPolicy: 'personal_only', inferenceKeyPolicy: 'team' }, 'chat'))
      .toEqual({ policy: 'personal_only', enforced: true, source: 'credential_policy' });
    expect(surfacePolicy({ credentialPolicy: null, inferenceKeyPolicy: 'team' }, 'chat'))
      .toEqual({ policy: 'team', enforced: true, source: 'inference_key_policy' });
    expect(surfacePolicy({ credentialPolicy: null, inferenceKeyPolicy: 'team_or_own' }, 'chat').policy).toBe('personal_first');
    expect(surfacePolicy({ credentialPolicy: null, inferenceKeyPolicy: 'own' }, 'chat').policy).toBe('personal_only');
    expect(surfacePolicy(null, 'chat')).toEqual({ policy: 'personal_first', enforced: true, source: 'default' });
    expect(surfacePolicy({}, 'chat').policy).toBe('personal_first');
  });
});

describe('policyAllowsScope: the full truth table', () => {
  // expected[policy][requester present?] = { personal, shared }
  const ENFORCED: Record<CredentialPolicy, Record<'yes' | 'no', { personal: boolean; shared: boolean }>> = {
    team: { yes: { personal: false, shared: true }, no: { personal: false, shared: true } },
    personal_first: { yes: { personal: true, shared: true }, no: { personal: false, shared: true } },
    personal_only: { yes: { personal: true, shared: false }, no: { personal: false, shared: false } },
  };

  for (const surface of SURFACES) {
    for (const policy of CREDENTIAL_POLICIES) {
      for (const req of ['yes', 'no'] as const) {
        for (const agentEnforced of [true, false]) {
          const hasReq = req === 'yes';
          // Not yet opted in: an agent surface reads every policy as `team`.
          const effective: CredentialPolicy = surface !== 'chat' && !agentEnforced ? 'team' : policy;
          const want = ENFORCED[effective][req];
          it(`${surface} ${policy} requester=${req} enforced=${agentEnforced}`, () => {
            const base = { policy, hasRequester: hasReq, surface, agentEnforced };
            expect(policyAllowsScope({ ...base, scope: 'personal' })).toBe(want.personal);
            for (const scope of SHARED) expect(policyAllowsScope({ ...base, scope })).toBe(want.shared);
            expect(appliedPolicy(base)).toBe(effective);
          });
        }
      }
    }
  }

  it('a closed scope always carries a reason, an open one never does', () => {
    for (const surface of SURFACES) for (const policy of CREDENTIAL_POLICIES) for (const hasReq of [true, false]) {
      for (const agentEnforced of [true, false]) for (const scope of ['personal', ...SHARED] as PolicyScope[]) {
        const input = { policy, scope, hasRequester: hasReq, surface, agentEnforced };
        expect(policyScopeReason(input) === null).toBe(policyAllowsScope(input));
      }
    }
  });

  it('names why an unenforced agent run ignores a personal credential', () => {
    expect(policyScopeReason({ policy: 'personal_first', scope: 'personal', hasRequester: true, surface: 'agent-claude', agentEnforced: false }))
      .toContain('until the team sets a credential policy');
  });

  it('exports the refusal code agents use when personal_only has nothing', () => {
    expect(NO_PERSONAL_CREDENTIAL).toBe('no_personal_credential');
  });
});

describe('requester rule', () => {
  const cases: Array<[string | null, string | null | undefined, boolean, string]> = [
    ['u1', 'u1', true, 'own row'],
    ['u1', 'u2', false, 'someone else'],
    ['u1', null, false, 'no requester'],
    ['u1', undefined, false, 'requester undefined'],
    ['u1', '', false, 'blank requester'],
    [null, 'u1', false, 'team row is not a personal row'],
    [null, null, false, 'team row, no requester'],
  ];
  for (const [row, requester, want, name] of cases) {
    it(name, () => expect(personalRowEligible(row, requester)).toBe(want));
  }

  it('normalizes blank to null', () => {
    expect(normalizeRequester('  ')).toBeNull();
    expect(normalizeRequester('u1')).toBe('u1');
    expect(hasRequester(null)).toBe(false);
    expect(hasRequester('u1')).toBe(true);
  });
});
