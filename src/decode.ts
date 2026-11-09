/**
 * The sound chip's output → notes. Driver-agnostic: it replays the game's
 * register writes into the APU and reads, frame by frame, what each channel
 * actually did.
 *
 * A channel sounding in a frame is one whose output was anything but silence
 * at any sample of it (a NES drum can be over within one frame). A NEW note is:
 * - a restart — its fourth register written ($4003/$4007/$400B/$400F) on a channel whose driver
 *   writes it to strike (`keyingOf`): with the value it already held, or with an attack;
 * - an attack — the volume jumping up by 2 or more, for the pulses and noise of a driver that
 *   does not key its notes by that register; how a driver that rewrites every register every
 *   frame starts its next note — but not while the note is still climbing from its start
 *   (`inAttack`), nor where the chip's looping envelope climbs by itself, nor at the distance
 *   after every strike at which the channel's instrument re-attacks (`reattacks`);
 * - a jump of a semitone or more between two frames (legato to another pitch) —
 *   unless the pulse's sweep unit is carrying it that way (`sweeping`).
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

import { Apu, expansionOf, fdsHz, n163Hz, vrc6PulseHz, vrc6SawHz, type ChannelBuffers } from '@xromdev/apu';
import { CPU_HZ } from './nes.ts';

export const TRACKS = ['pulse1', 'pulse2', 'triangle', 'noise'] as const;
/**
 * A voice: the 2A03's four, or an expansion chip's — the Disk System's wave channel (`fds`) and
 * the N163's channels, numbered in the order the chip switches them on (`n163_1` is its slot 7), and
 * the VRC6's two pulses and sawtooth.
 */
export type Track = (typeof TRACKS)[number] | 'fds' | `n163_${number}` | 'vrc6_1' | 'vrc6_2' | 'vrc6_saw';

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
  /**
   * `[seconds into the note, level 0..15]` at each change of level, when the level does not go in
   * a straight line from `volume` to `volumeEnd`. Capcom strikes a note at 8 and drops it to 5 the
   * next frame, then lets it fall slowly: a line from 8 to its last level is far too loud in the
   * middle, and Darkwing Duck sounded flat for it.
   */
  levels?: [number, number][];
  /** On an expansion voice: the waveform it started with (FDS 64 samples 0..63, N163 0..15). */
  wave?: number[];
}

const RESTART = [0x4003, 0x4007, 0x400b, 0x400f];
/** The part of a restart register a vibrato changes: the period's high bits (the noise's whole byte). */
const restartKey = (ch: number, value: number) => (ch === 3 ? value : value & 7);

/**
 * How a channel's driver uses its restart register, read off the writes of the whole recording:
 * - `keyon` — written when a note is struck, even with the value it already holds: a write is the
 *   strike, and a level rising without one is the note's envelope or tremolo, not a new note;
 * - `every` — written on (almost) every frame: a write says nothing;
 * - `change` — written only when the period's high bits change: a write is a vibrato or a new
 *   pitch crossing a 256-step boundary, never a strike by itself.
 *
 * Read as strikes, those writes and rises cut held notes up all through the second hundred games:
 * Nekketsu Soccer's A4 crosses period $100 on its vibrato and came out a note per crossing; Kai no
 * Bouken's attack climbs 3, 7, 11, 15 a frame each and Staff Roll came out 469 notes where the
 * driver strikes 197; Pizza Pop's triangle rewrites `$400B` every frame and its vibrato came out in
 * pieces of one to three frames.
 */
export type Keying = 'keyon' | 'every' | 'change';

/**
 * Whether a channel's driver writes its restart register whenever it changes the period — on 80% of
 * the windows its period moved in, eight at least — so that a write tells a vibrato step or a glide
 * as much as a strike (see `stepping` in `decode`). The noise has no period to step.
 */
export function rewritesOnStep(writes: readonly TimedWrite[], perFrame: number, rate: number, phase: number): boolean[] {
  return [0, 1, 2].map((ch) => {
    const lo = 0x4002 + 4 * ch;
    const hi = lo + 1;
    let period = -1;
    let window = NaN;
    let moved = false;
    let written = false;
    let windows = 0;
    let withWrite = 0;
    const flush = () => {
      if (moved) {
        windows++;
        if (written) withWrite++;
      }
      moved = written = false;
    };
    for (const w of writes) {
      if (w.address !== lo && w.address !== hi) continue;
      const at = Math.floor((w.time * rate - phase) / perFrame);
      if (at !== window) flush();
      window = at;
      const next = w.address === lo ? (period & 0x700) | w.value : (period & 0xff) | ((w.value & 7) << 8);
      if (period >= 0 && next !== period) moved = true;
      period = next;
      if (w.address === hi) written = true;
    }
    flush();
    return windows >= 8 && withWrite >= windows * 0.8;
  }).concat([false]);
}

/**
 * What the driver writes in each window, read ahead of the decoding: a window's choice can hang on the
 * next one (a slide's first step is a slide only if the next step repeats it). Per window, from the
 * first (index 0 is the window before frame 0): the period each of the pulses and the triangle holds
 * at its end, whether each channel's restart register was written in it, and the value its first
 * register was last written with in it (-1 when it was not).
 * A write falls in the window the decoder applies it in: the one holding the sample after it.
 */
export interface WritePlan {
  period: Int32Array[];
  restart: Uint8Array[];
  control: Int16Array[];
}
export function writePlan(writes: readonly TimedWrite[], perFrame: number, rate: number, phase: number, windows: number): WritePlan {
  const n = windows + 2;
  const plan: WritePlan = {
    period: [0, 1, 2].map(() => new Int32Array(n)),
    restart: [0, 1, 2, 3].map(() => new Uint8Array(n)),
    control: [0, 1, 2, 3].map(() => new Int16Array(n).fill(-1)),
  };
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  let at = 0;
  const startOf = (k: number) => Math.round(k * perFrame + phase);
  const fill = (upTo: number) => {
    // Each window up to `upTo` holds the periods as they stand.
    for (; at <= upTo && at < n; at++) for (let ch = 0; ch < 3; ch++) plan.period[ch][at] = (hi[ch] << 8) | lo[ch];
  };
  for (const w of writes) {
    if (w.address < 0x4000 || w.address > 0x400f) continue;
    const s = Math.ceil(w.time * rate);
    let k = Math.floor((s - phase) / perFrame);
    if (s >= startOf(k + 1)) k++;
    else if (s < startOf(k)) k--;
    const index = Math.min(n - 1, Math.max(0, k + 1));
    fill(index - 1);
    const ch = (w.address - 0x4000) >> 2;
    const r = w.address & 3;
    if (ch < 3 && r === 2) lo[ch] = w.value;
    if (ch < 3 && r === 3) hi[ch] = w.value & 7;
    if (r === 3) plan.restart[ch][index] = 1;
    if (r === 0) plan.control[ch][index] = w.value;
  }
  fill(n - 1);
  return plan;
}

export function keyingOf(writes: readonly TimedWrite[], perFrame: number, rate: number, phase: number): Keying[] {
  return RESTART.map((address, ch) => {
    let windows = 0;
    let consecutive = 0;
    let repeated = 0;
    let lastWindow = NaN;
    let lastKey = -1;
    for (const w of writes) {
      if (w.address !== address) continue;
      const window = Math.floor((w.time * rate - phase) / perFrame);
      const key = restartKey(ch, w.value);
      if (window !== lastWindow) {
        windows++;
        if (window === lastWindow + 1) consecutive++;
        if (key === lastKey) repeated++;
      }
      lastWindow = window;
      lastKey = key;
    }
    if (windows >= 8 && consecutive >= windows / 2) return 'every';
    return repeated >= 2 ? 'keyon' : 'change';
  });
}

/**
 * On a `keyon` channel, a rise of the level without a write still strikes a note when it is this
 * big and the note is past its attack: an echo voice re-struck by its level alone. Envelopes and
 * tremolos rise by 2 to 4.
 */
const KEYON_RISE = 6;
/** The loudest a frame of echo at the end of a note goes, and the most frames it lasts (`Open.echo`). */
const ECHO_LEVEL = 2;
const ECHO_FRAMES = 2;
/**
 * How many notes back an echo may play: Gun Sight's echo voice lags one note or two, by its tempo,
 * Jetman's four — in its arpeggios of four the echo has the pitch of the note it comes before.
 */
const ECHO_DELAY_NOTES = 4;
/**
 * A note whose level has only fallen since its attack and jumps back to the attack's level in one
 * frame is struck again, written or not: Ultimate Basketball's Ending re-strikes its repeated E3s on
 * pulse 2 by the envelope alone — 15, 14, 13, 12, then 15 — with no write of `$4007`. A tremolo
 * rises and falls within the note; it never climbs straight back from a decay that never rose.
 * The decay has to last `RESTRIKE_DECAY_FRAMES` too: Kamen Rider Club's Area 2 loops 6, 4, 2 every
 * three frames inside each written note — a 20 Hz flutter of the instrument, heard as one note.
 */
const RESTRIKE_DECAY_FRAMES = 4;
/**
 * Frames a note's attack may hold one level on its way up, once it has started to climb. Instruments
 * climb 3, 7, 11, 15 a frame each (Kai no Bouken, Tombs & Treasure), 1, 3, 5 (The Empire Strikes
 * Back), or 1, 1, 2, 2, … 6, 6 and then 12 (The Battle of Olympus), with no write of the restart
 * register: read as strikes, the steps came out a note a frame each.
 */
const ATTACK_STEP_FRAMES = 2;
/**
 * Whether a note is still in its attack: its level has only risen or held since it started, and it
 * rose on the frame before (or the note started there) — or, once it has climbed, within
 * `ATTACK_STEP_FRAMES`. A level held flat from the start and then jumping up is a note struck again:
 * Contra Force's echo holds 2 for two frames on the pitch the next note is struck at 8; Ninja Gaiden
 * III's release tail holds 3 for three frames before the next note's 6.
 */
const inAttack = (o: Open) => o.climbing && (o.sinceRise === 0 || (o.rose && o.sinceRise < ATTACK_STEP_FRAMES));
/** A note's level for one more frame: where its attack stands (`inAttack`). */
function follow(o: Open, level: number, pitch?: number) {
  if (level < o.lastVolume) o.climbing = false;
  if (level > o.lastVolume) o.rose = true;
  o.sinceRise = level > o.lastVolume ? 0 : o.sinceRise + 1;
  if (pitch !== undefined && o.climbing && o.frames <= SCOOP_FRAMES && level > (o.top?.level ?? o.volume)) o.top = { level, pitch, frame: o.frames };
}
/**
 * How far the top of an attack may sit from the pitch the note came in at and keep its name, and the
 * frames a scoop takes to get there (`named`).
 */
