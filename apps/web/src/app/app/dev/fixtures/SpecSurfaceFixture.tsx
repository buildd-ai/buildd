'use client';

import MarkdownContent from '@/components/MarkdownContent';

/**
 * A spec surface with a diagram and a wide table (living-specs.md §15), for
 * Visual QA at phone width: the scrubbed QA clone replaces spec bodies, so a
 * real spec cannot show either. Nothing here is fetched.
 */
export const SPEC_SURFACE_FIXTURE_BODY = [
  '# Checkout',
  '',
  'How a cart becomes an order.',
  '',
  '```mermaid',
  'graph TD',
  '  A[Cart] --> B{Signed in?}',
  '  B -- yes --> C[Payment]',
  '  B -- no --> D[Sign in] --> C',
  '  C --> E[Order placed]',
  '```',
  '',
  '| ID | Requirement | Check | Owner | Area | Notes |',
  '|----|-------------|-------|-------|------|-------|',
  '| **AC-1** | An empty cart shows the empty state | unit test | cart team | cart | Shown before any item is added |',
  '| **AC-2** | Totals are in the shopper currency | unit test | cart team | totals | Rounded the way the payment provider rounds |',
  '| **AC-3** | A failed payment keeps the cart | e2e | payments | checkout | The shopper sees why and can retry |',
].join('\n');

export default function SpecSurfaceFixture() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6" data-testid="spec-surface-fixture">
      <MarkdownContent content={SPEC_SURFACE_FIXTURE_BODY} images="link" surface="spec" />
    </main>
  );
}
