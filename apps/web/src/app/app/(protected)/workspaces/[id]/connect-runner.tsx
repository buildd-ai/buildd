'use client';

import { useState } from 'react';

interface ConnectRunnerSectionProps {
  workspaceId: string;
  workspaceName: string;
}

export function ConnectRunnerSection({ workspaceId, workspaceName }: ConnectRunnerSectionProps) {
  const [showSetup, setShowSetup] = useState<'action' | 'service' | 'user' | null>(null);
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
          description: `Create a GitHub Actions workflow that runs buildd agent to process tasks.

Steps:
1. Create .github/workflows/buildd.yml with the workflow below
2. Add BUILDD_API_KEY and ANTHROPIC_API_KEY to repository secrets
3. Test by manually triggering the workflow

The workflow should:
- Run on workflow_dispatch (manual) and schedule (every 15 minutes)
- Claim tasks from buildd and work on them
- Use the buildd agent or MCP server`,
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

  return (
    <div className="mb-8">
      <h2 className="text-xl font-semibold mb-4">Connect a Runner</h2>

      <div className="grid grid-cols-3 gap-4 mb-4">
        <button
          onClick={() => setShowSetup(showSetup === 'action' ? null : 'action')}
          className={`p-4 border rounded-lg text-left hover:border-orange-500 transition-colors ${showSetup === 'action' ? 'border-orange-500 bg-orange-50 dark:bg-orange-950' : 'border-gray-200 dark:border-gray-800'}`}
        >
          <div className="font-medium">GitHub Actions</div>
          <div className="text-xs text-gray-500 mt-1">CI/CD runner for automated tasks</div>
        </button>

        <button
          onClick={() => setShowSetup(showSetup === 'service' ? null : 'service')}
          className={`p-4 border rounded-lg text-left hover:border-purple-500 transition-colors ${showSetup === 'service' ? 'border-purple-500 bg-purple-50 dark:bg-purple-950' : 'border-gray-200 dark:border-gray-800'}`}
        >
          <div className="font-medium">Service Worker</div>
          <div className="text-xs text-gray-500 mt-1">Always-on VM or server</div>
        </button>

        <button
          onClick={() => setShowSetup(showSetup === 'user' ? null : 'user')}
          className={`p-4 border rounded-lg text-left hover:border-blue-500 transition-colors ${showSetup === 'user' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-gray-200 dark:border-gray-800'}`}
        >
          <div className="font-medium">User Worker</div>
          <div className="text-xs text-gray-500 mt-1">Your laptop via Claude Code</div>
        </button>
      </div>

      {showSetup === 'action' && (
        <div className="border border-orange-200 dark:border-orange-800 rounded-lg p-4 bg-orange-50 dark:bg-orange-950/30">
          <h3 className="font-medium mb-3">Set up GitHub Actions Runner</h3>

          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Step 1: Create an Action account</div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Go to <a href="/app/accounts/new" className="text-blue-600 hover:underline">Accounts &rarr; New Account</a> and select &quot;Action - GitHub Actions runner&quot; as the type.
              </p>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 2: Connect account to this workspace</div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                After creating the account, use the API to connect it to this workspace:
              </p>
              <pre className="bg-gray-800 text-gray-100 p-3 rounded text-xs overflow-x-auto">
{`curl -X POST https://app.buildd.dev/api/workspaces/${workspaceId}/accounts \\
  -H "Content-Type: application/json" \\
  -d '{"accountId": "YOUR_ACCOUNT_ID", "canClaim": true}'`}
              </pre>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 3: Add GitHub Actions workflow</div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Create <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">.github/workflows/buildd.yml</code>:
              </p>
              <pre className="bg-gray-800 text-gray-100 p-3 rounded text-xs overflow-x-auto whitespace-pre">
{`name: Buildd Agent

on:
  workflow_dispatch:
  schedule:
    - cron: '*/15 * * * *'  # Every 15 minutes

jobs:
  process-tasks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Claim and process tasks
        env:
          BUILDD_API_KEY: \${{ secrets.BUILDD_API_KEY }}
          BUILDD_SERVER: https://app.buildd.dev
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          # Claim a task
          RESPONSE=$(curl -s -X POST "$BUILDD_SERVER/api/workers/claim" \\
            -H "Authorization: Bearer $BUILDD_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"maxTasks": 1, "workspaceId": "${workspaceId}"}')

          WORKER_ID=$(echo $RESPONSE | jq -r '.workers[0].id // empty')

          if [ -z "$WORKER_ID" ]; then
            echo "No tasks available"
            exit 0
          fi

          echo "Claimed worker: $WORKER_ID"

          # Update status to running
          curl -s -X PATCH "$BUILDD_SERVER/api/workers/$WORKER_ID" \\
            -H "Authorization: Bearer $BUILDD_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"status": "running"}'

          # TODO: Run Claude Code or your agent here
          # npx @anthropic-ai/claude-code --task "$(echo $RESPONSE | jq -r '.workers[0].task.description')"

          # Mark complete
          curl -s -X PATCH "$BUILDD_SERVER/api/workers/$WORKER_ID" \\
            -H "Authorization: Bearer $BUILDD_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"status": "completed"}'`}
              </pre>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 4: Add secrets</div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                In your GitHub repo, go to Settings &rarr; Secrets &rarr; Actions and add:
              </p>
              <ul className="text-sm text-gray-600 dark:text-gray-400 list-disc list-inside mt-1">
                <li><code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">BUILDD_API_KEY</code> - Your action account API key</li>
                <li><code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">ANTHROPIC_API_KEY</code> - Your Anthropic API key</li>
              </ul>
            </div>

            <div className="pt-2 border-t border-orange-200 dark:border-orange-800">
              {taskCreated ? (
                <div className="text-sm text-green-600 dark:text-green-400">
                  Setup task created! Check the tasks list.
                </div>
              ) : (
                <button
                  onClick={createSetupTask}
                  disabled={creatingTask}
                  className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 text-sm"
                >
                  {creatingTask ? 'Creating...' : 'Create setup task for an agent to help'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showSetup === 'service' && (
        <div className="border border-purple-200 dark:border-purple-800 rounded-lg p-4 bg-purple-50 dark:bg-purple-950/30">
          <h3 className="font-medium mb-3">Set up Service Worker</h3>

          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Step 1: Create a Service account</div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Go to <a href="/app/accounts/new" className="text-blue-600 hover:underline">Accounts &rarr; New Account</a> and select &quot;Service - Always-on server/VM&quot; as the type.
              </p>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 2: Run the agent</div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                On your server, clone your repo and run:
              </p>
              <pre className="bg-gray-800 text-gray-100 p-3 rounded text-xs overflow-x-auto">
{`cd your-repo
export BUILDD_API_KEY=bld_xxx
export BUILDD_SERVER=https://app.buildd.dev
export ANTHROPIC_API_KEY=sk-ant-xxx

# Run the agent (loops forever, claiming tasks)
bun run ~/buildd/apps/agent/src/index.ts --workspace-id=${workspaceId}`}
              </pre>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Or use systemd for persistent running:</div>
              <pre className="bg-gray-800 text-gray-100 p-3 rounded text-xs overflow-x-auto">
{`# /etc/systemd/system/buildd-agent.service
[Unit]
Description=Buildd Agent
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/your-repo
Environment=BUILDD_API_KEY=bld_xxx
Environment=BUILDD_SERVER=https://app.buildd.dev
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

      {showSetup === 'user' && (
        <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-4 bg-blue-50 dark:bg-blue-950/30">
          <h3 className="font-medium mb-3">Set up User Worker (Claude Code)</h3>

          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Step 1: Create a User account</div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Go to <a href="/app/accounts/new" className="text-blue-600 hover:underline">Accounts &rarr; New Account</a> and select &quot;User - Personal laptop/workstation&quot; as the type.
              </p>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 2: Add MCP server to Claude Code</div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Run this command in your terminal:
              </p>
              <pre className="bg-gray-800 text-gray-100 p-3 rounded text-xs overflow-x-auto whitespace-pre-wrap">
{`claude mcp add-json buildd '{"type":"stdio","command":"bun","args":["run","~/path/to/buildd/apps/mcp-server/src/index.ts"],"env":{"BUILDD_API_KEY":"YOUR_API_KEY","BUILDD_SERVER":"https://app.buildd.dev"}}'`}
              </pre>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Step 3: Use Claude Code</div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Open Claude Code in your repo and say:
              </p>
              <ul className="text-sm text-gray-600 dark:text-gray-400 list-disc list-inside mt-1">
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
