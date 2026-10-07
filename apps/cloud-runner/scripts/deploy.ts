#!/usr/bin/env bun
/**
 * Deploy the cloud runner to Cloudflare and point a buildd workspace at it.
 *
 *   bun apps/cloud-runner/scripts/deploy.ts --workspace <id|name> [--runner-key bld_…]
 *       [--rotate] [--remove] [--dry-run] [--server <buildd url>] [--worker-server <url>]
 *       [--url <worker base url>] [--print-token] [--model-proxy-url <url>] [--name <worker name>]
 *       [--owner-seat]
 *
 * --name deploys the Worker under another name, with its own snapshot bucket
 * (<name>-snapshots), from a generated copy of wrangler.jsonc. Pass the same
 * --name on every later run against that deployment.
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
 *   MODEL_PROXY_URL        optional (--model-proxy-url wins); route model traffic through an
 *                          Anthropic-compatible proxy such as LiteLLM instead of AI Gateway
 *   MODEL_PROXY_KEY        the proxy's key; required with a new proxy URL. Never printed
 *   MODEL_PROXY_AUTH_HEADER  optional; authorization (default, Bearer) or x-api-key
 *   CLAUDE_CODE_OAUTH_TOKEN  with --owner-seat: your own `claude setup-token` value (prompted for,
 *                          hidden, when unset and run in a terminal). Goes to `wrangler secret put`
 *                          on your Cloudflare account only; never to buildd, never printed
 *
 * The decisions live in src/deploy-plan.ts (tested); this file only observes
 * and executes. Re-running is safe: see planDeploy for what changes when.
 */
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { SNAPSHOT_BUCKET, containerClasses, deployNames, describePlan, planDeploy, renderWranglerConfig, type DeployNames, type DeployStep, type ObservedWebhook } from '../src/deploy-plan';
import { readFileSync, writeFileSync } from 'node:fs';

const APP_DIR = join(dirname(new URL(import.meta.url).pathname), '..');
/** Generated next to wrangler.jsonc so its relative image paths still resolve; gitignored. */
const GENERATED_CONFIG = 'wrangler.generated.jsonc';
const CF_API = 'https://api.cloudflare.com/client/v4';

interface Args {
  workspace?: string;
  rotate: boolean;
  remove: boolean;
  dryRun: boolean;
  printToken: boolean;
  ownerSeat: boolean;
  runnerKey?: string;
  server?: string;
  workerServer?: string;
  url?: string;
  modelProxyUrl?: string;
  name?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { rotate: false, remove: false, dryRun: false, printToken: false, ownerSeat: false };
  const takesValue = new Set(['--workspace', '--runner-key', '--server', '--worker-server', '--url', '--model-proxy-url', '--name']);
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
      if (k === '--model-proxy-url') a.modelProxyUrl = v;
      if (k === '--name') a.name = v;
    } else if (k === '--rotate') a.rotate = true;
    else if (k === '--remove') a.remove = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--print-token') a.printToken = true;
    else if (k === '--owner-seat') a.ownerSeat = true;
    else if (k === '-h' || k === '--help') {
      console.log(readUsage());
      process.exit(0);
    } else die(`unknown argument ${k}`);
  }
  if (!a.workspace) die('--workspace <id|name> is required');
  if (a.rotate && a.remove) die('--rotate and --remove do not go together');
  if (a.ownerSeat && a.remove) die('--owner-seat and --remove do not go together');
  return a;
}

function readUsage(): string {
  return 'usage: bun apps/cloud-runner/scripts/deploy.ts --workspace <id|name> [--runner-key bld_…] [--rotate] [--remove] [--dry-run] [--server <url>] [--worker-server <url>] [--url <worker url>] [--print-token] [--model-proxy-url <url>] [--name <worker name>] [--owner-seat]';
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
  delete env.MODEL_PROXY_KEY;
  // The owner seat goes to `wrangler secret put` on stdin, not into wrangler's own environment.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

let configArgs: string[] = [];

async function wrangler(args: string[], env: Record<string, string>, stdin?: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bunx', 'wrangler', ...args, ...configArgs], {
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

async function workersDevUrl(cf: { apiToken: string; accountId: string }, worker: string): Promise<string> {
  const res = await fetch(`${CF_API}/accounts/${cf.accountId}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${cf.apiToken}` },
  });
  const body = (await res.json().catch(() => ({}))) as { result?: { subdomain?: string } };
  const sub = body.result?.subdomain;
  if (!res.ok || !sub) die(`could not read the account's workers.dev subdomain (HTTP ${res.status}); pass --url`);
  return `https://${worker}.${sub}.workers.dev`;
}

