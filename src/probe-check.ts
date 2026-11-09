/**
 * npm run probe-check -- <session dir> [--rom <file.nes>]
 *
 * Reads a session the FCEUX probe (fceux/nes_music_probe.lua) recorded and says whether it
 * is sound: frames in order, every chip write with its time and code address, FCEUX's view
 * of the channels, RAM snapshots one a frame. With --rom it also runs the same cartridge
 * on this package's own headless NES and lines the two streams of writes up, channel by
 * channel: two emulators that agree on what the driver tells the chip are worth trusting.
 *
 * The comparison is by the order of writes, not their time — the probe starts recording
 * whenever the script is run, and the headless NES from power-on — so it finds where the
 * probe's first writes sit in the headless stream and counts how far they agree from there.
 */

import { readFileSync } from 'node:fs';
import { CHANNEL_NAMES, channelOf, readSession } from './probe/session.ts';
import { Nes, parseRom } from './nes.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--rom');
if (!dir) {
  console.error('usage: npm run probe-check -- <session dir> [--rom <file.nes>]');
  process.exit(1);
}

const s = readSession(dir);
const problems: string[] = [];
const hex = (n: number, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

console.log(`ROM       ${String((s.meta.rom as { file?: string })?.file ?? '?')}  md5 ${String((s.meta.rom as { md5?: string })?.md5 ?? '?')}`);
console.log(`region    ${String(s.meta.region)}  (${String(s.meta.cyclesPerFrame)} cycles a frame)`);
console.log(`frames    ${s.frames.length}  writes ${s.writes.length}  $4015 reads ${s.reads.length}  sound.get ${s.sound.length}  RAM snapshots ${s.ramFrames}`);
console.log(`stopped   ${String(s.meta.stopped ?? 'still running, or FCEUX closed without stopping the script')}`);
const features = s.meta.features as Record<string, boolean> | undefined;
if (features) console.log(`missing   ${Object.entries(features).filter(([, ok]) => !ok).map(([n]) => n).join(', ') || 'nothing'}`);
if ((s.meta.warnings as string[] | undefined)?.length) console.log(`warnings  ${(s.meta.warnings as string[]).join(' | ')}`);
if (s.markers.length) console.log(`markers   ${s.markers.slice(0, 12).map((m) => `${m.frame}: ${m.text}`).join(' | ')}${s.markers.length > 12 ? ' …' : ''}`);

// Frames: numbered 1, 2, 3… with no gaps; cycles rising.
for (let i = 1; i < s.frames.length; i++) {
  if (s.frames[i].frame !== s.frames[i - 1].frame + 1) {
    problems.push(`frame ${s.frames[i - 1].frame} is followed by ${s.frames[i].frame}`);
    break;
  }
}
const spans = s.frames.slice(1).map((f, i) => f.cycle - s.frames[i].cycle).filter((d) => d > 20000 && d < 40000);
if (spans.length) {
  const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
  console.log(`cycles    ${mean.toFixed(1)} a frame on average over ${spans.length} frames`);
} else if (features?.cycles) problems.push('no frame-to-frame cycle counts: debugger.getcyclescount did not move');

// Writes: inside their frame, and on frames the log has.
const frameSet = new Set(s.frames.map((f) => f.frame));
const outside = s.writes.filter((w) => w.cycle < 0 || w.cycle > 40000).length;
if (outside) problems.push(`${outside} writes with a cycle outside their frame`);
const orphan = s.writes.filter((w) => !frameSet.has(w.frame)).length;
if (orphan) problems.push(`${orphan} writes on frames the log has no F line for`);
if (s.ramFrames && Math.abs(s.ramFrames - s.frames.length) > 1) problems.push(`${s.ramFrames} RAM snapshots for ${s.frames.length} frames`);
if (s.bad.length) problems.push(`${s.bad.length} lines did not parse (first: ${s.bad[0].slice(0, 60)})`);

console.log('\nchannel    writes  code addresses                              frames FCEUX hears it');
for (let ch = 0; ch < 5; ch++) {
  const mine = s.writes.filter((w) => channelOf(w.address) === ch);
  const pcs = new Map<number, number>();
  for (const w of mine) pcs.set(w.pc, (pcs.get(w.pc) ?? 0) + 1);
  const top = [...pcs].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([pc, n]) => `$${hex(pc, 4)}×${n}`).join(' ');
  const heard = s.sound.filter((f) => f.voices[ch]?.volume > 0).length;
  console.log(`${CHANNEL_NAMES[ch].padEnd(9)} ${String(mine.length).padStart(7)}  ${top.padEnd(42)} ${heard}`);
}
const control = s.writes.filter((w) => channelOf(w.address) < 0);
console.log(`$4014-17  ${String(control.length).padStart(7)}  ${[...new Set(control.map((w) => `$${hex(w.address, 4)}`))].join(' ')}`);

// The other emulator.
const rom = opt('rom');
if (rom) {
  const nes = new Nes(parseRom(new Uint8Array(readFileSync(rom))));
  const frames = Math.max(600, (s.meta.fceuxFrameAtStart as number ?? 0) + s.frames.length + 600);
  for (let f = 0; f < frames && !nes.cpu.jammed; f++) nes.runFrame();
  console.log(`\nheadless  ${frames} frames from power-on, ${nes.writes.length} writes${nes.cpu.jammed ? `, CPU jammed at $${hex(nes.cpu.pc, 4)}` : ''}`);
  for (let ch = 0; ch < 5; ch++) {
    const key = (w: { address: number; value: number }) => (w.address << 8) | w.value;
    const probe = s.writes.filter((w) => channelOf(w.address) === ch).map(key);
    const headless = nes.writes.filter((w) => channelOf(w.address) === ch).map(key);
    if (probe.length === 0) {
      console.log(`${CHANNEL_NAMES[ch].padEnd(9)} nothing recorded by the probe`);
      continue;
    }
    // Where the probe's opening run of writes sits in the headless stream.
    const run = Math.min(32, probe.length);
    let at = -1;
    for (let i = 0; i + run <= headless.length && at < 0; i++) {
      let same = true;
      for (let k = 0; k < run && same; k++) same = headless[i + k] === probe[k];
      if (same) at = i;
    }
    if (at < 0) {
      console.log(`${CHANNEL_NAMES[ch].padEnd(9)} the probe's first ${run} writes are not in the headless stream`);
      problems.push(`${CHANNEL_NAMES[ch]}: the two emulators' writes do not line up`);
      continue;
    }
    let agree = 0;
    while (agree < probe.length && at + agree < headless.length && probe[agree] === headless[at + agree]) agree++;
    const of = Math.min(probe.length, headless.length - at);
    const first = agree < of ? probe[agree] : null;
    console.log(
      `${CHANNEL_NAMES[ch].padEnd(9)} agree on ${agree} of ${of} writes from headless write ${at}` +
        (first !== null ? `; first difference: probe $${hex(first >> 8, 4)}=${hex(first & 255)}, headless $${hex(headless[at + agree] >> 8, 4)}=${hex(headless[at + agree] & 255)}` : '')
    );
  }
}

console.log(problems.length ? `\nPROBLEMS\n  ${problems.join('\n  ')}` : '\nno problems found');
process.exit(problems.length ? 2 : 0);
