import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ProtectedError from './error';

describe('ProtectedError', () => {
  it('shows the digest chip for a server-side error', () => {
    const error = Object.assign(new Error('boom'), { digest: 'abc123' });
    const html = renderToStaticMarkup(<ProtectedError error={error} reset={() => {}} />);
    expect(html).toContain('abc123');
  });

  it('shows name and message when there is no digest (client-side error)', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'foo')");
    const html = renderToStaticMarkup(<ProtectedError error={error} reset={() => {}} />);
    expect(html).toContain('TypeError');
    expect(html).toContain('Cannot read properties of undefined');
  });

  it('renders no diagnostic chip when neither digest nor name/message is present', () => {
    const error = Object.assign(Object.create(Error.prototype), { name: '', message: '' });
    const html = renderToStaticMarkup(<ProtectedError error={error} reset={() => {}} />);
    expect(html).not.toContain('bg-surface-3 px-3 py-1.5 rounded');
  });
});
