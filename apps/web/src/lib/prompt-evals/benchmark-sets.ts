/**
 * The decision benchmark's question sets and its scoring loop, shared by
 * `scripts/decision-benchmark.ts` (a local run over your own labelled data),
 * `scripts/private-prompt-eval.ts` (the same eval from a checkout) and the
 * server-side prompt eval (`./run.ts`).
 *
 * Every set resolves its questions through the prompts table
 * (`@buildd/core/prompts`) the way the live call site does, so the questions
 * scored are the ones in effect in this process: the public defaults, unless a
 * caller installed active rows first (`installPrompts`).
 */
import { decisionCall, describeDecisionError, type DecisionQuestions } from '@buildd/core/decision-client';
import type { LabeledExample, ScoredExample } from '@buildd/core/decision-benchmark';
import type { DecisionEndpoint } from '@builddai/ai-kit/decide';
import { promptedQuestions } from '@buildd/core/prompted-decision';
import {
  TASK_CATEGORY_PROMPT_ID,
  TASK_CATEGORY_PROMPT_VERSION,
  TASK_CATEGORY_QUESTIONS,
  buildTaskCategoryState,
} from '../task-category-decision';
import { classifyTask } from '../task-category';
import {
  HEARTBEAT_TRIAGE_PROMPT_ID,
  HEARTBEAT_TRIAGE_PROMPT_VERSION,
  HEARTBEAT_TRIAGE_QUESTIONS,
  buildHeartbeatTriageState,
} from '../heartbeat-triage';
import {
  TASK_ROLE_PROMPT_ID,
  buildRoleQuestion,
  buildTaskRoleState,
  taskRolePromptVersion,
  type RoleCandidate,
} from '../task-role-decision';

