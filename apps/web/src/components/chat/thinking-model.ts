/**
 * The Thinking panel (docs/design/chat-canvas.md, "Thinking"): what a
 * streaming turn is doing, in plain words. A tool call becomes a step with a
 * human verb (never the tool's name), and the person's message carries a tiny
 * tag naming the workspace the turn went to. Pure.
 */
import { isTextPart, isToolPart, messageMeta, toolNameOf, type ChatMessage, type ChatPart, type ChatToolPart } from './chat-contract';
import { isApprovalPart, toolAction, toolRowState } from './feed-model';

export type StepState = 'done' | 'active' | 'pending';

export interface ThinkingStep {
  key: string;
  label: string;
  state: StepState;
}

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

function verbOf(part: ChatToolPart): Verb {
  const name = toolNameOf(part);
  const action = toolAction(part);
  return (action && VERBS[`${name}:${action}`]) || VERBS[name] || FALLBACK;
}

/** One call (or a run of `count` identical ones) as a plain-language step label. */
export function stepLabel(part: ChatToolPart, state: StepState | 'failed', count = 1): string {
  const verb = verbOf(part);
  if (state === 'failed') return verb.failed;
  const obj = count > 1 && verb.many ? `${count} ${verb.many}` : verb.one;
  return `${state === 'done' ? verb.done : verb.doing} ${obj}`;
}

type CallState = 'done' | 'active' | 'pending' | 'failed' | 'skip';

function callState(part: ChatToolPart): CallState {
  switch (toolRowState(part)) {
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'denied': return 'skip';
    case 'awaiting': return 'pending';
    default: return 'active';
  }
}

/**
 * The steps of a streaming turn, oldest first. Finished calls are done, the
 * call in flight is the one active step, a change waiting on the person is
 * pending. After the calls: writing the answer while prose streams, else still
 * thinking. Consecutive identical calls collapse into one counted step.
 */
export function thinkingSteps(parts: readonly ChatPart[]): ThinkingStep[] {
  const out: Array<ThinkingStep & { sig: string; count: number; part: ChatToolPart | null; raw: CallState }> = [];
  let textAfterCalls = false;
  for (const p of parts) {
    if (isToolPart(p)) {
      textAfterCalls = false;
      const raw = callState(p);
      if (raw === 'skip') continue;
      if (raw === 'pending' && isApprovalPart(p)) {
        out.push({ key: p.toolCallId, label: 'Check it with you', state: 'pending', sig: `pending:${p.toolCallId}`, count: 1, part: null, raw });
        continue;
      }
      const sig = `${toolNameOf(p)}:${toolAction(p) ?? ''}:${raw}`;
      const last = out[out.length - 1];
      if (last && last.sig === sig && last.part) {
        last.count += 1;
        continue;
      }
      out.push({ key: p.toolCallId, label: '', state: raw === 'failed' ? 'done' : raw === 'pending' ? 'active' : raw, sig, count: 1, part: p, raw });
      continue;
    }
    if (isTextPart(p) && p.text.trim()) textAfterCalls = true;
  }
  for (const s of out) {
    if (s.part) s.label = stepLabel(s.part, s.raw === 'failed' ? 'failed' : s.state, s.count);
  }

  // One active step at most: the latest call still in flight wins.
  let activeSeen = false;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].state !== 'active') continue;
    if (activeSeen) { out[i].state = 'done'; if (out[i].part) out[i].label = stepLabel(out[i].part!, 'done', out[i].count); }
    activeSeen = true;
  }
  const waiting = out.some(s => s.state === 'pending');
  const steps: ThinkingStep[] = out.map(({ key, label, state }) => ({ key, label, state }));
  if (!activeSeen && !waiting) {
    if (out.length === 0 && !textAfterCalls) steps.push({ key: 'start', label: 'Reading your question', state: 'active' });
    else steps.push({ key: 'tail', label: textAfterCalls ? 'Writing the answer' : 'Thinking it through', state: 'active' });
  }
  return steps;
}

/**
 * The tiny tag under a person's message: where the reply to it was scoped.
 * Read from the assistant message that directly follows; null when there is
 * none yet or it was unscoped.
 */
export function intentTag(messages: readonly ChatMessage[], index: number): { label: string; workspaceId: string } | null {
  const next = messages[index + 1];
  if (!next || next.role !== 'assistant') return null;
  const scope = messageMeta(next).scope;
  if (!scope) return null;
  return { label: `${scope.source} · ${scope.name}`, workspaceId: scope.id };
}
