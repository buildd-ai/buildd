/**
 * Generates the animated spinner used in buildd's sticky PR activity comment
 * (`apps/web/src/lib/pr-activity-comment.ts`). GitHub proxies comment images
 * through camo, which passes animated GIFs straight through — a GIF is the only
 * format that reliably animates inside a PR comment (animated SVG does not).
 *
 * Committed as a binary asset, regenerable with:
 *   bun run scripts/generate-pr-spinner-gif.ts
 *
 * Self-contained GIF89a encoder — no image dependency in the tree for one
 * 40x40 asset. Two deliberate simplifications:
 *
 * 1. LZW runs in "literal" mode: a Clear code every 250 codes keeps the
 *    decoder's table under the 9-bit boundary, so no compressor is needed. It
 *    costs ~2KB per frame, which is irrelevant for a spinner.
 * 2. GIF has no alpha, so dot edges are anti-aliased by blending toward mid
 *    grey (#808080) rather than toward the page — that reads on both GitHub's
 *    light and dark themes, which a blend toward white or black would not.
 *
 * The asset is rendered at 40x40 and displayed at 16x16, so the browser's
 * downscale smooths whatever the 3-level coverage quantization leaves behind.
 */

const SIZE = 40;
const FRAMES = 12;
const DELAY_CENTISECONDS = 6; // 12 frames × 60ms → ~0.7s per rotation
const POSITIONS = 12;
const ORBIT_RADIUS = 14;
const DOT_RADIUS = 4.2;
/** Dots this far behind the leader are dropped — reads as a comet, not a static ring. */
const TRAIL_LENGTH = 8;
/** Supersampling factor per axis when measuring dot coverage. */
const SUPERSAMPLE = 4;
/** Quantization steps for partial coverage (edge pixels). */
const COVERAGE_LEVELS = 3;

/** Brand accent (#f4811f). */
const ACCENT = [0xf4, 0x81, 0x1f] as const;
const NEUTRAL = 0x80;
const TRAIL_FLOOR = 0.3; // faintest full-coverage dot
const TRAIL_GAMMA = 1.6; // >1 concentrates brightness in the leading dots

/** Brightness of a full-coverage dot `behind` steps behind the leader. */
function trailIntensity(behind: number): number {
  const ramp = Math.pow(1 - behind / TRAIL_LENGTH, TRAIL_GAMMA);
  return TRAIL_FLOOR + (1 - TRAIL_FLOOR) * ramp;
}

/**
 * Palette layout: index 0 is transparent, then TRAIL_LENGTH groups of
 * COVERAGE_LEVELS entries (dimmest coverage first within each group).
 */
function paletteIndex(behind: number, coverageLevel: number): number {
  return 1 + behind * COVERAGE_LEVELS + (coverageLevel - 1);
}

function buildPalette(): number[] {
  const table = [0, 0, 0];
  for (let behind = 0; behind < TRAIL_LENGTH; behind++) {
    for (let level = 1; level <= COVERAGE_LEVELS; level++) {
      const t = trailIntensity(behind) * (level / COVERAGE_LEVELS);
      for (const channel of ACCENT) {
        table.push(Math.round(NEUTRAL + (channel - NEUTRAL) * t));
      }
    }
  }
  const entries = table.length / 3;
  const padded = 1 << Math.ceil(Math.log2(entries));
  while (table.length < padded * 3) table.push(0);
  return table;
}

const PALETTE = buildPalette();
const PALETTE_BITS = Math.log2(PALETTE.length / 3) - 1;

function renderFrame(frame: number): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE); // 0 = transparent
  const centre = (SIZE - 1) / 2;
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let position = 0; position < POSITIONS; position++) {
    // The bright dot advances one position per frame; the rest trail behind it.
    const behind = (position - frame + POSITIONS) % POSITIONS;
    if (behind >= TRAIL_LENGTH) continue;

    const angle = (2 * Math.PI * position) / POSITIONS - Math.PI / 2;
    const cx = centre + ORBIT_RADIUS * Math.cos(angle);
    const cy = centre + ORBIT_RADIUS * Math.sin(angle);
    const lo = Math.max(0, Math.floor(Math.min(cx, cy) - DOT_RADIUS - 1));
    const hi = Math.min(SIZE - 1, Math.ceil(Math.max(cx, cy) + DOT_RADIUS + 1));

    for (let y = lo; y <= hi; y++) {
      for (let x = lo; x <= hi; x++) {
        let hits = 0;
        for (let sy = 0; sy < SUPERSAMPLE; sy++) {
          for (let sx = 0; sx < SUPERSAMPLE; sx++) {
            const dx = x + (sx + 0.5) * step - 0.5 - cx;
            const dy = y + (sy + 0.5) * step - 0.5 - cy;
            if (dx * dx + dy * dy <= DOT_RADIUS * DOT_RADIUS) hits++;
          }
        }
        if (hits === 0) continue;
        const level = Math.max(1, Math.round((hits / samples) * COVERAGE_LEVELS));
        // Dots never overlap at this radius, so last write wins is fine.
        pixels[y * SIZE + x] = paletteIndex(behind, level);
      }
    }
  }
  return pixels;
}

