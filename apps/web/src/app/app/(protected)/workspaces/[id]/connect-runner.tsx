'use client';

import { useState } from 'react';

interface ConnectRunnerSectionProps {
  workspaceId: string;
  workspaceName: string;
  runners: {
    action: string[];
    service: string[];
    user: string[];
  };
}

type RunnerType = 'action' | 'service' | 'user';

const runnerMeta: Record<RunnerType, { label: string; description: string; emptyText: string }> = {
  action: { label: 'GitHub Actions', description: 'CI/CD runner for automated tasks', emptyText: 'No runners connected' },
  service: { label: 'Service Workers', description: 'Always-on VM or server', emptyText: 'No runners connected' },
  user: { label: 'User Workers', description: 'Your laptop via Claude Code', emptyText: 'No runners connected' },
};

export function ConnectRunnerSection({ workspaceId, workspaceName, runners }: ConnectRunnerSectionProps) {
  const [expanded, setExpanded] = useState<RunnerType | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [taskCreated, setTaskCreated] = useState(false);

  async function createSetupTask() {
    setCreatingTask(true);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          title: `Set up GitHub Actions runner for ${workspaceName}`,
          description: `Create a GitHub Actions workflow using the official anthropics/claude-code-action@v1 to process buildd tasks.

Steps:
1. Create .github/workflows/buildd.yml with the workflow from the connect-runner guide
2. Add BUILDD_API_KEY and CLAUDE_CODE_OAUTH_TOKEN to repository secrets
3. Test by manually triggering the workflow

The workflow should:
- Run on repository_dispatch (buildd-triggered) and workflow_dispatch (manual)
- Claim tasks from buildd, run Claude Code on them, and report completion
- Use anthropics/claude-code-action@v1 with OAuth token auth`,
          runnerPreference: 'user',
        }),
      });

      if (res.ok) {
        setTaskCreated(true);
      }
    } catch (error) {
      console.error('Failed to create task:', error);
    } finally {
      setCreatingTask(false);
    }
  }

  function toggle(type: RunnerType) {
    setExpanded(expanded === type ? null : type);
  }

  return (
    <div className="mb-8">
      <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-6">
        Runners
      </div>

      <div className="grid grid-cols-3 gap-4 mb-4">
        {(Object.keys(runnerMeta) as RunnerType[]).map((type) => {
          const meta = runnerMeta[type];
          const names = runners[type];
          const isExpanded = expanded === type;

          return (
            <button
              key={type}
              onClick={() => toggle(type)}
              className={`bg-surface-2 border rounded-[10px] p-4 text-left transition-colors cursor-pointer ${
                isExpanded ? 'border-primary bg-primary/5' : 'border-border-default hover:border-text-muted'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-sm">{meta.label}</span>
                {names.length > 0 && (
                  <span className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-status-success/10 text-status-success">
                    {names.length}
                  </span>
                )}
              </div>
              {names.length > 0 ? (
                <div className="text-xs text-text-muted truncate">{names.join(', ')}</div>
              ) : (
                <div className="text-xs text-text-muted">{meta.emptyText}</div>
              )}
            </button>
          );
        })}
      </div>

      {expanded === 'action' && (
        <div className="border border-primary/30 rounded-[10px] p-4 bg-primary/5">
          <h3 className="font-medium mb-3">Set up GitHub Actions Runner</h3>

          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Step 1: Create an Action account &amp; get OAuth token</div>
              <p className="text-sm text-text-secondary mb-2">
                Go to <a href="/app/accounts/new" className="text-primary hover:underline">Accounts &rarr; New Account</a> and select &quot;Action - GitHub Actions runner&quot; as the type.
              </p>
              <p className="text-sm text-text-secondary">
                You&apos;ll also need a <code className="bg-surface-4 px-1 rounded">CLAUDE_CODE_OAUTH_TOKEN</code> from your Claude Pro/Max subscription for the official <code className="bg-surface-4 px-1 rounded">claude-code-action</code>.
              </p>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 2: Connect account to this workspace</div>
              <p className="text-sm text-text-secondary mb-2">
                After creating the account, use the API to connect it to this workspace:
              </p>
              <pre className="bg-surface-1 text-text-primary p-3 rounded text-xs overflow-x-auto">
{`curl -X POST https://buildd.dev/api/workspaces/${workspaceId}/accounts \\
  -H "Content-Type: application/json" \\
  -d '{"accountId": "YOUR_ACCOUNT_ID", "canClaim": true}'`}
              </pre>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 3: Add GitHub Actions workflow</div>
              <p className="text-sm text-text-secondary mb-2">
                Create <code className="bg-surface-4 px-1 rounded">.github/workflows/buildd.yml</code>:
              </p>
              <pre className="bg-surface-1 text-text-primary p-3 rounded text-xs overflow-x-auto whitespace-pre">
{`name: Buildd Agent

on:
  repository_dispatch:
    types: [buildd-task]
  workflow_dispatch:
    inputs:
      task:
        description: 'Task description'
        required: false

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  process-task:
    runs-on: ubuntu-latest
    env:
      BUILDD_API_KEY: \${{ secrets.BUILDD_API_KEY }}
      BUILDD_SERVER: https://buildd.dev
    steps:
      - uses: actions/checkout@v4

      - name: Claim task from buildd
        id: claim
        run: |
          RESPONSE=$(curl -s -X POST "$BUILDD_SERVER/api/workers/claim" \\
            -H "Authorization: Bearer $BUILDD_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"maxTasks": 1}')
          WORKER_ID=$(echo $RESPONSE | jq -r '.workers[0].id // empty')
          TASK_DESC=$(echo $RESPONSE | jq -r '.workers[0].task.description // empty')
          TASK_TITLE=$(echo $RESPONSE | jq -r '.workers[0].task.title // empty')
          echo "worker_id=$WORKER_ID" >> $GITHUB_OUTPUT
          echo "task=$TASK_TITLE: $TASK_DESC" >> $GITHUB_OUTPUT

      - name: Run Claude Code
        if: steps.claim.outputs.worker_id != ''
        uses: anthropics/claude-code-action@v1
        with:
          prompt: \${{ steps.claim.outputs.task }}
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}

      - name: Report completion
        if: steps.claim.outputs.worker_id != ''
        run: |
          curl -s -X PATCH "$BUILDD_SERVER/api/workers/\${{ steps.claim.outputs.worker_id }}" \\
            -H "Authorization: Bearer $BUILDD_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"status": "completed"}'`}
              </pre>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 4: Add secrets</div>
              <p className="text-sm text-text-secondary">
                In your GitHub repo, go to Settings &rarr; Secrets &rarr; Actions and add:
              </p>
              <ul className="text-sm text-text-secondary list-disc list-inside mt-1">
                <li><code className="bg-surface-4 px-1 rounded">BUILDD_API_KEY</code> - Your action account API key (for task claim/report)</li>
                <li><code className="bg-surface-4 px-1 rounded">CLAUDE_CODE_OAUTH_TOKEN</code> - Claude Pro/Max OAuth token (for running Claude Code)</li>
              </ul>
            </div>

            <div className="pt-2 border-t border-primary/30">
              {taskCreated ? (
                <div className="text-sm text-status-success">
                  Setup task created! Check the tasks list.
                </div>
              ) : (
                <button
                  onClick={createSetupTask}
                  disabled={creatingTask}
                  className="px-4 py-2 bg-primary text-white rounded-[10px] hover:bg-primary-hover disabled:opacity-50 text-sm"
                >
                  {creatingTask ? 'Creating...' : 'Create setup task for an agent to help'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {expanded === 'service' && (
        <div className="border border-primary/30 rounded-[10px] p-4 bg-primary/5">
          <h3 className="font-medium mb-3">Set up Service Worker</h3>

          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Step 1: Create a Service account</div>
              <p className="text-sm text-text-secondary">
                Go to <a href="/app/accounts/new" className="text-primary hover:underline">Accounts &rarr; New Account</a> and select &quot;Service - Always-on server/VM&quot; as the type.
              </p>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 2: Run the agent</div>
              <p className="text-sm text-text-secondary mb-2">
                On your server, clone your repo and run:
              </p>
              <pre className="bg-surface-1 text-text-primary p-3 rounded text-xs overflow-x-auto">
{`cd your-repo
export BUILDD_API_KEY=bld_xxx
export BUILDD_SERVER=https://buildd.dev
export ANTHROPIC_API_KEY=sk-ant-xxx

# Run the agent (loops forever, claiming tasks)
bun run ~/buildd/apps/agent/src/index.ts --workspace-id=${workspaceId}`}
              </pre>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Or use systemd for persistent running:</div>
              <pre className="bg-surface-1 text-text-primary p-3 rounded text-xs overflow-x-auto">
{`# /etc/systemd/system/buildd-agent.service
[Unit]
Description=Buildd Agent
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/your-repo
Environment=BUILDD_API_KEY=bld_xxx
Environment=BUILDD_SERVER=https://buildd.dev
Environment=ANTHROPIC_API_KEY=sk-ant-xxx
ExecStart=/usr/local/bin/bun run /home/ubuntu/buildd/apps/agent/src/index.ts
Restart=always

[Install]
WantedBy=multi-user.target`}
              </pre>
            </div>
          </div>
        </div>
      )}

      {expanded === 'user' && (
        <div className="border border-primary/30 rounded-[10px] p-4 bg-primary/5">
          <h3 className="font-medium mb-3">Set up User Worker (Claude Code)</h3>

          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Step 1: Create a User account</div>
              <p className="text-sm text-text-secondary">
                Go to <a href="/app/accounts/new" className="text-primary hover:underline">Accounts &rarr; New Account</a> and select &quot;User - Personal laptop/workstation&quot; as the type.
              </p>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 2: Add MCP server to Claude Code</div>
              <p className="text-sm text-text-secondary mb-2">
                Run this command in your terminal:
              </p>
              <pre className="bg-surface-1 text-text-primary p-3 rounded text-xs overflow-x-auto whitespace-pre-wrap">
{`claude mcp add-json buildd '{"type":"stdio","command":"bun","args":["run","~/path/to/buildd/apps/mcp-server/src/index.ts"],"env":{"BUILDD_API_KEY":"YOUR_API_KEY","BUILDD_SERVER":"https://buildd.dev"}}'`}
              </pre>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 3: Use Claude Code</div>
              <p className="text-sm text-text-secondary">
                Open Claude Code in your repo and say:
              </p>
              <ul className="text-sm text-text-secondary list-disc list-inside mt-1">
                <li>&quot;Check buildd for tasks&quot;</li>
                <li>&quot;Claim a task from buildd&quot;</li>
                <li>&quot;Work on the buildd task&quot;</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
