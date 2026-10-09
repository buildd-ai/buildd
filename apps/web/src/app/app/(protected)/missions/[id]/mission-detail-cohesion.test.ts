/**
 * Mission detail says each thing once (UI cohesion audit, mission detail):
 * ⋯ is the only settings sheet, the visual review starts from ⋯ and is
 * reviewed from the Screens row, the footer is Shipped + Screens + Records,
 * orchestrator runs and notes live in History, and the notice stack is one
 * slot that is a decision card only when a person has to act. page.tsx is a
 * server component that needs a database, so this pins its markup at the
 * source level.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8');
const PAGE = read('page.tsx');
const FOOTER = PAGE.slice(PAGE.indexOf('const footerRows = ('), PAGE.indexOf('</>', PAGE.indexOf('const footerRows = (')));

describe('one settings surface', () => {
  it('the footer carries no Settings row: the settings ride in the ⋯ sheet', () => {
    expect(FOOTER).not.toContain('{settings}');
    expect(PAGE).toMatch(/<MissionOverflowMenu[\s\S]*?settings=\{settings\}/);
    expect(PAGE).not.toContain('<MissionSecondaryPanel');
  });

  it('the ⋯ sheet renders the actions and the settings in one sheet', () => {
    const menu = read('MissionOverflowMenu.tsx');
    expect(menu).toContain('settings?: ReactNode');
    expect(menu.match(/<SideSheet\b/g)?.length).toBe(2); // the ⋯ sheet, and the visual review it opens
    expect(menu).toMatch(/title="Mission"/);
  });

  it('settings sections are plain sections, not cards inside a sheet, with no caps labels', () => {
    const settings = PAGE.slice(PAGE.indexOf('const settings = ('), PAGE.indexOf('// ── Board / Flow'));
    expect(settings).not.toMatch(/className="card\b/);
    expect(settings).not.toMatch(/\buppercase\b/);
    // Organizer runs are in History › Everything, not repeated here.
    expect(settings).not.toContain('<HeartbeatTimeline');
  });
});

describe('one visual review entry', () => {
  it('the header carries no Visual review button', () => {
    expect(PAGE).not.toMatch(/actions=\{<>\{askAbout\}\{visualReviewAction\}/);
    expect(PAGE).not.toContain('<MissionVisualReviewAction');
  });

  it('⋯ offers Visual review and still honours the ?visualReview=1 deep link', () => {
    expect(PAGE).toMatch(/const visualReviewEntry = [^\n]*\{ initialOpen: visualReviewParam === '1' \}/);
    expect(PAGE).toMatch(/<MissionOverflowMenu[\s\S]*?visualReview=\{visualReviewEntry\}/);
    const menu = read('MissionOverflowMenu.tsx');
    expect(menu).toContain('data-testid="mission-visual-review-entry"');
    expect(menu).toContain('VisualReviewSheetBody');
  });

  it('History has no second Screens section in a 2px frame', () => {
    const feed = read('MissionFeedLayout.tsx');
    expect(feed).not.toContain('feed-visual-section');
    expect(feed).not.toContain('border-2');
  });
});

describe('footer and History', () => {
  it('the footer is Shipped + Screens + Records: no Orchestrator or Notes rows', () => {
    expect(FOOTER).toContain('<MissionScreensRow');
    expect(FOOTER).toContain('<MissionRecordsSheet');
    expect(FOOTER).not.toContain('<MissionNotesSheet');
    expect(PAGE).not.toContain('{orchestratorRow}');
    expect(PAGE).not.toContain('mission-orchestrator-row');
  });

  it('notes and asking the organizer open from the History tab', () => {
    expect(PAGE).toMatch(/<MissionFeedLayout[\s\S]*?notesEntry=\{<MissionNotesSheet/);
    expect(read('MissionFeedLayout.tsx')).toContain('notesEntry');
  });
});

describe('one notice slot', () => {
  it('the notices render through one slot that frames only a decision', () => {
    expect(PAGE).toContain('<MissionNoticeSlot');
    const slot = read('MissionNoticeSlot.tsx');
    expect(slot).toContain('card-decision');
    expect(slot).not.toMatch(/\buppercase\b/);
  });

  it('the decision block and the mission PR line carry no tinted box, caps label or stripe card', () => {
    const decision = PAGE.slice(PAGE.indexOf('const decisionBlock ='), PAGE.indexOf('const settings = ('));
    expect(decision).not.toMatch(/\buppercase\b/);
    expect(decision).not.toContain('bg-status-warning/5');
    const pr = PAGE.slice(PAGE.indexOf('const missionPrCard ='), PAGE.indexOf('const reviewSummary ='));
    expect(pr).not.toMatch(/\buppercase\b/);
    expect(pr).not.toContain('border-l-2');
  });

  it('the situation block draws no box of its own and its primary is ink, not orange', () => {
    const block = readFileSync(join(import.meta.dir, '../../../../../components/missions/MissionSituationBlock.tsx'), 'utf8');
    expect(block).not.toContain('TONE_BLOCK_CLASS');
    expect(block).not.toContain('bg-accent text-white');
  });
});
