/**
 * Regression: a screenshot uploaded through POST /api/artifacts/upload-url
 * keeps its object key in the `artifacts.storage_key` column, not in
 * `metadata`. The viewer read only `metadata.storageKey`, so every uploaded
 * image or file opened to "No content to display."
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ArtifactViewer, { type ArtifactViewerItem } from './ArtifactViewer';

/** The row upload-url writes: key in the column, filename/mime/size in metadata. */
const uploaded: ArtifactViewerItem = {
  id: 'art-1',
  type: 'screenshot',
  title: 'invoices-eur-desktop.png',
  content: null,
  storageKey: 'qa/ws-1/art-1/invoices-eur-desktop.png',
  shareToken: null,
  visibility: 'private',
  metadata: {
    qa: { runKey: 'r1', route: '/invoices/:id', viewport: 'desktop', finding: 'fine', verdict: 'ok' },
    filename: 'invoices-eur-desktop.png',
    mimeType: 'image/png',
    sizeBytes: 81410,
  },
  createdAt: '2026-03-04T12:00:00.000Z',
};

function render(item: ArtifactViewerItem) {
  return renderToStaticMarkup(
    <ArtifactViewer artifacts={[item]} open initialIndex={0} onClose={() => {}} baseUrl="https://example.test" />,
  );
}

describe('ArtifactViewer, uploaded objects', () => {
  it('renders an uploaded image from the storageKey column', () => {
    const html = render(uploaded);
    expect(html).not.toContain('No content to display.');
    expect(html).toContain('src="/api/artifacts/art-1/download"');
  });

  it('offers a download for an uploaded non-image file', () => {
    const html = render({
      ...uploaded,
      type: 'file',
      storageKey: 'artifacts/ws-1/art-1/report.pdf',
      metadata: { filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 2048 },
    });
    expect(html).not.toContain('No content to display.');
    expect(html).toContain('href="/api/artifacts/art-1/download"');
  });

  it('still reads a legacy metadata.storageKey', () => {
    const { storageKey: _omit, ...rest } = uploaded;
    const html = render({ ...rest, metadata: { ...uploaded.metadata, storageKey: 'legacy/key.png' } });
    expect(html).toContain('src="/api/artifacts/art-1/download"');
  });
});
