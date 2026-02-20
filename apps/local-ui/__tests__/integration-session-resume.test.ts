/**
 * Integration Test: Session Resume After Agent Completion
 *
 * Exercises the exact path users hit: agent does real work (commit),
 * completes, then user sends a follow-up message. Produces rich
 * diagnostics to identify WHERE the resume pipeline breaks.
 *
 * Resume layers (in workers.ts sendMessage()):
 *   Layer 1: SDK resume via sessionId on disk
 *   Layer 2: restartWithReconstructedContext() fallback
 *   Layer 3: text reconstruction (no sessionId)
 *
 * Requires: local-ui running on port 8766
 *
 * Run:
 *   BUILDD_TEST_SERVER=http://localhost:3000 bun test apps/local-ui/__tests__/integration-session-resume.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const BASE_URL = process.env.LOCAL_UI_URL || 'http://localhost:8766';
const TEST_TIMEOUT = 180_000; // 3 min — agent must commit + resume

// Require BUILDD_TEST_SERVER to be set — prevents accidental production hits
if (!process.env.BUILDD_TEST_SERVER) {
  console.log(
    '⏭️  Skipping: BUILDD_TEST_SERVER not set.\n' +
    '   Set it to a preview/local URL to run integration tests.\n' +
    '   Example: BUILDD_TEST_SERVER=http://localhost:3000 bun test apps/local-ui/__tests__/integration-session-resume.test.ts',
  );
  process.exit(0);
}

// Track resources for cleanup
const createdTaskIds: string[] = [];
const createdWorkerIds: string[] = [];

// --- API Helpers ---

async function api<T = any>(path: string, method = 'GET', body?: any): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(`API ${method} ${path} failed: ${res.status} ${JSON.stringify(error)}`);
  }

  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForWorker(
  workerId: string,
  options: { timeout?: number; pollInterval?: number } = {}
): Promise<any> {
  const { timeout = TEST_TIMEOUT, pollInterval = 2000 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const { workers } = await api<{ workers: any[] }>('/api/workers');
    const worker = workers.find(w => w.id === workerId);

    if (worker?.status === 'done' || worker?.status === 'error') {
      return worker;
    }

    await sleep(pollInterval);
  }

  throw new Error(`Worker ${workerId} did not complete within ${timeout}ms`);
}

async function sendMessage(workerId: string, message: string): Promise<void> {
  await api(`/api/workers/${workerId}/send`, 'POST', { message });
}

async function getWorker(workerId: string): Promise<any> {
  const { workers } = await api<{ workers: any[] }>('/api/workers');
  return workers.find(w => w.id === workerId);
}

async function getSessionLogs(workerId: string): Promise<any[]> {
  try {
    const { logs } = await api<{ logs: any[] }>(`/api/workers/${workerId}/logs?limit=200`);
    return logs || [];
  } catch {
    return [];
  }
}

// --- Diagnostic Helpers ---

interface DiagnosticState {
  workerId: string;
  status: string;
  sessionId: string | null;
  commits: number;
  milestones: string[];
  error: string | null;
  output: string[];
  logs: any[];
  resumeLayer: string;
  markerFound: boolean;
}

function formatDiagnostics(label: string, state: DiagnosticState): string {
  const sessionStarts = state.milestones.filter(m => m === 'Session started');
  return [
    `\n=== DIAGNOSTICS: ${label} ===`,
    `  Worker ID:     ${state.workerId}`,
    `  Status:        ${state.status}`,
    `  SessionId:     ${state.sessionId || 'MISSING'}`,
    `  Commits:       ${state.commits}`,
    `  Milestones:    ${state.milestones.join(' -> ')}`,
    `  Error:         ${state.error || 'none'}`,
    `  Session starts: ${sessionStarts.length}`,
    `  Resume layer:  ${state.resumeLayer}`,
    `  Logs (last 5): ${JSON.stringify(state.logs.slice(-5), null, 2)}`,
    `  Output contains marker: ${state.markerFound}`,
    `  Output (last 3): ${state.output.slice(-3).join(' | ')}`,
    `===`,
  ].join('\n');
}

function buildDiagnosticState(worker: any, logs: any[], marker: string): DiagnosticState {
  const milestones = (worker.milestones || []).map((m: any) => m.label);
  const output = worker.output || [];
  const commitMilestones = milestones.filter((l: string) =>
    l.toLowerCase().includes('commit') || l.toLowerCase().includes('git')
  );

  // Determine resume layer from logs
  let resumeLayer = 'unknown';
  const logTexts = logs.map((l: any) => typeof l === 'string' ? l : JSON.stringify(l));
  if (logTexts.some((l: string) => l.includes('resume=true') || l.includes('Resuming session'))) {
    resumeLayer = 'Layer 1 (SDK resume)';
  } else if (logTexts.some((l: string) => l.includes('reconstructed') || l.includes('reconstruction'))) {
    resumeLayer = 'Layer 2 (reconstruction)';
  } else if (logTexts.some((l: string) => l.includes('No sessionId'))) {
    resumeLayer = 'Layer 3 (text only)';
  }

  return {
    workerId: worker.id,
    status: worker.status,
    sessionId: worker.sessionId || null,
    commits: commitMilestones.length,
    milestones,
    error: worker.error || null,
    output,
    logs,
    resumeLayer,
    markerFound: output.join(' ').includes(marker),
  };
}

// --- Test Setup ---

let testWorkspaceId: string;
let testWorkspaceName: string;
let originalServer: string | null = null;
let tempRepoPath: string | null = null;

beforeAll(async () => {
  // Verify server is running
  try {
    const config = await api<{ configured: boolean; hasClaudeCredentials: boolean; builddServer?: string }>('/api/config');
    if (!config.hasClaudeCredentials) {
      throw new Error('No Claude credentials configured');
    }

    // Repoint local-ui to the test server if needed
    originalServer = config.builddServer || null;
    const testServer = process.env.BUILDD_TEST_SERVER!;
    if (config.builddServer !== testServer) {
      console.log(`Repointing local-ui: ${config.builddServer} → ${testServer}`);
      await api('/api/config/server', 'POST', { server: testServer });
    }
  } catch (err: any) {
    if (err.message?.includes('fetch failed')) {
      throw new Error(`Local-UI not running at ${BASE_URL}. Start with: bun run dev`);
    }
    throw err;
  }

  // Get a workspace for testing
  const { workspaces } = await api<{ workspaces: any[] }>('/api/workspaces');
  if (workspaces.length === 0) {
    throw new Error('No workspaces available for testing');
  }

  // Prefer buildd workspace for consistent testing
  const workspace = workspaces.find(w => w.name?.includes('buildd')) || workspaces[0];
  testWorkspaceId = workspace.id;
  testWorkspaceName = workspace.name;

  // Create a temporary git repo to isolate test commits from the real repo
  tempRepoPath = mkdtempSync(join(tmpdir(), 'buildd-test-resume-'));
  execSync('git init && git commit --allow-empty -m "initial"', {
    cwd: tempRepoPath,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' },
  });
  console.log(`Using workspace: ${workspace.name} (${testWorkspaceId})`);
  console.log(`Temporary repo: ${tempRepoPath}`);

  // Override workspace path to use the temp repo (agent runs here instead of real repo)
  await api('/api/debug/override', 'POST', {
    workspaceName: testWorkspaceName,
    localPath: tempRepoPath,
  });
  console.log(`Path override set: "${testWorkspaceName}" → ${tempRepoPath}`);
});

afterAll(async () => {
  // Cleanup: abort any running workers
  for (const workerId of createdWorkerIds) {
    try {
      await api('/api/abort', 'POST', { workerId });
    } catch {
      // Ignore - worker may already be done
    }
  }

  // Cleanup: delete test tasks from the server
  for (const taskId of createdTaskIds) {
    try {
      await api(`/api/tasks/${taskId}`, 'DELETE');
    } catch {
      // Ignore - task may already be deleted
    }
  }

  // Clean up temp repo (override becomes stale → resolver falls through to normal resolution)
  if (tempRepoPath) {
    try {
      rmSync(tempRepoPath, { recursive: true, force: true });
      console.log(`Cleaned up temp repo: ${tempRepoPath}`);
    } catch { /* best effort */ }
  }

  // Restore original server URL
  if (originalServer) {
    try {
      await api('/api/config/server', 'POST', { server: originalServer });
      console.log(`Restored local-ui server → ${originalServer}`);
    } catch { /* best effort */ }
  }
});

