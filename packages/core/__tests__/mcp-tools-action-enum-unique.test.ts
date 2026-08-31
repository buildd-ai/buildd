/**
 * The action lists are published verbatim as a JSON Schema `enum` to every MCP
 * client, so a repeated entry ships a malformed schema.
 *
 * `get_task` was listed twice in both triggerActions and workerActions, which
 * put it twice in the `enum` (allActions spreads workerActions) and twice in
 * the human-readable "Available actions: …" description.
 *
 * These assert the invariant rather than the one fix: any future duplicate in
 * any list fails here, and the membership checks pin that dedup did not quietly
 * change which token level may call an action.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/mcp-tools-action-enum-unique.test.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  triggerActions,
  workerActions,
  adminActions,
  allActions,
  memoryActions,
} from '../mcp-tools';

const LISTS = {
  triggerActions,
  workerActions,
  adminActions,
  allActions,
  memoryActions,
} as const;

function duplicates(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const a of list) (seen.has(a) ? dup : seen).add(a);
  return [...dup].sort();
}

describe('MCP action enums contain no duplicates', () => {
  for (const [name, list] of Object.entries(LISTS)) {
    it(`${name} has each action exactly once`, () => {
      // Report the offenders, not just a count — a bare length compare tells the
      // next reader nothing about which entry to delete.
      expect({ list: name, duplicates: duplicates(list as readonly string[]) }).toEqual({
        list: name,
        duplicates: [],
      });
    });
  }
});

describe('dedup preserved action level membership', () => {
  it('get_task is still callable at trigger, worker and admin level', () => {
    expect(triggerActions).toContain('get_task');
    expect(workerActions).toContain('get_task');
    // admin inherits via allActions = [...workerActions, ...adminActions]
    expect(allActions).toContain('get_task');
  });

  it('get_task_messages kept its levels too', () => {
    expect(triggerActions).toContain('get_task_messages');
    expect(workerActions).toContain('get_task_messages');
  });

  it('worker level remains a superset of trigger level', () => {
    // Every action a trigger token may call, a worker token may also call.
    // handleBuilddAction relies on this: it computes the worker-only set as
    // workerActions minus triggerActions to decide what to reject.
    const missing = (triggerActions as readonly string[]).filter(
      a => !(workerActions as readonly string[]).includes(a),
    );
    expect(missing).toEqual([]);
  });
});
