/**
 * The music's grid, in frames, from where its notes begin.
 *
 * - The ROW: the driver's step — the largest step (2..12 frames) that at
 *   least 85% of the steady notes start on. Alien 3: 3 frames.
 * - The SIXTEENTH: the most common short gap between drum hits that is a
 *   whole number of rows (drums usually run in sixteenths and eighths); with no
 *   drums, between the other voices' notes. Alien 3: 9 frames, ♩ ≈ 100.
 *
 * A guess, to be checked by ear — the CLI takes `--sixteenth` to override it.
 */

import type { DecodedNote } from './decode.ts';

export interface Grid {
  rowFrames: number;
  sixteenthFrames: number;
  /** Quarter notes a minute. */
  bpm: number;
}

export function detectGrid(notes: readonly DecodedNote[], frameHz = 60.0988): Grid {
  // Steady notes only: the 1-2 frame splinters of arpeggios and effects carry no beat.
  const steady = notes.filter((n) => n.duration * frameHz >= 3 || n.track === 'noise');
  const onsets = steady.map((n) => n.start * frameHz);

  let rowFrames = 1;
  for (let b = 12; b >= 2; b--) {
    let best = 0;
    for (let phase = 0; phase < b; phase += 0.5) {
      let hit = 0;
      for (const x of onsets) {
        const r = (((x - phase) % b) + b) % b;
        if (r < 0.55 || r > b - 0.55) hit++;
      }
      best = Math.max(best, hit);
    }
    if (onsets.length > 0 && best / onsets.length >= 0.85) {
      rowFrames = b;
      break;
    }
  }

  const gapsOf = (list: readonly DecodedNote[]) => {
    const byTrack = new Map<string, number[]>();
    for (const n of list) (byTrack.get(n.track) ?? byTrack.set(n.track, []).get(n.track)!).push(Math.round(n.start * frameHz));
    const counts = new Map<number, number>();
    for (const starts of byTrack.values()) {
      for (let i = 1; i < starts.length; i++) {
        const gap = starts[i] - starts[i - 1];
        if (gap >= Math.max(3, rowFrames) && gap <= 32) counts.set(gap, (counts.get(gap) ?? 0) + 1);
      }
    }
    return counts;
  };
  const drums = steady.filter((n) => n.track === 'noise');
  const counts = gapsOf(drums.length >= 20 ? drums : steady);
  // The shortest gap that is common (≥ 25% of the most common one) and on the row grid.
  const top = Math.max(0, ...counts.values());
  const candidates = [...counts]
    .filter(([gap, n]) => n >= top * 0.25 && Math.abs(gap / rowFrames - Math.round(gap / rowFrames)) < 0.2)
    .map(([gap]) => gap)
    .sort((a, b) => a - b);
  const sixteenthFrames = candidates[0] ?? rowFrames * 2;
  return { rowFrames, sixteenthFrames, bpm: (60 * frameHz) / (sixteenthFrames * 4) };
}

/**
 * A driver's own clock, for a tempo that is not a whole number of frames: every PLAY adds
 * `increment` to an accumulator, and each time it passes a multiple of `modulus` the music steps
 * one tick. Tick k falls on frame ceil((modulus·k − phase) / increment): Double Dragon's
 * $0704 added to $0705 from $77 (`T:119`), River City Ransom's and Nekketsu Soccer's from 254,
 * Data East's 16-bit counter (`modulus` 65536, `increment` T + 1), Dragon Warrior's 8-bit one
 * that takes 150 back on each carry (`modulus` 150). A phase of half the modulus rounds where
 * the others floor: Kai no Bouken's rows. Frames count from the song's first sound.
 *
 * `changes`: from `frame` on, the increment is another — a tempo command inside the song; the
 * accumulator carries over, unless the change gives a `phase`: then the driver starts its count
 * again there, as at the song's start — the frame is a tick and the accumulator holds `phase`.
 * Konami's and Capcom's tempo commands clear the counter (Bucky O'Hare's $07ED, Mega Man 3): carried
 * over, every step of a ritardando came out a tick short.
 */
