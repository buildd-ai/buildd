/**
 * The second half of the web-down e2e (apps/control-plane/scripts/web-down-e2e.sh runs it): with apps/web
 * NOT running, a signed GitHub webhook advances a workflow-kernel delivery and
 * a signed Dispatch resolve + receipt round-trip lands, all through the
 * control plane Worker.
 *
 * GitHub is the stateful fake the kernel DB tests use
 * (apps/web/src/lib/workflow/testing/fake-github.ts), served over HTTP here on
 * FAKE_GITHUB_PORT; the Worker reaches it through GITHUB_API_ORIGIN. This
 * process opens the delivery itself (as create_pr does, with the drain left to
 * the Worker) and then only talks to the Worker over HTTP.
 *
 * Env: DATABASE_URL + NEON_LOCAL_FETCH_ENDPOINT (loopback), CP (the Worker),
 * FAKE_GITHUB_PORT (default 8798), GITHUB_APP_WEBHOOK_SECRET and
 * DISPATCH_CALLBACK_SECRET (`keyId:secret`): the values the Worker runs with.
 */
import { createHmac } from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { signRequest } from '@buildd/dispatch-contract';
import { FakeGithub, type WebhookDelivery } from '../../src/lib/workflow/testing/fake-github';
import { openKernelDelivery } from '../../src/lib/workflow/seam';
import { loadView } from '../../src/lib/workflow/kernel';

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (!v) throw new Error(`${k} is required`);
  return v;
};
for (const k of ['DATABASE_URL', 'NEON_LOCAL_FETCH_ENDPOINT']) {
  const host = new URL(env(k)).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error(`${k} must be loopback, got ${host}`);
}
const CP = env('CP', 'http://127.0.0.1:8799');
const PORT = Number(env('FAKE_GITHUB_PORT', '8798'));
const WEBHOOK_SECRET = env('GITHUB_APP_WEBHOOK_SECRET');
const [KEY_ID, ...rest] = env('DISPATCH_CALLBACK_SECRET').split(':');
const DISPATCH_SECRET = rest.join(':');

type Row = Record<string, unknown>;
const q = async <T extends Row = Row>(query: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(query)) as { rows?: T[] }).rows ?? [];
const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };

async function waitFor<T>(label: string, read: () => Promise<T>, done: (v: T) => boolean, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  let v = await read();
  while (!done(v)) {
    if (Date.now() > until) fail(`${label}: still ${JSON.stringify(v)} after ${ms / 1000}s`);
    await Bun.sleep(250);
    v = await read();
  }
  return v;
}

// ── Fake GitHub, over HTTP for the Worker and in-process for the open ──────

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const REPO = `acme/cp-${RUN}`;
const BRANCH = 'feat/cp-e2e';
const installationId = Math.floor(Math.random() * 1e12);
const gh = new FakeGithub({ installationId, seed: 7 });
const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: (req) => {
    const u = new URL(req.url);
    return gh.fetch(new Request(`https://api.github.com${u.pathname}${u.search}`, req));
  },
});
const restoreFetch = gh.installFetch();

