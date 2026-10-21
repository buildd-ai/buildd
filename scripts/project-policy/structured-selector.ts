import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, redactSecrets } from '../../packages/ai-kit/src/decide';
import { rowState, type ExperimentRow } from './pattern-experiment';
import prompt from './selector-prompts.json';
import authorPrompt from './prompt-author-instructions.json';

// Reuse the installed web SDK/provider, as scripts/demo does; no extra transport.
const requireWeb = createRequire(resolve(import.meta.dir, '../../apps/web/package.json'));
const { generateText, Output } = requireWeb('ai') as typeof import('../../apps/web/node_modules/ai');
const { createOpenRouter } = requireWeb('@openrouter/ai-sdk-provider') as typeof import('../../apps/web/node_modules/@openrouter/ai-sdk-provider');
const { z } = requireWeb('zod') as typeof import('../../apps/web/node_modules/zod');
export const SELECTOR_MODEL = 'deepseek/deepseek-v4.1-flash';
const patterns = ['over_explanation', 'duplication', 'vague_action'] as const;
export type ProposedPattern = typeof patterns[number];
export type Selection = { id: string; disposition: 'review' | 'leave' | 'need_context'; patterns: ProposedPattern[] };
export type AuthoredPrompts = Record<ProposedPattern, { question: string; revise: string; keep: string; uncertain: string }>;
const detectorSchema = z.object({ question: z.string().min(20).max(900), revise: z.string().min(10).max(400),
  keep: z.string().min(10).max(400), uncertain: z.string().min(10).max(400) }).strict();
const authorSchema = z.object({ over_explanation: detectorSchema, duplication: detectorSchema, vague_action: detectorSchema }).strict();
type AuthorOutcome = { ok: true; prompts: AuthoredPrompts } | { ok: false; reason: 'unsafe_input' | 'budget' | 'provider_or_schema' };
type Outcome = { ok: true; rows: Selection[] } | { ok: false; reason: 'unsafe_input' | 'budget' | 'provider_or_schema' };
type Receipt = { requestedModel: string; model: string | null; promptFingerprint: string; inputFingerprint: string; ok: boolean; attempts: number;
  latencyMs: number; costUsd: number | null; inputTokens: number | null; outputTokens: number | null;
  status: number | null; finish: string | null };
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
type Fetcher = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

