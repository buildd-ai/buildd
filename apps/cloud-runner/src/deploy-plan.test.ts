import { describe, it, expect } from 'bun:test';
import { SNAPSHOT_BUCKET, containerClasses, deployNames, renderWranglerConfig, planDeploy, describePlan, dispatchUrl, DISPATCH_EVENTS, type DeployInputs, type DeployStep } from './deploy-plan';

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

describe('snapshot bucket', () => {
  it('the bucket step names the bucket bound in wrangler.jsonc and the warm/ lifecycle backstop', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const text = readFileSync(join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const cfg = JSON.parse(text) as { r2_buckets: Array<{ binding: string; bucket_name: string }> };
    expect(cfg.r2_buckets).toEqual([{ binding: 'SNAPSHOTS', bucket_name: SNAPSHOT_BUCKET.name }]);
    expect(SNAPSHOT_BUCKET.lifecycle).toEqual([
      { id: 'warm-expiry', prefix: 'warm/', expireDays: 14 },
      { id: 'park-expiry', prefix: 'park/', expireDays: 2 },
    ]);
  });
});

describe('deploy names', () => {
  const base = () => require('fs').readFileSync(require('path').join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8') as string;
  const parse = (t: string) => JSON.parse(t.replace(/^\s*\/\/.*$/gm, '')) as { name: string; r2_buckets: Array<{ bucket_name: string }> };

  it('defaults to the names in wrangler.jsonc, so a plain deploy needs no generated config', () => {
    expect(deployNames()).toEqual({ worker: 'buildd-cloud-runner', bucket: SNAPSHOT_BUCKET.name, custom: false });
    const cfg = parse(base());
    expect(cfg.name).toBe(deployNames().worker);
  });

  it('derives the bucket from a custom Worker name', () => {
    expect(deployNames('agent-runtime-spike')).toEqual({ worker: 'agent-runtime-spike', bucket: 'agent-runtime-spike-snapshots', custom: true });
  });

  it('rejects names Cloudflare would refuse or that could escape the config', () => {
    for (const bad of ['', 'Upper', '-lead', 'has space', 'a"b', 'x'.repeat(50)]) expect(() => deployNames(bad)).toThrow();
  });

  it('renders a config with only the Worker name, its runner group and the bucket changed', () => {
    const out = renderWranglerConfig(base(), deployNames('agent-runtime-spike'));
    const a = parse(base()) as any, b = parse(out) as any;
    expect(b.name).toBe('agent-runtime-spike');
    expect(b.r2_buckets).toEqual([{ binding: 'SNAPSHOTS', bucket_name: 'agent-runtime-spike-snapshots' }]);
    // The fleet shows this deployment's runs as one group under its own name.
    expect(b.vars.RUNNER_GROUP).toBe('agent-runtime-spike');
    expect({ ...b, name: a.name, r2_buckets: a.r2_buckets, vars: { ...b.vars, RUNNER_GROUP: a.vars.RUNNER_GROUP } }).toEqual(a);
  });

  it('both container classes, each with its own instance type and ceiling, survive a custom-named render', () => {
    const want = [
      { className: 'WorkerAgent', instanceType: 'standard-1', maxInstances: expect.any(Number) },
      { className: 'WorkerAgentLarge', instanceType: 'standard-3', maxInstances: expect.any(Number) },
    ];
    expect(containerClasses(base())).toEqual(want);
    expect(containerClasses(renderWranglerConfig(base(), deployNames('agent-runtime-spike')))).toEqual(want);
  });

  it('refuses to render a config that lost a container class', () => {
    const oneClass = base().replace('"WorkerAgentLarge"', '"SomethingElse"');
    expect(() => renderWranglerConfig(oneClass, deployNames('agent-runtime-spike'))).toThrow(/WorkerAgentLarge/);
  });

  it('fails loudly if wrangler.jsonc no longer has the fields it rewrites', () => {
    expect(() => renderWranglerConfig('{ "main": "src/index.ts" }', deployNames('agent-runtime-spike'))).toThrow();
  });
});

describe('planDeploy: first deploy', () => {
  it('deploys, puts all three secrets and points the workspace at /dispatch', () => {
    const p = planDeploy(inputs());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER', 'put:BUILDD_API_KEY', 'put:DISPATCH_TOKEN', 'set_webhook']);
    const hook = p.steps.find((s) => s.kind === 'set_webhook');
    expect(hook).toMatchObject({ config: { url: DISPATCH, token: GEN, enabled: true } });
    // Opts into every dispatch event: without `events`, buildd sends a webhook
    // only new and unblocked tasks, and a push-only runner never sees a retry.
    expect(hook).toMatchObject({ config: { events: ['task.created', 'task.unblocked', 'task.retry', 'task.resume', 'task.scheduled'] } });
    expect([...DISPATCH_EVENTS]).toEqual(['task.created', 'task.unblocked', 'task.retry', 'task.resume', 'task.scheduled']);
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

describe('planDeploy: --secrets-only', () => {
  it('leaves the code alone (no bucket, no wrangler deploy), so no local Cloudflare token is needed', () => {
    const p = planDeploy(inputs({ skipWorkerDeploy: true, rotate: true, workerSecretNames: ['DISPATCH_TOKEN', 'BUILDD_API_KEY', 'BUILDD_SERVER'] }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(kinds(p.steps)).not.toContain('wrangler_deploy');
    expect(kinds(p.steps)).not.toContain('ensure_snapshot_bucket');
    expect(kinds(p.steps)).toContain('put:DISPATCH_TOKEN');
  });

  it('refuses a Worker that was never deployed', () => {
    expect(planDeploy(inputs({ skipWorkerDeploy: true, workerSecretNames: null })).ok).toBe(false);
  });
});

describe('planDeploy: idempotent re-run', () => {
  const deployed = {
    workerSecretNames: ['DISPATCH_TOKEN', 'BUILDD_API_KEY', 'BUILDD_SERVER'],
    workspace: {
      id: 'ws-1', name: 'demo',
      webhookConfig: { url: DISPATCH, enabled: true, hasToken: true, events: [...DISPATCH_EVENTS] as string[] | undefined },
    },
    runnerApiKey: undefined,
  };

  it('rotates nothing: no token, no key, no webhook write', () => {
    const p = planDeploy(inputs(deployed));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER']);
    expect(p.notes.join(' ')).toContain('token unchanged');
  });

  it('a webhook that already lists every event is left alone', () => {
    const p = planDeploy(inputs({
      ...deployed,
      workspace: { ...deployed.workspace, webhookConfig: { ...deployed.workspace.webhookConfig, events: [...DISPATCH_EVENTS] } },
    }));
    expect(p.ok && kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER']);
  });

  it('a webhook set before the events opt-in (no events) is opted in', () => {
    const p = planDeploy(inputs({
      ...deployed,
      workspace: { ...deployed.workspace, webhookConfig: { ...deployed.workspace.webhookConfig, events: undefined } },
    }));
    expect(p.ok && kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER', 'set_webhook']);
  });

  it('a webhook missing an event is opted in without touching the token', () => {
    const p = planDeploy(inputs({
      ...deployed,
      workspace: { ...deployed.workspace, webhookConfig: { ...deployed.workspace.webhookConfig, events: ['task.created'] } },
    }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER', 'set_webhook']);
    const hook = p.steps.find((s) => s.kind === 'set_webhook');
    // No token: PATCH merges, so the stored one stays.
    expect(hook).toMatchObject({ config: { url: DISPATCH, enabled: true, events: [...DISPATCH_EVENTS] } });
    expect(hook && 'config' in hook && 'token' in hook.config).toBe(false);
    expect(describePlan(p).join('\n')).toContain('token: (unchanged)');
  });

  it('never uses the generated token unless it needs one', () => {
    const p = planDeploy(inputs(deployed));
    expect(JSON.stringify(p)).not.toContain(GEN);
  });

  it('--rotate issues the generated token and rewrites the webhook', () => {
    const p = planDeploy(inputs({ ...deployed, rotate: true }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER', 'put:DISPATCH_TOKEN', 'set_webhook']);
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

  it('the deploy line names both container classes with their instance types and max_instances', () => {
    const classes = [
      { className: 'WorkerAgent', instanceType: 'standard-1', maxInstances: 10 },
      { className: 'WorkerAgentLarge', instanceType: 'standard-3', maxInstances: 4 },
    ];
    const deployLine = describePlan(planDeploy(inputs()), deployNames(), classes).find(l => l.startsWith('wrangler deploy'))!;
    expect(deployLine).toContain('WorkerAgent standard-1 max 10');
    expect(deployLine).toContain('WorkerAgentLarge standard-3 max 4');
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

describe('planDeploy: model proxy (--model-proxy-url)', () => {
  const deployed = {
    workerSecretNames: ['DISPATCH_TOKEN', 'BUILDD_API_KEY', 'BUILDD_SERVER'],
    workspace: {
      id: 'ws-1', name: 'demo',
      webhookConfig: { url: DISPATCH, enabled: true, hasToken: true, events: [...DISPATCH_EVENTS] as string[] },
    },
    runnerApiKey: undefined,
  };
  const PROXY_KEY = 'proxy-secret-key-123';

  it('puts the normalised URL and the key; the URL is printed, the key never is', () => {
    const p = planDeploy(inputs({ ...deployed, modelProxy: { url: 'https://litellm.example.com/anthropic/', key: PROXY_KEY } }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER', 'put:MODEL_PROXY_URL', 'put:MODEL_PROXY_KEY']);
    expect(p.steps.find((s) => s.kind === 'put_secret' && s.name === 'MODEL_PROXY_URL')).toMatchObject({ value: 'https://litellm.example.com/anthropic' });
    const text = describePlan(p).join('\n');
    expect(text).toContain('MODEL_PROXY_URL = https://litellm.example.com/anthropic');
    expect(text).toContain('wrangler secret put MODEL_PROXY_KEY = <redacted');
    expect(text).not.toContain(PROXY_KEY);
    expect(p.notes.join(' ')).toContain('proxy');
  });

  it('puts MODEL_PROXY_AUTH_HEADER when given, lowercased', () => {
    const p = planDeploy(inputs({ ...deployed, modelProxy: { url: 'https://litellm.example.com', key: PROXY_KEY, authHeader: 'X-Api-Key' } }));
    expect(p.ok && kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER', 'put:MODEL_PROXY_URL', 'put:MODEL_PROXY_KEY', 'put:MODEL_PROXY_AUTH_HEADER']);
    if (!p.ok) return;
    expect(p.steps.find((s) => s.kind === 'put_secret' && s.name === 'MODEL_PROXY_AUTH_HEADER')).toMatchObject({ value: 'x-api-key' });
    expect(describePlan(p).join('\n')).toContain('MODEL_PROXY_AUTH_HEADER = x-api-key');
  });

  it('refuses an unknown auth header', () => {
    const p = planDeploy(inputs({ ...deployed, modelProxy: { url: 'https://litellm.example.com', key: PROXY_KEY, authHeader: 'cookie' } }));
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toContain('MODEL_PROXY_AUTH_HEADER');
  });

  it('refuses a URL the Worker would refuse (plain http to a remote host, userinfo, query)', () => {
    for (const url of ['http://litellm.example.com', 'https://u:p@litellm.example.com', 'https://litellm.example.com/?a=1', 'nope']) {
      const p = planDeploy(inputs({ ...deployed, modelProxy: { url, key: PROXY_KEY } }));
      expect(p.ok).toBe(false);
      if (!p.ok) {
        expect(p.error).toContain('MODEL_PROXY_URL');
        expect(p.error).not.toContain(PROXY_KEY);
      }
    }
  });

  it('refuses a URL with no key when the Worker has none (it would never forward)', () => {
    const p = planDeploy(inputs({ ...deployed, modelProxy: { url: 'https://litellm.example.com' } }));
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toContain('MODEL_PROXY_KEY');
  });

  it('keeps the stored key when the Worker already has one', () => {
    const p = planDeploy(inputs({
      ...deployed, workerSecretNames: [...deployed.workerSecretNames, 'MODEL_PROXY_KEY'],
      modelProxy: { url: 'https://litellm.example.com' },
    }));
    expect(p.ok && kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER', 'put:MODEL_PROXY_URL']);
  });

  it('a key or header alone needs a proxy URL, supplied or already on the Worker', () => {
    expect(planDeploy(inputs({ ...deployed, modelProxy: { key: PROXY_KEY } })).ok).toBe(false);
    expect(planDeploy(inputs({ ...deployed, modelProxy: { authHeader: 'x-api-key' } })).ok).toBe(false);
    const p = planDeploy(inputs({
      ...deployed, workerSecretNames: [...deployed.workerSecretNames, 'MODEL_PROXY_URL', 'MODEL_PROXY_KEY'],
      modelProxy: { key: PROXY_KEY },
    }));
    expect(p.ok && kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER', 'put:MODEL_PROXY_KEY']);
  });

  it('without proxy flags nothing proxy-related is written, and an existing proxy is noted', () => {
    expect(kinds((planDeploy(inputs(deployed)) as { steps: DeployStep[] }).steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER']);
    const p = planDeploy(inputs({ ...deployed, workerSecretNames: [...deployed.workerSecretNames, 'MODEL_PROXY_URL', 'MODEL_PROXY_KEY'] }));
    expect(p.ok && kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER']);
    expect(p.ok && p.notes.join(' ')).toContain('MODEL_PROXY_URL');
  });

  it('empty strings count as not supplied', () => {
    const p = planDeploy(inputs({ ...deployed, modelProxy: { url: '', key: '', authHeader: '' } }));
    expect(p.ok && kinds(p.steps)).toEqual(['ensure_snapshot_bucket', 'wrangler_deploy', 'put:BUILDD_SERVER']);
  });
});

it('retains the Browser Rendering binding when rendering a custom deployment', () => {
  const base = require('fs').readFileSync(require('path').join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8');
  const config = JSON.parse(renderWranglerConfig(base, deployNames('browser-test')).replace(/^\s*\/\/.*$/gm, ''));
  expect(config.browser).toEqual({ binding: 'BROWSER' });
});

describe('owner seat (--owner-seat)', () => {
  const TOKEN = 'sk-ant-oat01-owner-seat-secret';
  const deployed = { workerSecretNames: ['BUILDD_SERVER', 'BUILDD_API_KEY', 'DISPATCH_TOKEN'], workspace: { id: 'ws-1', name: 'demo', webhookConfig: { url: DISPATCH, enabled: true, hasToken: true, events: [...DISPATCH_EVENTS] } } };

  it('is off by default: no secret is put, nothing mentioned', () => {
    const p = planDeploy(inputs(deployed));
    expect(p.ok && kinds(p.steps)).not.toContain('put:CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('puts the token as a Worker secret, and the plan output never shows it', () => {
    const p = planDeploy(inputs({ ...deployed, ownerSeat: { requested: true, token: TOKEN } }));
    if (!p.ok) throw new Error(p.error);
    const put = p.steps.find((s) => s.kind === 'put_secret' && s.name === 'CLAUDE_CODE_OAUTH_TOKEN');
    expect(put).toMatchObject({ value: TOKEN });
    const text = describePlan(p).join('\n');
    expect(text).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(text).not.toContain(TOKEN);
    expect(text).toMatch(/one owner, one token per Worker/i);
  });

  it('is the only step that carries the token: no webhook config, no other secret', () => {
    const p = planDeploy(inputs({ ...deployed, ownerSeat: { requested: true, token: TOKEN } }));
    if (!p.ok) throw new Error(p.error);
    const others = p.steps.filter((s) => !(s.kind === 'put_secret' && s.name === 'CLAUDE_CODE_OAUTH_TOKEN'));
    expect(JSON.stringify(others)).not.toContain(TOKEN);
  });

  it('requested with no token and none on the Worker is an error that says where to get it', () => {
    const p = planDeploy(inputs({ ...deployed, ownerSeat: { requested: true } }));
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toContain('claude setup-token');
  });

  it('requested with no token keeps the one already on the Worker', () => {
    const p = planDeploy(inputs({ ...deployed, workerSecretNames: [...deployed.workerSecretNames, 'CLAUDE_CODE_OAUTH_TOKEN'], ownerSeat: { requested: true } }));
    expect(p.ok && kinds(p.steps)).not.toContain('put:CLAUDE_CODE_OAUTH_TOKEN');
    expect(p.ok).toBe(true);
  });

  it('rejects a value that is not a setup-token', () => {
    for (const token of ['hello world', 'bld_runner_key', 'sk-ant-oat01-with space']) {
      expect(planDeploy(inputs({ ...deployed, ownerSeat: { requested: true, token } })).ok).toBe(false);
    }
  });

  it('a Worker that already has a seat says so, and how to turn it off', () => {
    const p = planDeploy(inputs({ ...deployed, workerSecretNames: [...deployed.workerSecretNames, 'CLAUDE_CODE_OAUTH_TOKEN'] }));
    expect(p.ok && p.notes.join(' ')).toContain('wrangler secret delete CLAUDE_CODE_OAUTH_TOKEN');
  });
});
