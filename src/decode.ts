/**
 * The sound chip's output → notes. Driver-agnostic: it replays the game's
 * register writes into the APU and reads, frame by frame, what each channel
 * actually did.
 *
 * A channel sounding in a frame is one whose output was anything but silence
 * at any sample of it (a NES drum can be over within one frame). A NEW note is:
 * - a restart — its fourth register written ($4003/$4007/$400B), for the
 *   pulses and triangle;
 * - an attack — the volume jumping up by 2 or more, for the pulses and noise;
 *   how a driver that rewrites every register every frame starts its next note;
 * - a jump of a semitone or more between two frames (legato to another pitch).
 * A glide stays one note, its pitch curve kept as the bend. On the triangle a
 * jump within a note's first frames is part of its attack — a kick drum played
 * as a quick fall in pitch — and stays one note too.
 *
 * A "frame" here starts where the DRIVER updates the chip, not where the
 * console's frame does: `driverPhase`. A game updates its sound in the vblank
 * interrupt, 97% of the way through the console's frame — Alien 3 writes at
 * cycle 28 937 of 29 781 — and a window cut at the console's frame edge held
 * one update's pitch (read at its end) and the previous update's level (read
 * through it). Bar 9 of Alien 3 opened on an F#4 that never sounds: the
 * driver writes it at volume 0, a frame of silence, and the window lent it the
 * volume 2 the frame before had. An NSF player calls the driver at the start
 * of its frame, and there the two always agreed — which is how it was found.
 */

import { Apu, type ChannelBuffers } from '@xromdev/apu';
import { CPU_HZ } from './nes.ts';

export const TRACKS = ['pulse1', 'pulse2', 'triangle', 'noise'] as const;
export type Track = (typeof TRACKS)[number];

export interface TimedWrite {
  /** Seconds from the start of the recording. */
  time: number;
  address: number;
  value: number;
}

export interface DecodedNote {
  track: Track;
  /** Nearest MIDI note; `pitch` is the exact one it started at. */
  midi: number;
  pitch: number;
  start: number;
  duration: number;
  /** 0..15 at the start and at the end. */
  volume: number;
  volumeEnd: number;
  /** Pulse duty, 0..3. */
  duty: number;
  /** Noise rate, 0..15. */
  periodIndex: number;
  /** `[position 0..1, semitones from pitch]`, when the pitch moved. */
  bend?: [number, number][];
}

const RESTART = [0x4003, 0x4007, 0x400b, 0x400f];
const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);
/** The noise channel's rates on the keyboard: a row of keys at the top, fastest highest. */
export const noiseKey = (periodIndex: number) => 96 - periodIndex;
/** Frames at the start of a triangle note a pitch jump counts as its attack. */
const TRIANGLE_ATTACK_FRAMES = 3;
/**
 * Frames a falling attack may take before the note it lands on. Alien 3's kick
 * is C#4, A3, F#3 a frame each; under an F#2 it falls on one more frame, and at
 * three that last step was cut off as a note of three frames.
 */
const TRIANGLE_KICK_FRAMES = 4;

interface Open {
  midi: number;
  pitch: number;
  last: number;
  start: number;
  frames: number;
  volume: number;
  lastVolume: number;
  duty: number;
  periodIndex: number;
  bend: [number, number][];
}

/**
 * Where in its frame the driver starts writing the chip, in samples at `rate`,
 * from 0.
 *
 * The earliest place of the busiest stretch: offsets of the channel registers'
 * writes into the frame, binned, and the window that holds most of them taken
 * from the first write in it — so a whole update falls at the start of a
 * window. `$4010`–`$4013` are left out: a driver that streams samples writes
 * those all through the frame.
 */
export function driverPhase(writes: readonly TimedWrite[], perFrame: number, rate: number): number {
  const BINS = 64;
  const bins = new Array<number>(BINS).fill(0);
  const offsets: number[] = [];
  for (const w of writes) {
    if (w.address > 0x400f || w.time <= 0) continue;
    const at = (((w.time * rate) % perFrame) + perFrame) % perFrame;
    offsets.push(at);
    bins[Math.floor((at / perFrame) * BINS) % BINS]++;
  }
  if (offsets.length === 0) return 0;
  // The busiest pair of neighbouring bins, so an update split by a bin edge still counts as one.
  let best = 0;
  for (let b = 1; b < BINS; b++) if (bins[b] + bins[(b + 1) % BINS] > bins[best] + bins[(best + 1) % BINS]) best = b;
  const from = (best / BINS) * perFrame;
  const to = from + (2 / BINS) * perFrame;
  let first = Infinity;
  for (const at of offsets) {
    const a = at < from ? at + perFrame : at;
    if (a >= from && a < to && a < first) first = a;
  }
  return Math.floor(first % perFrame);
}

