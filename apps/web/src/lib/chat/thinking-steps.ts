/**
 * The Thinking panel's steps (docs/design/chat-canvas.md, "Thinking"), decided
 * on the server: the turn streams a `data-step` part per tool call, in plain
 * words (never the tool's name), and the kit's ThinkingPanel draws them. The
 * labels come from the table below, keyed by the tool lifecycle; the model
 * never writes one. Pure, so the dev fixtures can use it too.
 */
import { STEP_PART_TYPE, type StepData } from '@builddai/ai-kit/chat/contract';

type Phase = 'active' | 'done' | 'failed';

/** doing / done verb phrases, and the object in the singular and, when a run can be counted, the plural. */
interface Verb { doing: string; done: string; one: string; many?: string; failed: string }

const v = (doing: string, done: string, one: string, many: string | undefined, failed: string): Verb => ({ doing, done, one, many, failed });

/** Keyed by tool, or `tool:action` for the multi-op tools. */
const VERBS: Record<string, Verb> = {
  list_tasks: v('Looking over', 'Looked over', 'the tasks', undefined, "Couldn't list the tasks"),
  get_task: v('Reading', 'Read', 'a task', 'tasks', "Couldn't open the task"),
  get_task_messages: v('Reading', 'Read', 'what was said on a task', undefined, "Couldn't read the task's messages"),
  list_discrepancies: v('Checking', 'Checked', 'where the spec and code disagree', undefined, "Couldn't check the spec"),
  get_discrepancy: v('Reading', 'Read', 'a spec mismatch', 'spec mismatches', "Couldn't read the spec mismatch"),
  query_events: v('Looking through', 'Looked through', 'recent activity', undefined, "Couldn't read the activity"),
  explain: v('Working out', 'Worked out', 'why it is stuck', undefined, "Couldn't work out the cause"),
  get_error_traces: v('Reading', 'Read', 'the errors', undefined, "Couldn't read the errors"),
  get_failure_analytics: v('Looking at', 'Looked at', 'what has been failing', undefined, "Couldn't look at the failures"),
  get_budget_forecast: v('Checking', 'Checked', 'the budget', undefined, "Couldn't check the budget"),
  list_connectors: v('Checking', 'Checked', 'the connected services', undefined, "Couldn't check the connected services"),
  get_pr: v('Checking', 'Checked', 'the change', 'changes', "Couldn't check the change"),
  list_prs: v('Looking over', 'Looked over', 'open changes', undefined, "Couldn't list the changes"),
  get_pr_review: v('Reading', 'Read', 'the review', 'reviews', "Couldn't read the review"),
  list_releases: v('Looking over', 'Looked over', 'recent releases', undefined, "Couldn't list the releases"),
  get_release: v('Reading', 'Read', 'a release', 'releases', "Couldn't read the release"),
  release_status: v('Checking', 'Checked', 'what would ship next', undefined, "Couldn't check the next release"),
  spec_compare: v('Comparing', 'Compared', 'the spec with the code', undefined, "Couldn't compare the spec"),
  recall: v('Searching', 'Searched', 'what buildd remembers', undefined, "Couldn't search what buildd remembers"),
  list_schedules: v('Looking over', 'Looked over', 'the schedules', undefined, "Couldn't list the schedules"),
  trace_schedule: v('Tracing', 'Traced', 'where it came from', undefined, "Couldn't trace where it came from"),
  list_artifacts: v('Looking over', 'Looked over', 'the saved work', undefined, "Couldn't list the saved work"),
  get_artifact: v('Reading', 'Read', 'a document', 'documents', "Couldn't open the document"),
  list_artifact_templates: v('Looking over', 'Looked over', 'the templates', undefined, "Couldn't list the templates"),
  list_skills: v('Looking over', 'Looked over', 'the roles', undefined, "Couldn't list the roles"),
  get_skill: v('Reading', 'Read', 'a role', 'roles', "Couldn't open the role"),
  'manage_missions:list': v('Looking over', 'Looked over', 'the missions', undefined, "Couldn't list the missions"),
  'manage_missions:get': v('Reading', 'Read', 'a mission', 'missions', "Couldn't open the mission"),
  'manage_missions:get_criteria_state': v('Checking', 'Checked', 'the goal', 'goals', "Couldn't check the goal"),
  'manage_missions:create': v('Drafting', 'Drafted', 'a mission', undefined, "Couldn't draft the mission"),
  'manage_missions:update': v('Drafting', 'Drafted', 'a change to the mission', undefined, "Couldn't draft the change"),
  'manage_initiatives:list': v('Looking over', 'Looked over', 'the initiatives', undefined, "Couldn't list the initiatives"),
  'manage_initiatives:get': v('Reading', 'Read', 'an initiative', 'initiatives', "Couldn't open the initiative"),
  'manage_workspaces:list': v('Looking over', 'Looked over', 'the workspaces', undefined, "Couldn't list the workspaces"),
  'manage_workspaces:get': v('Reading', 'Read', 'a workspace', 'workspaces', "Couldn't open the workspace"),
  'manage_watched_projects:list': v('Checking', 'Checked', 'the watched projects', undefined, "Couldn't check the watched projects"),
  'manage_experiments:list': v('Looking over', 'Looked over', 'the experiments', undefined, "Couldn't list the experiments"),
  'manage_experiments:get': v('Reading', 'Read', 'an experiment', 'experiments', "Couldn't open the experiment"),
  'manage_experiments:readout': v('Reading', 'Read', 'the results', undefined, "Couldn't read the results"),
  create_task: v('Drafting', 'Drafted', 'a task', 'tasks', "Couldn't draft the task"),
  update_task: v('Drafting', 'Drafted', 'a change to a task', undefined, "Couldn't draft the change"),
  send_agent_message: v('Writing', 'Wrote', 'to the agent', undefined, "Couldn't reach the agent"),
};

