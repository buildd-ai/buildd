import type { LocalWorker } from './types';
import { resolveActualModel } from './prompt-builder';

/**
 * Cost + model attribution for a terminal worker update.
 *
 * `costUsd` is only sent when the backend reported real spend: a 0 would be
 * indistinguishable from "this session was free" and would suppress the
 * server's token-derived estimate (the seat/OAuth path, where the SDK always
 * reports $0). `actualModel` is always sent when known so
 * task_outcomes.actual_model stops being NULL.
 *
 * Pure and dependency-free (no `this`) so both a live session's own terminal
 * PATCH (`WorkerManager`, apps/runner/src/workers.ts) and a startup
 * reconciliation for a session whose process already died
 * (`WorkerSync.restoreWorkersFromDisk`, apps/runner/src/worker-sync.ts) build
 * the identical payload shape from whatever the local worker record still
 * holds — a crashed session's last known numbers, not a fresh measurement.
 */
export function buildTerminalAttributionPayload(worker: LocalWorker): {
  costUsd?: number;
  actualModel?: string;
  inputTokens?: number;
  outputTokens?: number;
} {
  const meta = worker.resultMeta;
  const reportedCost = meta?.totalCostUsd;
  const actualModel = meta?.actualModel
    || resolveActualModel({
      modelUsage: meta?.modelUsage ?? null,
      reportedModel: worker.reportedModel ?? null,
      requestedModel: worker.sessionModel ?? null,
    });
  const tally = worker.tokenTally;
  return {
    ...(typeof reportedCost === 'number' && reportedCost > 0 ? { costUsd: reportedCost } : {}),
    ...(actualModel ? { actualModel } : {}),
    ...(tally && typeof tally.inputTokens === 'number' ? { inputTokens: tally.inputTokens } : {}),
    ...(tally && typeof tally.outputTokens === 'number' ? { outputTokens: tally.outputTokens } : {}),
  };
}
