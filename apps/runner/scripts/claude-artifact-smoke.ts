#!/usr/bin/env bun
/**
 * Real-provider smoke for claude.ai artifact access (the opt-in from PR #3400).
 *
 *   # full: on a runner host with its own Claude login
 *   ARTIFACT_SMOKE_URL=<a claude.ai Design canvas that login may read> \
 *     bun apps/runner/scripts/claude-artifact-smoke.ts
 *
 *   # gate: anywhere, no login needed (CI: .github/workflows/claude-artifact-smoke.yml)
 *   ARTIFACT_SMOKE_MODE=gate bun apps/runner/scripts/claude-artifact-smoke.ts
 *
 * Runs the REAL Claude Code binary the runner bundles, with the agent env and
 * PreToolUse hook built by the runner's production functions
 * (buildAgentBaseEnv, applyClaudeAiArtifactEnv, HookFactory). The CI test that
 * mocks the SDK is __tests__/unit/claude-ai-artifacts-session.test.ts; this is
 * what only the real CLI (gate) and a real login plus canvas (full) can show.
 *
 * Checks, each reported pass | fail | unconfigured | unsupported:
 *   control-tools    no opt-in: the CLI offers no Artifact tool. Also notes
 *                    whether it offers DesignSync anyway (CLI 2.1.290 does), which
 *                    only the runner's always-on hook then refuses.
 *   optin-tools      opt-in at read: the CLI offers Artifact. The CLI decides
 *                    this before any API call, so it needs no credential and
 *                    the session is stopped at its init message.
 *   login            a machine Claude login exists (`claude login` or
 *                    CLAUDE_CODE_OAUTH_TOKEN). Full mode only.
 *   optin-read       the model lists the canvas, reads project/canvas.json (valid
 *                    JSON) and one project/*.dc.html through the gated session
 *   hook-denials     the production hook refuses publish and delete at read.
 *                    Hook calls only: no write or delete is ever sent to claude.ai.
 *   no-leak          the login token is absent from the evidence file and output
 *   docs-connector   claude.ai connectors (Claude Docs). Separate from artifact
 *                    access and never fails the run: `unsupported` when the login
 *                    cannot carry user:mcp_servers, `unconfigured` when it can but
 *                    no connector loads.
 *
 * Isolation: BUILDD_HOME and the session cwd are fresh temp dirs, and no
 * WorkerManager is started, so a dogfood runner on the same host keeps its
 * workers, state and slots. The login is read where it lives; it is never
 * copied or written.
 *
 * Evidence: $ARTIFACT_SMOKE_OUT/claude-artifact-smoke.json (default: a temp
 * dir, printed) with the commit SHA, runner and CLI versions, and every check.
 * The canvas URL and file contents are not recorded: only sizes and hashes.
 *
 * Exit: 0 all required checks pass; 1 a check failed; 78 unconfigured (full
 * mode with no login or no ARTIFACT_SMOKE_URL, so the read did not run). Gate
 * mode records login/read/docs as not exercised and does not require them. No
 * retries: one attempt per check, each under ARTIFACT_SMOKE_TIMEOUT_MS
 * (default 180s).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir, homedir } from 'os';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';

const ROOT = resolve(import.meta.dir, '../../..');
const BUILDD_HOME = mkdtempSync(join(tmpdir(), 'buildd-artifact-smoke-home-'));
// Before any runner module reads it.
process.env.BUILDD_HOME = BUILDD_HOME;

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { applyClaudeAiArtifactEnv } = await import('@buildd/shared');
const { buildAgentBaseEnv } = await import('../src/agent-env');
const { detectMachineLogin, hostModelCredentialValues } = await import('../src/host-seat');
const { HookFactory } = await import('../src/hook-factory');
const { resolveClaudeBinaryPath } = await import('../src/sdk-binary-path');

type Status = 'pass' | 'fail' | 'unconfigured' | 'unsupported';
interface Check { name: string; status: Status; detail: string; ms: number; required: boolean }

const MODE: 'full' | 'gate' = process.env.ARTIFACT_SMOKE_MODE === 'gate' ? 'gate' : 'full';
const CANVAS_URL = (process.env.ARTIFACT_SMOKE_URL ?? '').trim();
const TIMEOUT_MS = Number(process.env.ARTIFACT_SMOKE_TIMEOUT_MS ?? 180_000);
const OUT_DIR = process.env.ARTIFACT_SMOKE_OUT || mkdtempSync(join(tmpdir(), 'buildd-artifact-smoke-out-'));
const checks: Check[] = [];
let cliVersion: string | null = null;

function record(name: string, status: Status, detail: string, started: number, required = true) {
  checks.push({ name, status, detail, ms: Date.now() - started, required });
  console.log(`== ${name}: ${status.toUpperCase()} ${detail}`);
}

function gitSha(): string {
  if (process.env.BUILDD_SHA) return process.env.BUILDD_SHA;
  try { return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

function runnerVersion(): string {
  try { return JSON.parse(readFileSync(join(ROOT, 'apps/runner/package.json'), 'utf8')).version; } catch { return 'unknown'; }
}

/** The scopes the machine's `claude login` declares. Reads the scope list only. */
function loginScopes(): string[] | null {
  const file = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(file)) return null;
  try {
    const scopes = JSON.parse(readFileSync(file, 'utf8'))?.claudeAiOauth?.scopes;
    return Array.isArray(scopes) ? scopes.filter((s: unknown): s is string => typeof s === 'string') : null;
  } catch { return null; }
}