/**
 * How far into a window the driver's update may still be running, as a share
 * of the window: levels are read only after the last write that falls in it.
 * The update takes a few samples, and a peak read from the window's first
 * sample found the level the update was about to replace — Alien 3's silent
 * F#4 came back with volume 2.
 */
const UPDATE_SHARE = 1 / 8;

export function decode(writes: readonly TimedWrite[], seconds: number, frameHz = 60.0988): DecodedNote[] {
  const rate = 88200;
  const apu = new Apu(rate);
  const perFrame = rate / frameHz;
  const phase = driverPhase(writes, perFrame, rate);
  const size = Math.ceil(perFrame) + 2;
  const levels: ChannelBuffers = {
    pulse1: new Uint8Array(size),
    pulse2: new Uint8Array(size),
    triangle: new Uint8Array(size),
    noise: new Float64Array(size),
    dmc: new Uint8Array(size),
  };
  const notes: DecodedNote[] = [];
  const open: (Open | null)[] = [null, null, null, null];
  const prevPeak = [0, 0, 0, 0];

  const close = (ch: number, end: number) => {
    const o = open[ch];
    if (!o) return;
    open[ch] = null;
    const duration = end - o.start;
    if (duration <= 0) return;
    const note: DecodedNote = {
      track: TRACKS[ch],
      midi: o.midi,
      pitch: o.pitch,
      start: o.start,
      duration,
      volume: o.volume,
      volumeEnd: o.lastVolume,
      duty: o.duty,
      periodIndex: o.periodIndex,
    };
    if (o.bend.some(([, s]) => Math.abs(s) >= 0.1)) {
      note.bend = [...o.bend.map(([t, s]): [number, number] => [(t - o.start) / duration, s]), [1, o.bend[o.bend.length - 1][1]]];
    }
    notes.push(note);
  };

  let wi = 0;
  let done = 0;
  const end = Math.round(seconds * rate);
  // Windows from one driver update to the next; the first runs from 0 to the first update.
  for (let frame = phase > 0 ? -1 : 0; done < end; frame++) {
    const next = Math.min(end, Math.round((frame + 1) * perFrame + phase));
    const restarted = [false, false, false, false];
    let at = done;
    /** The window's first sample after the driver's update — where its levels are read from. */
    let settled = 0;
    const updateEnd = done + (next - done) * UPDATE_SHARE;
    while (at < next) {
      while (wi < writes.length && writes[wi].time * rate <= at) {
        const w = writes[wi++];
        apu.write(w.address, w.value);
        if (w.address <= 0x400f && at <= updateEnd) settled = Math.max(settled, at - done);
        const c = RESTART.indexOf(w.address);
        if (c >= 0) restarted[c] = true;
      }
      const until = wi < writes.length ? Math.min(next, Math.max(at + 1, Math.ceil(writes[wi].time * rate))) : next;
      apu.render(until - at, levels, at - done);
      at = until;
    }
    const count = next - done;
    const s = apu.snapshot();
    let p1 = 0;
    let p2 = 0;
    let nz = 0;
    let triMoved = false;
    for (let k = settled; k < count; k++) {
      if (levels.pulse1[k] > p1) p1 = levels.pulse1[k];
      if (levels.pulse2[k] > p2) p2 = levels.pulse2[k];
      if (levels.noise[k] > nz) nz = levels.noise[k];
    }
    /*
     * Sounding in the second half of the window, not merely at its start. A frame
     * the driver silences with `$4008` = $80 does not go quiet at the write: the
     * chip loads the linear counter on its next quarter-frame clock, and for up to
     * a quarter of a frame the wave runs on — a click of 4 ms, already at the next
     * note's pitch, that came out a note a frame long before every bass note of
     * Alien 3. A real note, however short, sounds through the whole window.
     */
    const triFrom = Math.max(settled, Math.floor(count / 2));
    const triLevel = levels.triangle[triFrom];
    for (let k = triFrom; k < count; k++) if (levels.triangle[k] !== triLevel) triMoved = true;
    const pulse = (i: number, peak: number): [boolean, number] => {
      const period = s.pulse[i].period;
      const on = peak > 0 && period >= 8;
      return [on, on ? midiOf(CPU_HZ / (16 * (period + 1))) : 0];
    };
    const triOn = triMoved && s.triangle.period >= 2;
    const state: [boolean, number][] = [
      pulse(0, p1),
      pulse(1, p2),
      [triOn, triOn ? midiOf(CPU_HZ / (32 * (s.triangle.period + 1))) : 0],
      [nz > 0, noiseKey(s.noise.periodIndex)],
    ];
    const peaks = [p1, p2, 15, nz];
    const time = done / rate;

    for (let ch = 0; ch < 4; ch++) {
      const [on, pitch] = state[ch];
      const o = open[ch];
      const attack = ch !== 2 && peaks[ch] - prevPeak[ch] >= 2;
      prevPeak[ch] = peaks[ch];
      if (!on) {
        close(ch, time);
        continue;
      }
      let jumped = o !== null && ch !== 3 && Math.abs(pitch - o.last) >= 0.9;
      if (jumped && ch === 2 && o!.frames < TRIANGLE_ATTACK_FRAMES) jumped = false;
      // The noise channel's restart register is often rewritten every frame;
      // a new hit there is an attack.
      const restart = ch === 3 ? attack : restarted[ch] || attack;
      /*
       * A triangle kick: the pitch falling over a note's first frames, struck
       * again on the way or not, is the attack of the note it falls ONTO — the
       * bass is that note, the fall is how it is hit. Alien 3 strikes every bass
       * note C#4, A3, then F#3 a frame each, restarting on the F#3; read as a
       * note of its own the C#4 came out a separate head with a slide of four
       * semitones drawn down from it.
       */
      if (ch === 2 && o && o.frames < TRIANGLE_KICK_FRAMES && pitch < o.last - 0.5) {
        // The note is the pitch the fall lands on; the fall stays in its curve,
        // so it is still heard — measured from the new pitch, it ends at 0 and no
        // score draws it.
        const shift = o.pitch - pitch;
        o.bend = o.bend.map(([t, semis]): [number, number] => [t, semis + shift]);
        o.bend.push([time, 0]);
        o.midi = Math.round(pitch);
        o.pitch = pitch;
        o.last = pitch;
        o.frames++;
        continue;
      }
      if (o && !restart && !jumped) {
        if (ch !== 3) o.bend.push([time, pitch - o.pitch]);
        o.last = pitch;
        o.frames++;
        o.lastVolume = Math.round(ch === 2 ? 12 : peaks[ch]);
        continue;
      }
      close(ch, time);
      const volume = Math.round(ch === 2 ? 12 : peaks[ch]);
      open[ch] = {
        midi: Math.round(pitch),
        pitch,
        last: pitch,
        start: time,
        frames: 1,
        volume,
        lastVolume: volume,
        duty: ch < 2 ? s.pulse[ch].duty : 0,
        periodIndex: s.noise.periodIndex,
        bend: [[time, 0]],
      };
    }
    done = next;
  }
  for (let ch = 0; ch < 4; ch++) close(ch, done / rate);
  return strikesOntoNotes(notes, frameHz).filter((n) => n.midi >= 21 && n.midi <= 108);
}

