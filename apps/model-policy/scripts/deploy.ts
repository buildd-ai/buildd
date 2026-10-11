#!/usr/bin/env bun
/**
 * Ship the model-policy Worker with the Cloudflare credential stored in
 * buildd, which never comes to this machine.
 *
 *   bun apps/model-policy/scripts/deploy.ts [--environment production] [--credential-ref cloudflare]
 *       [--emit <file>] | [--workspace <id> [--secret NAME]... [--server <url>]]
 *
 * Builds the bundle with `wrangler deploy --dry-run --outdir` (no credential
 * involved), then either:
 *
 * --emit <file>   writes the deployment-action request to <file> and stops. A
 *                 Platform Operator task passes that JSON to the `deploy` MCP
 *                 action; buildd checks the workspace's Operator grant for this
 *                 project/environment/credential ref and deploys server-side.
 *
 * --workspace     a person with an admin key (BUILDD_API_KEY) sends it to
 *                 POST /api/deployments, the audited escape hatch. Each
 *                 --secret NAME puts the value of env var NAME as a Worker
 *                 secret (POLICY_TOKENS, MODEL_POLICY), never printed.
 *
 * Project is the Worker name in wrangler.jsonc; the Worker deployed is that
 * name in production and <name>-<environment> elsewhere.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readWranglerSettings, uploadRequest } from './deploy-request';

const APP_DIR = join(dirname(new URL(import.meta.url).pathname), '..');

function die(msg: string): never {
  console.error(`deploy: ${msg}`);
  process.exit(1);
}

interface Args { environment: string; credentialRef: string; emit?: string; workspace?: string; server?: string; secrets: string[] }

function parseArgs(argv: string[]): Args {
  const a: Args = { environment: 'production', credentialRef: 'cloudflare', secrets: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (!x || x.startsWith('--')) die(`${k} needs a value`); return x; };
    if (k === '--environment') a.environment = v();
    else if (k === '--credential-ref') a.credentialRef = v();
    else if (k === '--emit') a.emit = v();
    else if (k === '--workspace') a.workspace = v();
    else if (k === '--server') a.server = v();
    else if (k === '--secret') a.secrets.push(v());
    else die(`unknown argument ${k}`);
  }
  if (!a.emit === !a.workspace) die('pass exactly one of --emit <file> or --workspace <id>');
  if (a.emit && a.secrets.length) die('--secret goes with --workspace; an Operator sets secrets with the deploy action (put_secret)');
  return a;
}

async function build(): Promise<Array<{ name: string; content: string }>> {
  const out = mkdtempSync(join(tmpdir(), 'model-policy-'));
  try {
    const proc = Bun.spawn(['bunx', 'wrangler', 'deploy', '--dry-run', '--outdir', out], { cwd: APP_DIR, stdout: 'pipe', stderr: 'pipe' });
    const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) die(`wrangler build failed:\n${o}${e}`);
    return readdirSync(out).map(name => ({ name, content: readFileSync(join(out, name), 'utf8') }));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

async function action(server: string, key: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${server}/api/deployments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) die(`HTTP ${res.status}: ${String(json.error ?? 'request failed')}`);
  return json;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings = readWranglerSettings(readFileSync(join(APP_DIR, 'wrangler.jsonc'), 'utf8'));
  const target = { project: settings.name, environment: args.environment, credentialRef: args.credentialRef };
  const request = uploadRequest(settings, await build(), target);

  if (args.emit) {
    writeFileSync(args.emit, JSON.stringify(request, null, 2));
    console.log(`wrote ${args.emit}: pass it to the deploy MCP action (operation upload_worker, ${request.params.modules.length} module(s))`);
    return;
  }

  const key = process.env.BUILDD_API_KEY;
  if (!key) die('BUILDD_API_KEY (an admin-level buildd API key) is required with --workspace');
  const server = (args.server ?? process.env.BUILDD_SERVER ?? 'https://buildd.dev').replace(/\/+$/, '');
  const scope = { workspaceId: args.workspace, provider: 'cloudflare', ...target };

  const up = await action(server, key, { ...request, workspaceId: args.workspace });
  console.log(`uploaded: ${JSON.stringify(up.result)} (audit ${up.auditId})`);
  for (const name of args.secrets) {
    const value = process.env[name];
    if (!value) die(`--secret ${name}: env var ${name} is empty`);
    const r = await action(server, key, { ...scope, operation: 'put_secret', params: { name, value } });
    console.log(`secret ${name} set (audit ${r.auditId})`);
  }
  const status = await action(server, key, { ...scope, operation: 'status' });
  console.log(`status: ${JSON.stringify(status.result)}`);
}

if (import.meta.main) {
  main().catch((err) => die(err instanceof Error ? err.message : String(err)));
}
