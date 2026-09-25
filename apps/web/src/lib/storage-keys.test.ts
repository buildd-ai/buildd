import { describe, it, expect } from 'bun:test';
import {
  MAX_OBJECT_FILENAME_LENGTH,
  safeObjectFilename,
  assertSafeKeySegment,
  buildArtifactKey,
  buildAttachmentKey,
  buildRoleConfigKey,
  buildAuditScreenshotKey,
  isAuditStorageKey,
  isOwnedStorageKey,
  assertNormalizedObjectKey,
} from './storage-keys';

describe('safeObjectFilename', () => {
  it('keeps a plain filename intact', () => {
    expect(safeObjectFilename('report.pdf')).toBe('report.pdf');
    expect(safeObjectFilename('My-File_v2.tar.gz')).toBe('My-File_v2.tar.gz');
  });

  it('reduces any path-shaped input to its trailing name component', () => {
    expect(safeObjectFilename('a/b/c.txt')).toBe('c.txt');
    expect(safeObjectFilename('../../probe.txt')).toBe('probe.txt');
    expect(safeObjectFilename('/etc/passwd')).toBe('passwd');
    expect(safeObjectFilename('..\\..\\probe.txt')).toBe('probe.txt');
  });

  it('never returns a value containing path structure', () => {
    const inputs = [
      '../../probe.txt',
      '..%2f..%2fprobe.txt',
      'a/../../b.txt',
      './../x',
      'dir/',
      '//',
      '..',
      '...',
      'C:\\Windows\\win.ini',
    ];
    for (const input of inputs) {
      const out = safeObjectFilename(input);
      expect(out).not.toContain('/');
      expect(out).not.toContain('\\');
      expect(out.startsWith('.')).toBe(false);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it('restricts the charset to unreserved filename characters', () => {
    expect(safeObjectFilename('sp ace&query?x=1#frag.txt')).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(safeObjectFilename('emoji-\u{1F600}.png')).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('caps the length', () => {
    const long = `${'a'.repeat(500)}.txt`;
    expect(safeObjectFilename(long).length).toBe(MAX_OBJECT_FILENAME_LENGTH);
  });

  it('falls back to a default when nothing usable survives', () => {
    expect(safeObjectFilename('')).toBe('file');
    expect(safeObjectFilename('..')).toBe('file');
    expect(safeObjectFilename('/')).toBe('file');
    expect(safeObjectFilename(undefined)).toBe('file');
    expect(safeObjectFilename(null)).toBe('file');
    expect(safeObjectFilename(42)).toBe('file');
    expect(safeObjectFilename('...', 'bundle.json')).toBe('bundle.json');
  });
});

describe('assertSafeKeySegment', () => {
  it('accepts identifier-shaped segments', () => {
    expect(assertSafeKeySegment('ws-123', 'workspaceId')).toBe('ws-123');
    expect(assertSafeKeySegment('4f9c1e2a-0000-4000-8000-000000000000', 'uploadId')).toBe(
      '4f9c1e2a-0000-4000-8000-000000000000',
    );
  });

  it('rejects segments that could add path structure', () => {
    const bad = ['..', 'a/b', 'a\\b', '', '.hidden', 'a..b', '/abs', 'a b', 'a?b', 'a%2fb'];
    for (const value of bad) {
      expect(() => assertSafeKeySegment(value, 'workspaceId')).toThrow();
    }
  });

  it('rejects non-string values', () => {
    expect(() => assertSafeKeySegment(undefined, 'workspaceId')).toThrow();
    expect(() => assertSafeKeySegment(null, 'workspaceId')).toThrow();
    expect(() => assertSafeKeySegment(123, 'workspaceId')).toThrow();
  });
});

describe('key builders', () => {
  const ws = 'ws-1';
  const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('builds a fixed-depth artifact key under the workspace prefix', () => {
    const key = buildArtifactKey(ws, uploadId, 'report.pdf');
    expect(key).toBe(`artifacts/${ws}/${uploadId}/report.pdf`);
    expect(key.split('/')).toHaveLength(4);
  });

  it('builds a fixed-depth attachment key under the workspace prefix', () => {
    const key = buildAttachmentKey(ws, uploadId, 'shot.png');
    expect(key).toBe(`attachments/${ws}/${uploadId}/shot.png`);
    expect(key.split('/')).toHaveLength(4);
  });

  it('keeps caller-supplied names from changing the depth or prefix of a key', () => {
    const names = ['../../probe.txt', 'a/b/c/d/e.txt', '/../..//x', '..'];
    for (const name of names) {
      for (const key of [
        buildArtifactKey(ws, uploadId, name),
        buildAttachmentKey(ws, uploadId, name),
      ]) {
        expect(key.split('/')).toHaveLength(4);
        expect(key).not.toContain('..');
        expect(key.startsWith(`artifacts/${ws}/`) || key.startsWith(`attachments/${ws}/`)).toBe(true);
      }
    }
  });

  it('throws rather than emitting a key when a structural segment is unsafe', () => {
    expect(() => buildArtifactKey('../other', uploadId, 'a.txt')).toThrow();
    expect(() => buildArtifactKey(ws, '..', 'a.txt')).toThrow();
    expect(() => buildAttachmentKey('..', uploadId, 'a.txt')).toThrow();
    expect(() => buildRoleConfigKey('../escape', 'a'.repeat(64))).toThrow();
    expect(() => buildRoleConfigKey('builder', '../escape')).toThrow();
  });

  it('builds a fixed-depth audit screenshot key whose qa/ segment LEADS the key', () => {
    // An R2 lifecycle rule matches a bucket-wide prefix, so the decay segment
    // has to be the first one: `artifacts/<ws>/qa/...` could not be matched
    // across workspaces.
    const key = buildAuditScreenshotKey(ws, uploadId, 'tasks-mobile.png');
    expect(key).toBe(`qa/${ws}/${uploadId}/tasks-mobile.png`);
    expect(key.split('/')).toHaveLength(4);
  });

  it('keeps a traversal filename from escaping the qa prefix', () => {
    for (const name of ['../../probe.png', 'a/b/c.png', '..']) {
      const key = buildAuditScreenshotKey(ws, uploadId, name);
      expect(key.split('/')).toHaveLength(4);
      expect(key).not.toContain('..');
      expect(key.startsWith(`qa/${ws}/`)).toBe(true);
    }
    expect(() => buildAuditScreenshotKey('../other', uploadId, 'a.png')).toThrow();
  });

  it('builds a role config key from a validated slug and content hash', () => {
    const hash = 'a'.repeat(64);
    expect(buildRoleConfigKey('builder', hash)).toBe(`roles/builder/${hash}.json`);
  });
});

describe('assertNormalizedObjectKey', () => {
  it('passes keys produced by the builders', () => {
    const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    for (const key of [
      buildArtifactKey('ws-1', uploadId, '../../probe.txt'),
      buildAttachmentKey('ws-1', uploadId, 'shot.png'),
      buildRoleConfigKey('builder', 'b'.repeat(64)),
    ]) {
      expect(assertNormalizedObjectKey(key)).toBe(key);
    }
  });

  it('rejects keys whose segments could be re-interpreted as path navigation', () => {
    const bad = [
      'artifacts/ws-1/u1/../../probe.txt',
      'artifacts/ws-1/./u1/a.txt',
      '/artifacts/ws-1/u1/a.txt',
      'artifacts//u1/a.txt',
      'artifacts/ws-1/u1/',
      'artifacts\\ws-1\\u1\\a.txt',
      'artifacts/ws-1/u1/a b.txt',
      '..',
      '',
    ];
    for (const key of bad) {
      expect(() => assertNormalizedObjectKey(key)).toThrow();
    }
  });

  it('rejects non-strings and absurd lengths', () => {
    expect(() => assertNormalizedObjectKey(undefined)).toThrow();
    expect(() => assertNormalizedObjectKey(null)).toThrow();
    expect(() => assertNormalizedObjectKey(1)).toThrow();
    expect(() => assertNormalizedObjectKey(`artifacts/${'a'.repeat(2000)}/x`)).toThrow();
  });
});

describe('isOwnedStorageKey', () => {
  const ws = 'ws-1';

  it('accepts keys this workspace owns', () => {
    expect(isOwnedStorageKey(`attachments/${ws}/u1/a.png`, ws)).toBe(true);
    expect(isOwnedStorageKey(`artifacts/${ws}/u1/a.png`, ws)).toBe(true);
  });

  it('accepts an audit screenshot key for its own workspace only', () => {
    expect(isOwnedStorageKey(`qa/${ws}/u1/a.png`, ws)).toBe(true);
    expect(isOwnedStorageKey('qa/ws-2/u1/a.png', ws)).toBe(false);
  });

  it('rejects keys belonging to another workspace', () => {
    expect(isOwnedStorageKey('attachments/ws-2/u1/a.png', ws)).toBe(false);
    expect(isOwnedStorageKey('artifacts/ws-2/u1/a.png', ws)).toBe(false);
  });

  it('rejects prefixes that are not caller-writable object areas', () => {
    expect(isOwnedStorageKey(`roles/${ws}/x.json`, ws)).toBe(false);
    expect(isOwnedStorageKey(`sessions/${ws}/x.json`, ws)).toBe(false);
    expect(isOwnedStorageKey(`${ws}/a.png`, ws)).toBe(false);
  });

  it('rejects keys that carry path structure or resolve outside the prefix', () => {
    const bad = [
      `attachments/${ws}/../../roles/builder/x.json`,
      `attachments/${ws}/..`,
      `/attachments/${ws}/u1/a.png`,
      `attachments/${ws}//a.png`,
      `attachments/${ws}/u1/a.png/`,
      `attachments/${ws}\\u1\\a.png`,
      `attachments/${ws}`,
      `attachments/${ws}/`,
    ];
    for (const key of bad) {
      expect(isOwnedStorageKey(key, ws)).toBe(false);
    }
  });

  it('rejects everything when there is no workspace to scope to', () => {
    expect(isOwnedStorageKey(`attachments/${ws}/u1/a.png`, null)).toBe(false);
    expect(isOwnedStorageKey(`attachments/${ws}/u1/a.png`, undefined)).toBe(false);
    expect(isOwnedStorageKey(`attachments/${ws}/u1/a.png`, '')).toBe(false);
  });

  it('rejects non-string keys', () => {
    expect(isOwnedStorageKey(undefined, ws)).toBe(false);
    expect(isOwnedStorageKey(null, ws)).toBe(false);
    expect(isOwnedStorageKey({ toString: () => `attachments/${ws}/u1/a.png` }, ws)).toBe(false);
  });
});

describe('isArtifactKeyForUpload', () => {
  it('matches the key buildArtifactKey mints for that workspace and upload id', async () => {
    const { buildArtifactKey, isArtifactKeyForUpload } = await import('./storage-keys');
    const key = buildArtifactKey('ws-1', 'up-1', 'shot.png');
    expect(isArtifactKeyForUpload(key, 'ws-1', 'up-1')).toBe(true);
  });
  it('rejects another upload id, another workspace, another area, extra depth, an empty name and non-strings', async () => {
    const { isArtifactKeyForUpload } = await import('./storage-keys');
    expect(isArtifactKeyForUpload('artifacts/ws-1/up-1/s.png', 'ws-1', 'up-2')).toBe(false);
    expect(isArtifactKeyForUpload('artifacts/ws-1/up-1/s.png', 'ws-2', 'up-1')).toBe(false);
    expect(isArtifactKeyForUpload('attachments/ws-1/up-1/s.png', 'ws-1', 'up-1')).toBe(false);
    expect(isArtifactKeyForUpload('artifacts/ws-1/up-1/x/s.png', 'ws-1', 'up-1')).toBe(false);
    expect(isArtifactKeyForUpload('artifacts/ws-1/up-1/', 'ws-1', 'up-1')).toBe(false);
    expect(isArtifactKeyForUpload(null, 'ws-1', 'up-1')).toBe(false);
  });
});

describe('isAuditStorageKey', () => {
  it('is true for a key the audit builder produced', () => {
    expect(isAuditStorageKey(buildAuditScreenshotKey('ws-1', 'u1', 'a.png'))).toBe(true);
  });

  it('is false for other tenant areas, including a qa segment that does not lead', () => {
    expect(isAuditStorageKey(buildArtifactKey('ws-1', 'u1', 'a.png'))).toBe(false);
    expect(isAuditStorageKey('artifacts/ws-1/qa/a.png')).toBe(false);
    expect(isAuditStorageKey('qa')).toBe(false);
  });

  it('is false for a malformed key and for non-strings', () => {
    expect(isAuditStorageKey('qa/../artifacts/ws-1/a.png')).toBe(false);
    expect(isAuditStorageKey('/qa/ws-1/u1/a.png')).toBe(false);
    expect(isAuditStorageKey(null)).toBe(false);
    expect(isAuditStorageKey(undefined)).toBe(false);
    expect(isAuditStorageKey(42)).toBe(false);
  });
});
