/**
 * Unit tests for phase detection logic
 *
 * Tests extractPhaseLabel and the phase tracking behavior
 * where text blocks start phases and tool_use blocks increment them.
 *
 * Run: bun test __tests__/unit
 */

import { describe, test, expect } from 'bun:test';
import type { Milestone, LocalWorker } from '../../src/types';

// Re-implement extractPhaseLabel for testing (mirrors workers.ts)
function extractPhaseLabel(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  const periodIdx = firstLine.indexOf('. ');
  const label = periodIdx > 0 && periodIdx < 120
    ? firstLine.slice(0, periodIdx)
    : firstLine.slice(0, 120);
  return label + (firstLine.length > 120 && periodIdx < 0 ? '...' : '');
}

// Minimal phase tracker that mirrors handleMessage logic
class PhaseTracker {
  milestones: Milestone[] = [];
  phaseText: string | null = null;
  phaseStart: number | null = null;
  phaseToolCount = 0;
  phaseTools: string[] = [];

  onText(text: string) {
    // If active phase has tool calls, close it
    if (this.phaseText && this.phaseToolCount > 0) {
      this.closePhase();
    }
    // Start/update phase
    this.phaseText = text;
    this.phaseStart = Date.now();
    this.phaseToolCount = 0;
    this.phaseTools = [];
  }

  onToolUse(toolName: string, input: Record<string, unknown> = {}) {
    this.phaseToolCount++;

    // Track notable tools (cap 5)
    if (['Edit', 'Write', 'Bash'].includes(toolName) && this.phaseTools.length < 5) {
      if (toolName === 'Edit' || toolName === 'Write') {
        const filePath = input.file_path as string;
        const shortPath = filePath ? filePath.split('/').pop() || filePath : toolName;
        this.phaseTools.push(`${toolName}: ${shortPath}`);
      } else if (toolName === 'Bash') {
        const cmd = (input.command as string) || '';
        this.phaseTools.push(cmd.slice(0, 40));
      }
    }
  }

  onResult() {
    if (this.phaseText && this.phaseToolCount > 0) {
      this.closePhase();
    }
  }

  private closePhase() {
    if (!this.phaseText || this.phaseToolCount === 0) return;
    this.milestones.push({
      type: 'phase',
      label: extractPhaseLabel(this.phaseText),
      toolCount: this.phaseToolCount,
      ts: this.phaseStart || Date.now(),
    });
    this.phaseText = null;
    this.phaseStart = null;
    this.phaseToolCount = 0;
    this.phaseTools = [];
  }
}

describe('extractPhaseLabel', () => {
  test('extracts first sentence up to period', () => {
    const label = extractPhaseLabel('I need to read the configuration file. Then I will update it.');
    expect(label).toBe('I need to read the configuration file');
  });

  test('handles text without period — takes first line up to 120 chars', () => {
    const label = extractPhaseLabel('Investigating the routing setup and auth middleware');
    expect(label).toBe('Investigating the routing setup and auth middleware');
  });

  test('truncates long first line at 120 chars with ellipsis', () => {
    const long = 'A'.repeat(150);
    const label = extractPhaseLabel(long);
    expect(label).toBe('A'.repeat(120) + '...');
  });

  test('takes first line of multiline text', () => {
    const label = extractPhaseLabel('First line\nSecond line\nThird line');
    expect(label).toBe('First line');
  });

  test('handles empty string', () => {
    const label = extractPhaseLabel('');
    expect(label).toBe('');
  });

  test('period at beginning still works', () => {
    // Period at index 0: '. something' — periodIdx is 0 which is not > 0
    const label = extractPhaseLabel('. Something else here');
    expect(label).toBe('. Something else here');
  });

  test('period without trailing space is not a sentence boundary', () => {
    const label = extractPhaseLabel('Reading src/app.ts and checking config.json for settings');
    // '. ' doesn't appear, so the whole line is taken
    expect(label).toBe('Reading src/app.ts and checking config.json for settings');
  });

  test('first sentence boundary past 120 chars falls back to truncation', () => {
    const text = 'A'.repeat(130) + '. Then something else.';
    const label = extractPhaseLabel(text);
    // periodIdx > 120, so slice(0, 120) is used; but periodIdx > 0 so no '...' appended
    expect(label).toBe('A'.repeat(120));
  });
});

