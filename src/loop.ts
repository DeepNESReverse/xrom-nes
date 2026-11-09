/**
 * Where a song starts over — found in what the driver writes, not guessed.
 *
 * The driver is a program on a deterministic machine: once it is back where it
 * was, everything after repeats write for write. So the writes are cut into
 * frames (one PLAY each), each frame hashed — addresses and values in order,
 * not their times inside the frame — and the shortest period P is looked for
 * whose tail repeats: frame t equal to frame t + P from some frame on to the
 * end of the recording. The first frame of that tail is where the loop begins;
 * what comes before it is the intro, played once.
 *
 * Not RAM: a driver that counts frames somewhere never comes back to the same
 * memory, while its writes do.
 *
 * Not $4011 either: Super Mario Bros. walks the DAC down 2, 1, 0 over its first
 * 48 frames — easing it to rest without a click — and that alone made the
 * loop of every song begin 0.8 s in. The DMC's hits are in $4012/$4013/$4015.
 *
 * Some drivers never repeat exactly, and for those the notes are compared
 * instead (`findNoteLoop`).
 */

import type { DecodedNote, TimedWrite } from './decode.ts';

export interface Loop {
  /** Seconds from INIT to the first frame the repeat comes back to. */
  start: number;
  /** Seconds one pass of the loop takes. */
  seconds: number;
  /** False when the loop was found in the notes: the writes repeat only nearly. */
  exact: boolean;
}

/** One 32-bit hash per frame of what the driver wrote in it; 0 for a frame it wrote nothing in. */
export function frameHashes(writes: readonly TimedWrite[], frameHz: number, frames: number): Uint32Array {
  const hashes = new Uint32Array(frames);
  for (const w of writes) {
    if (w.address === 0x4011) continue;
    const f = Math.floor(w.time * frameHz + 1e-6);
    if (f < 0 || f >= frames) continue;
    let h = hashes[f] || 0x811c9dc5;
    h = Math.imul(h ^ (w.address & 0xff), 0x01000193);
    h = Math.imul(h ^ (w.address >> 8), 0x01000193);
    h = Math.imul(h ^ w.value, 0x01000193);
    hashes[f] = h >>> 0 || 1;
  }
  return hashes;
}

/**
 * The shortest loop of at least `minSeconds` whose tail, from its start to the
 * end of `recorded` seconds, repeats frame for frame at least twice over — or null.
 * The tail must begin in the recording's first half: Terminator 2's song 5 found
 * a 3.2-second riff at second 989 of 1000, played three times, and nothing else.
 *
 * `sounds(fromSecond, toSecond)` says whether a note begins inside a span: a
 * song that has ended writes the same nothing every frame, and that is no loop.
 */
export function findLoop(
  writes: readonly TimedWrite[],
  frameHz: number,
  recorded: number,
  sounds: (from: number, to: number) => boolean,
  minSeconds = 1
): Loop | null {
  const n = Math.floor(recorded * frameHz);
  const h = frameHashes(writes, frameHz, n);
  const minFrames = Math.max(2, Math.round(minSeconds * frameHz));
  for (let p = minFrames; p * 2 <= n; p++) {
    // Walk back from the end while frame t matches frame t − P.
    let t = n - 1;
    while (t - p >= 0 && h[t] === h[t - p]) t--;
    const start = t - p + 1;
    // A riff played three times over at the end of the recording is no loop: the song's starts early.
    if (n - start < 2 * p || start > n / 2) continue;
    const at = start / frameHz;
    if (!sounds(at, at + p / frameHz)) continue;
    return { start: at, seconds: p / frameHz, exact: true };
  }
  return null;
}

/** Of the last `WINDOW` notes walked back over, `DENSE` without a twin end the tail. */
const WINDOW = 12;
const DENSE = 4;
/** Notes that may lack a twin in all, as a share of the tail. */
const STRAY = 0.02;