const SCOOP_SEMITONES = 0.4;
const SCOOP_FRAMES = 3;
/**
 * What a tonal note that climbed into its body is called: the pitch it held at the top of its attack,
 * when the climb came in from another — as the notes were when every step of the climb was cut off
 * as one of its own. Radia Senki, Cattou Ninden Teyandee, Wai Wai World 2 and The Lone Ranger scoop
 * into a note from a frame or two half a semitone or more under it, Castlevania III's saw from a
 * frame of C#3 at 3 into C3 at 14, and the notes came out named after the scoop. The scoop stays in
 * the bend. (The note's `volume` stays its first frame's: the climb is in its levels.)
 */
function named(o: Open, slides = true, held = true): { midi: number; pitch: number; shift: number } {
  const same = { midi: o.midi, pitch: o.pitch, shift: 0 };
  const top = o.top;
  // Not a top the note was cut off before (`dipFrom`).
  if (!top || top.frame > o.levels.length || Math.abs(top.pitch - o.pitch) < SCOOP_SEMITONES) return held ? heldName(o, slides) : same;
  // Only where the note stays: the pitch it holds most of the time is the top's. Ice Climber sweeps
  // its sound effects down as they swell, and they are where they began.
  const median = o.bend.map(([, semis]) => semis).sort((a, b) => a - b)[o.bend.length >> 1];
  if (Math.abs(median - (top.pitch - o.pitch)) >= SCOOP_SEMITONES) return held ? heldName(o, slides) : same;
  return { midi: Math.round(top.pitch), pitch: top.pitch, shift: o.pitch - top.pitch };
}
/**
 * Frames a note may take to come onto the pitch it then holds and still be named by that pitch
 * (`heldName`), and how close to it the frames of its body stay.
 */
const APPROACH_FRAMES = 4;
const HOLD_SEMITONES = 0.5;
/**
 * A note that comes in off its pitch and holds another — whatever its level does — is named by the
 * pitch it holds, when the name differs: the frames before are its approach, kept in the bend (rule
 * 24). Jajamaru Ninpou Chou starts its pulse notes up to three quarters of a semitone sharp and slides
 * them onto the note in two to four frames, and pulse 2 read D#5 F5 G#5 against pulse 1's D5 E5 G5;
 * Bad News Baseball's triangle sounds one frame of the old pitch before each note (an early `$4008`
 * reload) and read E2 for a B2. A note that never settles — a fall, a sweep, a wide vibrato — keeps
 * its first frame's name, and so does one that falls whole tones before it settles: Astyanax writes
 * D4 and lets the sound fall to B3, 1999's sweep instruments drop a whole tone a frame. On the
 * triangle (`slides` false) only a one-frame approach: Jajamaru's toms fall 0.7 and then 0.9 of a
 * semitone over six frames from the pitch they are struck at, a drum's fall, not a slide onto a note.
 */
function heldName(o: Open, slides: boolean): { midi: number; pitch: number; shift: number } {
  const same = { midi: o.midi, pitch: o.pitch, shift: 0 };
  // Not a swept pulse: its pitch is read where the sweep has moved it by the window's end, and the note
  // is the period the driver wrote (Akuma-kun's Final Battle rewrites `$4002` every frame under a
  // sweep of `$8E`, and every note read a semitone above its write).
  if (o.swept) return same;
  const semis = o.bend.map(([, s]) => s);
  const n = semis.length;
  if (n < 3) return same;
  const body = semis.slice(Math.min(APPROACH_FRAMES, n >> 1));
  const held = [...body].sort((a, b) => a - b)[body.length >> 1];
  if (Math.abs(held) < SCOOP_SEMITONES || Math.round(o.pitch + held) === o.midi) return same;
  if (body.filter((s) => Math.abs(s - held) < HOLD_SEMITONES).length < (body.length * 2) / 3) return same;
  // The approach: the frames before the note first comes onto the pitch it holds.
  let k = 0;
  while (k < n && Math.abs(semis[k] - held) >= HOLD_SEMITONES / 2) k++;
  if (k === 0 || k > APPROACH_FRAMES || k * 2 > n) return same;
  // An approach of more than one frame comes from under a semitone away (a detuned start sliding onto
  // the note, under the 0.9 of a jump), or onto the period the driver wrote for the note in the silence
  // before it (Star Tropics 2 writes F4 at level 0 and scoops onto it from D#4 in two frames); a fall
  // of whole tones before the note settles (Astyanax, 1999) is its written pitch's.
  const written = o.mark !== undefined && Math.abs(midiOf(CPU_HZ / (16 * (o.mark.period + 1))) - (o.pitch + held)) < HOLD_SEMITONES;
  if (k > 1 && !written && (!slides || Math.abs(semis[0] - held) >= 0.9)) return same;
  return { midi: Math.round(o.pitch + held), pitch: o.pitch + held, shift: -held };
}
/**
 * Its level has only fallen since its attack — or since its instrument re-attacked (`reattacks`):
 * Shancara's SNS News re-strikes F#6 by its level every six frames, 8 8 7 6 5 4 each time, and once
 * the first of them was taken for the instrument re-attacking the note held all the others too.
 */
/**
 * Where a note's decay is measured from: where its instrument re-attacked it, or its first frame —
 * its second, when the first holds a lower level the note before left (Batman writes its notes at 3
 * and plays them at 9 9 9 8 7 the frame after).
 */
const decayFrom = (o: Open) => o.reattacked ?? (o.levels.length > 1 && o.levels[1][1] > o.levels[0][1] ? 1 : 0);
function decayedOnly(o: Open): boolean {
  const from = decayFrom(o);
  if (o.levels.length - from < RESTRIKE_DECAY_FRAMES) return false;
  let steps = 0;
  for (let i = from + 1; i < o.levels.length; i++) {
    if (o.levels[i][1] > o.levels[i - 1][1]) return false;
    if (o.levels[i][1] < o.levels[i - 1][1]) steps++;
  }
  // Two steps down at least: a square tremolo dips once and comes back, which is not a decay.
  return steps >= 2;
}
/**
 * Frames a `keyon` pulse may fall silent inside a note and come back at its pitch with no write, and
 * still be that note. Dragon's Lair drops the Lizard King's notes to 0 for one frame, and later six,
 * and back to 5 and 2; Ikari Warriors III's envelope goes 10 10 10 10 10 0 0 0 5 5 — an echo inside
 * the note, which their drivers' own logs strike once. A note that stays silent longer ends where it
 * fell.
 */
const DIP_FRAMES = 8;
/**
 * A note back from a dip to 0 (`DIP_FRAMES`) that is struck again, not resumed: a note that had faded
 * out (to 1 or less) and comes back 2 or more above where it faded — Super Mario Bros. 3's Music Box
 * falls 7 … 1 1 0 and strikes the same C4 again at 5; one back with another duty — Bee 52's Choose
 * a Door; or one the driver set the pitch of again (`pitched`: `$4002` written, as it was not the
 * frame before) — Kage's Stage Clear rewrites `$4006` with the value it held for each repeat. Back at
 * the level it was struck at or louder, it MAY be struck again (`maybe`, see `Comeback`). The echoes
 * the dip is for come back lower than the note's strike, from a level cut off on the way down, with
 * no write but the level: Ikari Warriors III 10 … 0 0 0 5, Dragon's Lair 6 0 5 and 3 … 0 2, Mega Man 3
 * 10 4 0 0 2 (whose driver writes `$4002` every frame).
 */
function struckAgain(o: Open, level: number, duty: number, pitched: boolean): boolean | 'maybe' {
  const before = o.levels.filter(([t, l]) => t < o.dipFrom! && l > 0);
  // A note silent from its second frame for a frame or two was not heard yet: After Burner II writes
  // each note on the last frame of the one before, at its level of 1, and sounds it two frames later
  // at 5, 15, 9. Silent longer, its one frame was an echo: Panic Restaurant's 1, seven frames of 0,
  // then the note at 3 3 3 3 2 1.
  if (before.length < 2) return (o.dipFrames ?? 0) > SOUNDING_GAP_FRAMES && level >= o.volume;
  if (duty !== o.duty || pitched) return true;
  const faded = before[before.length - 1][1];
  if (faded <= 1 && level >= faded + 2) return true;
  return level >= o.volume ? 'maybe' : false;
}
/**
 * A comeback from a dip at the level the note was struck at is the note struck again when its next
 * frames go the way the note's own opening went, within `COMEBACK_SLACK`: Dokuganryu Masamune, Batsu
 * & Terii, Getsufuu Maden, Ultimate Basketball and Rolling Thunder repeat a pitch by restarting its
 * envelope through `$4000` alone — 14 15 13 8 3 0, then 14 15 13 … again — and every repeat had been
 * held in the note before. An envelope that swells back by itself goes its own way: Final Fantasy's
 * 8 7 5 4 2 0 comes back 8 8 8 and holds, one note in its driver's reads.
 */
const COMEBACK_FRAMES = 3;
/** The frames of silence a note's envelope may open with after its first frame (`struckAgain`). */
const SOUNDING_GAP_FRAMES = 2;
const COMEBACK_SLACK = 2;
interface Comeback {
  /** Where the note came back, and the frame (`struckAt`). */
  time: number;
  frame: number;
  pitch: number;
  /** Its index in `levels`, and where the note had fallen silent. */
  index: number;
  dipFrom: number;
  /** The levels the note opened with, from the one it comes back at. */
  opening: number[];
}
function comebackOf(o: Open, time: number, frame: number, pitch: number, level: number): Comeback {
  const heard = o.levels.filter(([t, l]) => t < o.dipFrom! && l > 0).map(([, l]) => l);
  const from = heard.slice(0, 2).indexOf(level);
  return { time, frame, pitch, index: o.levels.length, dipFrom: o.dipFrom!, opening: heard.slice(Math.max(0, from), Math.max(0, from) + COMEBACK_FRAMES) };
}
/** After one more frame of a comeback: `true` once it has gone the note's way long enough, `false` once it has not. */
function comebackGoes(o: Open): boolean | undefined {
  const c = o.comeback!;
  const k = o.levels.length - 1 - c.index;
  if (Math.abs(o.levels[o.levels.length - 1][1] - (c.opening[k] ?? 0)) > COMEBACK_SLACK) return false;
  return k + 1 >= Math.min(COMEBACK_FRAMES, c.opening.length) ? comebackTops(o) : undefined;
}
/**
 * And it climbs to where the opening climbed: Batman's notes, written at the
 * level of 1 the note before had left and played at 3 2 1, come back from a dip at 1 and stay there.
 */
function comebackTops(o: Open): boolean {
  const c = o.comeback!;
  return Math.max(...o.levels.slice(c.index).map(([, level]) => level)) >= Math.max(...c.opening);
}
/**
 * Frames a note may open after its restart write, or its new period (`repitched`), while it is still
 * silent, and start there. Two were too few for slow attacks: The Battle of Olympus fades its notes
 * in from 0, and its driver's strike log puts 70 of them more than two frames before the first sound.
 * Longer, a silent channel's period moving on (Love Quest slides one a period at a time, then strikes
 * it fifteen frames later) would start the note long before its strike.
 */
