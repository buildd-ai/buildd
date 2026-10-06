/**
 * What `scripts/deploy.ts` should do, decided from what it observed. Pure and
 * runtime-free: no wrangler, no fetch, no randomness (the caller passes a
 * freshly generated token in case one is needed). The script does the I/O.
 *
 * The rule that makes a re-run safe: a DISPATCH_TOKEN that already exists on
 * the Worker is never replaced unless the operator asks (`--rotate`). The
 * Worker has one token and every workspace pointed at it holds a copy, so
 * rotating silently would break the other workspaces.
 */
import { parseModelProxyAuthHeader, parseModelProxyUrl } from './outbound';
import { RUNNER_CLASSES } from './runner-class';

/** Non-secret webhook view, as GET /api/workspaces returns it (token masked). */
export interface ObservedWebhook {
  url: string | null;
  enabled: boolean;
  hasToken: boolean;
  /** The dispatch events the webhook opted into; absent = buildd's legacy set. */
  events?: string[];
}

/**
 * Every dispatch event this Worker handles. buildd sends a webhook without an
 * `events` list only new and unblocked tasks (the behaviour webhooks had
 * before the list existed), so the Worker must opt in to hear about retries,
 * approved-plan children and deferred-start re-dispatches. `task.scheduled`
 * makes buildd send a deferred task at once with its start time, so the
 * agent wakes itself then instead of waiting for buildd's hourly sweep.
 */
export const DISPATCH_EVENTS = ['task.created', 'task.unblocked', 'task.retry', 'task.resume', 'task.scheduled'] as const;
export type DispatchEvent = (typeof DISPATCH_EVENTS)[number];

export interface DeployInputs {
  mode: 'deploy' | 'remove';
  rotate: boolean;
  /** Workspace being pointed at (or detached from) the Worker. */
  workspace: { id: string; name: string; webhookConfig: ObservedWebhook | null };
  /**
   * Secret names currently on the Worker (`wrangler secret list`), or null
   * when the Worker has never been deployed.
   */
  workerSecretNames: string[] | null;
  /** The Worker's public base URL, e.g. https://buildd-cloud-runner.<sub>.workers.dev. */
  workerUrl: string;
  /** buildd base URL the containers should talk to. */
  builddServer: string;
  /** Runner API key to hand the containers, if the operator supplied one. */
  runnerApiKey?: string;
  /** DISPATCH_TOKEN the operator supplied (to point another workspace at an existing Worker). */
  providedDispatchToken?: string;
  /** A fresh random token, used only if the plan needs a new one. */
  generatedDispatchToken: string;
  /**
   * Route model traffic through an Anthropic-compatible proxy (LiteLLM and
   * similar). Each field is optional; an empty string counts as not supplied.
   */
  modelProxy?: { url?: string; key?: string; authHeader?: string };
  /**
   * `--secrets-only`: leave the Worker's code alone and only put secrets and
   * set the webhook. Every such step runs server-side with the stored
   * credential, so the run needs no Cloudflare token on the machine at all.
   * Refused for a Worker that was never deployed.
   */
  skipWorkerDeploy?: boolean;
}

export type SecretName =
  | 'DISPATCH_TOKEN' | 'BUILDD_SERVER' | 'BUILDD_API_KEY'
  | 'MODEL_PROXY_URL' | 'MODEL_PROXY_KEY' | 'MODEL_PROXY_AUTH_HEADER';

/** Put with `wrangler secret put` so a later deploy keeps them, but not secret in substance: printed in the plan. */
const PLAIN_SECRET_NAMES: ReadonlySet<SecretName> = new Set(['BUILDD_SERVER', 'MODEL_PROXY_URL', 'MODEL_PROXY_AUTH_HEADER']);

/**
 * The R2 bucket bound as SNAPSHOTS in wrangler.jsonc (warm repos), and the
 * lifecycle rule that backstops the refresher's two-generation pruning.
 * `wrangler deploy` fails on a binding to a bucket that does not exist, so
 * the bucket is created (idempotently) before every deploy.
 */
export const SNAPSHOT_BUCKET = {
  name: 'buildd-cloud-runner-snapshots',
  lifecycle: [
    { id: 'warm-expiry', prefix: 'warm/', expireDays: 14 },
    { id: 'park-expiry', prefix: 'park/', expireDays: 2 },
  ],
} as const;

/** The Worker name in wrangler.jsonc. */
const DEFAULT_WORKER_NAME = 'buildd-cloud-runner';

