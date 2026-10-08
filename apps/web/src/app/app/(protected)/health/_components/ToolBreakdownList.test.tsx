import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ToolBreakdownList from './ToolBreakdownList';
import type { ToolBreakdownRow } from '@/lib/tool-usage-breakdown';

const rows: ToolBreakdownRow[] = [
  {
    name: 'Bash', label: 'Bash', calls: 120, share: 0.6,
    children: [
      { key: 'git', label: 'git', calls: 60, share: 0.5 },
      { key: 'file_read', label: 'file read', calls: 40, share: 0.33, dedicatedTool: 'Read', hint: 'cat / head' },
    ],
    childCoverage: { covered: 100, of: 120 },
  },
  { name: 'Agent', label: 'Agent', calls: 5, share: 0.025, children: [], childCoverage: null },
];

describe('ToolBreakdownList', () => {
  const html = renderToStaticMarkup(<ToolBreakdownList rows={rows} maxCalls={120} />);

  it('a row with a breakdown opens in place, with its children inside it', () => {
    expect(html).toContain('<details class="group/tool">');
    const bash = html.slice(0, html.indexOf('Agent'));
    expect(bash).toContain('git');
    expect(bash).toContain('file read');
  });

  it('marks a shell bucket a dedicated tool already covers', () => {
    expect(html).toContain('Read does this');
  });

  it('says when the breakdown covers fewer calls than the row', () => {
    expect(html).toContain('Broken down: 100 of 120 calls.');
  });

  it('a row with nothing to break down is plain, not expandable', () => {
    const agentRow = html.slice(html.lastIndexOf('<li'));
    expect(agentRow).not.toContain('<details');
    expect(agentRow).toContain('Agent');
  });

  it('uses no arbitrary pixel sizes or rounded corners', () => {
    expect(html).not.toMatch(/text-\[\d+px\]/);
    expect(html).not.toMatch(/rounded/);
  });
});