export function createStructuredSelector(apiKey: string, fetcher: Fetcher = fetch, maxCalls = 20) {
  if (!Number.isInteger(maxCalls) || maxCalls < 0 || maxCalls > 100) throw new Error('Invalid selector budget.');
  const calls: Receipt[] = [];
  let reserved = 0;
    async function run(rows: ExperimentRow[], author = false): Promise<Outcome | AuthorOutcome> {
      if (!apiKey || !Array.isArray(rows) || !rows.length || rows.length > 48 || rows.some(r => !r || typeof r.id !== 'string')
        || new Set(rows.map(r => r.id)).size !== rows.length) return { ok: false, reason: 'unsafe_input' };
      if (author && (rows.length > 16 || rows.some(r => !['revise', 'keep', 'uncertain'].includes(r.expected ?? '')))) return { ok: false, reason: 'unsafe_input' };
      if (rows.some(r => typeof r.text !== 'string' || typeof r.purpose !== 'string'
        || !['action', 'description', 'heading', 'status', 'diagnostic'].includes(r.role)
        || r.component !== undefined && typeof r.component !== 'string' || r.prop !== undefined && typeof r.prop !== 'string'
        || r.staticContext && (r.staticContext.completeness !== 'static-partial' || typeof r.staticContext.container !== 'string'
          || r.staticContext.heading !== undefined && typeof r.staticContext.heading !== 'string'
          || !Array.isArray(r.staticContext.nearbyText) || r.staticContext.nearbyText.some(t => typeof t !== 'string')))) return { ok: false, reason: 'unsafe_input' };
      const inputs = rows.map((r, i) => ({ id: `c_${i}`, ...rowState(r), ...(author ? { expected: r.expected } : {}) }));
      const instructions = author ? authorPrompt : prompt;
      const raw = canonicalJson(inputs);
      if (rows.some(r => typeof r.text !== 'string' || r.text.length > 500 || r.purpose.length > 80)
        || inputs.some(r => r.role === 'unknown' || r.component.length > 80 || r.prop.length > 80
          || r.staticContext && (r.staticContext.container.length > 80 || (r.staticContext.heading?.length ?? 0) > 120
            || r.staticContext.nearbyText.length > 2 || r.staticContext.nearbyText.some(t => t.length > 160)))
        || raw.length > 64000 || redactSecrets(raw, [apiKey]) !== raw
        || /(?:sk-|bld_|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw)) return { ok: false, reason: 'unsafe_input' };
      if (reserved >= maxCalls) return { ok: false, reason: 'budget' };
      reserved++;
      const started = performance.now();
      const receipt: Receipt = { requestedModel: SELECTOR_MODEL, model: null, promptFingerprint: hash(instructions), inputFingerprint: hash(inputs),
        ok: false, attempts: 0, latencyMs: 0, costUsd: null, inputTokens: null, outputTokens: null, status: null, finish: null };
      const observe: Fetcher = async (url, init) => {
        if (String(url) !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('Unexpected selector endpoint.');
        receipt.attempts++;
        const response = await fetcher(url, { ...init, redirect: 'error' });
        receipt.status = response.status;
        // Retain billing even if the SDK later rejects JSON/schema/truncation.
        // Never retain body, headers, reasoning or provider exception text.
        try {
          const body = await response.clone().json() as { model?: string; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number }; choices?: { finish_reason?: string }[] };
          receipt.costUsd = number(body.usage?.cost);
          receipt.inputTokens = number(body.usage?.prompt_tokens);
          receipt.outputTokens = number(body.usage?.completion_tokens);
          const finish = body.choices?.[0]?.finish_reason;
          receipt.finish = finish ? ['stop', 'length', 'content_filter', 'tool_calls'].includes(finish) ? finish : 'other' : null;
          if (typeof body.model === 'string' && /^deepseek\/[A-Za-z0-9._-]{1,90}$/.test(body.model)) receipt.model = body.model;
        } catch { /* Unknown billing remains explicit. */ }
        return response;
      };
      try {
        const selectorSchema = z.object({ rows: z.array(z.object({ id: z.enum(inputs.map(r => r.id) as [string, ...string[]]),
          disposition: z.enum(['review', 'leave', 'need_context']), patterns: z.array(z.enum(patterns)).max(3),
        }).strict()).length(rows.length) }).strict();
        const model = createOpenRouter({ apiKey, fetch: observe as typeof fetch, appName: 'buildd-local-policy' }).chat(SELECTOR_MODEL, {
          usage: { include: true }, reasoning: { effort: 'none', exclude: true },
          extraBody: { provider: { require_parameters: true, allow_fallbacks: false } },
        });
        const schema = author ? authorSchema : selectorSchema;
        const result = await generateText({ model, output: Output.object({ schema }), maxRetries: 0, temperature: 0,
          maxOutputTokens: 6000, abortSignal: AbortSignal.timeout(20000), system: instructions.instructions, prompt: raw });
        const returned = result.response.modelId;
        if (returned && returned !== SELECTOR_MODEL && !returned.startsWith(`${SELECTOR_MODEL}-`)) throw new Error('Unexpected returned model.');
        if (result.finishReason !== 'stop') throw new Error('Incomplete selector output.');
        if (author) {
          const authored = authorSchema.parse(result.output);
          if (redactSecrets(canonicalJson(authored), [apiKey]) !== canonicalJson(authored)) throw new Error('Sensitive prompt.');
          receipt.ok = true;
          return { ok: true, prompts: authored };
        }
        const selected = selectorSchema.parse(result.output).rows;
        if (new Set(selected.map(r => r.id)).size !== rows.length || selected.some(r => new Set(r.patterns).size !== r.patterns.length
          || (r.disposition === 'review') !== (r.patterns.length > 0))) throw new Error('Invalid selector coverage.');
        receipt.ok = true;
        return { ok: true, rows: selected.map(r => ({ ...r, id: rows[Number(r.id.slice(2))].id })) };
      } catch {
        return { ok: false, reason: 'provider_or_schema' };
      } finally {
        receipt.latencyMs = Math.round(performance.now() - started);
        calls.push(receipt);
      }
    }
  return { calls, select: (rows: ExperimentRow[]) => run(rows, false) as Promise<Outcome>,
    author: (training: ExperimentRow[]) => run(training, true) as Promise<AuthorOutcome> };
}