/**
 * The shortest loop in the notes: each note of the tail has a twin — same voice,
 * same key — one period earlier, to within a frame and a half.
 *
 * For a driver whose writes never come back exactly. Darkwing Duck keeps its
 * tempo with a fractional counter, so a pass is not a whole number of frames
 * and each lands some rows a frame later than the last; and its envelopes run
 * on their own phase, so a pass here and there writes a level one lower
 * ($4004 $B3 for $B4) or lets the triangle go a frame sooner. Compared frame
 * for frame, nearly every multiple of a phrase matched 91–98% and the shortest
 * that passed was not the loop; the notes do not care about either. A stray
 * note may lack its twin; the tail ends where they lack it thickly — `DENSE`
 * of the last `WINDOW` — which is where the intro is other music.
 */
export function findNoteLoop(
  notes: readonly DecodedNote[],
  frameHz: number,
  recorded: number,
  minSeconds = 1
): Loop | null {
  const tolerance = 1.5 / frameHz;
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return null;
  const keyOf = (x: DecodedNote) => `${x.track}:${x.track === 'noise' ? x.periodIndex : x.midi}`;
  const keys = sorted.map(keyOf);
  const byKey = new Map<string, number[]>();
  sorted.forEach((x, i) => {
    if (!byKey.has(keys[i])) byKey.set(keys[i], []);
    byKey.get(keys[i])!.push(x.start);
  });
  const twin = (i: number, p: number) => {
    const list = byKey.get(keys[i])!;
    const want = sorted[i].start - p;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < want - tolerance) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length && list[lo] <= want + tolerance;
  };
  const last = sorted.length - 1;
  const step = 1 / frameHz;
  // A song that ends has its last note long before the recording does; a loop plays to the end.
  const from = Math.max(minSeconds, 2 * step, recorded - sorted[last].start);
  for (let p = from; p * 2 <= recorded; p += step) {
    // Walk back from the last note while notes have their twins a period earlier.
    const misses: number[] = [];
    let strays = 0;
    let first = -1;
    for (let i = last; i >= 0 && sorted[i].start - p >= -tolerance; i--) {
      if (twin(i, p)) continue;
      misses.push(i);
      strays++;
      while (misses[0] - i >= WINDOW) misses.shift();
      if (misses.length >= DENSE) {
        first = misses[0] + 1;
        break;
      }
    }
    if (first > last) continue;
    // The tail's first note is the loop's first note come round again; no break, and it is the song's.
    const start = first < 0 ? sorted[0].start : Math.max(0, sorted[first].start - p);
    if (first < 0) first = 0;
    if (recorded - start < 2 * p || start > recorded / 2 || strays > STRAY * (last - first + 1)) continue;
    return { start, seconds: p, exact: false };
  }
  return null;
}

/** A note this many frames long or shorter is a splinter — a driver's restart frame, an arpeggio's step — not compared. */
const SPLINTER = 1.5;

/**
 * Whether a note has a twin — same voice, same key — `period` seconds away (earlier for a
 * negative `period`), to within `tolerance` seconds.
 *
 * `held`: or the twin's place is inside a note the decoder joined it to, one of the same key that
 * began before and is struck again there, its level climbing. One pass's writes may differ where its notes do not, and a
 * re-strike without a restart write is joined to the note before it in one pass and not in the
 * next: Toukon Club's General Gegebben strikes its A3 a row after the last at level 2 → 8 in the
 * first pass and comes out one 15-frame note in the second. On the noise another drum will do, begun
 * at most three frames before — a sweep is one row with the first rate it struck (Indiana Jones'
 * Rescuing Dad, 2 frames before the bar line), a hit a frame after a tail is joined to the tail
 * (Ninja Gaiden II's Unlimited Moment) — but no more: a decay held on covers the places of the hits
 * after it, and Fire Emblem Gaiden's Celica 1 slid into a drum roll by those.
 */
