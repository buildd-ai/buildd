/**
 * Concurrency for the dependency-bearing half of prompt-context injection.
 *
 * route.ts used to `await` predictTaskAreas, attachMissionHandoff,
 * attachKnowledgeContext, attachSubjectPriorWork and attachDiscrepancyContext
 * one after another. Every claim that hands out a task paid for all of that
 * sequentially, even though only one real data dependency exists between them:
 * attachKnowledgeContext reads the task-area predictions and the
 * `handoffExcludedSources` set attachMissionHandoff populates (to avoid
 * duplicating a source the handoff block already rendered). Neither
 * attachSubjectPriorWork nor attachDiscrepancyContext reads anything the
 * others produce.
 *
 * So: predictTaskAreas, attachMissionHandoff, attachSubjectPriorWork and
 * attachDiscrepancyContext all start together. attachKnowledgeContext starts
 * only once predictions + handoff have resolved (the real dependency), but
 * still overlaps with subjectPriorWork/discrepancy, which were already in
 * flight.
 *
 * ORDER MATTERS for the rendered blocks (see context-injection.ts's header) —
 * mission handoff, then knowledge, then subject-prior-work, then discrepancy —
 * and that order must NOT depend on which computation happens to resolve
 * first. So each stage is called with a buffering sink instead of the default
 * appendContextBlock; nothing lands on resolvedContextProviders until every
 * stage's block has been computed, at which point they are flushed onto the
 * rail in the fixed order in one synchronous pass.
 */
import type { ClaimTasksResponse } from '@buildd/shared';
import type { TaskAreaPrediction } from '@buildd/core/task-area-prediction-source';
import {
  appendContextBlock,
  attachDiscrepancyContext,
  attachKnowledgeContext,
  attachSubjectPriorWork,
  predictTaskAreas,
  type ContextBlockSink,
} from './context-injection';
import { attachMissionHandoff } from './mission-handoff-injection';

type ClaimedTask = { id: string; title: string; workspaceId: string; missionId?: string | null };

type Worker = ClaimTasksResponse['workers'][number];

function bufferingSink(buffer: Map<Worker, string>): ContextBlockSink {
  return (cw, block) => buffer.set(cw, block);
}

function flush(claimedWorkers: readonly Worker[], buffer: Map<Worker, string>): void {
  for (const cw of claimedWorkers) {
    const block = buffer.get(cw);
    if (block) appendContextBlock(cw, block);
  }
}

/**
 * Run the four dependency-bearing injections concurrently and flush their
 * blocks onto resolvedContextProviders in the fixed contract order. Returns
 * the task-area predictions so the caller can pass them on to
 * attachTaskAreaScope, which appends last and is unaffected by this change.
 */
export async function runDependentContextInjections(
  claimedWorkers: readonly Worker[],
  claimedTasks: readonly ClaimedTask[],
): Promise<ReadonlyMap<string, TaskAreaPrediction>> {
  const handoffExcludedSources = new Set<string>();
  const missionHandoffBuffer = new Map<Worker, string>();
  const knowledgeBuffer = new Map<Worker, string>();
  const subjectPriorWorkBuffer = new Map<Worker, string>();
  const discrepancyBuffer = new Map<Worker, string>();

  const predictionsPromise = predictTaskAreas(claimedTasks);
  const missionHandoffPromise = attachMissionHandoff(
    claimedWorkers as ClaimTasksResponse['workers'],
    claimedTasks,
    handoffExcludedSources,
    bufferingSink(missionHandoffBuffer),
  );
  const subjectPriorWorkPromise = attachSubjectPriorWork(
    claimedWorkers as ClaimTasksResponse['workers'],
    claimedTasks,
    bufferingSink(subjectPriorWorkBuffer),
  );
  const discrepancyPromise = attachDiscrepancyContext(
    claimedWorkers as ClaimTasksResponse['workers'],
    claimedTasks,
    bufferingSink(discrepancyBuffer),
  );

  // attachKnowledgeContext's only real dependencies: it must wait for these two.
  const [predictions] = await Promise.all([predictionsPromise, missionHandoffPromise]);
  await attachKnowledgeContext(
    claimedWorkers as ClaimTasksResponse['workers'],
    claimedTasks,
    predictions,
    handoffExcludedSources,
    bufferingSink(knowledgeBuffer),
  );
  await Promise.all([subjectPriorWorkPromise, discrepancyPromise]);

  flush(claimedWorkers, missionHandoffBuffer);
  flush(claimedWorkers, knowledgeBuffer);
  flush(claimedWorkers, subjectPriorWorkBuffer);
  flush(claimedWorkers, discrepancyBuffer);

  return predictions;
}