export interface DriverTempo {
  increment: number;
  phase: number;
  modulus: number;
  changes: readonly { frame: number; increment: number; phase?: number }[];
}

/** How a moment between two ticks is put on the driver's clock — see `DriverClock.ticksAt`. */
export type ClockSnap = 'floor' | 'first' | 'ceil' | 'between';

export interface DriverClock {
  /** The frame each tick falls on, from tick 0 (the first sound's own). */
  tickFrames: number[];
  /**
   * A moment, in seconds from the first sound, on the driver's clock: `floor` — a start — on the
   * tick its frame falls in (the last tick on or before it); `first` the same, but on the first of
   * the ticks a frame runs when it runs more than one (a tempo above the modulus: the frame alone
   * cannot tell which of them struck the note); `ceil` on the first tick on or after it; `between`
   * as far between two ticks as it is between their frames.
   */
  ticksAt(seconds: number, how: ClockSnap): number;
  /** Ticks → seconds as if every tick of a stretch lasted modulus / increment frames. */
  secondsOf(ticks: number): number;
  /** Where each stretch of one increment begins, in ticks and in those seconds, and its tick's length. */
  stretches: { tick: number; at: number; secondsPerTick: number }[];
}

export function driverClock(tempo: DriverTempo, frameHz: number, frames: number): DriverClock {
  const { modulus, phase } = tempo;
  // A change may add nothing for a while — a stall, Captain Planet's driver standing still a frame —
  // but the tempo the song starts on must step: `--driver-tempo 0:0` came out NaN.
  if (!(tempo.increment > 0) || !(modulus > 0)) throw new Error(`a driver's tempo must add more than nothing to a modulus above 0 (${tempo.increment} of ${modulus})`);
  for (const change of tempo.changes) if (!(change.increment >= 0)) throw new Error(`a change of the driver's tempo adds a negative or no number (${change.increment})`);
  const changes = [...tempo.changes].sort((a, b) => a.frame - b.frame);
  const incrementAt = (frame: number) => {
    let inc = tempo.increment;
    for (const change of changes) if (change.frame <= frame) inc = change.increment;
    return inc;
  };
  const resets = new Map(changes.filter((change) => change.phase !== undefined && change.frame > 0).map((change) => [Math.round(change.frame), change.phase!]));
  // The accumulator before each frame's add is phase + the increments of the frames before it.
  const tickFrames: number[] = [];
  let acc = phase;
  let level = Math.floor(acc / modulus) - 1;
  for (let f = 0; f <= frames + 1; f++) {
    if (f > 0) acc += incrementAt(f - 1);
    if (resets.has(f)) {
      // The count starts again: this frame is a tick, the accumulator holds the phase given.
      acc = resets.get(f)!;
      level = Math.floor(acc / modulus) - 1;
      if (tickFrames[tickFrames.length - 1] === f) level++;
    }
    const now = Math.floor(acc / modulus);
    while (level < now) {
      tickFrames.push(f);
      level++;
    }
  }
  // The tick a frame falls in: the last whose frame is not after it.
  const tickOf = (frame: number) => {
    let lo = 0;
    let hi = tickFrames.length - 1;
    if (frame <= tickFrames[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tickFrames[mid] <= frame) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const ticksAt = (seconds: number, how: ClockSnap) => {
    const frame = seconds * frameHz;
    if (how === 'floor') return tickOf(Math.round(frame));
    if (how === 'first') {
      let k = tickOf(Math.round(frame));
      while (k > 0 && tickFrames[k - 1] === tickFrames[k]) k--;
      return k;
    }
    if (how === 'ceil') {
      const k = tickOf(Math.round(frame));
      return tickFrames[k] < Math.round(frame) ? k + 1 : k;
    }
    const k = tickOf(Math.floor(frame + 1e-6));
    const from = tickFrames[k];
    const to = tickFrames[k + 1] ?? from + modulus / incrementAt(from);
    return k + Math.min(1, Math.max(0, (frame - from) / (to - from)));
  };
  // Each change of increment starts a stretch at the first tick on or after its frame.
  const stretches: { tick: number; at: number; secondsPerTick: number }[] = [{ tick: 0, at: 0, secondsPerTick: modulus / tempo.increment / frameHz }];
  for (const change of changes) {
    if (change.frame <= 0) {
      stretches[0].secondsPerTick = modulus / change.increment / frameHz;
      continue;
    }
    const tick = tickFrames.findIndex((f) => f >= change.frame);
    if (tick < 0) break;
    const last = stretches[stretches.length - 1];
    const stretch = { tick, at: last.at + (tick - last.tick) * last.secondsPerTick, secondsPerTick: modulus / change.increment / frameHz };
    if (tick === last.tick) stretches[stretches.length - 1] = { ...stretch, at: last.at };
    else stretches.push(stretch);
  }
  const secondsOf = (ticks: number) => {
    let at = stretches[0];
    for (const stretch of stretches) if (stretch.tick <= ticks + 1e-9) at = stretch;
    return at.at + (ticks - at.tick) * at.secondsPerTick;
  };
  return { tickFrames, ticksAt, secondsOf, stretches };
}

/**
 * Which stretch of a tempo map the song's tempo is marked by: the one holding more than half the
 * song's ticks, else the first — of the stretches that hold a tick inside the song (`length`
 * seconds; a recording's later passes run on past it, and a stretch that rounds to no tick is not
 * written). The one marked must be one a metronome beats, `range` in the metre's counted beat
 * (`scale` × ♩), up to `halves` times its fastest where the metre can be counted in halves: Daikaijuu
 * Deburas' The Answer slows from ♩150 to a loop at ♩34.7, and a quarter at 34.7 cannot be counted
 * in eighths — the workshop's `countedBeat` has no such beat — so the ♩150 is marked. Half is not
 * more: Fire Emblem Gaiden's Alm 1 opens with 960 ticks at ♩150 and closes with 1024 of its 2048 at
 * ♩140.6, Alm 2 1024 and 1024 — ♩150, as read. When neither can be beaten, the main one is (and the output says it is
 * past a metronome).
 */
export function markedStretch(
  stretches: readonly { at: number; sixteenthFrames: number }[],
  length: number,
  frameHz: number,
  scale = 1,
  halves = 1,
  range = { slowest: 40, fastest: 208 }
): number {
  const ticksOf = (i: number) => {
    const begin = Math.min(stretches[i].at, length);
    const end = Math.min(i + 1 < stretches.length ? stretches[i + 1].at : length, length);
    return Math.max(0, (end - begin) / (stretches[i].sixteenthFrames / 4 / frameHz));
  };
  const all = stretches.reduce((sum, _, i) => sum + ticksOf(i), 0);
  const beatable = (i: number) => {
    const counted = ((60 * frameHz) / (stretches[i].sixteenthFrames * 4)) * scale;
    return counted >= range.slowest && counted <= halves * range.fastest;
  };
  const held = stretches.map((_, i) => i).filter((i) => ticksOf(i) >= 0.5);
  /*
   * In whole ticks, and by more than a frame: a stretch of exactly half, counted in seconds, came out
   * a hair over; and the song's end is a frame either way — Kid Niki's Chirin Dojo, two stretches of
   * 192 ticks, its last note held a frame long, was marked by its second, ♩300 for ♩200.
   */
  const frameTicks = (i: number) => 4 / stretches[i].sixteenthFrames;
  const main = held.find((i) => Math.round(ticksOf(i) - frameTicks(i)) > Math.round(all - ticksOf(i)));
  const first = held[0] ?? 0;
  return [main, first].find((i) => i !== undefined && beatable(i)) ?? main ?? first;
}