function twins(notes: readonly DecodedNote[]) {
  const keyOf = (x: DecodedNote) => `${x.track}:${x.track === 'noise' ? x.periodIndex : x.midi}`;
  const heldKeyOf = (x: DecodedNote) => (x.track === 'noise' ? 'noise' : keyOf(x));
  const byKey = new Map<string, number[]>();
  for (const x of notes) (byKey.get(keyOf(x)) ?? byKey.set(keyOf(x), []).get(keyOf(x))!).push(x.start);
  for (const list of byKey.values()) list.sort((a, b) => a - b);
  const spans = new Map<string, DecodedNote[]>();
  for (const x of notes) (spans.get(heldKeyOf(x)) ?? spans.set(heldKeyOf(x), []).get(heldKeyOf(x))!).push(x);
  for (const list of spans.values()) list.sort((a, b) => a.start - b.start);
  /** How far the nearest twin is from where it should be, or Infinity beyond `tolerance`. */
  const offset = (x: DecodedNote, period: number, tolerance: number) => {
    const list = byKey.get(keyOf(x))!;
    const want = x.start + period;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < want - tolerance) lo = mid + 1;
      else hi = mid;
    }
    let near = Infinity;
    for (let i = lo; i < list.length && list[i] <= want + tolerance; i++) near = Math.min(near, Math.abs(list[i] - want));
    return near;
  };
  /** Whether a note joined to an earlier one is struck again inside it where its twin would start. */
  const inside = (x: DecodedNote, period: number, tolerance: number) => {
    const list = spans.get(heldKeyOf(x))!;
    const want = x.start + period;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start < want) lo = mid + 1;
      else hi = mid;
    }
    // Notes of one voice and key do not overlap: the last to begin before is the one that may still sound.
    const held = list[lo - 1];
    if (!held || held.start + held.duration <= want + tolerance) return false;
    // Another drum begun a frame or three before, which the hit was joined to: a long decay covers
    // the next hits' places, and the same drum a frame or two early is a hit of its own, not a join
    // (Wai Wai World's intro roll, 2 frames off the loop's).
    if (x.track === 'noise') return held.start >= want - 2 * tolerance && held.periodIndex !== x.periodIndex;
    // A pitch, struck again there: its level climbs where the twin would start. A longer note
    // where the other pass has two is another rhythm, not a re-strike joined.
    const levels = held.levels ?? [];
    return levels.some(([at, level], i) => i > 0 && level > levels[i - 1][1] && Math.abs(held.start + at - want) <= tolerance);
  };
  const twin = (x: DecodedNote, period: number, tolerance: number) => offset(x, period, tolerance) <= tolerance;
  return Object.assign(twin, { offset, held: (x: DecodedNote, period: number, tolerance: number) => twin(x, period, tolerance) || inside(x, period, tolerance) });
}

/**
 * Whether the notes from `start` on repeat every `period` seconds: each one but a splinter, a
 * period or more after `start`, has its twin a period earlier, to within a frame and a half.
 * No stray is allowed — a pass that differs in one note is not the same pass, and writing one
 * pass of a shorter period would drop that note.
 */
export function notesRepeat(notes: readonly DecodedNote[], frameHz: number, start: number, period: number): boolean {
  const twin = twins(notes);
  const tolerance = 1.5 / frameHz;
  let compared = 0;
  for (const x of notes) {
    if (x.start < start + period - tolerance || x.duration * frameHz <= SPLINTER) continue;
    if (!twin(x, -period, tolerance)) return false;
    compared++;
  }
  return compared > 0;
}

