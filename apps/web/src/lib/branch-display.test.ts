import { describe, expect, it } from 'bun:test';
import { displayBranchName } from './branch-display';

// Regression (demo reshoot, Worker history): generated branch names are capped
// mid-slug, so the page printed "buildd/abc12345-feat-invoices-render-invoices-"
// with a dangling hyphen that reads as a rendering bug.
describe('displayBranchName', () => {
  it('leaves a short, clean name alone', () => {
    expect(displayBranchName('main')).toBe('main');
    expect(displayBranchName('buildd/abc12345-fix-login')).toBe('buildd/abc12345-fix-login');
  });
  it('a name that ends on a separator (cut mid-slug) ends in an ellipsis instead', () => {
    expect(displayBranchName('buildd/abc12345-feat-invoices-render-invoices-')).toBe('buildd/abc12345-feat-invoices-render-invoices…');
    expect(displayBranchName('feature/x_/')).toBe('feature/x…');
  });
  it('truncates a long name at a token boundary, never mid-token', () => {
    const out = displayBranchName('buildd/abc12345-feat-invoices-render-invoices-in-the-customers-currency', 40);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toBe('buildd/abc12345-feat-invoices-render…');
    expect(out).not.toMatch(/[-/_]…$/);
  });
  it('falls back to a hard cut when the first token alone is too long', () => {
    const out = displayBranchName('a'.repeat(60), 20);
    expect(out).toBe('a'.repeat(19) + '…');
  });
  it('null/empty in → empty out', () => {
    expect(displayBranchName(null)).toBe('');
    expect(displayBranchName('')).toBe('');
  });
});
