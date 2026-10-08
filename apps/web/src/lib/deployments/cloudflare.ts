/**
 * Cloudflare deployment adapter: the operations buildd runs against the
 * Cloudflare API with a stored `cloudflare_token`, server-side.
 *
 * Pure apart from the injected fetch, so the non-disclosure rules can be
 * asserted directly:
 * - every result is built field by field from an allowlist, never by passing
 *   a provider body through;
 * - provider error text is scrubbed of the token and account id and capped
 *   before it goes anywhere;
 * - a Worker secret value the caller supplies is sent and never echoed.
 */
import { CLOUDFLARE_API_BASE, type CloudflareCredential, type FetchLike } from '../cloudflare-credential-shared';

/** Names a Worker, R2 bucket and secret may take. Cloudflare's own rules, narrowed. */
const SCRIPT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MODULE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,127}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FLAG_RE = /^[a-z0-9_]{1,64}$/;

/** Upload cap, under the serverless request body limit. */
export const MAX_BUNDLE_BYTES = 3 * 1024 * 1024;
export const MAX_SECRET_BYTES = 64 * 1024;

export type CloudflareOperation = 'status' | 'put_secret' | 'upload_worker' | 'ensure_bucket';

/** The Worker script a target deploys to: the project in production, `<project>-<environment>` elsewhere. */
export function cloudflareScriptName(project: string, environment: string): string {
  const p = project.trim().toLowerCase();
  const e = environment.trim().toLowerCase();
  return e === 'production' ? p : `${p}-${e}`;
}

export type ParsedParams =
  | { ok: true; op: 'status' }
  | { ok: true; op: 'put_secret'; name: string; value: string }
  | {
      ok: true;
      op: 'upload_worker';
      mainModule: string;
      modules: Array<{ name: string; content: string }>;
      compatibilityDate: string;
      compatibilityFlags: string[];
      vars: Record<string, string>;
    }
  | { ok: true; op: 'ensure_bucket'; bucket: string; lifecycle: Array<{ id: string; prefix: string; expireDays: number }> }
  | { ok: false; error: string };

/**
 * Validate one operation's params. `script` is the derived Worker name: a
 * bucket must be named after it, so a grant for one project cannot create
 * another project's bucket.
 */
export function parseCloudflareParams(op: CloudflareOperation, raw: unknown, script: string): ParsedParams {
  const p = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  switch (op) {
    case 'status':
      return { ok: true, op };
    case 'put_secret': {
      if (typeof p.name !== 'string' || !SECRET_NAME_RE.test(p.name)) return { ok: false, error: 'params.name must be a secret name (letters, digits, underscore)' };
      if (typeof p.value !== 'string' || p.value.length === 0) return { ok: false, error: 'params.value must be a non-empty string' };
      if (Buffer.byteLength(p.value) > MAX_SECRET_BYTES) return { ok: false, error: `params.value is over ${MAX_SECRET_BYTES} bytes` };
      return { ok: true, op, name: p.name, value: p.value };
    }
    case 'upload_worker': {
      if (!Array.isArray(p.modules) || p.modules.length === 0) return { ok: false, error: 'params.modules must be a non-empty array of { name, content }' };
      const modules: Array<{ name: string; content: string }> = [];
      let bytes = 0;
      for (const m of p.modules as unknown[]) {
        const mod = m as Record<string, unknown> | null;
        if (!mod || typeof mod.name !== 'string' || !MODULE_NAME_RE.test(mod.name) || mod.name.includes('..')) {
          return { ok: false, error: 'each module needs a plain relative name' };
        }
        if (typeof mod.content !== 'string') return { ok: false, error: `module ${mod.name}: content must be a string` };
        bytes += Buffer.byteLength(mod.content);
        modules.push({ name: mod.name, content: mod.content });
      }
      if (bytes > MAX_BUNDLE_BYTES) return { ok: false, error: `bundle is over ${MAX_BUNDLE_BYTES} bytes` };
      const mainModule = typeof p.mainModule === 'string' ? p.mainModule : modules[0].name;
      if (!modules.some(m => m.name === mainModule)) return { ok: false, error: `mainModule ${mainModule} is not among the modules` };
      if (typeof p.compatibilityDate !== 'string' || !DATE_RE.test(p.compatibilityDate)) return { ok: false, error: 'params.compatibilityDate must be YYYY-MM-DD' };
      const flags = p.compatibilityFlags ?? [];
      if (!Array.isArray(flags) || flags.some(f => typeof f !== 'string' || !FLAG_RE.test(f))) return { ok: false, error: 'params.compatibilityFlags must be an array of flag names' };
      const vars: Record<string, string> = {};
      if (p.vars !== undefined) {
        if (!p.vars || typeof p.vars !== 'object' || Array.isArray(p.vars)) return { ok: false, error: 'params.vars must be an object of strings' };
        for (const [k, v] of Object.entries(p.vars as Record<string, unknown>)) {
          if (!SECRET_NAME_RE.test(k) || typeof v !== 'string') return { ok: false, error: `params.vars.${k} must be a string under a plain name` };
          vars[k] = v;
        }
      }
      return { ok: true, op, mainModule, modules, compatibilityDate: p.compatibilityDate, compatibilityFlags: flags as string[], vars };
    }
    case 'ensure_bucket': {
      const bucket = typeof p.bucket === 'string' ? p.bucket : `${script}-snapshots`;
      if (!bucket.startsWith(`${script}-`) || !SCRIPT_RE.test(bucket)) {
        return { ok: false, error: `params.bucket must be named "${script}-<suffix>" (lowercase letters, digits, dashes)` };
      }
      const rules = p.lifecycle ?? [];
      if (!Array.isArray(rules)) return { ok: false, error: 'params.lifecycle must be an array' };
      const lifecycle: Array<{ id: string; prefix: string; expireDays: number }> = [];
      for (const r of rules as unknown[]) {
        const rule = r as Record<string, unknown> | null;
        if (!rule || typeof rule.id !== 'string' || typeof rule.prefix !== 'string' || typeof rule.expireDays !== 'number'
          || !Number.isInteger(rule.expireDays) || rule.expireDays < 1) {
          return { ok: false, error: 'each lifecycle rule needs { id, prefix, expireDays (whole days >= 1) }' };
        }
        lifecycle.push({ id: rule.id, prefix: rule.prefix, expireDays: rule.expireDays });
      }
      return { ok: true, op, bucket, lifecycle };
    }
  }
}

