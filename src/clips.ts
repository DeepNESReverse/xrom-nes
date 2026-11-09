/**
 * A loop of a game's own animation, cut out of a recording of sprite memory (`sprites-cli.ts`):
 *
 *   npm run clips -- <sprites.json> <out.json> --box x,y,w,h [--palettes 2,0] [--with 2] [--from N] [--scan N]
 *   npm run clips -- <sprites.json> <out.png> --preview N        (frame N's sprites, for choosing a box)
 *
 * Every sprite inside the box (its top-left corner in the box) is kept, relative to the box —
 * whatever the game drew there, so a scene of several objects (Charlie on his lion) stays one
 * scene. From `--from` on, the first period P with which the box repeats exactly, frame for frame,
 * twice over and for a second at least (`--window N` frames), is the loop: its P frames are the clip.
 * `--period N` takes N frames from `--from` without the search.
 *
 * Out: `{ width, height, frames: [[x, y, tile, attr], …][], palettes: hex[] }` — a frame's
 * palette is its 16 sprite colours, given per frame only when they change (else ""). The pattern
 * tables are the recording's: `--chr out.bin` writes them beside the clip.
 *
 * A recording under a mapper that switches CHR (`banks`, `chrRom`: `sprites-cli.ts`) reads each
 * sprite's tile from the bank its line was drawn with, and gives the clip its own pattern table,
 * `chr` (hex): the 8×8 tiles it uses, numbered from 0 — the same tile number can be two pictures
 * a few lines apart, or a frame apart, and a bank switched under a pose animates it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { NES_RGB } from './palette.ts';
import { encodePng } from './png.ts';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const [input, out] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!input || !out) {
  console.error('usage: clips <sprites.json> <out> --box x,y,w,h [--from N] [--scan N] | --preview N');
  process.exit(1);
}
const rec = JSON.parse(readFileSync(input, 'utf8')) as {
  ctrl: number;
  chr: string;
  chrRom?: string;
  frames: { frame: number; oam: string; palette: string; banks?: number[][] }[];
};
const chr = Buffer.from(rec.chr, 'hex');
const H = rec.ctrl & 0x20 ? 16 : 8;
const table = rec.ctrl & 0x08 ? 0x1000 : 0;
const chrRom = rec.chrRom ? Buffer.from(rec.chrRom, 'hex') : null;
if (chrRom && H === 16) throw new Error('8×16 sprites under switched CHR banks are not cut yet');

/** `rom`: with switched banks, where the tile's 16 bytes are in CHR ROM. */
type Sprite = [x: number, y: number, tile: number, attr: number, rom?: number];
function spritesOf(n: number): Sprite[] {
  const oam = Buffer.from(rec.frames[n].oam, 'hex');
  const banks = rec.frames[n].banks;
  const list: Sprite[] = [];
  for (let s = 0; s < 64; s++) {
    const y = oam[s * 4] + 1;
    if (y >= 240) continue;
    const sprite: Sprite = [oam[s * 4 + 3], y, oam[s * 4 + 1], oam[s * 4 + 2]];
    if (chrRom && banks) {
      // The banks in force on the sprite's first line.
      const slots = banks.filter(([line]) => line <= y).at(-1)!;
      const address = table + sprite[2] * 16;
      sprite[4] = slots[1 + (address >> 10)] + (address & 0x3ff);
    }
    list.push(sprite);
  }
  return list;
}

/** A sprite's tile's 16 bytes, and where: the recording's pattern tables, or CHR ROM. */
function patternOf(tile: number, rom?: number): [Uint8Array, number] {
  return rom === undefined ? [chr, table + tile * 16] : [chrRom!, rom];
}

/** Sprites drawn over a picture of `w`×`h`, the first in the list in front, as the PPU does. */
function draw(sprites: Sprite[], palette: Buffer, w: number, h: number, pixels: Int32Array, stride: number, ox = 0, oy = 0) {
  for (const [x, y, tile, attr, rom] of [...sprites].reverse()) {
    for (let row = 0; row < H; row++) {
      let r = attr & 0x80 ? H - 1 - row : row;
      let [bytes, base] = patternOf(tile, rom);
      if (H === 16) base = (tile & 1) * 0x1000 + (tile & 0xfe) * 16;
      if (H === 16 && r >= 8) {
        base += 16;
        r -= 8;
      }
      for (let col = 0; col < 8; col++) {
        const bit = attr & 0x40 ? col : 7 - col;
        const c = ((bytes[base + r] >> bit) & 1) | (((bytes[base + r + 8] >> bit) & 1) << 1);
        const px = x + col;
        const py = y + row;
        if (!c || px < 0 || py < 0 || px >= w || py >= h) continue;
        pixels[(oy + py) * stride + ox + px] = NES_RGB[palette[0x10 + (attr & 3) * 4 + c] & 0x3f];
      }
    }
  }
}

if (opt('--preview') !== undefined) {
  const n = Number(opt('--preview'));
  const pixels = new Int32Array(256 * 240).fill(0x181820);
  // A grid every 16 pixels, to read a box off.
  for (let y = 0; y < 240; y++) for (let x = 0; x < 256; x++) if (x % 16 === 0 || y % 16 === 0) pixels[y * 256 + x] = 0x2a2a38;
  draw(spritesOf(n), Buffer.from(rec.frames[n].palette, 'hex'), 256, 240, pixels, 256);
  writeFileSync(out, encodePng(pixels, 256, 240, 3));
  console.log(`frame ${n} (game frame ${rec.frames[n].frame}) → ${out}`);
  process.exit(0);
}

