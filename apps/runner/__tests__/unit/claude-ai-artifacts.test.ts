import { describe, test, expect } from 'bun:test';
import {
  parseClaudeAiArtifactAccess,
  resolveClaudeAiArtifactAccess,
  classifyArtifactToolCall,
  applyClaudeAiArtifactEnv,
  isClaudeAiArtifactTool,
  designSourceFromContext,
  patchClaudeAiArtifactsMetadata,
} from '@buildd/shared';
import { HookFactory } from '../../src/hook-factory';
import { RUNNER_DENIAL_MARKER } from '../../src/runner-denial';

describe('parseClaudeAiArtifactAccess', () => {
  test('accepts the three levels and true as read', () => {
    expect(parseClaudeAiArtifactAccess('off')).toBe('off');
    expect(parseClaudeAiArtifactAccess('read')).toBe('read');
    expect(parseClaudeAiArtifactAccess('publish')).toBe('publish');
    expect(parseClaudeAiArtifactAccess(true)).toBe('read');
    expect(parseClaudeAiArtifactAccess(false)).toBe('off');
  });

  test('anything else is unset, never an accidental opt-in', () => {
    for (const v of [undefined, null, '', 'yes', 'delete', 1, {}, []]) {
      expect(parseClaudeAiArtifactAccess(v)).toBeUndefined();
    }
  });
});

describe('resolveClaudeAiArtifactAccess', () => {
  test('default is off', () => {
    expect(resolveClaudeAiArtifactAccess({})).toBe('off');
    expect(resolveClaudeAiArtifactAccess({ roleMetadata: {}, taskContext: {} })).toBe('off');
  });

  test('role flag opts in', () => {
    expect(resolveClaudeAiArtifactAccess({ roleMetadata: { claudeAiArtifacts: 'read' } })).toBe('read');
    expect(resolveClaudeAiArtifactAccess({ roleMetadata: { claudeAiArtifacts: 'publish' } })).toBe('publish');
  });

  test('a task can opt in without a role flag', () => {
    expect(resolveClaudeAiArtifactAccess({ taskContext: { claudeAiArtifacts: 'read' } })).toBe('read');
  });

  test('a task can turn off a role that opted in', () => {
    expect(resolveClaudeAiArtifactAccess({
      roleMetadata: { claudeAiArtifacts: 'publish' },
      taskContext: { claudeAiArtifacts: 'off' },
    })).toBe('off');
  });

  test('a task can narrow a producer role to read', () => {
    expect(resolveClaudeAiArtifactAccess({
      roleMetadata: { claudeAiArtifacts: 'publish' },
      taskContext: { claudeAiArtifacts: 'read' },
    })).toBe('read');
  });

  test('publish needs a producer role: a task cannot grant it on its own', () => {
    expect(resolveClaudeAiArtifactAccess({ taskContext: { claudeAiArtifacts: 'publish' } })).toBe('read');
    expect(resolveClaudeAiArtifactAccess({
      roleMetadata: { claudeAiArtifacts: 'read' },
      taskContext: { claudeAiArtifacts: 'publish' },
    })).toBe('read');
  });

  test('citing a design source does not opt in by itself', () => {
    expect(resolveClaudeAiArtifactAccess({
      taskContext: { designSource: { sourceUrl: 'https://claude.ai/artifact/example' } },
    })).toBe('off');
  });
});

describe('applyClaudeAiArtifactEnv', () => {
  test('sets CLAUDE_CODE_ARTIFACT only when opted in', () => {
    const off: Record<string, string> = {};
    applyClaudeAiArtifactEnv(off, 'off');
    expect(off.CLAUDE_CODE_ARTIFACT).toBeUndefined();

    for (const level of ['read', 'publish'] as const) {
      const env: Record<string, string> = {};
      applyClaudeAiArtifactEnv(env, level);
      expect(env.CLAUDE_CODE_ARTIFACT).toBe('1');
    }
  });

  test('strips a CLAUDE_CODE_ARTIFACT that arrived another way (role env) when not opted in', () => {
    const env: Record<string, string> = { CLAUDE_CODE_ARTIFACT: '1' };
    applyClaudeAiArtifactEnv(env, 'off');
    expect(env.CLAUDE_CODE_ARTIFACT).toBeUndefined();
  });

  test('opted in: trades the umbrella no-traffic switch for its parts, so telemetry stays off', () => {
    const env: Record<string, string> = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    applyClaudeAiArtifactEnv(env, 'read');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    expect(env.DISABLE_TELEMETRY).toBe('1');
    expect(env.DISABLE_ERROR_REPORTING).toBe('1');
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env.DISABLE_BUG_COMMAND).toBe('1');
  });

  test('not opted in: the umbrella switch is left exactly as it was', () => {
    const env: Record<string, string> = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    applyClaudeAiArtifactEnv(env, 'off');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.DISABLE_TELEMETRY).toBeUndefined();
  });

  test('opted in on a host without the umbrella switch adds nothing else', () => {
    const env: Record<string, string> = {};
    applyClaudeAiArtifactEnv(env, 'read');
    expect(env).toEqual({ CLAUDE_CODE_ARTIFACT: '1' });
  });
});

