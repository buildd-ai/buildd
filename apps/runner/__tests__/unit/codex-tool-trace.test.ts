import { describe, expect, test } from 'bun:test';
import { mapCodexEventToSdkMessages } from '../../src/backends/codex-events';
import { ToolTraceRecorder } from '../../src/tool-trace';

/** Feed a Codex item.completed through the adapter and into the recorder, as workers.ts does. */
function trace(item: Record<string, unknown>) {
  const r = new ToolTraceRecorder({ taskId: 't', harness: 'codex', model: 'm', root: '/repo' });
  for (const m of mapCodexEventToSdkMessages({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'rg foo src', ...item } }, {})) {
    for (const b of m.message.content) {
      if (b.type === 'tool_use') r.onToolUse({ id: b.id, name: b.name, input: b.input });
      if (b.type === 'tool_result') r.onToolResult(b);
    }
  }
  r.close(); // unresolved calls finalise as unobserved
  return r.events[0];
}

describe('codex command results in the tool trace', () => {
  test('successful rg with matches is observed with exit 0 and output size', () => {
    const e = trace({ status: 'completed', exit_code: 0, aggregated_output: 'src/a.ts:1:foo\nsrc/b.ts:2:foo\n' });
    expect(e.resultObserved).toBe(true);
    expect(e.outcome).toBe('ok');
    expect(e.exitCode).toBe(0);
    expect(e.exitCodeBasis).toBe('structured');
    expect(e.output).toMatchObject({ bytes: 30, lines: 2 });
  });

  test('rg exit 1 is no_matches, not an error', () => {
    const e = trace({ status: 'completed', exit_code: 1, aggregated_output: '' });
    expect(e.resultObserved).toBe(true);
    expect(e.outcome).toBe('no_matches');
    expect(e.exitCode).toBe(1);
    expect(e.exitCodeBasis).toBe('structured');
  });

  test('failed command is observed as an error', () => {
    const e = trace({ command: 'cat nope', status: 'failed', exit_code: 2, aggregated_output: 'boom' });
    expect(e.resultObserved).toBe(true);
    expect(e.exitCode).toBe(2);
    expect(e.outcome).not.toBe('ok');
  });

  test('missing telemetry stays unobserved and nothing is invented', () => {
    const msgs = mapCodexEventToSdkMessages({ type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: 'rg foo', status: 'completed' } }, {});
    expect(msgs).toHaveLength(1); // tool_use only
    const e = trace({ status: 'completed' });
    expect(e.resultObserved).toBe(false);
    expect(e.outcome).toBe('unobserved');
    expect(e.exitCode).toBeNull();
    expect(e.output.bytes).toBeNull();
  });

  test('output without an exit code is measured but the exit code is only inferred', () => {
    const e = trace({ status: 'completed', aggregated_output: 'x\n' });
    expect(e.resultObserved).toBe(true);
    expect(e.exitCodeBasis).toBe('inferred');
    expect(e.output.lines).toBe(1);
  });
});