/**
 * A loop found in the writes, made the music's:
 *
 * - The smallest period whose notes repeat. A driver whose tempo counter is fractional, or whose
 *   tremolo or vibrato runs on a counter of its own, comes back to the same writes only after a
 *   few passes of the music: Moon Crystal's every 4 to 8, Panic Restaurant's 5, Tetris's 4.
 *   Each P/m is tried, the largest m first, on the notes.
 * - A frame of restart left out: a driver that takes a frame to start the song over plays each
 *   pass a frame longer than its music. Metroid's Tourian repeats every 769 frames, its notes on
 *   rows of 6 — 128 bars of 6 frames and the frame of the restart, a splinter of the next pass's
 *   first note. A period one frame over a whole number of `rowFrames` (≥ 3) is taken a frame shorter.
 * - The start slid back while the notes before it repeat too: the writes of the first pass can
 *   differ where the notes do not (INIT's own writes at frame 0 put Zelda II's loops at frame 1;
 *   New York Nyankies' at 1089 for the bar line at 1024). The start goes back to the earliest
 *   note from which every note has its twin a period later.
 */
export function musicLoop(loop: Loop, notes: readonly DecodedNote[], frameHz: number, rowFrames = 0, minSeconds = 1): Loop & { passes?: number; restart?: boolean } {
  let { start, seconds } = loop;
  let passes: number | undefined;
  let restart = false;
  const frames = Math.round(seconds * frameHz);
  if (loop.exact) {
    for (let m = Math.floor(seconds / minSeconds); m >= 2; m--) {
      if (notesRepeat(notes, frameHz, start, seconds / m)) {
        passes = m;
        seconds /= m;
        break;
      }
    }
    if (passes === undefined && rowFrames >= 3 && frames % rowFrames === 1) {
      seconds = (frames - 1) / frameHz;
      restart = true;
    }
  }
  const twin = twins(notes);
  const tolerance = 1.5 / frameHz;
  const half = 0.5 / frameHz;
  /*
   * A loop found in the notes is the shortest period they match at to within a frame and a half —
   * a frame short of the true one as often as not (Rolling Thunder's 8063 for 8064): the period
   * near it that the notes match at most closely is taken, in half frames.
   */
  if (!loop.exact) {
    const tail = notes.filter((x) => x.start >= start + seconds - tolerance && x.duration * frameHz > SPLINTER);
    const misfit = (period: number) => {
      let sum = 0;
      for (const x of tail) sum += Math.min(tolerance, twin.offset(x, -period, tolerance));
      return sum;
    };
    let best = seconds;
    let bestFit = misfit(seconds);
    for (let step = -2; step <= 4; step++) {
      const period = seconds + (step * half);
      const fit = misfit(period);
      if (fit < bestFit - 1e-9) [best, bestFit] = [period, fit];
    }
    seconds = best;
  }
  const counted = notes.filter((x) => x.duration * frameHz > SPLINTER);
  /*
   * Walk back from the start while the notes before it have their twins a period later — and the
   * notes a period later theirs before it, both ways: an intro of the tune without its drums
   * matches note for note one way only, and sliding into it would loop the tune without drums.
   * The latest note either way that has no twin stops it — a twin the decoder joined to the note
   * before it in one pass (`twins`' `held`) is there.
   */
  const latestMiss = (from: number) => {
    let miss = -Infinity;
    for (const x of counted) {
      if (x.start >= from - half && x.start < start - half && x.start > miss && !twin.held(x, seconds, tolerance)) miss = x.start;
      const back = x.start - seconds;
      if (back >= from - half && back < start - half && back > miss && !twin.held(x, -seconds, tolerance)) miss = back;
    }
    return miss;
  };
  const earliest = notes.reduce((least, x) => Math.min(least, x.start), Infinity);
  /*
   * Nor only the notes' starts: what sounds, frame by frame, must sound a period later — a note held
   * across the start, a note of another length (`soundingAt`). RoadBlasters' Course Select slid back
   * to frame 49, where the intro's A3 on the triangle and pulse 2 still sounds and a pass later their
   * A4 and C♯4 do; Flipull's Ending Credit through a triangle C of 6 frames that is 3 a pass later;
   * Metal Fighter's Main BGM to frame 0, its first pass's pulse 1 notes 15 frames where every later
   * pass holds them 20 to 80 — the driver's restart leaves the instrument as the pass before set it,
   * and the writes repeat only from frame 313.
   */
  const slack = (loop.exact ? 1 : SPLINTER) / frameHz;
  const sound = soundingAt(notes, frameHz);
  const miss = Math.max(latestMiss(earliest), sound.latestMiss(earliest, start, seconds, slack));
  const back = counted.filter((x) => x.start > miss + half && x.start < start - half);
  if (back.length > 0) start = back.reduce((least, x) => Math.min(least, x.start), Infinity);
  /*
   * And a note held across the start must go on as it does a period later — the writes after the
   * start repeat, but not the registers set before it: Spelunker II's Boss repeats its writes from
   * frame 873, where a C♯3 struck at 872 still sounds and a pass later an E3 struck at 1384 does, up
   * to 880. The start goes on to the first note after such a note.
   */
  for (let step = 0; step < 8; step++) {
    const until = sound.heldOtherwise(start, seconds, slack);
    if (until === null) break;
    const next = counted.reduce((least, x) => (x.start >= until - half && x.start < least ? x.start : least), Infinity);
    start = Number.isFinite(next) ? next : until;
  }
  return { start, seconds, exact: loop.exact && passes === undefined && !restart, ...(passes ? { passes } : {}), ...(restart ? { restart } : {}) };
}

