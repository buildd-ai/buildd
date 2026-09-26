/**
 * Regression: the task page's artifact list dropped `storageKey`, so neither
 * the card nor the viewer knew an uploaded screenshot had an object behind it.
 */
import { describe, expect, it } from 'bun:test';
import { toTaskArtifactItem } from './task-artifact-items';

/** A row as upload-url inserts it (see api/artifacts/upload-url/route.ts). */
const uploadRow = {
  id: 'art-1',
  type: 'screenshot',
  title: 'invoices-eur-desktop.png',
  content: null,
  storageKey: 'qa/ws-1/art-1/invoices-eur-desktop.png',
  shareToken: null,
  visibility: 'private',
  metadata: { filename: 'invoices-eur-desktop.png', mimeType: 'image/png', sizeBytes: 81410 },
  createdAt: new Date('2026-03-04T12:00:00.000Z'),
};

describe('toTaskArtifactItem', () => {
  it('carries the storageKey column through', () => {
    const item = toTaskArtifactItem(uploadRow);
    expect(item.storageKey).toBe('qa/ws-1/art-1/invoices-eur-desktop.png');
    expect(item.createdAt).toBe('2026-03-04T12:00:00.000Z');
    expect(item.visibility).toBe('private');
  });

  it('normalises missing metadata and visibility', () => {
    const item = toTaskArtifactItem({ ...uploadRow, storageKey: null, metadata: null, visibility: null });
    expect(item.storageKey).toBeNull();
    expect(item.metadata).toEqual({});
    expect(item.visibility).toBe('private');
  });
});
