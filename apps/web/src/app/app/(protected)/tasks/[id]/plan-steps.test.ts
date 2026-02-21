import { describe, test, expect } from 'bun:test';
import { parsePlanSteps, matchMilestoneToStep } from './plan-steps';

describe('parsePlanSteps', () => {
  test('parses numbered lists', () => {
    const md = `
1. Set up the database schema
2. Create API endpoints
3. Build the frontend
    `;
    const steps = parsePlanSteps(md);
    expect(steps).toHaveLength(3);
    expect(steps[0].text).toBe('Set up the database schema');
    expect(steps[1].text).toBe('Create API endpoints');
    expect(steps[2].text).toBe('Build the frontend');
    expect(steps.every(s => s.depth === 0)).toBe(true);
  });

  test('parses markdown checkboxes', () => {
    const md = `
- [ ] Add authentication
- [x] Set up database
- [ ] Write tests
    `;
    const steps = parsePlanSteps(md);
    expect(steps).toHaveLength(3);
    expect(steps[0].text).toBe('Add authentication');
    expect(steps[1].text).toBe('Set up database');
  });

  test('parses phase headings', () => {
    const md = `
## Phase 1: Setup
Some description here
## Phase 2: Implementation
More details
## Phase 3: Testing
    `;
    const steps = parsePlanSteps(md);
    expect(steps).toHaveLength(3);
    expect(steps[0].text).toBe('Phase 1: Setup');
    expect(steps[2].text).toBe('Phase 3: Testing');
  });

  test('parses ### step headings', () => {
    const md = `
### Create the schema file
### Add migration
### Test the endpoint
    `;
    const steps = parsePlanSteps(md);
    expect(steps).toHaveLength(3);
    expect(steps[0].text).toBe('Create the schema file');
  });

  test('handles indented sub-items as depth 1', () => {
    const md = `
1. Top level step
    1. Sub step one
    2. Sub step two
2. Another top level
    `;
    const steps = parsePlanSteps(md);
    expect(steps).toHaveLength(4);
    expect(steps[0].depth).toBe(0);
    expect(steps[1].depth).toBe(1);
    expect(steps[2].depth).toBe(1);
    expect(steps[3].depth).toBe(0);
  });

  test('ignores non-step headings (## without phase/step prefix)', () => {
    const md = `
## Overview
This is not a step.
## Phase 1: Real step
    `;
    const steps = parsePlanSteps(md);
    expect(steps).toHaveLength(1);
    expect(steps[0].text).toBe('Phase 1: Real step');
  });

  test('handles mixed formats', () => {
    const md = `
## Phase 1: Setup
1. Install dependencies
2. Configure database
- [ ] Run migrations

## Phase 2: Implementation
1. Build API
2. Build frontend
    `;
    const steps = parsePlanSteps(md);
    expect(steps).toHaveLength(7);
  });

  test('returns empty array for non-step markdown', () => {
    const md = `
Just a paragraph of text.

Another paragraph with no lists or headings.
    `;
    const steps = parsePlanSteps(md);
    expect(steps).toHaveLength(0);
  });

  test('handles empty input', () => {
    expect(parsePlanSteps('')).toHaveLength(0);
  });
});

describe('matchMilestoneToStep', () => {
  const steps = parsePlanSteps(`
1. Set up the database schema
2. Create API authentication endpoints
3. Build the frontend dashboard
4. Write integration tests
  `);

  test('matches milestone to correct step by keyword overlap', () => {
    const idx = matchMilestoneToStep('Working on database schema', steps);
    expect(idx).toBe(0);
  });

  test('matches authentication-related milestone', () => {
    const idx = matchMilestoneToStep('Implementing authentication endpoints', steps);
    expect(idx).toBe(1);
  });

  test('matches frontend milestone', () => {
    const idx = matchMilestoneToStep('Building frontend components', steps);
    expect(idx).toBe(2);
  });

  test('matches test milestone', () => {
    const idx = matchMilestoneToStep('Writing integration tests', steps);
    expect(idx).toBe(3);
  });

  test('returns -1 for unrelated milestone', () => {
    const idx = matchMilestoneToStep('Deploying to production', steps);
    expect(idx).toBe(-1);
  });

  test('returns -1 for empty label', () => {
    expect(matchMilestoneToStep('', steps)).toBe(-1);
  });

  test('returns -1 for empty steps', () => {
    expect(matchMilestoneToStep('Some label', [])).toBe(-1);
  });

  test('handles short stop-word-only labels', () => {
    // "the and for" are all stop words with length >= 3 but filtered out
    const idx = matchMilestoneToStep('the and for', steps);
    expect(idx).toBe(-1);
  });
});
