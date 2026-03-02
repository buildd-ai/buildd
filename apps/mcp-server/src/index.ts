#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import {
  handleBuilddAction,
  handleMemoryAction,
  workerActions,
  adminActions,
  allActions as allActionsList,
  memoryActions,
  buildToolDescription,
  buildParamsDescription,
  buildMemoryDescription,
  type ApiFn,
  type ActionContext,
} from "@buildd/core/mcp-tools";
import { MemoryClient } from "@buildd/core/memory-client";
import { detectProjects } from "./detect-projects.js";

// ── Config ───────────────────────────────────────────────────────────────────

function loadBuilddConfig(): { apiKey?: string; builddServer?: string } {
  try {
    const configPath = join(homedir(), ".buildd", "config.json");
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const config = loadBuilddConfig();
const SERVER_URL = process.env.BUILDD_SERVER || config.builddServer || "https://buildd.dev";
const API_KEY = process.env.BUILDD_API_KEY || config.apiKey || "";
const EXPLICIT_WORKSPACE_ID = process.env.BUILDD_WORKSPACE_ID || process.env.BUILDD_WORKSPACE || "";
const WORKER_ID = process.env.BUILDD_WORKER_ID || "";
const MEMORY_API_URL = process.env.MEMORY_API_URL || "";
const MEMORY_API_KEY = process.env.MEMORY_API_KEY || "";

// ── Memory Client ────────────────────────────────────────────────────────────

let memoryClient: MemoryClient | null = null;

function getMemoryClient(): MemoryClient {
  if (memoryClient) return memoryClient;
  if (!MEMORY_API_URL || !MEMORY_API_KEY) {
    throw new Error(
      'Memory service not configured. Set MEMORY_API_URL and MEMORY_API_KEY environment variables.'
    );
  }
  memoryClient = new MemoryClient(MEMORY_API_URL, MEMORY_API_KEY);
  return memoryClient;
}

// Resolve workspace repo name for memory project scoping
let cachedProject: string | null = null;

async function getMemoryProject(): Promise<string | undefined> {
  if (cachedProject !== null) return cachedProject || undefined;

  // Use git remote to derive a stable project identifier
  const repoName = getRepoFullNameFromGit();
  if (repoName) {
    cachedProject = repoName;
    return repoName;
  }

  cachedProject = '';
  return undefined;
}

// ── Workspace Resolution ─────────────────────────────────────────────────────

let cachedWorkspaceId: string | null = null;

function getRepoFullNameFromGit(): string | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const sshMatch = remoteUrl.match(/git@github\.com:([^/]+\/[^.]+)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];

    const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^.]+)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];

    return null;
  } catch {
    return null;
  }
}

async function getWorkspaceIdFromRepo(repoFullName: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${SERVER_URL}/api/workspaces/by-repo?repo=${encodeURIComponent(repoFullName)}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.workspace?.id || null;
  } catch {
    return null;
  }
}

async function getWorkspaceId(): Promise<string | null> {
  if (EXPLICIT_WORKSPACE_ID) return EXPLICIT_WORKSPACE_ID;
  if (cachedWorkspaceId !== null) return cachedWorkspaceId || null;

  const repoFullName = getRepoFullNameFromGit();
  if (repoFullName) {
    cachedWorkspaceId = await getWorkspaceIdFromRepo(repoFullName);
    if (!cachedWorkspaceId) {
      console.error(
        `[buildd] Could not find a workspace matching "${repoFullName}". ` +
        `Create one at ${SERVER_URL}/app/workspaces/new or set BUILDD_WORKSPACE_ID.`
      );
      cachedWorkspaceId = "";
    }
    return cachedWorkspaceId || null;
  }

  cachedWorkspaceId = "";
  return null;
}

// ── Account Level ────────────────────────────────────────────────────────────

let cachedAccountLevel: 'worker' | 'admin' | null = null;

