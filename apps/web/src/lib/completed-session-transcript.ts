/** Internal, read-only prerequisite for post-session analysis. No lifecycle hooks. */
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { config } from '@buildd/core/config';
import { eq } from 'drizzle-orm';
import { isTerminalWorkerStatus } from '@buildd/shared';
import { getDefaultStorageClient, isStorageConfigured } from './storage';
import { EvidenceReadError, openStoredEvidenceBody } from './evidence-read';
import { MAX_SESSION_ARTIFACT_BYTES, sessionArtifactKey } from './session-artifact-keys';

export interface CompletedTranscriptWorker {
  id: string;
  workspaceId: string | null;
  status: string;
  workspace: { teamId: string | null; dataClass: string } | null;
}
export type TranscriptMissingPortion = 'early_tool_calls' | 'early_messages' | 'early_output' | 'tail' | 'malformed_records' | 'unknown_coverage';

export interface CompletedSessionTranscript {
  traceAvailability: 'full' | 'truncated' | 'absent';
  source: { kind: 'session-diagnostics'; objectKey: string } | null;
  /** Early-window entries mean potentially missing: legacy headers count retained records only. */
  missingPortions: TranscriptMissingPortion[];
  reason: string | null;
  /** Original JSONL records; seq is per record type, not global chronological order. */
  records: Record<string, unknown>[];
}
export interface CompletedTranscriptDeps {
  loadWorker(id: string): Promise<CompletedTranscriptWorker | null | undefined>;
  open(key: string): Promise<AsyncIterable<Uint8Array>>;
}
const defaults: CompletedTranscriptDeps = {
  loadWorker: id => db.query.workers.findFirst({ where: eq(workers.id, id),
    columns: { id: true, workspaceId: true, status: true },
    with: { workspace: { columns: { teamId: true, dataClass: true } } } }),
  open: key => {
    if (!isStorageConfigured()) throw new Error('storage_unconfigured');
    return openStoredEvidenceBody(key, { client: getDefaultStorageClient(), bucket: config.storageBucket });
  },
};

/** Never throws or writes. Call only from trusted server code; this is not an access API. */
export async function readCompletedSessionTranscript(workerId: string, deps: CompletedTranscriptDeps = defaults): Promise<CompletedSessionTranscript> {
  const result: CompletedSessionTranscript = { traceAvailability: 'absent', source: null, missingPortions: [], reason: null, records: [] };
  try {
    const worker = await deps.loadWorker(workerId);
    if (!worker || worker.id !== workerId) return { ...result, reason: 'worker_missing' };
    if (!isTerminalWorkerStatus(worker.status)) return { ...result, reason: 'not_terminal' };
    if (worker.workspace?.dataClass === 'sensitive') return { ...result, reason: 'sensitive_workspace' };
    if (!worker.workspaceId || !worker.workspace?.teamId) return { ...result, reason: 'workspace_missing' };
    const key = sessionArtifactKey({ teamId: worker.workspace.teamId, workspaceId: worker.workspaceId, workerId, kind: 'transcript' });
    result.source = { kind: 'session-diagnostics', objectKey: key };
    const stream = await deps.open(key);
    const buffers: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > MAX_SESSION_ARTIFACT_BYTES) return { ...result, reason: 'read_size_limit' };
      buffers.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(buffers).toString('utf8');
    if (!text.trim()) return { ...result, reason: 'empty_object' };
    const missing = new Set<TranscriptMissingPortion>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record) || !['session', 'message', 'tool_call', 'milestone', 'output', 'truncated'].includes(record.type)) {
          missing.add('malformed_records'); continue;
        }
        if (record.type === 'tool_call' && (!record.toolCall || typeof record.toolCall !== 'object')) missing.add('malformed_records');
        if (record.type === 'session' && result.records.length > 0) missing.add('unknown_coverage');
        result.records.push(record);
        if (record.type === 'truncated') missing.add('tail');
      } catch { missing.add('malformed_records'); }
    }
    const header = result.records[0];
    if (header?.type !== 'session' || header.schemaVersion !== 1) missing.add('unknown_coverage');
    else {
      if (header.workerId !== workerId || header.workspaceId !== worker.workspaceId) return { ...result, records: [], reason: 'identity_mismatch' };
      for (const [type, field, early] of [['tool_call', 'toolCallCount', 'early_tool_calls'], ['message', 'messageCount', 'early_messages']] as const) {
        const count = header[field];
        const records = result.records.filter(r => r.type === type);
        if (!Number.isSafeInteger(count) || (count as number) < 0) missing.add('unknown_coverage');
        else {
          if ((count as number) >= 200) missing.add(early);
          if (records.length !== count) missing.add('tail');
          if (records.some((r, i) => r.seq !== i)) missing.add('unknown_coverage');
        }
      }
      // Runner output is independently a trailing window of 100 lines.
      if (result.records.filter(r => r.type === 'output').length >= 100) missing.add('early_output');
    }
    result.missingPortions = [...missing];
    result.traceAvailability = missing.size ? 'truncated' : 'full';
    return result;
  } catch (error) {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    result.reason = (error instanceof EvidenceReadError && error.status === 410) || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404 ? 'object_missing' : 'read_failed';
    return result;
  }
}