describe('PhaseTracker', () => {
  test('text followed by tools creates a phase on next text', () => {
    const tracker = new PhaseTracker();

    tracker.onText('Exploring the codebase');
    tracker.onToolUse('Read', { file_path: '/src/index.ts' });
    tracker.onToolUse('Read', { file_path: '/src/app.ts' });
    tracker.onToolUse('Grep', { pattern: 'export' });

    // Phase not closed yet (still accumulating)
    expect(tracker.milestones).toHaveLength(0);
    expect(tracker.phaseToolCount).toBe(3);

    // New text block closes previous phase
    tracker.onText('Now I will make changes');

    expect(tracker.milestones).toHaveLength(1);
    expect(tracker.milestones[0].type).toBe('phase');
    expect(tracker.milestones[0].label).toBe('Exploring the codebase');
    expect((tracker.milestones[0] as any).toolCount).toBe(3);
  });

  test('consecutive text blocks without tools do not create empty phase', () => {
    const tracker = new PhaseTracker();

    tracker.onText('First thought');
    // No tools
    tracker.onText('Second thought');

    // No milestones — first phase had 0 tools, so not closed as milestone
    expect(tracker.milestones).toHaveLength(0);
    expect(tracker.phaseText).toBe('Second thought');
    expect(tracker.phaseToolCount).toBe(0);
  });

  test('result closes open phase', () => {
    const tracker = new PhaseTracker();

    tracker.onText('Final changes');
    tracker.onToolUse('Edit', { file_path: '/src/app.ts' });
    tracker.onToolUse('Bash', { command: 'npm test' });

    tracker.onResult();

    expect(tracker.milestones).toHaveLength(1);
    expect(tracker.milestones[0].label).toBe('Final changes');
    expect((tracker.milestones[0] as any).toolCount).toBe(2);
  });

  test('result with no open phase does nothing', () => {
    const tracker = new PhaseTracker();

    tracker.onResult();

    expect(tracker.milestones).toHaveLength(0);
  });

  test('multiple phases tracked correctly', () => {
    const tracker = new PhaseTracker();

    // Phase 1
    tracker.onText('Reading configuration');
    tracker.onToolUse('Read', { file_path: '/config.ts' });
    tracker.onToolUse('Read', { file_path: '/schema.ts' });

    // Phase 2
    tracker.onText('Updating the schema');
    tracker.onToolUse('Edit', { file_path: '/schema.ts' });
    tracker.onToolUse('Edit', { file_path: '/migration.sql' });
    tracker.onToolUse('Bash', { command: 'bun db:generate' });

    // Phase 3
    tracker.onText('Running tests');
    tracker.onToolUse('Bash', { command: 'bun test' });

    // Close final phase
    tracker.onResult();

    expect(tracker.milestones).toHaveLength(3);
    expect(tracker.milestones[0].label).toBe('Reading configuration');
    expect((tracker.milestones[0] as any).toolCount).toBe(2);
    expect(tracker.milestones[1].label).toBe('Updating the schema');
    expect((tracker.milestones[1] as any).toolCount).toBe(3);
    expect(tracker.milestones[2].label).toBe('Running tests');
    expect((tracker.milestones[2] as any).toolCount).toBe(1);
  });

  test('notable tools tracked with cap of 5', () => {
    const tracker = new PhaseTracker();

    tracker.onText('Making many edits');
    tracker.onToolUse('Edit', { file_path: '/a.ts' });
    tracker.onToolUse('Edit', { file_path: '/b.ts' });
    tracker.onToolUse('Write', { file_path: '/c.ts' });
    tracker.onToolUse('Bash', { command: 'npm test' });
    tracker.onToolUse('Bash', { command: 'npm run build' });
    tracker.onToolUse('Edit', { file_path: '/d.ts' }); // 6th notable — should be capped
    tracker.onToolUse('Read', { file_path: '/e.ts' }); // Not notable

    expect(tracker.phaseTools).toHaveLength(5);
    expect(tracker.phaseToolCount).toBe(7); // All tools counted
  });

  test('phase resets after close', () => {
    const tracker = new PhaseTracker();

    tracker.onText('Phase one');
    tracker.onToolUse('Read', { file_path: '/a.ts' });

    tracker.onText('Phase two');

    // After close, phase state is reset
    expect(tracker.phaseText).toBe('Phase two');
    expect(tracker.phaseToolCount).toBe(0);
    expect(tracker.phaseTools).toHaveLength(0);
  });
});
