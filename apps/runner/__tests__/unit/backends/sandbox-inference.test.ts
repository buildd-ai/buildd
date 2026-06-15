/**
 * Unit tests for inferSandboxMode — maps task.kind to sandbox restriction level.
 *
 * Run: bun test apps/runner/__tests__/unit/backends/
 */

import { describe, test, expect } from 'bun:test';
import { inferSandboxMode } from '../../../src/backends/index';

describe('inferSandboxMode', () => {
  test('research → read-only', () => {
    expect(inferSandboxMode('research')).toBe('read-only');
  });

  test('analysis → read-only', () => {
    expect(inferSandboxMode('analysis')).toBe('read-only');
  });

  test('observation → read-only', () => {
    expect(inferSandboxMode('observation')).toBe('read-only');
  });

  test('engineering → workspace-write', () => {
    expect(inferSandboxMode('engineering')).toBe('workspace-write');
  });

  test('writing → workspace-write', () => {
    expect(inferSandboxMode('writing')).toBe('workspace-write');
  });

  test('design → workspace-write', () => {
    expect(inferSandboxMode('design')).toBe('workspace-write');
  });

  test('coordination → workspace-write', () => {
    expect(inferSandboxMode('coordination')).toBe('workspace-write');
  });

  test('unknown kind → workspace-write (safe default)', () => {
    expect(inferSandboxMode('unknown-kind')).toBe('workspace-write');
    expect(inferSandboxMode('bug')).toBe('workspace-write');
    expect(inferSandboxMode('feature')).toBe('workspace-write');
  });

  test('null → workspace-write', () => {
    expect(inferSandboxMode(null)).toBe('workspace-write');
  });

  test('undefined → workspace-write', () => {
    expect(inferSandboxMode(undefined)).toBe('workspace-write');
  });

  test('empty string → workspace-write', () => {
    expect(inferSandboxMode('')).toBe('workspace-write');
  });
});
