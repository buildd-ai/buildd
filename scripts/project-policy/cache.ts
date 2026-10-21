import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, JEV_MODEL } from '../../packages/ai-kit/src/decide';
import { buildSemanticState, semanticDecision, type SemanticEvaluation, type SemanticEvaluator } from './semantic';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const labels = new Set(['useful', 'redundant', 'unclear', 'uncertain']);
interface RecordEntry { schema: 1; key: string; recordedAt: number; result: SemanticEvaluation }

/** Local Jev memoization, not an evidence ledger. Only successful typed answers are reusable. */
export function cachedJevEvaluator(evaluate: SemanticEvaluator, options: {
  directory: string; namespace: string; ttlMs?: number; now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 24 * 60 * 60 * 1000;
  if (!options.namespace || !Number.isFinite(ttl) || ttl <= 0) throw new Error('Cache requires a namespace and positive TTL.');
  const stats = { hits: 0, misses: 0, writes: 0, errors: 0 };
  const inFlight = new Map<string, Promise<SemanticEvaluation>>();
  const wrapped: SemanticEvaluator = async (subject, policy, context) => {
    const definition = semanticDecision(policy);
    const key = digest({ schema: 'copy-context-1', namespace: options.namespace, provider: 'openrouter', endpoint: 'systemone',
      model: JEV_MODEL, version: definition.version, prompt: definition.fingerprint, policy,
      state: buildSemanticState(subject, context) });
    const path = join(options.directory, `${key}.json`);
    const replay = (entry: RecordEntry): SemanticEvaluation => {
      stats.hits++;
      return { ...entry.result, attempts: 0, latencyMs: 0, costUsd: 0,
        cache: { hit: true, recordedAt: entry.recordedAt,
          historical: { attempts: entry.result.attempts, latencyMs: entry.result.latencyMs, costUsd: entry.result.costUsd } } };
    };
    try {
      const entry = JSON.parse(readFileSync(path, 'utf8')) as RecordEntry;
      const r = entry.result;
      if (entry.schema === 1 && entry.key === key && Number.isFinite(entry.recordedAt)
        && now() >= entry.recordedAt && now() - entry.recordedAt < ttl && r && labels.has(r.label)
        && r.version === definition.version && r.promptFingerprint === definition.fingerprint
        && typeof r.inputFingerprint === 'string' && typeof r.reasonCode === 'string'
        && typeof r.model === 'string' && (r.model === JEV_MODEL || r.model.startsWith(`${JEV_MODEL}-`))
        && (r.confidence === null || Number.isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 1)
        && Number.isInteger(r.attempts) && r.attempts > 0 && Number.isFinite(r.latencyMs) && r.latencyMs >= 0
        && (r.costUsd === null || Number.isFinite(r.costUsd) && r.costUsd >= 0)) return replay(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stats.errors++;
    }
    const pending = inFlight.get(key);
    if (pending) {
      const result = await pending;
      return labels.has(result.label) ? replay({ schema: 1, key, recordedAt: now(), result })
        : { ...result, attempts: 0, latencyMs: 0, costUsd: 0, coalesced: true };
    }
    stats.misses++;
    const run = (async () => {
      const result = await evaluate(subject, policy, context);
      if (labels.has(result.label) && result.attempts > 0) {
        try {
          mkdirSync(options.directory, { recursive: true });
          const temporary = join(options.directory, `${key}.${randomUUID()}.tmp`);
          writeFileSync(temporary, JSON.stringify({ schema: 1, key, recordedAt: now(), result }), { mode: 0o600 });
          renameSync(temporary, path);
          stats.writes++;
        } catch { stats.errors++; }
      }
      return result;
    })();
    inFlight.set(key, run);
    try { return await run; } finally { inFlight.delete(key); }
  };
  return { evaluate: wrapped, stats };
}
