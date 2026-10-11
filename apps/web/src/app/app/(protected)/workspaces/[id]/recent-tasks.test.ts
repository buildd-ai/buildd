/**
 * The workspace overview's recent tasks are rows: the display title (no
 * conventional-commit prefix) and the state. The task description is the
 * agent's prompt, markdown and all, so it is not a sub-line here.
 */
import { describe, expect, it } from 'bun:test';

const page = await Bun.file(new URL('./page.tsx', import.meta.url)).text();

describe('workspace overview recent tasks', () => {
  it('titles each task with displayTaskTitle', () => {
    expect(page).toContain("import { displayTaskTitle } from '@/lib/task-title'");
    expect(page).toContain('{displayTaskTitle(task.title)}');
    expect(page).not.toContain('>{task.title}<');
  });

  it('does not print the task description (the agent prompt) under it', () => {
    expect(page).not.toContain('{task.description}');
  });
});
