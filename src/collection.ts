/**
 * Notes → the workshop's /music collection format (the shape Battletoads'
 * tracks use): pitched rows and drum rows in ticks, 16 ticks to the quarter.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NOISE_PERIODS } from '@xromdev/apu';
import { CPU_HZ } from './nes.ts';
import type { DecodedNote } from './decode.ts';
import type { Grid } from './grid.ts';
import { KIND_LANE, type DmcHit, type DrumKind } from './dmc.ts';

/** A DMC sample a collection carries: its bytes, where the DMC reads them, and what drum it is. */
export interface CollectedSample {
  address: number;
  bytes: number[];
  kind: DrumKind;
}

const CHANNEL = { pulse1: 0, pulse2: 1, triangle: 2 } as const;

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
  };
}

export function writeCollection(
  dir: string,
  info: TrackInfo,
  notes: readonly DecodedNote[],
  seconds: number,
  grid: Grid,
  frameHz = 60.0988,
  /** The DMC's hits and the samples they play, when the music uses it. */
  dmc?: { hits: readonly DmcHit[]; samples: readonly CollectedSample[] }
) {
  // The workshop counts 16 ticks to the quarter: a tick is a quarter of the sixteenth.
  const spt = grid.sixteenthFrames / 4 / frameHz;
  const tick = (t: number) => Math.round(t / spt);

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

  const pitched: number[][] = [];
  const drums: number[][] = [];
  for (const n of legato) {
    const start = tick(n.start);
    const ticks = Math.max(1, tick(n.start + n.duration) - start);
    if (n.track === 'noise') {
      drums.push([n.periodIndex, start, ticks, n.volume, n.volumeEnd, 0, -1]);
      continue;
    }
    const ch = CHANNEL[n.track];
    const hz = 440 * 2 ** ((n.pitch - 69) / 12);
    const period = Math.round(CPU_HZ / ((ch === 2 ? 32 : 16) * hz) - 1);
    const level = ch === 2 ? -1 : levelOf(n);
    pitched.push([
      n.midi, start, ticks, ch, ch === 2 ? 12 : n.volume, period, n.duty, ch === 2 ? 12 : n.volumeEnd, 0, bendOf(n), -1,
      ...(level >= 0 ? [-1, level] : []),
    ]);
  }
  pitched.sort((a, b) => a[1] - b[1] || a[3] - b[3]);
  drums.sort((a, b) => a[1] - b[1]);
  const voiced = [0, 1, 2].flatMap((ch) => oneAtATime(pitched.filter((r) => r[3] === ch)));
  voiced.sort((a, b) => a[1] - b[1] || a[3] - b[3]);
  pitched.length = 0;
  pitched.push(...voiced);
  const hits = oneAtATime(drums);
  drums.length = 0;
  drums.push(...hits);

  const totalTicks = tick(seconds);
  const events = (ch: number) => (ch === 3 ? drums.length : pitched.filter((r) => r[3] === ch).length);
  const bpm = Number(grid.bpm.toFixed(2));
  const track = {
    id: info.id,
    name: info.name,
    musicSpeed: 256,
    bpm,
    secondsPerTick: spt,
    totalTicks,
    seconds,
    loop: null,
    reading: info.reading,
    rom: { start: 0, end: 0 },
    bends,
    ...(levels.length ? { levels } : {}),
    channels: ['pulse1', 'pulse2', 'triangle', 'noise'].map((name, channel) => ({
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
    pitched,
    drums,
    ...(dmc && dmc.hits.length
      ? {
          /** `[sampleIndex, tick, ticks, rate, loop, level]` — samples struck on the DMC (`SampleRow`). */
          hits: dmc.hits
            .map((hit) => {
              const index = dmc.samples.findIndex((sample) => sample.address === hit.address && sample.bytes.length === hit.length);
              const start = tick(hit.start);
              return [index, start, Math.max(1, tick(hit.start + hit.duration) - start), hit.rate, hit.loop ? 1 : 0, hit.level];
            })
            .filter((row) => row[0] >= 0),
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
  index.tracks = index.tracks.filter((t: { id: number }) => t.id !== info.id);
  index.tracks.push({ id: info.id, slug: info.slug, name: info.name, reading: info.reading, musicSpeed: 256, bpm, seconds, events: pitched.length + drums.length });
  index.tracks.sort((a: { id: number }, b: { id: number }) => a.id - b.id);
  writeFileSync(indexPath, JSON.stringify(index, null, 1));
  return { pitched: pitched.length, drums: drums.length, bends: bends.length };
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
 * splinter), and each note ends where the next begins.
 */
function oneAtATime(rows: number[][]): number[][] {
  const out: number[][] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last[1] === row[1]) {
      if (row[2] > last[2]) out[out.length - 1] = row;
      continue;
    }
    if (last && last[1] + last[2] > row[1]) last[2] = row[1] - last[1];
    out.push(row);
  }
  return out;
}
