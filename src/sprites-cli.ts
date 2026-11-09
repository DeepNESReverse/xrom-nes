/**
 * A cartridge's sprites as the game drew them, frame by frame, headless:
 *
 *   npm run sprites -- <rom.nes> <out.json> "wait 100, start 3, wait 270, right+a 4, right 300"
 *
 * The steps are `snap`'s (`wait N`, `<buttons> N`), and `record` / `record off` around what is kept,
 * and `poke $63 3 10` to write a RAM byte before each of the next 10 frames (a game's stage number,
 * to start where the recording is wanted), and `background` to keep each frame's first nametable
 * too, for a game that draws its characters in the background (Yie Ar Kung-Fu's fighters) — or
 * `background shown` the one the screen shows (PPUCTRL's nametable bits) instead, for a game that
 * draws the next frame in the hidden nametable and flips to it (Bokosuka Wars). Every
 * frame's sprite memory is kept with the
 * palette it was drawn in, and the pattern tables once at the end — what is needed to find the
 * objects on screen, their poses and how long each is held (`animations.ts`).
 *
 * Out: `{ ctrl, chr, frames: [{ frame, oam, palette, nt? }] }`, `oam`, `nt` and `chr` as hex. Under a mapper
 * that switches CHR (MMC3) a frame also has `banks` — `[line, …eight 1 KB slots' offsets in CHR
 * ROM]` wherever they change down the screen — and the recording all of CHR ROM, `chrRom`, so a
 * sprite's tile is read from the bank its line was drawn with (`clips.ts`).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { BUTTON, Nes, parseRom } from './nes.ts';
import { Ppu } from './ppu.ts';

const [rom, out, script] = process.argv.slice(2);
if (!rom || !out || !script) {
  console.error('usage: sprites <rom.nes> <out.json> "<steps>"');
  process.exit(1);
}
const cart = parseRom(new Uint8Array(readFileSync(rom)));
const nes = new Nes(cart);
const ppu = new Ppu(cart, nes.mapper);
nes.ppu = ppu;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const frames: { frame: number; oam: string; palette: string; nt?: string; banks?: number[][] }[] = [];
let recording = false;
let background: false | 'first' | 'shown' = false;

const ram = (nes as unknown as { ram: Uint8Array }).ram;
/** Writes into work RAM before each frame — `poke $63 3 10`: Circus Charlie's stage, for 10 frames. */
let pokes: { address: number; value: number; left: number }[] = [];

function run(n: number, buttons: number) {
  for (let i = 0; i < n; i++) {
    for (const p of pokes) if (p.left-- > 0) ram[p.address & 0x7ff] = p.value;
    pokes = pokes.filter((p) => p.left > 0);
    nes.buttons = buttons;
    nes.runFrame();
    if (recording) {
      const s = ppu.snapshot();
      const banks = s.chrLines?.flatMap((slots, line, all) =>
        line > 0 && slots.join() === all[line - 1].join() ? [] : [[line, ...slots]]
      );
      frames.push({
        frame: nes.frame,
        oam: hex(s.oam),
        palette: hex(s.palette),
        ...(background
          ? { nt: hex(s.nametables.subarray(background === 'shown' ? (s.ctrl & 3) * 0x400 : 0, (background === 'shown' ? (s.ctrl & 3) * 0x400 : 0) + 0x400)) }
          : {}),
        ...(banks ? { banks } : {}),
      });
    }
  }
}

for (const step of script.split(',').map((s) => s.trim()).filter(Boolean)) {
  const [verb, arg, arg2, arg3] = step.split(/\s+/);
  if (verb === 'wait') run(Number(arg), 0);
  else if (verb === 'poke')
    pokes.push({ address: parseInt(arg.replace('$', ''), 16), value: Number(arg2), left: Number(arg3 ?? 1) });
  else if (verb === 'record') recording = arg !== 'off';
  else if (verb === 'background') background = arg === 'shown' ? 'shown' : 'first';
  else {
    const buttons = verb
      .split('+')
      .reduce(
        (mask, b) =>
          mask | (BUTTON[(b === 'a' || b === 'b' ? b.toUpperCase() : b) as keyof typeof BUTTON] ?? 0),
        0
      );
    if (!buttons) throw new Error(`unknown step: ${step}`);
    run(Number(arg ?? 1), buttons);
  }
}

const last = ppu.snapshot();
writeFileSync(
  out,
  JSON.stringify({
    ctrl: last.ctrl,
    chr: hex(last.chr),
    ...(last.chrLines ? { chrRom: hex(cart.chr) } : {}),
    frames,
  })
);
console.log(`${frames.length} frames of sprites → ${out}`);
