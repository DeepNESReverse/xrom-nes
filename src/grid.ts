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
