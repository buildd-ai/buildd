// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * How every surface names a task the viewer cannot see: an upstream or
 * dependent in a workspace outside their reach (spec e28018c2 R-6). Its facts
 * are resolved per viewer before they get here (`resolveDependencyHolders`,
 * lib/task-dependency-reach.ts). Pure.
 */
export const HIDDEN_TASK_WORDS = "a task in a workspace you can't see";
