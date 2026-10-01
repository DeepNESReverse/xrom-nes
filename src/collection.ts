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
    composer?: string;
  };
}

export function writeCollection(dir: string, info: TrackInfo, notes: readonly DecodedNote[], seconds: number, grid: Grid, frameHz = 60.0988) {
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

  const pitched: number[][] = [];
  const drums: number[][] = [];
  for (const n of notes) {
    const start = tick(n.start);
    const ticks = Math.max(1, tick(n.start + n.duration) - start);
    if (n.track === 'noise') {
      drums.push([n.periodIndex, start, ticks, n.volume, n.volumeEnd, 0, -1]);
      continue;
    }
    const ch = CHANNEL[n.track];
    const hz = 440 * 2 ** ((n.pitch - 69) / 12);
    const period = Math.round(CPU_HZ / ((ch === 2 ? 32 : 16) * hz) - 1);
    pitched.push([n.midi, start, ticks, ch, ch === 2 ? 12 : n.volume, period, n.duty, ch === 2 ? 12 : n.volumeEnd, 0, bendOf(n), -1]);
  }
  pitched.sort((a, b) => a[1] - b[1] || a[3] - b[3]);
  drums.sort((a, b) => a[1] - b[1]);

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