export interface DeployNames {
  worker: string;
  bucket: string;
  /** True when the names differ from wrangler.jsonc, so deploy needs a generated config. */
  custom: boolean;
}

/**
 * The Worker and snapshot bucket names for one deployment. `--name` lets an
 * account host the runner under its own name (e.g. a neutral one for an
 * evaluation); the bucket follows the Worker so two deployments in one
 * account never share snapshots. Cloudflare allows lowercase letters, digits
 * and dashes; the bucket suffix must still fit R2's 63-character limit.
 */
export function deployNames(name?: string): DeployNames {
  if (name === undefined) return { worker: DEFAULT_WORKER_NAME, bucket: SNAPSHOT_BUCKET.name, custom: false };
  if (!/^[a-z0-9][a-z0-9-]{0,44}$/.test(name)) {
    throw new Error(`invalid Worker name "${name}": use 1-45 lowercase letters, digits or dashes, not starting with a dash`);
  }
  if (name === DEFAULT_WORKER_NAME) return deployNames();
  return { worker: name, bucket: `${name}-snapshots`, custom: true };
}

/**
 * wrangler.jsonc with the Worker name, its runner group (vars.RUNNER_GROUP)
 * and snapshot bucket replaced, for `wrangler -c`. Everything else is
 * byte-for-byte the checked-in config, so a custom-named deploy cannot drift
 * from the default one. Throws if any field is missing rather than deploying
 * a half-renamed Worker.
 */
export function renderWranglerConfig(base: string, names: DeployNames): string {
  const swap = (text: string, re: RegExp, value: string, field: string) => {
    const hits = text.match(new RegExp(re.source, 'gm'))?.length ?? 0;
    if (hits !== 1) throw new Error(`wrangler.jsonc: expected one ${field}, found ${hits}`);
    return text.replace(re, (_m, pre: string) => `${pre}"${value}"`);
  };
  const named = swap(base, /^(\s*"name":\s*)"[^"]*"/m, names.worker, '"name"');
  // The fleet groups this deployment's runs under its Worker name.
  const grouped = swap(named, /("RUNNER_GROUP":\s*)"[^"]*"/m, names.worker, '"RUNNER_GROUP"');
  const out = swap(grouped, /("bucket_name":\s*)"[^"]*"/m, names.bucket, '"bucket_name"');
  // A deploy without one of the container classes would strand every task
  // buildd routes to it.
  const present = new Set(containerClasses(out).map(c => c.className));
  for (const cls of Object.values(RUNNER_CLASSES)) {
    if (!present.has(cls.binding)) throw new Error(`wrangler.jsonc: no container class ${cls.binding}`);
  }
  return out;
}

/** One container class as wrangler.jsonc declares it. */
export interface ContainerClassSummary {
  className: string;
  instanceType: string;
  maxInstances: number;
}

/**
 * The container classes in a wrangler.jsonc text (whole-line `//` comments
 * allowed, as in the checked-in file), for the plan output and the render
 * check. Throws on text that is not that.
 */
export function containerClasses(configText: string): ContainerClassSummary[] {
  const cfg = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, '')) as { containers?: Array<{ class_name?: unknown; instance_type?: unknown; max_instances?: unknown }> };
  return (cfg.containers ?? []).map(c => ({
    className: String(c.class_name),
    instanceType: String(c.instance_type),
    maxInstances: typeof c.max_instances === 'number' ? c.max_instances : 0,
  }));
}

export type DeployStep =
  | { kind: 'ensure_snapshot_bucket' }
  | { kind: 'wrangler_deploy' }
  | { kind: 'put_secret'; name: SecretName; value: string; reason: string }
  | {
      kind: 'set_webhook';
      workspaceId: string;
      /** `token` omitted = keep the stored one (PATCH merges webhookConfig). */
      config: { url: string; token?: string; enabled: true; events: DispatchEvent[] };
      reason: string;
    }
  | { kind: 'clear_webhook'; workspaceId: string; reason: string };

export type DeployPlan =
  | { ok: true; steps: DeployStep[]; notes: string[] }
  | { ok: false; error: string };

export function dispatchUrl(workerUrl: string): string {
  return `${workerUrl.replace(/\/+$/, '')}/dispatch`;
}

function webhookPointsAt(w: ObservedWebhook | null, url: string): boolean {
  return !!w && w.url === url && w.enabled && w.hasToken;
}

function listsEveryEvent(w: ObservedWebhook | null): boolean {
  return !!w?.events && DISPATCH_EVENTS.every((e) => w.events!.includes(e));
}

