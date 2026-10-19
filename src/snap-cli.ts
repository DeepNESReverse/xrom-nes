/**
 * A cartridge's screens as pictures, headless: run it, press what the script says, save frames.
 *
 *   npm run snap -- <rom.nes> <out dir> "wait 120, start 4, wait 200, shot title, right 90, shot run"
 *
 * Steps, comma-separated: `wait N` runs N frames with nothing held; `<buttons> N` holds them
 * (`start`, `select`, `a`, `b`, `up`, `down`, `left`, `right`, joined by `+`) for N frames;
 * `shot <name>` saves the last frame as `<name>.png` (×1 and ×3), its layers apart as
 * `<name>-bg.png` and `<name>-sprites.png` (transparent where empty), and `<name>.json` — palette,
 * sprite memory, nametables, CHR — for reading the graphics afterwards; `every N <name>` saves a
 * frame every N frames from then on, numbered, until the next `every 0`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUTTON, Nes, parseRom } from './nes.ts';
import { encodePng } from './png.ts';
import { HEIGHT, Ppu, WIDTH } from './ppu.ts';

const [rom, out, script] = process.argv.slice(2);
if (!rom || !out || !script) {
  console.error('usage: snap <rom.nes> <out dir> "<steps>"');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const cart = parseRom(new Uint8Array(readFileSync(rom)));
const nes = new Nes(cart);
const ppu = new Ppu(cart);
nes.ppu = ppu;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
function shot(name: string) {
  const s = ppu.snapshot();
  writeFileSync(join(out, `${name}.png`), encodePng(s.pixels, WIDTH, HEIGHT));
  writeFileSync(join(out, `${name}@3x.png`), encodePng(s.pixels, WIDTH, HEIGHT, 3));
  writeFileSync(join(out, `${name}-bg.png`), encodePng(s.background, WIDTH, HEIGHT));
  writeFileSync(join(out, `${name}-sprites.png`), encodePng(s.sprites, WIDTH, HEIGHT));
  writeFileSync(
    join(out, `${name}.json`),
    JSON.stringify({
      frame: nes.frame,
      ctrl: s.ctrl,
      mask: s.mask,
      palette: [...s.palette],
      oam: hex(s.oam),
      nametables: hex(s.nametables),
      chr: hex(s.chr),
    })
  );
  console.log(`frame ${nes.frame}: ${name}.png`);
}

let every = 0;
let everyName = '';
let everyCount = 0;
function frames(n: number, buttons: number) {
  for (let i = 0; i < n; i++) {
    nes.buttons = buttons;
    nes.runFrame();
    if (every && nes.frame % every === 0) shot(`${everyName}-${String(everyCount++).padStart(3, '0')}`);
  }
}

for (const step of script.split(',').map((s) => s.trim()).filter(Boolean)) {
  const [verb, arg, arg2] = step.split(/\s+/);
  if (verb === 'wait') frames(Number(arg), 0);
  else if (verb === 'shot') shot(arg);
  else if (verb === 'every') {
    every = Number(arg);
    everyName = arg2 ?? 'f';
    everyCount = 0;
  } else {
    const buttons = verb
      .split('+')
      .reduce((mask, b) => mask | (BUTTON[(b === 'a' || b === 'b' ? b.toUpperCase() : b) as keyof typeof BUTTON] ?? 0), 0);
    if (!buttons) throw new Error(`unknown step: ${step}`);
    frames(Number(arg ?? 1), buttons);
  }
}
