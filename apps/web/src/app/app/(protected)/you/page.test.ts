import { describe, test, expect } from 'bun:test';

// Logic extracted from page.tsx for unit testing
function getInitials(name: string | null | undefined, email: string): string {
  if (name) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  }
  return email[0].toUpperCase();
}

describe('getInitials', () => {
  test('returns initials from name', () => {
    expect(getInitials('Jane Doe', 'jane@example.com')).toBe('JD');
  });

  test('returns single initial for single-word name', () => {
    expect(getInitials('Jane', 'jane@example.com')).toBe('J');
  });

  test('returns at most 2 characters', () => {
    expect(getInitials('Anna Belle Carla', 'a@example.com')).toBe('AB');
  });

  test('falls back to email initial when name is null', () => {
    expect(getInitials(null, 'jane@example.com')).toBe('J');
  });

  test('falls back to email initial when name is undefined', () => {
    expect(getInitials(undefined, 'max@buildd.dev')).toBe('M');
  });

  test('uppercases initials', () => {
    expect(getInitials('john doe', 'j@example.com')).toBe('JD');
  });
});
