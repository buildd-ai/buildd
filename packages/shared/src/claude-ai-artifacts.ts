/**
 * Opt-in access to claude.ai artifacts (Design canvases, pages) from a worker.
 *
 * Claude Code ships a first-party `Artifact` tool (plus `ArtifactData`,
 * `ArtifactComments`, `ArtifactCheck` and `DesignSync`) that reads and writes
 * the seat owner's claude.ai artifacts through the API with the session's OAuth
 * bearer. In Agent SDK sessions (every worker) the CLI withholds it
 * (`sdk_default_off`) unless the process env has `CLAUDE_CODE_ARTIFACT=1`, and
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` withholds it too
 * (`essential_traffic_only`). `"enableArtifact": true` in settings is a no-op.
 *
 * The tool acts as the account behind the team's Claude credential, and its
 * write actions (publish, upload, pin) and delete land in that person's
 * claude.ai account. So access is:
 *
 * - `off`     — default. Env unset; any artifact tool call is refused.
 * - `read`    — read/list/get only.
 * - `publish` — also publish/upload, for roles flagged as artifact producers.
 *
 * Delete is refused at every level: it is irreversible and no worker task
 * needs it.
 *
 * Where it is set: `workspaceSkills.metadata.claudeAiArtifacts` on the role,
 * and `task.context.claudeAiArtifacts` per task. The server resolves the two
 * at claim time and sends the result as `claudeAiArtifacts` on the claimed
 * worker; the runner applies the env and the PreToolUse gate from that.
 */

export type ClaudeAiArtifactAccess = 'off' | 'read' | 'publish';

/** The key on role metadata and on task context. */
export const CLAUDE_AI_ARTIFACTS_KEY = 'claudeAiArtifacts' as const;

/** Tools the CLI exposes once CLAUDE_CODE_ARTIFACT is on. */
export const CLAUDE_AI_ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
  'Artifact',
  'ArtifactData',
  'ArtifactComments',
  'ArtifactCheck',
  'DesignSync',
]);

export function isClaudeAiArtifactTool(toolName: string): boolean {
  return CLAUDE_AI_ARTIFACT_TOOLS.has(toolName);
}

/** `true` reads as `read`; anything unrecognised is `undefined` (unset), never an opt-in. */
export function parseClaudeAiArtifactAccess(value: unknown): ClaudeAiArtifactAccess | undefined {
  if (value === true) return 'read';
  if (value === false) return 'off';
  if (value === 'off' || value === 'read' || value === 'publish') return value;
  return undefined;
}

/**
 * Effective access for one session.
 *
 * The task wins when it says something, with one limit: `publish` needs a
 * producer role, so a task asking for it on any other role gets `read`.
 * A task citing `context.designSource` does NOT opt in by itself — without
 * the flag the worker uses the copy-in artifact keys.
 */
export function resolveClaudeAiArtifactAccess(input: {
  roleMetadata?: Record<string, unknown> | null;
  taskContext?: Record<string, unknown> | null;
}): ClaudeAiArtifactAccess {
  const role = parseClaudeAiArtifactAccess(input.roleMetadata?.[CLAUDE_AI_ARTIFACTS_KEY]) ?? 'off';
  const task = parseClaudeAiArtifactAccess(input.taskContext?.[CLAUDE_AI_ARTIFACTS_KEY]);
  if (task === undefined) return role;
  if (task === 'publish') return role === 'publish' ? 'publish' : 'read';
  return task;
}

/**
 * What `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` stands for in Claude Code.
 * An opted-in session drops the umbrella switch (it also kills the Artifact
 * tool) but keeps each of these, so telemetry, error reporting, the
 * auto-updater and /bug stay off.
 */
export const NONESSENTIAL_TRAFFIC_PARTS = [
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_AUTOUPDATER',
  'DISABLE_BUG_COMMAND',
] as const;

/**
 * Make the agent env match `access`. Mutates and returns `env`.
 *
 * Call it after every other source has written to the env (role env secrets
 * included), so this is the only thing that decides CLAUDE_CODE_ARTIFACT.
 */