export interface QuestionSet {
  /** The prompts-table id whose text this set scores. */
  promptId: string;
  /** The prompt version naming the text in effect. */
  promptVersion(): string;
  /**
   * The questions for one row, and how to read the answer back as a label.
   * Null when the live path would make no call (a role question with fewer
   * than two candidates).
   */
  questionsFor(fields: Record<string, unknown>): { questions: DecisionQuestions; toLabel(choice: string): string } | null;
  /** The field the gold is read from when --label-field is not given. */
  labelField?: string;
  /** Print the apply-gate table (a wrong answer is worse than none). */
  gate?: boolean;
  /** Which choice question's answer is compared with the gold label. */
  answerKey: string;
  toState(fields: Record<string, unknown>): Record<string, unknown> | string;
  /** The incumbent logic, for a side-by-side accuracy line. */
  baseline?(fields: Record<string, unknown>): string | null;
  /**
   * A label whose wrong picks are the expensive ones: its precision is printed
   * at each confidence threshold, which is what its gate is read from.
   */
  gatedLabel?: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const same = (choice: string) => choice;

/** Routing text for slug candidates (`--roles`). */
let ROLE_TEXT: Map<string, RoleCandidate> = new Map();

export function setRoleText(roles: Array<{ slug: string; name?: string; whenToUse: string; notFor?: string }>): void {
  ROLE_TEXT = new Map(roles.map(r => [r.slug, { slug: r.slug, name: r.name ?? r.slug, whenToUse: r.whenToUse, ...(r.notFor ? { notFor: r.notFor } : {}), connectorRefs: [] }]));
}

function roleCandidates(fields: Record<string, unknown>): RoleCandidate[] {
  const raw = Array.isArray(fields.candidates) ? fields.candidates : [];
  const out: RoleCandidate[] = [];
  for (const c of raw) {
    if (typeof c === 'string') {
      const known = ROLE_TEXT.get(c);
      if (!known) throw new Error(`candidate "${c}" has no routing text; pass --roles <file> or inline the candidate`);
      out.push(known);
    } else if (c && typeof c === 'object' && typeof (c as RoleCandidate).slug === 'string') {
      const r = c as RoleCandidate;
      out.push({ slug: r.slug, name: r.name ?? r.slug, whenToUse: r.whenToUse, ...(r.notFor ? { notFor: r.notFor } : {}), connectorRefs: [] });
    }
  }
  return out;
}

export const SETS: Record<string, QuestionSet> = {
  // {"id":"…","label":"bug","title":"…","description":"…"}
  task_category: {
    promptId: TASK_CATEGORY_PROMPT_ID,
    promptVersion: () => promptedQuestions(TASK_CATEGORY_PROMPT_ID, TASK_CATEGORY_QUESTIONS, TASK_CATEGORY_PROMPT_VERSION).promptVersion,
    questionsFor: () => ({
      questions: promptedQuestions(TASK_CATEGORY_PROMPT_ID, TASK_CATEGORY_QUESTIONS, TASK_CATEGORY_PROMPT_VERSION).questions,
      toLabel: same,
    }),
    answerKey: 'category',
    toState: f => buildTaskCategoryState(str(f.title), str(f.description)),
    baseline: f => classifyTask(str(f.title), str(f.description)),
  },
  // {"id":"…","label":"wait"|"act","description":"<the cycle's heartbeat description>"}
  // Gold is what the organizer did on that cycle (see docs/design/heartbeat-triage.md).
  heartbeat_triage: {
    promptId: HEARTBEAT_TRIAGE_PROMPT_ID,
    promptVersion: () => promptedQuestions(HEARTBEAT_TRIAGE_PROMPT_ID, HEARTBEAT_TRIAGE_QUESTIONS, HEARTBEAT_TRIAGE_PROMPT_VERSION).promptVersion,
    questionsFor: () => ({
      questions: promptedQuestions(HEARTBEAT_TRIAGE_PROMPT_ID, HEARTBEAT_TRIAGE_QUESTIONS, HEARTBEAT_TRIAGE_PROMPT_VERSION).questions,
      toLabel: same,
    }),
    answerKey: 'next',
    toState: f => buildHeartbeatTriageState(str(f.description)),
    // Today every cycle that reaches this point dispatches the organizer.
    baseline: () => 'act',
    gatedLabel: 'wait',
  },
  // {"id":"t1","role":"builder","category":"feature","title":"...","description":"...",
  //  "kind":null,"candidates":["builder","researcher","writer"]}
  task_role: {
    promptId: TASK_ROLE_PROMPT_ID,
    promptVersion: taskRolePromptVersion,
    labelField: 'role',
    answerKey: 'role',
    gate: true,
    questionsFor: f => {
      const q = buildRoleQuestion(roleCandidates(f));
      if (!q) return null;
      return { questions: { role: q.question }, toLabel: choice => q.slugFor.get(choice) ?? choice };
    },
    toState: f => buildTaskRoleState({
      title: str(f.title),
      label: typeof f.taskLabel === 'string' ? f.taskLabel : null,
      kind: typeof f.kind === 'string' ? f.kind : null,
      description: str(f.description),
      pathManifest: Array.isArray(f.paths) ? f.paths as string[] : null,
      pathManifestIsConcrete: Array.isArray(f.paths) && f.paths.length > 0,
      creationSource: typeof f.source === 'string' ? f.source : null,
      inMission: f.inMission === true,
      outputRequirement: typeof f.output === 'string' ? f.output : null,
    }),
    // Today every role-less task stays role-less.
    baseline: () => 'none',
  },
};

export interface BenchmarkRun {
  /** One per example that was reached, in example order. */
  scored: ScoredExample[];
  /** Examples never started because `deadlineAt` passed first. */
  notRun: number;
  costUsd: number;
  /** Sum over answered examples. */
  latencyTotalMs: number;
}

export interface BenchmarkRunOptions {
  apiKey: string;
  /** Where to send the key (default: Jev on OpenRouter's System One API). */
  endpoint?: DecisionEndpoint;
  model?: string;
  concurrency?: number;
  decide?: typeof decisionCall;
  timeoutMs?: number;
  /** Epoch ms after which no new example is started. */
  deadlineAt?: number;
  now?: () => number;
}

/** Run `set` over `examples`: one decision call per example, `concurrency` at a time. */
export async function runBenchmarkSet(
  set: QuestionSet,
  examples: readonly LabeledExample[],
  opts: BenchmarkRunOptions,
): Promise<BenchmarkRun> {
  const decide = opts.decide ?? decisionCall;
  const now = opts.now ?? Date.now;
  const scored: Array<ScoredExample | undefined> = new Array(examples.length);
  let next = 0;
  let costUsd = 0;
  let latencyTotalMs = 0;

  async function worker() {
    while (next < examples.length) {
      if (opts.deadlineAt !== undefined && now() >= opts.deadlineAt) return;
      const i = next++;
      const ex = examples[i];
      const baseline = set.baseline ? set.baseline(ex.fields) : undefined;
      const q = set.questionsFor(ex.fields);
      if (!q) {
        // Fewer than two candidates: the live path makes no call and leaves the role null.
        scored[i] = { id: ex.id, gold: ex.label, predicted: null, confidence: null, baseline, error: 'too_few_candidates' };
        continue;
      }
      const res = await decide({
        // Ignored when apiKey is passed (no policy check); names the call site.
        capability: 'task_category',
        teamId: 'offline',
        apiKey: opts.apiKey,
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        model: opts.model,
        state: set.toState(ex.fields),
        questions: q.questions,
        timeoutMs: opts.timeoutMs ?? 10_000,
      });
      if (res.ok) {
        const a = res.answers[set.answerKey] as { choice?: string; confidence?: number } | undefined;
        const predicted = a?.choice == null ? null : q.toLabel(a.choice);
        scored[i] = { id: ex.id, gold: ex.label, predicted, confidence: a?.confidence ?? null, baseline };
        costUsd += res.usage.costUsd ?? 0;
        latencyTotalMs += res.latencyMs;
      } else {
        scored[i] = { id: ex.id, gold: ex.label, predicted: null, confidence: null, baseline, error: describeDecisionError(res.error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  const reached = scored.filter((s): s is ScoredExample => s !== undefined);
  return { scored: reached, notRun: examples.length - reached.length, costUsd, latencyTotalMs };
}
