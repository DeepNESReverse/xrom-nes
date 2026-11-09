/**
 * node src/complexity/scan.ts <file.nsf> <out.jsonl> [seconds]
 *
 * Every song of an NSF, its first `seconds` (60) played the way an NSF player
 * plays it and decoded off the chip — one JSON line per song with the notes as
 * `ScanRow`s. The worker `cli.ts` runs eight of at a time; it is its own
 * process so a driver that never returns can be killed without losing the rest.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { NsfPlayer } from '@xromdev/nsf';
import { decode, type TimedWrite } from '../decode.ts';

/** NSFs with more entries than this are sound-effect banks; their music is in the first ones. */
const MAX_SONGS = 64;
/** Voices as `@xromdev/apu` numbers rows: the 2A03's, then the FDS (5) and the N163's channels (6..13). */
const VOICE: Record<string, number> = { pulse1: 0, pulse2: 1, triangle: 2, noise: 3, dmc: 4, fds: 5 };
const voiceOf = (track: string) => VOICE[track] ?? (track.startsWith('n163_') ? 5 + Number(track.slice(5)) : -1);

const [path, out, secArg] = process.argv.slice(2);
const seconds = Number(secArg ?? 60);
const file = new Uint8Array(readFileSync(path));
const info = new NsfPlayer(file).info;
const hz = info.playHz || 60.0988;

for (let song = 1; song <= Math.min(info.songs, MAX_SONGS); song++) {
  try {
    const writes: TimedWrite[] = [];
    const player = new NsfPlayer(file, { onWrite: (w: TimedWrite) => writes.push({ time: w.time, address: w.address, value: w.value }) });
    player.start(song);
    // The player enables the channels on its own chip and does not report it (see nsf-cli's record()).
    writes.unshift({ time: 0, address: 0x4015, value: 0x0f });
    const buffer = new Float32Array(4096);
    for (let done = 0; done < seconds * player.sampleRate; done += buffer.length) player.render(buffer);
    const rows = decode(writes, seconds, hz).map((n) => [
      voiceOf(n.track as string),
      n.midi,
      Math.round(n.start * hz),
      Math.max(1, Math.round(n.duration * hz)),
      n.volume,
      n.bend ? 1 : 0,
    ]);
    appendFileSync(out, JSON.stringify({ file: path, title: info.title, artist: info.artist, song, songs: info.songs, expansion: info.expansion, rows }) + '\n');
  } catch (e) {
    appendFileSync(out, JSON.stringify({ file: path, song, error: String(e) }) + '\n');
  }
}