const SILENT_START_FRAMES = 8;
/**
 * How far a period set in silence has to move to mark a new strike (`silentStart`): a vibrato or a
 * detune stepping through the silent frames before a note — Twinbee swings `$4006` by two either way
 * all through its rests, Dr. Mario detunes a note it has just written — moves it far less.
 */
const MARK_STEP = 0.5;
/**
 * Frames such a small step may come before the note and still be its strike: Family Block re-sets
 * a repeated note's period a step off the one before as it cuts the note, and sounds it the frame
 * after; Twinbee's vibrato steps as the note before fades out, eight frames before the next.
 */
const SMALL_MARK_FRAMES = 2;
const semitones = (period: number, from: number) => Math.abs(12 * Math.log2((period + 1) / (from + 1)));
/** Frames after a write of `$400F` within which another, on a falling level, steps the same hit (`noiseHit`). */
const NOISE_STEP_FRAMES = 2;
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
/**
 * A driver's slide adds the same number to the period every frame. Where that is a semitone or more
 * a frame, every frame of it jumped and was cut off as a note: Dance Aerobics falls from B5 by 8 a
 * frame — B5 A#5 A5 G#5 G5 a frame each, then F#5 carrying the slower rest as a bend. A step that
 * the window before or the window after repeats (in its sign, and within an eighth of its size), in a
 * run of `SLIDE_STEPS` such steps at least, is the slide going on, the same note (rule 24). A trill's
 * steps turn back, an arpeggio's differ or turn back after two.
 */
const SLIDE_STEP_SHARE = 1 / 8;
/**
 * Steps a run needs to be a slide. A frame arpeggio's two steps up a triad can be as alike: Jungle
 * Book's G#3 B3 D#4 a frame each (periods 539 452 358) came out one G#3 bent up, its notes gone.
 */
const SLIDE_STEPS = 3;
/**
 * A slide that lands on a pitch and holds it there (two frames at least) is left in its pieces: it is
 * the tail of the note it leaves or the attack of the note it reaches, by where its far end falls on
 * the grid (rule 24) — the post-fix's to say. How far a run is followed to its end, in frames.
 */
const SLIDE_RUN_FRAMES = 64;
/**
 * At the top of the range one step of the period is a semitone or more (period 17, G8: 0.94 of one),
 * and a vibrato there jumped on every step: Akuma-kun's G8 and B8 twinkles came out 1-2-frame notes
 * a semitone apart, though the driver writes only `$4006` for its vibrato. A step of `VIBRATO_PERIODS`
 * or less that keeps within as much of the note's own period, and comes back to it within
 * `VIBRATO_RETURN_FRAMES` with no restart written on the way, is the vibrato. A run that moves on
 * (Bram Stoker's Dracula's high triangle steps) stays notes.
 */
const VIBRATO_PERIODS = 2;
const VIBRATO_RETURN_FRAMES = 8;
/**
 * A note's start at a restart written in silence is moved to its sound when the period written there
 * was no pitch of the note: a placeholder, its low byte 0 — the restart written before the note's own
 * low byte — that the note never comes within this much of. Bill Elliott's NASCAR
 * Challenge writes `$4003` with the low byte 0 at volume 0 a frame before each note sounds, and its
 * real period with the sound: a note started on the write where the high byte was not 0 (period
 * `$200`) and on the sound where it was (period 0, no note), and the pulses sat a frame off the
 * triangle in one song. Alien 3 writes its note at level 0 and slides on from it, half a semitone to a
 * semitone at the first sound, Star Tropics 2 scoops onto the period it wrote: a real period, and both
 * stay struck at the write — a distance alone does not tell the two apart.
 */
const MARK_HELD = 0.5;

interface Open {
  midi: number;
  pitch: number;
  last: number;
  start: number;
  frames: number;
  /** Frames at the current pitch. */
  held: number;
  volume: number;
  lastVolume: number;
  duty: number;
  periodIndex: number;
  bend: [number, number][];
  /** `[time, level]` for every frame of the note. */
  levels: [number, number][];
  /** The level has only risen or held since the note started (see `inAttack`). */
  climbing: boolean;
  /** It has risen at least once. */
  rose: boolean;
  /** The top of its attack, when it climbed to it: the level, and the pitch it held there (`named`). */
  top?: { level: number; pitch: number; frame: number };
  /** Frames since the level last rose (or since the note started). */
  sinceRise: number;
  /**
   * Where a rise on the note's second frame was taken as its attack: if the level falls right after
   * it, the first frame was the note before's tail and the note starts here (`inAttack`).
   */
  climbedAt?: { time: number; pitch: number; volume: number; duty: number; periodIndex: number };
  /**
   * The note's first frame was struck: a keyed write of the restart register, a silence before it,
   * or its level rising into it.
   */
  struck?: boolean;
  /** Where the note's level dropped to 0 with no strike, while it may still come back (`DIP_FRAMES`). */
  dipFrom?: number;
  dipFrames?: number;
  /** A comeback from a dip that may be the note struck again (`Comeback`). */
  comeback?: Comeback;
  /** The index in `levels` where its instrument re-attacked it (`reattacks`). */
  reattacked?: number;
  /**
   * It came in at the pitch of one of the notes before it (`ECHO_DELAY_NOTES`), at a level of
   * `ECHO_LEVEL` or less, with no strike written: the echo of that note, which Konami's drivers (Gun
   * Sight, Contra Force, Bucky O'Hare, TMNT III, Yume Penguin Monogatari) and Jaleco's (Toukon Club,
   * Jetman) play on a note's last frame or two. When the next note has the echo's pitch, the driver
   * writes its `$4002` and its level the frame after, and the jump was read as that note's attack:
   * it started a frame early, off its beat.
   */
  echo?: boolean;
  /** It came in out of silence (no note was open on the channel the frame before). */
  fromSilence?: boolean;
  /** A pulse opened under a sweep that moves it (`sweepDirection`): named by the period written (`heldName`). */
  swept?: boolean;
  /**
   * It starts at a restart written while the channel was silent (`silentStart`): the period written
   * there and the frame the note was first heard (`MARK_HELD`).
   */
  mark?: { period: number; sound: number };
}

/**
 * Where in its frame the driver starts writing the chip, in samples at `rate`,
 * from 0.
 *
 * The earliest place of the busiest stretch: offsets of the channel registers'
 * writes into the frame, binned, and the run of busy bins around the window that
 * holds most of them taken from the first write in it — so a whole update falls
 * at the start of a window. `$4010`–`$4013` are left out: a driver that streams samples writes
 * those all through the frame.
 */
/**
 * A write that is part of the driver's per-frame update: the 2A03's channel registers and an
 * expansion chip's (FDS `$4040`–`$408A`, the N163's ports). With the 2A03's alone, Mappy Kids'
 * update — pulses first, then a long run of N163 writes — was cut by a window edge inside the
 * N163 part, and half its voices changed pitch a frame early, with one-frame splinters.
 */
const updatesSound = (address: number) =>
  address <= 0x400f ||
  (address >= 0x4040 && address <= 0x408a) ||
  (address >= 0x4800 && address <= 0x4fff) ||
  (address >= 0x9000 && address <= 0xb002 && (address & 0xfff) <= 3) ||
  address >= 0xf800;

/**
 * A waveform that holds its shape more than once: how many times, and the shape stretched to the
 * same length once. A chip plays the stored samples at its frequency, so a wave of two periods
 * sounds an octave above what the frequency and length say — Mappy Kids' bass is `0000ffff0000ffff`
 * in 16 samples, and read as one period it fell an octave, below A0, and was dropped.
 */
export function wavePeriods(wave: readonly number[]): { times: number; wave: number[] } {
  const n = wave.length;
  // A flat wave is silence, not a shape repeated n times.
  if (wave.every((v) => v === wave[0])) return { times: 1, wave: [...wave] };
  for (let p = 2; p <= n / 2; p++) {
    if (n % p !== 0) continue;
    let same = true;
    for (let i = p; i < n && same; i++) same = wave[i] === wave[i % p];
    if (same) return { times: n / p, wave: Array.from({ length: n }, (_, i) => wave[Math.floor(i / (n / p))]) };
  }
  const times = nearPeriods(wave);
  if (times > 1) {
    // The periods averaged into one, stretched over the length.
    const p = n / times;
    const one = Array.from({ length: p }, (_, i) => {
      let sum = 0;
      for (let c = 0; c < times; c++) sum += wave[c * p + i];
      return Math.round(sum / times);
    });
    return { times, wave: Array.from({ length: n }, (_, i) => one[Math.floor(i / times)]) };
  }
  return { times: 1, wave: [...wave] };
}

/**
 * How many times a wave NEARLY repeats, by its spectrum: the harmonics within 20 dB of the
 * strongest share a divisor g (a power of two), and every harmonic off its multiples is 26 dB
 * under. Ai Senshi Nicol's FDS waves hold two or four periods that differ by a sample or two;
 * read as one period they came out two octaves under what is heard. (The rule is the one its
 * review settled on by ear.)
 */
function nearPeriods(wave: readonly number[]): number {
  const n = wave.length;
  const mean = wave.reduce((a, b) => a + b, 0) / n;
  const amp: number[] = [];
  for (let h = 1; h <= n / 2; h++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * h * i) / n;
      re += (wave[i] - mean) * Math.cos(a);
      im -= (wave[i] - mean) * Math.sin(a);
    }
    amp.push(Math.hypot(re, im));
  }
  const top = Math.max(...amp);
  if (top === 0) return 1;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  let g = 0;
  amp.forEach((a, k) => {
    if (a >= 0.1 * top) g = gcd(g, k + 1);
  });
  if (g < 2 || g & (g - 1) || n % g) return 1;
  return amp.every((a, k) => (k + 1) % g === 0 || a < 0.05 * top) ? g : 1;
}

