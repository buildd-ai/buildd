/**
 * Run a function with a different set of active prompts, for that call tree
 * only.
 *
 * The prompt eval scores text the deployment may not run yet (a push to the
 * prompts repo, before the deploy seed takes it). `installPrompts` would swap
 * the text for every live call in the process; this scopes it with
 * AsyncLocalStorage instead, so a request served while an eval runs still
 * resolves the deployment's own rows. Inside the scope the overlay REPLACES the
 * shared snapshot: an id the overlay does not carry resolves to its public
 * default, exactly as it would in a deployment seeded from that text.
 *
 * Server-only (node:async_hooks). `prompts.ts` stays pure: it only calls the
 * provider this module installs on first use.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { setPromptOverlayProvider, type ActivePrompt, type PromptSnapshot } from './prompts';

const scope = new AsyncLocalStorage<PromptSnapshot>();
let installed = false;

export function withPromptOverlay<T>(rows: Iterable<ActivePrompt>, fn: () => Promise<T>): Promise<T> {
  if (!installed) {
    setPromptOverlayProvider(() => scope.getStore() ?? null);
    installed = true;
  }
  const map = new Map<string, ActivePrompt>();
  for (const r of rows) map.set(r.id, r);
  return scope.run(map, fn);
}
