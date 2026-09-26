import { describe, expect, test } from 'bun:test';
import { toolMilestone } from './tool-milestone';

describe('toolMilestone', () => {
  test('edits carry path and line counts with the runner label', () => {
    expect(toolMilestone({ tool: 'Edit', path: 'packages/pdf/src/invoice.tsx', add: 31, rem: 6 }, 5)).toEqual({
      type: 'action', label: 'Edited invoice.tsx', ts: 5, tool: 'Edit', path: 'packages/pdf/src/invoice.tsx', add: 31, rem: 6,
    });
  });

  test('writes default rem to 0; reads carry no counts; folded reads keep count', () => {
    expect(toolMilestone({ tool: 'Write', path: 'a/B.tsx', add: 30 }, 1)).toMatchObject({ label: 'Wrote B.tsx', add: 30, rem: 0 });
    const read = toolMilestone({ tool: 'Read', path: 'a/c.ts', count: 3 }, 1);
    expect(read).toMatchObject({ label: 'Read c.ts', count: 3 });
    expect(read).not.toHaveProperty('add');
  });

  test('bash carries the command and the Ran: label', () => {
    expect(toolMilestone({ tool: 'Bash', cmd: 'pnpm test' }, 1)).toEqual({ type: 'action', label: 'Ran: pnpm test', ts: 1, tool: 'Bash', cmd: 'pnpm test' });
  });
});