describe('classifyArtifactToolCall', () => {
  test('recognises the artifact tool family only', () => {
    for (const t of ['Artifact', 'ArtifactData', 'ArtifactComments', 'ArtifactCheck', 'DesignSync']) {
      expect(isClaudeAiArtifactTool(t)).toBe(true);
    }
    for (const t of ['Read', 'Bash', 'mcp__buildd__buildd', 'artifact']) {
      expect(isClaudeAiArtifactTool(t)).toBe(false);
    }
  });

  test('read/list/get are allowed when opted in to read', () => {
    for (const action of ['read', 'list', 'list_assets', 'read_asset', 'list_types', 'status']) {
      expect(classifyArtifactToolCall('Artifact', { action }, 'read').allowed).toBe(true);
    }
    for (const action of ['list_projects', 'get_project', 'list_files', 'get_file']) {
      expect(classifyArtifactToolCall('DesignSync', { action }, 'read').allowed).toBe(true);
    }
  });

  test('publish (including the omitted-action default) is refused at read level', () => {
    expect(classifyArtifactToolCall('Artifact', { action: 'publish', file_path: 'x.html' }, 'read').allowed).toBe(false);
    expect(classifyArtifactToolCall('Artifact', { file_path: 'x.html' }, 'read').allowed).toBe(false);
    expect(classifyArtifactToolCall('Artifact', { action: 'upload_asset' }, 'read').allowed).toBe(false);
    expect(classifyArtifactToolCall('DesignSync', { action: 'write_files' }, 'read').allowed).toBe(false);
  });

  test('publish is allowed for producer roles', () => {
    expect(classifyArtifactToolCall('Artifact', { action: 'publish' }, 'publish').allowed).toBe(true);
    expect(classifyArtifactToolCall('Artifact', { file_path: 'x.html' }, 'publish').allowed).toBe(true);
  });

  test('delete is always denied, even for producer roles', () => {
    for (const level of ['off', 'read', 'publish'] as const) {
      expect(classifyArtifactToolCall('Artifact', { action: 'delete' }, level).allowed).toBe(false);
      expect(classifyArtifactToolCall('Artifact', { action: 'delete_asset' }, level).allowed).toBe(false);
      expect(classifyArtifactToolCall('ArtifactComments', { action: 'delete' }, level).allowed).toBe(false);
    }
  });

  test('everything is denied when not opted in', () => {
    expect(classifyArtifactToolCall('Artifact', { action: 'read' }, 'off').allowed).toBe(false);
    expect(classifyArtifactToolCall('Artifact', { action: 'list' }, 'off').allowed).toBe(false);
  });

  test('non-artifact tools are not this policy\'s business', () => {
    expect(classifyArtifactToolCall('Bash', { command: 'rm -rf /' }, 'off').allowed).toBe(true);
  });
});

describe('patchClaudeAiArtifactsMetadata (register_skill / update_skill)', () => {
  test('sets the flag and keeps every other metadata key', () => {
    const r = patchClaudeAiArtifactsMetadata({ routing: { whenToUse: 'x' } }, 'publish');
    expect(r).toEqual({ ok: true, metadata: { routing: { whenToUse: 'x' }, claudeAiArtifacts: 'publish' } });
  });

  test('off or null removes it', () => {
    for (const v of ['off', null, false]) {
      expect(patchClaudeAiArtifactsMetadata({ claudeAiArtifacts: 'read', a: 1 }, v)).toEqual({ ok: true, metadata: { a: 1 } });
    }
  });

  test('rejects anything else rather than guessing', () => {
    expect(patchClaudeAiArtifactsMetadata({}, 'delete').ok).toBe(false);
    expect(patchClaudeAiArtifactsMetadata({}, 'yes').ok).toBe(false);
  });
});

describe('designSourceFromContext', () => {
  test('reads sourceUrl and artifactKeys', () => {
    expect(designSourceFromContext({
      designSource: { sourceUrl: 'https://claude.ai/artifact/abc', artifactKeys: ['design:x/a', 7] },
    })).toEqual({ sourceUrl: 'https://claude.ai/artifact/abc', artifactKeys: ['design:x/a'] });
  });

  test('ignores a sourceUrl that is not a claude.ai artifact', () => {
    expect(designSourceFromContext({ designSource: { sourceUrl: 'https://evil.example/artifact/abc' } })).toBeNull();
    expect(designSourceFromContext({ designSource: { sourceUrl: 'javascript:alert(1)' } })).toBeNull();
  });

  test('null when absent or empty', () => {
    expect(designSourceFromContext(undefined)).toBeNull();
    expect(designSourceFromContext({})).toBeNull();
    expect(designSourceFromContext({ designSource: {} })).toBeNull();
  });
});

describe('HookFactory.createClaudeAiArtifactHook', () => {
  const factory = new HookFactory({
    config: {},
    buildd: {} as any,
    addMilestone: () => {},
    emit: () => {},
    pendingPermissionRequests: new Map(),
  });
  const worker = { id: 'w1' } as any;
  const call = (hook: any, tool_name: string, tool_input: Record<string, unknown>) =>
    hook({ hook_event_name: 'PreToolUse', tool_name, tool_input }, undefined, { signal: new AbortController().signal });

  test('denies delete with a runner denial, at every level', async () => {
    for (const level of ['read', 'publish'] as const) {
      const out = await call(factory.createClaudeAiArtifactHook(worker, level), 'Artifact', { action: 'delete', url: 'u' });
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain(RUNNER_DENIAL_MARKER);
    }
  });

  test('passes reads through untouched', async () => {
    const out = await call(factory.createClaudeAiArtifactHook(worker, 'read'), 'Artifact', { action: 'read', url: 'u' });
    expect(out).toEqual({});
  });

  test('denies publish at read level', async () => {
    const out = await call(factory.createClaudeAiArtifactHook(worker, 'read'), 'Artifact', { file_path: 'x.html' });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('ignores other tools', async () => {
    const out = await call(factory.createClaudeAiArtifactHook(worker, 'off'), 'Bash', { command: 'ls' });
    expect(out).toEqual({});
  });
});
