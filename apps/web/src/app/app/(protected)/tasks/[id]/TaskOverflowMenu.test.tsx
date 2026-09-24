/**
 * The ⋮ sheet is the only way to Edit / Reassign / View Source / Delete on
 * mobile, so every control inside it — including the nested confirm rows —
 * must meet the 44px tap target (min-h-11).
 */
import { describe, expect, it } from 'bun:test';
import { TASK_SHEET_ACTIONS_CLASS } from './TaskOverflowMenu';

describe('TaskOverflowMenu sheet actions', () => {
  it('gives every button and link in the sheet a 44px minimum height', () => {
    expect(TASK_SHEET_ACTIONS_CLASS).toContain('[&_button]:min-h-11');
    expect(TASK_SHEET_ACTIONS_CLASS).toContain('[&_a]:min-h-11');
  });

  it('keeps the top-level actions full width', () => {
    expect(TASK_SHEET_ACTIONS_CLASS).toContain('[&>*]:w-full');
  });
});
