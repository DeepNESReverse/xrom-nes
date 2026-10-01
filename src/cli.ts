/**
 * npm run notes -- <rom.nes> --slug robocop [--name "RoboCop — title"]
 *   [--seconds 120] [--press start@600,start@700] [--skip 0] [--sixteenth 9]
 *   [--out <dir>] [--id 1]
 *
 * Boots the cartridge headless, records its music from the first note on,
 * decodes it into notes and writes a /music collection for the workshop
 * (default: battletoads-tools-next/public/tracks/<slug>/notes).
 *
 * --press   buttons to press, `button@frame` (held for 4 frames), to get past
 *           a title screen or into a level. Buttons: A B select start up down
 *           left right.
 * --skip    seconds of music to skip after the first note (to start later).
 *
 * The score's reading, by ear (all optional):
 * --bar-offset  ticks (16 to the quarter) from the first note to the first bar
 *               line; the notes before it are the pickup. 2 = a thirty-second.
 * --meter       4/4 (default), 2/4, 3/4…
 * --key         its name for the track list (Dm); --key-signature the VexFlow
 *               key for the signature (F = one flat).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderWrites } from '@xromdev/apu';
import { basename, join } from 'node:path';
import { BUTTON, CPU_HZ, Nes, parseRom } from './nes.ts';
import { decode, type TimedWrite } from './decode.ts';
import { detectGrid } from './grid.ts';
import { writeCollection } from './collection.ts';

const args = process.argv.slice(2);
const rom = args.find((a) => !a.startsWith('--'));
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!rom) {
  console.error('usage: npm run notes -- <rom.nes> --slug <name> [--seconds 120] [--press start@600] [--sixteenth 9]');
  process.exit(1);
}

const slug = opt('slug') ?? basename(rom).replace(/\.nes$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const seconds = Number(opt('seconds') ?? 120);
const skip = Number(opt('skip') ?? 0);
const presses = (opt('press') ?? '')
  .split(',')
  .filter(Boolean)
  .map((p) => {
    const [button, frame] = p.split('@');
    const bit = BUTTON[button as keyof typeof BUTTON];
    if (!bit) throw new Error(`unknown button ${button}`);
    return { bit, frame: Number(frame) };
  });

const cart = parseRom(new Uint8Array(readFileSync(rom)));
const nes = new Nes(cart);
console.log(`${basename(rom)}: mapper ${cart.mapper} (${nes.mapper.name}), PRG ${cart.prg.length / 1024} KB`);

// Run until the music has played `skip + seconds` past its first audible write,
// or give up after two minutes of silence.
const frameHz = CPU_HZ / 29780.5;
const audible = (w: { address: number; value: number }) =>
  w.address === 0x4003 || w.address === 0x4007 || w.address === 0x400b ||
  ((w.address === 0x4000 || w.address === 0x4004 || w.address === 0x400c) && (w.value & 0x0f) > 0 && (w.value & 0x10) !== 0);
let firstFrame = -1;
const limit = 60 * 120;
// The limit is for the silence before the music, not for the music itself.
while (firstFrame >= 0 || nes.frame < limit) {
  nes.buttons = presses.filter((p) => nes.frame >= p.frame && nes.frame < p.frame + 4).reduce((m, p) => m | p.bit, 0);
  nes.runFrame();
  if (firstFrame < 0 && nes.writes.some(audible)) firstFrame = Math.max(0, nes.frame - 2);
  if (firstFrame >= 0 && nes.frame - firstFrame > (skip + seconds) * frameHz + 2) break;
  if (nes.cpu.jammed) throw new Error(`the CPU jammed at $${nes.cpu.pc.toString(16)} on frame ${nes.frame}`);
}
if (firstFrame < 0) throw new Error('no music in two minutes — try --press start@<frame>');

// Writes before the music began still matter (setup: $4015, sweeps), so the
// whole log is replayed; the notes are taken from the first one on.
const t0 = firstFrame * 29780.5;
const writes: TimedWrite[] = nes.writes.map((w) => ({ time: (w.cycle - t0) / CPU_HZ, address: w.address, value: w.value }));
const before = writes.filter((w) => w.time < 0).map((w) => ({ ...w, time: 0 }));
const after = writes.filter((w) => w.time >= 0);
let notes = decode([...before, ...after], skip + seconds, frameHz);
const firstNote = Math.min(...notes.map((n) => n.start));
const from = Math.floor((firstNote + skip) * frameHz) / frameHz;
notes = notes
  .filter((n) => n.start >= from && n.start < from + seconds)
  .map((n) => ({ ...n, start: n.start - from }));

const grid = detectGrid(notes, frameHz);
const sixteenth = opt('sixteenth');
if (sixteenth) {
  grid.sixteenthFrames = Number(sixteenth);
  grid.bpm = (60 * frameHz) / (grid.sixteenthFrames * 4);
}
console.log(
  `music from frame ${firstFrame} (${(firstFrame / frameHz).toFixed(1)} s); ${notes.length} notes; row ${grid.rowFrames} frames, sixteenth ${grid.sixteenthFrames} frames → ♩ = ${grid.bpm.toFixed(2)}`
);

const out = opt('out') ?? join('/Users/alex.m/battletoads_mega_hack copy/battletoads-tools-next/public/tracks', slug, 'notes');
const name = opt('name') ?? `${basename(rom).replace(/\s*\(.*$/, '').replace(/\.nes$/i, '')} — title`;
const id = Number(opt('id') ?? 1);
const meter = opt('meter');
const reading = {
  ...(opt('bar-offset') ? { barOffset: Number(opt('bar-offset')) } : {}),
  ...(meter ? { measureTicks: (64 / Number(meter.split('/')[1])) * Number(meter.split('/')[0]) } : {}),
  ...(opt('key') ? { keyName: opt('key') } : {}),
  ...(opt('key-signature') ? { keySignature: opt('key-signature') } : {}),
};
const written = writeCollection(
  out,
  { id, slug: `${String(id).padStart(2, '0')}_${opt('track') ?? 'title'}`, name, reading, source: `${basename(rom)}, recorded headless and decoded from the sound chip — local research` },
  notes,
  seconds,
  grid,
  frameHz
);
console.log(`→ ${out}: ${written.pitched} notes, ${written.drums} drum hits, ${written.bends} bend shapes`);

// --wav: the recording itself as sound, from the music's start — to check by ear.
if (args.includes('--wav')) {
  const shifted = [...before, ...after].map((w) => ({ ...w, time: Math.max(0, w.time - from) }));
  const { samples, sampleRate } = renderWrites(shifted, seconds, { sampleRate: 44100 });
  const rms: string[] = [];
  for (let s = 0; s < Math.min(seconds, 30); s++) {
    let e = 0;
    for (let i = s * sampleRate; i < (s + 1) * sampleRate; i++) e += samples[i] * samples[i];
    rms.push(Math.sqrt(e / sampleRate).toFixed(2));
  }
  console.log('loudness per second:', rms.join(' '));
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples.length * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  mkdirSync('out', { recursive: true });
  writeFileSync(`out/${slug}.wav`, wav);
  console.log(`→ out/${slug}.wav`);
}
