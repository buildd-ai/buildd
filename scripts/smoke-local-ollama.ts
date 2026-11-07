#!/usr/bin/env bun
/**
 * Smoke check for a local Ollama before pointing a buildd runner at it
 * (docs/local-ollama-runner.md). Reads the same variables the runner reads:
 *
 *   BUILDD_LOCAL_MODEL_URL      default http://localhost:11434 (loopback only)
 *   BUILDD_LOCAL_MODEL          required: the model name to test
 *   BUILDD_LOCAL_MODEL_CONTEXT  optional: the window the runner will tell Codex about
 *
 * Checks: Ollama reachable, model pulled, context length adequate, then one
 * one-shot request on each wire the runner uses (Anthropic-compatible
 * /v1/messages for Claude tasks, /v1/responses for Codex tasks). Exits 1 on
 * the first failure with a message saying what to change. Needs no credential.
 *
 * Usage: bun run scripts/smoke-local-ollama.ts [--min-context 32768]
 */
export const DEFAULT_URL = 'http://localhost:11434';
/** Agentic coding sessions carry a system prompt, tool schemas and file reads. */
export const DEFAULT_MIN_CONTEXT = 32768;

export interface SmokeConfig {
  origin: string;
  model: string;
  declaredContext?: number;
  minContext: number;
}

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Config from env + argv; throws a message fit to print. */
export function resolveConfig(env: Record<string, string | undefined>, argv: string[] = []): SmokeConfig {
  const raw = env.BUILDD_LOCAL_MODEL_URL?.trim() || DEFAULT_URL;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`BUILDD_LOCAL_MODEL_URL is not a valid URL: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('BUILDD_LOCAL_MODEL_URL must be http(s)');
  if (!isLoopback(url.hostname)) throw new Error('BUILDD_LOCAL_MODEL_URL must be a loopback address (localhost, 127.x, ::1); the runner refuses anything else');
  const model = env.BUILDD_LOCAL_MODEL?.trim();
  if (!model) throw new Error('BUILDD_LOCAL_MODEL is required (the Ollama model name, e.g. the one you pulled)');
  const ctxRaw = env.BUILDD_LOCAL_MODEL_CONTEXT?.trim();
  const declaredContext = ctxRaw ? Number(ctxRaw) : undefined;
  if (ctxRaw && !(Number.isInteger(declaredContext) && (declaredContext as number) > 0)) throw new Error('BUILDD_LOCAL_MODEL_CONTEXT must be a positive integer');
  const i = argv.indexOf('--min-context');
  const minContext = i >= 0 ? Number(argv[i + 1]) : DEFAULT_MIN_CONTEXT;
  if (!Number.isInteger(minContext) || minContext <= 0) throw new Error('--min-context must be a positive integer');
  return { origin: url.origin, model, ...(declaredContext ? { declaredContext } : {}), minContext };
}

/** Whether `/api/tags` lists the model. `name` and `name:latest` are the same model. */
export function modelPresent(tags: unknown, model: string): boolean {
  const list = (tags as { models?: Array<{ name?: string; model?: string }> } | null)?.models;
  if (!Array.isArray(list)) return false;
  const want = model.includes(':') ? model : `${model}:latest`;
  return list.some(m => [m.name, m.model].some(n => typeof n === 'string' && (n === want || n === model)));
}

/**
 * The context length the model will actually run with, from `/api/show`
 * (+ `/api/ps` for a loaded model). A `num_ctx` line in the Modelfile
 * parameters wins over the architecture maximum, which is only the ceiling.
 */
export function effectiveContext(show: unknown, ps?: unknown, model?: string): { tokens?: number; source: string } {
  const loaded = (ps as { models?: Array<{ name?: string; model?: string; context_length?: number }> } | null)?.models
    ?.find(m => m.name === model || m.model === model || (model && (m.name === `${model}:latest`)));
  if (loaded && typeof loaded.context_length === 'number') return { tokens: loaded.context_length, source: 'loaded model' };
  const params = (show as { parameters?: string } | null)?.parameters;
  const m = typeof params === 'string' ? /^\s*num_ctx\s+(\d+)\s*$/m.exec(params) : null;
  if (m) return { tokens: Number(m[1]), source: 'Modelfile num_ctx' };
  return { source: 'not set: the server default applies (OLLAMA_CONTEXT_LENGTH)' };
}

/** Pass/fail for a context figure; undefined tokens means the default applies, which is small. */
export function contextVerdict(tokens: number | undefined, min: number): { ok: boolean; message: string } {
  if (tokens === undefined) return { ok: false, message: `no explicit context length found. Set OLLAMA_CONTEXT_LENGTH=${min} (or more) on the Ollama server, or bake num_ctx into a Modelfile` };
  if (tokens < min) return { ok: false, message: `context length ${tokens} is below ${min}. Agentic tools need a large window: raise OLLAMA_CONTEXT_LENGTH` };
  return { ok: true, message: `context length ${tokens}` };
}

export function anthropicRequest(model: string): { path: string; headers: Record<string, string>; body: unknown } {
  return {
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'x-api-key': 'ollama', authorization: 'Bearer ollama', 'anthropic-version': '2023-06-01' },
    body: { model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] },
  };
}

export function responsesRequest(model: string): { path: string; headers: Record<string, string>; body: unknown } {
  return {
    path: '/v1/responses',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ollama' },
    body: { model, input: 'Reply with the single word: ok', max_output_tokens: 64 },
  };
}

/** Text out of an Anthropic Messages reply, or '' when there is none. */
export function anthropicText(json: unknown): string {
  const c = (json as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  return Array.isArray(c) ? c.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('') : '';
}

/** Text out of a Responses API reply (`output_text` or message output items). */
export function responsesText(json: unknown): string {
  const j = json as { output_text?: unknown; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> } | null;
  if (typeof j?.output_text === 'string') return j.output_text;
  if (!Array.isArray(j?.output)) return '';
  return j.output.filter(o => o.type === 'message').flatMap(o => o.content ?? []).filter(c => typeof c.text === 'string').map(c => c.text).join('');
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(180_000) });
  let json: unknown = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

async function main(): Promise<number> {
  let cfg: SmokeConfig;
  try { cfg = resolveConfig(process.env, process.argv.slice(2)); } catch (e) { console.error(`FAIL config: ${(e as Error).message}`); return 1; }
  const fail = (what: string, why: string) => { console.error(`FAIL ${what}: ${why}`); return 1; };
  console.log(`Ollama ${cfg.origin}, model ${cfg.model}`);

  let tags;
  try { tags = await getJson(`${cfg.origin}/api/tags`); } catch (e) {
    return fail('reachable', `cannot reach ${cfg.origin} (${(e as Error).message}). Start it with \`ollama serve\``);
  }
  if (tags.status !== 200) return fail('reachable', `${cfg.origin}/api/tags answered ${tags.status}; is this Ollama?`);
  console.log('ok   reachable');

  if (!modelPresent(tags.json, cfg.model)) return fail('model present', `${cfg.model} is not pulled. Run \`ollama pull ${cfg.model}\``);
  console.log('ok   model present');

  const show = await getJson(`${cfg.origin}/api/show`, { method: 'POST', body: JSON.stringify({ model: cfg.model }) });
  const ps = await getJson(`${cfg.origin}/api/ps`).catch(() => ({ status: 0, json: null }));
  const ctx = effectiveContext(show.json, ps.json, cfg.model);
  const verdict = contextVerdict(ctx.tokens, cfg.minContext);
  if (!verdict.ok) return fail('context length', verdict.message);
  console.log(`ok   ${verdict.message} (${ctx.source})`);
  if (cfg.declaredContext && ctx.tokens && cfg.declaredContext > ctx.tokens) {
    return fail('context length', `BUILDD_LOCAL_MODEL_CONTEXT=${cfg.declaredContext} exceeds what the server runs with (${ctx.tokens}); Codex would overfill the window`);
  }

  for (const [label, req, textOf] of [
    ['anthropic-compatible (Claude tasks)', anthropicRequest(cfg.model), anthropicText],
    ['responses API (Codex tasks)', responsesRequest(cfg.model), responsesText],
  ] as const) {
    let r;
    try { r = await getJson(`${cfg.origin}${req.path}`, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) }); } catch (e) {
      return fail(label, (e as Error).message);
    }
    if (r.status !== 200) return fail(label, `${req.path} answered ${r.status}${r.status === 404 ? '; this Ollama may be too old for the endpoint, upgrade it' : ''}`);
    if (!textOf(r.json).trim()) return fail(label, `${req.path} answered 200 with no text`);
    console.log(`ok   ${label}`);
  }
  console.log('All checks passed. Tool-call quality is not tested here; run the task smoke in docs/local-ollama-runner.md.');
  return 0;
}

if (import.meta.main) process.exit(await main());