export function planDeploy(i: DeployInputs): DeployPlan {
  const url = dispatchUrl(i.workerUrl);
  const current = i.workspace.webhookConfig;

  if (i.mode === 'remove') {
    if (!current) {
      return { ok: true, steps: [], notes: [`${i.workspace.name} has no webhook; nothing to remove.`] };
    }
    const notes = ['The Worker itself stays deployed; delete it with `bunx wrangler delete` if nothing else uses it.'];
    if (current.url !== url) {
      notes.unshift(`Note: the webhook being cleared points at ${current.url ?? '(no url)'}, not this Worker.`);
    }
    return {
      ok: true,
      steps: [{ kind: 'clear_webhook', workspaceId: i.workspace.id, reason: 'back to Pusher-notified runners' }],
      notes,
    };
  }

  if (i.runnerApiKey !== undefined && !i.runnerApiKey.startsWith('bld_')) {
    return { ok: false, error: 'The runner API key must be a bld_ key.' };
  }

  if (i.skipWorkerDeploy && i.workerSecretNames === null) {
    return { ok: false, error: 'The Worker has not been deployed yet; run without --secrets-only first.' };
  }

  const secrets = new Set(i.workerSecretNames ?? []);
  const steps: DeployStep[] = i.skipWorkerDeploy ? [] : [{ kind: 'ensure_snapshot_bucket' }, { kind: 'wrangler_deploy' }];
  const notes: string[] = [];

  // BUILDD_SERVER: not a secret in substance, but kept with the others so a
  // deploy never falls back to a stale var. Re-putting the same value is not a rotation.
  steps.push({ kind: 'put_secret', name: 'BUILDD_SERVER', value: i.builddServer, reason: 'buildd base URL for containers' });

  // BUILDD_API_KEY: put when supplied; required when the Worker has none.
  if (i.runnerApiKey) {
    steps.push({
      kind: 'put_secret', name: 'BUILDD_API_KEY', value: i.runnerApiKey,
      reason: secrets.has('BUILDD_API_KEY') ? 'replace runner key (supplied)' : 'runner key for containers',
    });
  } else if (!secrets.has('BUILDD_API_KEY')) {
    return {
      ok: false,
      error: 'The Worker has no BUILDD_API_KEY yet. Pass a runner key (worker level, ideally scoped to this workspace) with --runner-key or BUILDD_RUNNER_API_KEY.',
    };
  }

  // Model proxy. Put as secrets, like BUILDD_SERVER: a plain var would be
  // dropped by the next `wrangler deploy` that does not repeat it, silently
  // switching the route back to the gateway.
  const proxy = planModelProxy(i.modelProxy ?? {}, secrets);
  if (!proxy.ok) return proxy;
  steps.push(...proxy.steps);
  notes.push(...proxy.notes);

  // DISPATCH_TOKEN.
  const hasToken = secrets.has('DISPATCH_TOKEN');
  let token: string | null = null;
  let tokenReason = '';
  if (i.rotate) {
    token = i.providedDispatchToken ?? i.generatedDispatchToken;
    tokenReason = '--rotate';
    if (hasToken) notes.push('Rotating DISPATCH_TOKEN: any other workspace pointed at this Worker stops dispatching until re-run with the new token.');
  } else if (!hasToken) {
    token = i.providedDispatchToken ?? i.generatedDispatchToken;
    tokenReason = 'first deploy';
  } else if (i.providedDispatchToken) {
    token = i.providedDispatchToken;
    tokenReason = 'supplied';
  }

  if (token) {
    steps.push({ kind: 'put_secret', name: 'DISPATCH_TOKEN', value: token, reason: tokenReason });
    steps.push({
      kind: 'set_webhook', workspaceId: i.workspace.id, config: { url, token, enabled: true, events: [...DISPATCH_EVENTS] },
      reason: webhookPointsAt(current, url) ? 'refresh token' : 'point workspace at the Worker',
    });
  } else if (webhookPointsAt(current, url)) {
    if (!listsEveryEvent(current)) {
      steps.push({
        kind: 'set_webhook', workspaceId: i.workspace.id, config: { url, enabled: true, events: [...DISPATCH_EVENTS] },
        reason: 'opt into every dispatch event',
      });
    }
    notes.push(`${i.workspace.name} already dispatches to ${url}; token unchanged.`);
  } else {
    return {
      ok: false,
      error:
        'The Worker already has a DISPATCH_TOKEN, and this workspace is not pointed at it. '
        + 'The token cannot be read back. Pass the existing one as DISPATCH_TOKEN, or --rotate to issue a new one '
        + '(which breaks any other workspace using this Worker until it is re-run).',
    };
  }

  if (current && current.url && current.url !== url && steps.some((s) => s.kind === 'set_webhook')) {
    notes.push(`Replaces the existing webhook ${current.url}.`);
  }
  return { ok: true, steps, notes };
}

