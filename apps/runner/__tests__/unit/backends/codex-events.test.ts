import { describe, test, expect } from 'bun:test';
import { mapCodexEventToSdkMessages } from '../../../src/backends/codex-events';

// Helpers to pull blocks out of the Claude-shaped SDKMessage objects the
// adapter produces, so assertions read clearly.
function assistantBlocks(msg: any): any[] {
  return msg?.message?.content ?? [];
}
function firstTextBlock(msgs: any[]): any {
  for (const m of msgs) {
    if (m.type !== 'assistant') continue;
    const b = assistantBlocks(m).find((x) => x.type === 'text');
    if (b) return b;
  }
  return undefined;
}
function firstToolUse(msgs: any[]): any {
  for (const m of msgs) {
    if (m.type !== 'assistant') continue;
    const b = assistantBlocks(m).find((x) => x.type === 'tool_use');
    if (b) return b;
  }
  return undefined;
}
function allToolUses(msgs: any[]): any[] {
  const out: any[] = [];
  for (const m of msgs) {
    if (m.type !== 'assistant') continue;
    for (const b of assistantBlocks(m)) if (b.type === 'tool_use') out.push(b);
  }
  return out;
}
function toolResults(msgs: any[]): any[] {
  const out: any[] = [];
  for (const m of msgs) {
    if (m.type !== 'user') continue;
    const content = m?.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) if (b.type === 'tool_result') out.push(b);
    }
  }
  return out;
}

