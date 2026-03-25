import Pusher from 'pusher-js';
import type { BuilddTask, WorkerCommand, LocalUIConfig, LocalWorker } from './types';
import type { BuilddClient } from './buildd';
import { saveWorker as storeSaveWorker } from './worker-store';

type EventHandler = (event: any) => void;
type CommandHandler = (workerId: string, command: WorkerCommand) => void;

/**
 * Callbacks the PusherManager needs from WorkerManager to interact
 * with worker state and lifecycle methods.
 */
export interface PusherManagerCallbacks {
  getWorkers: () => Map<string, LocalWorker>;
  emit: (event: any) => void;
  emitCommand: (workerId: string, command: WorkerCommand) => void;
  abort: (workerId: string) => Promise<void>;
  sendMessage: (workerId: string, text: string) => Promise<void>;
  rollback: (workerId: string, checkpointUuid: string) => Promise<void>;
  recover: (workerId: string, mode: 'diagnose' | 'complete' | 'restart') => Promise<void>;
  sendHeartbeat: () => void;
  claimPendingTasks: () => Promise<void>;
  claimAndStart: (task: BuilddTask) => Promise<LocalWorker | null>;
  getProbedWorkers: () => Set<string>;
}

export class PusherManager {
  private pusher?: Pusher;
  private pusherChannels = new Map<string, any>();
  private workspaceChannels = new Map<string, any>();
  private channelPrefix: string;
  private acceptRemoteTasks: boolean;
  private config: LocalUIConfig;
  private buildd: BuilddClient;
  private callbacks: PusherManagerCallbacks;
  private unresolvableTaskIds = new Set<string>();

  constructor(
    config: LocalUIConfig,
    buildd: BuilddClient,
    callbacks: PusherManagerCallbacks,
  ) {
    this.config = config;
    this.buildd = buildd;
    this.callbacks = callbacks;
    this.channelPrefix = config.pusherChannelPrefix || '';
    this.acceptRemoteTasks = config.acceptRemoteTasks !== false;
  }

  /**
   * Initialize the Pusher client and subscribe to channels.
   * Call this from the WorkerManager constructor after all other init.
   */
  initialize() {
    if (!this.config.pusherKey || !this.config.pusherCluster) return;

    this.pusher = new Pusher(this.config.pusherKey, {
      cluster: this.config.pusherCluster,
    });
    console.log('Pusher connected for command relay');

    // On reconnect, send immediate heartbeat and claim any tasks missed during disconnect
    this.pusher.connection.bind('state_change', (states: { previous: string; current: string }) => {
      if (states.current === 'connected' && states.previous !== 'initialized') {
        console.log(`Pusher reconnected (was ${states.previous}), sending immediate heartbeat`);
        this.callbacks.sendHeartbeat();
        // Claim any tasks that were created while Pusher was disconnected
        if (this.acceptRemoteTasks) {
          this.callbacks.claimPendingTasks().catch(err => {
            console.error('Failed to claim tasks on Pusher reconnect:', err);
          });
        }
      }
    });

    // Subscribe to workspace channels for task assignments if enabled
    if (this.acceptRemoteTasks) {
      this.subscribeToWorkspaceChannels();

      // Claim any pending tasks on startup (covers tasks dispatched while runner was down).
      // Runs after subscription so we don't miss events for tasks created between claim and subscribe.
      this.callbacks.claimPendingTasks().catch(err => {
        console.error('Failed to claim tasks on startup:', err);
      });
    }
  }

  /** Whether the Pusher client is connected */
  get isConnected(): boolean {
    return !!this.pusher;
  }

  setAcceptRemoteTasks(enabled: boolean) {
    this.acceptRemoteTasks = enabled;
    if (enabled && this.pusher) {
      this.subscribeToWorkspaceChannels();
    } else if (!enabled) {
      this.unsubscribeFromWorkspaceChannels();
    }
  }

  // Subscribe to workspace channels for task assignments
  async subscribeToWorkspaceChannels() {
    if (!this.pusher) return;

    try {
      // Get workspaces to determine channel names
      const workspaces = await this.buildd.listWorkspaces();
      if (workspaces.length === 0) {
        console.log('No workspaces found, skipping workspace channel subscription');
        return;
      }

      // Subscribe to each workspace for task:assigned events
      for (const ws of workspaces) {
        const channelName = `${this.channelPrefix}workspace-${ws.id}`;
        if (!this.workspaceChannels.has(channelName)) {
          const channel = this.pusher.subscribe(channelName);
          channel.bind('task:assigned', (data: { task: BuilddTask; targetLocalUiUrl?: string | null }) => {
            this.handleTaskAssignment(data);
          });
          this.workspaceChannels.set(channelName, channel);
          console.log(`Subscribed to ${channelName} for task assignments`);
        }
      }
    } catch (err) {
      console.error('Failed to subscribe to workspace channels:', err);
    }
  }

  unsubscribeFromWorkspaceChannels() {
    // Unsubscribe from workspace channels
    for (const [channelName, channel] of this.workspaceChannels) {
      channel.unbind('task:assigned');
      this.pusher?.unsubscribe(channelName);
    }
    this.workspaceChannels.clear();
  }