// ── GIF89a writer ─────────────────────────────────────────────────────────────

class ByteSink {
  private bytes: number[] = [];
  u8(...values: number[]) { this.bytes.push(...values.map((v) => v & 0xff)); }
  u16(value: number) { this.bytes.push(value & 0xff, (value >> 8) & 0xff); }
  ascii(text: string) { for (const ch of text) this.bytes.push(ch.charCodeAt(0)); }
  push(values: ArrayLike<number>) { for (let i = 0; i < values.length; i++) this.bytes.push(values[i]! & 0xff); }
  toUint8Array() { return new Uint8Array(this.bytes); }
}

/** LSB-first bit packer, as GIF's LZW stream requires. */
class BitWriter {
  private bytes: number[] = [];
  private current = 0;
  private bits = 0;
  write(code: number, width: number) {
    this.current |= code << this.bits;
    this.bits += width;
    while (this.bits >= 8) {
      this.bytes.push(this.current & 0xff);
      this.current >>= 8;
      this.bits -= 8;
    }
  }
  flush(): number[] {
    if (this.bits > 0) {
      this.bytes.push(this.current & 0xff);
      this.current = 0;
      this.bits = 0;
    }
    return this.bytes;
  }
}

const MIN_CODE_SIZE = 8;
const CLEAR_CODE = 1 << MIN_CODE_SIZE;  // 256
const EOI_CODE = CLEAR_CODE + 1;        // 257
const CODE_WIDTH = MIN_CODE_SIZE + 1;   // 9 bits, held constant
/** Decoder adds one table entry per code; re-clear before it needs 10 bits. */
const CODES_PER_CLEAR = 250;

function encodeImageData(pixels: Uint8Array): number[] {
  const bits = new BitWriter();
  bits.write(CLEAR_CODE, CODE_WIDTH);
  let sinceClear = 0;
  for (const pixel of pixels) {
    if (sinceClear >= CODES_PER_CLEAR) {
      bits.write(CLEAR_CODE, CODE_WIDTH);
      sinceClear = 0;
    }
    bits.write(pixel, CODE_WIDTH);
    sinceClear++;
  }
  bits.write(EOI_CODE, CODE_WIDTH);
  return bits.flush();
}

function writeSubBlocks(sink: ByteSink, data: number[]) {
  for (let offset = 0; offset < data.length; offset += 255) {
    const chunk = data.slice(offset, offset + 255);
    sink.u8(chunk.length);
    sink.push(chunk);
  }
  sink.u8(0x00); // block terminator
}

function buildGif(): Uint8Array {
  const sink = new ByteSink();

  sink.ascii('GIF89a');
  sink.u16(SIZE);
  sink.u16(SIZE);
  sink.u8(0x80 | PALETTE_BITS); // global colour table of 2^(bits+1) entries
  sink.u8(0x00); // background colour index
  sink.u8(0x00); // default pixel aspect ratio
  sink.push(PALETTE);

  // Netscape application extension — loop forever.
  sink.u8(0x21, 0xff, 0x0b);
  sink.ascii('NETSCAPE2.0');
  sink.u8(0x03, 0x01);
  sink.u16(0); // 0 = infinite
  sink.u8(0x00);

  for (let frame = 0; frame < FRAMES; frame++) {
    // Graphic control extension: dispose to background + transparent index 0,
    // so frames never accumulate over each other.
    sink.u8(0x21, 0xf9, 0x04, 0x09);
    sink.u16(DELAY_CENTISECONDS);
    sink.u8(0x00, 0x00);

    sink.u8(0x2c);
    sink.u16(0);
    sink.u16(0);
    sink.u16(SIZE);
    sink.u16(SIZE);
    sink.u8(0x00); // no local colour table, not interlaced

    sink.u8(MIN_CODE_SIZE);
    writeSubBlocks(sink, encodeImageData(renderFrame(frame)));
  }

  sink.u8(0x3b); // trailer
  return sink.toUint8Array();
}

const OUT = new URL('../apps/web/public/github/pr-working.gif', import.meta.url).pathname;
await Bun.write(OUT, buildGif());
console.log(
  `Wrote ${OUT} (${Bun.file(OUT).size} bytes, ${FRAMES} frames, ${SIZE}x${SIZE}, ${PALETTE.length / 3}-colour palette)`,
);