/** The longest a triangle note can be and still be the strike of the note after it, in frames. */
const TRIANGLE_STRIKE_FRAMES = 3.5;

/**
 * A triangle note of a few frames running straight into a longer one is how
 * that longer note is struck — a drum made of pitch — and is written as part of
 * it: the note starts where the strike did, at the note's own pitch.
 *
 * Alien 3 strikes its bass three ways: falling C#4, A3, F#3 or F#3, D3, A#2 a
 * frame each, or one frame of C1 under it. The falls that land lower are
 * already one note (see the kick in `decode`); this takes the rest — a fall
 * followed by a HIGHER note, and the frame of C1 — which came out two hundred
 * notes of a frame or three on the bass staff.
 */
function strikesOntoNotes(notes: DecodedNote[], frameHz: number): DecodedNote[] {
  const tri = notes.filter((n) => n.track === 'triangle').sort((a, b) => a.start - b.start);
  const gone = new Set<DecodedNote>();
  const out = new Map<DecodedNote, DecodedNote>();
  for (let i = 0; i + 1 < tri.length; i++) {
    const strike = tri[i], note = tri[i + 1];
    if (gone.has(strike)) continue;
    const frames = strike.duration * frameHz;
    const gap = (note.start - strike.start - strike.duration) * frameHz;
    if (frames > TRIANGLE_STRIKE_FRAMES || Math.abs(gap) > 0.5 || note.duration <= strike.duration) continue;
    gone.add(strike);
    const merged: DecodedNote = { ...note, start: strike.start, duration: note.start + note.duration - strike.start };
    // The strike stays in the sound as the start of the note's curve: its pitch,
    // measured from the note's, for its frames; then the note's own curve, if any.
    const struck = strike.duration / merged.duration;
    const from = strike.pitch - note.pitch;
    const head: [number, number][] = strike.bend
      ? strike.bend.slice(0, -1).map(([p, semis]): [number, number] => [p * struck, semis + from])
      : [[0, from]];
    const tail: [number, number][] = note.bend
      ? note.bend.map(([p, semis]): [number, number] => [struck + p * (1 - struck), semis])
      : [[struck, 0], [1, 0]];
    merged.bend = [...head, ...tail];
    out.set(note, merged);
    tri[i + 1] = merged;
  }
  return notes.filter((n) => !gone.has(n)).map((n) => out.get(n) ?? n);
}
