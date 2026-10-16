/**
 * The v8 film over `storyboards/demo-v8.yaml` (story: stories/invoice-phone-session.json):
 * v7's visual UI fix, but the work is shared. The runner takes two tasks and a
 * person's own Claude Code session, connected over MCP, claims the third. Same
 * checks wherever the agent runs.
 *
 * Everything but the agents chapter is v7's (cuts-v7.ts). That chapter opens
 * on Health > Runners: the runner's group lit first, then "Your sessions".
 * Nothing here shows or says how a session's model is paid for or signed in.
 *
 * Cuts: `full` (voiced) and `captioned` (silent), as v7.
 */
import type { Stills } from './cuts';
import { aim, type Look } from './cuts-v6';
import { captionedOf, filmOf, FILM_LOOK, V7_LINES, v7Chapters, type Spoken } from './cuts-v7';
import type { Cut, Shot } from './timeline';

const PAD = 14;

/** v7's passage with one line changed: the agents chapter names the agent you already have. */
export const V8_LINES = [
  V7_LINES[0],
  V7_LINES[1],
  'Then the agents get to work, a few tasks at a time. Use the agent you already have: your own Claude Code session takes a task. Small calls get decided on the spot. Anything risky, like a migration or a secret, comes to your phone.',
  V7_LINES[3],
  V7_LINES[4],
];
export const V8_VOICE = { voice: 'af_heart', speed: 1.0 };

/** The agents chapter's opening: the runner at work, then your own session beside it. */
function agents(s: Stills, look: Look): Shot[] {
  const H = 's04-runners';
  const img = s.img(H);
  const board = s.box(H, 'running-now');
  const groups = s.boxes(H, 'running-now-group');
  const runner = groups[0];
  const mine = groups[groups.length - 1];
  const key = (at: number, rects: typeof groups, dim = look.dim) => ({ at, rects, dim, padPx: PAD });
  const f = (rect: typeof board, padding: number, t: number) => aim(look, img, rect, padding, t);
  const fleet: Shot = {
    id: 'fleet', layout: 'screen', dur: 3.4, images: [img],
    // The whole board in frame (the sessions group dim below it), the runner's two tasks lit.
    spot: [key(0, [runner])],
    camera: [f(board, 1.1, 0), f(board, 1.06, 1)],
  };
  const session: Shot = {
    id: 'session', layout: 'screen', dur: 3.6, images: [img],
    // The light moves down to "Your sessions" and the camera follows it in, close enough that
    // nothing below the board (budget, credentials) is ever in frame.
    spot: [key(0, [runner]), { ...key(0.5, [mine]), cross: true }],
    camera: [f(board, 1.06, 0), f(mine, 1.14, 0.35), f(mine, 1.1, 1)],
  };
  return [fleet, session];
}

export function v8Chapters(s: Stills, look: Look = FILM_LOOK): Shot[][] {
  return v7Chapters(s, look, { agents });
}

export function v8Film(s: Stills, spoken: Spoken): Cut {
  return filmOf(v8Chapters(s), spoken);
}

export function v8Captioned(s: Stills, spoken: Spoken): Cut {
  return captionedOf(v8Chapters(s), V8_LINES, spoken);
}
