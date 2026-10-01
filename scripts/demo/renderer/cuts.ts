/**
 * The v4 cuts, over the stills `storyboards/demo-v4.yaml` captures: the full
 * film (~50s, one idea per shot, 4-6s holds, slow camera) and the 16s hero
 * loop. Points are image fractions (0..1) of the still they sit on.
 *
 * Captions: short, plain, present tense. No "X, not Y", no em dashes.
 */
import type { Cut, Rect, Shot, ShotImage } from './timeline';

/** Looks up a captured still by storyboard step id (and viewport) and returns it sized. */
export type Stills = {
  img: (step: string, viewport?: 'desktop' | 'phone', at?: number) => ShotImage;
  /** The typing frames of a `type:` step. */
  typing: (step: string) => ShotImage[];
  /** Element boxes the storyboard recorded (its `highlight` targets), as fractions of the step's still. */
  boxes: (step: string, target: string, viewport?: 'desktop' | 'phone') => Rect[];
  box: (step: string, target: string, index?: number, viewport?: 'desktop' | 'phone') => Rect;
  /** Boxes with their recorded attributes (data-status/state/kind, text). */
  boxAttrs: (step: string, target: string, viewport?: 'desktop' | 'phone') => Array<{ rect: Rect; status?: string; state?: string; kind?: string; text?: string }>;
  /** Any image in the repo (path from the repo root), e.g. a synthetic screenshot asset. */
  file: (path: string) => ShotImage;
  /** A `highlightText` phrase: one rect per line, and its enclosing block. */
  text: (step: string, phrase: string, viewport?: 'desktop' | 'phone') => { rects: Rect[]; block: Rect };
};

const FRAME = { width: 1920, height: 1080, fps: 30 };

/** Spread typing frames over [from, to] seconds, the last one being the finished text. */
function typed(frames: ShotImage[], from: number, to: number): { images: ShotImage[]; keys: number[] } {
  const step = (to - from) / Math.max(1, frames.length - 1);
  const images = frames.map((f, i) => ({ ...f, at: i === 0 ? 0 : from + i * step }));
  // A tick per frame change plus one between: calm typing, not a drum roll.
  const keys: number[] = [];
  for (let i = 1; i < frames.length; i++) keys.push(images[i].at - step / 2, images[i].at);
  return { images, keys };
}