  async handleTaskAssignment(data: { task: BuilddTask; targetLocalUiUrl?: string | null }) {
    if (!this.acceptRemoteTasks) {
      console.log('Remote task assignment ignored (acceptRemoteTasks is disabled)');
      return;
    }

    const { task, targetLocalUiUrl } = data;

    // Skip tasks we already know can't be resolved
    if (this.unresolvableTaskIds.has(task.id)) {
      return;
    }

    // Check if this assignment is targeted at this runner instance
    // If targetLocalUiUrl is set, only accept if it matches our URL
    // If targetLocalUiUrl is null/undefined, any runner can accept (broadcast)
    if (targetLocalUiUrl && this.config.localUiUrl && targetLocalUiUrl !== this.config.localUiUrl) {
      console.log(`Task ${task.id} assigned to different runner: ${targetLocalUiUrl}`);
      return;
    }

    // Check if we have capacity
    const workers = this.callbacks.getWorkers();
    const activeWorkers = Array.from(workers.values()).filter(
      w => w.status === 'working' || w.status === 'stale'
    );
    if (activeWorkers.length >= this.config.maxConcurrent) {
      console.log(`Cannot accept task ${task.id}: at max capacity (${activeWorkers.length}/${this.config.maxConcurrent})`);
      return;
    }

    console.log(`Received task assignment: ${task.title} (${task.id})`);
    this.callbacks.emit({ type: 'task_assigned', task });

    // Auto-claim and start the task
    try {
      const worker = await this.callbacks.claimAndStart(task);
      if (worker) {
        console.log(`Successfully started assigned task: ${task.title}`);
      }
    } catch (err) {
      console.error(`Failed to start assigned task ${task.id}:`, err);
    }
  }

  // Subscribe to Pusher channel for worker commands
  subscribeToWorker(workerId: string) {
    if (!this.pusher || this.pusherChannels.has(workerId)) return;

    const channel = this.pusher.subscribe(`${this.channelPrefix}worker-${workerId}`);
    channel.bind('worker:command', (data: WorkerCommand) => {
      console.log(`Command received for worker ${workerId}:`, data);
      this.handleCommand(workerId, data);
    });

    // Resolution signals: server pushes completion/failure events so the runner
    // can immediately reconcile local state without waiting for the next sync.
    channel.bind('worker:completed', () => {
      const worker = this.callbacks.getWorkers().get(workerId);
      if (worker && worker.status !== 'done') {
        console.log(`[Worker ${workerId}] Pusher resolution: server confirmed completed`);
        worker.status = 'done';
        worker.completedAt = worker.completedAt || Date.now();
        this.callbacks.emit({ type: 'worker_update', worker });
        storeSaveWorker(worker);
      }
    });

    channel.bind('worker:failed', (data: any) => {
      const worker = this.callbacks.getWorkers().get(workerId);
      // Only apply if worker hasn't already completed locally
      if (worker && worker.status !== 'done' && worker.status !== 'error') {
        console.log(`[Worker ${workerId}] Pusher resolution: server marked failed`);
        worker.status = 'error';
        worker.error = data?.error || 'Task failed on server';
        worker.completedAt = worker.completedAt || Date.now();
        this.callbacks.emit({ type: 'worker_update', worker });
        this.callbacks.abort(workerId).catch(() => {});
      }
    });

    // Progress heartbeat: when the server confirms a progress update (from the agent's
    // update_progress MCP call), reset lastActivity. This prevents the hard timeout from
    // killing workers that are actively reporting progress even if the SDK stream is slow.
    channel.bind('worker:progress', () => {
      const worker = this.callbacks.getWorkers().get(workerId);
      if (worker && (worker.status === 'working' || worker.status === 'stale')) {
        worker.lastActivity = Date.now();
        // If worker was stale but server got progress, recover it
        if (worker.status === 'stale') {
          worker.status = 'working';
          this.callbacks.getProbedWorkers().delete(workerId);
          console.log(`[Worker ${workerId}] Recovered from stale via server progress`);
        }
      }
    });

    this.pusherChannels.set(workerId, channel);
  }

  unsubscribeFromWorker(workerId: string) {
    const channel = this.pusherChannels.get(workerId);
    if (channel) {
      this.pusher?.unsubscribe(`${this.channelPrefix}worker-${workerId}`);
      this.pusherChannels.delete(workerId);
    }
  }

  async handleCommand(workerId: string, command: WorkerCommand) {
    this.callbacks.emitCommand(workerId, command);

    switch (command.action) {
      case 'pause':
        // TODO: Implement pause (would need SDK support)
        console.log(`Pause requested for worker ${workerId}`);
        break;
      case 'resume':
        console.log(`Resume requested for worker ${workerId}`);
        break;
      case 'abort':
        await this.callbacks.abort(workerId);
        break;
      case 'message':
        if (command.text) {
          await this.callbacks.sendMessage(workerId, command.text);
        }
        break;
      case 'rollback':
        if (command.checkpointUuid) {
          await this.callbacks.rollback(workerId, command.checkpointUuid);
        }
        break;
      case 'recover':
        if (command.recoveryMode) {
          await this.callbacks.recover(workerId, command.recoveryMode);
        }
        break;
    }
  }

  /** Mark a task ID as unresolvable so future Pusher events skip it */
  markUnresolvable(taskId: string) {
    this.unresolvableTaskIds.add(taskId);
  }

  /** Disconnect Pusher and unsubscribe from all channels */
  destroy() {
    for (const workerId of this.pusherChannels.keys()) {
      this.unsubscribeFromWorker(workerId);
    }
    if (this.pusher) {
      this.pusher.disconnect();
    }
  }
}
