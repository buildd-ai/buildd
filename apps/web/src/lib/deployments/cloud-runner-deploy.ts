/**
 * The Settings Deploy button for the cloud runner (Settings → Runners →
 * Cloudflare), one step per request so no step outlives a 60 s function:
 *
 *   check → bucket → worker → containers → connect
 *
 * Every Cloudflare call goes through runDeploymentAction (principal `user`),
 * so each is audited like an Operator's and none returns the token. The plan
 * is apps/cloud-runner/src/deploy-plan.ts's `planDeploy`, the same one
 * scripts/deploy.ts runs, so a re-run here follows its rules: a
 * DISPATCH_TOKEN already on the Worker is never replaced.
 *
 * Every step is idempotent, so a failed one is retried by running it again
 * and a fresh run starts from `check`. `check` also reports the steps that
 * are already current (`detail.current`: the Worker at this release, the
 * bucket with its lifecycle, the container applications on this image, the
 * workspace dispatching to the Worker with its key and secrets in place), and
 * the client skips them, so a re-run only does what changed.
 *
 * Secrets made here never leave the server: the runner key is minted and put
 * straight onto the Worker, and the DISPATCH_TOKEN is written to the Worker
 * and the workspace's webhook. Neither appears in a reply or an audit row.
 * Orchestration only; storage and the actions are injected (cloud-runner-store.ts).
 */
import { DISPATCH_EVENTS, SNAPSHOT_BUCKET, deployNames, dispatchUrl, planDeploy, type DeployPlan, type ObservedWebhook } from '../../../../cloud-runner/src/deploy-plan';
import { configForScript, snapshotBucketOf, type ReleaseBundle } from '../../../../cloud-runner/src/release-bundle';
import type { LoadReleaseBundle } from './cloudflare';
import type { DeploymentOperation, DeploymentResponse } from './action';

export const CLOUD_RUNNER_DEPLOY_STEPS = ['check', 'bucket', 'worker', 'containers', 'connect'] as const;
export type CloudRunnerDeployStep = (typeof CLOUD_RUNNER_DEPLOY_STEPS)[number];

export function isCloudRunnerDeployStep(v: unknown): v is CloudRunnerDeployStep {
  return typeof v === 'string' && (CLOUD_RUNNER_DEPLOY_STEPS as readonly string[]).includes(v);
}

/** The Worker the Settings button deploys: wrangler.jsonc's name, in production. */
export const CLOUD_RUNNER_SCRIPT = deployNames().worker;

/** webhook_config as stored (the dispatch keys this flow reads). */
export interface StoredWebhook {
  url?: string | null;
  token?: string | null;
  enabled?: boolean;
  events?: string[];
}

export interface CloudRunnerDeployContext {
  teamId: string;
  userId: string;
  workspace: { id: string; name: string; webhookConfig: StoredWebhook | null };
  /** buildd's base URL the containers talk to. */
  builddServer: string;
}

/** The runner key this flow minted for a Worker, found by its name. */
export interface MintedRunnerKey {
  id: string;
  workspaceIds: string[] | null;
}