function planModelProxy(
  m: NonNullable<DeployInputs['modelProxy']>,
  secrets: Set<string>,
): { ok: true; steps: DeployStep[]; notes: string[] } | { ok: false; error: string } {
  const url = m.url || undefined;
  const key = m.key || undefined;
  const header = m.authHeader || undefined;
  const steps: DeployStep[] = [];
  if (!url && !key && !header) {
    const notes = secrets.has('MODEL_PROXY_URL')
      ? ['Model traffic goes to the proxy already set on the Worker (MODEL_PROXY_URL); `wrangler secret delete MODEL_PROXY_URL` returns it to the gateway.']
      : [];
    return { ok: true, steps, notes };
  }
  if (url) {
    const parsed = parseModelProxyUrl(url);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    steps.push({ kind: 'put_secret', name: 'MODEL_PROXY_URL', value: parsed.baseUrl, reason: 'model proxy base URL' });
  } else if (!secrets.has('MODEL_PROXY_URL')) {
    return { ok: false, error: 'MODEL_PROXY_KEY / MODEL_PROXY_AUTH_HEADER need a proxy: pass --model-proxy-url or set MODEL_PROXY_URL.' };
  }
  if (key) {
    steps.push({
      kind: 'put_secret', name: 'MODEL_PROXY_KEY', value: key,
      reason: secrets.has('MODEL_PROXY_KEY') ? 'replace model proxy key (supplied)' : 'model proxy key',
    });
  } else if (!secrets.has('MODEL_PROXY_KEY')) {
    return { ok: false, error: 'The Worker has no MODEL_PROXY_KEY yet, and model traffic is never forwarded to the proxy without one. Set MODEL_PROXY_KEY.' };
  }
  if (header) {
    const parsed = parseModelProxyAuthHeader(header);
    if (!parsed) return { ok: false, error: 'MODEL_PROXY_AUTH_HEADER must be authorization or x-api-key.' };
    steps.push({ kind: 'put_secret', name: 'MODEL_PROXY_AUTH_HEADER', value: parsed, reason: 'model proxy auth header' });
  }
  return {
    ok: true,
    steps,
    notes: ['Model traffic goes to the proxy (MODEL_PROXY_URL), which takes precedence over any AI Gateway settings.'],
  };
}

/** One line per step, secrets redacted, for --dry-run and the run log. */
export function describePlan(plan: DeployPlan, names: DeployNames = deployNames(), classes: ContainerClassSummary[] = []): string[] {
  const classList = classes.length ? `; containers: ${classes.map(c => `${c.className} ${c.instanceType} max ${c.maxInstances}`).join(', ')}` : '';
  if (!plan.ok) return [`error: ${plan.error}`];
  const lines = plan.steps.map((s) => {
    switch (s.kind) {
      case 'ensure_snapshot_bucket':
        return `wrangler r2 bucket create ${names.bucket} (if missing) + lifecycle ${SNAPSHOT_BUCKET.lifecycle.map(r => `${r.prefix} ${r.expireDays}d`).join(', ')}`;
      case 'wrangler_deploy':
        return names.custom
          ? `wrangler deploy --name ${names.worker} (apps/cloud-runner, generated config${classList})`
          : `wrangler deploy (apps/cloud-runner${classList})`;
      case 'put_secret':
        return `wrangler secret put ${s.name} = ${PLAIN_SECRET_NAMES.has(s.name) ? s.value : redact(s.value)} (${s.reason})`;
      case 'set_webhook':
        return `PATCH workspace ${s.workspaceId} webhookConfig = { url: ${s.config.url}, token: ${s.config.token === undefined ? '(unchanged)' : redact(s.config.token)}, enabled: true, events: ${s.config.events.join(',')} } (${s.reason})`;
      case 'clear_webhook':
        return `PATCH workspace ${s.workspaceId} webhookConfig = null (${s.reason})`;
    }
  });
  if (lines.length === 0) lines.push('nothing to do');
  return [...lines, ...plan.notes.map((n) => `note: ${n}`)];
}

export function redact(v: string): string {
  return `<redacted, ${v.length} chars>`;
}