async function getAccountLevel(): Promise<'worker' | 'admin'> {
  if (cachedAccountLevel) return cachedAccountLevel;
  try {
    const response = await fetch(`${SERVER_URL}/api/accounts/me`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (response.ok) {
      const data = await response.json();
      cachedAccountLevel = data.level || 'worker';
      return cachedAccountLevel!;
    }
  } catch {
    // Default to worker
  }
  cachedAccountLevel = 'worker';
  return 'worker';
}

// ── API Helper ───────────────────────────────────────────────────────────────

const api: ApiFn = async (endpoint, options = {}) => {
  const response = await fetch(`${SERVER_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  return response.json();
};

// ── Skill Helpers (filesystem-dependent, kept local) ─────────────────────────

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      meta[key] = value;
    }
  }
  return { meta, body: match[2] };
}

function parseGitHubSource(source: string): { owner: string; repo: string; path: string; ref: string } {
  let rest = source.replace(/^github:/, '');

  let ref = '';
  const atIdx = rest.indexOf('@');
  if (atIdx > 0) {
    ref = rest.slice(atIdx + 1);
    rest = rest.slice(0, atIdx);
  }

  const parts = rest.split('/');
  return { owner: parts[0], repo: parts[1], path: parts.slice(2).join('/'), ref };
}

async function fetchGitHubSkill(gh: { owner: string; repo: string; path: string; ref: string }): Promise<string> {
  const filePath = gh.path || 'SKILL.md';
  const ref = gh.ref || 'main';
  const url = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${ref}/${filePath}`;

  const headers: Record<string, string> = {};
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (ghToken) headers['Authorization'] = `token ${ghToken}`;

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub fetch failed (${response.status}): ${url}`);
  return response.text();
}

/**
 * Handle register_skill with filesystem/GitHub resolution (stdio-only).
 * Falls through to shared handler if content is provided directly.
 */
async function handleRegisterSkill(params: Record<string, unknown>): Promise<void> {
  if (params.filePath) {
    const resolvedPath = resolve(params.filePath as string);
    if (!existsSync(resolvedPath)) throw new Error(`File not found: ${resolvedPath}`);
    const skillContent = readFileSync(resolvedPath, 'utf-8');
    const { meta } = parseFrontmatter(skillContent);
    params.name = (params.name as string) || meta.name;
    params.description = (params.description as string) || meta.description || undefined;
    params.content = skillContent;
    params.source = (params.source as string) || `file:${resolvedPath}`;
    delete params.filePath;
  } else if (params.repo) {
    const gh = parseGitHubSource(params.repo as string);
    const skillContent = await fetchGitHubSkill(gh);
    const { meta } = parseFrontmatter(skillContent);
    params.name = (params.name as string) || meta.name;
    params.description = (params.description as string) || meta.description || undefined;
    params.content = skillContent;
    params.source = (params.source as string) || (params.repo as string);
    delete params.repo;
  }
}

// ── Action Context ───────────────────────────────────────────────────────────

const ctx: ActionContext = {
  workerId: WORKER_ID || undefined,
  workspaceId: EXPLICIT_WORKSPACE_ID || undefined,
  getWorkspaceId,
  getLevel: getAccountLevel,
};

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "buildd", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
    instructions: WORKER_ID
      ? `Buildd is a task coordination system for AI coding agents. Two tools: \`buildd\` (task actions) and \`buildd_memory\` (workspace knowledge).

**Your task is already assigned.** Your worker ID is \`${WORKER_ID}\`. Do NOT call list_tasks or claim_task — your task was auto-claimed for you.

**Worker workflow:**
1. Do the work on the current branch.
2. Report progress at milestones (25%, 50%, 75%) via action=update_progress with workerId="${WORKER_ID}". Include plan param to submit a plan for review.
3. When done: push commits → action=create_pr → action=complete_task (with summary). If blocked, use action=complete_task with error param instead.

**IMPORTANT — Output types & completion:**
Each task has an \`outputRequirement\` that controls what you must produce before completing:
- **pr_required**: You MUST create a PR (code changes expected).
- **artifact_required**: You MUST create a PR or artifact (report, summary, etc.).
- **none**: No deliverable required — just complete with a summary. Use for simple questions, explorations, or tasks with no code changes.
- **auto** (default): If you made commits, you must create a PR or artifact. If no commits, complete freely.

**Match your workflow to the output type:**
- Code tasks (bug fix, feature, refactor) → make commits, push, create_pr, then complete_task.
- Research/analysis tasks → create_artifact with your findings, then complete_task.
- Simple/trivial tasks (greetings, questions, quick lookups) → just complete_task with a summary. No commits or PRs needed.

**PR creation:**
- Use \`action=create_pr\` (the buildd tool) instead of \`gh pr create\`. Do NOT use both — create_pr handles deduplication and tracks the PR on the worker.
- If you have no commits to push, skip create_pr and go straight to complete_task.

**Observability:**
- Use \`action=emit_event\` to record custom milestones (type, label, metadata) on the worker timeline.
- Use \`action=query_events\` to read back events from the worker timeline.

**Memory (REQUIRED):**
- BEFORE touching unfamiliar files, use \`buildd_memory\` action=search with keywords
- AFTER encountering a gotcha, pattern, or decision, use \`buildd_memory\` action=save IMMEDIATELY
- Use \`buildd_memory\` action=update to correct stale observations, action=delete to remove outdated ones.
- Observation types: **gotcha** (non-obvious bugs/traps), **pattern** (recurring code conventions), **decision** (architectural choices), **discovery** (learned behaviors/undocumented APIs), **architecture** (system structure/data flow)

**Pipeline patterns (optional):**
- Fan-out: create_task with parentTaskId linking children to a parent. The parent receives a CHILDREN_COMPLETED event when all children finish.
- The claim response for a parent task includes childResults with status and result of each child.`
      : `Buildd is a task coordination system for AI coding agents. Two tools: \`buildd\` (task actions) and \`buildd_memory\` (workspace knowledge).

**Worker workflow:**
1. \`buildd\` action=claim_task → checkout the returned branch → do the work. claim_task auto-assigns the highest-priority pending task — you do NOT pick a task by ID. Use list_tasks only to preview what's available.
2. Report progress at milestones (25%, 50%, 75%) via action=update_progress. Include plan param to submit a plan for review.
3. When done: push commits → action=create_pr → action=complete_task (with summary). If blocked, use action=complete_task with error param instead.

**IMPORTANT — Output types & completion:**
Each task has an \`outputRequirement\` that controls what you must produce before completing:
- **pr_required**: You MUST create a PR (code changes expected).
- **artifact_required**: You MUST create a PR or artifact (report, summary, etc.).
- **none**: No deliverable required — just complete with a summary. Use for simple questions, explorations, or tasks with no code changes.
- **auto** (default): If you made commits, you must create a PR or artifact. If no commits, complete freely.

**Match your workflow to the output type:**
- Code tasks (bug fix, feature, refactor) → make commits, push, create_pr, then complete_task.
- Research/analysis tasks → create_artifact with your findings, then complete_task.
- Simple/trivial tasks (greetings, questions, quick lookups) → just complete_task with a summary. No commits or PRs needed.

**PR creation:**
- Use \`action=create_pr\` (the buildd tool) instead of \`gh pr create\`. Do NOT use both — create_pr handles deduplication and tracks the PR on the worker.
- If you have no commits to push, skip create_pr and go straight to complete_task.

**Admin actions** (require admin-level API key): create_schedule, update_schedule, list_schedules, register_skill

**Observability:**
- Use \`action=emit_event\` to record custom milestones (type, label, metadata) on the worker timeline.
- Use \`action=query_events\` to read back events from the worker timeline.

**Memory (REQUIRED):**
- When you claim a task, relevant memory is included automatically. READ IT before starting.
- BEFORE touching unfamiliar files, use \`buildd_memory\` action=search with keywords
- AFTER encountering a gotcha, pattern, or decision, use \`buildd_memory\` action=save IMMEDIATELY
- Use \`buildd_memory\` action=update to correct stale observations, action=delete to remove outdated ones.
- Observation types: **gotcha** (non-obvious bugs/traps), **pattern** (recurring code conventions), **decision** (architectural choices), **discovery** (learned behaviors/undocumented APIs), **architecture** (system structure/data flow)

**Pipeline patterns (optional):**
- Fan-out: create_task with parentTaskId linking children to a parent. The parent receives a CHILDREN_COMPLETED event when all children finish.
- The claim response for a parent task includes childResults with status and result of each child.`,
  }
);

// ── Tool Listing (Dynamic Toolset) ───────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const level = await getAccountLevel();
  const filteredActions = level === 'admin'
    ? [...allActionsList, 'detect_projects']
    : [...workerActions, 'detect_projects'];

  const tools = [
    {
      name: "buildd",
      description: buildToolDescription(filteredActions),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            description: `Action to perform: ${filteredActions.join(", ")}`,
            enum: filteredActions,
          },
          params: {
            type: "object" as const,
            description: buildParamsDescription(filteredActions),
          },
        },
        required: ["action"],
      },
    },
    {
      name: "buildd_memory",
      description: `Search, save, and manage shared team memories (code patterns, gotchas, decisions). Actions: ${[...memoryActions].join(', ')}`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            description: `Action: ${[...memoryActions].join(', ')}`,
            enum: [...memoryActions],
          },
          params: {
            type: "object" as const,
            description: buildMemoryDescription(memoryActions),
          },
        },
        required: ["action"],
      },
    },
  ];

  return { tools };
});