const [bx, by, bw, bh] = (opt('--box') ?? '').split(',').map(Number);
if (!(bw > 0 && bh > 0)) throw new Error('--box x,y,w,h is needed');
const from = Number(opt('--from') ?? 0);
/**
 * `--palettes 2,0`: only sprites in these sprite palettes — Charlie (2) and his lion (0), not the
 * rings rolling past, which would make the box never repeat.
 */
const keep = opt('--palettes')?.split(',').map(Number);
/**
 * `--with 2`: only what is joined to a palette-2 sprite, touching it or touching what does —
 * Charlie's own trapeze, not the next one, whose rope swings into the box at the far end.
 */
const anchor = opt('--with') === undefined ? null : Number(opt('--with'));
/**
 * `--follow 3 --anchor-x 120`: the box goes with a thing that crosses the screen — its x is then
 * relative to the leftmost sprite of palette 3 at x ≥ 120 in the box's rows, frame by frame (a
 * ring with its money bag on its way to Charlie, a monkey on the rope).
 */
const follow = opt('--follow') === undefined ? null : Number(opt('--follow'));
const anchorX = Number(opt('--anchor-x') ?? 0);
const scan = Number(opt('--scan') ?? 240);

/** What the box holds in frame n, relative to the box — and its key, to compare frames by. */
/** The sprites joined, by touching, to one in palette `anchor`. */
function attached(sprites: Sprite[]): Sprite[] {
  if (anchor === null) return sprites;
  const parent = sprites.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < sprites.length; i++)
    for (let j = i + 1; j < sprites.length; j++)
      if (Math.abs(sprites[i][0] - sprites[j][0]) <= 9 && Math.abs(sprites[i][1] - sprites[j][1]) <= H + 1)
        parent[find(i)] = find(j);
  const roots = new Set(sprites.flatMap((s, i) => ((s[3] & 3) === anchor ? [find(i)] : [])));
  return sprites.filter((_, i) => roots.has(find(i)));
}

function boxed(n: number): { sprites: Sprite[]; key: string } {
  const all = spritesOf(n);
  let ox = bx;
  if (follow !== null) {
    const lead = all.filter(([x, y, , a]) => (a & 3) === follow && x >= anchorX && y >= by && y < by + bh);
    ox = (lead.length ? Math.min(...lead.map(([x]) => x)) : 256) + bx;
  }
  const sprites = attached(all.filter(([, , , a]) => !keep || keep.includes(a & 3)))
    .filter(([x, y]) => x >= ox && x < ox + bw && y >= by && y < by + bh)
    .map(([x, y, t, a, rom]): Sprite => (rom === undefined ? [x - ox, y - by, t, a & 0xe3] : [x - ox, y - by, t, a & 0xe3, rom]));
  const key = JSON.stringify([...sprites].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]));
  // Only the colours of the palettes kept: the rings' fire cycles its own palette, not Charlie's.
  const colours = rec.frames[n].palette.slice(32);
  const own = keep ? keep.map((p) => colours.slice(p * 8, p * 8 + 8)).join('') : colours;
  return { sprites, key: key + own };
}

/** How long a loop has to keep repeating to be one: twice over, and a second at least. */
const WINDOW = Number(opt('--window') ?? 60);
/** `--period N`: the loop's length, known from the poses' runs, where a take is too short to prove it. */
let period = Number(opt('--period') ?? 0);
for (let p = 2; p <= scan && !period; p++) {
  let same = true;
  // Held for a whole window, not one period: a pose is held for frames, so two neighbouring frames
  // already "repeat" with a period of one or two.
  for (let i = from; i < from + Math.max(p, WINDOW) && same; i++) same = boxed(i).key === boxed(i + p).key;
  if (same && from + p + Math.max(p, WINDOW) > rec.frames.length) same = false;
  if (same) period = p;
}
if (!period) throw new Error(`no loop of up to ${scan} frames from ${from}`);

const frames: Sprite[][] = [];
const palettes: string[] = [];
let lastPalette = '';
for (let i = from; i < from + period; i++) {
  frames.push(boxed(i).sprites);
  const sprite = rec.frames[i].palette.slice(32);
  palettes.push(sprite === lastPalette ? '' : sprite);
  lastPalette = sprite;
}
// Under switched banks the clip's own pattern table: each tile it shows, once, numbered in order.
let own: Buffer | null = null;
if (chrRom) {
  const index = new Map<string, number>();
  const tiles: Buffer[] = [];
  for (const frame of frames)
    for (const sprite of frame) {
      const bytes = chrRom.subarray(sprite[4]!, sprite[4]! + 16);
      const key = bytes.toString('hex');
      if (!index.has(key)) {
        index.set(key, tiles.length);
        tiles.push(Buffer.from(bytes));
      }
      sprite[2] = index.get(key)!;
    }
  if (tiles.length > 256) throw new Error(`the clip shows ${tiles.length} tiles, more than a table holds`);
  own = Buffer.concat(tiles);
}
// The strip below is drawn from CHR ROM still; the clip itself without the offsets.
const written = frames.map((frame) => frame.map(([x, y, t, a]) => [x, y, t, a]));
writeFileSync(
  out,
  JSON.stringify({ width: bw, height: bh, frames: written, palettes, ...(own ? { chr: own.toString('hex') } : {}) })
);
if (opt('--chr')) writeFileSync(opt('--chr')!, chr);

// A strip of the loop's frames beside the clip, to look at.
const strip = new Int32Array(bw * period * bh).fill(0x181820);
for (let i = 0; i < period; i++)
  draw(frames[i], Buffer.from(rec.frames[from + i].palette, 'hex'), bw, bh, strip, bw * period, i * bw, 0);
writeFileSync(out.replace(/\.json$/, '.png'), encodePng(strip, bw * period, bh, 2));
console.log(`loop of ${period} frames (${(period / 60).toFixed(2)} s), ${bw}×${bh} → ${out}`);
