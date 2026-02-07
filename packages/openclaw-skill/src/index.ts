/**
 * Buildd Skill for OpenClaw
 *
 * This module provides functions to interact with Buildd's task coordination API.
 * It can be used as a skill in OpenClaw or imported directly into any TypeScript project.
 */

const SERVER_URL = process.env.BUILDD_SERVER || 'https://app.buildd.dev';
const API_KEY = process.env.BUILDD_API_KEY || '';

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  workspaceId: string;
  workspace?: { name: string };
}

interface Worker {
  id: string;
  taskId: string;
  branch: string;
  task: Task;
}

interface ClaimResult {
  workers: Worker[];
}

// Store current worker context
let currentWorkerId: string | null = process.env.BUILDD_WORKER_ID || null;

async function apiCall<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  if (!API_KEY) {
    throw new Error('BUILDD_API_KEY environment variable is required');
  }

  const response = await fetch(`${SERVER_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Buildd API error: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * List available tasks from Buildd
 */
export async function listTasks(options?: {
  status?: 'pending' | 'assigned' | 'completed' | 'failed';
  limit?: number;
}): Promise<Task[]> {
  const data = await apiCall<{ tasks: Task[] }>('/api/tasks');
  let tasks = data.tasks || [];

  // Filter by status if provided
  if (options?.status) {
    tasks = tasks.filter(t => t.status === options.status);
  }

  // Sort pending first, then by priority
  tasks.sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (b.status === 'pending' && a.status !== 'pending') return 1;
    return (b.priority || 0) - (a.priority || 0);
  });

  // Apply limit
  if (options?.limit) {
    tasks = tasks.slice(0, options.limit);
  }

  return tasks;
}

/**
 * Claim a task from Buildd to work on
 */
export async function claimTask(options?: {
  workspaceId?: string;
}): Promise<Worker | null> {
  const data = await apiCall<ClaimResult>('/api/workers/claim', {
    method: 'POST',
    body: JSON.stringify({
      maxTasks: 1,
      workspaceId: options?.workspaceId,
      runner: 'openclaw',
    }),
  });

  const workers = data.workers || [];
  if (workers.length === 0) {
    return null;
  }

  // Store worker ID for progress/complete calls
  currentWorkerId = workers[0].id;
  return workers[0];
}

/**
 * Report progress on the current task
 */
export async function reportProgress(
  progress: number,
  message?: string
): Promise<void> {
  if (!currentWorkerId) {
    throw new Error('No active task. Call claimTask first.');
  }

  await apiCall(`/api/workers/${currentWorkerId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'running',
      ...(message && { currentAction: message }),
    }),
  });
}

/**
 * Mark the current task as completed
 */
export async function completeTask(summary?: string): Promise<void> {
  if (!currentWorkerId) {
    throw new Error('No active task. Call claimTask first.');
  }

  await apiCall(`/api/workers/${currentWorkerId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'completed',
    }),
  });

  // Clear worker ID
  currentWorkerId = null;
}

/**
 * Mark the current task as failed
 */
export async function failTask(error: string): Promise<void> {
  if (!currentWorkerId) {
    throw new Error('No active task. Call claimTask first.');
  }

  await apiCall(`/api/workers/${currentWorkerId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'failed',
      error,
    }),
  });

  // Clear worker ID
  currentWorkerId = null;
}

/**
 * Get the current worker ID (if a task is claimed)
 */
export function getCurrentWorkerId(): string | null {
  return currentWorkerId;
}

/**
 * Set the worker ID manually (useful when resuming work)
 */
export function setWorkerId(workerId: string): void {
  currentWorkerId = workerId;
}

// Export types
export type { Task, Worker, ClaimResult };