export function driverPhase(writes: readonly TimedWrite[], perFrame: number, rate: number): number {
  const BINS = 64;
  const bins = new Array<number>(BINS).fill(0);
  const offsets: number[] = [];
  for (const w of writes) {
    if (!updatesSound(w.address) || w.time <= 0) continue;
    const at = (((w.time * rate) % perFrame) + perFrame) % perFrame;
    offsets.push(at);
    bins[Math.floor((at / perFrame) * BINS) % BINS]++;
  }
  if (offsets.length === 0) return 0;
  // The busiest pair of neighbouring bins, so an update split by a bin edge still counts as one.
  let best = 0;
  for (let b = 1; b < BINS; b++) if (bins[b] + bins[(b + 1) % BINS] > bins[best] + bins[(best + 1) % BINS]) best = b;
  /*
   * Back from there to where the update begins: while the bin before is busy too. Capcom's driver
   * spends a twentieth of a frame on an update — pulse 1, then pulse 2, then the triangle — and the
   * busiest pair was its middle, so pulse 1's writes fell into the window before: Darkwing Duck,
   * song 2, came out with pulse 2 and the triangle a frame behind pulse 1, and a one-frame note on
   * every pitch change, where the new period landed a window ahead of its level.
   */
  const busy = Math.max(1, Math.max(...bins) * 0.02);
  let start = best;
  for (let step = 0; step < BINS / 2 && bins[(start - 1 + BINS) % BINS] >= busy; step++) {
    start = (start - 1 + BINS) % BINS;
  }
  const from = (start / BINS) * perFrame;
  const to = from + (((best - start + BINS) % BINS) + 2) / BINS * perFrame;
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

/**
 * Which way the pulse's hardware sweep moves its pitch, from its `$4001`/`$4005` byte: −1 down,
 * +1 up, 0 when it does not move it (off, or a shift of 0).
 *
 * The chip moves the period by itself, with no write: Super Mario Bros. writes `$94` to `$4001`
 * every frame — enabled, divider 1, shift 4 — and each note of pulse 1 falls about a semitone a
 * frame until it is gone. Read frame by frame, every frame of that fall jumped a semitone and was
 * cut off as a note of its own: "You Have Died" came out A4 G4 G#4 A4 F#4 where the game plays
 * A#4, B4, C5, each falling, and the synth played the fall as a staircase.
 *
 * Not a sweep too slow to carry a note anywhere (`SWEEP_MOVES`): Route 16 Turbo's pulse 2 holds
 * `$4005` = $FF — a shift of 7 every eighth clock, a thirtieth of a semitone a frame — and every
 * octave up it struck through `$4007` came out a bend.
 */
const sweepDirection = (value: number) => {
  if (!(value & 0x80) || !(value & 0x07)) return 0;
  const up = value & 0x08 ? 1 : -1;
  // Semitones a frame: two half-frame clocks, every (divider + 1)th of them moving the period by its
  // 2^shift-th part.
  const perFrame = (Math.abs(12 * Math.log2(1 - up * 2 ** -(value & 7))) * 2) / (((value >> 4) & 7) + 1);
  return perFrame >= SWEEP_MOVES ? up : 0;
};
/** Semitones a frame a sweep has to move the pitch to carry a note (`sweepDirection`). */
const SWEEP_MOVES = 0.25;

/** A note a `keyon` channel strikes by its level alone, with no write: how far after the last struck note. */
interface LevelStrike {
  /** Frames from the last note the driver struck otherwise (by a write, a new pitch, after a silence). */
  offset: number;
  /** The note before was struck by its level alone too. */
  chained: boolean;
  /** The instrument of the note it strikes again (`instrumentOf`). */
  instrument: string;
  /** It climbs above anything that note reached: a note after a quiet echo, not a re-attack. */
  louder: boolean;
}
/**
 * A channel's level-only strikes, and for every note the driver struck otherwise the frames it went
 * on sounding and its instrument.
 */
interface Strikes {
  levels: LevelStrike[];
  spans: { frames: number; instrument: string }[];
  /**
   * The first two levels of every sound the channel opened at a pitch of its own — out of silence at
   * another pitch than it last sounded, or by a jump — and held for a second frame, as `first second`,
   * and how many it opened so (`lowOpenings`).
   */
  openings: Map<string, number>;
  opened: number;
}
/**
 * A note's instrument, as far as its levels tell: the levels of its second to fourth frames. Not the
 * first: Fester's Quest writes `$4003` with the note before's `$4000` still in place, and its first
 * frame holds whatever level that note had faded to.
 */
const INSTRUMENT_FRAMES = 4;
const instrumentOf = (o: Open | null) => (o ? o.levels.slice(1, INSTRUMENT_FRAMES).map(([, level]) => level).join(' ') : '');

/**
 * The offsets at which a channel's level-only strikes are its instrument re-attacking, not notes:
 * most of them (`REATTACK_SHARE`, and `REATTACK_MIN` at least) at one distance from the note the
 * driver struck, and hardly ever one after another. Yoshi's Cookie's instruments go 15 15 10 8, then
 * 15 again — four frames after every `$4003` write, whatever the note's length; Bubble Bobble's go
 * 15 11 7 3 11 10 9, Dragon Ball 2's 9 9 6 5 9. Their drivers write the restart register once a note
 * (their own strike logs), and every note came out as two. Ultimate Basketball's Ending strikes its
 * repeated E3s by the envelope alone, each a note length after the one before — a chain, not one
 * distance — and keeps them.
 */
const REATTACK_SHARE = 0.5;
const REATTACK_MIN = 4;
/** An instrument re-attacks early in its note; a level-only strike later than this is the music's. */
const REATTACK_MAX_FRAMES = 12;
/**
 * An instrument re-attacks in (nearly) every note that sounds long enough to get there; music strikes
 * a repeat only where the tune repeats a pitch. Puzznic, Final Lap, Mitsume ga Tooru and Amagon
 * strike their repeated eighths by the level alone, one note length after the written strike — one
 * distance, most of their level-only strikes — but most of their notes that last an eighth go on
 * without one, and the repeats were held as one note.
 */
const REATTACK_OF_NOTES = 0.9;
/** `offset instrument` keys: the distances at which each instrument of the channel re-attacks. */
function reattacks({ levels: found, spans }: Strikes): Set<string> {
  const out = new Set<string>();
  if (found.length < REATTACK_MIN || found.filter((f) => f.chained).length > found.length / 4) return out;
  const count = new Map<number, number>();
  for (const f of found) count.set(f.offset, (count.get(f.offset) ?? 0) + 1);
  for (const [offset, n] of count) {
    if (offset < INSTRUMENT_FRAMES || offset > REATTACK_MAX_FRAMES || n < REATTACK_MIN || n < found.length * REATTACK_SHARE) continue;
    /*
     * Instrument by instrument — or the channel's notes all together, for an instrument too rare to
     * tell: the share of its notes that reach the distance and re-attack there, and how many of those
     * are struck by the level again right after — a run of repeats, not an instrument. A frame later
     * is the same distance for a note struck with the level the one before had left (`instrumentOf`):
     * Batman's 9 9 9 8 7 re-attacks five frames in, and six where it was written at 3.
     */
    const by = new Map<string, { k: number; again: number }>();
    found.forEach((f, i) => {
      if ((f.offset !== offset && f.offset !== offset + 1) || f.louder) return;
      for (const key of [f.instrument, '*']) {
        const b = by.get(key) ?? { k: 0, again: 0 };
        b.k++;
        if (found[i + 1]?.chained) b.again++;
        by.set(key, b);
      }
    });
    let any = false;
    for (const [instrument, { k, again }] of by) {
      const reached = spans.filter((s) => (instrument === '*' || s.instrument === instrument) && s.frames > offset).length;
      if (k >= REATTACK_MIN && k >= reached * REATTACK_OF_NOTES && again <= k / 4) {
        out.add(`${offset} ${instrument}`);
        out.add(`${offset + 1} ${instrument}`);
        any = true;
      }
    }
    // An instrument heard too seldom to judge goes with the channel's that re-attack there: Yoshi's
    // Cookie plays 13 13 9 7 once in a song of 15 15 10 8, both re-attacking after four frames.
    if (!any) continue;
    const seldom = new Map<string, number>();
    for (const s of spans) if (s.frames > offset) seldom.set(s.instrument, (seldom.get(s.instrument) ?? 0) + 1);
    for (const f of found) if (f.offset === offset && !seldom.has(f.instrument)) seldom.set(f.instrument, 0);
    for (const [instrument, reached] of seldom) if (reached < REATTACK_MIN) out.add(`${offset} ${instrument}`);
  }
  return out;
}

/**
 * How a channel's instruments open their notes, when they open them below their second frame: Tecmo's
 * (Bad News Baseball) go 4 then 9, or 2 then 7, or 1 then 4, on nearly every note. When most of the
 * sounds the channel opened (`OPENING_SHARE`) climb by 2 or more on their second frame, the pairs
 * `first second` that do, each seen `REATTACK_MIN` times at least.
 *
 * Read where the notes repeat a pitch or follow the echo of the note before at its own level, such an
 * opening was taken for the end of what came before: a repeat struck by its second frame — a frame
 * late — and a new pitch at the echo's level taken for a Konami echo of the next note (`Open.echo`)
 * and split off as a one-frame note. A frame at the first level of an opening, followed by its second,
 * is the opening (`decodePass`).
 */
const OPENING_SHARE = 0.5;
function lowOpenings({ openings, opened }: Strikes): Set<string> {
  const low = [...openings].filter(([pair]) => {
    const [a, b] = pair.split(' ').map(Number);
    return b - a >= 2;
  });
  if (low.reduce((sum, [, n]) => sum + n, 0) < opened * OPENING_SHARE) return new Set();
  return new Set(low.filter(([, n]) => n >= REATTACK_MIN).map(([pair]) => pair));
}

export function decode(writes: readonly TimedWrite[], seconds: number, frameHz = 60.0988): DecodedNote[] {
  const found: Strikes[] = [0, 1, 2, 3].map(() => ({ levels: [], spans: [], openings: new Map(), opened: 0 }));
  const first = decodePass(writes, seconds, frameHz, null, found, null);
  const reattack = found.map(reattacks);
  const opening = found.map(lowOpenings);
  return reattack.some((r) => r.size) || opening.some((o) => o.size) ? decodePass(writes, seconds, frameHz, reattack, null, opening) : first;
}

function decodePass(
  writes: readonly TimedWrite[],
  seconds: number,
  frameHz: number,
  reattack: readonly Set<string>[] | null,
  found: Strikes[] | null,
  opening: readonly Set<string>[] | null
): DecodedNote[] {
  const rate = 88200;
  const expansion = expansionOf(writes);
  const apu = new Apu(rate, { expansion });
  const perFrame = rate / frameHz;
  const phase = driverPhase(writes, perFrame, rate);
  const size = Math.ceil(perFrame) + 2;
  const levels: ChannelBuffers = {
    pulse1: new Uint8Array(size),
    pulse2: new Uint8Array(size),
    triangle: new Uint8Array(size),
    noise: new Float64Array(size),
    dmc: new Uint8Array(size),
    // Rendered for the chips' own clocks (the FDS's envelopes move its gain); the decoder reads their state.
    ...(apu.fds ? { fds: new Float64Array(size) } : {}),
    ...(apu.n163 ? { n163: Array.from({ length: 8 }, () => new Float64Array(size)) } : {}),
  };
  const notes: DecodedNote[] = [];
  const openX = new Map<string, Open & { waveKey: string; wave: number[] }>();
  const closeX = (track: string, end: number) => {
    const o = openX.get(track);
    if (!o) return;
    openX.delete(track);
    const duration = end - o.start;
    if (duration <= 0) return;
    // The expansion voices keep the scoop rule alone (`heldName` is the 2A03's).
    const name = named(o, true, false);
    const note: DecodedNote = {
      track: track as Track,
      midi: name.midi,
      pitch: name.pitch,
      start: o.start,
      duration,
      volume: o.volume,
      volumeEnd: o.lastVolume,
      duty: o.duty,
      periodIndex: 0,
      ...(o.wave.length ? { wave: o.wave } : {}),
    };
    const straight = o.levels.every(
      ([t, level]) => Math.abs(level - (o.volume + ((o.lastVolume - o.volume) * (t - o.start)) / duration)) <= 1
    );
    if (!straight) {
      note.levels = o.levels
        .filter(([, level], index) => index === 0 || level !== o.levels[index - 1][1])
        .map(([t, level]): [number, number] => [t - o.start, level]);
    }
    const bend = o.bend.map(([t, semis]): [number, number] => [t, semis + name.shift]);
    if (bend.some(([, semis]) => Math.abs(semis) >= 0.1)) {
      note.bend = [...bend.map(([t, semis]): [number, number] => [(t - o.start) / duration, semis]), [1, bend[bend.length - 1][1]]];
    }
    notes.push(note);
  };
  const open: (Open | null)[] = [null, null, null, null];
  /** The pulses' sweep bytes, and the periods their low/high registers were last written with. */
  const sweep = [0, 0];
  const periodLo = [0, 0, 0];
  const periodHi = [0, 0, 0];
  const prevPeak = [0, 0, 0, 0];
  const keying = keyingOf(writes, perFrame, rate, phase);
  const rewritesOnStep_ = rewritesOnStep(writes, perFrame, rate, phase);
  const plan = writePlan(writes, perFrame, rate, phase, Math.ceil(seconds * frameHz) + 2);
  const windowOf = (k: number) => Math.min(plan.period[0].length - 1, Math.max(0, k + 1));
  /** The period the driver left a pulse or the triangle with in window `k` (the loop's frame numbers). */
  const periodAt = (ch: number, k: number) => plan.period[ch][windowOf(k)];
  const periodOf = (ch: number, pitch: number) => Math.round(CPU_HZ / ((ch === 2 ? 32 : 16) * 440 * 2 ** ((pitch - 69) / 12)) - 1);
  /**
   * The period moves in window `k` by the step it moved in the window before, or will in the one after,
   * and the run of such steps does not land on a pitch it then holds (`SLIDE_STEP_SHARE`).
   */
  const slides = (ch: number, k: number) => {
    const stepAt = (x: number) => periodAt(ch, x) - periodAt(ch, x - 1);
    const d = stepAt(k);
    if (d === 0) return false;
    const same = (step: number, e: number) => Math.sign(e) === Math.sign(step) && Math.abs(e - step) <= Math.max(1, Math.abs(step) * SLIDE_STEP_SHARE);
    // The run of such steps through window `k`, back and on: three steps at least.
    let begin = k;
    let end = k;
    for (let step = d; k - begin < SLIDE_RUN_FRAMES && same(step, stepAt(begin - 1)); begin--) step = stepAt(begin - 1);
    for (let step = d; end - k < SLIDE_RUN_FRAMES && same(step, stepAt(end + 1)); end++) step = stepAt(end + 1);
    if (end - begin + 1 < SLIDE_STEPS) return false;
    // Followed on through steps that only drift from it (a whole-tone run's periods shrink by an eighth a
    // step, and rounding makes some steps more): Magic Johnson's High Score climbs D#4 to C#6 a frame a
    // step into a held D#6, and the run read in two halves left the first one's landing unseen.
    const onward = (step: number, e: number) => Math.sign(e) === Math.sign(step) && Math.abs(e - step) <= Math.max(2, Math.abs(step) / 4);
    for (let step = stepAt(end); end - k < SLIDE_RUN_FRAMES && onward(step, stepAt(end + 1)); end++) step = stepAt(end + 1);
    // It lands where its period then holds for a frame, sounding (Contra Force scoops A4 A#4 B4 into a
    // held C5, periods 254 240 226 214).
    const settles = (x: number) => semitones(periodAt(ch, x + 1), periodAt(ch, x)) < HOLD_SEMITONES && !silenced(ch, x) && !silenced(ch, x + 1);
    return !settles(end);
  };
  /** A step of the high register's vibrato around the note `o` (`VIBRATO_PERIODS`). */
  const vibratoStep = (ch: number, k: number, o: Open) => {
    const p = periodAt(ch, k);
    const base = periodOf(ch, o.pitch);
    if (Math.abs(p - periodAt(ch, k - 1)) > VIBRATO_PERIODS || Math.abs(p - base) > VIBRATO_PERIODS) return false;
    if (p === base) return true;
    for (let j = 1; j <= VIBRATO_RETURN_FRAMES; j++) {
      if (keying[ch] === 'keyon' && plan.restart[ch][windowOf(k + j)]) return false;
      if (periodAt(ch, k + j) === base) return true;
    }
    return false;
  };
  /** The driver silenced the channel in window `k` by its first register: a pulse's constant level 0, the triangle's counter 0. */
  const silenced = (ch: number, k: number) => {
    const control = plan.control[ch][windowOf(k)];
    return control >= 0 && (ch === 2 ? (control & 0x7f) === 0 : (control & 0x1f) === 0x10);
  };
  /**
   * Window `k + 1` ends what window `k` started on the channel: it writes the restart register again,
   * moves the period, or silences it (`oneFrameRewrite`).
   */
  const endsNext = (ch: number, k: number) =>
    plan.restart[ch][windowOf(k + 1)] === 1 || (ch < 3 && periodAt(ch, k + 1) !== periodAt(ch, k)) || (ch !== 3 && silenced(ch, k + 1));
  /** Where each pulse's last sound opened at a pitch of its own, waiting for its second frame (`Strikes.openings`). */
  const openingAt: ({ level: number; pitch: number } | null)[] = [null, null];
  const lastOn = [false, false];
  const lastPitch = [0, 0];
  /** Each restart register's last value, to tell a write that repeats it (a strike) from one that moves it. */
  const restartValue = [-1, -1, -1, -1];
  /**
   * Where a silent channel was last restarted: a driver whose envelope starts at 0 writes the note
   * a frame or two before it is heard (Mother, Tetris 2, Solomon's Key's noise), and the note starts
   * at the write.
   */
  const silentStart: ({ time: number; frame: number; written: boolean; period: number; small: boolean } | null)[] = [null, null, null, null];
  /** The noise's `$400E` as last written (`silentStart`). */
  let noiseRate = -1;
  /** Where each channel's last note was struck other than by its level alone, and whether the last one was (`LevelStrike`). */
  const struckAt = [0, 0, 0, 0];
  /** The last frame each channel sounded in, and whether it has struck a note yet (`Strikes.spans`). */
  const heard = [0, 0, 0, 0];
  const struckYet = [false, false, false, false];
  /** The pitches the notes before the open one were struck at and ended at, the latest first (`Open.echo`). */
  const pitchesBefore: number[][][] = [[], [], [], []];
  /** Whether each pulse's period low byte was written in the window before (`struckAgain`). */
  const pitchSetBefore = [false, false];
  /** The note each channel's driver last struck otherwise than by its level alone (`instrumentOf`). */
  const struckNote: (Open | null)[] = [null, null, null, null];
  /** Each channel's first register as last written: its envelope's mode (`levelRise`). */
  const control = [0, 0, 0, 0];
  /** The window each restart register was last written in, before this one. */
  const lastRestart = [-Infinity, -Infinity, -Infinity, -Infinity];
  const byLevel = [false, false, false, false];
  /** Whether the window before wrote the FDS frequency high byte (see `fdsStruck`). */
  let fdsHiBefore = false;
  /** `$4015` as last written: the channels it leaves on. */
  let status = 0;
  /** The same for the VRC6's three voices: `$9002`, `$A002`, `$B002`. */
  const vrc6HiBefore = [false, false, false];

  /**
   * A comeback that went the note's way (`Comeback`): the note ends where it fell silent, and the
   * comeback is a note of its own, as if struck after a rest.
   */
  const strikeComeback = (ch: number) => {
    const o = open[ch]!;
    const c = o.comeback!;
    o.comeback = undefined;
    open[ch] = { ...o, levels: o.levels.slice(0, c.index), bend: o.bend.filter(([t]) => t < c.time), dipFrom: c.dipFrom };
    close(ch, c.time);
    const levels = o.levels.slice(c.index);
    const again: Open = {
      ...o,
      midi: Math.round(c.pitch),
      pitch: c.pitch,
      start: c.time,
      frames: levels.length,
      held: levels.length,
      volume: levels[0][1],
      lastVolume: levels[0][1],
      bend: o.bend.filter(([t]) => t >= c.time).map(([t, semis]): [number, number] => [t, semis + o.pitch - c.pitch]),
      levels: [levels[0]],
      climbing: true,
      rose: false,
      sinceRise: 0,
      struck: true,
      dipFrom: undefined,
      dipFrames: 0,
      reattacked: undefined,
      climbedAt: undefined,
      top: undefined,
      mark: undefined,
    };
    for (const level of levels.slice(1)) {
      follow(again, level[1]);
      again.lastVolume = level[1];
      again.levels.push(level);
    }
    open[ch] = again;
    if (struckYet[ch]) found?.[ch].spans.push({ frames: c.frame - struckAt[ch], instrument: instrumentOf(struckNote[ch]) });
    struckYet[ch] = true;
    struckAt[ch] = c.frame;
    struckNote[ch] = again;
    byLevel[ch] = false;
  };
  /** One more frame of a pending comeback: struck again or resumed, once its frames tell. */
  const followComeback = (ch: number) => {
    const goes = open[ch]?.comeback ? comebackGoes(open[ch]!) : undefined;
    if (goes === true) strikeComeback(ch);
    if (goes === false) open[ch]!.comeback = undefined;
  };

  const close = (ch: number, end: number) => {
    // Cut off while its frames still went the note's way: struck again — if it was heard for two
    // frames at least. Batman's notes dip for a frame and come back for one at the level they were
    // struck at, the frame before the next note's write: the tail of the note, in its driver's reads.
    const pending = open[ch]?.comeback;
    if (pending && open[ch]!.levels.length - pending.index >= 2 && comebackTops(open[ch]!)) strikeComeback(ch);
    const o = open[ch];
    if (!o) return;
    open[ch] = null;
    if (o.dipFrom !== undefined) {
      // It fell silent and did not come back: it ends where it fell.
      const from = o.dipFrom;
      end = Math.min(end, from);
      o.levels = o.levels.filter(([t]) => t < from);
      o.bend = o.bend.filter(([t]) => t < from);
      o.lastVolume = o.levels.length ? o.levels[o.levels.length - 1][1] : o.volume;
    }
    // Struck at a write in silence of a period that was no pitch of it: it starts at its sound (`MARK_HELD`).
    if (o.mark) {
      const marked = midiOf(CPU_HZ / (16 * (o.mark.period + 1)));
      if ((o.mark.period & 0xff) === 0 && !o.bend.some(([, s]) => Math.abs(o.pitch + s - marked) < MARK_HELD)) {
        const sound = o.mark.sound;
        o.start = sound;
        o.levels = o.levels.filter(([t]) => t >= sound);
        o.bend = o.bend.map(([t, s], i): [number, number] => [i === 0 ? sound : t, s]);
      }
    }
    const duration = end - o.start;
    if (duration <= 0) return;
    const name = named(o, ch !== 2);
    const note: DecodedNote = {
      track: TRACKS[ch],
      midi: name.midi,
      pitch: name.pitch,
      start: o.start,
      duration,
      volume: o.volume,
      volumeEnd: o.lastVolume,
      duty: o.duty,
      periodIndex: o.periodIndex,
    };
    // The level as it went, where a straight line from the first to the last would not say so.
    const straight = o.levels.every(
      ([t, level]) => Math.abs(level - (o.volume + ((o.lastVolume - o.volume) * (t - o.start)) / duration)) <= 1
    );
    if (!straight && TRACKS[ch] !== 'triangle') {
      note.levels = o.levels
        .filter(([, level], index) => index === 0 || level !== o.levels[index - 1][1])
        .map(([t, level]): [number, number] => [t - o.start, level]);
    }
    const bend = o.bend.map(([t, s]): [number, number] => [t, s + name.shift]);
    if (bend.some(([, s]) => Math.abs(s) >= 0.1)) {
      note.bend = [...bend.map(([t, s]): [number, number] => [(t - o.start) / duration, s]), [1, bend[bend.length - 1][1]]];
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
    /** The channel's first register (`$4000`/`$4004`/`$4008`/`$400C`) was written — its level or envelope set. */
    const controlled = [false, false, false, false];
    /** The pulses' period low byte was written (`Open.echo`), and their sweep register (`stepping`). */
    const pitchSet = [false, false];
    const swept = [false, false];
    /** The pulses' periods and the noise's rate as they stood when the window opened (`silentStart`). */
    const periodBefore = [0, 1, 2].map((ch) => (periodHi[ch] << 8) | periodLo[ch]).concat(noiseRate);
    /** Restarted with the high bits it already held — a strike on a `keyon` channel. */
    const repeated = [false, false, false, false];
    let fdsHi = false;
    const vrc6Hi = [false, false, false];
    let at = done;
    /** The window's first sample after the driver's update — where its levels are read from. */
    let settled = 0;
    const updateEnd = done + (next - done) * UPDATE_SHARE;
    while (at < next) {
      while (wi < writes.length && writes[wi].time * rate <= at) {
        const w = writes[wi++];
        apu.write(w.address, w.value);
        if (w.address >= 0x4000 && w.address <= 0x400b) {
          const i = (w.address - 0x4000) >> 2;
          const r = w.address & 3;
          if (r === 1 && i < 2) {
            sweep[i] = w.value;
            swept[i] = true;
          }
          if (r === 2) periodLo[i] = w.value;
          if (r === 3) periodHi[i] = w.value & 7;
        }
        if (w.address === 0x400e) noiseRate = w.value & 0x8f;
        if (w.address <= 0x400c && (w.address & 3) === 0) {
          controlled[w.address >> 2 & 3] = true;
          control[w.address >> 2 & 3] = w.value;
        }
        if (w.address === 0x4002 || w.address === 0x4006) pitchSet[(w.address - 0x4002) >> 2] = true;
        /*
         * A channel switched off by `$4015` in the update is silent from there, as a level of 0 is:
         * Ikki's Miss stops its last D with `$4015` = 0 a few samples into frame 264, and read from
         * the window's first sample the D sounded through it — a frame long, the song 265 frames for
         * the driver's 264, a tick past its last bar (Jajamaru no Daibouken's Stage Start too).
         */
        const silenced = w.address === 0x4015 && (status & ~w.value & 0x0f) !== 0;
        if (w.address === 0x4015) status = w.value;
        if ((w.address <= 0x400f || silenced) && at <= updateEnd) settled = Math.max(settled, at - done);
        const c = RESTART.indexOf(w.address);
        if (c >= 0) {
          restarted[c] = true;
          if (restartValue[c] >= 0 && restartKey(c, w.value) === restartKey(c, restartValue[c])) repeated[c] = true;
          restartValue[c] = w.value;
        }
        if (w.address === 0x4083) fdsHi = true;
        if (w.address === 0x9002 || w.address === 0xa002 || w.address === 0xb002) vrc6Hi[(w.address >> 12) - 9] = true;
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
    /**
     * The window gave the channel a new period, or the noise a new rate — with or without a write of
     * the restart register: Family Block sets each note's period with `$4002` alone at level 0, a
     * frame before it sounds (its note reads), and Adventure Island II's repeated high bits are
     * never written again.
     */
    /** The driver wrote a period a semitone or more from the one before (see the sweep below). */
    const leapt = [0, 1].map((ch) => Math.abs(12 * Math.log2((((periodHi[ch] << 8) | periodLo[ch]) + 1) / (periodBefore[ch] + 1))) >= 0.9);
    const repitched = [0, 1, 2, 3].map((ch) =>
      ch < 2
        ? ((periodHi[ch] << 8) | periodLo[ch]) !== periodBefore[ch]
        : ch === 3 && noiseRate !== periodBefore[3]
    );
    const time = done / rate;

    for (let ch = 0; ch < 4; ch++) {
      const [on, pitch] = state[ch];
      let o = open[ch];
      const heardBefore = heard[ch];
      if (on) heard[ch] = frame;
      // How the pulse's sounds open, frame by frame, whatever is made of them (`lowOpenings`).
      if (ch < 2 && found) {
        const level = Math.round(peaks[ch]);
        const waiting = openingAt[ch];
        if (waiting && on && Math.abs(pitch - waiting.pitch) < 0.5) {
          const pair = `${waiting.level} ${level}`;
          found[ch].openings.set(pair, (found[ch].openings.get(pair) ?? 0) + 1);
          found[ch].opened++;
        }
        openingAt[ch] = null;
        if (on && (lastOn[ch] ? Math.abs(pitch - lastPitch[ch]) >= 0.9 : Math.abs(pitch - lastPitch[ch]) >= 0.5)) {
          openingAt[ch] = { level, pitch };
        }
        lastOn[ch] = on;
        if (on) lastPitch[ch] = pitch;
      }
      /*
       * A one-step climb that does not go on — it falls straight back, moves to another pitch or
       * stops — from a frame the driver did not strike, was no attack: Contra Force plays each
       * note's last frame at the next one's pitch at level 1 or 2 — the tail of the note before, an
       * echo — and strikes the note itself at 3 or 6 the frame after, falling from there; the
       * Camerica Dizzy's arpeggios strike 13 on the pitch the last frame of the note before held at
       * 5. The note starts at its strike, and the frame before stays a note of its own, as it
       * sounds. A first frame that was struck itself (`struck`) keeps the note: Kaijuu Monogatari's
       * 5, 10, 5, 3 rises into its 5 from the note before's 1, and Love Quest's echo 2, 5, 2 after a
       * rest is one sound.
       */
      if (o?.climbedAt) {
        const at = o.climbedAt;
        o.climbedAt = undefined;
        if (!on || peaks[ch] < at.volume || Math.abs(pitch - o.last) >= 0.9) {
          const tail = { ...o, levels: o.levels.filter(([t]) => t < at.time), bend: o.bend.filter(([t]) => t < at.time) };
          tail.lastVolume = tail.levels[tail.levels.length - 1][1];
          open[ch] = tail;
          close(ch, at.time);
          const was = o;
          o = open[ch] = {
            ...o,
            midi: Math.round(at.pitch),
            pitch: at.pitch,
            start: at.time,
            frames: o.frames - 1,
            volume: at.volume,
            duty: at.duty,
            periodIndex: at.periodIndex,
            bend: o.bend.filter(([t]) => t >= at.time).map(([t, semis]): [number, number] => [t, semis + o!.pitch - at.pitch]),
            levels: o.levels.filter(([t]) => t >= at.time),
            rose: false,
            top: undefined,
            mark: undefined,
          };
          if (struckNote[ch] === was) struckNote[ch] = o;
        }
      }
      // A rise that goes on climbing from the note's start is its attack, not a new strike.
      /** The driver set the pulse's pitch and level in this window (`Open.echo`). */
      const repitch = ch < 2 && pitchSet[ch] && controlled[ch];
      /*
       * Not the noise struck at a new rate: Ys III plays a click of 1 at rate 5 the frame before each
       * hit at 10 at rate 7, Jungle Book a hi-hat the frame before its kick, P.O.W. a hat before the
       * kick, Castlevania III a click before the snare — each written `$400F` and `$400E` its own,
       * and the hit was read as the click's attack.
       */
      const climb = o !== null && ch !== 2 && inAttack(o) && !(ch === 3 && restarted[3] && repitched[3]);
      /*
       * A looping hardware envelope (`$4000` bit 5 set, bit 4 clear) climbs back to 15 by itself
       * every time it runs out: the chip's sawtooth, not a strike. Wizards & Warriors plays Potion's
       * sixteenths at `$E1` and each came out a note of 3 ticks and one of 1; Mappy's notes split on
       * every turn of the saw. Unless the driver restarted it with a write of the restart register:
       * Roller Ball's hi-hat, written at a new rate as the snare's saw runs down, came out its tail.
       */
      const sawtooth = ch !== 2 && (control[ch] & 0x30) === 0x20 && !(restarted[ch] && keying[ch] !== 'every');
      const levelRise = ch !== 2 && !sawtooth ? peaks[ch] - prevPeak[ch] : 0;
      prevPeak[ch] = peaks[ch];
      /*
       * A `keyon` pulse whose level dipped to 0 inside a note, back at the same pitch without a
       * write: the same note (`DIP_FRAMES`) — unless it comes back struck (`struckAgain`).
       */
      let resumed = false;
      if (o?.dipFrom !== undefined && on) {
        const again = struckAgain(o, peaks[ch], s.pulse[ch].duty, pitchSet[ch] && !pitchSetBefore[ch]);
        if (!restarted[ch] && Math.abs(pitch - o.last) < 0.5 && again !== true) {
          resumed = true;
          if (again === 'maybe') o.comeback = comebackOf(o, time, frame, pitch, Math.round(peaks[ch]));
          o.dipFrom = undefined;
          o.dipFrames = 0;
        } else {
          close(ch, time);
          o = null;
        }
      }
      if (!on) {
        if (o && ch < 2 && keying[ch] === 'keyon' && !restarted[ch] && peaks[ch] === 0 && s.pulse[ch].period >= 8 && (o.dipFrames ?? 0) < DIP_FRAMES) {
          o.dipFrom ??= time;
          o.dipFrames = (o.dipFrames ?? 0) + 1;
          o.frames++;
          follow(o, 0);
          o.lastVolume = 0;
          o.levels.push([time, 0]);
          if (o.comeback) {
            // A comeback that falls silent again on its next frames: as the opening did, or not.
            const dipFrom = o.dipFrom;
            o.dipFrom = undefined;
            followComeback(ch);
            open[ch]!.dipFrom = dipFrom;
          }
          continue;
        }
        close(ch, time);
        // Not the triangle: it has no envelope to rise from zero, and a window it is still off in
        // after its restart is the linear counter not yet reloaded — King's Knight's Final Boss
        // writes its bass at the very end of a window and came out with every note a frame early.
        // A silent pulse or noise given its next pitch — by the restart register, or a pulse by the
        // period alone — has been struck there, whatever its level does next (`MARK_STEP`).
        if (ch !== 2) {
          const written = restarted[ch] && keying[ch] !== 'every';
          const mark = silentStart[ch] && frame - silentStart[ch]!.frame <= SILENT_START_FRAMES ? silentStart[ch] : null;
          const period = ch < 2 ? (periodHi[ch] << 8) | periodLo[ch] : noiseRate;
          const small = ch < 2 && semitones(period, mark ? mark.period : periodBefore[ch]) < MARK_STEP;
          // A pulse written again at the pitch of the note it wrote in this silence is that note; a
          // small step of the period alone does not move a mark that is not one itself.
          const keep = mark !== null && ch < 2 && small && (written ? mark.written : !mark.small);
          // A period moving on through the silence — an arpeggio left running, as in M.C. Kids — marks
          // no more than a small step does.
          const running = !written && mark !== null && !mark.written;
          if ((written || (ch < 2 && repitched[ch])) && !keep) silentStart[ch] = { time, frame, written, period, small: (small || running) && !written };
        }
        continue;
      }
      let jumped = o !== null && ch !== 3 && Math.abs(pitch - o.last) >= 0.9;
      // The sweep carrying the pitch its own way is the same note gliding, not a new one — unless the
      // driver wrote the leap itself, on a channel it does not rewrite every frame: Time Diver Eon
      // Man rewrites `$4002`/`$4003` every frame of its swept run, a semitone a frame, and every frame
      // came out a note. (Yoshi's Cookie rewrites its low byte a period or two either way all through
      // a swept fall.)
      const wroteLeap = leapt[ch] && keying[ch] !== 'every';
      if (jumped && ch < 2 && !wroteLeap && Math.sign(pitch - o!.last) === sweepDirection(sweep[ch])) jumped = false;
      if (jumped && ch === 2 && o!.frames < TRIANGLE_ATTACK_FRAMES) jumped = false;
      /*
       * Nor a slide's step (`SLIDE_STEP_SHARE`) or a high vibrato's (`VIBRATO_PERIODS`), read off the
       * periods the driver writes (so not where the sweep moves the pulse) — nor a pulse note's one
       * frame of approach out of silence: a note that sounds one frame and jumps to a pitch it then
       * holds for three frames at least, its restart not written again, was that pitch's attack (rule
       * 24). Bill Elliott's NASCAR Challenge opens every stab of Pit Stop with a frame a fifth below at
       * level 3 (F3, then C4 at 7), and the frame came out a note of its own; named after the pitch it
       * holds (`named`). A fall a semitone a frame or two from the written pitch (Astyanax) does not
       * hold. Between two notes such a frame is the tail of one or the attack of the other by the grid
       * (rule 24): the post-fix's to say.
       */
      const ownPeriod = ch === 2 || sweepDirection(sweep[ch]) === 0;
      if (jumped && ownPeriod && (slides(ch, frame) || vibratoStep(ch, frame, o!))) jumped = false;
      const approach = jumped && ch < 2 && ownPeriod && o!.frames === 1 && o!.fromSilence === true &&
        [1, 2].every((m) => semitones(periodAt(ch, frame + m), periodAt(ch, frame)) < HOLD_SEMITONES && !(keying[ch] === 'keyon' && plan.restart[ch][windowOf(frame + m)]));
      if (approach) jumped = false;
      /*
       * A strike at the same pitch, by how this channel's driver keys its notes (`keyingOf`). The
       * noise has no vibrato, so on a `keyon` channel any write of `$400F` is a hit; elsewhere a
       * write that moves the high bits is a vibrato crossing a boundary. The triangle has no level:
       * only a keyed write restarts it.
       */
      /*
       * On a channel whose driver writes the restart register with every change of the period
       * (`rewritesOnStep`), a rewrite of the high bits a note already holds, made with a period less
       * than half a semitone from the one written before, its level not rising and its first
       * register left alone, is a vibrato or a glide stepping, not a strike: Fire Emblem Gaiden
       * writes `$400A`/`$400B` together on every step of the triangle's vibrato, Love Quest every
       * second frame — a note a step, where the drivers' own note reads have one. A driver that
       * writes it only to strike strikes there, pitch moving or not: Dragon Ball 2 re-strikes its
       * triangle at the pitch its vibrato left it; and a semitone is a note, not a step: Blaster
       * Master's triangle grace notes a semitone under the note. A pulse's first register written
       * with its level falling, and its sweep left alone, is its decay stepping on: Platoon's Combat
       * Zone lets each vibrato note down 7 6 5 4 3 a step every sixteen frames, and every step came
       * out a note. (After Burner II strikes a note at 1 as the one before fades from 2, `$4001` and all.)
       */
      const period = (periodHi[ch] << 8) | periodLo[ch];
      const decaying = ch < 2 && levelRise < 0 && !swept[ch];
      const stepping = rewritesOnStep_[ch] && (!controlled[ch] || decaying) && o !== null && ch !== 3 && period !== periodBefore[ch] &&
        Math.abs(12 * Math.log2((period + 1) / (periodBefore[ch] + 1))) < 0.5;
      /*
       * The noise struck again is heard again: its level goes back up, or at least stops falling. A
       * driver that rewrites `$400F` on the way down, a frame or two after its last write — Maniac
       * Mansion's drums every second frame, swapping two rates, as their level falls 11 to 0 — is
       * playing one hit, as its event log has. Not on a hit's second frame (Fester's Quest strikes
       * its drum at 13 a frame after a click at 15), nor long after the last write (Ikari Warriors
       * III's soft hit at level 1, as the one before has faded to 2), nor a step down of more than one
       * (Abarenboh Tengu's roll holds each stroke flat for two frames, 13 13, 11 11, 9 9, as it
       * swaps two rates, and every step down is a stroke): those are hits.
       */
      const noiseHit =
        ch === 3 &&
        !(o !== null && o.frames >= 2 && peaks[ch] < o.lastVolume && peaks[ch] >= o.lastVolume - 1 && frame - lastRestart[3] <= NOISE_STEP_FRAMES);
      /*
       * Nor the restart register written again with the value it holds, at the period it holds, the
       * level not rising and the first register left alone, where the piece it would start lasts one
       * frame (`endsNext`): Jajamaru Ninpou Chou's Battle rewrites `$4003` on the last frame of the
       * notes of its runs (4 + 1 frames), Town with Sakura's arpeggio `$4007` on three frames running
       * of each note. A frame at one pitch and one level is not heard as the note struck again.
       */
      const oneFrameRewrite =
        ch < 3 && o !== null && restarted[ch] && repeated[ch] && !controlled[ch] && period === periodBefore[ch] && levelRise <= 0 && endsNext(ch, frame);
      const keyed = (rise: number) =>
        restarted[ch] && ((repeated[ch] && !oneFrameRewrite && (!stepping || rise >= 2) && (ch !== 3 || noiseHit)) || rise >= 2 || noiseHit);
      const levelOnly = (rise: number) =>
        o !== null && ((rise >= KEYON_RISE && o.frames > TRIANGLE_ATTACK_FRAMES) || (rise >= 2 && decayedOnly(o) && peaks[ch] >= o.levels[decayFrom(o)][1]));
      const strikes = (rise: number) => (keying[ch] !== 'keyon' ? rise >= 2 : keyed(rise) || levelOnly(rise));
      // A note struck out of an echo (`Open.echo`).
      // Not one of the channel's openings, first frame to second (`lowOpenings`): Bad News Baseball's
      // notes open at the level of the echo before them, 2 then 7.
      const opens = (from: number) => opening?.[ch].has(`${from} ${Math.round(peaks[ch])}`) === true;
      const pitchStrike = !resumed && o !== null && o.echo === true && o.frames <= ECHO_FRAMES && repitch && levelRise >= 3 && !(o.frames === 1 && opens(o.volume));
      let restart = !resumed && (strikes(climb ? 0 : levelRise) || pitchStrike);
      /*
       * Struck by the level alone on a channel whose driver writes its strikes: a note of its own,
       * unless the channel's instrument re-attacks at that distance after every note (`reattacks`).
       */
      const levelStrike = restart && keying[ch] === 'keyon' && !keyed(levelRise) && !jumped && !pitchStrike;
      if (levelStrike) {
        const offset = frame - struckAt[ch];
        const instrument = instrumentOf(struckNote[ch]);
        const louder = struckNote[ch] !== null && peaks[ch] > Math.max(...struckNote[ch]!.levels.map(([, level]) => level));
        found?.[ch].levels.push({ offset, chained: byLevel[ch], instrument, louder });
        if (!louder && (reattack?.[ch].has(`${offset} ${instrument}`) || reattack?.[ch].has(`${offset} *`))) {
          restart = false;
          o!.reattacked = o!.levels.length;
        }
      }
      // The rise alone would have struck: if the note falls straight after it, it did (`climbedAt`).
      const climbStruck = climb && !restart && !resumed && strikes(levelRise);
      /*
       * A triangle kick: the pitch falling over a note's first frames, struck
       * again on the way or not, is the attack of the note it falls ONTO — the
       * bass is that note, the fall is how it is hit. Alien 3 strikes every bass
       * note C#4, A3, then F#3 a frame each, restarting on the F#3; read as a
       * note of its own the C#4 came out a separate head with a slide of four
       * semitones drawn down from it.
       */
      // One frame a step: a trill falls too, but holds each note for longer (Balloon Fight's G4/B♭4
      // three frames apiece came out one G4 bent up and down).
      if (ch === 2 && o && o.frames < TRIANGLE_KICK_FRAMES && o.held <= 1 && pitch < o.last - 0.5) {
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
        o.held = 1;
        continue;
      }
      if (o && !restart && !jumped) {
        if (ch !== 3) o.bend.push([time, pitch - o.pitch]);
        o.held = Math.abs(pitch - o.last) < 0.5 ? o.held + 1 : 1;
        o.last = pitch;
        o.frames++;
        const level = Math.round(ch === 2 ? 12 : peaks[ch]);
        if (climbStruck && o.frames === 2 && !o.rose && !o.struck) {
          o.climbedAt = { time, pitch, volume: level, duty: ch < 2 ? s.pulse[ch].duty : 0, periodIndex: s.noise.periodIndex };
        }
        follow(o, level, ch < 2 ? pitch : undefined);
        o.lastVolume = level;
        o.levels.push([time, o.lastVolume]);
        if (o.comeback) followComeback(ch);
        continue;
      }
      /*
       * Struck by its level alone at the pitch it held, from a frame at the first level of one of the
       * channel's openings to its second (`lowOpenings`): that frame was the note's first. Bad News
       * Baseball repeats a pitch with no write, 4 then 9 on the frames after the echo of the note
       * before at 4, and every repeat started a frame late.
       */
      const lead = restart && o !== null && !jumped && !pitchStrike && !(restarted[ch] && keying[ch] !== 'every') && o.frames >= 2 &&
        o.dipFrom === undefined && Math.abs(pitch - o.last) < 0.5 && o.levels.length >= 2 &&
        o.levels[o.levels.length - 2][1] >= o.lastVolume && o.lastVolume < Math.round(peaks[ch]) && opens(o.lastVolume)
        ? o.levels[o.levels.length - 1]
        : null;
      if (lead) {
        o!.levels.pop();
        o!.bend = o!.bend.filter(([t]) => t < lead[0]);
        o!.frames--;
        o!.lastVolume = o!.levels[o!.levels.length - 1][1];
      }
      close(ch, lead ? lead[0] : time);
      const byWrite = !levelStrike || !o || jumped;
      if (byWrite) {
        if (struckYet[ch]) found?.[ch].spans.push({ frames: heardBefore - struckAt[ch] + 1, instrument: instrumentOf(struckNote[ch]) });
        struckYet[ch] = true;
        struckAt[ch] = frame;
      }
      byLevel[ch] = levelStrike && o !== null && !jumped;
      const volume = Math.round(ch === 2 ? 12 : peaks[ch]);
      /*
       * A swept pulse struck this frame has already moved by the window's end, where its pitch is
       * read: the note is the period the driver wrote, and the fall is its bend from there.
       */
      const written = ch < 2 && restarted[ch] && sweepDirection(sweep[ch]) !== 0
        ? midiOf(CPU_HZ / (16 * ((periodHi[ch] << 8 | periodLo[ch]) + 1)))
        : pitch;
      /*
       * Not when the mark was no note — a pause written as period 0 (F-1 Race, Abadox) — or when this
       * frame set a pitch of its own after one set in silence by the period alone (Family Block glides
       * on through the frame it cuts). A note written in silence stays struck at its write, however it
       * moves as it sounds:
       * Alien 3 writes a note at level 0 and slides it on, Star Tropics 2 scoops into the note it
       * wrote, Captain Tsubasa and Dr. Mario step a vibrato or a detune through the silent frames.
       */
      const mark = silentStart[ch];
      const wrong = mark !== null && ch < 2 && (mark.period < 8 || (!mark.written && repitched[ch]));
      const silent = !o && !restarted[ch] && mark && !wrong ? mark : null;
      const marked = silent && frame - silent.frame <= (silent.small ? SMALL_MARK_FRAMES : SILENT_START_FRAMES) ? silent : null;
      const start = lead ? lead[0] : marked ? marked.time : time;
      silentStart[ch] = null;
      open[ch] = {
        midi: Math.round(written),
        pitch: written,
        last: pitch,
        start,
        frames: 1,
        held: 1,
        volume,
        lastVolume: volume,
        duty: ch < 2 ? s.pulse[ch].duty : 0,
        periodIndex: s.noise.periodIndex,
        bend: lead ? [[start, o!.last - written], [time, 0]] : [[start, 0]],
        levels: lead ? [lead, [time, volume]] : start < time ? [[start, 0], [time, volume]] : [[time, volume]],
        climbing: true,
        rose: lead !== null,
        sinceRise: 0,
        struck: (restarted[ch] && keying[ch] === 'keyon') || !o || levelRise >= 2,
        echo:
          !lead && o !== null && jumped && !(restarted[ch] && keying[ch] === 'keyon') && volume <= ECHO_LEVEL &&
          [[o.pitch], ...pitchesBefore[ch]].some((before) => before.some((p) => Math.abs(pitch - p) < 0.5)),
        fromSilence: !o,
        swept: ch < 2 && sweepDirection(sweep[ch]) !== 0,
        ...(ch < 2 && marked?.written && start < time ? { mark: { period: marked.period, sound: time } } : {}),
      };
      if (lead) {
        open[ch]!.volume = lead[1];
        open[ch]!.frames = 2;
      }
      // Where the notes struck and where they ended: Yume Penguin Monogatari's bends away.
      if (o && !o.echo) pitchesBefore[ch] = [[o.pitch, o.last], ...pitchesBefore[ch]].slice(0, ECHO_DELAY_NOTES + 1);
      if (byWrite) struckNote[ch] = open[ch];
    }
    /*
     * The expansion voices, read off the chips' state the same way: a voice sounding is a note; a
     * new one starts on an attack (the level up by 2 or more), a jump of a semitone, or a new
     * waveform — a driver changing the timbre between notes is striking the next one.
     */
    const voices: { track: string; hz: number; volume: number; wave: number[]; duty?: number; struck?: boolean }[] = [];
    if (s.fds && !s.fds.halted && s.fds.gain > 0 && s.fds.frequency > 0) {
      const w = wavePeriods(s.fds.wave);
      voices.push({ track: 'fds', hz: fdsHz(s.fds.frequency) * w.times, volume: Math.round((s.fds.gain * 15) / 32), wave: w.wave });
    }
    if (s.n163) {
      for (const c of s.n163.active) {
        if (c.volume > 0 && c.frequency > 0) {
          const w = wavePeriods(c.wave);
          voices.push({ track: `n163_${8 - c.slot}`, hz: n163Hz(c.frequency, c.length, s.n163.channels) * w.times, volume: c.volume, wave: w.wave });
        }
      }
    }
    /*
     * The VRC6 keys a note the FDS's way: its drivers write a voice's high byte (`$x002`, which holds
     * the enable bit) once a note and leave it while the note is held — Esper Dream 2 writes `$B002`
     * once a note and the saw's rate, its envelope, every frame. The pulse's duty is its timbre, 8 for
     * the mode that puts the volume out flat; the saw's level is its rate, 42 the loudest clean one.
     */
    const vrc6Struck = vrc6Hi.map((hi, k) => hi && !vrc6HiBefore[k]);
    vrc6Hi.forEach((hi, k) => (vrc6HiBefore[k] = hi));
    if (s.vrc6 && !s.vrc6.halted) {
      s.vrc6.pulse.forEach((p, k) => {
        if (p.enabled && p.volume > 0 && p.period >> s.vrc6!.shift >= 1) {
          voices.push({ track: `vrc6_${k + 1}`, hz: vrc6PulseHz(p.period, s.vrc6!.shift), volume: p.volume, wave: [], duty: p.constant ? 8 : p.duty, struck: vrc6Struck[k] });
        }
      });
      const saw = s.vrc6.saw;
      if (saw.enabled && saw.rate >> 3 > 0 && saw.period >> s.vrc6.shift >= 1) {
        voices.push({ track: 'vrc6_saw', hz: vrc6SawHz(saw.period, s.vrc6.shift), volume: Math.round((Math.min(saw.rate, 42) * 15) / 42), wave: [], struck: vrc6Struck[2] });
      }
    }
    /*
     * The FDS has a register a driver writes when it strikes: the frequency's high byte, `$4083`.
     * The drivers here write it on a note's first frame and leave it alone while the note is held
     * (Famicom Tantei Club 2, Ai Senshi Nicol, Yuuyuuki, Dababa: on 0-10% of frames), so a write
     * after a window without one is a strike even where the gain only swells from where the last
     * note faded — FTC2's song 15 pad, struck 12+4, came out one note 96 ticks long. A driver that
     * writes it every frame tells nothing by it, and only its first write counts.
     */
    const fdsStruck = fdsHi && !fdsHiBefore;
    fdsHiBefore = fdsHi;
    for (const track of [...openX.keys()]) if (!voices.some((v) => v.track === track)) closeX(track, time);
    for (const v of voices) {
      const pitch = midiOf(v.hz);
      const waveKey = v.wave.join(',');
      const o = openX.get(v.track);
      const fresh =
        !o ||
        (v.volume - o.lastVolume >= 2 && !inAttack(o)) ||
        Math.abs(pitch - o.last) >= 0.9 ||
        waveKey !== o.waveKey ||
        (v.track === 'fds' && fdsStruck) ||
        v.struck === true;
      if (o && !fresh) {
        o.bend.push([time, pitch - o.pitch]);
        o.last = pitch;
        o.frames++;
        follow(o, v.volume, pitch);
        o.lastVolume = v.volume;
        o.levels.push([time, v.volume]);
        continue;
      }
      closeX(v.track, time);
      openX.set(v.track, {
        midi: Math.round(pitch),
        pitch,
        last: pitch,
        start: time,
        frames: 1,
        held: 1,
        volume: v.volume,
        lastVolume: v.volume,
        duty: v.duty ?? 0,
        periodIndex: 0,
        bend: [[time, 0]],
        levels: [[time, v.volume]],
        climbing: true,
        rose: false,
        sinceRise: 0,
        waveKey,
        wave: [...v.wave],
      });
    }
    restarted.forEach((written, ch) => written && (lastRestart[ch] = frame));
    pitchSet.forEach((written, ch) => (pitchSetBefore[ch] = written));
    done = next;
  }
  for (let ch = 0; ch < 4; ch++) close(ch, done / rate);
  for (let ch = 0; ch < 4; ch++) if (struckYet[ch]) found?.[ch].spans.push({ frames: heard[ch] - struckAt[ch] + 1, instrument: instrumentOf(struckNote[ch]) });
  for (const track of [...openX.keys()]) closeX(track, done / rate);
  // A0 up to MIDI's own ceiling — not a piano's C8. A pulse sounds to period 8, near 12.4 kHz:
  // Terminator 2's Level 3 rings at period 13 (about 8 kHz, MIDI 119) for twenty seconds, and its
  // arpeggios climb past C8; on the piano's range all of it was thrown away as if silent.
  // An expansion voice goes lower than any 2A03 one: the N163 plays a bass under A0 (Mappy Kids'
  // Stage Theme 2, G#0 and G0 at 26-25 Hz), and was cut off there. C0, 16 Hz, is about where a
  // tone stops being heard as one.
  return strikesOntoNotes(notes, frameHz).filter(
    (n) => n.midi >= (TRACKS.includes(n.track as (typeof TRACKS)[number]) ? 21 : 12) && n.midi <= 127
  );
}

/** The longest a triangle note can be and still be the strike of the note after it, in frames. */
const TRIANGLE_STRIKE_FRAMES = 3.5;
/** The least interval, in semitones, at which a short triangle note not falling is a strike. */
const TRIANGLE_STRIKE_INTERVAL = 5;

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
    // A plain note a few semitones off is a trill's or a run's last step, not a strike: Genpei's
    // three-frame trills came out one note bent.
    if (!strike.bend && Math.abs(strike.pitch - note.pitch) < TRIANGLE_STRIKE_INTERVAL) continue;
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