const FALLBACK = v('Looking', 'Looked', 'something up', undefined, "Couldn't look it up");

export const APPROVAL_STEP_LABEL = 'Check it with you';
export const DENIED_STEP_LABEL = 'Not done';

function actionOf(input: unknown): string | null {
  const a = input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  return typeof a === 'string' && a.trim() ? a.trim() : null;
}

function keyOf(tool: string, input: unknown): string {
  return `${tool}:${actionOf(input) ?? ''}`;
}

function verbOf(tool: string, input: unknown): Verb {
  const action = actionOf(input);
  return (action && VERBS[`${tool}:${action}`]) || VERBS[tool] || FALLBACK;
}

/** One call (or a run of `count` identical ones) as a plain-language step label. */
export function stepLabel(tool: string, input: unknown, phase: Phase, count = 1): string {
  const verb = verbOf(tool, input);
  if (phase === 'failed') return verb.failed;
  const obj = count > 1 && verb.many ? `${count} ${verb.many}` : verb.one;
  return `${phase === 'done' ? verb.done : verb.doing} ${obj}`;
}

export interface KnownCall { toolCallId: string; toolName: string; input: unknown }

/** Consecutive calls of the same tool (and action): one step, counted. */
interface Run { id: string; tool: string; input: unknown; key: string; live: Set<string>; ok: number; closed: boolean }

export interface StepTracker {
  start(toolCallId: string, toolName: string, input: unknown): StepData[];
  approval(toolCallId: string): StepData[];
  output(toolCallId: string): StepData[];
  error(toolCallId: string): StepData[];
  denied(toolCallId: string): StepData[];
  /** Every step's latest state, in first-seen order (for persisting). */
  steps(): StepData[];
}

/**
 * The tool lifecycle → steps. Each method returns the steps to stream (a step
 * re-sent under the same id replaces the earlier one on the client).
 * `known`: calls from the stored message a continuation extends, so an output
 * for a call that started in an earlier request is still labelled. `seed`:
 * steps already on that message.
 */
