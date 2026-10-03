/**
 * The DMC's hits: where a driver struck a sample, which one, and for how long.
 *
 * Read from the register writes, as the rest of the decoding is: `$4010` (rate,
 * loop), `$4012` (where), `$4013` (how long), and bit 4 of `$4015` going from
 * clear to set — that, and only that, starts a sample. A sample plays until its
 * bytes run out, the driver clears the bit, or the next one starts.
 *
 * Which drum a sample is, is read from the sample itself: its 1-bit deltas
 * played back into a waveform, and how often that crosses its own middle. A
 * kick is a slow swing, a snare a fast one, a hat faster still. Contra has two:
 * a 20 ms swing at 130 Hz and 143 ms of noise at 1.6 kHz.
 */

import type { TimedWrite } from './decode.ts';

/** `$4010` rate → CPU cycles per delta bit, NTSC. */
const DMC_PERIODS = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
const CPU_HZ = 1789772.7272727273;

export interface DmcHit {
  /** Seconds, as the writes count them. */
  start: number;
  duration: number;
  address: number;
  /** Bytes, as `$4013` makes the DMC read them: 16·n + 1. */
  length: number;
  rate: number;
  loop: boolean;
  /** The `$4011` level the driver loaded since the last hit, or -1 — see `SampleRow`. */
  level: number;
}

export type DrumKind = 'kick' | 'snare' | 'hat';

/** The noise rate a drum of each kind stands at on the drum staff and the kit: the same lines. */
export const KIND_LANE: Record<DrumKind, number> = { kick: 15, snare: 7, hat: 1 };

export const sampleSeconds = (length: number, rate: number) =>
  (length * 8 * DMC_PERIODS[rate & 0x0f]) / CPU_HZ;

export function dmcHits(writes: readonly TimedWrite[], until: number): DmcHit[] {
  const hits: DmcHit[] = [];
  let r10 = 0;
  let r11 = -1;
  let r12 = 0;
  let r13 = 0;
  let r15 = 0;
  let open: DmcHit | null = null;
  const close = (time: number) => {
    if (!open) return;
    const natural = open.loop ? Infinity : open.start + sampleSeconds(open.length, open.rate);
    open.duration = Math.max(0, Math.min(time, natural) - open.start);
    if (open.duration > 0) hits.push(open);
    open = null;
  };
  for (const w of writes) {
    if (w.time > until) break;
    if (w.address === 0x4010) r10 = w.value;
    else if (w.address === 0x4011) r11 = w.value & 0x7f;
    else if (w.address === 0x4012) r12 = w.value;
    else if (w.address === 0x4013) r13 = w.value;
    else if (w.address === 0x4015) {
      const was = (r15 & 0x10) !== 0;
      const now = (w.value & 0x10) !== 0;
      // A sample that has run out leaves the bit set in the driver's mind; the chip
      // has stopped it, and setting the bit again starts the next.
      const finished = open !== null && !open.loop && w.time >= open.start + sampleSeconds(open.length, open.rate);
      if (now && (!was || finished)) {
        close(w.time);
        open = { start: w.time, duration: 0, address: 0xc000 + r12 * 64, length: r13 * 16 + 1, rate: r10 & 0x0f, loop: (r10 & 0x40) !== 0, level: r11 };
        r11 = -1;
      } else if (!now && was) {
        close(w.time);
      }
      r15 = w.value;
    }
  }
  close(until);
  return hits;
}

/** A sample's kind, from how its waveform swings — see the header. */
export function drumKindOf(bytes: readonly number[], rate: number): DrumKind {
  let level = 64;
  const wave: number[] = [];
  for (const byte of bytes)
    for (let bit = 0; bit < 8; bit++) {
      if ((byte >> bit) & 1) {
        if (level <= 125) level += 2;
      } else if (level >= 2) level -= 2;
      wave.push(level);
    }
  if (wave.length < 2) return 'snare';
  const mean = wave.reduce((sum, v) => sum + v, 0) / wave.length;
  let crossings = 0;
  for (let i = 1; i < wave.length; i++) if ((wave[i - 1] - mean) * (wave[i] - mean) < 0) crossings++;
  const hz = crossings / 2 / (wave.length / (CPU_HZ / DMC_PERIODS[rate & 0x0f]));
  return hz < 400 ? 'kick' : hz < 3000 ? 'snare' : 'hat';
}
