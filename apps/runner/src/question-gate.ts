/**
 * AskUserQuestion: the question brief and the question gate, runner side.
 *
 * Brief (always on): the runner turns the tool input into a `waitingFor` that
 * carries the brief fields (packages/core/question-brief.ts) plus the facts it
 * already has: task title, branch, last edited file. Deterministic; nothing
 * the agent did not write is invented.
 *
 * Gate (only with a claim-time `questionGate` marker, i.e. the runner sent the
 * `question_gate` feature): before the question is parked, the server runs
 * the brief check and, once that passes, decide/hold/ask
 * (packages/core/question-gate.ts). Three outcomes reach the runner:
 *  - `pushback` — the brief needs work; the reason becomes the AskUserQuestion
 *    tool result and the agent asks again, up to `maxPushbacks` per worker.
 *  - `decide` — Jev picked an option; the answer becomes the AskUserQuestion
 *    tool result and the agent continues — this does NOT count against the
 *    pushback cap, it is a final answer, not a request to rewrite.
 *  - `send` — park as `waiting_input`, same as always, tagged with the gate's
 *    disposition (`gateTagged`): a `hold` parks without a notification until
 *    its deadline (apps/web/src/lib/question-hold.ts); an `ask` is what admits
 *    it to Needs You (packages/core/needs-you-admission.ts).
 * Any failure sends the question unchanged.
 */
import { deriveQuestionBrief } from '@buildd/core/question-brief';
import { QUESTION_GATE_RUNNER_TIMEOUT_MS, type QuestionGateReply } from '@buildd/core/question-gate';
import type { LocalWorker, WaitingFor } from './types';

type ToolQuestion = { question?: unknown; header?: unknown; options?: Array<{ label?: unknown; description?: unknown }> };

function firstQuestion(input: unknown): ToolQuestion | undefined {
  const qs = (input as { questions?: unknown } | null | undefined)?.questions;
  return Array.isArray(qs) ? (qs[0] as ToolQuestion | undefined) : undefined;
}

/** A tool path relative to the worker's worktree, for the brief's `where.file`. */
export function worktreeRelative(path: string, worktreePath?: string): string {
  if (worktreePath) {
    const root = worktreePath.endsWith('/') ? worktreePath : `${worktreePath}/`;
    if (path.startsWith(root)) return path.slice(root.length);
  }
  return path;
}

/** The header the agent gave its first question, for the worker's current action. */
export function questionHeader(input: unknown): string | undefined {
  const h = firstQuestion(input)?.header;
  return typeof h === 'string' && h.trim() ? h : undefined;
}

/**
 * The parked question for an AskUserQuestion tool input, with its brief.
 * The prompt stays the agent's full text when it has no framing to split off.
 */
export function questionFromToolInput(
  worker: Pick<LocalWorker, 'taskTitle' | 'branch' | 'lastEditedFile'>,
  input: unknown,
  toolUseId?: string,
): WaitingFor {
  const q = firstQuestion(input);
  const text = typeof q?.question === 'string' && q.question.trim() ? q.question : 'Awaiting input';
  const options = Array.isArray(q?.options)
    ? q!.options
        .filter(o => o && typeof o.label === 'string')
        .map(o => ({ label: o.label as string, ...(typeof o.description === 'string' ? { description: o.description } : {}) }))
    : undefined;
  const brief = deriveQuestionBrief(
    { question: text, options },
    { taskTitle: worker.taskTitle, branch: worker.branch, file: worker.lastEditedFile },
  );
  return {
    type: 'question',
    prompt: brief.prompt,
    ...(options ? { options: brief.options } : {}),
    ...(brief.context ? { context: brief.context } : {}),
    ...(brief.recommended ? { recommended: brief.recommended } : {}),
    ...(brief.where ? { where: brief.where } : {}),
    ...(toolUseId ? { toolUseId } : {}),
  };
}

