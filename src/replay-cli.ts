/**
 * A game played in FCEUX (`fceux/record_play.lua`), played again headless — with the picture:
 *
 *   npm run replay -- <rom.nes> <take.play.txt> <out dir> [--shots N] [--from F] [--to F]
 *       [--sprites a-b name …]
 *
 * Every frame runs with the buttons the player held, and then the RAM is laid over with what
 * FCEUX had at the end of that frame: whatever our NES does differently (its timing is by whole
 * scanlines) the game cannot drift from the take. How much it would have drifted — the bytes from
 * $0200 that differ before the overlay — is counted, as a check that the two stay one game.
 *
 *   --shots N         a frame every N as `snap` saves them (picture, layers, JSON), `f<frame>`
 *   --sprites a-b n   frames a to b as `sprites-cli` records them, into `<n>.json` — for `clips`
 *   --screen a-b n    frames a to b as `fceux/record_screen.lua` records them, into `<n>.screen.txt`
 *                     — the camera from the PPU's own scroll — and the pattern tables of frame a
 *                     into `<n>.chr.txt` (hex): a game with CHR RAM (Metroid) has none in the ROM
 *   --from / --to     where to start saving and stop running
 *   --then N          N frames more after the take, nothing held and nothing laid over: what the
 *                     game does by itself once the movie has ended (Metroid's ending and credits)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Nes, parseRom } from './nes.ts';
import { encodePng } from './png.ts';
import { HEIGHT, Ppu, WIDTH } from './ppu.ts';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const [romPath, takePath, out] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--') && args[i - 2] !== '--sprites' && args[i - 2] !== '--screen');
if (!romPath || !takePath || !out) {
  console.error('usage: replay <rom.nes> <take.play.txt> <out dir> [--shots N] [--sprites a-b name] [--screen a-b name] [--from F] [--to F]');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const shotsEvery = Number(opt('--shots') ?? 0);
const from = Number(opt('--from') ?? 0);
const to = Number(opt('--to') ?? Infinity);
const spriteTakes = args.flatMap((a, i) => {
  if (a !== '--sprites') return [];
  const [first, last] = args[i + 1].split('-').map(Number);
  return [{ first, last, name: args[i + 2], frames: [] as object[] }];
});
const screenTakes = args.flatMap((a, i) => {
  if (a !== '--screen') return [];
  const [first, last] = args[i + 1].split('-').map(Number);
  return [{ first, last, name: args[i + 2], lines: [] as string[], last0: '', last1: '' }];
});

const cart = parseRom(new Uint8Array(readFileSync(romPath)));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** The take: one entry a frame, its buttons and the RAM bytes that changed by its end. */
const take: { frame: number; buttons: number; changes: [number, number][]; free?: boolean }[] = [];
for (const line of readFileSync(takePath, 'utf8').split('\n')) {
  if (line.startsWith('f ')) {
    const [, frame, buttons] = line.split(' ').map(Number);
    take.push({ frame, buttons, changes: [] });
  } else if (line.startsWith('r ') && take.length) {
    const body = line.slice(2);
    const changes = take[take.length - 1].changes;
    for (let i = 0; i + 6 <= body.length; i += 6)
      changes.push([parseInt(body.slice(i, i + 4), 16), parseInt(body.slice(i + 4, i + 6), 16)]);
  }
}

const then = Number(opt('--then') ?? 0);
for (let k = 1; k <= then; k++) take.push({ frame: take[take.length - 1].frame + 1, buttons: 0, changes: [], free: true });

/**
 * Plays the take on a NES of its own, `lead` frames of the take ahead of it: FCEUX's frame ends
 * where VBlank begins, so its RAM is laid over at line 241, before the NMI — and how many of its
 * frames come before ours depends on how it powered on, so the lead is found (`calibrate`).
 * `each(n)` runs after our frame n, with the take's entry it was laid over with. Returns the bytes
 * from $0200 that differed before the overlays — zero page and the stack hold wait-for-NMI flags
 * and return addresses, which differ with where each NES stopped, not with the game.
 */
