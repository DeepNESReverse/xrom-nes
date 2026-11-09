/**
 * Notes → the workshop's /music collection format (the shape Battletoads'
 * tracks use): pitched rows and drum rows in ticks, 16 ticks to the quarter.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NOISE_PERIODS } from '@xromdev/apu';
import { CPU_HZ } from './nes.ts';
import type { DecodedNote, TimedWrite } from './decode.ts';
import type { Grid } from './grid.ts';
import { KIND_LANE, type DmcHit, type DrumKind } from './dmc.ts';

/** A DMC sample a collection carries: its bytes, where the DMC reads them, and what drum it is. */
export interface CollectedSample {
  address: number;
  bytes: number[];
  kind: DrumKind;
}

const CHANNEL = { pulse1: 0, pulse2: 1, triangle: 2 } as const;
/**
 * An expansion voice's channel in the rows: the FDS 5, the N163's `n163_k` 5 + k, the VRC6's
 * pulses `vrc6_1`/`vrc6_2` 14 and 15 and its saw 16 — `@xromdev/apu`'s `EXPANSION_CHANNELS`.
 */
const VRC6_CHANNEL: Record<string, number> = { vrc6_1: 14, vrc6_2: 15, vrc6_saw: 16 };
const expansionChannel = (track: string) =>
  track === 'fds' ? 5 : track.startsWith('n163_') ? 5 + Number(track.slice(5)) : (VRC6_CHANNEL[track] ?? -1);
/** A channel's voice name, the other way round. */
const expansionName = (channel: number) =>
  channel === 5 ? 'fds' : channel >= 14 ? Object.keys(VRC6_CHANNEL).find((name) => VRC6_CHANNEL[name] === channel)! : `n163_${channel - 5}`;

export interface TrackInfo {
  id: number;
  slug: string;
  name: string;
  source: string;
  /**
   * How the score is read — always written, even empty: a track that carries a
   * reading is never read through the workshop's Battletoads tables.
   */
  reading: {
    barOffset?: number;
    measureTicks?: number;
    mergePickup?: boolean;
    keyName?: string;
    keySignature?: string;
    keyChanges?: { tick: number; key: string }[];
    composer?: string;
    /** Straight values played swung — the tempo map carries the swing; the score says "Swing". */
    swing?: boolean;
  };
  /**
   * The pulses' sequencers run on from note to note when the high period byte is not written
   * again: a driver that writes `$4003`/`$4007` only when that byte changes (Yie Ar Kung-Fu,
   * Castlevania). Written into the track as `keepPulsePhase`, which the player passes on to
   * `@xromdev/apu`'s renderer; left out, every pulse note restarts its phase.
   */
  keepPulsePhase?: boolean;
}

