/**
 * MissionRecordsSheet (docs/design/mission-feed-mobile-continuity.md, AC-16,
 * addendum D5): `Records · N` counts `selectMissionRecords` and opens a sheet
 * listing exactly those; every other artifact is one tap further, at the bottom
 * of the same sheet — never an unfiltered dump at the bottom of the page.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionRecordsSheet, { resolveInitialRecordsView } from './MissionRecordsSheet';

const artifact = (id: string, title: string) => ({
  id,
  type: 'report',
  title,
  content: null,
  shareToken: null,
  visibility: 'private' as const,
  metadata: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  taskTitle: 'Example task',
});

const records = [artifact('r1', 'Example plan'), artifact('r2', 'Example review')];
const all = [...records, artifact('cap', 'Example capture')];

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('MissionRecordsSheet', () => {
  it('labels its row with the records count, not the artifact count', () => {
    const html = renderToStaticMarkup(<MissionRecordsSheet missionId="m" baseUrl="https://example.test" records={records} allArtifacts={all} />);
    expect(html).toContain('Records · 2');
    expect(html).not.toContain('data-testid="mission-records-sheet"');
  });

  it('opens a sheet listing only the records, with All artifacts behind one more tap', () => {
    const html = renderToStaticMarkup(
      <MissionRecordsSheet missionId="m" baseUrl="https://example.test" records={records} allArtifacts={all} defaultOpen />,
    );
    expect(html).toContain('data-testid="mission-records-sheet"');
    expect(count(html, 'data-testid="mission-artifact-row"')).toBe(2);
    expect(html).not.toContain('Example capture');
    expect(html).toContain('All artifacts · 3');
  });

  it('renders nothing when the mission has no artifacts at all', () => {
    const html = renderToStaticMarkup(<MissionRecordsSheet missionId="m" baseUrl="https://example.test" records={[]} allArtifacts={[]} />);
    expect(html).toBe('');
  });
});

describe('resolveInitialRecordsView (?artifact=)', () => {
  it('opens on the records list when the artifact is a record', () => {
    expect(resolveInitialRecordsView('r1', records, all)).toEqual({ open: true, showAll: false });
  });

  it('opens with All artifacts shown when the artifact is not a record', () => {
    expect(resolveInitialRecordsView('cap', records, all)).toEqual({ open: true, showAll: true });
  });

  it('stays closed for no id or an unknown id', () => {
    expect(resolveInitialRecordsView(null, records, all)).toEqual({ open: false, showAll: false });
    expect(resolveInitialRecordsView('nope', records, all)).toEqual({ open: false, showAll: false });
  });
});
