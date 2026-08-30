import { describe, it, expect } from 'bun:test';
import {
  SESSION_ARTIFACT_KINDS,
  SESSION_ARTIFACT_FILES,
  MAX_SESSION_ARTIFACT_BYTES,
  isSessionArtifactKind,
  sessionArtifactKey,
} from './session-artifact-keys';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const WORKER = '33333333-3333-4333-8333-333333333333';

describe('session-artifact-keys', () => {
  it('derives a deterministic key from team/workspace/worker ids', () => {
    const key = sessionArtifactKey({ teamId: TEAM, workspaceId: WORKSPACE, workerId: WORKER, kind: 'transcript' });
    expect(key).toBe(`sessions/${TEAM}/${WORKSPACE}/${WORKER}/transcript.jsonl`);
  });

  it('is stable across calls so an object is locatable from workers.id alone', () => {
    const a = sessionArtifactKey({ teamId: TEAM, workspaceId: WORKSPACE, workerId: WORKER, kind: 'session-log' });
    const b = sessionArtifactKey({ teamId: TEAM, workspaceId: WORKSPACE, workerId: WORKER, kind: 'session-log' });
    expect(a).toBe(b);
    expect(a).toBe(`sessions/${TEAM}/${WORKSPACE}/${WORKER}/session.log`);
  });

  it('never lands outside the sessions/ prefix', () => {
    for (const kind of SESSION_ARTIFACT_KINDS) {
      const key = sessionArtifactKey({ teamId: TEAM, workspaceId: WORKSPACE, workerId: WORKER, kind });
      expect(key.startsWith('sessions/')).toBe(true);
      expect(key.includes('..')).toBe(false);
    }
  });

  it('rejects path traversal in any id segment', () => {
    expect(() => sessionArtifactKey({ teamId: '../role-configs', workspaceId: WORKSPACE, workerId: WORKER, kind: 'transcript' })).toThrow();
    expect(() => sessionArtifactKey({ teamId: TEAM, workspaceId: 'a/b', workerId: WORKER, kind: 'transcript' })).toThrow();
    expect(() => sessionArtifactKey({ teamId: TEAM, workspaceId: WORKSPACE, workerId: '..', kind: 'transcript' })).toThrow();
    expect(() => sessionArtifactKey({ teamId: TEAM, workspaceId: WORKSPACE, workerId: '', kind: 'transcript' })).toThrow();
  });

  it('rejects an unknown kind rather than interpolating it', () => {
    expect(() => sessionArtifactKey({ teamId: TEAM, workspaceId: WORKSPACE, workerId: WORKER, kind: 'evil/../../x' as any })).toThrow();
  });

  it('validates kinds', () => {
    expect(isSessionArtifactKind('transcript')).toBe(true);
    expect(isSessionArtifactKind('session-log')).toBe(true);
    expect(isSessionArtifactKind('role-config')).toBe(false);
    expect(isSessionArtifactKind(undefined)).toBe(false);
  });

  it('exposes a content type per kind and a byte ceiling', () => {
    expect(SESSION_ARTIFACT_FILES.transcript.contentType).toBe('application/x-ndjson');
    expect(SESSION_ARTIFACT_FILES['session-log'].contentType).toBe('application/x-ndjson');
    expect(MAX_SESSION_ARTIFACT_BYTES).toBeGreaterThan(0);
    expect(MAX_SESSION_ARTIFACT_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});
