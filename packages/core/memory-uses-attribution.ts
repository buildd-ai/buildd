/**
 * The attribution check for memory use ledger rows (see verifyAttribution in
 * ./memory-retrieval). Its own module so the schema import stays out of
 * memory-retrieval's static graph.
 */
import { sql, type SQL } from 'drizzle-orm';
import { tasks, workers } from './db/schema';

/**
 * One query that says whether a retrieval's claimed task and worker are real
 * and belong to the workspace the rows are filed under: the task is in that
 * workspace, and the worker is in it too and is working that task. With no
 * task the worker is checked against the workspace alone.
 */
export function memoryAttributionCheckSql(args: {
  taskId: string | null;
  workerId: string | null;
  workspaceId: string;
}): SQL {
  const { taskId, workerId, workspaceId } = args;
  const taskOk = taskId
    ? sql`EXISTS (SELECT 1 FROM ${tasks} WHERE ${tasks.id} = ${taskId} AND ${tasks.workspaceId} = ${workspaceId})`
    : sql`false`;
  const workerOk = workerId
    ? taskId
      ? sql`EXISTS (SELECT 1 FROM ${workers} WHERE ${workers.id} = ${workerId} AND ${workers.workspaceId} = ${workspaceId} AND ${workers.taskId} = ${taskId})`
      : sql`EXISTS (SELECT 1 FROM ${workers} WHERE ${workers.id} = ${workerId} AND ${workers.workspaceId} = ${workspaceId})`
    : sql`false`;
  return sql`SELECT ${taskOk} AS task_ok, ${workerOk} AS worker_ok`;
}