export function writeCollection(
  dir: string,
  info: TrackInfo,
  notes: readonly DecodedNote[],
  seconds: number,
  grid: Grid,
  frameHz = 60.0988,
  /** The DMC's hits and the samples they play, when the music uses it. */
  dmc?: { hits: readonly DmcHit[]; samples: readonly CollectedSample[] },
  /** Where the song starts over and how long one pass is, in seconds on the notes' clock. */
  loop?: { start: number; seconds: number } | null,
  /**
   * A tempo map: from `at` seconds on, a tick lasts `secondsPerTick` — each stretch of the song
   * counted on its own grid. The first entry is at 0. Left out, the whole song is on `grid`.
   */
  tempo?: readonly { at: number; secondsPerTick: number }[]
) {
  // The workshop counts 16 ticks to the quarter: a tick is a quarter of the sixteenth.
  let spt = tempo?.length ? tempo[0].secondsPerTick : grid.sixteenthFrames / 4 / frameHz;
  /*
   * Seconds to ticks, stretch by stretch: each stretch starts on the tick the one before it ended
   * on, so a change of tempo falls on a whole tick and the ticks after it count on the new grid.
   */
  const stretches: { at: number; secondsPerTick: number; tick: number }[] = [];
  for (const [index, entry] of (tempo?.length ? tempo : [{ at: 0, secondsPerTick: spt }]).entries()) {
    const before = stretches[index - 1];
    stretches.push({
      ...entry,
      tick: before ? before.tick + Math.round((entry.at - before.at) / before.secondsPerTick) : 0,
    });
  }
  /** A moment in ticks, unrounded. */
  const exactTick = (t: number) => {
    let at = stretches[0];
    for (const stretch of stretches) if (stretch.at <= t + 1e-9) at = stretch;
    return at.tick + (t - at.at) / at.secondsPerTick;
  };
  const tick = (t: number) => Math.round(exactTick(t));
  /*
   * The tempo map as written: a stretch a later one starts on the same tick of is no stretch, and
   * one that goes on at the tempo of the one before it is no change — Captain Planet's map wrote
   * one stretch a tempo command, the same one over and over, and Adventures in the Magic Kingdom's
   * first stretch held no tick and set the track's tempo. The notes are counted as before.
   */
  const written: { tick: number; secondsPerTick: number }[] = [];
  for (const stretch of stretches) {
    const last = written[written.length - 1];
    if (last && last.tick === stretch.tick) written.pop();
    const kept = written[written.length - 1];
    if (kept && Math.abs(kept.secondsPerTick - stretch.secondsPerTick) < 1e-12) continue;
    written.push({ tick: stretch.tick, secondsPerTick: stretch.secondsPerTick });
  }
  spt = written[0].secondsPerTick;

  const bends: [number, number][][] = [];
  const bendIndex = new Map<string, number>();
  const bendOf = (n: DecodedNote) => {
    if (!n.bend) return -1;
    const curve = n.bend.map(([p, s]): [number, number] => [Number(p.toFixed(4)), Number(s.toFixed(3))]);
    const key = JSON.stringify(curve);
    if (!bendIndex.has(key)) {
      bendIndex.set(key, bends.length);
      bends.push(curve);
    }
    return bendIndex.get(key)!;
  };

  /*
   * A gap of a frame or less before the next note of the same voice is the
   * driver letting go to strike again, not a rest: Alien 3 ends every held note
   * a frame early — an A5 of 35 frames before the next at 36 — and on a tick
   * of 1.125 frames each of those was a sixty-fourth rest. The note keeps on
   * up to the next one.
   */
  // A frame and a half: the decoder's windows are whole samples, so a frame of silence measures a hair over a frame.
  const GAP = 1.5 / frameHz;
  const byTrack = new Map<string, DecodedNote[]>();
  for (const n of notes) byTrack.set(n.track, [...(byTrack.get(n.track) ?? []), n]);
  const legato: DecodedNote[] = [];
  for (const list of byTrack.values()) {
    const ordered = [...list].sort((a, b) => a.start - b.start);
    ordered.forEach((n, i) => {
      const next = ordered[i + 1];
      const gap = next ? next.start - (n.start + n.duration) : Infinity;
      legato.push(gap > 0 && gap <= GAP ? { ...n, duration: next.start - n.start } : n);
    });
  }

  /*
   * Level curves, shared like the bends: `[position 0..1, level]` at each change of level. A row
   * points at one by index in its thirteenth place (`levelIndex`); -1, or a row without one, is the
   * straight line from its start level to its end level.
   */
  const levels: [number, number][][] = [];
  const levelIndex = new Map<string, number>();
  const levelOf = (n: DecodedNote) => {
    if (!n.levels || n.duration <= 0) return -1;
    const curve = n.levels.map(([t, level]): [number, number] => [Number(Math.min(1, t / n.duration).toFixed(4)), level]);
    const key = JSON.stringify(curve);
    if (!levelIndex.has(key)) {
      levelIndex.set(key, levels.length);
      levels.push(curve);
    }
    return levelIndex.get(key)!;
  };

  /*
   * The expansion voices' waveforms, shared: a row points at one by index in its fourteenth place
   * (`waveIndex`), as `@xromdev/apu`'s `ApuInput.waves` takes them.
   */
  const waves: number[][] = [];
  const waveIndex = new Map<string, number>();
  const waveOf = (n: DecodedNote) => {
    if (!n.wave?.length) return -1;
    const key = n.wave.join(',');
    if (!waveIndex.has(key)) {
      waveIndex.set(key, waves.length);
      waves.push(n.wave);
    }
    return waveIndex.get(key)!;
  };

  const pitched: number[][] = [];
  const drums: number[][] = [];
  for (const n of legato) {
    const start = tick(n.start);
    const ticks = Math.max(1, tick(n.start + n.duration) - start);
    if (n.track === 'noise') {
      const level = levelOf(n);
      drums.push([n.periodIndex, start, ticks, n.volume, n.volumeEnd, 0, -1, ...(level >= 0 ? [level] : [])]);
      continue;
    }
    const hz = 440 * 2 ** ((n.pitch - 69) / 12);
    const xch = expansionChannel(n.track);
    if (xch >= 0) {
      // On an expansion voice the period field is the frequency in hundredths of a hertz; a VRC6
      // pulse keeps its duty, 0..7, or 8 for the mode bit (the volume put out flat).
      const level = levelOf(n);
      const duty = xch === 14 || xch === 15 ? n.duty : 0;
      pitched.push([n.midi, start, ticks, xch, n.volume, Math.round(hz * 100), duty, n.volumeEnd, 0, bendOf(n), -1, -1, level, waveOf(n)]);
      continue;
    }
    const ch = CHANNEL[n.track as keyof typeof CHANNEL];
    const period = Math.round(CPU_HZ / ((ch === 2 ? 32 : 16) * hz) - 1);
    const level = ch === 2 ? -1 : levelOf(n);
    pitched.push([
      n.midi, start, ticks, ch, ch === 2 ? 12 : n.volume, period, n.duty, ch === 2 ? 12 : n.volumeEnd, 0, bendOf(n), -1,
      ...(level >= 0 ? [-1, level] : []),
    ]);
  }
  pitched.sort((a, b) => a[1] - b[1] || a[3] - b[3]);
  drums.sort((a, b) => a[1] - b[1]);
  const voices = [...new Set(pitched.map((r) => r[3]))];
  // Every note a shared tick takes is counted, whatever its length: a splinter that goes is a note gone too.
  const lost = { pitched: 0, drums: 0, same: 0 };
  const voiced = voices.flatMap((ch) => oneAtATime(pitched.filter((r) => r[3] === ch), lost, 'pitched'));
  voiced.sort((a, b) => a[1] - b[1] || a[3] - b[3]);
  pitched.length = 0;
  pitched.push(...voiced);
  const hits = oneAtATime(drums, lost, 'drums');
  drums.length = 0;
  drums.push(...hits);

  /*
   * A pass of the loop is a whole number of ticks, its length rounded once — not its two ends each
   * on their own: on a tick of 2 frames Fester's Quest's 2256 frames came out 1127 ticks for 1128.
   * Across a change of tempo the ends are where notes there would be, each on the tick its stretch
   * rounded onto. Whichever of the two is whole bars, where only one is, is taken (rules 7 and 18):
   * Gun Sight's 1152 frames came out 767 ticks for 768, and TaleSpin's given 1728 would be 1729.
   * A length of a whole number and a half ticks goes down (below).
   */
  const stretchOf = (t: number) => stretches.filter((stretch) => stretch.at <= t + 1e-9).length;
  const bar = info.reading.measureTicks ?? 64;
  const loopTicks = (() => {
    if (!loop) return null;
    const start = tick(loop.start);
    // Half a tick over a whole number of frames is a frame of restart on ticks of two frames, not
    // half a tick of music (rule 18): Just Breed's Boss repeats every 2881 frames, 1440 ticks of rows
    // and the restart. A pass of a fractional number of frames — a tempo counter's, TaleSpin's
    // 2172.5 on ticks of a frame — rounds as it did.
    const exact = exactTick(loop.start + loop.seconds) - exactTick(loop.start);
    const frames = loop.seconds * frameHz;
    const restart = Math.abs(frames - Math.round(frames)) < 1e-6 && Math.abs(exact - Math.floor(exact) - 0.5) < 1e-6;
    const once = restart ? Math.floor(exact) : Math.round(exact);
    const ends = tick(loop.start + loop.seconds) - start;
    const same = stretchOf(loop.start) === stretchOf(loop.start + loop.seconds);
    const whole = [once, ends].filter((ticks) => ticks % bar === 0);
    return { start, ticks: whole.length === 1 ? whole[0] : same ? once : ends };
  })();
  /*
   * A song that does not loop ends with its last sound: Marble Madness' Game Over strikes a G#5 for
   * one frame on the last frame it plays, and on ticks of two frames the note's start and the song's
   * end both rounded onto tick 154 — written as the song's length, it left the note out. The end
   * goes a tick past the last start, no further: an end rounded past the song's is cut back to it.
   */
  let lastSound = 0;
  if (!loopTicks) {
    for (const row of [...pitched, ...drums]) lastSound = Math.max(lastSound, row[1] + 1);
    for (const hit of dmc?.hits ?? []) if (hit.start < seconds) lastSound = Math.max(lastSound, tick(hit.start) + 1);
  }
  const totalTicks = loopTicks
    ? Math.abs(loopTicks.start + loopTicks.ticks - tick(seconds)) <= 2
      ? loopTicks.start + loopTicks.ticks
      : tick(seconds)
    : Math.max(tick(seconds), lastSound);
  /*
   * Nothing starts on or past the end: a note of the next pass a hair before the loop's end rounded
   * onto `totalTicks` and was written a tick long after the song — Cowboy Kid's Storehouse, three
   * notes and a drum on tick 1024 of 1024. What runs past the end is cut there.
   */
  const inside = (rows: number[][]) => {
    const kept = rows.filter((row) => row[1] < totalTicks);
    for (const row of kept) row[2] = Math.max(1, Math.min(row[2], totalTicks - row[1]));
    rows.length = 0;
    rows.push(...kept);
  };
  inside(pitched);
  inside(drums);
  // Nor does the tempo map run on past it: the recording's later passes changed tempo on ticks
  // 2404 and 2692 of Final Fantasy II's Imperial Army Theme, a track of 1380.
  while (written.length > 1 && written[written.length - 1].tick >= totalTicks) written.pop();
  const events = (ch: number) => (ch === 3 ? drums.length : pitched.filter((r) => r[3] === ch).length);
  const bpm = Number(grid.bpm.toFixed(2));
  const track = {
    id: info.id,
    name: info.name,
    musicSpeed: 256,
    bpm,
    secondsPerTick: spt,
    ...(written.length > 1
      ? { tempo: written }
      : {}),
    totalTicks,
    seconds,
    loop: loopTicks,
    reading: info.reading,
    rom: { start: 0, end: 0 },
    bends,
    ...(levels.length ? { levels } : {}),
    ...(waves.length ? { waves } : {}),
    channels: [
      ...['pulse1', 'pulse2', 'triangle', 'noise'].map((name, channel) => ({ name, channel })),
      ...voices.filter((ch) => ch >= 5).sort((a, b) => a - b).map((channel) => ({ name: expansionName(channel), channel })),
    ].map(({ name, channel }) => ({
      channel,
      name,
      address: 0x8000,
      rom: 0,
      romEnd: 0,
      events: events(channel),
      totalTicks,
      endReason: 'recorded',
      trace: [],
    })),
    ...(info.keepPulsePhase ? { keepPulsePhase: true } : {}),
    pitched,
    drums,
    ...(dmc && dmc.hits.length
      ? {
          /** `[sampleIndex, tick, ticks, rate, loop, level]` — samples struck on the DMC (`SampleRow`). */
          hits: dmc.hits
            .map((hit) => {
              const index = dmc.samples.findIndex((sample) => sample.address === hit.address && sample.bytes.length === hit.length);
              const start = tick(hit.start);
              return [index, start, Math.max(1, Math.min(tick(hit.start + hit.duration), totalTicks) - start), hit.rate, hit.loop ? 1 : 0, hit.level];
            })
            .filter((row) => row[0] >= 0 && row[1] < totalTicks),
          /** The samples, each with the noise rate whose line its drum stands on. */
          samples: dmc.samples.map((sample) => ({ ...sample, lane: KIND_LANE[sample.kind] })),
        }
      : {}),
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${info.slug}.json`), JSON.stringify(track));
  const indexPath = join(dir, 'index.json');
  const index = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf8'))
    : { apu: { cpuHz: CPU_HZ, noisePeriods: [...NOISE_PERIODS] }, rom: null, source: info.source, tracks: [] };
  // The source is this run's: a collection rebuilt from another rip kept the first one's (Toxic Crusaders).
  index.source = info.source;
  index.tracks = index.tracks.filter((t: { id: number }) => t.id !== info.id);
  index.tracks.push({ id: info.id, slug: info.slug, name: info.name, reading: info.reading, musicSpeed: 256, bpm, seconds, events: pitched.length + drums.length });
  index.tracks.sort((a: { id: number }, b: { id: number }) => a.id - b.id);
  writeFileSync(indexPath, JSON.stringify(index, null, 1));
  // A DMC hit whose sample's bytes were not read is not written either: counted with the rest.
  const unread = dmc ? dmc.hits.filter((hit) => !dmc.samples.some((sample) => sample.address === hit.address && sample.bytes.length === hit.length)).length : 0;
  /**
   * `lost`: notes (and drum hits) another of their voice's took the tick of — not in the rows;
   * `merged`: pieces of the same pitch (or noise) that met their note on its tick; `unread`: DMC hits left out.
   */
  return { pitched: pitched.length, drums: drums.length, bends: bends.length, lost: lost.pitched + lost.drums, lostDrums: lost.drums, merged: lost.same, unread };
}

/** Notes of the pulses that change pitch, no restart written, before the song is said to keep their phase. */
const KEEP_PHASE_EVIDENCE = 4;
/**
 * Whether the driver lets the pulses' sequencers run on from note to note: a write of `$4003` or
 * `$4007` restarts the channel's phase on the chip, and a driver that writes it only when the high
 * byte of the period changes (Yie Ar Kung-Fu, Castlevania, Contra) never restarts a note it slides
 * into. Played with a restart on every note, two pulses in unison or an octave apart start each note
 * in step and dip where they cancel; the chip's drift past each other does not.
 *
 * Read off the song's own writes, from its first sound to its end: no write on either pulse that
 * repeats the high byte the channel already holds while a note of it is sounding — a driver that
 * strikes with the write repeats it all the time, on every two notes in one octave — and at least
 * `KEEP_PHASE_EVIDENCE` steady notes (3 frames or more) that change pitch without a write, on the
 * same high byte: the proof the driver leaves it alone. A rewrite after a rest says nothing (a
 * driver may restart a note it strikes from silence; the phase matters where notes run into each
 * other), so a song of a few notes, or of notes that never share a high byte, is left as it was.
 */
export function pulsePhaseKept(writes: readonly TimedWrite[], notes: readonly DecodedNote[], from: number, until: number, hz: number) {
  const frame = 1 / hz;
  let repeats = 0;
  let evidence = 0;
  for (const [track, address] of [['pulse1', 0x4003], ['pulse2', 0x4007]] as const) {
    const voice = notes.filter((n) => n.track === track && n.start >= from - frame && n.start < until).sort((a, b) => a.start - b.start);
    const sounding = (t: number) => voice.some((n) => n.start < t - 0.5 * frame && n.start + n.duration > t - 1.5 * frame);
    const restarts = writes.filter((w) => w.address === address);
    let held = -1;
    let lastFrame = NaN;
    const highAt: [number, number][] = [];
    for (const w of restarts) {
      const at = Math.floor(w.time * hz + 1e-6);
      if (w.time >= from - frame && w.time < until && at !== lastFrame && (w.value & 7) === held && sounding(w.time)) repeats++;
      held = w.value & 7;
      lastFrame = at;
      highAt.push([w.time, held]);
    }
    const highOf = (t: number) => {
      let value = -1;
      for (const [time, high] of highAt) if (time <= t + 1e-9) value = high;
      return value;
    };
    const steady = voice.filter((n) => n.duration * hz >= 3);
    for (let i = 1; i < steady.length; i++) {
      const [a, b] = [steady[i - 1], steady[i]];
      if (a.midi === b.midi || b.start - (a.start + a.duration) > 1.5 * frame) continue;
      const written = restarts.some((w) => Math.abs(w.time - b.start) <= frame);
      if (!written && highOf(a.start + frame) === highOf(b.start + frame) && highOf(b.start + frame) >= 0) evidence++;
    }
  }
  return { keep: repeats === 0 && evidence >= KEEP_PHASE_EVIDENCE, repeats, evidence };
}

/**
 * A track taken out of a collection — a song this run skips (silent, an effect) whose file a run
 * before left behind: Atlantis no Nazo's folder held 20 files for 13 songs.
 */
export function removeTrack(dir: string, id: number, slug: string): boolean {
  const indexPath = join(dir, 'index.json');
  let removed = false;
  if (existsSync(join(dir, `${slug}.json`))) {
    rmSync(join(dir, `${slug}.json`));
    removed = true;
  }
  if (existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const kept = index.tracks.filter((t: { id: number }) => t.id !== id);
    if (kept.length !== index.tracks.length) {
      index.tracks = kept;
      writeFileSync(indexPath, JSON.stringify(index, null, 1));
      removed = true;
    }
  }
  return removed;
}

/**
 * One voice, one note at a time, on the tick grid.
 *
 * Rounding to ticks can land two notes of one voice on the same tick — a
 * frame-long splinter before the real note, or two quick arpeggio steps — and
 * a voice's notes can overlap by a tick. The roll draws them by time and does
 * not mind; the score writes a voice's notes one after another, so every such
 * pair added a beat, and Alien 3's score ran a whole bar ahead of the sound by
 * bar 24. Here the longest note of a tick stays (the real one, not the
 * splinter), and each note ends where the next begins. Each note dropped is
 * counted in `lost`: the caller says how many, so none goes without a word.
 */
function oneAtATime(rows: number[][], lost?: Record<'pitched' | 'drums' | 'same', number>, kind: 'pitched' | 'drums' = 'pitched'): number[][] {
  const out: number[][] = [];
  // A row's key (its pitch, a drum's noise period) and level: of two as long, the louder stays —
  // Mitsume ga Tooru's Stage 5-2 kept a quiet one-tick echo for a D#2 the bass struck on its tick.
  const [key, level] = kind === 'pitched' ? [0, 4] : [0, 3];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last[1] === row[1]) {
      const same = row[key] === last[key];
      // Of one pitch too: Bonk's Adventure's kick struck at 15 on the tick of the last one's tail at 2.
      if (row[2] > last[2] || (row[2] === last[2] && row[level] > last[level])) out[out.length - 1] = row;
      // A piece of the same pitch on the note's own tick — an attack's frames, a re-strike inside a
      // tick of the driver — is the note, not a note lost: counted apart (Tetris 2's 235 "lost").
      if (lost) lost[same ? 'same' : kind]++;
      continue;
    }
    if (last && last[1] + last[2] > row[1]) last[2] = row[1] - last[1];
    out.push(row);
  }
  return out;
}