// ── Tool Calls ───────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "buildd") {
      const action = args?.action as string;
      const params = (args?.params || {}) as Record<string, unknown>;

      // Stdio-specific: resolve filePath/repo for register_skill
      if (action === 'register_skill') {
        await handleRegisterSkill(params);
      }

      // Stdio-specific: detect monorepo projects from filesystem
      if (action === 'detect_projects') {
        const projects = detectProjects(params.rootDir as string | undefined);
        if (projects.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No projects detected. Ensure the directory has a package.json with a workspaces field.' }],
          };
        }
        const summary = projects.map(p => `- **${p.name}**: ${p.path}`).join('\n');
        return {
          content: [{ type: 'text' as const, text: `Detected ${projects.length} project(s):\n\n${summary}` }],
        };
      }

      // Stdio-specific: add env exports to claim_task response
      if (action === 'claim_task') {
        const result = await handleBuilddAction(api, action, params, ctx);
        if (!result.isError && result.content[0]) {
          const firstWorkerIdMatch = result.content[0].text.match(/\*\*Worker ID:\*\* (\S+)/);
          if (firstWorkerIdMatch) {
            const envExports = `\n\n---\n# For Claude Code hooks integration (optional - enables automatic activity tracking):\nexport BUILDD_WORKER_ID=${firstWorkerIdMatch[1]}\nexport BUILDD_SERVER=${SERVER_URL}`;
            result.content[0].text += envExports;
          }
        }
        return result;
      }

      return await handleBuilddAction(api, action, params, ctx);
    } else if (name === "buildd_memory") {
      const action = args?.action as string;
      const params = (args?.params || {}) as Record<string, unknown>;

      const project = await getMemoryProject();
      return await handleMemoryAction(getMemoryClient(), action, params, {
        project,
        workerId: WORKER_ID || undefined,
      });
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ],
      isError: true,
    };
  }
});

