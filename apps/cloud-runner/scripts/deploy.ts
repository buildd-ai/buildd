#!/usr/bin/env bun
/**
 * Deploy the cloud runner to Cloudflare and point a buildd workspace at it.
 *
 *   bun apps/cloud-runner/scripts/deploy.ts --workspace <id|name> [--runner-key bld_…]
 *       [--rotate] [--remove] [--dry-run] [--server <buildd url>] [--worker-server <url>]
 *       [--url <worker base url>] [--print-token]
 *
 * Env:
 *   BUILDD_API_KEY         admin-level buildd API key (reads the workspace, sets its webhook,
 *                          and fetches the stored Cloudflare token if the two below are unset)
 *   BUILDD_SERVER          buildd base URL (default https://buildd.dev; --server wins)
 *   BUILDD_RUNNER_API_KEY  runner key handed to the containers (--runner-key wins). Worker
 *                          level, ideally scoped to the workspace. Needed on first deploy only.
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 *                          optional; otherwise the token saved in Settings → Runners → Cloudflare
 *                          is fetched with the admin key
 *   DISPATCH_TOKEN         optional; the existing token, to point another workspace at a
 *                          Worker that is already deployed
 *
 * The decisions live in src/deploy-plan.ts (tested); this file only observes
 * and executes. Re-running is safe: see planDeploy for what changes when.
 */
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { describePlan, planDeploy, type DeployStep, type ObservedWebhook } from '../src/deploy-plan';

const APP_DIR = join(dirname(new URL(import.meta.url).pathname), '..');
const WORKER_NAME = 'buildd-cloud-runner';
const CF_API = 'https://api.cloudflare.com/client/v4';

interface Args {
  workspace?: string;
  rotate: boolean;
  remove: boolean;
  dryRun: boolean;
  printToken: boolean;
  runnerKey?: string;
  server?: string;
  workerServer?: string;
  url?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { rotate: false, remove: false, dryRun: false, printToken: false };
  const takesValue = new Set(['--workspace', '--runner-key', '--server', '--worker-server', '--url']);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (takesValue.has(k)) {
      const v = argv[++i];
      if (!v || v.startsWith('--')) die(`${k} needs a value`);
      if (k === '--workspace') a.workspace = v;
      if (k === '--runner-key') a.runnerKey = v;
      if (k === '--server') a.server = v;
      if (k === '--worker-server') a.workerServer = v;
      if (k === '--url') a.url = v;
    } else if (k === '--rotate') a.rotate = true;
    else if (k === '--remove') a.remove = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--print-token') a.printToken = true;
    else if (k === '-h' || k === '--help') {
      console.log(readUsage());
      process.exit(0);
    } else die(`unknown argument ${k}`);
  }
  if (!a.workspace) die('--workspace <id|name> is required');
  if (a.rotate && a.remove) die('--rotate and --remove do not go together');
  return a;
}

function readUsage(): string {
  return 'usage: bun apps/cloud-runner/scripts/deploy.ts --workspace <id|name> [--runner-key bld_…] [--rotate] [--remove] [--dry-run] [--server <url>] [--worker-server <url>] [--url <worker url>] [--print-token]';
}

function die(msg: string): never {
  console.error(`deploy: ${msg}`);
  process.exit(1);
}

// ── buildd API ────────────────────────────────────────────────────────────────