export type AdapterResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; status: number; error: string };

/** Remove every occurrence of the credential's parts from text, and cap it. */
export function scrubProviderText(text: string, cred: CloudflareCredential): string {
  let out = text;
  for (const secret of [cred.apiToken, cred.accountId]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out.slice(0, 300);
}

interface CfEnvelope {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: unknown;
}

async function cf(
  fetchImpl: FetchLike,
  cred: CloudflareCredential,
  path: string,
  init: { method?: string; body?: BodyInit; json?: unknown } = {},
): Promise<{ status: number; ok: boolean; body: CfEnvelope }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${cred.apiToken}` };
  let body = init.body;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetchImpl(`${CLOUDFLARE_API_BASE}/accounts/${cred.accountId}${path}`, { method: init.method ?? 'GET', headers, body });
  const parsed = (await res.json().catch(() => ({}))) as CfEnvelope;
  return { status: res.status, ok: res.ok && parsed.success !== false, body: parsed };
}

function providerError(op: string, r: { status: number; body: CfEnvelope }, cred: CloudflareCredential): AdapterResult {
  const first = r.body.errors?.[0];
  const detail = first ? `${first.code ?? ''} ${first.message ?? ''}`.trim() : `HTTP ${r.status}`;
  // A provider 4xx is the caller's target or input; anything else is upstream.
  const status = r.status === 401 || r.status === 403 ? 502 : r.status >= 400 && r.status < 500 ? 422 : 502;
  return { ok: false, status, error: `cloudflare ${op} failed: ${scrubProviderText(detail, cred)}` };
}

function isNotFound(r: { status: number; body: CfEnvelope }): boolean {
  return r.status === 404 || !!r.body.errors?.some(e => e.code === 10007);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Run one parsed operation against `script`. */
export async function runCloudflareOperation(
  params: Exclude<ParsedParams, { ok: false }>,
  script: string,
  cred: CloudflareCredential,
  fetchImpl: FetchLike = fetch,
): Promise<AdapterResult> {
  if (!SCRIPT_RE.test(script)) return { ok: false, status: 400, error: `"${script}" is not a valid Worker name` };
  const s = encodeURIComponent(script);

  switch (params.op) {
    case 'status': {
      const [deployments, secrets, subdomain] = await Promise.all([
        cf(fetchImpl, cred, `/workers/scripts/${s}/deployments`),
        cf(fetchImpl, cred, `/workers/scripts/${s}/secrets`),
        cf(fetchImpl, cred, '/workers/subdomain'),
      ]);
      const sub = subdomain.ok ? str((subdomain.body.result as { subdomain?: unknown } | undefined)?.subdomain) : null;
      const workersDevUrl = sub ? `https://${script}.${sub}.workers.dev` : null;
      if (isNotFound(deployments)) return { ok: true, result: { script, exists: false, secretNames: null, workersDevUrl } };
      if (!deployments.ok) return providerError('status', deployments, cred);
      const list = ((deployments.body.result as { deployments?: unknown[] } | undefined)?.deployments ?? []) as Array<Record<string, unknown>>;
      const latest = list[0];
      return {
        ok: true,
        result: {
          script,
          exists: true,
          // Identity only: id, time, source, version split. No author email, no annotations.
          latestDeployment: latest
            ? {
                id: str(latest.id),
                createdOn: str(latest.created_on),
                source: str(latest.source),
                versions: Array.isArray(latest.versions)
                  ? (latest.versions as Array<Record<string, unknown>>).map(v => ({ versionId: str(v.version_id), percentage: typeof v.percentage === 'number' ? v.percentage : null }))
                  : [],
              }
            : null,
          deploymentCount: list.length,
          // Names only; Cloudflare never returns secret values, and neither does this.
          secretNames: secrets.ok && Array.isArray(secrets.body.result)
            ? (secrets.body.result as Array<Record<string, unknown>>).map(x => str(x.name)).filter((n): n is string => !!n).sort()
            : null,
          workersDevUrl,
        },
      };
    }

    case 'put_secret': {
      const r = await cf(fetchImpl, cred, `/workers/scripts/${s}/secrets`, {
        method: 'PUT',
        json: { name: params.name, text: params.value, type: 'secret_text' },
      });
      if (!r.ok) return providerError('put_secret', r, cred);
      return { ok: true, result: { script, secret: params.name, set: true } };
    }

    case 'upload_worker': {
      const metadata = {
        main_module: params.mainModule,
        compatibility_date: params.compatibilityDate,
        compatibility_flags: params.compatibilityFlags,
        // Secrets are set separately (put_secret) and must survive a code upload.
        keep_bindings: ['secret_text', 'secret_key'],
        bindings: Object.entries(params.vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
        observability: { enabled: true },
      };
      const form = new FormData();
      form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      for (const m of params.modules) {
        const type = m.name.endsWith('.map') ? 'application/source-map' : m.name.endsWith('.wasm') ? 'application/wasm' : 'application/javascript+module';
        form.set(m.name, new Blob([m.content], { type }), m.name);
      }
      const r = await cf(fetchImpl, cred, `/workers/scripts/${s}`, { method: 'PUT', body: form });
      if (!r.ok) return providerError('upload_worker', r, cred);
      const res = (r.body.result ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        result: {
          script,
          etag: str(res.etag),
          modifiedOn: str(res.modified_on),
          deploymentId: str(res.deployment_id),
          modules: params.modules.map(m => m.name),
        },
      };
    }

    case 'ensure_bucket': {
      const created = await cf(fetchImpl, cred, '/r2/buckets', { method: 'POST', json: { name: params.bucket } });
      const already = !created.ok && (created.status === 409 || !!created.body.errors?.some(e => e.code === 10004 || /already exists/i.test(e.message ?? '')));
      if (!created.ok && !already) return providerError('ensure_bucket', created, cred);
      let lifecycleSet = false;
      if (params.lifecycle.length > 0) {
        const r = await cf(fetchImpl, cred, `/r2/buckets/${encodeURIComponent(params.bucket)}/lifecycle`, {
          method: 'PUT',
          json: {
            rules: params.lifecycle.map(rule => ({
              id: rule.id,
              enabled: true,
              conditions: { prefix: rule.prefix },
              deleteObjectsTransition: { condition: { type: 'Age', maxAge: rule.expireDays * 86_400 } },
            })),
          },
        });
        if (!r.ok) return providerError('ensure_bucket lifecycle', r, cred);
        lifecycleSet = true;
      }
      return { ok: true, result: { bucket: params.bucket, created: created.ok, lifecycleRules: lifecycleSet ? params.lifecycle.map(r => r.id) : [] } };
    }
  }
}