// ── Resources ────────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "buildd://tasks/pending",
        name: "Pending Tasks",
        description: "Pending tasks sorted by priority",
        mimeType: "text/plain",
      },
      {
        uri: "buildd://workspace/memory",
        name: "Workspace Memory",
        description: "Recent observations (code patterns, gotchas, decisions)",
        mimeType: "text/plain",
      },
      {
        uri: "buildd://workspace/skills",
        name: "Workspace Skills",
        description: "Available skills in the workspace",
        mimeType: "text/plain",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {
    case "buildd://tasks/pending": {
      const data = await api("/api/tasks");
      const allTasks = data.tasks || [];
      const wsId = EXPLICIT_WORKSPACE_ID || await getWorkspaceId();
      let pending = allTasks.filter((t: any) => t.status === "pending");
      if (wsId) pending = pending.filter((t: any) => t.workspaceId === wsId);
      pending.sort((a: any, b: any) => (b.priority || 0) - (a.priority || 0));

      const content = pending.length === 0
        ? "No pending tasks."
        : pending.map((t: any) =>
            `[P${t.priority}] ${t.title} (${t.id})\n  ${t.description?.slice(0, 150) || 'No description'}`
          ).join("\n\n");

      return {
        contents: [{
          uri,
          mimeType: "text/plain",
          text: content,
        }],
      };
    }

    case "buildd://workspace/memory": {
      try {
        const project = await getMemoryProject();
        const data = await getMemoryClient().getContext(project);
        return {
          contents: [{ uri, mimeType: "text/plain", text: data.markdown || "No memories yet." }],
        };
      } catch {
        return {
          contents: [{ uri, mimeType: "text/plain", text: "Memory service not configured or unavailable." }],
        };
      }
    }

    case "buildd://workspace/skills": {
      const wsId = EXPLICIT_WORKSPACE_ID || await getWorkspaceId();
      if (!wsId) {
        return {
          contents: [{ uri, mimeType: "text/plain", text: "No workspace detected." }],
        };
      }

      const data = await api(`/api/workspaces/${wsId}/skills`);
      const skills = data.skills || [];

      const content = skills.length === 0
        ? "No skills registered in workspace."
        : skills.map((s: any) =>
            `${s.name} (slug: ${s.slug})${s.enabled ? '' : ' [DISABLED]'}\n  ${s.description || 'No description'}`
          ).join("\n\n");

      return {
        contents: [{ uri, mimeType: "text/plain", text: content }],
      };
    }

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("buildd MCP server running");
}

main().catch(console.error);
