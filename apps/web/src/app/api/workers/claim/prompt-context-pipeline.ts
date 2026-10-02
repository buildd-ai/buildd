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
import { loadTaskAreaConfig, type TaskAreaPrediction } from '@buildd/core/task-area-prediction-source';
import { assignTaskAreaArm, TASK_AREA_TREATMENT_ARM } from '@buildd/core/task-area-prediction';
import {
  appendContextBlock,
  attachDiscrepancyContext,
  attachKnowledgeContext,
  attachSubjectPriorWork,
  predictTaskAreas,
  type ContextBlockSink,
} from './context-injection';
import { attachMissionHandoff } from './mission-handoff-injection';
import type { LinkedDocsAccount } from '@/lib/linked-knowledge';

type ClaimedTask = { id: string; title: string; workspaceId: string; missionId?: string | null };

type Worker = ClaimTasksResponse['workers'][number];

function bufferingSink(buffer: Map<Worker, string>): ContextBlockSink {
  return (cw, block) => buffer.set(cw, block);
}

/**
 * Whether ANY of these tasks could actually use the neighbour-area hint.
 *
 * Arm assignment is a pure hash draw over the task id (`assignTaskAreaArm`) —
 * it needs no DB and no neighbour lookup, so it can be known well before
 * `predictTaskAreas`' full Voyage+Neon round trip resolves. A control-arm
 * task's `taskAreaHint` is null regardless of what the prediction turns out to
 * be (see context-injection.ts's `taskAreaHint`), so when every claimed task
 * draws control (or the experiment is off), `attachKnowledgeContext` has no
 * real dependency on the predictions and gains nothing from waiting for them.
 *
 * Best-effort: on any failure to resolve config, default to `true` (today's
 * behaviour — wait for predictions) rather than assume the answer.
 */
async function anyTaskNeedsAreaHint(claimedTasks: readonly ClaimedTask[]): Promise<boolean> {
  if (claimedTasks.length === 0) return false;
  try {
    const config = await loadTaskAreaConfig();
    if (!config.enabled) return false;
    return claimedTasks.some(t => assignTaskAreaArm(t.id, config).arm === TASK_AREA_TREATMENT_ARM);
  } catch {
    return true;
  }
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
  account?: LinkedDocsAccount | null,
): Promise<ReadonlyMap<string, TaskAreaPrediction>> {
  const handoffExcludedSources = new Set<string>();
  const missionHandoffBuffer = new Map<Worker, string>();
  const knowledgeBuffer = new Map<Worker, string>();
  const subjectPriorWorkBuffer = new Map<Worker, string>();
  const discrepancyBuffer = new Map<Worker, string>();

  // predictTaskAreas previously received the full over-fetched candidate pool
  // (`claimedTasks` here is `filteredTasks` from route.ts) and predicted every
  // candidate, not just the task(s) actually handed out. A deep queue's claim
  // can over-fetch a couple dozen candidates while claiming one task, so this
  // filter is the difference between a dozen predictions and one.
  const claimedTaskIds = new Set(claimedWorkers.map(w => w.taskId));
  const tasksToPredict = claimedTasks.filter(t => claimedTaskIds.has(t.id));

  const predictionsPromise = predictTaskAreas(tasksToPredict);
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
  const needsAreaHintPromise = anyTaskNeedsAreaHint(tasksToPredict);

  // attachKnowledgeContext's one unconditional real dependency: it reads what
  // mission handoff excluded. Predictions are the other candidate dependency,
  // but only when a claimed task could actually use the hint — see
  // anyTaskNeedsAreaHint.
  const [, needsAreaHint] = await Promise.all([missionHandoffPromise, needsAreaHintPromise]);

  let predictions: ReadonlyMap<string, TaskAreaPrediction>;
  if (needsAreaHint) {
    predictions = await predictionsPromise;
    await attachKnowledgeContext(
      claimedWorkers as ClaimTasksResponse['workers'],
      claimedTasks,
      predictions,
      handoffExcludedSources,
      bufferingSink(knowledgeBuffer),
      account,
    );
  } else {
    await attachKnowledgeContext(
      claimedWorkers as ClaimTasksResponse['workers'],
      claimedTasks,
      new Map(),
      handoffExcludedSources,
      bufferingSink(knowledgeBuffer),
      account,
    );
    predictions = await predictionsPromise;
  }
  await Promise.all([subjectPriorWorkPromise, discrepancyPromise]);

  flush(claimedWorkers, missionHandoffBuffer);
  flush(claimedWorkers, knowledgeBuffer);
  flush(claimedWorkers, subjectPriorWorkBuffer);
  flush(claimedWorkers, discrepancyBuffer);

  return predictions;
}
