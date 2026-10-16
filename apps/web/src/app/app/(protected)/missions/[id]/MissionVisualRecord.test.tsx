import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionVisualRecord from './MissionVisualRecord';

describe('MissionVisualRecord', () => {
  it('shows a waiver with its reason, actor, time and policy', () => {
    const html = renderToStaticMarkup(
      <MissionVisualRecord record={{ kind: 'waiver', text: 'Visual check waived', detail: 'Emergency copy fix', reason: 'Emergency copy fix', actor: 'sam@example.com', at: '2026-10-02T10:00:00Z', policy: 'ask' }} />,
    );
    expect(html).toContain('data-kind="waiver"');
    expect(html).toContain('Waived by a person');
    expect(html).toContain('Emergency copy fix');
    expect(html).toContain('sam@example.com');
    expect(html).toContain('ask policy');
  });

  it('shows an automatic no-impact decision distinctly from a waiver', () => {
    const html = renderToStaticMarkup(<MissionVisualRecord record={{ kind: 'auto_no_impact', text: 'No visual changes', detail: 'Checked automatically. No visual review was needed.' }} />);
    expect(html).toContain('data-kind="auto_no_impact"');
    expect(html).toContain('Decided automatically');
    expect(html).not.toContain('Waived');
  });
});
