/**
 * Home's Needs-you cards split a question's option into its answer and its
 * reason. Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { splitOption } from './NeedsYouCards';

describe('NeedsYouCards', () => {
  it('splits an option into its answer and its reason', () => {
    expect(splitOption('Per line — match Stripe')).toEqual({ main: 'Per line', sub: 'match Stripe' });
    expect(splitOption('Total only')).toEqual({ main: 'Total only', sub: null });
  });
});
