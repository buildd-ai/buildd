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
  costBasis?: LocalWorker['costBasis'];
  actualModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  claudeLoginUsed?: ClaudeLoginUsed;
  claudeLoginId?: string;
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
    // How the usage was charged; the server records `unknown` when absent.
    ...(worker.costBasis ? { costBasis: worker.costBasis } : {}),
    ...(tally && typeof tally.inputTokens === 'number' ? { inputTokens: tally.inputTokens } : {}),
    ...(tally && typeof tally.outputTokens === 'number' ? { outputTokens: tally.outputTokens } : {}),
    // Which Claude login the run used: the server walls only this runner when
    // it was the machine's own (spec "A runner", R-3, R-9).
    ...(worker.claudeLoginUsed ? { claudeLoginUsed: worker.claudeLoginUsed } : {}),
    // Which login that was (host-seat.ts claudeLoginIdentity, a one-way
    // hash), so the wall holds every runner on it, not only this one.
    ...(worker.claudeLoginId ? { claudeLoginId: worker.claudeLoginId } : {}),
  };
}

/** Which Claude login a run used, as the server's seat-wall decision reads it. */
export type ClaudeLoginUsed = 'machine_login' | 'machine_token' | 'stored';

/**
 * The Claude login a run used, from the agent env the runner built for it.
 * Undefined when the run used no subscription login at all (Codex, a cloud
 * run, an API key, an endpoint): those walls are scoped by other rules.
 */
export function claudeLoginUsed(input: {
  isCodexTask: boolean;
  cloud: boolean;
  machineLoginUsed?: boolean;
  machineLogin: 'env' | 'login' | null;
  injected: readonly string[];
  claudeCredentialUsed: boolean;
}): ClaudeLoginUsed | undefined {
  if (input.isCodexTask || input.cloud) return undefined;
  if (input.machineLoginUsed && input.machineLogin) return input.machineLogin === 'env' ? 'machine_token' : 'machine_login';
  if (input.injected.includes('serverOauthToken') || input.claudeCredentialUsed) return 'stored';
  return undefined;
}