/**
 * The deployer's own Claude token for --owner-seat: CLAUDE_CODE_OAUTH_TOKEN,
 * else a hidden prompt. Never echoed, never logged.
 */
async function readOwnerSeatToken(): Promise<string | undefined> {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) return undefined;
  process.stderr.write('Your `claude setup-token` value (input hidden): ');
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return await new Promise<string>((resolve) => {
    let buf = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(buf.trim());
        }
        if (ch === '\u0003') { stdin.setRawMode(false); process.exit(130); }
        if (ch === '\u007f') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = (args.server ?? process.env.BUILDD_SERVER ?? 'https://buildd.dev').replace(/\/+$/, '');
  const adminKey = process.env.BUILDD_API_KEY;
  if (!adminKey) die('BUILDD_API_KEY (an admin-level buildd API key) is required');
  const runnerKey = args.runnerKey ?? process.env.BUILDD_RUNNER_API_KEY;
  if (runnerKey && runnerKey === adminKey) die('the runner key must not be the admin key: containers run untrusted code');

  let names: DeployNames;
  try { names = deployNames(args.name); } catch (err) { die((err as Error).message); }
  const baseConfig = readFileSync(join(APP_DIR, 'wrangler.jsonc'), 'utf8');
  // Both container classes (standard and large), as the deploy will create them.
  const classes = containerClasses(baseConfig);
  if (names.custom) {
    writeFileSync(join(APP_DIR, GENERATED_CONFIG), renderWranglerConfig(baseConfig, names));
    configArgs = ['--config', GENERATED_CONFIG];
    console.log(`worker: ${names.worker} (bucket ${names.bucket}, config ${GENERATED_CONFIG})`);
  }

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
    workerUrl ??= await workersDevUrl(cf, names.worker);
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
    ownerSeat: { requested: args.ownerSeat, token: args.ownerSeat ? await readOwnerSeatToken() : undefined },
    modelProxy: {
      url: args.modelProxyUrl ?? process.env.MODEL_PROXY_URL,
      key: process.env.MODEL_PROXY_KEY,
      authHeader: process.env.MODEL_PROXY_AUTH_HEADER,
    },
  });

  console.log(`${args.dryRun ? 'plan (dry run, nothing changed)' : 'plan'}:`);
  for (const line of describePlan(plan, names, classes)) console.log(`  ${line}`);
  if (!plan.ok) process.exit(1);
  if (args.dryRun) return;

  for (const step of plan.steps) await execute(step, { server, adminKey, env, bucket: names.bucket });

  const tokenStep = plan.steps.find((s): s is Extract<DeployStep, { kind: 'put_secret' }> => s.kind === 'put_secret' && s.name === 'DISPATCH_TOKEN');
  if (tokenStep && args.printToken) console.log(`DISPATCH_TOKEN=${tokenStep.value}`);
  else if (tokenStep) console.log('DISPATCH_TOKEN set on the Worker and the workspace (not shown; --print-token shows it). A second workspace on this Worker needs it as DISPATCH_TOKEN, or --rotate.');
  console.log(args.remove ? 'done: workspace detached from the cloud runner' : `done: ${workspace.name} dispatches to ${workerUrl}/dispatch`);
}

async function execute(step: DeployStep, ctx: { server: string; adminKey: string; env: Record<string, string> | null; bucket: string }) {
  switch (step.kind) {
    case 'ensure_snapshot_bucket': {
      console.log(`→ ensure R2 bucket ${ctx.bucket}`);
      const created = await wrangler(['r2', 'bucket', 'create', ctx.bucket], ctx.env!);
      if (created.code !== 0 && !/already exists|already own/i.test(created.out)) die(`wrangler r2 bucket create failed:\n${created.out}`);
      for (const rule of SNAPSHOT_BUCKET.lifecycle) {
        const r = await wrangler(['r2', 'bucket', 'lifecycle', 'add', ctx.bucket, rule.id, rule.prefix, '--expire-days', String(rule.expireDays), '--force'], ctx.env!);
        if (r.code !== 0 && !/already exists/i.test(r.out)) console.log(`  lifecycle rule ${rule.id} not set (set it by hand): ${r.out.trim().split('\n').at(-1)}`);
      }
      return;
    }
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
