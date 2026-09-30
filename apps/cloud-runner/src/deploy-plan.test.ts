import { describe, it, expect } from 'bun:test';
import { planDeploy, describePlan, dispatchUrl, type DeployInputs, type DeployStep } from './deploy-plan';

const URL_ = 'https://buildd-cloud-runner.example.workers.dev';
const DISPATCH = `${URL_}/dispatch`;
const GEN = 'generated-token-0000000000000000';

function inputs(over: Partial<DeployInputs> = {}): DeployInputs {
  return {
    mode: 'deploy',
    rotate: false,
    workspace: { id: 'ws-1', name: 'demo', webhookConfig: null },
    workerSecretNames: null,
    workerUrl: URL_,
    builddServer: 'https://buildd.example',
    runnerApiKey: 'bld_runner_key',
    generatedDispatchToken: GEN,
    ...over,
  };
}

const kinds = (steps: DeployStep[]) => steps.map((s) => (s.kind === 'put_secret' ? `put:${s.name}` : s.kind));

describe('planDeploy: first deploy', () => {
  it('deploys, puts all three secrets and points the workspace at /dispatch', () => {
    const p = planDeploy(inputs());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(kinds(p.steps)).toEqual(['wrangler_deploy', 'put:BUILDD_SERVER', 'put:BUILDD_API_KEY', 'put:DISPATCH_TOKEN', 'set_webhook']);
    const hook = p.steps.find((s) => s.kind === 'set_webhook');
    expect(hook).toMatchObject({ config: { url: DISPATCH, token: GEN, enabled: true } });
    const tok = p.steps.find((s) => s.kind === 'put_secret' && s.name === 'DISPATCH_TOKEN');
    expect(tok).toMatchObject({ value: GEN });
  });

  it('needs a runner key when the Worker has none', () => {
    const p = planDeploy(inputs({ runnerApiKey: undefined }));
    expect(p.ok).toBe(false);
  });

  it('refuses a runner key that is not a bld_ key', () => {
    expect(planDeploy(inputs({ runnerApiKey: 'sk-ant-nope' })).ok).toBe(false);
  });
});

describe('planDeploy: idempotent re-run', () => {
  const deployed = {
    workerSecretNames: ['DISPATCH_TOKEN', 'BUILDD_API_KEY', 'BUILDD_SERVER'],
    workspace: { id: 'ws-1', name: 'demo', webhookConfig: { url: DISPATCH, enabled: true, hasToken: true } },
    runnerApiKey: undefined,
  };

  it('rotates nothing: no token, no key, no webhook write', () => {
    const p = planDeploy(inputs(deployed));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(kinds(p.steps)).toEqual(['wrangler_deploy', 'put:BUILDD_SERVER']);
    expect(p.notes.join(' ')).toContain('token unchanged');
  });

  it('never uses the generated token unless it needs one', () => {
    const p = planDeploy(inputs(deployed));
    expect(JSON.stringify(p)).not.toContain(GEN);
  });

  it('--rotate issues the generated token and rewrites the webhook', () => {
    const p = planDeploy(inputs({ ...deployed, rotate: true }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(kinds(p.steps)).toEqual(['wrangler_deploy', 'put:BUILDD_SERVER', 'put:DISPATCH_TOKEN', 'set_webhook']);
    expect(p.steps.find((s) => s.kind === 'set_webhook')).toMatchObject({ config: { token: GEN } });
    expect(p.notes.join(' ')).toContain('other workspace');
  });

  it('a second workspace on an existing Worker needs the token or --rotate', () => {
    const p = planDeploy(inputs({ ...deployed, workspace: { id: 'ws-2', name: 'other', webhookConfig: null } }));
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.error).toContain('DISPATCH_TOKEN');
  });

  it('a supplied token points the second workspace without rotating', () => {
    const p = planDeploy(inputs({
      ...deployed, workspace: { id: 'ws-2', name: 'other', webhookConfig: null }, providedDispatchToken: 'existing-token',
    }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.steps.find((s) => s.kind === 'set_webhook')).toMatchObject({ workspaceId: 'ws-2', config: { token: 'existing-token' } });
  });

  it('a disabled webhook at the right URL is not "already pointed"', () => {
    const p = planDeploy(inputs({ ...deployed, workspace: { id: 'ws-1', name: 'demo', webhookConfig: { url: DISPATCH, enabled: false, hasToken: true } } }));
    expect(p.ok).toBe(false);
  });
});

describe('planDeploy: --remove', () => {
  it('clears the webhook and leaves the Worker alone', () => {
    const p = planDeploy(inputs({ mode: 'remove', workspace: { id: 'ws-1', name: 'demo', webhookConfig: { url: DISPATCH, enabled: true, hasToken: true } } }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(kinds(p.steps)).toEqual(['clear_webhook']);
    expect(p.notes.join(' ')).toContain('stays deployed');
  });

  it('is a no-op when there is no webhook', () => {
    const p = planDeploy(inputs({ mode: 'remove' }));
    expect(p.ok && p.steps.length).toBe(0);
  });

  it('warns when the webhook it clears points elsewhere', () => {
    const p = planDeploy(inputs({ mode: 'remove', workspace: { id: 'ws-1', name: 'demo', webhookConfig: { url: 'https://other.example/hook', enabled: true, hasToken: true } } }));
    expect(p.ok && p.notes[0]).toContain('not this Worker');
  });

  it('needs no runner key', () => {
    expect(planDeploy(inputs({ mode: 'remove', runnerApiKey: undefined })).ok).toBe(true);
  });
});

describe('describePlan (--dry-run output)', () => {
  it('prints every step with secrets redacted', () => {
    const lines = describePlan(planDeploy(inputs()));
    const text = lines.join('\n');
    expect(text).toContain('wrangler deploy');
    expect(text).toContain('wrangler secret put DISPATCH_TOKEN');
    expect(text).toContain(`url: ${DISPATCH}`);
    expect(text).toContain('https://buildd.example');
    expect(text).not.toContain(GEN);
    expect(text).not.toContain('bld_runner_key');
  });

  it('prints the error for a refused plan', () => {
    expect(describePlan(planDeploy(inputs({ runnerApiKey: undefined })))[0]).toStartWith('error:');
  });

  it('says nothing to do for an empty plan', () => {
    expect(describePlan(planDeploy(inputs({ mode: 'remove' })))[0]).toBe('nothing to do');
  });
});

describe('dispatchUrl', () => {
  it('appends /dispatch once', () => {
    expect(dispatchUrl(`${URL_}/`)).toBe(DISPATCH);
  });
});
