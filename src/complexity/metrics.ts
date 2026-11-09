/**
 * How complex a soundtrack is, read off the notes the chip played — frame-exact
 * notes from `decode`, never a collection's grid (measured on the grid, the
 * numbers say more about the grid chosen for the score than about the music:
 * Metal Gear came out in the middle).
 *
 * A song is measured over what `scan.ts` recorded (its first 60 s); one under
 * 15 s or with fewer than 60 pitched notes is a jingle or an effect and is not
 * measured. A game's score is the mean of the busier half of its songs, so a
 * soundtrack is not dragged down by its menus and fanfares.
 *
 * The weights are a choice, and the choice is stated: they were set so that the
 * three soundtracks the user named as the hardest (Terminator 2, RoboCop 3,
 * Alien 3) land at the top and Metal Gear, which they called simple, in the
 * middle. What that measures is OUTWARD complexity — frame-fast ornaments,
 * density, chromatic lines, bends — the British and European school of the
 * early nineties, more than harmonic depth.
 */

import { deflateSync } from 'node:zlib';

/** One pitched or noise note: [voice 0..4, midi, start frame, frames, volume, bent 0|1]. */
export type ScanRow = [number, number, number, number, number, number];

export interface SongMetrics {
  /** Pitched notes a second. */
  density: number;
  /** Share of notes 2 frames or shorter: arpeggios, trills, frame-fast runs. */
  ornament: number;
  /** Share of sounding time outside the best-fitting major scale. */
  chromatic: number;
  /** Entropy (bits) of the melodic steps within each voice, clamped to two octaves. */
  intervals: number;
  /** Entropy (bits) of note lengths in frames. */
  rhythm: number;
  /** Mean span of a voice, 5th to 95th percentile, in semitones. */
  range: number;
  /** Deflated bytes a second of the voices written out as text: how little the music repeats. */
  info: number;
  /** Share of notes whose pitch moves: vibrato, slides, bends. */
  bends: number;
}

export type MetricKey = keyof SongMetrics;

export const METRICS: readonly MetricKey[] = ['density', 'ornament', 'chromatic', 'intervals', 'rhythm', 'range', 'info', 'bends'];

/** See the header: set against Terminator 2 / RoboCop 3 / Alien 3 at the top, Metal Gear in the middle. */
export const WEIGHTS: Record<MetricKey, number> = {
  density: 1,
  ornament: 2,
  chromatic: 1,
  intervals: 0.5,
  rhythm: 0.5,
  range: 0.25,
  info: 1,
  bends: 1,
};

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MIN_SECONDS = 15;
const MIN_NOTES = 60;

function entropy(counts: Map<number, number>): number {
  let n = 0;
  for (const v of counts.values()) n += v;
  let h = 0;
  for (const v of counts.values()) if (v) h -= (v / n) * Math.log2(v / n);
  return n ? h : 0;
}

function bump(map: Map<number, number>, key: number, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** Linear-interpolated percentile, as numpy's default. */
function percentile(sorted: number[], p: number): number {
  const at = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** The least a song needs to be measured: seconds and pitched notes. */
export interface SongLimits {
  seconds: number;
  notes: number;
}

/**
 * For songs already known to be music — a careful pass listed them — whose game has nothing longer:
 * Battle City's music is three jingles, and with the usual limits its rank came from two engine
 * sound effects.
 */
export const JINGLE_LIMITS: SongLimits = { seconds: 3, notes: 12 };

/** The metrics of one song, or null when it is too short or too sparse to be a piece of music. */
export function songMetrics(
  all: readonly ScanRow[],
  frameHz = 60,
  limits: SongLimits = { seconds: MIN_SECONDS, notes: MIN_NOTES },
): SongMetrics | null {
  // The pitched voices: the 2A03's pulses and triangle, and any expansion chip's (5..13).
  const rows = all.filter((r) => (r[0] >= 0 && r[0] <= 2) || r[0] >= 5).filter((r) => r[1] >= 21 && r[1] <= 127);
  if (rows.length < limits.notes) return null;
  const end = Math.max(...rows.map((r) => r[2] + r[3]));
  const seconds = end / frameHz;
  if (seconds < limits.seconds) return null;

  const pcs = new Array<number>(12).fill(0);
  for (const r of rows) pcs[r[1] % 12] += r[3];
  const total = pcs.reduce((a, b) => a + b, 0);
  let inScale = 0;
  for (let k = 0; k < 12; k++) inScale = Math.max(inScale, MAJOR.reduce((s, i) => s + pcs[(k + i) % 12], 0));

  const voices = [...new Set(rows.map((r) => r[0]))].map((v) => rows.filter((r) => r[0] === v).sort((a, b) => a[2] - b[2]));
  const steps = new Map<number, number>();
  const lengths = new Map<number, number>();
  const spans: number[] = [];
  let text = '';
  for (const voice of voices) {
    let last: ScanRow | null = null;
    for (const r of voice) {
      text += `${r[0]}${r[1]},${last ? r[2] - last[2] : 0},${r[3]};`;
      last = r;
    }
    if (voice.length < 8) continue;
    const pitches = voice.map((r) => r[1]).sort((a, b) => a - b);
    spans.push(percentile(pitches, 95) - percentile(pitches, 5));
    for (let i = 1; i < voice.length; i++) bump(steps, Math.max(-24, Math.min(24, voice[i][1] - voice[i - 1][1])));
    for (const r of voice) bump(lengths, Math.min(r[3], 96));
  }

  return {
    density: rows.length / seconds,
    ornament: rows.filter((r) => r[3] <= 2).length / rows.length,
    chromatic: 1 - inScale / total,
    intervals: entropy(steps),
    rhythm: entropy(lengths),
    range: spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : 0,
    info: deflateSync(Buffer.from(text), { level: 9 }).length / seconds,
    bends: rows.filter((r) => r[5]).length / rows.length,
  };
}

export interface Normal {
  mean: Record<MetricKey, number>;
  sd: Record<MetricKey, number>;
}

/** Mean and spread of each metric over every song of every game — the scale the z-scores are on. */
export function normalOf(songs: readonly SongMetrics[]): Normal {
  const mean = {} as Record<MetricKey, number>;
  const sd = {} as Record<MetricKey, number>;
  for (const k of METRICS) {
    const xs = songs.map((s) => s[k]);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    mean[k] = m;
    sd[k] = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length) || 1;
  }
  return { mean, sd };
}

/** A song's score: the weighted mean of its z-scores. 0 is the library's average song. */
export function songScore(s: SongMetrics, n: Normal): number {
  let sum = 0;
  let weights = 0;
  for (const k of METRICS) {
    sum += (WEIGHTS[k] * (s[k] - n.mean[k])) / n.sd[k];
    weights += WEIGHTS[k];
  }
  return sum / weights;
}

/** A game's score: the mean of the busier half of its songs' scores. */
export function gameScore(scores: readonly number[]): number {
  const sorted = [...scores].sort((a, b) => b - a);
  const half = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
  return half.reduce((a, b) => a + b, 0) / half.length;
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
