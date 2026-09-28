/**
 * Which models may serve a chat turn.
 *
 * A chat turn needs a model that calls tools and answers in text. A model that
 * can't do both streams something (often only reasoning) and ends with no tool
 * call and no answer, and the person sees an empty turn. So pool challengers
 * and chat-surface registry picks are checked here before they are served, and
 * the incumbent (or the tier default) is served instead.
 *
 * The evidence, in order:
 * 1. `CHAT_TOOLS_UNRELIABLE`: models that LIST `tools` on OpenRouter but, served
 *    through the AI SDK tool protocol, did not call them in chat. The catalog
 *    can't catch these, so they are named here, each with what was seen.
 * 2. Anthropic and OpenAI native routes: their chat models all call tools.
 * 3. OpenRouter: the model must be in the normalized catalog, which keeps only
 *    models whose `supported_parameters` include `tools` and whose output
 *    modalities include text (`normalizeCatalog`).
 * 4. No catalog (fetch failed, cold cache): allowed, as today. Blocking every
 *    OpenRouter pick because a public list was unreachable would break chat
 *    for a reason the person can't fix; (1) still applies.
 *
 * Pure: the caller passes the catalog.
 */

import type { CatalogEntry } from './model-catalog';

export const CHAT_TOOLS_UNRELIABLE: ReadonlyArray<{ pattern: RegExp; seen: string }> = [
  {
    pattern: /^aion-labs\//i,
    seen: 'lists tools on OpenRouter; as a chat pool challenger it streamed only reasoning, with no tool call and no answer',
  },
];

export type ChatModelVerdict =
  | { ok: true; basis: 'vendor' | 'catalog' | 'no_catalog' }
  | { ok: false; reason: 'tools_unreliable' | 'no_tool_calling' };

/** `vendor/model:variant` → `vendor/model` (the catalog drops `:free`, `:nitro`, ... variants). */
function baseSlug(model: string): string {
  const i = model.indexOf(':');
  return (i >= 0 ? model.slice(0, i) : model).toLowerCase();
}

/**
 * May `model`, called on `route`, serve a chat turn?
 * `route` is the provider the call goes to: `anthropic`, `openai`,
 * `openrouter` (a pool arm's route, or a plan's provider).
 */
export function chatModelVerdict(route: string, model: string, catalog: readonly CatalogEntry[]): ChatModelVerdict {
  const slug = baseSlug(model);
  if (CHAT_TOOLS_UNRELIABLE.some(u => u.pattern.test(slug))) return { ok: false, reason: 'tools_unreliable' };
  if (route === 'anthropic' || route === 'openai') return { ok: true, basis: 'vendor' };
  if (catalog.length === 0) return { ok: true, basis: 'no_catalog' };
  const listed = catalog.some(e => e.openRouterId.toLowerCase() === slug || e.permaslug?.toLowerCase() === slug);
  return listed ? { ok: true, basis: 'catalog' } : { ok: false, reason: 'no_tool_calling' };
}
