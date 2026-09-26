import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isAuditScreenshotKeyForUpload, isArtifactKeyForUpload } from '../../../apps/web/src/lib/storage-keys';
import { artifactStorageKey, blobFileFor, contentTypeOf, storyBlobs, writeBlobs } from './blobs';
import { IdMap } from './story';

const ids = new IdMap('blobs-test');
ids.register('ws');
ids.register('shot');
ids.register('file');
const shot = { key: 'shot', type: 'screenshot', workspaceId: 'ws', _file: 'shots/a-desktop.png', metadata: { filename: 'a-desktop.png', mimeType: 'image/png' } };

describe('artifactStorageKey', () => {
  test('a screenshot gets the qa/ key upload-url mints, bound to the row id', () => {
    const key = artifactStorageKey(shot, ids)!;
    expect(key).toBe(`qa/${ids.get('ws')}/${ids.get('shot')}/a-desktop.png`);
    // The visual-audit evidence check accepts a shot only when its key is the
    // one minted for this workspace and this row id.
    expect(isAuditScreenshotKeyForUpload(key, ids.get('ws'), ids.get('shot'))).toBe(true);
  });

  test('any other file goes to the artifacts/ area', () => {
    const key = artifactStorageKey({ key: 'file', type: 'file', workspaceId: 'ws', _file: 'x/report.pdf' }, ids)!;
    expect(isArtifactKeyForUpload(key, ids.get('ws'), ids.get('file'))).toBe(true);
  });

  test('an artifact without _file has no object', () => {
    expect(artifactStorageKey({ key: 'shot', type: 'screenshot', workspaceId: 'ws' }, ids)).toBeNull();
  });
});

describe('storyBlobs + writeBlobs', () => {
  test('resolves _file next to the story and copies it under its key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-blobs-'));
    const story = join(dir, 'story.json');
    writeFileSync(story, '{}');
    mkdirSync(join(dir, 'shots'));
    writeFileSync(join(dir, 'shots/a-desktop.png'), 'png-bytes');
    const blobs = storyBlobs({ timeline: [], artifacts: [shot, { key: 'x', type: 'report' }] }, story, ids);
    expect(blobs).toEqual([{ key: artifactStorageKey(shot, ids)!, file: join(dir, 'shots/a-desktop.png'), contentType: 'image/png' }]);
    const root = join(dir, 'blobs');
    expect(writeBlobs(blobs, root)).toBe(1);
    expect(readFileSync(join(root, blobs[0].key), 'utf8')).toBe('png-bytes');
  });

  test('a missing _file fails the seed instead of rendering an expired tile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-blobs-'));
    expect(() => storyBlobs({ timeline: [], artifacts: [shot] }, join(dir, 'story.json'), ids)).toThrow(/_file not found/);
  });
});

describe('blobFileFor', () => {
  const root = '/srv/blobs';
  test('a path-style GET for the bucket maps to <root>/<key>', () => {
    expect(blobFileFor(root, 'buildd-demo', '/buildd-demo/qa/ws/id/a-desktop.png')).toBe('/srv/blobs/qa/ws/id/a-desktop.png');
  });
  test('another bucket, traversal and encoded separators resolve to nothing', () => {
    expect(blobFileFor(root, 'buildd-demo', '/other/qa/ws/id/a.png')).toBeNull();
    expect(blobFileFor(root, 'buildd-demo', '/buildd-demo/../etc/passwd')).toBeNull();
    expect(blobFileFor(root, 'buildd-demo', '/buildd-demo/qa/..%2F..%2Fetc/passwd')).toBeNull();
    expect(blobFileFor(root, 'buildd-demo', '/buildd-demo/')).toBeNull();
    expect(blobFileFor(root, 'buildd-demo', '/buildd-demo/%E0%A4%A')).toBeNull();
  });
});

test('contentTypeOf', () => {
  expect(contentTypeOf('a/b.PNG')).toBe('image/png');
  expect(contentTypeOf('a/b.bin')).toBe('application/octet-stream');
});