function play(lead: number, frames: number, each?: (nes: Nes, ppu: Ppu, n: number) => void) {
  const nes = new Nes(cart);
  const ppu = new Ppu(cart, nes.mapper);
  nes.ppu = ppu;
  const ram = (nes as unknown as { ram: Uint8Array }).ram;
  const theirs = new Uint8Array(0x800);
  let next = 0;
  /** Their RAM at the end of their entry `n`, the take read on as far as needed. */
  const upTo = (n: number) => {
    for (; next <= n && next < take.length; next++) for (const [address, value] of take[next].changes) theirs[address] = value;
  };
  const stats = { drift: 0, drifted: 0, busy: 0, worst: { frame: 0, bytes: 0 } };
  // The last 64 instructions' addresses: a CPU waiting for the NMI runs a few of them over and
  // over; one still at its frame's work (a room loading over several frames) runs many.
  const cpu = nes.cpu as unknown as { pc: number; step: () => number };
  const recent = new Int32Array(64).fill(-1);
  let ri = 0;
  const step = cpu.step.bind(cpu);
  cpu.step = () => {
    recent[ri++ & 63] = cpu.pc;
    return step();
  };
  const waiting = () => new Set(recent).size <= 16;
  let n = 0;
  nes.beforeVblank = () => {
    const at = n + lead;
    if (at >= take.length || take[at].free) return;
    upTo(at);
    let bytes = 0;
    for (let a = 0x200; a < 0x800; a++) if (ram[a] !== theirs[a]) bytes++;
    if (n > 0) {
      stats.drift += bytes;
      if (bytes) stats.drifted++;
      if (bytes > stats.worst.bytes) stats.worst = { frame: take[at].frame, bytes };
    }
    // Not the stack: it holds our CPU's own return addresses, wherever in its code it stopped.
    // Nor the zero page while our CPU is still at work: its pointers are in use there, and
    // FCEUX's, from a CPU at another point, sent a store into the stack (Metroid, frame 4579:
    // STA ($00),Y at $EF54 wrote a return address over, the RTS jumped into RAM and the NES
    // stopped for good). It is laid over at the next frame the CPU waits.
    if (waiting()) ram.set(theirs.subarray(0, 0x100), 0);
    else stats.busy++;
    ram.set(theirs.subarray(0x200), 0x200);
  };
  for (n = 0; n < frames && n + lead < take.length; n++) {
    nes.buttons = take[n + lead].buttons;
    nes.runFrame();
    each?.(nes, ppu, n);
  }
  return stats;
}

/** The lead with the least drift over the take's first ten seconds. */
const leads = [0, 1, 2, 3, 4].map((lead) => ({ lead, drift: play(lead, 600).drift }));
const { lead } = leads.reduce((a, b) => (b.drift < a.drift ? b : a));
console.log(`lead ${lead} (drift over 600 frames: ${leads.map((l) => `${l.lead}:${l.drift}`).join(' ')})`);

const lastFrame = take.findIndex((e) => e.frame > to);
const stats = play(lead, lastFrame < 0 ? take.length : lastFrame - lead, (nes, ppu, n) => {
  const entry = take[n + lead];
  if (entry.frame < from) return;
  if (shotsEvery && entry.frame % shotsEvery === 0) {
    const s = ppu.snapshot();
    const name = `f${entry.frame}`;
    writeFileSync(join(out, `${name}.png`), encodePng(s.pixels, WIDTH, HEIGHT));
    writeFileSync(join(out, `${name}-bg.png`), encodePng(s.background, WIDTH, HEIGHT));
    writeFileSync(join(out, `${name}-sprites.png`), encodePng(s.sprites, WIDTH, HEIGHT));
    writeFileSync(
      join(out, `${name}.json`),
      JSON.stringify({
        frame: entry.frame,
        ctrl: s.ctrl,
        mask: s.mask,
        palette: [...s.palette],
        oam: hex(s.oam),
        nametables: hex(s.nametables),
        chr: hex(s.chr),
        ...(s.chrLines ? { chrLines: s.chrLines } : {}),
      })
    );
  }
  for (const t of screenTakes) {
    if (entry.frame < t.first || entry.frame > t.last) continue;
    const s = ppu.snapshot();
    // The scroll the frame was drawn with: `t` (the loopy address) and the fine x, as set for it.
    const scroll = ppu as unknown as { t: number; fineX: number };
    const x = ((scroll.t >> 10) & 1) * 256 + (scroll.t & 31) * 8 + scroll.fineX;
    const nt0 = hex(s.nametables.subarray(0, 0x400));
    const nt1 = hex(s.nametables.subarray(0x400, 0x800));
    t.lines.push(
      `${entry.frame} ${x >> 8} ${x & 255} ${hex(s.oam)} ${hex(s.palette)} ${nt0 === t.last0 ? '-' : nt0} ${nt1 === t.last1 ? '-' : nt1}`
    );
    [t.last0, t.last1] = [nt0, nt1];
    if (entry.frame === t.first) writeFileSync(join(out, `${t.name}.chr.txt`), hex(s.chr) + '\n');
    if (entry.frame === t.last) {
      writeFileSync(join(out, `${t.name}.screen.txt`), t.lines.join('\n') + '\n');
      console.log(`${t.name}: ${t.lines.length} frames of the screen`);
    }
  }
  for (const t of spriteTakes) {
    if (entry.frame < t.first || entry.frame > t.last) continue;
    const s = ppu.snapshot();
    const banks = s.chrLines?.flatMap((slots, line, all) =>
      line > 0 && slots.join() === all[line - 1].join() ? [] : [[line, ...slots]]
    );
    t.frames.push({ frame: entry.frame, oam: hex(s.oam), palette: hex(s.palette), ...(banks ? { banks } : {}) });
    if (entry.frame === t.last) {
      writeFileSync(
        join(out, `${t.name}.json`),
        JSON.stringify({ ctrl: s.ctrl, chr: hex(s.chr), ...(s.chrLines ? { chrRom: hex(cart.chr) } : {}), frames: t.frames })
      );
      console.log(`${t.name}: ${t.frames.length} frames of sprites`);
    }
  }
});

const { drift, drifted, busy, worst } = stats;
console.log(
  `${take.length - lead} frames replayed; ${drifted} drifted before the overlay (${(drift / Math.max(1, drifted)).toFixed(1)} bytes on those), ` +
    `the most ${worst.bytes} at frame ${worst.frame}; ${busy} frames with our CPU at work kept their zero page`
);
