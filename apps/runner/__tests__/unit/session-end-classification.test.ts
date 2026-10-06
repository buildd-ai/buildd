import { describe, test, expect } from 'bun:test';
import {
  classifySessionEnd,
  isBackgroundJobOutstanding,
  lastToolWasDeniedByRunner,
  genuinelyBlockedQuestionInput,
  GENUINELY_BLOCKED_RETRY_OPTION,
  GENUINELY_BLOCKED_FAIL_OPTION,
  SESSION_END_PUSH_TEXT,
} from '../../src/session-end-classification';

describe('classifySessionEnd', () => {
  const base = {
    alreadyTerminalOnServer: false,
    hasProgress: false,
    backgroundJobOutstanding: false,
    lastToolDeniedByRunner: false,
  };

  test('already terminal on the server wins over every other signal', () => {
    expect(classifySessionEnd({ ...base, hasProgress: true, backgroundJobOutstanding: true, alreadyTerminalOnServer: true })).toBe('done');
  });

  test('a background job outstanding classifies as waiting_on_background_job', () => {
    expect(classifySessionEnd({ ...base, backgroundJobOutstanding: true })).toBe('waiting_on_background_job');
  });

  test('a background job outstanding wins over mere progress', () => {
    expect(classifySessionEnd({ ...base, backgroundJobOutstanding: true, hasProgress: true })).toBe('waiting_on_background_job');
  });

  test('a runner denial classifies as asking_permission_it_has', () => {
    expect(classifySessionEnd({ ...base, lastToolDeniedByRunner: true })).toBe('asking_permission_it_has');
  });

  test('a runner denial wins over mere progress', () => {
    expect(classifySessionEnd({ ...base, lastToolDeniedByRunner: true, hasProgress: true })).toBe('asking_permission_it_has');
  });

  test('progress with no background job or denial classifies as believes_done_no_deliverable', () => {
    expect(classifySessionEnd({ ...base, hasProgress: true })).toBe('believes_done_no_deliverable');
  });

  test('nothing at all classifies as genuinely_blocked', () => {
    expect(classifySessionEnd(base)).toBe('genuinely_blocked');
  });
});

describe('isBackgroundJobOutstanding', () => {
  test('true when the last tool call is a backgrounded Bash call', () => {
    expect(isBackgroundJobOutstanding({
      toolCalls: [{ name: 'Read' }, { name: 'Bash', input: { command: 'bun run build:only', run_in_background: true } }],
      subagentTasks: [],
    })).toBe(true);
  });

  test('false when a later tool call follows the backgrounded Bash call', () => {
    expect(isBackgroundJobOutstanding({
      toolCalls: [
        { name: 'Bash', input: { command: 'bun run build:only', run_in_background: true } },
        { name: 'Read' },
      ],
      subagentTasks: [],
    })).toBe(false);
  });

  test('false for a foreground Bash call', () => {
    expect(isBackgroundJobOutstanding({
      toolCalls: [{ name: 'Bash', input: { command: 'ls' } }],
      subagentTasks: [],
    })).toBe(false);
  });

  test('true when a background subagent task is still running', () => {
    expect(isBackgroundJobOutstanding({
      toolCalls: [{ name: 'Read' }],
      subagentTasks: [{ isBackground: true, status: 'running' }],
    })).toBe(true);
  });

  test('false when the background subagent task already completed', () => {
    expect(isBackgroundJobOutstanding({
      toolCalls: [{ name: 'Read' }],
      subagentTasks: [{ isBackground: true, status: 'completed' }],
    })).toBe(false);
  });

  test('false with no tool calls at all', () => {
    expect(isBackgroundJobOutstanding({ toolCalls: [], subagentTasks: [] })).toBe(false);
  });
});

describe('lastToolWasDeniedByRunner', () => {
  test('true when the last tool call matches a runner-attributed denial', () => {
    expect(lastToolWasDeniedByRunner({
      toolCalls: [{ name: 'Bash', toolUseId: 'tu-1' }],
      lastToolDenial: { toolUseId: 'tu-1', runnerAttributed: true },
    })).toBe(true);
  });

  test('false when a later tool call superseded the denial', () => {
    expect(lastToolWasDeniedByRunner({
      toolCalls: [{ name: 'Bash', toolUseId: 'tu-1' }, { name: 'Read', toolUseId: 'tu-2' }],
      lastToolDenial: { toolUseId: 'tu-1', runnerAttributed: true },
    })).toBe(false);
  });

  test('false when the denial was not runner-attributed (e.g. a person denied it)', () => {
    expect(lastToolWasDeniedByRunner({
      toolCalls: [{ name: 'Bash', toolUseId: 'tu-1' }],
      lastToolDenial: { toolUseId: 'tu-1', runnerAttributed: false },
    })).toBe(false);
  });

  test('false with no denial recorded', () => {
    expect(lastToolWasDeniedByRunner({ toolCalls: [{ name: 'Bash', toolUseId: 'tu-1' }] })).toBe(false);
  });
});

describe('genuinelyBlockedQuestionInput', () => {
  test('offers exactly the retry and fail options', () => {
    const input = genuinelyBlockedQuestionInput() as { questions: Array<{ options: Array<{ label: string }> }> };
    const labels = input.questions[0].options.map(o => o.label);
    expect(labels).toEqual([GENUINELY_BLOCKED_RETRY_OPTION, GENUINELY_BLOCKED_FAIL_OPTION]);
  });

  test('folds the diagnosis into the question text when given', () => {
    const input = genuinelyBlockedQuestionInput('waiting for the test run') as { questions: Array<{ question: string }> };
    expect(input.questions[0].question).toContain('waiting for the test run');
  });

  test('omits the diagnosis tail when none is given', () => {
    const input = genuinelyBlockedQuestionInput() as { questions: Array<{ question: string }> };
    expect(input.questions[0].question).not.toContain('Last thing it said');
  });
});

describe('SESSION_END_PUSH_TEXT', () => {
  test('has plain, concrete text for every pushable label', () => {
    expect(SESSION_END_PUSH_TEXT.waiting_on_background_job).toContain('Push the branch now');
    expect(SESSION_END_PUSH_TEXT.asking_permission_it_has).toContain('already have permission');
    expect(SESSION_END_PUSH_TEXT.believes_done_no_deliverable).toContain('PR or artifact');
  });
});