/**
 * What the pitched voices sound, frame by frame (the noise left out: a drum's tail is joined to the
 * next hit in one pass and not in the next, and `twins` judges it by its starts), for comparing a
 * stretch with the one a period later: in each voice the same key or none, to within `slack` seconds
 * either way. Splinters are not counted.
 */
function soundingAt(notes: readonly DecodedNote[], frameHz: number) {
  const byVoice = new Map<string, DecodedNote[]>();
  for (const x of notes) {
    if (x.track === 'noise' || x.duration * frameHz <= SPLINTER) continue;
    (byVoice.get(x.track) ?? byVoice.set(x.track, []).get(x.track)!).push(x);
  }
  for (const list of byVoice.values()) list.sort((a, b) => a.start - b.start);
  const at = (list: readonly DecodedNote[], t: number) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start <= t) lo = mid + 1;
      else hi = mid;
    }
    const x = list[lo - 1];
    return x && x.start + x.duration > t ? x : null;
  };
  const first = notes.reduce((least, x) => Math.min(least, x.start), Infinity);
  /*
   * Whether the voice sounds at `t` as it does at `u`, give or take `slack`, in half frames: the same
   * key or none. Not the level: a pass's envelopes may run on their own phase, and INIT may leave an
   * instrument louder than a restart does (Q Boy's Stage 4-1 holds its first note at 15 where every
   * later pass decays to 11) — the notes are the same. Nor a note of the pass before held on over
   * the restart where the song began in silence: The Untouchables' and Ghost Lion's echoes of their
   * last notes run a few frames into every pass but the first.
   */
  const same = (list: readonly DecodedNote[], t: number, u: number, slack: number) => {
    const a = at(list, t);
    const step = 0.5 / frameHz;
    for (let d = -slack; d <= slack + 1e-9; d += step) {
      const b = at(list, u + d);
      if (!a && (!b || b.start < first + (u - t) - 0.5 / frameHz)) return true;
      if (a && b && a.midi === b.midi) return true;
    }
    return false;
  };
  /*
   * A frame that differs alone is no difference: a driver's first frame (Q Boy strikes its triangle
   * two frames early at INIT, and on time in every pass after).
   */
  const differs = (list: readonly DecodedNote[], t: number, period: number, slack: number) =>
    !same(list, t, t + period, slack) && [-1, 1].some((k) => !same(list, t + k / frameHz, t + k / frameHz + period, slack));
  // Sampled mid-frame, on the frames the notes start on (the decoder's windows).
  const phase = Number.isFinite(first) ? first * frameHz - Math.floor(first * frameHz) : 0;
  const frameAt = (f: number) => (f + phase + 0.5) / frameHz;
  return {
    /**
     * The start of the latest frame in `[from, to)` whose sound differs a period later — or of a note
     * begun before `to` that differs after it — or −∞.
     */
    latestMiss(from: number, to: number, period: number, slack: number) {
      let miss = -Infinity;
      for (const list of byVoice.values()) {
        const x = at(list, to);
        if (!x || x.start >= to - 0.5 / frameHz) continue;
        for (let f = Math.ceil(to * frameHz - phase - 0.5); frameAt(f) < x.start + x.duration; f++) {
          if (differs(list, frameAt(f), period, slack)) {
            miss = Math.max(miss, x.start);
            break;
          }
        }
      }
      for (let f = Math.ceil(to * frameHz - phase - 0.5) - 1; frameAt(f) >= from && frameAt(f) - 0.5 / frameHz > miss; f--) {
        const t = frameAt(f);
        if (t >= to) continue;
        for (const list of byVoice.values()) if (differs(list, t, period, slack)) return Math.max(miss, t - 0.5 / frameHz);
      }
      return miss;
    },
    /** The end of the last note held across `start` that sounds otherwise a period later, or null. */
    heldOtherwise(start: number, period: number, slack: number): number | null {
      let until: number | null = null;
      for (const list of byVoice.values()) {
        const x = at(list, start);
        if (!x || x.start >= start - 0.5 / frameHz || x.start + x.duration <= start + 0.5 / frameHz) continue;
        const end = x.start + x.duration;
        for (let f = Math.ceil(start * frameHz - phase - 0.5); frameAt(f) < end; f++) {
          if (differs(list, frameAt(f), period, slack)) {
            until = Math.max(until ?? -Infinity, end);
            break;
          }
        }
      }
      return until;
    },
  };
}

