/**
 * Scripted SDK event streams for the task-shape contract suite
 * (apps/runner/__tests__/unit/task-shape-contract.test.ts).
 *
 * Every builder returns a raw SDK message — the shape the Claude Agent SDK
 * hands the backend's `onProgress` — so the runner's own handleMessage sees
 * exactly what it sees in production. `translateScriptedMessage` is the other
 * half: it turns one of those messages into the BackendEvent(s) the real
 * backends yield for it, mirroring claude-backend.ts (including its
 * `<subtype>: <detail>` error wording, which the runner's failure classifiers
 * match on).
 *
 * All identifiers are synthetic.
 */

/** A script entry that is not an SDK message but a directive to the fake. */
export type ScriptDirective =
  /** The backend itself throws mid-stream (a crashed CLI / transport error). */
  | { __throw: string }
  /** Yield a raw BackendEvent (e.g. Codex's structured output on turn_complete). */
  | { __event: Record<string, unknown> };

export type ScriptEntry = Record<string, any> | ScriptDirective;
export type Script = ScriptEntry[];

let toolUseSeq = 0;
const nextToolUseId = () => `toolu_fixture_${++toolUseSeq}`;

export function init(sessionId = 'sess-fixture') {
  return { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-4-6' };
}

export function say(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

/** An assistant tool_use block followed by its tool_result, as the SDK emits them. */
export function toolCall(name: string, input: Record<string, unknown>, resultText = 'ok', isError = false) {
  const id = nextToolUseId();
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: resultText, is_error: isError }] } },
  ];
}

export function builddAction(action: string, params: Record<string, unknown> = {}, resultText = 'ok') {
  return toolCall('mcp__buildd__buildd', { action, params }, resultText);
}

/** The agent's own complete_task call. The fake server terminalises on it. */
export function completeTask(summary = 'Done.') {
  return builddAction('complete_task', { summary }, 'Task completed.');
}

export function createPr() {
  return builddAction(
    'create_pr',
    { title: 'feat: example', head: 'buildd/example', base: 'dev' },
    'Pull request created\n**URL:** https://github.com/example-org/example-repo/pull/1',
  );
}

export function createArtifact() {
  return builddAction('create_artifact', { type: 'report', title: 'Findings', content: '# Findings' }, 'Artifact created.');
}

/**
 * The SDK's structured-output tool call. With `outputFormat` set, this is how
 * the model delivers its answer — never through complete_task.
 */
export function structuredOutputTool(payload: Record<string, unknown>) {
  return toolCall('StructuredOutput', payload, 'Structured output provided successfully');
}

export function success(sessionId = 'sess-fixture', extra: Record<string, unknown> = {}) {
  return { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, num_turns: 3, total_cost_usd: 0.05, ...extra };
}

export function errorResult(
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries',
  detail: string,
  sessionId = 'sess-fixture',
) {
  return { type: 'result', subtype, is_error: true, session_id: sessionId, num_turns: 3, errors: [detail] };
}

/**
 * The BackendEvents a real backend yields for one SDK message (after passing
 * it to onProgress). `'stop'` means the backend returns after yielding.
 */
export function translateScriptedMessage(msg: Record<string, any>): { events: Record<string, unknown>[]; stop: boolean } {
  if (msg.type === 'assistant') {
    const text = msg.message?.content?.find((b: any) => b.type === 'text')?.text;
    return { events: text ? [{ type: 'progress', message: text }] : [], stop: false };
  }
  if (msg.type === 'result') {
    if (msg.is_error) {
      const detail = typeof msg.result === 'string' && msg.result.trim()
        ? msg.result
        : Array.isArray(msg.errors) && msg.errors.length > 0 ? msg.errors.join('; ') : undefined;
      const subtype = msg.subtype && msg.subtype !== 'success' ? msg.subtype : undefined;
      const error = subtype && detail ? `${subtype}: ${detail}` : detail ?? subtype ?? 'Claude Agent SDK returned an error result';
      return { events: [{ type: 'error', error }], stop: true };
    }
    return {
      events: [{
        type: 'turn_complete',
        ...(msg.structured_output && typeof msg.structured_output === 'object' ? { structuredOutput: msg.structured_output } : {}),
      }],
      stop: false,
    };
  }
  return { events: [], stop: false };
}

/** True when this script entry is the agent calling complete_task. */
export function isCompleteTaskCall(msg: Record<string, any>): boolean {
  if (msg.type !== 'assistant') return false;
  return (msg.message?.content ?? []).some((b: any) =>
    b.type === 'tool_use' && b.name === 'mcp__buildd__buildd' && b.input?.action === 'complete_task');
}

/**
 * How a script ends, as a value of the SDK's own result-subtype vocabulary
 * plus the two ways a session ends without one. Drives the coverage guard.
 */
export function scriptEnding(script: Script): string {
  for (const entry of script) {
    if ('__throw' in entry) return 'thrown';
    if ((entry as any).type === 'result') {
      const r = entry as any;
      if (r.is_error && /abort/i.test(r.result ?? (r.errors ?? []).join(' '))) return 'aborted';
      return r.subtype;
    }
  }
  return 'no_result';
}