const hooks = new HookFactory({
  config: {},
  buildd: {} as any,
  addMilestone: () => {},
  emit: () => {},
  pendingPermissionRequests: new Map(),
} as any);
const smokeWorker = { id: 'artifact-smoke' } as any;

function sessionEnv(access: 'off' | 'read'): Record<string, string> {
  const env = buildAgentBaseEnv(process.env, { available: false } as any);
  env.BUILDD_HOME = BUILDD_HOME;
  return applyClaudeAiArtifactEnv(env, access);
}

interface SessionResult {
  init: any | null;
  toolResults: Array<{ tool: string; input: Record<string, unknown>; response: string }>;
  denied: string[];
  error: string | null;
}

/**
 * One SDK session. `initOnly` stops at the init message, before any model turn.
 */
async function runSession(access: 'off' | 'read', prompt: string, initOnly: boolean): Promise<SessionResult> {
  const out: SessionResult = { init: null, toolResults: [], denied: [], error: null };
  const cwd = mkdtempSync(join(tmpdir(), 'buildd-artifact-smoke-cwd-'));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const gate = hooks.createClaudeAiArtifactHook(smokeWorker, access);
  try {
    const q = query({
      prompt,
      options: {
        cwd,
        env: sessionEnv(access),
        abortController: abort,
        pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
        settingSources: [],
        maxTurns: 8,
        allowedTools: ['Artifact', 'ToolSearch'],
        disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
        hooks: {
          PreToolUse: [{
            hooks: [async (input: any, id: any, opts: any) => {
              const r: any = await gate(input, id, opts);
              if (r?.hookSpecificOutput?.permissionDecision === 'deny') out.denied.push(`${input.tool_name} ${input.tool_input?.action ?? ''}`.trim());
              return r;
            }],
          }],
          PostToolUse: [{
            hooks: [async (input: any) => {
              const resp = input.tool_response;
              out.toolResults.push({
                tool: input.tool_name,
                input: input.tool_input ?? {},
                response: typeof resp === 'string' ? resp : JSON.stringify(resp ?? ''),
              });
              return {};
            }],
          }],
        },
      } as any,
    });
    for await (const msg of q as AsyncIterable<any>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        out.init = msg;
        cliVersion ??= msg.claude_code_version ?? null;
        if (initOnly) { abort.abort(); break; }
      }
    }
  } catch (err) {
    if (!(initOnly && out.init)) out.error = abort.signal.aborted && !out.init ? `timed out after ${TIMEOUT_MS}ms` : String((err as Error)?.message ?? err);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

const hasArtifactTool = (init: any) => Array.isArray(init?.tools) && init.tools.includes('Artifact');

/** Pull the text a read returned: a JSON string field, or the raw response. */
function readBody(response: string): string {
  try {
    const parsed = JSON.parse(response);
    if (typeof parsed === 'string') return parsed;
    for (const k of ['content', 'text', 'data', 'file']) if (typeof parsed?.[k] === 'string') return parsed[k];
  } catch {}
  return response;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function main(): Promise<number> {
  console.log(`claude-artifact-smoke mode=${MODE} sha=${gitSha()} runner=${runnerVersion()} BUILDD_HOME=${BUILDD_HOME}`);
  let t = Date.now();

  // hook-denials: local, no tool executes.
  const readGate = hooks.createClaudeAiArtifactHook(smokeWorker, 'read');
  const deny = async (tool: string, input: Record<string, unknown>) =>
    ((await readGate({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input } as any, undefined, { signal: new AbortController().signal })) as any)
      ?.hookSpecificOutput?.permissionDecision === 'deny';
  const writes: Array<[string, Record<string, unknown>]> = [
    ['Artifact', { action: 'publish', file_path: 'x.html' }],
    ['Artifact', { file_path: 'x.html' }],
    ['Artifact', { action: 'delete', url: 'u' }],
    ['ArtifactData', { action: 'delete_asset', url: 'u' }],
  ];
  const allowedWrites: string[] = [];
  for (const [tool, input] of writes) if (!(await deny(tool, input))) allowedWrites.push(`${tool} ${input.action ?? '(default publish)'}`);
  const readOk = !(await deny('Artifact', { action: 'read', url: 'u', path: 'project/canvas.json' }));
  record('hook-denials', allowedWrites.length === 0 && readOk ? 'pass' : 'fail',
    allowedWrites.length ? `not refused: ${allowedWrites.join(', ')}` : readOk ? 'publish and delete refused, read allowed' : 'read refused at read level', t);

  // control-tools
  t = Date.now();
  const control = await runSession('off', 'Reply with OK.', true);
  if (control.error || !control.init) record('control-tools', 'fail', control.error ?? 'no init message', t);
  else {
    const designSync = control.init.tools.includes('DesignSync') ? '; DesignSync offered anyway (refused by the runner hook)' : '';
    record('control-tools', hasArtifactTool(control.init) ? 'fail' : 'pass',
      (hasArtifactTool(control.init) ? 'Artifact offered without the opt-in' : 'Artifact not offered') + designSync, t);
  }

  // optin-tools
  t = Date.now();
  const optin = await runSession('read', 'Reply with OK.', true);
  if (optin.error || !optin.init) record('optin-tools', 'fail', optin.error ?? 'no init message', t);
  else record('optin-tools', hasArtifactTool(optin.init) ? 'pass' : 'fail',
    hasArtifactTool(optin.init) ? 'Artifact offered' : `Artifact not offered (CLI ${cliVersion ?? '?'})`, t);

  const live = MODE === 'full';
  if (!live) {
    t = Date.now();
    record('login', 'unconfigured', 'gate mode: no login used', t, false);
    record('optin-read', 'unconfigured', 'gate mode: canvas read not exercised (needs a runner login and ARTIFACT_SMOKE_URL)', t, false);
    record('docs-connector', 'unconfigured', 'gate mode: not exercised', t, false);
    return finish();
  }

  // login
  t = Date.now();
  const login = detectMachineLogin();
  if (!login) {
    record('login', 'unconfigured', 'no machine Claude login (claude login or CLAUDE_CODE_OAUTH_TOKEN): the canvas read needs one', t);
    record('optin-read', 'unconfigured', 'no login', t);
    record('docs-connector', 'unconfigured', 'no login', t, false);
    return finish();
  }
  record('login', 'pass', `machine login: ${login}`, t);

  // docs-connector: separate from artifact access, never required.
  t = Date.now();
  const connectors = (optin.init?.mcp_servers ?? []).filter((s: any) => /^claude\.ai /i.test(s?.name ?? ''));
  const scopes = login === 'login' ? loginScopes() : null;
  if (connectors.length > 0) {
    record('docs-connector', 'pass', `claude.ai connectors: ${connectors.map((c: any) => `${c.name}=${c.status}`).join(', ')}`, t, false);
  } else if (login === 'env' || !scopes?.includes('user:mcp_servers')) {
    record('docs-connector', 'unsupported', login === 'env'
      ? 'env-token login (setup-token) is inference-only: no claude.ai connectors'
      : `login scopes lack user:mcp_servers (${scopes?.join(' ') ?? 'none recorded'})`, t, false);
  } else {
    record('docs-connector', 'unconfigured', 'user:mcp_servers granted but no claude.ai connector loaded (none enabled on the account?)', t, false);
  }

  // optin-read
  t = Date.now();
  if (!CANVAS_URL) {
    record('optin-read', 'unconfigured', 'ARTIFACT_SMOKE_URL not set: canvas read not exercised', t);
  } else if (!hasArtifactTool(optin.init)) {
    record('optin-read', 'fail', 'skipped: the opt-in session had no Artifact tool', t);
  } else {
    const read = await runSession('read', [
      `Use the Artifact tool on ${CANVAS_URL}. Do exactly these calls and nothing else:`,
      `1. Artifact action=list url=<that URL> scope=files`,
      `2. Artifact action=read url=<that URL> path=project/canvas.json`,
      `3. Artifact action=read on the first project/*.dc.html file the list returned.`,
      `Never publish, upload, pin or delete. Then reply DONE.`,
    ].join('\n'), false);
    const reads = read.toolResults.filter(r => r.tool === 'Artifact' && String(r.input.action ?? '') === 'read');
    const canvas = reads.find(r => String(r.input.path ?? '').endsWith('canvas.json'));
    const board = reads.find(r => /\.dc\.html$/.test(String(r.input.path ?? '')));
    const listed = read.toolResults.some(r => r.tool === 'Artifact' && String(r.input.action ?? '') === 'list');
    let canvasJson = false;
    if (canvas) { try { JSON.parse(readBody(canvas.response)); canvasJson = true; } catch {} }
    const boardBody = board ? readBody(board.response) : '';
    const ok = !read.error && listed && canvasJson && boardBody.length > 0 && read.denied.length === 0;
    record('optin-read', ok ? 'pass' : 'fail', [
      read.error ? `error: ${read.error}` : null,
      `list=${listed}`,
      `canvas.json=${canvas ? `${canvas.response.length}B json=${canvasJson} sha=${sha(canvas.response)}` : 'missing'}`,
      `dc.html=${board ? `${boardBody.length}B sha=${sha(boardBody)}` : 'missing'}`,
      read.denied.length ? `denied: ${read.denied.join(', ')}` : null,
    ].filter(Boolean).join(' '), t);
  }

  return finish();
}

function finish(): number {
  const failed = checks.filter(c => c.required && c.status === 'fail');
  const unconfigured = checks.filter(c => c.required && c.status === 'unconfigured');
  const overall: Status = failed.length ? 'fail' : unconfigured.length ? 'unconfigured' : 'pass';
  const evidence = {
    smoke: 'claude-artifact',
    mode: MODE,
    sha: gitSha(),
    runnerVersion: runnerVersion(),
    cliVersion,
    finishedAt: new Date().toISOString(),
    canvasConfigured: CANVAS_URL.length > 0,
    overall,
    checks,
  };
  let body = JSON.stringify(evidence, null, 2);

  // no-leak: the login token must not be anywhere in what is written.
  const t = Date.now();
  const secrets = hostModelCredentialValues(process.env).map(v => v.value).filter(v => v.length >= 8);
  const leaked = secrets.some(s => body.includes(s));
  checks.push({ name: 'no-leak', status: leaked ? 'fail' : 'pass', detail: leaked ? 'a host credential value is in the evidence' : `${secrets.length} host credential value(s) checked`, ms: Date.now() - t, required: true });
  console.log(`== no-leak: ${leaked ? 'FAIL' : 'PASS'}`);
  if (leaked) { evidence.overall = 'fail'; body = '{"smoke":"claude-artifact","overall":"fail","detail":"evidence withheld: it contained a credential"}'; }
  else body = JSON.stringify({ ...evidence, checks }, null, 2);

  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, 'claude-artifact-smoke.json');
  writeFileSync(file, body + '\n');
  const final = leaked ? 'fail' : overall;
  console.log(`== smoke ${final.toUpperCase()} (evidence: ${file})`);
  return final === 'pass' ? 0 : final === 'unconfigured' ? 78 : 1;
}

process.exit(await main());
