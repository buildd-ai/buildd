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

/** Non-secret webhook view, as GET /api/workspaces returns it (token masked). */
export interface ObservedWebhook {
  url: string | null;
  enabled: boolean;
  hasToken: boolean;
}

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
}

export type DeployStep =
  | { kind: 'wrangler_deploy' }
  | { kind: 'put_secret'; name: 'DISPATCH_TOKEN' | 'BUILDD_SERVER' | 'BUILDD_API_KEY'; value: string; reason: string }
  | { kind: 'set_webhook'; workspaceId: string; config: { url: string; token: string; enabled: true }; reason: string }
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

  const secrets = new Set(i.workerSecretNames ?? []);
  const steps: DeployStep[] = [{ kind: 'wrangler_deploy' }];
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
      kind: 'set_webhook', workspaceId: i.workspace.id, config: { url, token, enabled: true },
      reason: webhookPointsAt(current, url) ? 'refresh token' : 'point workspace at the Worker',
    });
  } else if (webhookPointsAt(current, url)) {
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

/** One line per step, secrets redacted, for --dry-run and the run log. */
export function describePlan(plan: DeployPlan): string[] {
  if (!plan.ok) return [`error: ${plan.error}`];
  const lines = plan.steps.map((s) => {
    switch (s.kind) {
      case 'wrangler_deploy':
        return 'wrangler deploy (apps/cloud-runner)';
      case 'put_secret':
        return `wrangler secret put ${s.name} = ${s.name === 'BUILDD_SERVER' ? s.value : redact(s.value)} (${s.reason})`;
      case 'set_webhook':
        return `PATCH workspace ${s.workspaceId} webhookConfig = { url: ${s.config.url}, token: ${redact(s.config.token)}, enabled: true } (${s.reason})`;
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
