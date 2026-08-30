/**
 * Object-key derivation for durable session diagnostics (transcripts + session logs).
 *
 * The key is derived SERVER-SIDE from the authenticated worker row and is never
 * accepted from the client. A client-supplied key would let a compromised runner
 * or agent overwrite arbitrary objects in the shared bucket — role-config
 * bundles, other tenants' artifacts, anything.
 *
 * Keys are deterministic so an object is locatable from the `workers.id` that
 * already exists in Postgres — no index row, no new table, no bulk payload in Neon.
 *
 * The key string itself is assembled by `buildSessionArtifactKey` in
 * `./storage-keys`, the single module allowed to assemble object keys
 * (`storage-keys.guard.test.ts` fails the build if a call site starts
 * assembling its own).
 */
import { buildSessionArtifactKey } from './storage-keys';

export const SESSION_ARTIFACT_KINDS = ['transcript', 'session-log'] as const;

export type SessionArtifactKind = (typeof SESSION_ARTIFACT_KINDS)[number];

export const SESSION_ARTIFACT_FILES: Record<
  SessionArtifactKind,
  { filename: string; contentType: string }
> = {
  transcript: { filename: 'transcript.jsonl', contentType: 'application/x-ndjson' },
  'session-log': { filename: 'session.log', contentType: 'application/x-ndjson' },
};

/**
 * Hard ceiling for a single session diagnostic object. Enforced twice: rejected
 * here at request time, and bound into the presigned signature as ContentLength
 * so the URL itself cannot be used to PUT an unbounded body.
 */
export const MAX_SESSION_ARTIFACT_BYTES = 8 * 1024 * 1024; // 8 MiB

/** UUID-shaped path segments only — no separators, no dots, no traversal. */
const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isSessionArtifactKind(value: unknown): value is SessionArtifactKind {
  return typeof value === 'string' && (SESSION_ARTIFACT_KINDS as readonly string[]).includes(value);
}

function segment(name: string, value: unknown): string {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value)) {
    throw new Error(`session artifact key: invalid ${name} segment`);
  }
  return value;
}

export function sessionArtifactKey(input: {
  teamId: string;
  workspaceId: string;
  workerId: string;
  kind: SessionArtifactKind;
}): string {
  if (!isSessionArtifactKind(input.kind)) {
    throw new Error('session artifact key: unknown kind');
  }
  const teamId = segment('teamId', input.teamId);
  const workspaceId = segment('workspaceId', input.workspaceId);
  const workerId = segment('workerId', input.workerId);
  const { filename } = SESSION_ARTIFACT_FILES[input.kind];
  return buildSessionArtifactKey(teamId, workspaceId, workerId, filename);
}
