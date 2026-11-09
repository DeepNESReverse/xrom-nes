/**
 * Objects, poses and animations out of a recording of sprite memory (`sprites-cli.ts`):
 *
 *   npm run animations -- <sprites.json> <out dir>
 *
 * A frame's sprites are joined into objects where they touch and share a palette — a game builds
 * a character out of 8×8 pieces laid side by side in its colours, so the pieces of one thing meet,
 * and two things that meet (Charlie in a ring) are drawn in different palettes. An
 * object's POSE is its pieces relative to its top-left corner: the tile, the flips and the palette
 * of each. The same pose seen again is the same pose, wherever it stands.
 *
 * Objects are followed from frame to frame by where they are (nearest centre, within reach), and a
 * followed object's poses in order, with how many frames each is held, are its animation.
 *
 * Out: `poses.png` (every pose, numbered, ×3), `poses.json` (each pose's pieces and colours) and
 * `tracks.json` (each followed object: its poses as `[pose, frames]` runs).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NES_RGB } from './palette.ts';
import { encodePng } from './png.ts';

interface Piece {
  dx: number;
  dy: number;
  tile: number;
  attr: number;
}
interface Pose {
  id: number;
  width: number;
  height: number;
  pieces: Piece[];
  /** The colours of each sprite palette its pieces use, by palette index 0–3: 4 NES colours. */
  colors: Record<number, number[]>;
  seen: number;
}

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('usage: animations <sprites.json> <out dir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const rec = JSON.parse(readFileSync(input, 'utf8')) as {
  ctrl: number;
  chr: string;
  frames: { frame: number; oam: string; palette: string }[];
};
const chr = Buffer.from(rec.chr, 'hex');
const tall = (rec.ctrl & 0x20) !== 0;
const spriteTable = rec.ctrl & 0x08 ? 0x1000 : 0;
const H = tall ? 16 : 8;

const poses = new Map<string, Pose>();
/** A followed object: where it was last, and its poses in order. */
interface Track {
  id: number;
  cx: number;
  cy: number;
  last: number;
  seq: number[];
  frames: number[];
}
const tracks: Track[] = [];

for (const [n, f] of rec.frames.entries()) {
  const oam = Buffer.from(f.oam, 'hex');
  const pal = Buffer.from(f.palette, 'hex');
  const sprites: { x: number; y: number; tile: number; attr: number }[] = [];
  for (let s = 0; s < 64; s++) {
    const y = oam[s * 4] + 1;
    if (y >= 240) continue;
    sprites.push({ x: oam[s * 4 + 3], y, tile: oam[s * 4 + 1], attr: oam[s * 4 + 2] });
  }
  // Pieces that touch (a pixel apart at most) are one object.
  const parent = sprites.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < sprites.length; i++)
    for (let j = i + 1; j < sprites.length; j++) {
      const a = sprites[i];
      const b = sprites[j];
      // One palette, one thing: Charlie passing through a ring touches it but is not part of it.
      if ((a.attr & 3) === (b.attr & 3) && Math.abs(a.x - b.x) <= 9 && Math.abs(a.y - b.y) <= H + 1)
        parent[find(i)] = find(j);
    }
  const groups = new Map<number, typeof sprites>();
  sprites.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]));

  for (const group of groups.values()) {
    const x0 = Math.min(...group.map((s) => s.x));
    const y0 = Math.min(...group.map((s) => s.y));
    const pieces = group
      .map((s) => ({ dx: s.x - x0, dy: s.y - y0, tile: s.tile, attr: s.attr & 0xe3 }))
      .sort((a, b) => a.dy - b.dy || a.dx - b.dx || a.tile - b.tile);
    const width = Math.max(...pieces.map((p) => p.dx)) + 8;
    const height = Math.max(...pieces.map((p) => p.dy)) + H;
    const colors: Record<number, number[]> = {};
    for (const p of pieces) colors[p.attr & 3] = [...pal.subarray(0x10 + (p.attr & 3) * 4, 0x14 + (p.attr & 3) * 4)];
    const key = JSON.stringify([pieces, colors]);
    let pose = poses.get(key);
    if (!pose) poses.set(key, (pose = { id: poses.size, width, height, pieces, colors, seen: 0 }));
    pose.seen++;
    // Follow: the nearest track seen last frame, within reach, or a new one.
    const cx = x0 + width / 2;
    const cy = y0 + height / 2;
    let best: Track | undefined;
    let bestD = 24;
    for (const t of tracks) {
      if (t.last !== n - 1) continue;
      const d = Math.hypot(t.cx - cx, t.cy - cy);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    if (!best) tracks.push((best = { id: tracks.length, cx, cy, last: n, seq: [], frames: [] }));
    best.cx = cx;
    best.cy = cy;
    best.last = n;
    best.seq.push(pose.id);
    best.frames.push(f.frame);
  }
}

// Every pose drawn on one sheet, numbered by its order of first sight.
const list = [...poses.values()];
const SCALE = 3;
const PAD = 6;
const cols = 10;
const cellW = Math.max(...list.map((p) => p.width)) + PAD;
const cellH = Math.max(...list.map((p) => p.height)) + PAD;
const W = cols * cellW;
const Ht = Math.ceil(list.length / cols) * cellH;
const pixels = new Int32Array(W * Ht).fill(0x202030);
for (const [i, pose] of list.entries()) {
  const ox = (i % cols) * cellW + 3;
  const oy = Math.floor(i / cols) * cellH + 3;
  for (const p of pose.pieces) {
    for (let row = 0; row < H; row++) {
      let r = p.attr & 0x80 ? H - 1 - row : row;
      let base = tall ? (p.tile & 1) * 0x1000 + (p.tile & 0xfe) * 16 : spriteTable + p.tile * 16;
      if (tall && r >= 8) {
        base += 16;
        r -= 8;
      }
      const lo = chr[base + r];
      const hi = chr[base + r + 8];
      for (let col = 0; col < 8; col++) {
        const bit = p.attr & 0x40 ? col : 7 - col;
        const c = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        if (!c) continue;
        pixels[(oy + p.dy + row) * W + ox + p.dx + col] = NES_RGB[pose.colors[p.attr & 3][c] & 0x3f];
      }
    }
  }
}
writeFileSync(join(outDir, 'poses.png'), encodePng(pixels, W, Ht, SCALE));
writeFileSync(join(outDir, 'poses.json'), JSON.stringify(list));

// Tracks as runs of poses; the short-lived ones (a pose or two) are flicker and noise.
const runs = tracks
  .filter((t) => t.seq.length >= 8)
  .map((t) => {
    const out: [number, number][] = [];
    for (const p of t.seq) {
      const lastRun = out[out.length - 1];
      if (lastRun && lastRun[0] === p) lastRun[1]++;
      else out.push([p, 1]);
    }
    return { id: t.id, from: t.frames[0], to: t.frames[t.frames.length - 1], poses: new Set(t.seq).size, runs: out };
  });
writeFileSync(join(outDir, 'tracks.json'), JSON.stringify(runs, null, 1));
console.log(`${list.length} poses, ${runs.length} tracks → ${outDir}`);
for (const t of runs.slice(0, 12))
  console.log(
    `track ${t.id}: frames ${t.from}–${t.to}, ${t.poses} poses: ${t.runs
      .slice(0, 14)
      .map(([p, n]) => `${p}×${n}`)
      .join(' ')}`
  );