export function createStepTracker(opts: { known?: readonly KnownCall[]; seed?: readonly StepData[] } = {}): StepTracker {
  const calls = new Map<string, { tool: string; input: unknown }>();
  for (const c of opts.known ?? []) calls.set(c.toolCallId, { tool: c.toolName, input: c.input });
  const steps = new Map<string, StepData>();
  for (const s of opts.seed ?? []) steps.set(s.id, s);
  const runOf = new Map<string, Run>();
  /** A call's own step, once it left its run (a card, a failure). */
  const ownOf = new Map<string, string>();
  let last: Run | null = null;
  let lastStepId: string | null = null;

  const set = (s: StepData): StepData => {
    if (!steps.has(s.id)) lastStepId = s.id;
    steps.set(s.id, s);
    return s;
  };
  const runStep = (r: Run): StepData => {
    const n = r.live.size + r.ok;
    return set(r.live.size > 0
      ? { id: r.id, label: stepLabel(r.tool, r.input, 'active', n), state: 'active' }
      : { id: r.id, label: stepLabel(r.tool, r.input, 'done', n), state: 'done' });
  };
  /**
   * Take a call out of its run. Alone in it, the run's step becomes the call's
   * own (returned id); otherwise the run is re-counted and the call gets a new step.
   */
  const detach = (id: string, prefix: string): { own: string; out: StepData[] } | null => {
    const r = runOf.get(id);
    if (!r) return null;
    runOf.delete(id);
    r.live.delete(id);
    if (r.live.size + r.ok === 0) { r.closed = true; return { own: r.id, out: [] }; }
    return { own: `${prefix}-${id}`, out: [runStep(r)] };
  };
  const single = (id: string, phase: Phase): StepData[] => {
    const c = calls.get(id);
    if (!c) return [];
    return [set({ id, label: stepLabel(c.tool, c.input, phase), state: 'done' })];
  };

  return {
    start(id, tool, input) {
      calls.set(id, { tool, input });
      const key = keyOf(tool, input);
      if (last && !last.closed && last.key === key && lastStepId === last.id) {
        last.live.add(id);
        runOf.set(id, last);
        return [runStep(last)];
      }
      const r: Run = { id, tool, input, key, live: new Set([id]), ok: 0, closed: false };
      last = r;
      runOf.set(id, r);
      return [runStep(r)];
    },
    approval(id) {
      const d = detach(id, 'approval');
      const own = d?.own ?? id;
      ownOf.set(id, own);
      return [...(d?.out ?? []), set({ id: own, label: APPROVAL_STEP_LABEL, state: 'pending' })];
    },
    output(id) {
      const r = runOf.get(id);
      if (r) {
        r.live.delete(id);
        r.ok += 1;
        return [runStep(r)];
      }
      const own = ownOf.get(id);
      const c = calls.get(id);
      if (own && c) return [set({ id: own, label: stepLabel(c.tool, c.input, 'done'), state: 'done' })];
      return single(id, 'done');
    },
    error(id) {
      const d = detach(id, 'failed');
      const c = calls.get(id);
      if (!c) return [];
      const own = d?.own ?? ownOf.get(id) ?? id;
      return [...(d?.out ?? []), set({ id: own, label: stepLabel(c.tool, c.input, 'failed'), state: 'done' })];
    },
    denied(id) {
      const d = detach(id, 'denied');
      const own = d?.own ?? ownOf.get(id) ?? id;
      if (!d && !steps.has(own)) return [];
      return [...(d?.out ?? []), set({ id: own, label: DENIED_STEP_LABEL, state: 'done' })];
    },
    steps: () => [...steps.values()],
  };
}

interface ToolLike { type: string; toolCallId?: string; state?: string; input?: unknown }

function isToolLike<T extends { type: string }>(p: T): p is T & ToolLike & { toolCallId: string } {
  return p.type.startsWith('tool-') && typeof (p as ToolLike).toolCallId === 'string';
}

function isStepLike<T extends { type: string }>(p: T): p is T & { id?: string; data: StepData } {
  const d = (p as { data?: Partial<StepData> }).data;
  return p.type === STEP_PART_TYPE && !!d && typeof d.id === 'string';
}

