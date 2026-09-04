/**
 * Tool visibility rules for the remote MCP server.
 *
 * These assert the two gates that decide what a caller is even told exists:
 * token level, and whether the workspace is data-class `sensitive`. Both were
 * previously only reachable through a full HTTP request and had no coverage.
 */

import { describe, it, expect } from 'bun:test';
import { actionsForLevel, listMcpTools, type McpAccountLevel } from './tools';

const LEVELS: McpAccountLevel[] = ['trigger', 'worker', 'admin'];

function toolNames(opts: { accountLevel: McpAccountLevel; isSensitive: boolean }): string[] {
  return listMcpTools(opts).map((t) => (t as { name: string }).name);
}

/** Tools that read or write team knowledge — all gated on data class. */
const KNOWLEDGE_TOOLS = ['buildd_memory', 'recall', 'learn'];

describe('listMcpTools — token level gating', () => {
  it('exposes the buildd tool at every level', () => {
    for (const accountLevel of LEVELS) {
      expect(toolNames({ accountLevel, isSensitive: false })).toContain('buildd');
    }
  });

  it('withholds worker coordination tools from trigger tokens', () => {
    const names = toolNames({ accountLevel: 'trigger', isSensitive: false });
    expect(names).not.toContain('check_path_claim');
    expect(names).not.toContain('send_worker_message');
  });

  it('exposes worker coordination tools to worker and admin tokens', () => {
    for (const accountLevel of ['worker', 'admin'] as McpAccountLevel[]) {
      const names = toolNames({ accountLevel, isSensitive: false });
      expect(names).toContain('check_path_claim');
      expect(names).toContain('send_worker_message');
    }
  });

  it('narrows the advertised action list to the caller level', () => {
    const trigger = actionsForLevel('trigger');
    const worker = actionsForLevel('worker');
    const admin = actionsForLevel('admin');

    // Each level is a strict superset of what the level below may call.
    expect(worker.length).toBeGreaterThan(trigger.length);
    expect(admin.length).toBeGreaterThan(worker.length);
    for (const action of worker) expect(admin).toContain(action);

    // Admin-only knowledge management is never advertised below admin.
    expect(admin).toContain('consolidate_knowledge');
    expect(worker).not.toContain('consolidate_knowledge');
    expect(trigger).not.toContain('consolidate_knowledge');
  });

  it('publishes the same action list in the schema enum and the description', () => {
    const [builddTool] = listMcpTools({ accountLevel: 'worker', isSensitive: false }) as Array<{
      inputSchema: { properties: { action: { enum: string[] } } };
    }>;
    expect(builddTool.inputSchema.properties.action.enum).toEqual(actionsForLevel('worker'));
  });
});

describe('listMcpTools — sensitive workspace gating', () => {
  it('does not expose knowledge tools for a sensitive workspace, at any level', () => {
    for (const accountLevel of LEVELS) {
      const names = toolNames({ accountLevel, isSensitive: true });
      for (const tool of KNOWLEDGE_TOOLS) expect(names).not.toContain(tool);
    }
  });

  it('exposes knowledge tools for a standard workspace', () => {
    const names = toolNames({ accountLevel: 'worker', isSensitive: false });
    for (const tool of KNOWLEDGE_TOOLS) expect(names).toContain(tool);
  });

  it('still exposes task coordination tools for a sensitive workspace', () => {
    // The data class gates knowledge, not the ability to do the work.
    const names = toolNames({ accountLevel: 'worker', isSensitive: true });
    expect(names).toContain('buildd');
    expect(names).toContain('check_path_claim');
    expect(names).toContain('send_worker_message');
  });
});