async function buildd<T>(server: string, key: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${server}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = (body as { error?: string } | null)?.error ?? text.slice(0, 200);
    throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${res.status}: ${err}`);
  }
  return body as T;
}

interface WorkspaceRow { id: string; name: string; webhookConfig: ObservedWebhook | null }

async function resolveWorkspace(server: string, key: string, ref: string): Promise<WorkspaceRow> {
  const { workspaces } = await buildd<{ workspaces: WorkspaceRow[] }>(server, key, '/api/workspaces');
  const byId = workspaces.find((w) => w.id === ref);
  if (byId) return byId;
  const byName = workspaces.filter((w) => w.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) die(`${byName.length} workspaces are named "${ref}"; pass the ID`);
  die(`no workspace "${ref}" reachable with this API key`);
}

async function cloudflareCredential(server: string, key: string): Promise<{ apiToken: string; accountId: string; source: string }> {
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (envToken && envAccount) return { apiToken: envToken, accountId: envAccount, source: 'env' };
  if (envToken || envAccount) die('set both CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or neither');
  const c = await buildd<{ apiToken: string; accountId: string; healthStatus: string }>(
    server, key, '/api/cloudflare/credential/reveal', { method: 'POST' },
  );
  if (c.healthStatus === 'revoked') console.warn('deploy: warning: the stored Cloudflare token was rejected at its last verify');
  return { apiToken: c.apiToken, accountId: c.accountId, source: 'buildd settings' };
}

// ── wrangler / Cloudflare ─────────────────────────────────────────────────────

function wranglerEnv(cf: { apiToken: string; accountId: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.CLOUDFLARE_API_TOKEN = cf.apiToken;
  env.CLOUDFLARE_ACCOUNT_ID = cf.accountId;
  // The runner key and admin key are for this script, not wrangler.
  delete env.BUILDD_API_KEY;
  delete env.BUILDD_RUNNER_API_KEY;
  return env;
}

async function wrangler(args: string[], env: Record<string, string>, stdin?: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bunx', 'wrangler', ...args], {
    cwd: APP_DIR, env, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: out + err };
}

async function listWorkerSecrets(env: Record<string, string>): Promise<string[] | null> {
  const r = await wrangler(['secret', 'list', '--format', 'json'], env);
  if (r.code !== 0) {
    if (/not found|does not exist|10007/i.test(r.out)) return null;
    die(`wrangler secret list failed:\n${r.out}`);
  }
  const start = r.out.indexOf('[');
  const list = JSON.parse(r.out.slice(start, r.out.lastIndexOf(']') + 1)) as Array<{ name: string }>;
  return list.map((s) => s.name);
}

async function workersDevUrl(cf: { apiToken: string; accountId: string }): Promise<string> {
  const res = await fetch(`${CF_API}/accounts/${cf.accountId}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${cf.apiToken}` },
  });
  const body = (await res.json().catch(() => ({}))) as { result?: { subdomain?: string } };
  const sub = body.result?.subdomain;
  if (!res.ok || !sub) die(`could not read the account's workers.dev subdomain (HTTP ${res.status}); pass --url`);
  return `https://${WORKER_NAME}.${sub}.workers.dev`;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = (args.server ?? process.env.BUILDD_SERVER ?? 'https://buildd.dev').replace(/\/+$/, '');
  const adminKey = process.env.BUILDD_API_KEY;
  if (!adminKey) die('BUILDD_API_KEY (an admin-level buildd API key) is required');
  const runnerKey = args.runnerKey ?? process.env.BUILDD_RUNNER_API_KEY;
  if (runnerKey && runnerKey === adminKey) die('the runner key must not be the admin key: containers run untrusted code');

  const workspace = await resolveWorkspace(server, adminKey, args.workspace!);
  console.log(`workspace: ${workspace.name} (${workspace.id})`);

  let workerUrl = args.url;
  let secretNames: string[] | null = [];
  let env: Record<string, string> | null = null;
  if (!args.remove) {
    const cf = await cloudflareCredential(server, adminKey);
    console.log(`cloudflare: account ${cf.accountId.slice(0, 4)}…${cf.accountId.slice(-4)} (token from ${cf.source})`);
    env = wranglerEnv(cf);
    secretNames = await listWorkerSecrets(env);
    workerUrl ??= await workersDevUrl(cf);
  }
  workerUrl ??= workspace.webhookConfig?.url?.replace(/\/dispatch$/, '') ?? 'https://unknown.invalid';

  const plan = planDeploy({
    mode: args.remove ? 'remove' : 'deploy',
    rotate: args.rotate,
    workspace,
    workerSecretNames: secretNames,
    workerUrl,
    builddServer: (args.workerServer ?? server).replace(/\/+$/, ''),
    runnerApiKey: runnerKey,
    providedDispatchToken: process.env.DISPATCH_TOKEN || undefined,
    generatedDispatchToken: randomBytes(32).toString('base64url'),
  });

  console.log(`${args.dryRun ? 'plan (dry run, nothing changed)' : 'plan'}:`);
  for (const line of describePlan(plan)) console.log(`  ${line}`);
  if (!plan.ok) process.exit(1);
  if (args.dryRun) return;

  for (const step of plan.steps) await execute(step, { server, adminKey, env });

  const tokenStep = plan.steps.find((s): s is Extract<DeployStep, { kind: 'put_secret' }> => s.kind === 'put_secret' && s.name === 'DISPATCH_TOKEN');
  if (tokenStep && args.printToken) console.log(`DISPATCH_TOKEN=${tokenStep.value}`);
  else if (tokenStep) console.log('DISPATCH_TOKEN set on the Worker and the workspace (not shown; --print-token shows it). A second workspace on this Worker needs it as DISPATCH_TOKEN, or --rotate.');
  console.log(args.remove ? 'done: workspace detached from the cloud runner' : `done: ${workspace.name} dispatches to ${workerUrl}/dispatch`);
}

async function execute(step: DeployStep, ctx: { server: string; adminKey: string; env: Record<string, string> | null }) {
  switch (step.kind) {
    case 'wrangler_deploy': {
      console.log('→ wrangler deploy (builds the container image; slow the first time)');
      const r = await wrangler(['deploy'], ctx.env!);
      if (r.code !== 0) die(`wrangler deploy failed:\n${r.out}`);
      const url = r.out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
      if (url) console.log(`  deployed ${url}`);
      return;
    }
    case 'put_secret': {
      console.log(`→ wrangler secret put ${step.name}`);
      const r = await wrangler(['secret', 'put', step.name], ctx.env!, step.value);
      if (r.code !== 0) die(`wrangler secret put ${step.name} failed:\n${r.out}`);
      return;
    }
    case 'set_webhook':
      console.log(`→ set webhook on ${step.workspaceId}`);
      await buildd(ctx.server, ctx.adminKey, `/api/workspaces/${step.workspaceId}`, {
        method: 'PATCH', body: JSON.stringify({ webhookConfig: step.config }),
      });
      return;
    case 'clear_webhook':
      console.log(`→ clear webhook on ${step.workspaceId}`);
      await buildd(ctx.server, ctx.adminKey, `/api/workspaces/${step.workspaceId}`, {
        method: 'PATCH', body: JSON.stringify({ webhookConfig: null }),
      });
      return;
  }
}

if (import.meta.main) {
  main().catch((err) => die(err instanceof Error ? err.message : String(err)));
}