describe('mapCodexEventToSdkMessages', () => {
  test('thread.started maps to system:init with session_id from thread_id', () => {
    const msgs = mapCodexEventToSdkMessages(
      { type: 'thread.started', thread_id: 'thread-abc' },
      {},
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'thread-abc' });
  });

  test('agent_message maps to assistant text block', () => {
    const msgs = mapCodexEventToSdkMessages(
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'All done here' } },
      {},
    );
    const text = firstTextBlock(msgs);
    expect(text).toBeDefined();
    expect(text.text).toBe('All done here');
  });

  test('reasoning maps to assistant text block', () => {
    const msgs = mapCodexEventToSdkMessages(
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking about it' } },
      {},
    );
    const text = firstTextBlock(msgs);
    expect(text).toBeDefined();
    expect(text.text).toBe('thinking about it');
  });

  test('command_execution maps to Bash tool_use carrying the command and stable id', () => {
    const msgs = mapCodexEventToSdkMessages(
      {
        type: 'item.completed',
        item: { id: 'cmd-1', type: 'command_execution', status: 'completed', command: 'git commit -m "x"', aggregated_output: '', exit_code: 0 },
      },
      {},
    );
    const tu = firstToolUse(msgs);
    expect(tu).toMatchObject({ type: 'tool_use', name: 'Bash', id: 'cmd-1' });
    expect(tu.input.command).toBe('git commit -m "x"');
    // a successful command yields no synthetic tool_result
    expect(toolResults(msgs)).toHaveLength(0);
  });

  test('file_change add->Write, update->Edit, delete->Bash, one tool_use per change with unique ids', () => {
    const msgs = mapCodexEventToSdkMessages(
      {
        type: 'item.completed',
        item: {
          id: 'fc-1',
          type: 'file_change',
          status: 'completed',
          changes: [
            { path: 'src/new.ts', kind: 'add' },
            { path: 'src/old.ts', kind: 'update' },
            { path: 'src/gone.ts', kind: 'delete' },
          ],
        },
      },
      {},
    );
    const tus = allToolUses(msgs);
    expect(tus).toHaveLength(3);

    const add = tus.find((t) => t.name === 'Write');
    expect(add.input.file_path).toBe('src/new.ts');

    const update = tus.find((t) => t.name === 'Edit');
    expect(update.input.file_path).toBe('src/old.ts');

    const del = tus.find((t) => t.name === 'Bash');
    expect(del).toBeDefined();
    expect(del.input.command).toContain('rm');
    expect(del.input.command).toContain('src/gone.ts');

    // ids must all be unique so tool_use<->tool_result correlation never collides
    const ids = tus.map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
  });

  test('mcp_tool_call maps to mcp__server__tool tool_use that satisfies the PR/artifact gate', () => {
    const msgs = mapCodexEventToSdkMessages(
      {
        type: 'item.completed',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'buildd',
          tool: 'buildd',
          status: 'completed',
          arguments: { action: 'create_pr', title: 'My PR' },
        },
      },
      {},
    );
    const tu = firstToolUse(msgs);
    expect(tu).toBeDefined();
    // The exact name + input.action the output-requirement gate (workers.ts ~1535-1539) matches.
    expect(tu.name).toBe('mcp__buildd__buildd');
    expect(tu.input.action).toBe('create_pr');
    expect(tu.id).toBe('mcp-1');

    // Replicate the gate predicate to prove it fires.
    const toolCalls = [{ name: tu.name, input: tu.input }];
    const hasPR = toolCalls.some(
      (tc: any) => tc.name === 'create_pr' || (tc.name === 'mcp__buildd__buildd' && tc.input?.action === 'create_pr'),
    );
    expect(hasPR).toBe(true);
  });

  test('mcp_tool_call with create_artifact satisfies the artifact arm of the gate', () => {
    const msgs = mapCodexEventToSdkMessages(
      {
        type: 'item.completed',
        item: {
          id: 'mcp-2',
          type: 'mcp_tool_call',
          server: 'buildd',
          tool: 'buildd',
          status: 'completed',
          arguments: { action: 'create_artifact', type: 'summary' },
        },
      },
      {},
    );
    const tu = firstToolUse(msgs);
    const toolCalls = [{ name: tu.name, input: tu.input }];
    const hasArtifact = toolCalls.some(
      (tc: any) => tc.name === 'mcp__buildd__buildd' && tc.input?.action === 'create_artifact',
    );
    expect(hasArtifact).toBe(true);
  });

  test('mcp_tool_call without arguments still maps name + id (input may be empty)', () => {
    const msgs = mapCodexEventToSdkMessages(
      {
        type: 'item.completed',
        item: { id: 'mcp-3', type: 'mcp_tool_call', server: 'github', tool: 'create_pr', status: 'completed' },
      },
      {},
    );
    const tu = firstToolUse(msgs);
    expect(tu.name).toBe('mcp__github__create_pr');
    expect(tu.id).toBe('mcp-3');
    expect(tu.input).toBeDefined();
  });

  test('web_search maps to WebSearch tool_use with query', () => {
    const msgs = mapCodexEventToSdkMessages(
      { type: 'item.completed', item: { id: 'ws-1', type: 'web_search', query: 'how to foo' } },
      {},
    );
    const tu = firstToolUse(msgs);
    expect(tu).toMatchObject({ name: 'WebSearch', id: 'ws-1' });
    expect(tu.input.query).toBe('how to foo');
  });

  test('todo_list does NOT produce a tool_use (avoids loop-detection misfire)', () => {
    const msgs = mapCodexEventToSdkMessages(
      {
        type: 'item.completed',
        item: {
          id: 'todo-1',
          type: 'todo_list',
          items: [{ text: 'do thing', completed: false }],
        },
      },
      {},
    );
    expect(allToolUses(msgs)).toHaveLength(0);
  });

  test('failed command_execution emits a user tool_result with a correlating id and the output', () => {
    const itemId = 'cmd-fail-1';
    const msgs = mapCodexEventToSdkMessages(
      {
        type: 'item.completed',
        item: {
          id: itemId,
          type: 'command_execution',
          status: 'failed',
          command: 'bun test',
          exit_code: 1,
          aggregated_output: 'Error: 1 test failed\nTypeError: boom',
        },
      },
      {},
    );
    // tool_use still emitted (for tracking), with the same id
    const tu = firstToolUse(msgs);
    expect(tu.id).toBe(itemId);

    // synthetic tool_result correlated to that tool_use id, carrying the output
    const results = toolResults(msgs);
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe(itemId);
    const text =
      typeof results[0].content === 'string'
        ? results[0].content
        : results[0].content.map((b: any) => b.text).join('\n');
    expect(text).toContain('TypeError: boom');
  });

  test('command_execution with non-zero exit_code (status completed) is treated as failed', () => {
    const msgs = mapCodexEventToSdkMessages(
      {
        type: 'item.completed',
        item: {
          id: 'cmd-fail-2',
          type: 'command_execution',
          status: 'completed',
          command: 'grep foo',
          exit_code: 2,
          aggregated_output: 'grep: error',
        },
      },
      {},
    );
    const results = toolResults(msgs);
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe('cmd-fail-2');
  });

  test('failed mcp_tool_call emits a user tool_result with correlating id', () => {
    const msgs = mapCodexEventToSdkMessages(
      {
        type: 'item.completed',
        item: { id: 'mcp-fail-1', type: 'mcp_tool_call', server: 'buildd', tool: 'buildd', status: 'failed' },
      },
      {},
    );
    const tu = firstToolUse(msgs);
    expect(tu.name).toBe('mcp__buildd__buildd');
    const results = toolResults(msgs);
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe('mcp-fail-1');
    expect(results[0].is_error).toBe(true);
  });

  test('item.completed error item does not throw and produces no tool_use', () => {
    const msgs = mapCodexEventToSdkMessages(
      { type: 'item.completed', item: { id: 'e1', type: 'error', message: 'boom' } },
      {},
    );
    expect(allToolUses(msgs)).toHaveLength(0);
  });

  test('unknown / non-mapped events produce no messages', () => {
    expect(mapCodexEventToSdkMessages({ type: 'turn.started' }, {})).toEqual([]);
    expect(mapCodexEventToSdkMessages({ type: 'turn.completed', usage: {} }, {})).toEqual([]);
    expect(mapCodexEventToSdkMessages({ type: 'item.started', item: { id: 'x', type: 'agent_message', text: 'partial' } }, {})).toEqual([]);
    expect(mapCodexEventToSdkMessages(null, {})).toEqual([]);
    expect(mapCodexEventToSdkMessages(undefined, {})).toEqual([]);
  });
});
