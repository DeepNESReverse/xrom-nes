/**
 * npm run nsf -- <file.nsf> --slug smb [--songs 1,4,7] [--seconds 90]
 *   [--composer "Koji Kondo"] [--out <dir>]
 *
 * Every song of an NSF as notes, into one /music collection for the workshop
 * (default: battletoads-tools-next/public/tracks/<slug>/notes) — the same
 * decoding, grid and collection as `npm run notes` takes from a cartridge, but
 * the driver is called the way an NSF player calls it: INIT with the song,
 * then PLAY once a frame. No title screen to wait out, no frames the game
 * skips.
 *
 * A song that stops — a jingle, a fanfare — ends at its first silence of
 * `SILENCE` seconds; one that loops is cut at `--seconds`.
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { NsfPlayer } from '@xromdev/nsf';
import { decode, type DecodedNote, type TimedWrite } from './decode.ts';
import { detectGrid } from './grid.ts';
import { writeCollection } from './collection.ts';

/** Seconds of nothing sounding that end a song that does not loop. */
const SILENCE = 2.5;

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--') && a.toLowerCase().endsWith('.nsf'));
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!path) {
  console.error('usage: npm run nsf -- <file.nsf> --slug <name> [--songs 1,2] [--seconds 90] [--composer "…"]');
  process.exit(1);
}

const file = new Uint8Array(readFileSync(path));
const probe = new NsfPlayer(file);
const info = probe.info;
const slug = opt('slug') ?? basename(path).replace(/\s*\(.*$/, '').replace(/\.nsf$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const seconds = Number(opt('seconds') ?? 90);
const songs = opt('songs')
  ? opt('songs')!.split(',').map(Number)
  : Array.from({ length: info.songs }, (_, i) => i + 1);
const out = opt('out') ?? join('/Users/alex.m/battletoads_mega_hack copy/battletoads-tools-next/public/tracks', slug, 'notes');
const composer = opt('composer') ?? info.artist;
console.log(`${info.title} — ${info.artist}, ${info.songs} songs, ${info.region} at ${info.playHz.toFixed(3)} Hz${info.expansion.length ? ', expansion ' + info.expansion.join(' ') : ''}`);

/** Every APU write of one song, from INIT on, for `length` seconds. */
function record(song: number, length: number): TimedWrite[] {
  const writes: TimedWrite[] = [];
  const player = new NsfPlayer(file, {
    onWrite: (w) => writes.push({ time: w.time, address: w.address, value: w.value }),
  });
  player.start(song);
  const buffer = new Float32Array(4096);
  for (let done = 0; done < length * player.sampleRate; done += buffer.length) player.render(buffer);
  return writes;
}

/**
 * Where the song falls silent for `SILENCE` seconds after it began — between
 * two notes, or after its last one — or null if it never does in `recorded`.
 */
function silenceAfter(notes: readonly DecodedNote[], recorded: number): number | null {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  let end = sorted[0]?.start ?? 0;
  for (const n of sorted) {
    if (n.start - end >= SILENCE) return end;
    end = Math.max(end, n.start + n.duration);
  }
  return recorded - end >= SILENCE ? end : null;
}

for (const song of songs) {
  const hz = info.playHz;
  let notes = decode(record(song, seconds + 1), seconds + 1, hz);
  if (notes.length === 0) {
    console.log(`song ${song}: silent — skipped`);
    continue;
  }
  const from = Math.min(...notes.map((n) => n.start));
  const quiet = silenceAfter(notes, seconds + 1);
  const until = quiet !== null ? quiet : from + seconds;
  notes = notes
    .filter((n) => n.start >= from && n.start < until)
    .map((n) => ({ ...n, start: n.start - from, duration: Math.min(n.duration, until - n.start) }));
  const length = until - from;
  const grid = detectGrid(notes, hz);
  const written = writeCollection(
    out,
    {
      id: song,
      slug: `${String(song).padStart(2, '0')}_song`,
      name: `${info.title} — song ${song}`,
      reading: composer ? { composer } : {},
      source: `${basename(path)}, played song by song and decoded from the sound chip — local research`,
    },
    notes,
    length,
    grid,
    hz
  );
  console.log(
    `song ${String(song).padStart(2)}: ${length.toFixed(1).padStart(5)} s${quiet !== null ? ' (ends)' : ' (cut) '}  row ${grid.rowFrames}f, sixteenth ${grid.sixteenthFrames}f → ♩ ${grid.bpm.toFixed(1).padStart(6)}  ${written.pitched} notes, ${written.drums} drums`
  );
}
console.log(`→ ${out}`);