// --- Test ---

describe('Session Resume After Agent Completion', () => {
  test('agent creates commit, completes, then follow-up preserves context', async () => {
    const timestamp = Date.now();
    const marker = `SRTEST_${timestamp}`;
    const testFile = `test-session-resume-${timestamp}.txt`;

    let phase1Diag: DiagnosticState | null = null;
    let phase2Diag: DiagnosticState | null = null;
    let workerId: string | null = null;

    try {
      // === Phase 1: Agent creates a commit ===
      console.log('\n--- Phase 1: Creating task (agent will commit a file) ---');

      const { task } = await api('/api/tasks', 'POST', {
        title: `Session Resume Test ${timestamp}`,
        description: [
          `Create a file called "${testFile}" with the content "${marker}".`,
          `Commit it with message "test: session resume ${marker}".`,
          `Remember the secret code "${marker}".`,
          `Then say "done" and nothing else.`,
        ].join('\n'),
        workspaceId: testWorkspaceId,
      });
      createdTaskIds.push(task.id);
      expect(task.id).toBeTruthy();

      // Claim and start
      const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
      workerId = worker.id;
      createdWorkerIds.push(worker.id);
      expect(worker.status).toBe('working');

      console.log(`  Worker: ${worker.id}`);
      console.log('  Waiting for first completion...');

      // Wait for completion (agent needs time to create file + commit)
      const completedWorker = await waitForWorker(worker.id);

      // === Phase 2: Capture diagnostics after first completion ===
      console.log('\n--- Phase 2: Capturing post-completion diagnostics ---');

      const logs1 = await getSessionLogs(worker.id);
      phase1Diag = buildDiagnosticState(completedWorker, logs1, marker);
      console.log(formatDiagnostics('After first completion', phase1Diag));

      // Assert: worker completed successfully
      expect(completedWorker.status).toBe('done');

      // Assert: sessionId was captured (critical for Layer 1 resume)
      if (!completedWorker.sessionId) {
        console.warn('⚠️  sessionId is MISSING — Layer 1 (SDK resume) will not be attempted');
        console.warn('    Resume will fall through to Layer 3 (text reconstruction)');
      }

      // === Phase 3: Send follow-up message ===
      console.log('\n--- Phase 3: Sending follow-up message ---');

      await sendMessage(worker.id, `What was the secret code I told you to remember? What file did you create? Reply with just the code and filename.`);

      console.log('  Waiting for follow-up completion...');

      // Wait for the follow-up session to complete
      const resumedWorker = await waitForWorker(worker.id);

      // === Phase 4: Verify context preserved ===
      console.log('\n--- Phase 4: Verifying context preservation ---');

      const logs2 = await getSessionLogs(worker.id);
      phase2Diag = buildDiagnosticState(resumedWorker, logs2, marker);
      console.log(formatDiagnostics('After follow-up', phase2Diag));

      // Primary assertion: the agent recalled the marker
      const fullOutput = resumedWorker.output?.join(' ') || '';
      expect(fullOutput).toContain(marker);

      // Check how many "Session started" milestones exist
      const allMilestones = (resumedWorker.milestones || []).map((m: any) => m.label);
      const sessionStarts = allMilestones.filter((l: string) => l === 'Session started');
      console.log(`  Session starts: ${sessionStarts.length} (2 = expected: one per session)`);

      // The resumed worker should have completed successfully
      expect(resumedWorker.status).toBe('done');

      console.log('\n✅ Session resume test passed — context preserved across sessions');

    } catch (err) {
      // On failure: dump all diagnostics
      console.error('\n❌ Session resume test FAILED');

      if (phase1Diag) {
        console.error(formatDiagnostics('After first completion (on failure)', phase1Diag));
      } else if (workerId) {
        // Try to capture diagnostics even if phase 1 didn't complete cleanly
        try {
          const w = await getWorker(workerId);
          const logs = await getSessionLogs(workerId);
          if (w) {
            console.error(formatDiagnostics('Worker state at failure', buildDiagnosticState(w, logs, marker)));
          }
        } catch { /* best effort */ }
      }

      if (phase2Diag) {
        console.error(formatDiagnostics('After follow-up (on failure)', phase2Diag));
      }

      throw err;
    }
  }, TEST_TIMEOUT);
});