export function applyClaudeAiArtifactEnv(
  env: Record<string, string>,
  access: ClaudeAiArtifactAccess,
): Record<string, string> {
  if (access === 'off') {
    delete env.CLAUDE_CODE_ARTIFACT;
    return env;
  }
  env.CLAUDE_CODE_ARTIFACT = '1';
  if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    for (const k of NONESSENTIAL_TRAFFIC_PARTS) env[k] = '1';
  }
  return env;
}

/**
 * Apply a `claudeAiArtifacts` value from register_skill / update_skill to a
 * role's metadata. `off`, `false` or `null` removes the key; an unknown value
 * is an error, never a silent opt-in.
 */
export function patchClaudeAiArtifactsMetadata(
  metadata: unknown,
  value: unknown,
): { ok: true; metadata: Record<string, unknown> } | { ok: false; error: string } {
  const meta = { ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {}) };
  const access = value === null ? 'off' : parseClaudeAiArtifactAccess(value);
  if (access === undefined) {
    return { ok: false, error: 'claudeAiArtifacts must be "off", "read" or "publish"' };
  }
  if (access === 'off') delete meta[CLAUDE_AI_ARTIFACTS_KEY];
  else meta[CLAUDE_AI_ARTIFACTS_KEY] = access;
  return { ok: true, metadata: meta };
}

export type ArtifactCallDecision = { allowed: true } | { allowed: false; reason: string };

function actionOf(input: Record<string, unknown>): string | null {
  for (const key of ['action', 'operation', 'method']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase();
  }
  return null;
}

const READ_ACTION = /^(read|list|get)(_|$)/;

/**
 * The permission policy for one artifact-tool call. Non-artifact tools are
 * always allowed (not this policy's business).
 *
 * `Artifact` with no `action` publishes `file_path` — the tool's default — so a
 * missing action is a write.
 */
export function classifyArtifactToolCall(
  toolName: string,
  input: Record<string, unknown>,
  access: ClaudeAiArtifactAccess,
): ArtifactCallDecision {
  if (!isClaudeAiArtifactTool(toolName)) return { allowed: true };
  const action = actionOf(input) ?? (toolName === 'Artifact' ? 'publish' : 'unknown');

  if (action.includes('delete')) {
    return { allowed: false, reason: `\`${toolName}\` ${action} is never allowed for workers: deleting from the owner's claude.ai account cannot be undone` };
  }
  if (access === 'off') {
    return { allowed: false, reason: `claude.ai artifact access is not enabled for this task or role, so \`${toolName}\` ${action} is refused` };
  }
  if (READ_ACTION.test(action) || action === 'status') return { allowed: true };
  if (access === 'publish') return { allowed: true };
  return { allowed: false, reason: `this role may only read claude.ai artifacts, and \`${toolName}\` ${action} writes to the owner's claude.ai account` };
}

export interface DesignSource {
  /** A claude.ai artifact URL (e.g. a Design canvas). */
  sourceUrl?: string;
  /** Copy-in fallback: buildd artifact keys holding each board's source. */
  artifactKeys?: string[];
}

const CLAUDE_AI_ARTIFACT_URL = /^https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+\/?$/;

/** `task.context.designSource`, validated. Null when there is nothing usable. */
export function designSourceFromContext(context: Record<string, unknown> | null | undefined): DesignSource | null {
  const raw = context?.designSource;
  if (!raw || typeof raw !== 'object') return null;
  const ds = raw as Record<string, unknown>;
  const out: DesignSource = {};
  if (typeof ds.sourceUrl === 'string' && CLAUDE_AI_ARTIFACT_URL.test(ds.sourceUrl.trim())) {
    out.sourceUrl = ds.sourceUrl.trim();
  }
  if (Array.isArray(ds.artifactKeys)) {
    const keys = ds.artifactKeys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0);
    if (keys.length > 0) out.artifactKeys = keys;
  }
  return out.sourceUrl || out.artifactKeys ? out : null;
}