/** The tool calls on a stored message, for a tracker continuing it. */
export function knownCalls(parts: readonly { type: string }[]): KnownCall[] {
  return parts.filter(isToolLike).map(p => ({ toolCallId: p.toolCallId, toolName: p.type.slice('tool-'.length), input: p.input }));
}

/**
 * Steps for a message stored before the server sent them, from its tool parts'
 * stored states. Empty when it already has steps or made no calls. A
 * continuation streams these first, so resuming an old turn after an approval
 * still shows its panel.
 */
export function backfillSteps(parts: readonly { type: string }[]): StepData[] {
  if (parts.some(isStepLike)) return [];
  const t = createStepTracker();
  for (const p of parts.filter(isToolLike)) {
    const id = p.toolCallId;
    t.start(id, p.type.slice('tool-'.length), p.input);
    switch (p.state) {
      case 'output-available': t.output(id); break;
      case 'output-error': t.error(id); break;
      case 'output-denied': t.approval(id); t.denied(id); break;
      case 'approval-requested':
      case 'approval-responded': t.approval(id); break;
    }
  }
  return t.steps();
}

/** A `data-step` part (stream chunk or stored part): the id makes a later one replace it. */
export function stepPart(s: StepData): { type: typeof STEP_PART_TYPE; id: string; data: StepData } {
  return { type: STEP_PART_TYPE, id: s.id, data: s };
}

/**
 * The saved message with this turn's steps: a step already stored is replaced
 * in place, a new one goes after its call (the order the client saw), else last.
 */
export function mergeStepParts<P extends { type: string }>(parts: readonly P[], steps: readonly StepData[]): P[] {
  const latest = new Map(steps.map(s => [s.id, s]));
  const out: P[] = parts.map(p => (isStepLike(p) && latest.has(p.data.id) ? stepPart(latest.get(p.data.id)!) as unknown as P : p));
  const stored = new Set(out.filter(isStepLike).map(p => p.data.id));
  for (const s of steps) {
    if (stored.has(s.id)) continue;
    const callId = s.id.replace(/^(failed|approval|denied)-/, '');
    let at = out.findIndex(p => isToolLike(p) && p.toolCallId === callId);
    if (at < 0) { out.push(stepPart(s) as unknown as P); continue; }
    // After the call and the steps already placed behind it.
    while (at + 1 < out.length && isStepLike(out[at + 1])) at += 1;
    out.splice(at + 1, 0, stepPart(s) as unknown as P);
  }
  return out;
}

type Chunk = { type: string; toolCallId?: string; toolName?: string; input?: unknown };

/**
 * Follows each tool chunk of a UI message stream with the step it moves, and
 * streams `backfill` right after `start`. The tracker keeps every step for
 * persisting (`mergeStepParts`), since the stream's own `onEnd` never sees
 * chunks added here.
 */
export function withThinkingSteps<C extends Chunk>(
  stream: ReadableStream<C>,
  opts: { tracker: StepTracker; backfill?: readonly StepData[] },
): ReadableStream<C> {
  const { tracker } = opts;
  const emit = (controller: TransformStreamDefaultController<C>, steps: readonly StepData[]) => {
    for (const s of steps) controller.enqueue(stepPart(s) as unknown as C);
  };
  return stream.pipeThrough(new TransformStream<C, C>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      const id = chunk.toolCallId;
      switch (chunk.type) {
        case 'start': emit(controller, opts.backfill ?? []); break;
        case 'tool-input-available': emit(controller, tracker.start(id!, chunk.toolName ?? '', chunk.input)); break;
        case 'tool-approval-request': emit(controller, tracker.approval(id!)); break;
        case 'tool-output-available': emit(controller, tracker.output(id!)); break;
        case 'tool-output-error': emit(controller, tracker.error(id!)); break;
        case 'tool-output-denied': emit(controller, tracker.denied(id!)); break;
      }
    },
  }));
}
