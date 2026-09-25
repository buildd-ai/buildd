/**
 * Workers must act in their OWN worktree, never in the primary clone that
 * contains it.
 *
 * The runner nests every worktree inside the primary clone
 * (`<primary>/.buildd-worktrees/<slug>`). Agents were seen running
 * `cd <primary> && …` — editing, testing, stashing and committing in the shared
 * checkout. It drifted onto a stale branch with unpushed commits, stashes and
 * other tasks' edits, and commits there picked up other workers' leftovers.
 *
 * These pin the PreToolUse guard: Bash that `cd`s (or `git -C`/`--cwd`s) into
 * the primary clone or a sibling worktree is denied, Edit/Write there is
 * denied, and the worker's own worktree — itself a path under the primary —
 * stays fully usable. Reads are not this guard's business.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worktree-confinement.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { warnOnPrimaryCloneDrift, __setGitOpsDeps, __resetGitOpsDeps } from '../../src/git-operations';
import {
  classifyWorktreePath,
  findWorktreeEscape,
  findWriteEscape,
  describePrimaryCloneDrift,
} from '../../src/worktree-confinement';
import { HookFactory } from '../../src/hook-factory';
import { buildPromptWithComposition } from '../../src/prompt-builder';
import { primaryCloneMemoryExcludes } from '../../src/host-memory-excludes';

const PRIMARY = '/home/coder/project/demo';
const OWN = `${PRIMARY}/.buildd-worktrees/buildd-abc-my-task`;
const SIBLING = `${PRIMARY}/.buildd-worktrees/buildd-def-other-task`;
const scope = { worktreePath: OWN, primaryPath: PRIMARY };

describe('classifyWorktreePath', () => {
  test('own worktree root and files inside it are own', () => {
    expect(classifyWorktreePath(OWN, scope)).toBe('own');
    expect(classifyWorktreePath(`${OWN}/apps/web/page.tsx`, scope)).toBe('own');
  });

  test('the primary root and files in it are primary', () => {
    expect(classifyWorktreePath(PRIMARY, scope)).toBe('primary');
    expect(classifyWorktreePath(`${PRIMARY}/apps/web/page.tsx`, scope)).toBe('primary');
    expect(classifyWorktreePath(`${PRIMARY}/.buildd-worktrees`, scope)).toBe('primary');
  });

  test('a sibling worktree is other_worktree', () => {
    expect(classifyWorktreePath(SIBLING, scope)).toBe('other_worktree');
    expect(classifyWorktreePath(`${SIBLING}/x.ts`, scope)).toBe('other_worktree');
  });

  test('a path sharing only a string prefix with the worktree is not own', () => {
    expect(classifyWorktreePath(`${OWN}-evil/x.ts`, scope)).toBe('other_worktree');
  });

  test('paths outside the primary are outside', () => {
    expect(classifyWorktreePath('/tmp/scratch', scope)).toBe('outside');
    expect(classifyWorktreePath('/home/coder/project/demo-other', scope)).toBe('outside');
  });
});

describe('findWorktreeEscape — Bash', () => {
  const deny = (command: string, cwd = OWN) => findWorktreeEscape(command, { ...scope, cwd });

  test('cd into the primary clone is denied (the observed pattern)', () => {
    expect(deny(`cd ${PRIMARY} && bun run test`)).not.toBeNull();
    expect(deny(`cd "${PRIMARY}" && git stash`)).not.toBeNull();
    expect(deny(`cd ${PRIMARY}/apps/web; git commit -am wip`)).not.toBeNull();
    expect(deny(`pushd ${PRIMARY} >/dev/null && git status`)).not.toBeNull();
    expect(deny(`(cd ${PRIMARY} && git log -1)`)).not.toBeNull();
  });

  test('cd into a sibling worktree is denied', () => {
    expect(deny(`cd ${SIBLING} && git diff`)).not.toBeNull();
  });

  test('relative cd that climbs out of the worktree is denied', () => {
    expect(deny('cd ../.. && git status')).not.toBeNull();
    expect(deny('cd ../buildd-def-other-task')).not.toBeNull();
  });

  test('git -C / --cwd pointed at the primary clone is denied', () => {
    expect(deny(`git -C ${PRIMARY} status`)).not.toBeNull();
    expect(deny(`bun --cwd ${PRIMARY} run test`)).not.toBeNull();
    expect(deny(`bun --cwd=${PRIMARY}/apps/web run build`)).not.toBeNull();
  });

  test('a shell cwd already inside the primary clone is denied', () => {
    expect(deny('git status', PRIMARY)).not.toBeNull();
  });

  test('...unless the command first returns to its own worktree', () => {
    expect(deny(`cd ${OWN} && git status`, PRIMARY)).toBeNull();
  });

  test('the denial names the worktree path to use', () => {
    expect(deny(`cd ${PRIMARY} && ls`)).toContain(OWN);
  });

  test('own worktree, including absolute paths nested under the primary, is allowed', () => {
    expect(deny(`cd ${OWN} && bun run test`)).toBeNull();
    expect(deny(`cd ${OWN}/apps/runner && bun run test`)).toBeNull();
    expect(deny('cd apps/web && bun run build:only')).toBeNull();
    expect(deny(`git -C ${OWN} status`)).toBeNull();
    expect(deny('git status && git diff')).toBeNull();
  });

  test('reads of the primary clone without changing directory are allowed', () => {
    expect(deny(`cat ${PRIMARY}/package.json`)).toBeNull();
    expect(deny(`ls ${PRIMARY}`)).toBeNull();
    expect(deny(`grep -r foo ${PRIMARY}/docs`)).toBeNull();
  });

  test('cd outside the primary entirely is allowed', () => {
    expect(deny('cd /tmp && ls')).toBeNull();
    expect(deny('cd && ls')).toBeNull();
    expect(deny('cd ~ && ls')).toBeNull();
  });

  test('unresolvable targets fail open', () => {
    expect(deny('cd "$SOME_DIR" && ls')).toBeNull();
    expect(deny('cd - && ls')).toBeNull();
  });

  test('a cd inside a quoted string is not a directory change', () => {
    expect(deny(`echo "cd ${PRIMARY}" && git status`)).toBeNull();
    expect(deny(`git commit -m 'do not cd ${PRIMARY}'`)).toBeNull();
  });
});

describe('findWriteEscape — Edit/Write', () => {
  test('writing into the primary clone is denied', () => {
    expect(findWriteEscape(`${PRIMARY}/apps/web/page.tsx`, scope)).not.toBeNull();
  });

  test('writing into a sibling worktree is denied', () => {
    expect(findWriteEscape(`${SIBLING}/apps/web/page.tsx`, scope)).not.toBeNull();
  });

  test('writing into the own worktree is allowed (absolute and relative)', () => {
    expect(findWriteEscape(`${OWN}/apps/web/page.tsx`, scope)).toBeNull();
    expect(findWriteEscape('apps/web/page.tsx', scope)).toBeNull();
  });

  test('a relative path that climbs out is denied', () => {
    expect(findWriteEscape('../../apps/web/page.tsx', scope)).not.toBeNull();
  });

  test('writing outside the primary (scratch, tmp) is allowed', () => {
    expect(findWriteEscape('/tmp/scratch/notes.txt', scope)).toBeNull();
  });
});

describe('HookFactory.createWorktreeConfinementHook', () => {
  const factory = new HookFactory({
    config: {},
    buildd: {} as any,
    addMilestone: () => {},
    emit: () => {},
    pendingPermissionRequests: new Map(),
  });
  const worker = { id: 'w-test' } as any;
  const hook = factory.createWorktreeConfinementHook(worker, OWN, PRIMARY);
  const call = (tool_name: string, tool_input: Record<string, unknown>, cwd = OWN) =>
    hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd } as any, undefined, { signal: new AbortController().signal }) as Promise<any>;

  const decision = (r: any) => r?.hookSpecificOutput?.permissionDecision;

  test('denies Bash cd into the primary clone, naming the worktree', async () => {
    const r = await call('Bash', { command: `cd ${PRIMARY} && bun run test` });
    expect(decision(r)).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain(OWN);
  });

  test('denies Edit, Write, MultiEdit and NotebookEdit under the primary clone', async () => {
    expect(decision(await call('Edit', { file_path: `${PRIMARY}/a.ts` }))).toBe('deny');
    expect(decision(await call('Write', { file_path: `${SIBLING}/a.ts` }))).toBe('deny');
    expect(decision(await call('MultiEdit', { file_path: `${PRIMARY}/a.ts`, edits: [] }))).toBe('deny');
    expect(decision(await call('NotebookEdit', { notebook_path: `${PRIMARY}/n.ipynb` }))).toBe('deny');
  });

  test('allows its own worktree and reads', async () => {
    expect(await call('Bash', { command: `cd ${OWN}/apps/runner && bun run test` })).toEqual({});
    expect(await call('Edit', { file_path: `${OWN}/a.ts` })).toEqual({});
    expect(await call('Write', { file_path: 'relative/a.ts' })).toEqual({});
    expect(await call('Read', { file_path: `${PRIMARY}/CLAUDE.md` })).toEqual({});
  });

  test('ignores non-PreToolUse events', async () => {
    const r = await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `cd ${PRIMARY}` } } as any, undefined, { signal: new AbortController().signal });
    expect(r).toEqual({});
  });
});

// ─── Prompt: the agent is told its worktree, and only its worktree ─────────

describe('Git Workflow prompt names the worktree, never the primary clone', () => {
  const built = buildPromptWithComposition({
    task: { id: 'task-1', title: 'UI tweak', description: 'change a button' },
    worker: { id: 'worker-1', workspaceName: 'demo', branch: 'buildd/abc-ui', worktreePath: OWN },
    gitConfig: { branchingStrategy: 'feature', defaultBranch: 'dev', targetBranch: 'dev', requiresPR: true },
    isConfigured: true,
    compactResult: { count: 0 },
    taskSearchResults: [],
    fullObservations: [],
    inputPolicy: 'autonomous',
    hasApiKey: true,
  } as any);

  test('states the worktree path as the place to run every command', () => {
    expect(built.promptText).toContain(`\`${OWN}\``);
  });

  test('never names the primary clone path on its own', () => {
    expect(built.promptText.split(OWN).join('<WT>')).not.toContain(PRIMARY);
  });
});

// ─── Ancestor project memory ───────────────────────────────────────────────

describe('primaryCloneMemoryExcludes', () => {
  test('excludes project memory in the primary clone and the worktrees dir', () => {
    const ex = primaryCloneMemoryExcludes(OWN, PRIMARY);
    expect(ex).toContain(`${PRIMARY}/CLAUDE.md`);
    expect(ex).toContain(`${PRIMARY}/CLAUDE.local.md`);
    expect(ex).toContain(`${PRIMARY}/.claude/CLAUDE.md`);
    expect(ex).toContain(`${PRIMARY}/.claude/rules/**`);
    expect(ex).toContain(`${PRIMARY}/.buildd-worktrees/CLAUDE.md`);
  });

  test('never excludes the worktree own memory, nor anything above the primary', () => {
    const ex = primaryCloneMemoryExcludes(OWN, PRIMARY);
    expect(ex.some(p => p.startsWith(`${OWN}/`))).toBe(false);
    expect(ex.some(p => !p.startsWith(`${PRIMARY}/`))).toBe(false);
  });

  test('no worktree (cwd is the clone itself, or unrelated) → nothing excluded', () => {
    expect(primaryCloneMemoryExcludes(PRIMARY, PRIMARY)).toEqual([]);
    expect(primaryCloneMemoryExcludes('/tmp/role-dir', PRIMARY)).toEqual([]);
  });
});

// ─── Primary clone drift warning ───────────────────────────────────────────

describe('describePrimaryCloneDrift', () => {
  test('clean clone on its expected branch → no warning', () => {
    expect(describePrimaryCloneDrift({ branch: 'dev', expectedBranch: 'dev', dirtyEntries: 0, stashes: 0 })).toBeNull();
  });

  test('off its expected branch → warning names both branches', () => {
    const w = describePrimaryCloneDrift({ branch: 'mission/old', expectedBranch: 'dev', dirtyEntries: 0, stashes: 0 });
    expect(w).toContain('mission/old');
    expect(w).toContain('dev');
  });

  test('uncommitted changes or stashes → warning', () => {
    expect(describePrimaryCloneDrift({ branch: 'dev', expectedBranch: 'dev', dirtyEntries: 3, stashes: 0 })).toContain('3 uncommitted');
    expect(describePrimaryCloneDrift({ branch: 'dev', expectedBranch: 'dev', dirtyEntries: 0, stashes: 7 })).toContain('7 stash');
  });

  test('unknown branch (probe failed) is not itself a warning', () => {
    expect(describePrimaryCloneDrift({ branch: undefined, expectedBranch: 'dev', dirtyEntries: 0, stashes: 0 })).toBeNull();
  });
});

describe('warnOnPrimaryCloneDrift (probe)', () => {
  const deps = (outputs: Record<string, string | Error>) => ({
    execSync: ((cmd: string) => {
      const out = outputs[cmd];
      if (out instanceof Error) throw out;
      return out ?? '';
    }) as any,
    execFile: (() => {}) as any,
    existsSync: () => false,
    mkdirSync: (() => {}) as any,
    appendFileSync: () => {},
    readFileSync: (() => '') as any,
    rmSync: () => {},
    sessionLog: () => {},
  });

  afterEach(() => __resetGitOpsDeps());

  test('reports a primary clone that drifted onto another branch with stashes and edits', () => {
    __setGitOpsDeps(deps({
      'git rev-parse --abbrev-ref HEAD': 'mission/old-arc\n',
      'git status --porcelain': ' M apps/web/page.tsx\n?? scratch.txt\n',
      'git stash list': 'stash@{0}: WIP\nstash@{1}: WIP\n',
    }));
    const w = warnOnPrimaryCloneDrift(PRIMARY, 'dev', 'w-1');
    expect(w).toContain('mission/old-arc');
    expect(w).toContain('2 uncommitted');
    expect(w).toContain('2 stashes');
  });

  test('a pristine primary produces no warning', () => {
    __setGitOpsDeps(deps({ 'git rev-parse --abbrev-ref HEAD': 'dev\n' }));
    expect(warnOnPrimaryCloneDrift(PRIMARY, 'dev', 'w-1')).toBeNull();
  });

  test('a failing probe never throws', () => {
    __setGitOpsDeps(deps({
      'git rev-parse --abbrev-ref HEAD': new Error('not a git repo'),
      'git status --porcelain': new Error('boom'),
      'git stash list': new Error('boom'),
    }));
    expect(warnOnPrimaryCloneDrift(PRIMARY, 'dev', 'w-1')).toBeNull();
  });
});
