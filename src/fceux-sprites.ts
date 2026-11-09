/**
 * A take recorded in FCEUX (`fceux/record_sprites.lua`) as `sprites-cli`'s recording, for `clips`:
 *
 *   npm run fceux-sprites -- <take.sprites.txt> <rom.nes> <out.json> [--phase 8 | --frames a-b] [--ctrl 88]
 *
 * The pattern tables come from the ROM's CHR (a board with CHR RAM needs another way); PPUCTRL is
 * not in the take, so `--ctrl` gives its sprite bits (Circus Charlie's is $88: 8×8 sprites from
 * $1000). `--phase N` keeps only the frames in that game phase, and a second before them — for
 * Circus Charlie, 8 is a stage's bonus count, the goal. A take with the nametable (a line's sixth
 * field, `-` where unchanged) gives every frame its `nt`, as `sprites-cli`'s `background` does.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseRom } from './nes.ts';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const [take, rom, out] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!take || !rom || !out) {
  console.error('usage: fceux-sprites <take.sprites.txt> <rom.nes> <out.json> [--phase N] [--ctrl 88]');
  process.exit(1);
}
const cart = parseRom(new Uint8Array(readFileSync(rom)));
if (cart.chr.length === 0) throw new Error('the ROM has CHR RAM: its tiles are not in the file');
const ctrl = parseInt(opt('--ctrl') ?? '88', 16);
const phase = opt('--phase') === undefined ? null : Number(opt('--phase'));

let nt: string | undefined;
const lines = readFileSync(take, 'utf8').trim().split('\n').map((line) => {
  const [frame, ph, stage, oam, palette, table] = line.split(' ');
  if (table && table !== '-') nt = table;
  return { frame: Number(frame), phase: Number(ph), stage: Number(stage), oam, palette, nt };
});
let frames = lines;
/** `--frames 558-759`: the take's lines from one to the other, inclusive. */
if (opt('--frames')) {
  const [a, b] = opt('--frames')!.split('-').map(Number);
  frames = lines.slice(a, b + 1);
}
if (phase !== null) {
  const first = lines.findIndex((l) => l.phase === phase);
  if (first < 0) throw new Error(`phase ${phase} never comes in the take`);
  let last = first;
  while (last + 1 < lines.length && lines[last + 1].phase === phase) last++;
  frames = lines.slice(Math.max(0, first - 60), last + 1);
}
writeFileSync(
  out,
  JSON.stringify({
    ctrl,
    chr: Buffer.from(cart.chr.subarray(0, 0x2000)).toString('hex'),
    frames: frames.map(({ frame, oam, palette, nt }) => ({ frame, oam, palette, ...(nt ? { nt } : {}) })),
  })
);
const stages = [...new Set(frames.map((f) => f.stage))].join(',');
console.log(`${frames.length} frames (stage ${stages}) → ${out}`);
