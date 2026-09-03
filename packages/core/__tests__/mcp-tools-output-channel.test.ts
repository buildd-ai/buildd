import { describe, it, expect } from 'bun:test';
import { describeOutputChannel } from '../mcp-tools';

// describeOutputChannel is a display-only hint shown in list_schedules /
// trace_schedule so a caller can identify the schedule behind a stray
// notification. It used to name two private connectors literally
// (`mcp__<name>__*` and `<name>__send_pushover`), which published a production
// connector name from this PUBLIC repo. Those alternatives were redundant: a
// real tool name carries the capability verb, and `send_pushover` already
// matches earlier in the same alternation.
//
// These tests pin the property that made the removal safe — matching is on the
// CAPABILITY, not on any connector's name — so nobody re-adds a private
// identifier to "fix" a hint.

function tpl(description: string, skillSlugs: string[] = []) {
  return { description, context: { skillSlugs } };
}

describe('describeOutputChannel — capability matching, not connector names', () => {
  it('hints pushover for a pushover tool from ANY connector', () => {
    for (const connector of ['sibling-ops', 'anything', 'a-b-c']) {
      expect(describeOutputChannel(tpl(`calls mcp__${connector}__send_pushover`))).toContain(
        'pushover'
      );
    }
  });

  it('hints pushover on the underscore tool-name form too', () => {
    expect(describeOutputChannel(tpl('runs whatever__send_pushover nightly'))).toContain('pushover');
  });

  it('hints pushover for the bare capability words', () => {
    expect(describeOutputChannel(tpl('sends a pushover alert'))).toContain('pushover');
    expect(describeOutputChannel(tpl('calls send_notification'))).toContain('pushover');
  });

  it('does NOT hint pushover for a connector named with no capability verb', () => {
    // The deliberate narrowing: naming a connector alone no longer implies
    // pushover. Re-adding a literal connector name to recover this hint would
    // republish a production identifier — write the verb in the template instead.
    expect(describeOutputChannel(tpl('routes through mcp__sibling-ops'))).toBeNull();
  });

  it('still recognises the other channels', () => {
    expect(describeOutputChannel(tpl('posts to slack'))).toContain('slack');
    expect(describeOutputChannel(tpl('sends gmail'))).toContain('email');
    expect(describeOutputChannel(tpl('the morning digest'))).toContain('daily digest');
  });

  it('reads skillSlugs as well as the description', () => {
    expect(describeOutputChannel(tpl('nothing here', ['daily-digest']))).toContain('skill:daily-digest');
  });

  it('returns null for nothing recognisable, and for junk input', () => {
    expect(describeOutputChannel(tpl('reindexes the corpus'))).toBeNull();
    expect(describeOutputChannel(null)).toBeNull();
    expect(describeOutputChannel('a string')).toBeNull();
  });
});