async function sendWebhook(d: WebhookDelivery): Promise<Response> {
  const body = JSON.stringify(d.payload);
  return fetch(`${CP}/api/github/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': d.name,
      'x-github-delivery': d.id,
      'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    body,
  });
}

async function signedPost(path: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers = await signRequest({ keyId: KEY_ID, secret: DISPATCH_SECRET, method: 'POST', path, body });
  return fetch(`${CP}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
}

try {
  // ── Seed: a kernel workspace on the dispatch transport, with a repo ─────
  const slug = `cp-${RUN}`;
  const [team] = await q<{ id: string }>(sql`INSERT INTO teams (name, slug) VALUES (${slug}, ${slug}) RETURNING id`);
  const webhookConfig = { url: 'https://hooks.example.test/agent', token: 'hook-token', enabled: true };
  const [ws] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id, access_mode, dispatch_transport, webhook_config)
    VALUES (${`cp-ws-${RUN}`}, ${team.id}::uuid, 'open', 'dispatch', ${JSON.stringify(webhookConfig)}::jsonb) RETURNING id`);
  const workspaceId = ws.id;
  // A cached, unexpired installation token: nothing signs an App JWT.
  const [inst] = await q<{ id: string }>(sql`INSERT INTO github_installations (installation_id, account_type, account_login, account_id, access_token, token_expires_at)
    VALUES (${installationId}, 'Organization', 'acme', ${installationId}, 'ghs_fake', now() + interval '1 day') RETURNING id`);
  const [repo] = await q<{ id: string }>(sql`INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner, default_branch)
    VALUES (${inst.id}::uuid, ${installationId}, ${REPO}, ${REPO.split('/')[1]}, 'acme', 'dev') RETURNING id`);
  await q(sql`UPDATE workspaces SET github_installation_id = ${inst.id}::uuid, github_repo_id = ${repo.id}::uuid WHERE id = ${workspaceId}::uuid`);

  // ── 1. A signed webhook advances a kernel delivery ───────────────────────
  gh.createRepo(REPO, { defaultBranch: 'dev', files: { 'src/a.ts': 'export const a = 1;\n' } });
  const head = gh.push(REPO, BRANCH, { 'src/a.ts': 'export const a = 2;\n' });
  const prNumber = gh.openPr(REPO, { head: BRANCH, base: 'dev', title: 'feat: control plane e2e' });
  gh.greenCi(REPO, head, ['build']);
  const prUrl = `https://github.com/${REPO}/pull/${prNumber}`;
  const [owner] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status) VALUES (${workspaceId}::uuid, 'feat: control plane e2e', 'in_progress') RETURNING id`);
  await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, last_commit_sha, pr_number, pr_url, commit_count)
    VALUES (${workspaceId}::uuid, ${owner.id}::uuid, 'w', 'cp-e2e', ${BRANCH}, 'running', ${head}, ${prNumber}, ${prUrl}, 1)`);
  // create_pr's open, with its inline drain left undone: the Worker drains.
  const opened = await openKernelDelivery({ workspaceId, ownerTaskId: owner.id, repoFullName: REPO, prNumber, installationId, source: 'cp-e2e' }, { drain: async () => null });
  if (!opened.owned || !opened.deliveryId) fail(`kernel did not open the delivery: ${opened.reason}`);
  const deliveryId = opened.deliveryId!;

  // Earlier hints (the push, the open) are not under test: drop them.
  await gh.deliverWebhooks();
  gh.mergePr(REPO, prNumber);
  const closed: WebhookDelivery[] = [];
  const off = gh.onWebhook(async (d) => { if (d.name === 'pull_request' && d.payload.action === 'closed') closed.push(d); });
  await gh.deliverWebhooks();
  off();
  if (closed.length !== 1) fail(`expected one pull_request.closed hint, got ${closed.length}`);
  const res = await sendWebhook(closed[0]);
  if (res.status !== 200) fail(`webhook answered ${res.status}: ${await res.text()}`);
  if (res.headers.get('x-buildd-served-by') !== 'control-plane') fail(`webhook served by ${res.headers.get('x-buildd-served-by')}`);
  // Read through the kernel's own view: kernel tables have one reader and writer (workflow-write-sites.test.ts).
  const merged = await waitFor('delivery state',
    async () => (await loadView({ deliveryId })).delivery?.state,
    (s) => s === 'MERGED');
  // The merge lands on the worker row, in the Worker (stamp_pr_rows, drained inline or in waitUntil).
  await waitFor('worker merged_at',
    async () => (await q<{ merged_at: string | null }>(sql`SELECT merged_at FROM workers WHERE task_id = ${owner.id}::uuid`))[0]?.merged_at ?? null,
    (v) => v !== null);
  console.log(`PASS: a signed pull_request.closed webhook took the delivery to ${merged} through the control plane, and the worker's merge is stamped`);

  // ── 2. A signed Dispatch resolve + receipt round-trip ───────────────────
  const [wake] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status) VALUES (${workspaceId}::uuid, 'dispatch e2e task', 'pending') RETURNING id`);
  const [row] = await waitFor('outbox row',
    () => q<{ id: string; status: string }>(sql`SELECT id, status FROM task_dispatch_outbox WHERE task_id = ${wake.id}::uuid ORDER BY created_at LIMIT 1`),
    (rows) => rows.length === 1);
  // The publish to Dispatch, which needs web (a cron or an after()): marked
  // published with its ack not yet written, so the resolve takes custody the
  // way it does when a callback outruns the ack.
  await q(sql`UPDATE task_dispatch_outbox SET published_at = now() WHERE id = ${row.id}::uuid`);
  const resolve = await signedPost('/api/dispatch/v1/resolve', { id: row.id, attempt: 1, target: `buildd:ws:${workspaceId}:webhook` });
  const decision = await resolve.json() as { decision?: string; why?: string; grant?: { url?: string } };
  if (resolve.status !== 200 || decision.decision !== 'deliver') fail(`resolve answered ${resolve.status} ${JSON.stringify(decision)}`);
  if (decision.grant?.url !== webhookConfig.url) fail(`resolve granted ${decision.grant?.url}`);
  if (resolve.headers.get('x-buildd-served-by') !== 'control-plane') fail(`resolve served by ${resolve.headers.get('x-buildd-served-by')}`);
  const receipt = await signedPost('/api/dispatch/v1/receipts', { receipts: [{ id: row.id, attempt: 1, event: 'delivered', via: 'webhook', at: new Date().toISOString() }] });
  const applied = await receipt.json() as { applied?: number };
  if (receipt.status !== 200 || applied.applied !== 1) fail(`receipts answered ${receipt.status} ${JSON.stringify(applied)}`);
  const [after] = await q<{ status: string; delivered_via: string | null }>(sql`SELECT status, delivered_via FROM task_dispatch_outbox WHERE id = ${row.id}::uuid`);
  if (after.status !== 'delivered' || after.delivered_via !== 'webhook') fail(`outbox row is ${after.status}/${after.delivered_via}`);
  // A forged receipt is refused at the Worker.
  const forged = await fetch(`${CP}/api/dispatch/v1/receipts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receipts: [] }) });
  if (forged.status !== 401) fail(`an unsigned receipt answered ${forged.status}`);
  console.log(`PASS: Dispatch resolve (deliver) and receipt (delivered via webhook) through the control plane (outbox row ${after.status})`);
} finally {
  restoreFetch();
  server.stop(true);
}
process.exit(0);
