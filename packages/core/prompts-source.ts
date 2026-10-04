/**
 * Server-side loader for versioned prompts (format and semantics: `prompts.ts`).
 *
 * Reads every active row of the `prompts` table at most once per
 * `PROMPTS_TTL_MS` per process and installs them as the in-process snapshot.
 * A failed read (no database, no table yet) keeps whatever was installed
 * before, which on a cold process is nothing: every prompt resolves to its
 * public default. A row whose `content_hash` is not the sha256 of its body is
 * skipped, so a half-written seed cannot become the text in effect.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './db/client';
import { prompts } from './db/schema';
import { createSnapshotLoader, type LoadOptions } from './runtime-snapshot';
import { promptsSnapshot, setPromptFallbackListener, type ActivePrompt, type PromptFallbackReason, type PromptSnapshot } from './prompts';

export const PROMPTS_TTL_MS = 60_000;

export function promptContentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

async function readActiveRows(): Promise<unknown> {
  const rows = await db
    .select({ id: prompts.id, version: prompts.version, contentHash: prompts.contentHash, body: prompts.body })
    .from(prompts)
    .where(eq(prompts.active, true));
  return rows.length > 0 ? rows : null;
}

/** Validate raw rows. Never throws; a row that does not fit is skipped with a log line naming its id. */
export function parsePromptRows(raw: unknown, log: (m: string) => void = m => console.warn(`[prompts] ${m}`)): PromptSnapshot {
  if (!Array.isArray(raw)) return new Map();
  const out: ActivePrompt[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const id = typeof r?.id === 'string' ? r.id : null;
    if (!id) {
      log('row without an id skipped');
      continue;
    }
    if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) {
      log(`row "${id}" has no positive integer version; skipped`);
      continue;
    }
    if (typeof r.body !== 'string' || r.body.trim() === '') {
      log(`row "${id}" v${r.version} has an empty body; skipped`);
      continue;
    }
    if (typeof r.contentHash !== 'string' || r.contentHash !== promptContentHash(r.body)) {
      log(`row "${id}" v${r.version} content_hash does not match its body; skipped`);
      continue;
    }
    out.push({ id, version: r.version, contentHash: r.contentHash, body: r.body });
  }
  return new Map(out.map(row => [row.id, row]));
}

const loader = createSnapshotLoader<PromptSnapshot>({
  name: 'prompts',
  ttlMs: PROMPTS_TTL_MS,
  snapshot: promptsSnapshot,
  read: readActiveRows,
  parse: raw => parsePromptRows(raw),
  missingMessage: 'no active prompt rows; every prompt uses its public default',
});

/** Load (or reuse, within the TTL) the active rows and install them. Never throws. */
export function loadPrompts(opts: LoadOptions = {}): Promise<PromptSnapshot> {
  return loader.load(opts);
}

/** Forget the TTL and the missing-record log state. For tests. */
export function resetPromptsLoader(): void {
  loader.reset();
}

/**
 * The production fallback log: once per id and reason per process, and only
 * when this deployment carries its own rows (the snapshot is non-empty), so a
 * deployment that runs on public defaults by design stays quiet. Names the id,
 * never text. The cross-process alert is the release health check's
 * (`apps/web/src/lib/prompt-fallback-alert.ts`).
 */
export function productionFallbackLogger(
  env: Record<string, string | undefined> = process.env,
  log: (m: string) => void = m => console.warn(m),
): (id: string, reason: PromptFallbackReason) => void {
  const logged = new Set<string>();
  return (id, reason) => {
    if (env.VERCEL_ENV !== 'production' || promptsSnapshot.peek().size === 0) return;
    const key = `${id}:${reason}`;
    if (logged.has(key)) return;
    logged.add(key);
    log(`[prompts] "${id}" resolved to its public default (${reason}) in production`);
  };
}

/** Load now and keep resolves fresh from here on. Once per server process, from instrumentation.ts. */
export function startPrompts(): Promise<void> {
  setPromptFallbackListener(productionFallbackLogger());
  return loader.start();
}