/** The registers of a 2A03 voice, for a loop looked for without it. */
const VOICE_REGISTERS: Record<string, [number, number]> = {
  pulse1: [0x4000, 0x4003],
  pulse2: [0x4004, 0x4007],
  triangle: [0x4008, 0x400b],
  noise: [0x400c, 0x400f],
};

/**
 * A loop of all the voices but one, when all of them together do not loop within the recording:
 * a voice with a loop of its own length — Tetris' noise, Rolling Thunder's wood block on the N163,
 * River City Ransom's drums — comes round with the others only after many passes. Each voice is
 * left out in turn, the writes of its registers with it (and $4015, which every voice shares);
 * of the loops the rest make the longest is taken — the voice left out for it is the one that
 * goes round on its own, a short ostinato, not the tune — with the voice that was left out.
 */
export function loopWithoutVoice(
  writes: readonly TimedWrite[],
  notes: readonly DecodedNote[],
  frameHz: number,
  recorded: number
): (Loop & { without: string }) | null {
  let best: (Loop & { without: string }) | null = null;
  const voices = [...new Set(notes.map((x) => x.track))];
  if (voices.length < 2) return null;
  for (const voice of voices) {
    const rest = notes.filter((x) => x.track !== voice);
    const starts = rest.map((x) => x.start);
    const range = VOICE_REGISTERS[voice];
    const found = range
      ? findLoop(
          writes.filter((w) => w.address !== 0x4015 && (w.address < range[0] || w.address > range[1])),
          frameHz,
          recorded,
          (a, b) => starts.some((t) => t >= a && t < b)
        )
      : null;
    const loop = found ?? findNoteLoop(rest, frameHz, recorded);
    if (!loop) continue;
    if (!best || loop.seconds > best.seconds + 0.5 / frameHz || (Math.abs(loop.seconds - best.seconds) <= 0.5 / frameHz && loop.start < best.start))
      best = { ...loop, without: voice };
  }
  return best;
}
