import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionAcceptanceTests from './MissionAcceptanceTests';

describe('MissionAcceptanceTests', () => {
  test('lists the tests under the check each covers', () => {
    const html = renderToStaticMarkup(<MissionAcceptanceTests tests={[
      { checkId: 'AC-1', name: 'one', startingResult: 'fail' },
      { checkId: 'AC-1', name: 'two', startingResult: null },
      { checkId: 'AC-2', name: 'three', startingResult: 'pass' },
    ]} />);
    expect(html.match(/data-testid="acceptance-check"/g)?.length).toBe(2);
    expect(html).toContain('fails, as wanted');
    expect(html).toContain('not run yet');
    expect(html).toContain('passes already');
  });
  test('renders nothing without tests', () => {
    expect(renderToStaticMarkup(<MissionAcceptanceTests tests={[]} />)).toBe('');
  });
});