export interface CloudRunnerDeployDeps {
  /** One Cloudflare deployment action on the cloud runner's target, as the signed-in person. */
  action(operation: DeploymentOperation, params?: Record<string, unknown>): Promise<DeploymentResponse>;
  loadRelease: LoadReleaseBundle;
  /** Every workspace in the team and its stored webhook (to find the Worker's existing token). */
  teamWebhooks(teamId: string): Promise<Array<{ workspaceId: string; webhookConfig: StoredWebhook | null }>>;
  /** Merge the dispatch keys onto the workspace's webhook_config. `token` undefined keeps the stored one. */
  saveWebhook(workspaceId: string, config: { url: string; token?: string; enabled: boolean; events: string[] }): Promise<void>;
  runnerKey: {
    find(teamId: string, script: string): Promise<MintedRunnerKey | null>;
    /** Mint a worker-level Task agent key scoped to one workspace; returns the plaintext once. */
    mint(input: { teamId: string; userId: string; script: string; workspaceId: string; maxConcurrentWorkers: number }): Promise<string>;
    widen(id: string, workspaceId: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
  /** Audit a buildd-side step (webhook, runner key). Never takes a secret. */
  audit(operation: string, outcome: 'succeeded' | 'failed', reason: string | null, result: Record<string, unknown> | null): Promise<void>;
  randomToken(): string;
}

export type CloudRunnerStepResult =
  | {
      ok: true;
      step: CloudRunnerDeployStep;
      /** The step after this one, or null when the deploy is done. */
      next: CloudRunnerDeployStep | null;
      detail: Record<string, unknown>;
    }
  | { ok: false; step: CloudRunnerDeployStep; status: number; error: string };

function fail(step: CloudRunnerDeployStep, status: number, error: string): CloudRunnerStepResult {
  return { ok: false, step, status, error };
}

function nextOf(step: CloudRunnerDeployStep): CloudRunnerDeployStep | null {
  const i = CLOUD_RUNNER_DEPLOY_STEPS.indexOf(step);
  return CLOUD_RUNNER_DEPLOY_STEPS[i + 1] ?? null;
}

/** An action's failure as a step failure, in the action's own (already scrubbed) words. */
function actionFailed(step: CloudRunnerDeployStep, res: DeploymentResponse): CloudRunnerStepResult {
  const error = typeof res.body.error === 'string' ? res.body.error : `HTTP ${res.status}`;
  return fail(step, res.status >= 500 ? 502 : res.status, error);
}

function observed(w: StoredWebhook | null): ObservedWebhook | null {
  if (!w || (!w.url && !w.token)) return null;
  return { url: w.url ?? null, enabled: w.enabled === true, hasToken: !!w.token, ...(w.events ? { events: w.events } : {}) };
}

interface WorkerStatus {
  exists: boolean;
  secretNames: string[] | null;
  workersDevUrl: string | null;
}

async function readStatus(step: CloudRunnerDeployStep, deps: CloudRunnerDeployDeps): Promise<{ ok: true; status: WorkerStatus } | { ok: false; result: CloudRunnerStepResult }> {
  const res = await deps.action('status');
  if (res.status !== 200) return { ok: false, result: actionFailed(step, res) };
  const r = (res.body.result ?? {}) as Partial<WorkerStatus>;
  return { ok: true, status: { exists: r.exists === true, secretNames: r.secretNames ?? null, workersDevUrl: r.workersDevUrl ?? null } };
}

/** planDeploy's refusal for this case speaks to a terminal; this says it for Settings. */
const ORPHAN_TOKEN = 'This Worker already has a dispatch token that no workspace in this team holds, and Cloudflare never shows it again. '
  + 'Rotate it from a terminal (apps/cloud-runner/scripts/deploy.ts --rotate), which stops any other workspace using this Worker until it is re-run, or delete the Worker in Cloudflare and deploy again.';

function pointedAt(w: StoredWebhook | null, url: string): boolean {
  return !!w && w.url === url && w.enabled === true && !!w.token;
}

/**
 * `connect` has nothing to do: the Worker holds every secret it puts, this
 * workspace already dispatches to it on every event, and the runner key
 * reaches the workspace. BUILDD_SERVER cannot be read back; it is judged by
 * its presence, as connect last put it with this server's URL.
 */
function connectCurrent(ctx: CloudRunnerDeployContext, names: string[], url: string, minted: MintedRunnerKey | null): boolean {
  const own = ctx.workspace.webhookConfig;
  return ['BUILDD_SERVER', 'BUILDD_API_KEY', 'DISPATCH_TOKEN'].every((n) => names.includes(n))
    && pointedAt(own, url)
    && DISPATCH_EVENTS.every((e) => own?.events?.includes(e))
    && !(minted?.workspaceIds && !minted.workspaceIds.includes(ctx.workspace.id));
}

/**
 * The steps after `check` that are already current. A failed read skips
 * nothing, so the deploy runs in full as before.
 */
async function currentSteps(bundle: ReleaseBundle, deps: CloudRunnerDeployDeps, connect: () => Promise<boolean>): Promise<CloudRunnerDeployStep[]> {
  const res = await deps.action('release_state', { release: bundle.tag, lifecycle: SNAPSHOT_BUCKET.lifecycle });
  if (res.status !== 200) return [];
  const r = (res.body.result ?? {}) as { worker?: { current?: boolean }; bucket?: { current?: boolean }; containers?: { current?: boolean } };
  const out: CloudRunnerDeployStep[] = [];
  if (r.bucket?.current === true) out.push('bucket');
  if (r.worker?.current === true) out.push('worker');
  if (r.containers?.current === true) out.push('containers');
  if (await connect()) out.push('connect');
  return out;
}

const NO_SUBDOMAIN = 'This Cloudflare account has no workers.dev subdomain yet. Pick one under Workers & Pages in the Cloudflare dashboard, then deploy again.';

/**
 * The existing DISPATCH_TOKEN, when the Worker has one and this workspace is
 * not already dispatching to it: the token stored on any workspace of this
 * team pointed at the Worker, this one first (a stash an earlier connect
 * left). It cannot be read back from Cloudflare.
 */
async function existingToken(ctx: CloudRunnerDeployContext, url: string, deps: CloudRunnerDeployDeps): Promise<string | undefined> {
  const own = ctx.workspace.webhookConfig;
  if (own?.url === url && own.token) return own.token;
  const team = await deps.teamWebhooks(ctx.teamId);
  return team.find((w) => w.webhookConfig?.url === url && !!w.webhookConfig.token)?.webhookConfig?.token ?? undefined;
}

function plan(ctx: CloudRunnerDeployContext, status: WorkerStatus, workerUrl: string, runnerApiKey: string | undefined, providedDispatchToken: string | undefined, generated: string): DeployPlan {
  return planDeploy({
    mode: 'deploy',
    rotate: false,
    workspace: { id: ctx.workspace.id, name: ctx.workspace.name, webhookConfig: observed(ctx.workspace.webhookConfig) },
    workerSecretNames: status.exists ? status.secretNames ?? [] : null,
    workerUrl,
    builddServer: ctx.builddServer,
    runnerApiKey,
    providedDispatchToken,
    generatedDispatchToken: generated,
    // Bucket and Worker are their own steps; this plans the secrets and the webhook.
    skipWorkerDeploy: true,
  });
}

function maxConcurrent(bundle: ReleaseBundle): number {
  return bundle.config.containers.reduce((n, c) => n + c.max_instances, 0) || 3;
}

export async function runCloudRunnerDeployStep(
  step: CloudRunnerDeployStep,
  ctx: CloudRunnerDeployContext,
  deps: CloudRunnerDeployDeps,
): Promise<CloudRunnerStepResult> {
  const release = await deps.loadRelease(null);
  if (!release.ok) return fail(step, 422, release.error);
  const bundle = release.bundle;
  const script = CLOUD_RUNNER_SCRIPT;

  switch (step) {
    case 'check': {
      // Refuse before anything changes when the deploy could not finish.
      if (!bundle.image) return fail(step, 422, `Release ${bundle.tag} has no runner image Cloudflare can pull yet (it needs a public Docker Hub copy).`);
      const s = await readStatus(step, deps);
      if (!s.ok) return s.result;
      const workerUrl = s.status.workersDevUrl;
      if (!workerUrl) return fail(step, 422, NO_SUBDOMAIN);
      const url = dispatchUrl(workerUrl);
      const names = s.status.secretNames ?? [];
      const token = names.includes('DISPATCH_TOKEN') && !pointedAt(ctx.workspace.webhookConfig, url) ? await existingToken(ctx, url, deps) : undefined;
      if (names.includes('DISPATCH_TOKEN') && !token && !pointedAt(ctx.workspace.webhookConfig, url)) return fail(step, 409, ORPHAN_TOKEN);
      const needsKey = !names.includes('BUILDD_API_KEY');
      // A first deploy has no Worker yet: pretend it exists with no secrets, as it will by `connect`.
      const dry = plan(ctx, { ...s.status, exists: true }, workerUrl, needsKey ? 'bld_planned' : undefined, token, 'planned');
      if (!dry.ok) return fail(step, 409, dry.error);
      const current = s.status.exists
        ? await currentSteps(bundle, deps, async () => connectCurrent(ctx, names, url, await deps.runnerKey.find(ctx.teamId, script)))
        : [];
      return {
        ok: true, step, next: CLOUD_RUNNER_DEPLOY_STEPS.find((x) => x !== 'check' && !current.includes(x)) ?? null,
        detail: {
          release: bundle.tag, workerUrl, workerExists: s.status.exists, workspace: ctx.workspace.name, current,
          ...(current.includes('connect') ? { dispatchUrl: url } : {}),
          notes: dry.notes,
        },
      };
    }

    case 'bucket': {
      const bucket = snapshotBucketOf(configForScript(bundle.config, script));
      if (!bucket) return { ok: true, step, next: nextOf(step), detail: { bucket: null } };
      const res = await deps.action('ensure_bucket', { bucket, lifecycle: SNAPSHOT_BUCKET.lifecycle });
      if (res.status !== 200) return actionFailed(step, res);
      return { ok: true, step, next: nextOf(step), detail: { bucket } };
    }

    case 'worker': {
      const res = await deps.action('deploy_worker_script', { release: bundle.tag });
      if (res.status !== 200) return actionFailed(step, res);
      const r = (res.body.result ?? {}) as Record<string, unknown>;
      return { ok: true, step, next: nextOf(step), detail: { release: bundle.tag, workerUrl: r.workersDevUrl ?? null } };
    }

    case 'containers': {
      const res = await deps.action('deploy_containers', { release: bundle.tag });
      if (res.status !== 200) return actionFailed(step, res);
      const r = (res.body.result ?? {}) as Record<string, unknown>;
      return { ok: true, step, next: nextOf(step), detail: { image: r.image ?? null, applications: r.applications ?? [] } };
    }

    case 'connect': {
      const s = await readStatus(step, deps);
      if (!s.ok) return s.result;
      if (!s.status.exists) return fail(step, 409, 'The Worker is not deployed yet. Run Deploy again from the start.');
      const workerUrl = s.status.workersDevUrl;
      if (!workerUrl) return fail(step, 422, NO_SUBDOMAIN);
      const url = dispatchUrl(workerUrl);
      const names = s.status.secretNames ?? [];
      const notes: string[] = [];

      const token = names.includes('DISPATCH_TOKEN') && !pointedAt(ctx.workspace.webhookConfig, url) ? await existingToken(ctx, url, deps) : undefined;
      if (names.includes('DISPATCH_TOKEN') && !token && !pointedAt(ctx.workspace.webhookConfig, url)) return fail(step, 409, ORPHAN_TOKEN);

      // The runner key: minted here only when the Worker has none, so a re-run
      // never rotates it (that would end every run in flight).
      const minted = await deps.runnerKey.find(ctx.teamId, script);
      let runnerApiKey: string | undefined;
      if (!names.includes('BUILDD_API_KEY')) {
        // A key minted by an earlier attempt that never reached the Worker is unused.
        if (minted) await deps.runnerKey.remove(minted.id);
        runnerApiKey = await deps.runnerKey.mint({ teamId: ctx.teamId, userId: ctx.userId, script, workspaceId: ctx.workspace.id, maxConcurrentWorkers: maxConcurrent(bundle) });
        await deps.audit('mint_runner_key', 'succeeded', null, { script, workspaceId: ctx.workspace.id, replacedUnused: !!minted }).catch(() => undefined);
      } else if (minted?.workspaceIds && !minted.workspaceIds.includes(ctx.workspace.id)) {
        // Another workspace on the same Worker: the key reaches it too. Widening ends nothing.
        await deps.runnerKey.widen(minted.id, ctx.workspace.id);
        await deps.audit('widen_runner_key', 'succeeded', null, { script, workspaceId: ctx.workspace.id }).catch(() => undefined);
      } else if (!minted) {
        notes.push(`The Worker's runner key was set from a terminal; it must reach ${ctx.workspace.name} for its tasks to run.`);
      }

      const p = plan(ctx, s.status, workerUrl, runnerApiKey, token, deps.randomToken());
      if (!p.ok) return fail(step, 409, p.error);

      for (const st of p.steps) {
        if (st.kind === 'put_secret') {
          if (st.name === 'DISPATCH_TOKEN') {
            // Stash the token on the workspace (not yet dispatching) before the
            // Worker holds it: a retry after a failure below finds it here
            // instead of facing a token nobody can read back.
            await deps.saveWebhook(ctx.workspace.id, { url, token: st.value, enabled: false, events: [] });
          }
          const res = await deps.action('put_secret', { name: st.name, value: st.value });
          if (res.status !== 200) return actionFailed(step, res);
        } else if (st.kind === 'set_webhook') {
          try {
            await deps.saveWebhook(ctx.workspace.id, st.config);
          } catch {
            await deps.audit('set_webhook', 'failed', 'webhook write failed', { workspaceId: ctx.workspace.id, url }).catch(() => undefined);
            return fail(step, 503, 'Could not point the workspace at the Worker. Try again.');
          }
          await deps.audit('set_webhook', 'succeeded', st.reason, { workspaceId: ctx.workspace.id, url, events: st.config.events }).catch(() => undefined);
        }
      }

      return {
        ok: true, step, next: null,
        detail: { workerUrl, dispatchUrl: url, workspace: ctx.workspace.name, notes: [...notes, ...p.notes] },
      };
    }
  }
}
