/**
 * npm run nsf -- <file.nsf> --slug smb [--songs 1,4,7] [--seconds 90]
 *   [--composer "Koji Kondo"] [--out <dir>]
 *
 * The reading of the songs given with `--songs` (by ear, all optional) — as
 * `npm run notes` takes them: `--meter 3/4`, `--bar-offset` (ticks, 16 to the
 * quarter, from the first note to the first bar line), `--key` (its name for the
 * list), `--key-signature` (VexFlow's), `--key-change bar:key,…`, `--sixteenth`
 * (frames). Re-run with one song to change just that song.
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
import { writeCollection, type CollectedSample } from './collection.ts';
import { dmcHits, drumKindOf } from './dmc.ts';

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

/**
 * Every APU write of one song, from INIT on, for `length` seconds — and the bytes of every DMC
 * sample it starts, read from the driver's memory the moment it starts it (the banks may move).
 */
function record(song: number, length: number): { writes: TimedWrite[]; bytes: Map<string, number[]> } {
  const writes: TimedWrite[] = [];
  const bytes = new Map<string, number[]>();
  let r12 = 0;
  let r13 = 0;
  let r15 = 0;
  // eslint-disable-next-line prefer-const
  let player: NsfPlayer;
  player = new NsfPlayer(file, {
    onWrite: (w) => {
      writes.push({ time: w.time, address: w.address, value: w.value });
      if (w.address === 0x4012) r12 = w.value;
      if (w.address === 0x4013) r13 = w.value;
      if (w.address === 0x4015) {
        const address = 0xc000 + r12 * 64;
        const size = r13 * 16 + 1;
        const key = `${address}:${size}`;
        if (w.value & 0x10 && !bytes.has(key)) {
          bytes.set(key, Array.from({ length: size }, (_, i) => player.peek(address + i)));
        }
        r15 = w.value;
      }
    },
  });
  void r15;
  player.start(song);
  const buffer = new Float32Array(4096);
  for (let done = 0; done < length * player.sampleRate; done += buffer.length) player.render(buffer);
  return { writes, bytes };
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

const meter = opt('meter');
const measureTicks = meter ? (64 / Number(meter.split('/')[1])) * Number(meter.split('/')[0]) : 64;
const barOffset = Number(opt('bar-offset') ?? 0);
const reading = {
  ...(opt('bar-offset') ? { barOffset } : {}),
  ...(meter ? { measureTicks, beatValue: Number(meter.split('/')[1]) } : {}),
  ...(opt('key') ? { keyName: opt('key') } : {}),
  ...(opt('key-signature') ? { keySignature: opt('key-signature') } : {}),
  ...(composer ? { composer } : {}),
};
const keyChanges = (opt('key-change') ?? '')
  .split(',')
  .filter(Boolean)
  .map((change) => {
    const [bar, key] = change.split(':');
    return { tick: barOffset + (Number(bar) - 1) * measureTicks, key };
  });
if (keyChanges.length) Object.assign(reading, { keyChanges });

/**
 * Where the bar lines fall when nobody has said: on the eighth that most notes start on.
 *
 * Counted from the song's first sound, Super Mario Bros.' song 4 put every note five ticks after
 * an eighth — its first sound is not on the beat — and each note that ends a bar was tied over the
 * bar line. The eighth most of a song's notes start on is its beat; the first bar line is moved
 * onto it, and what comes before is a pickup.
 */
function barLineOf(notes: readonly DecodedNote[], secondsPerTick: number): { barOffset?: number } {
  const EIGHTH = 8;
  const counts = new Array<number>(EIGHTH).fill(0);
  for (const n of notes) counts[((Math.round(n.start / secondsPerTick) % EIGHTH) + EIGHTH) % EIGHTH]++;
  let phase = 0;
  for (let p = 1; p < EIGHTH; p++) if (counts[p] > counts[phase]) phase = p;
  return phase > 0 ? { barOffset: phase } : {};
}

for (const song of songs) {
  const hz = info.playHz;
  const recorded = record(song, seconds + 1);
  let notes = decode(recorded.writes, seconds + 1, hz);
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
  // The DMC's hits, on the same clock as the notes; the samples they play, with their kind.
  const hits = dmcHits(recorded.writes, until)
    .filter((hit) => hit.start >= from)
    .map((hit) => ({ ...hit, start: hit.start - from }));
  const samples: CollectedSample[] = [];
  for (const hit of hits) {
    if (samples.some((s) => s.address === hit.address && s.bytes.length === hit.length)) continue;
    const bytes = recorded.bytes.get(`${hit.address}:${hit.length}`);
    if (bytes) samples.push({ address: hit.address, bytes, kind: drumKindOf(bytes, hit.rate) });
  }
  const grid = detectGrid(notes, hz);
  if (opt('sixteenth')) {
    grid.sixteenthFrames = Number(opt('sixteenth'));
    grid.bpm = (60 * hz) / (grid.sixteenthFrames * 4);
  }
  // The bar line where most notes begin, not at the song's first sound — unless given by ear.
  const own = opt('bar-offset') ? reading : { ...reading, ...barLineOf(notes, grid.sixteenthFrames / 4 / hz) };
  const written = writeCollection(
    out,
    {
      id: song,
      slug: `${String(song).padStart(2, '0')}_song`,
      name: `${info.title} — song ${song}`,
      reading: own,
      source: `${basename(path)}, played song by song and decoded from the sound chip — local research`,
    },
    notes,
    length,
    grid,
    hz,
    { hits, samples }
  );
  console.log(
    `song ${String(song).padStart(2)}: ${length.toFixed(1).padStart(5)} s${quiet !== null ? ' (ends)' : ' (cut) '}  row ${grid.rowFrames}f, sixteenth ${grid.sixteenthFrames}f → ♩ ${grid.bpm.toFixed(1).padStart(6)}  ${written.pitched} notes, ${written.drums} drums${hits.length ? `, ${hits.length} samples (${samples.map((s) => s.kind).join(' ')})` : ''}${own.barOffset ? `, bar line ${own.barOffset} ticks in` : ''}`
  );
}
console.log(`→ ${out}`);