/** The `waitingFor` the server stores: the question and its brief, no runner-only fields. */
export function questionPayload(w: WaitingFor): Record<string, unknown> {
  return {
    type: w.type,
    prompt: w.prompt,
    ...(w.options ? { options: w.options } : {}),
    ...(w.context ? { context: w.context } : {}),
    ...(w.recommended ? { recommended: w.recommended } : {}),
    ...(w.where ? { where: w.where } : {}),
    ...(w.disposition ? { disposition: w.disposition } : {}),
    ...(w.gateOutcome ? { gateOutcome: w.gateOutcome } : {}),
    ...(w.rail ? { rail: w.rail } : {}),
    ...(w.repairTaskId ? { repairTaskId: w.repairTaskId } : {}),
    ...(w.holdReason ? { holdReason: w.holdReason } : {}),
    ...(w.resurfaceAt ? { resurfaceAt: w.resurfaceAt } : {}),
  };
}

export type GateResult =
  | { action: 'send'; reply: QuestionGateReply | null }
  | { action: 'pushback'; reason: string; reply: QuestionGateReply }
  | { action: 'answer'; reason: string; reply: QuestionGateReply };

export interface QuestionChecker {
  checkQuestion(
    workerId: string,
    body: { question: Record<string, unknown>; priorPushbacks: number },
    timeoutMs: number,
  ): Promise<QuestionGateReply>;
}

/**
 * The parked question, tagged with the gate's human-attention disposition so
 * the server admits it to Needs You as the gate said (apps/web/src/lib/park-disposition.ts):
 * `hold` with its fields, `recovered` with its repair task, otherwise `ask`
 * with the gate's outcome and rail. No reply (no gate, or the call failed):
 * untagged, and the server re-checks it itself.
 */
export function gateTagged(question: WaitingFor, reply?: QuestionGateReply | null): WaitingFor {
  if (!reply) return question;
  if (reply.disposition === 'hold') {
    return {
      ...question,
      disposition: 'hold',
      ...(reply.holdReason ? { holdReason: reply.holdReason } : {}),
      ...(reply.resurfaceAt ? { resurfaceAt: reply.resurfaceAt } : {}),
    };
  }
  if (reply.outcome === 'recovered' && reply.repairTaskId) {
    return { ...question, disposition: 'recovered', gateOutcome: reply.outcome, repairTaskId: reply.repairTaskId };
  }
  return {
    ...question,
    disposition: 'ask',
    gateOutcome: reply.outcome,
    ...(reply.rail ? { rail: reply.rail } : {}),
  };
}

/**
 * Ask the server what should happen to this question. Three outcomes:
 *  - `pushback`: this worker still has pushbacks left — the agent rewrites.
 *  - `answer`: Jev decided — the agent continues with the answer, no park,
 *    no pushback counted (it is not a rewrite request).
 *  - `send`: park it (brief-check cap spent, a hold, an ask, a hard rail, or
 *    any failure) — the server enforces the pushback cap too; this keeps it
 *    even against a server that does not.
 * Never throws.
 */
export async function runQuestionGate(worker: LocalWorker, question: WaitingFor, client: QuestionChecker): Promise<GateResult> {
  const gate = worker.questionGate;
  if (!gate) return { action: 'send', reply: null };
  const prior = worker.questionPushbacks ?? 0;
  let reply: QuestionGateReply;
  try {
    reply = await client.checkQuestion(worker.id, { question: questionPayload(question), priorPushbacks: prior }, QUESTION_GATE_RUNNER_TIMEOUT_MS);
  } catch {
    return { action: 'send', reply: null };
  }
  console.log(`[Worker ${worker.id}] Question gate: ${reply.verdict} (${reply.outcome}${reply.error ? `: ${reply.error}` : ''}, pushbacks ${prior}/${gate.maxPushbacks})`);
  if (reply.verdict === 'decide' && reply.reason) {
    return { action: 'answer', reason: reply.reason, reply };
  }
  // The server enforces the cap too; this keeps it even against a server that does not.
  if (reply.verdict === 'pushback' && prior < gate.maxPushbacks && reply.reason) {
    worker.questionPushbacks = prior + 1;
    return { action: 'pushback', reason: reply.reason, reply };
  }
  return { action: 'send', reply };
}