export function fullCut(s: Stills): Cut {
  const ask = typed(s.typing('s01-ask'), 0.8, 3.3);
  const shots: Shot[] = [
    {
      id: 'ask', layout: 'screen', dur: 4.5,
      images: ask.images, keys: ask.keys,
      caption: 'Start with one sentence.',
      camera: [{ at: 0, cx: 0.5, cy: 0.5, zoom: 1 }, { at: 1, cx: 0.52, cy: 0.8, zoom: 1.22 }],
    },
    {
      id: 'reads', layout: 'screen', dur: 5.5,
      images: [s.img('s02-thread')],
      caption: [{ at: 0, text: 'It reads first, and recalls a past decision.' }, { at: 3.0, text: 'Then it drafts a mission for you to confirm.' }],
      camera: [
        { at: 0, cx: 0.52, cy: 0.16, zoom: 1.28 },
        { at: 0.3, cx: 0.52, cy: 0.16, zoom: 1.28 },
        { at: 0.62, cx: 0.52, cy: 0.68, zoom: 1.18 },
        { at: 1, cx: 0.52, cy: 0.71, zoom: 1.18 },
      ],
      taps: [{ at: 4.7, x: 0.355, y: 0.81 }],
    },
    {
      id: 'rule', layout: 'screen', dur: 6.5,
      images: [s.img('s04-rule-card'), { ...s.img('s05-rule-saved', 'desktop', 4.1), fade: 0 }],
      caption: [{ at: 0, text: 'The mission docks beside the chat.' }, { at: 2.8, text: 'Say a rule once. Tap to keep it.' }],
      camera: [
        { at: 0, cx: 0.5, cy: 0.5, zoom: 1 },
        { at: 0.28, cx: 0.5, cy: 0.5, zoom: 1 },
        { at: 0.52, cx: 0.4, cy: 0.58, zoom: 1.3 },
        { at: 1, cx: 0.4, cy: 0.6, zoom: 1.32 },
      ],
      taps: [{ at: 3.85, x: 0.2156, y: 0.664 }],
    },
    {
      id: 'rules', layout: 'screen', dur: 3.5,
      images: [s.img('s06-rules-settings')],
      caption: 'It applies in billing-web from now on.',
      camera: [{ at: 0, cx: 0.45, cy: 0.48, zoom: 1.12 }, { at: 1, cx: 0.45, cy: 0.5, zoom: 1.22 }],
    },
    {
      id: 'board', layout: 'screen', dur: 4,
      images: [s.img('s07-board')],
      caption: 'The work fans out across a board.',
      camera: [{ at: 0, cx: 0.5, cy: 0.5, zoom: 1 }, { at: 1, cx: 0.42, cy: 0.56, zoom: 1.1 }],
    },
    {
      id: 'fleet', layout: 'screen', dur: 5,
      images: [s.img('s08-home')],
      caption: 'Six agents work at once.',
      camera: [{ at: 0, cx: 0.45, cy: 0.42, zoom: 1 }, { at: 1, cx: 0.37, cy: 0.57, zoom: 1.2 }],
    },
    {
      id: 'question', layout: 'phone', dur: 5.5,
      images: [s.img('s09-question', 'phone'), { ...s.img('s14-answered', 'phone', 3.6), fade: 0 }],
      caption: [{ at: 0, text: 'When a choice matters, it asks.' }, { at: 2.9, text: 'You answer from your phone.' }],
      camera: [{ at: 0, cx: 0.5, cy: 0.5, zoom: 1 }, { at: 1, cx: 0.5, cy: 0.5, zoom: 1.05 }],
      taps: [{ at: 3.3, x: 0.5, y: 0.572 }],
    },
    {
      id: 'screens', layout: 'screen', dur: 4,
      images: [s.img('s10-screens')],
      caption: 'It screenshots its own change, phone and desktop.',
      camera: [{ at: 0, cx: 0.66, cy: 0.3, zoom: 1.12 }, { at: 1, cx: 0.66, cy: 0.36, zoom: 1.3 }],
    },
    {
      id: 'review', layout: 'screen', dur: 5,
      images: [s.img('s11-deck'), { ...s.img('s12-deck-agreed', 'desktop', 3.35), fade: 0 }],
      caption: 'You look, and approve.',
      camera: [{ at: 0, cx: 0.5, cy: 0.5, zoom: 0.8 }, { at: 1, cx: 0.5, cy: 0.5, zoom: 0.815 }],
      taps: [{ at: 3.1, x: 0.633, y: 0.918 }],
    },
    {
      id: 'done', layout: 'screen', dur: 5,
      images: [s.img('s13-complete')],
      caption: 'Done. Every PR merged, every criterion checked.',
      camera: [{ at: 0, cx: 0.5, cy: 0.45, zoom: 1 }, { at: 1, cx: 0.5, cy: 0.52, zoom: 1.14 }],
      chime: 0.7,
    },
  ];
  // Poster: the fleet at peak, mid-push.
  return { name: 'full', ...FRAME, fade: 0.6, fadeOut: 0.9, captions: true, poster: 26.5, shots };
}

/** 16 seconds, four calm holds, no captions, the last fading back into the first. */
export function heroLoop(s: Stills): Cut {
  const shots: Shot[] = [
    { id: 'chat', layout: 'screen', dur: 4, images: [s.img('s04-rule-card')], camera: [{ at: 0, cx: 0.5, cy: 0.5, zoom: 1.04 }, { at: 1, cx: 0.55, cy: 0.45, zoom: 1.12 }] },
    { id: 'fleet', layout: 'screen', dur: 4, images: [s.img('s08-home')], camera: [{ at: 0, cx: 0.45, cy: 0.45, zoom: 1.04 }, { at: 1, cx: 0.37, cy: 0.56, zoom: 1.16 }] },
    { id: 'review', layout: 'screen', dur: 4, images: [s.img('s11-deck')], camera: [{ at: 0, cx: 0.5, cy: 0.5, zoom: 1.02 }, { at: 1, cx: 0.5, cy: 0.45, zoom: 1.1 }] },
    { id: 'done', layout: 'screen', dur: 4, images: [s.img('s13-complete')], camera: [{ at: 0, cx: 0.5, cy: 0.48, zoom: 1.02 }, { at: 1, cx: 0.5, cy: 0.52, zoom: 1.1 }] },
  ];
  return { name: 'hero', ...FRAME, fade: 0.8, loop: true, captions: false, shots };
}
