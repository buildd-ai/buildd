/**
 * The re-embed driver (docs/specs/local-runner-provider.md §5.3 D-3, D-6).
 *
 * A namespace is marked `pending` when the model or size its team embeds with
 * changes: by the pick route for every namespace of the team at once
 * (`requestReembedForTeam`), and by the first ingest or query that touches a
 * namespace still in the old space (`resolveNamespaceSpace`). This walks those
 * namespaces from the maintenance cron: a few bounded batches each, inside one
 * time budget, so it never starves live work. It is resumable by construction
 * (`PgVectorStore.reembedNamespace` only reads rows not yet in the space).
 *
 * For a `local_runner` pick each batch is a relay job on the `reembed`
 * surface, which the claim order puts behind chat and live queries, and waits
 * no longer than the tick allows. With the runner offline the batch is
 * `denied` in one read and the namespace waits for the next tick; rows not
 * yet re-embedded stay reachable by text. No other provider is ever used.
 */
import { db } from '@buildd/core/db';
import type { SQL } from 'drizzle-orm';
import { PgVectorStore, getVoyageEmbedder, listNamespacesToReembed, REEMBED_CALLER, type NamespaceSpace } from '@buildd/core/knowledge-store';
import { resolveEmbeddingConfig } from '@buildd/core/knowledge-store/embedding-config';

/** How long one tick may spend re-embedding. */
export const REEMBED_TICK_BUDGET_MS = 25_000;
/** How long one relay batch may wait inside a tick. */
export const REEMBED_BATCH_DEADLINE_MS = 20_000;
const DEFAULT_MAX_NAMESPACES = 10;
const DEFAULT_BATCHES_PER_NAMESPACE = 4;
const DEFAULT_BATCH_SIZE = 16;

export interface ReembedTickResult {
  namespaces: number;
  processed: number;
  done: number;
  denied: number;
  failed: number;
}

type ReembedStep = Awaited<ReturnType<PgVectorStore['reembedNamespace']>>;

export interface ReembedTickDeps {
  list?: (limit: number) => Promise<NamespaceSpace[]>;
  reembed?: (namespace: string, batchSize: number) => Promise<ReembedStep>;
  now?: () => number;
}

let store: PgVectorStore | null = null;
function reembedStore(): PgVectorStore {
  // Attributed as `reembed`, which is also what queues its relay jobs behind
  // live work. A relay batch waits no longer than the tick can.
  store ??= new PgVectorStore(getVoyageEmbedder(), null, {
    caller: REEMBED_CALLER,
    embeddingConfig: async (ownerId) => {
      const cfg = await resolveEmbeddingConfig(ownerId);
      return cfg.localRunner ? { ...cfg, localRunner: { ...cfg.localRunner, deadlineMs: REEMBED_BATCH_DEADLINE_MS } } : cfg;
    },
  });
  return store;
}

/** One tick. Never throws: a failure is counted and logged. */
export async function runReembedTick(
  opts: { maxNamespaces?: number; batchesPerNamespace?: number; batchSize?: number; budgetMs?: number } = {},
  deps: ReembedTickDeps = {},
): Promise<ReembedTickResult> {
  const out: ReembedTickResult = { namespaces: 0, processed: 0, done: 0, denied: 0, failed: 0 };
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budgetMs = opts.budgetMs ?? REEMBED_TICK_BUDGET_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const list = deps.list ?? ((limit: number) => listNamespacesToReembed((q: SQL) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>, limit));
  const reembed = deps.reembed ?? ((namespace: string, size: number) => reembedStore().reembedNamespace(namespace, { batchSize: size }));

  let pending: NamespaceSpace[];
  try {
    pending = await list(opts.maxNamespaces ?? DEFAULT_MAX_NAMESPACES);
  } catch (err) {
    console.error('[reembed] listing namespaces failed:', err instanceof Error ? err.message : err);
    return out;
  }

  for (const space of pending) {
    if (now() - startedAt >= budgetMs) break;
    out.namespaces++;
    try {
      for (let i = 0; i < (opts.batchesPerNamespace ?? DEFAULT_BATCHES_PER_NAMESPACE); i++) {
        const step = await reembed(space.namespace, batchSize);
        out.processed += step.processed;
        if (step.status === 'done') { out.done++; break; }
        if (step.status === 'denied' || step.status === 'skipped') { out.denied++; break; }
        if (now() - startedAt >= budgetMs) break;
      }
    } catch (err) {
      out.failed++;
      console.error(`[reembed] ${space.namespace} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
