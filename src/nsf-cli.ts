/**
 * npm run nsf -- <file.nsf> --slug smb [--songs 1,4,7] [--seconds 90]
 *   [--composer "Koji Kondo"] [--m3u <playlist.m3u>] [--listen 480] [--quantize 4]
 *   [--tempo 0:6,4224:8] [--loop 3780.5] [--out <dir>]
 * npm run nsf -- --session <probe session> --rom <the .nes> --slug t2-cart
 *   [--title "Terminator 2"] [--names "04=Level 3;01=Title"] [--order 01,02,05,04] [--min-seconds 1.5]
 *
 * `--session`: no NSF — the cartridge's own driver, as the FCEUX agent found it (stage 3b, see
 * cartridgeSource below). Song numbers are the driver's, in hex for `--names` and `--songs`.
 *
 * `--m3u` names the songs from an NSF playlist (`file::NSF,<song>,<name>,…`,
 * as Zophar's archive ships them): its song numbers are the file's own only
 * when it was made for the same rip — check by ear, or by the notes.
 *
 * The reading of the songs given with `--songs` (by ear, all optional) — as
 * `npm run notes` takes them: `--meter 3/4`, `--bar-offset` (in the collection's
 * ticks, 16 to the quarter — not frames — from the first note to the first bar
 * line), `--key` (its name for the list; the key signature follows it unless
 * `--key-signature`, VexFlow's, says otherwise), `--key-change bar:key,…`,
 * `--sixteenth` (frames: the grid, kept as given). Re-run with one song to change
 * just that song.
 *
 * Frames, wherever a flag takes them (`--sixteenth`, `--tempo`, `--loop`,
 * `--driver-tempo-map`), are PLAY calls at the NSF's own rate (its header's, e.g.
 * 60.002 Hz), counted from the song's first sound.
 *
 * `--driver-tempo T[:phase]` (with `--driver-modulus M`, default 256,
 * `--driver-tempo-map F:T[:phase],…` — a phase, or `reset` for 0, starts the driver's count again
 * on frame F — `--driver-quarter Q`, default 16, and `--driver-ends floor|ceil|between`): the notes
 * put on the driver's own ticks — see `driverClock` in grid.ts — Q of them to the quarter.
 *
 * `--origin note|sound|init|F`: where tick 0 is — the first note of the 2A03's and the expansions'
 * voices (`note`, the default); the first sound, a DMC hit's too (`sound`); INIT (`init`); or frame
 * F of the PLAY calls from INIT, what sounds before it left out. Every frame a flag takes counts
 * from it — which is why the default stays: Super Mario Bros. 3's songs that open on the DMC moved
 * by up to 36 frames, and every script's frames and bar lines with them.
 * `--title` names an NSF's songs (the header's name otherwise); `--no-loop` takes no loop, the song
 * cut at its silence or `--seconds`; `--keep-pulse-phase on|off` overrides what the song's writes
 * say about the pulses' phase (`keepPulsePhase`, below); `--lead [F]` moves the origin onto the
 * rows — F frames, or as found.
 *
 * Every song of an NSF as notes, into one /music collection for the workshop
 * (default: battletoads-tools-next/public/tracks/<slug>/notes) — the same
 * decoding, grid and collection as `npm run notes` takes from a cartridge, but
 * the driver is called the way an NSF player calls it: INIT with the song,
 * then PLAY once a frame. No title screen to wait out, no frames the game
 * skips.
 *
 * A song that loops is found looping (`findLoop`, over `LISTEN` seconds) and
 * kept for its intro and one pass of the loop; one that stops — a jingle, a
 * fanfare — ends at its first silence of `--silence` seconds (2.5); one that does
 * neither is cut at `--seconds`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { NsfPlayer } from '@xromdev/nsf';
import { readSession } from './probe/session.ts';
import { DumpPlayer, NMI, readDump, songTables, withRom } from './agent/driver.ts';
import { agreement, agrees, experiments, play, playCandidates, startCalls, startSong, type Experiment, type StartCall } from './agent/cartridge.ts';
import { CPU_HZ, FRAME_CYCLES } from './nes.ts';
import { decode, type DecodedNote, type TimedWrite } from './decode.ts';
import { detectGrid, driverClock, markedStretch, type ClockSnap, type DriverTempo } from './grid.ts';
import { pulsePhaseKept, removeTrack, writeCollection, type CollectedSample } from './collection.ts';
import { dmcHits, drumKindOf, type DmcHit } from './dmc.ts';
import { findLoop, findNoteLoop, loopWithoutVoice, musicLoop, type Loop } from './loop.ts';

/** The quarters a minute a mechanical metronome is marked with, slowest to fastest. */
const METRONOME = { slowest: 40, fastest: 208 };

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--') && a.toLowerCase().endsWith('.nsf'));
/*
 * A flag given twice is read where it last stands, as command lines go: Jajamaru Ninpou Chou's
 * script gave a song's `--meter 12/8` after its shared list's `--meter`, and the list's was read.
 * Given twice with two values, it is said — on every song's line too, which scripts keep — and
 * the first is not read. (Flappy's and Q-Boy's scripts put a song's own flags before their shared
 * list, written for the first being read: they must put them after it.)
 */
const opt = (name: string) => {
  const i = args.lastIndexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
/** The flags given twice with two values, as the song lines say. */
const givenTwice: string[] = [];
{
  const seen = new Map<string, string | undefined>();
  args.forEach((a, i) => {
    if (!a.startsWith('--')) return;
    const value = args[i + 1]?.startsWith('--') ? undefined : args[i + 1];
    if (seen.has(a) && seen.get(a) !== value) givenTwice.push(`${a} given twice: ${value ?? '(no value)'} is read, ${seen.get(a) ?? '(no value)'} is not`);
    seen.set(a, value);
  });
  for (const line of givenTwice) console.log(line);
}
const sessionDir = opt('session');
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: npm run nsf -- <file.nsf> --slug <name> [--songs 1,2] [--seconds 90] [--silence 2.5] [--composer "…"] [--title "…"] [--m3u <playlist>]');
  console.log('       npm run nsf -- --session <probe session> --rom <the .nes> --slug <name>   (the cartridge\'s own driver)');
  console.log('  grid: --sixteenth F (kept as given) | --tempo F:S,… | --swing F:P:eighths|sixteenths[:L-S] | --driver-tempo T[:phase] [--driver-modulus M]');
  console.log('        [--driver-tempo-map F:T[:phase|reset],…] [--driver-quarter Q] [--driver-ends floor|ceil|between] [--driver-starts first|last]');
  console.log('        [--quantize N] [--keep-grid]');
  console.log('  time: --origin note|sound|init|F, --lead [F], --loop [F:]L, --no-loop, --listen S, --min-seconds S');
  console.log('  reading: --meter N/D, --bar-offset T, --key K, --key-signature K, --key-change bar:key,…, --order 1,2,…');
  console.log('  sound: --keep-pulse-phase on|off; --out <dir>');
  console.log('  frames (--sixteenth, --tempo, --loop, --driver-tempo-map) are PLAY calls at the NSF\'s rate, from the origin;');
  console.log('  --bar-offset is in the collection\'s ticks, 16 to the quarter, not frames');
  process.exit(0);
}
if (!path && !sessionDir) {
  console.error('usage: npm run nsf -- <file.nsf> --slug <name> [--songs 1,2] [--seconds 90] [--silence 2.5] [--composer "…"]');
  console.error('       npm run nsf -- --session <probe session> --rom <the .nes> --slug <name>   (the cartridge\'s own driver)');
  console.error('  frames (--sixteenth, --tempo, --loop, --driver-tempo-map) are PLAY calls at the NSF\'s rate, from the first sound;');
  console.error('  --bar-offset is in the collection\'s ticks, 16 to the quarter, not frames');
  process.exit(1);
}
/** A flag's number, or an error: `--songs 1,2,` read as songs 1, 2 and 0 played song 1 again as a "song 0". */
const numberOf = (flag: string, text: string) => {
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value)) {
    console.error(`--${flag}: "${text}" is not a number`);
    process.exit(1);
  }
  return value;
};
/** Seconds of nothing sounding that end a song that does not loop: `--silence`, for a song with a pause of its own. */
const SILENCE = numberOf('silence', opt('silence') ?? '2.5');

/** Where the songs come from: an NSF file, or the cartridge's driver on a probe session's dump. */
interface Source {
  title: string;
  artist: string;
  songs: number[];
  region: string;
  playHz: number;
  expansion: string[];
  /** For the collection's `source`. */
  origin: string;
  name(song: number): string | undefined;
  /** Every chip write of one song from INIT on, and the DMC samples it starts (see below). */
  record(song: number, length: number): { writes: TimedWrite[]; bytes: Map<string, number[]> };
}

const source: Source = sessionDir ? cartridgeSource(sessionDir) : nsfSource(path!);
const info = source;
const slug = opt('slug') ?? basename(path ?? sessionDir!).replace(/\s*\(.*$/, '').replace(/\.nsf$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const seconds = Number(opt('seconds') ?? 90);
/** Seconds each song is recorded for while its loop is looked for: two passes of the longest loop must fit. */
const LISTEN = Number(opt('listen') ?? 480);
/** A song's number as given: the driver's numbers are written in hex, an NSF's in decimal. */
const songNumber = (text: string) => {
  const number = sessionDir ? (/^\s*\$?[0-9a-f]+\s*$/i.test(text) ? parseInt(text.replace('$', ''), 16) : NaN) : text.trim() === '' ? NaN : Number(text);
  if (!Number.isInteger(number)) {
    console.error(`no song "${text}" — a list of song numbers, without empty places`);
    process.exit(1);
  }
  return number;
};
/**
 * `--order 01,02,05…`: the songs in the order the collection lists them, numbered 1, 2, 3… —
 * the order the game plays them, not the driver's numbering. Songs left out are not collected.
 */
const order = opt('order')?.split(',').map(songNumber);
const idOf = (song: number) => (order ? order.indexOf(song) + 1 : song);
const songs = opt('songs')
  ? opt('songs')!.split(',').map(songNumber)
  : order
    ? order.filter((song) => source.songs.includes(song))
    : source.songs;
for (const song of songs) {
  // A warning, not an error: a patched NSF may hold songs past its header's count.
  if (!sessionDir && !source.songs.includes(song)) console.log(`song ${song}: past the NSF's songs 1 to ${source.songs.length}`);
}
const out = opt('out') ?? join(process.env.XROM_TRACKS ?? '/Users/alex.m/battletoads_mega_hack copy/battletoads-tools-next/public/tracks', slug, 'notes');
// An NSF that does not know its composer says `<?>`, which is not a name to print on a score.
const composer = opt('composer') ?? (/^\s*<\s*\?+\s*>\s*$|^\s*$/.test(info.artist) ? undefined : info.artist);
// The header's expansion byte ($7B) is only a claim — Hydlide 3's says VRC6, VRC7 and FDS on an
// MMC1 game: the voices the songs do write are said at the end.
console.log(`${info.title} — ${composer ?? 'composer not given'}, ${info.songs.length} songs, ${info.region} at ${info.playHz.toFixed(3)} Hz${info.expansion.length ? ', expansion in the header: ' + info.expansion.join(' ') : ''}`);

/** Song number → name, from the lines of an NSF playlist; a `\,` is a comma inside a field. */
function playlistNames(m3u: string | undefined): Map<number, string> {
  const names = new Map<number, string>();
  if (!m3u) return names;
  // UTF-8 (an em dash, a Japanese title), unless the bytes are not: then Latin-1, as older playlists are.
  const bytes = readFileSync(m3u);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    text = bytes.toString('latin1');
  }
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('::NSF,');
    if (at < 0) continue;
    const fields = line.slice(at + 6).split(/(?<!\\),/).map((f) => f.replace(/\\,/g, ','));
    if (fields[1]) names.set(Number(fields[0]), fields[1].trim());
  }
  return names;
}

/** The DMC samples a run of writes starts, read from the driver's memory the moment it starts each (the banks may move). */
function sampleWatcher(peek: (address: number) => number) {
  const bytes = new Map<string, number[]>();
  let r12 = 0;
  let r13 = 0;
  return {
    bytes,
    write(address: number, value: number) {
      if (address === 0x4012) r12 = value;
      if (address === 0x4013) r13 = value;
      if (address === 0x4015 && value & 0x10) {
        const at = 0xc000 + r12 * 64;
        const size = r13 * 16 + 1;
        const key = `${at}:${size}`;
        if (!bytes.has(key)) bytes.set(key, Array.from({ length: size }, (_, i) => peek(at + i)));
      }
    },
  };
}

function nsfSource(path: string): Source {
  const file = new Uint8Array(readFileSync(path));
  const nsf = new NsfPlayer(file).info;
  const names = playlistNames(opt('m3u'));
  return {
    title: opt('title') ?? nsf.title,
    artist: nsf.artist,
    songs: Array.from({ length: nsf.songs }, (_, i) => i + 1),
    region: nsf.region,
    playHz: nsf.playHz,
    expansion: nsf.expansion,
    origin: basename(path),
    name: (song) => names.get(song),
    /**
     * Every APU write of one song, from INIT on, for `length` seconds — and the bytes of every
     * DMC sample it starts.
     */
    record(song, length) {
      const writes: TimedWrite[] = [];
      // eslint-disable-next-line prefer-const
      let player: NsfPlayer;
      const samples = sampleWatcher((address) => player.peek(address));
      player = new NsfPlayer(file, {
        onWrite: (w) => {
          writes.push({ time: w.time, address: w.address, value: w.value });
          samples.write(w.address, w.value);
        },
      });
      player.start(song);
      // The player enables every channel ($4015 = $0F) before INIT, as the NSF spec has it, but on
      // its own chip — the write is not reported. A driver that never writes $4015 itself (Chip 'n
      // Dale 2) left the decoder's chip with every channel off, and every song came out silent; one
      // that writes it after its first notes (Terminator 2) lost those: Level 3's opening fifteen
      // seconds of pulse 1, and Title's, Story's and Level 2/4's openings with it.
      writes.unshift({ time: 0, address: 0x4015, value: 0x0f });
      const buffer = new Float32Array(4096);
      for (let done = 0; done < length * player.sampleRate; done += buffer.length) player.render(buffer);
      return { writes, bytes: samples.bytes };
    },
  };
}

/**
 * The cartridge's own driver (stage 3b of the agent): the entry and the register the agent found
 * in FCEUX (tracks.json), PLAY found among the routines the probe saw called each frame, and the
 * dump the probe took at the song start — with the ROM, so a driver that switches banks reads the
 * banks it asks for. A song is collected only if the dump player writes, frame for frame, what
 * the cartridge wrote in FCEUX in the agent's experiment with it; the others are named and left.
 * Song numbers are the driver's own: the register's value.
 */
function cartridgeSource(dir: string): Source {
  const session = readSession(dir);
  const tracks = JSON.parse(readFileSync(join(dir, 'tracks.json'), 'utf8'));
  const number = (v: string | number) => (typeof v === 'number' ? v : parseInt(String(v).replace('$', ''), 16));
  if (!tracks.argument) throw new Error(`${dir}: the agent found no song argument (tracks.json)`);
  const entry = number(tracks.argument.entry);
  const reg = tracks.argument.reg as 'a' | 'x' | 'y';
  // The driver entry the game called (the agent's `via`), or the argument's entry itself.
  const via = tracks.argument.via as { entry: string; a: number; x: number; y: number } | undefined;
  const outer = via ? number(via.entry) : entry;
  // The dump taken where that entry was called, when the probe has it; else the start's own.
  const atEntry = join(dir, 'dumps', `${tracks.start}-${outer.toString(16).toUpperCase().padStart(4, '0')}.bin`);
  let dump = readDump(existsSync(atEntry) ? atEntry : join(dir, 'dumps', `${tracks.start}.bin`));
  const meta = session.meta as { rom?: { file?: string; md5?: string }; cyclesPerFrame?: number; region?: string };
  const rom = opt('rom');
  if (rom) dump = withRom(dump, new Uint8Array(readFileSync(rom)), meta.rom?.md5);
  else console.log('no --rom: the dump\'s banks only — a driver that switches banks will not agree with FCEUX');
  const cyclesPerFrame = meta.cyclesPerFrame ?? FRAME_CYCLES;
  // How many songs the driver's tables hold: as the agent found them, or found now (a session
  // recorded before the agent looked).
  const songCount: number | null = tracks.argument.mailbox || tracks.argument.fixed ? null : (tracks.tables ?? songTables(dump, entry, reg, number(tracks.argument.original))).songs;
  if (songCount === null) console.log('the song tables were not found: every value tried is taken');
  // A song asked for through RAM: the experiments' values are the mailbox's, not a register's.
  const box = tracks.argument.mailbox as { addr: number; empty: number; nth: number } | undefined;
  // A dispatcher's routine set beside the song number (the agent's `fixed`: Jungle Book's Y = 2).
  const fixed = tracks.argument.fixed as Partial<Record<'a' | 'x' | 'y', number>> | undefined;
  const [routineReg, routineValue] = (Object.entries(fixed ?? {})[0] ?? []) as ['a' | 'x' | 'y', number] | [];
  const checkFrames = opt('check-frames') ? Number(opt('check-frames')) : undefined;
  const tried = experiments(session, entry, Number(tracks.start), routineReg ? { reg: routineReg, value: routineValue! } : undefined)
    .filter((e) => !box || e.asked !== undefined || e.hit)
    .map((e) => ({ ...e, value: box ? (e.asked ?? number(tracks.argument.original)) : e.hit[reg] }))
    .filter((e) => songCount === null || e.value < songCount)
    // `--check-frames N`: the game's own sounds over the song after N frames (Jungle Book's attract
    // mode fires an effect on pulse 2 at frame 131 of every try) — the window ends there, as it
    // does where the game calls the driver itself.
    .map((e) => (checkFrames && e.frames > checkFrames ? { ...e, frames: checkFrames, cut: checkFrames - 1, writes: e.writes.filter((w) => w.frame < checkFrames) } : e));
  const byValue = new Map<number, Experiment>();
  for (const e of tried) if (!byValue.has(e.value)) byValue.set(e.value, e);
  /** The start as the game made it, the song number `value` taken at the argument's entry. */
  const nth = Number(tracks.argument.nth ?? 1);
  // How the start is replayed and which routine is PLAY: every pair tried, the one whose writes
  // run in FCEUX's order furthest kept — judged on the busiest experiments, the songs: an effect's
  // few writes, with the game's own requests landing on them (RoboCop), say little.
  const ways: StartCall[] = box
    ? [{ entry, regs: { a: 0, x: 0, y: 0 }, at: -1, reg, mailbox: box.addr }]
    : startCalls(session, Number(tracks.start), entry, reg, nth);
  if (ways.length === 0) ways.push({ entry: outer, regs: via ? { a: via.a, x: via.x, y: via.y } : { a: 0, x: 0, y: 0 }, at: entry, reg, nth });
  if (fixed) for (const w of ways) w.fixed = fixed;
  const sample = [...byValue.values()].filter((e) => e.writes.length >= 20 || e.cut !== undefined).sort((p, q) => q.writes.length - p.writes.length).slice(0, 12);
  const at = (address: number) => (address >= 0x6000 && address <= 0xffff ? dump.upper[address - 0x6000] : -1);
  let playAt = -1;
  let way = ways[0];
  let bestShare = -1;
  // Each way from the dump taken where its entry was called, when the probe has one.
  const dumpFor = (address: number) => {
    // A mailbox's start: the dump taken at the request, before the routine acted on it.
    const file = join(dir, 'dumps', `${tracks.start}-${address.toString(16).toUpperCase().padStart(4, '0')}${box ? '-ram' : ''}.bin`);
    if (!existsSync(file)) return dump;
    const own = readDump(file);
    return rom ? withRom(own, new Uint8Array(readFileSync(rom)), meta.rom?.md5) : own;
  };
  for (const candidateWay of ways) {
    const wayDump = dumpFor(candidateWay.entry);
    // The entries in a row of JMPs around the one the game calls are candidates too: RoboCop's
    // frame routine $8006 sits beside $8003 and is called from the NMI, out of sight of any chain.
    const row: number[] = [];
    if (at(candidateWay.entry) === 0x4c) for (const step of [-3, 3]) for (let address = candidateWay.entry + step; at(address) === 0x4c && Math.abs(address - candidateWay.entry) <= 24; address += step) row.push(address);
    // And the frame interrupt itself, for a driver reached only through the NMI handler.
    for (const candidate of [...new Set([...(box ? [candidateWay.entry] : []), ...row, ...playCandidates(session, entry).slice(0, 12), NMI])]) {
      let share = 0;
      for (const e of sample) {
        const mine = play(wayDump, { ...candidateWay, regs: candidateWay.series?.[0] ?? e.hit }, e.value, candidate, e.frames + 3).writes.filter((w) => w.frame < e.frames - 1);
        const a = agreement(e, mine);
        share += a.writes ? Math.min(1, (a.confirmed * mine.length) / a.writes) : 0;
      }
      share /= Math.max(1, sample.length);
      if (share > bestShare) [playAt, way, bestShare] = [candidate, candidateWay, share];
    }
  }
  if (playAt < -1 || bestShare < 0.5) throw new Error(`no way of starting and no routine the probe saw called plays like FCEUX (best: ${Math.round(bestShare * 100)}% of writes in order): PLAY not found`);
  dump = dumpFor(way.entry);
  const startOf = (e: Experiment): StartCall => ({ ...way, regs: way.series?.[0] ?? e.hit });
  const hex = (n: number, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
  const playName = playAt === NMI ? 'the NMI handler' : `$${hex(playAt, 4)}`;
  if (box) console.log(`the song in RAM $${hex(box.addr, 3)}, picked up by $${hex(way.entry, 4)}; PLAY ${playName}`);
  else console.log(`INIT $${hex(way.entry, 4)}${(way.series?.length ?? 1) > 1 ? ` (${way.series!.length} calls)` : ''}${way.entry !== entry ? `, the song in ${reg.toUpperCase()} at $${hex(entry, 4)}${nth > 1 ? ` (its call ${nth})` : ''}` : ` with the song in ${reg.toUpperCase()}`}, PLAY ${playName}`);
  const agreed: number[] = [];
  for (const [value, e] of [...byValue].sort((p, q) => p[0] - q[0])) {
    const mine = play(dump, startOf(e), e.value, playAt, e.frames + 3).writes.filter((w) => w.frame < e.frames - 1);
    const a = agreement(e, mine);
    const ok = agrees(a, mine.length);
    const how =
      (a.firstDiffering === null ? 'agrees with FCEUX' : ok ? `agrees with FCEUX, the game's own sounds over it (${Math.round(a.confirmed * 100)}% of ours in FCEUX's order)` : `DIFFERS from FCEUX from frame ${a.firstDiffering}`) +
      (e.cut !== undefined ? ` — checked for ${e.cut} frames only: the game called the driver itself then` : '');
    console.log(`  $${hex(value)}: ${how} — ${a.same}/${a.frames} frames${a.lagged ? ` (${a.lagged} lag frames of the game passed over)` : ''}, ${a.prefix}/${a.writes} writes in order`);
    if (ok) agreed.push(value);
  }
  const starts = new Map([...byValue].map(([value, e]) => [value, startOf(e)]));
  // `--names "0=Level 5;1=Title"`: the songs' names, by the driver's numbers — the agent knows
  // where a song plays only for the ones it heard the game start.
  const names = new Map(
    (opt('names') ?? '')
      .split(';')
      .filter(Boolean)
      .map((pair) => [parseInt(pair.split('=')[0], 16), pair.slice(pair.indexOf('=') + 1).trim()] as const)
  );
  const playHz = CPU_HZ / cyclesPerFrame;
  const enabled = [...session.writes].reverse().find((w) => w.address === 0x4015 && w.frame <= Number(tracks.start))?.value ?? 0x0f;
  return {
    title: opt('title') ?? meta.rom?.file ?? basename(dir),
    artist: '',
    songs: agreed,
    region: meta.region ?? 'NTSC',
    playHz,
    expansion: [],
    origin: `${meta.rom?.file ?? 'the cartridge'} — its own driver, INIT $${hex(way.entry, 4)} and PLAY ${playName} run on the probe's dump, checked against FCEUX`,
    name: (song) => (names.has(song) ? `${names.get(song)} ($${hex(song)})` : `song $${hex(song)}`),
    record(song, length) {
      const player = new DumpPlayer(dump);
      const samples = sampleWatcher((address) => player.peek(address));
      // The channels as the game left them enabled: RoboCop writes $4015 once, at power-on, and a
      // song recorded without it decoded as silence on every channel.
      const writes: TimedWrite[] = [{ time: 0, address: 0x4015, value: enabled }];
      const frames = Math.ceil(length * playHz);
      for (let f = 0; f < frames; f++) {
        const list = f === 0 ? startSong(player, starts.get(song)!, song) : player.call(playAt, {});
        for (const w of list) {
          writes.push({ time: (f * cyclesPerFrame + w.cycle) / CPU_HZ, address: w.address, value: w.value });
          samples.write(w.address, w.value);
        }
      }
      if (player.stuck) console.log(`  song $${hex(song)}: ${player.stuck} calls did not return`);
      return { writes, bytes: samples.bytes };
    },
  };
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
/** A key's name as VexFlow's key signatures spell it: B♭m → Bbm, F♯ major → F#. */
const vexKey = (name: string) =>
  name.trim().replace(/♭/g, 'b').replace(/♯/g, '#').replace(/\s*(minor|min)$/i, 'm').replace(/\s*(major|maj)$/i, '');
/** Sharps (+) or flats (−) of each key a signature can name, majors and minors. */
const ACCIDENTALS: Record<string, number> = Object.fromEntries(
  ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'].flatMap((major, i) => {
    const minor = ['Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m'][i];
    return [[major, i - 7], [minor, i - 7]];
  })
);
/*
 * The signature follows the key named, unless given: Altered Beast's draft wrote a B♭m with an
 * F♯ major signature. One given that does not match is kept — a mode can mean it (C with one
 * flat for a mixolydian) — but said.
 */
const keyName = opt('key');
const keySignature = opt('key-signature') ? vexKey(opt('key-signature')!) : keyName && vexKey(keyName) in ACCIDENTALS ? vexKey(keyName) : undefined;
if (keyName && keySignature && vexKey(keyName) in ACCIDENTALS && ACCIDENTALS[vexKey(keyName)] !== ACCIDENTALS[keySignature])
  console.log(`key ${keyName} under the signature of ${keySignature} — kept as given`);
const reading = {
  ...(opt('bar-offset') ? { barOffset } : {}),
  ...(meter ? { measureTicks, beatValue: Number(meter.split('/')[1]) } : {}),
  ...(keyName ? { keyName } : {}),
  ...(keySignature ? { keySignature } : {}),
  ...(composer ? { composer } : {}),
};
const keyChanges = (opt('key-change') ?? '')
  .split(',')
  .filter(Boolean)
  .map((change) => {
    const [bar, key] = change.split(':');
    return { tick: barOffset + (Number(bar) - 1) * measureTicks, key: vexKey(key) };
  });
if (keyChanges.length) Object.assign(reading, { keyChanges });

/**
 * Where the bar lines fall when nobody has said: on the eighth that most notes start on — when
 * the notes say so plainly.
 *
 * Counted from the song's first sound, Super Mario Bros.' song 4 put every note five ticks after
 * an eighth — its first sound is not on the beat — and each note that ends a bar was tied over the
 * bar line. The eighth most of a song's notes start on is its beat; the first bar line is moved
 * onto it, and what comes before is a pickup.
 *
 * Only by a clear margin, though: twice as many notes as start on the first sound's own eighth,
 * and three times when two voices or more open the song together — the plainest downbeat there is.
 * Taken on any lead, Darkwing Duck's theme — every voice striking its first note together, its
 * eighths spread almost evenly by a tempo that is not a whole number of frames — moved its bar
 * line two ticks on 180 notes against 153, opened on a whole bar of rests round a pickup of a
 * sixty-fourth, and a dozen tracks did the same on leads of a few per cent.
 */
function barLineOf(notes: readonly DecodedNote[], secondsPerTick: number): { barOffset?: number } {
  const EIGHTH = 8;
  const counts = new Array<number>(EIGHTH).fill(0);
  for (const n of notes) counts[((Math.round(n.start / secondsPerTick) % EIGHTH) + EIGHTH) % EIGHTH]++;
  let phase = 0;
  for (let p = 1; p < EIGHTH; p++) if (counts[p] > counts[phase]) phase = p;
  const together = new Set(notes.filter((n) => Math.round(n.start / secondsPerTick) === 0).map((n) => n.track)).size;
  const margin = together >= 2 ? 3 : 2;
  return phase > 0 && counts[phase] >= margin * counts[0] ? { barOffset: phase } : {};
}

/**
 * How many times faster than the quarter the beat a metre is counted in goes by — the workshop's
 * `countedBeat` (Score/layout.ts): a dotted quarter in 6/8, 9/8, 12/8, a dotted eighth in 6/16,
 * a dotted half in 6/4, a half in 2/2, else the quarter. The metronome's 40 to 208 are the
 * counted beat's: 12/8 at ♩. = 200 is ♩ = 300, and stays 12/8.
 */
function beatScale(measureTicks = 64, beatValue = 4): number {
  const quarters = measureTicks / 16;
  const eighths = measureTicks / 8;
  const sixteenths = measureTicks / 4;
  if (beatValue === 8 && eighths >= 6 && eighths % 3 === 0) return 16 / 24;
  if (beatValue === 16 && sixteenths >= 6 && sixteenths % 3 === 0) return 16 / 12;
  if (beatValue === 4 && quarters >= 6 && quarters % 3 === 0) return 16 / 48;
  if (beatValue === 2 && quarters === 4) return 16 / 32;
  return 1;
}

/**
 * The first sound a frame off the grid the rest of the song keeps — a frame of a driver starting
 * late or early: −1 when the rest stands a frame earlier on the rows than the first sound, +1
 * when a frame later, else 0. Metroid's title strikes its first chord on frame 0 and every bar
 * after it on 111, 223… of bars of 112: counted from the first sound, each bar line fell a tick
 * early, 63 and 127 for 64 and 128. Only one frame either way, only on rows of 3 frames or more,
 * and only when nearly every note says so — a pickup stands on the rows like the rest.
 */
function leadOf(notes: readonly DecodedNote[], from: number, hz: number, row: number): number {
  if (row < 3) return 0;
  const counts = new Array<number>(row).fill(0);
  for (const n of notes) {
    const frame = (n.start - from) * hz;
    if (frame < 0.5 || n.duration * hz <= 1.5) continue;
    counts[((Math.round(frame) % row) + row) % row]++;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  for (const [residue, lead] of [[row - 1, -1], [1, 1]] as const) {
    if (total >= 8 && counts[residue] >= 0.75 * total && counts[0] <= 0.1 * total) return lead;
  }
  return 0;
}

/** `--driver-tempo T[:phase]`, `--driver-modulus M`, `--driver-tempo-map F:T,…` — see `driverClock`. */
const driverTempo: DriverTempo | undefined = (() => {
  const given = opt('driver-tempo');
  if (!given) return undefined;
  for (const other of ['tempo', 'sixteenth', 'swing']) {
    if (opt(other)) {
      console.error(`--driver-tempo puts the notes on the driver's ticks: --${other} cannot be given with it`);
      process.exit(1);
    }
  }
  const [increment, phase = '0'] = given.split(':');
  // A tempo that adds nothing never ticks: `--driver-tempo 0:0` came out NaN without a word.
  const positive = (flag: string, text: string) => {
    const value = numberOf(flag, text);
    if (!(value > 0)) {
      console.error(`--${flag}: "${text}" — the driver must add more than nothing, to a modulus above 0`);
      process.exit(1);
    }
    return value;
  };
  return {
    increment: positive('driver-tempo', increment),
    phase: numberOf('driver-tempo', phase),
    modulus: positive('driver-modulus', opt('driver-modulus') ?? '256'),
    changes: (opt('driver-tempo-map') ?? '')
      .split(',')
      .filter(Boolean)
      .map((entry) => {
        // `F:T:phase` (or `F:T:reset`, a phase of 0): the driver's count starts again on frame F.
        const [frame, inc, reset] = entry.split(':');
        return {
          frame: numberOf('driver-tempo-map', frame),
          // 0 is a stall (Captain Planet's driver stands still a frame), not an error.
          increment: numberOf('driver-tempo-map', inc ?? ''),
          ...(reset !== undefined ? { phase: reset === 'reset' ? 0 : numberOf('driver-tempo-map', reset) } : {}),
        };
      }),
  };
})();
/** `--driver-quarter Q`: the driver's ticks to a quarter. */
const driverQuarter = numberOf('driver-quarter', opt('driver-quarter') ?? '16');

/** `--origin`: where tick 0 is (see the top). */
const originGiven = opt('origin');
if (originGiven !== undefined && !['sound', 'note', 'init'].includes(originGiven)) numberOf('origin', originGiven);
/** `--lead [F]`: F frames given, or found (`leadOf`) when the flag stands alone. */
const leadAt = args.lastIndexOf('--lead');
const leadGiven = leadAt >= 0 && /^[+-]?\d+(\.\d+)?$/.test(args[leadAt + 1] ?? '') ? Number(args[leadAt + 1]) : undefined;
const keepPhaseGiven = opt('keep-pulse-phase');
if (keepPhaseGiven !== undefined && !['on', 'off'].includes(keepPhaseGiven)) {
  console.error('--keep-pulse-phase: on or off');
  process.exit(1);
}

/** The voices of the expansion chips that the songs do write, for the last line. */
const EXPANSION_WRITES: [string, (address: number) => boolean][] = [
  ['FDS', (a) => a >= 0x4040 && a <= 0x408a],
  ['N163', (a) => a === 0x4800 || a === 0xf800],
  ['VRC6', (a) => (a >= 0x9000 && a <= 0x9002) || (a >= 0xa000 && a <= 0xa002) || (a >= 0xb000 && a <= 0xb002)],
  ['VRC7', (a) => a === 0x9010 || a === 0x9030],
  ['MMC5', (a) => a >= 0x5000 && a <= 0x5015],
  ['5B', (a) => a === 0xc000 || a === 0xe000],
];
const expansionWritten = new Set<string>();

for (const song of songs) {
  const hz = info.playHz;
  const listen = Math.max(LISTEN, seconds) + 1;
  const recorded = source.record(song, listen);
  for (const w of recorded.writes) for (const [chip, of] of EXPANSION_WRITES) if (of(w.address)) expansionWritten.add(chip);
  let notes = decode(recorded.writes, listen, hz);
  // The DMC's hits over the whole recording: a song may open on them alone.
  const allHits = dmcHits(recorded.writes, listen);
  if (notes.length === 0) {
    console.log(`song ${song}: silent — skipped`);
    // A file a run before wrote for it goes: Atlantis no Nazo's folder kept 20 tracks for 13 songs.
    if (removeTrack(out, idOf(song), `${String(idOf(song)).padStart(2, '0')}_song`)) console.log(`  its track from a run before removed`);
    continue;
  }
  /*
   * Tick 0: the first note, unless `--origin` says otherwise. Counted from it, the DMC's hits before
   * it are lost — Ultimate Stuntman's Title its opening drums, Contra Force's Player Select 42 frames
   * of them, Track & Field II's snare from INIT: `--origin sound` keeps them. A loop over many notes:
   * `Math.min(...)` of Pooyan's 360 Hz notes ran out of stack.
   */
  const firstNote = notes.reduce((least, n) => Math.min(least, n.start), Infinity);
  // A sample of one byte is no drum: INIT setting $4015 with $4013 at 0 (Road Fighter) clicks.
  const firstHit = allHits.reduce((least, hit) => (hit.length > 1 ? Math.min(least, hit.start) : least), Infinity);
  const origin = originGiven ?? 'note';
  let from = origin === 'init' ? 0 : origin === 'note' ? firstNote : origin === 'sound' ? Math.min(firstNote, firstHit) : Number(origin) / hz;
  const starts = notes.map((n) => n.start);
  // The driver's step up to `end`, for a loop's restart frame and a late first sound — on the song
  // as written: over many passes a pass a frame longer than its rows blurs them.
  // Counted from the first sound, as the grid is later: the rows' phase is searched in half frames.
  const rowOf = (begin: number, end: number, of: readonly DecodedNote[] = notes) =>
    detectGrid(of.filter((n) => n.start >= begin - 0.5 / hz && n.start < end).map((n) => ({ ...n, start: n.start - from })), hz).rowFrames;
  /*
   * `--loop [F:]L`: a loop of L frames from frame F of the first sound, given — for a tempo counter
   * whose loop is not a whole number of frames. Bad Dudes' Riding Stages comes back after 3780.5:
   * every sixth of the pass lands a frame early or late, the notes match at 92 per cent, short of
   * what findNoteLoop asks for, and it took five passes, 314 seconds, for one.
   */
  const given = opt('loop')?.split(':').map((part) => numberOf('loop', part));
  /*
   * Found, the loop is made the music's (`musicLoop`): the smallest period its notes repeat at,
   * a driver's restart frame left out, the start slid back while the notes before it repeat too.
   * When no loop holds every voice, the one with a loop of its own is left out of the search
   * (`loopWithoutVoice`) and the output says so.
   */
  let loop: (Loop & { passes?: number; restart?: boolean }) | null = null;
  let loopNote = '';
  if (given) loop = { start: from + (given.length > 1 ? given[0] : 0) / hz, seconds: given[given.length - 1] / hz, exact: false };
  else if (args.includes('--no-loop')) loopNote = '';
  else {
    const found = findLoop(recorded.writes, hz, listen, (a, b) => starts.some((t) => t >= a && t < b)) ?? findNoteLoop(notes, hz, listen);
    if (found) loop = musicLoop(found, notes, hz, rowOf(found.start, found.start + found.seconds));
    else {
      const partial = loopWithoutVoice(recorded.writes, notes, hz, listen);
      if (partial) {
        const rest = notes.filter((n) => n.track !== partial.without);
        loop = musicLoop(partial, rest, hz, rowOf(partial.start, partial.start + partial.seconds, rest));
        loopNote = `, without ${partial.without}: it loops on its own`;
      }
    }
    if (loop?.passes) loopNote += `, the writes repeat every ${loop.passes} passes`;
    if (loop?.restart) loopNote += ', less the restart frame';
  }
  const quiet = loop ? null : silenceAfter(notes, listen);
  // The intro and one pass of the loop; a loop that sets in before the first note starts with it.
  let loopFrom = loop ? Math.max(loop.start, from) : 0;
  let until = loop ? loopFrom + loop.seconds : quiet !== null ? quiet : from + seconds;
  // A first sound a frame off the rows the rest keep: the origin moved onto the rows, the notes of
  // the first sound pulled onto it. Only on a draft, or with `--lead`: a grid or a bar line given
  // by ear has placed the frame too — Challenger's chained loops stand a frame late after the
  // driver's switch, which its post-fix takes out, and moving the origin as well put the intro a
  // frame early; Dark Lord's Battle Won, retimed frame by frame afterwards, lost a note to it.
  const first = from;
  const byEar = ['bar-offset', 'sixteenth', 'tempo', 'driver-tempo', 'driver-tempo-map', 'origin'].some((name) => opt(name));
  // `--lead F`: the frames given — Hebereke's first noise a frame early, which no count of the rows found.
  const lead = leadGiven ?? (byEar && !args.includes('--lead') ? 0 : leadOf(notes.filter((n) => n.start < until), from, hz, rowOf(from, until)));
  /** Where the next pass's first sound stands in the recording: a note begun there is not this pass's. */
  let passEnd = until;
  if (lead) {
    from = first + lead / hz;
    /*
     * A loop's start given, `--loop F:L`, is counted from the origin, as every frame a flag takes:
     * Flipull's scripts gave 142 for the 144 they meant on `--lead -2`. A loop that starts with the
     * first sound starts on the origin, and its pass runs to a pass after it — the next pass's first
     * sound is as far off the rows as this one's: Master Chu's theme and boss, `--lead` a frame, cut
     * the G5 held into the restart a frame, a tick short of the loop's end.
     */
    if (loop) {
      const withFirst = !(given && given.length > 1 && given[0] > 0) && Math.abs(loopFrom - first) < 0.5 / hz;
      loopFrom = withFirst ? from : given && given.length > 1 ? Math.max(from + given[0] / hz, from) : loopFrom;
      until = loopFrom + loop.seconds;
      passEnd = withFirst ? first + loop.seconds : until;
    }
  }
  const firstInstant = (t: number) => t - first < 0.5 / hz;
  /** Where this pass's notes stop beginning. */
  const cut = passEnd < until ? passEnd - 0.5 / hz : until;
  /*
   * The notes of the first sound, pulled onto the origin, keep their end — a driver that strikes its
   * first notes late and lets them go on its rows (Flipull's first tick, short by the frames of its
   * catch-up) — or their length, when the rest of their voice says so: Metal Fighter writes all of
   * its first notes a frame early, the pulses' C4 and G4 15 frames as every one after them, and
   * pulled a frame later with their ends kept they came out 11 ticks for 12, the first drum 1 for 2.
   * Of the two lengths, the one more of the voice's later notes of the same key have; the end, if
   * neither.
   */
  const keepsLength = (n: DecodedNote) => {
    if (!lead) return false;
    const key = (x: DecodedNote) => (x.track === 'noise' ? x.periodIndex : x.midi);
    const near = (a: number, b: number) => Math.abs(a - b) <= 0.5 / hz;
    let length = 0;
    let end = 0;
    for (const x of notes) {
      if (x.track !== n.track || key(x) !== key(n) || firstInstant(x.start) || x.start >= cut) continue;
      if (near(x.duration, n.duration)) length++;
      else if (near(x.duration, n.duration - lead / hz)) end++;
    }
    return length > end;
  };
  // The pulses' phase, from the song's own writes — unless given (`--keep-pulse-phase`).
  const phaseKept = pulsePhaseKept(recorded.writes, notes, first, until, hz);
  const keepPulsePhase = keepPhaseGiven ? keepPhaseGiven === 'on' : phaseKept.keep;
  notes = notes
    .filter((n) => n.start >= first && n.start < cut)
    .map((n) => {
      const pulled = firstInstant(n.start);
      const start = pulled ? from : n.start;
      // A note that runs to the next pass's first sound runs to the end of the pass.
      const runsOn = passEnd < until && n.start + n.duration >= passEnd - 0.5 / hz;
      const end = Math.min(runsOn ? until : pulled && keepsLength(n) ? from + n.duration : n.start + n.duration, until);
      return { ...n, start: start - from, duration: end - start };
    });
  let length = until - from;
  // `--min-seconds S`: shorter than S is a sound effect — a driver that plays music and effects
  // by the same call numbers them in one row (RoboCop's $8003 takes both).
  if (opt('min-seconds') && length < Number(opt('min-seconds'))) {
    console.log(`song ${song}: ${length.toFixed(1)} s — an effect, left out`);
    if (removeTrack(out, idOf(song), `${String(idOf(song)).padStart(2, '0')}_song`)) console.log(`  its track from a run before removed`);
    continue;
  }
  // The DMC's hits, on the same clock as the notes; the samples they play, with their kind.
  let hits: DmcHit[] = dmcHits(recorded.writes, until)
    .filter((hit) => hit.start >= first && hit.start < cut)
    .map((hit) => ({ ...hit, start: (firstInstant(hit.start) ? from : hit.start) - from }));
  const samples: CollectedSample[] = [];
  for (const hit of hits) {
    if (samples.some((s) => s.address === hit.address && s.bytes.length === hit.length)) continue;
    const bytes = recorded.bytes.get(`${hit.address}:${hit.length}`);
    if (bytes) samples.push({ address: hit.address, bytes, kind: drumKindOf(bytes, hit.rate) });
  }
  /** Where the loop starts and how long a pass is, in seconds from the first sound. */
  let loopAt = loop ? loopFrom - from : 0;
  let loopSeconds = loop ? loop.seconds : 0;
  /*
   * `--driver-tempo`: every moment put on the driver's own clock — a start on the tick its frame
   * falls in, an end as far between two ticks as it is between their frames — and the clock's
   * ticks made even, each stretch of one tempo on its own grid of `--driver-quarter` ticks to
   * the quarter. Ten games' collections each took a converter of their own for this.
   */
  const clockStretches: { at: number; sixteenthFrames: number }[] = [];
  if (driverTempo) {
    /** The driver's increment on a frame, as `driverClock` takes it. */
    const incrementAt = (frame: number) => {
      let inc = driverTempo.increment;
      for (const change of [...driverTempo.changes].sort((a, b) => a.frame - b.frame)) if (change.frame <= frame) inc = change.increment;
      return inc;
    };
    // Two passes long: a pass's end may fall past the song's (below).
    const clock = driverClock(driverTempo, hz, Math.ceil((length + loopSeconds) * hz) + 2);
    const at = (t: number, how: ClockSnap) => clock.secondsOf(clock.ticksAt(t, how));
    // `--driver-ends floor|ceil|between`: where an end between two ticks goes (Double Dragon's
    // converter floored, WWF's took the next tick, Dragon Warrior's the place between).
    const ends = (opt('driver-ends') ?? 'between') as ClockSnap;
    if (!['floor', 'ceil', 'between'].includes(ends)) {
      console.error('--driver-ends: floor, ceil or between');
      process.exit(1);
    }
    // `--driver-starts first|last`: of the ticks a frame runs (a tempo above the modulus), the one a
    // start goes on — the last, unless the driver's own reads say the first (Wily & Light's Auction,
    // Rad Racer II): the frames alone cannot tell.
    const startsOn: ClockSnap = opt('driver-starts') === 'first' ? 'first' : 'floor';
    if (opt('driver-starts') && !['first', 'last'].includes(opt('driver-starts')!)) {
      console.error('--driver-starts: first or last');
      process.exit(1);
    }
    // A frame's gap before the next note of the voice is the driver letting go to strike again
    // (`writeCollection`'s legato) — closed in frames, before the clock, where it is a frame.
    const next = new Map<DecodedNote, number>();
    for (const track of new Set(notes.map((n) => n.track))) {
      const voice = notes.filter((n) => n.track === track).sort((a, b) => a.start - b.start);
      voice.forEach((n, i) => i + 1 < voice.length && next.set(n, voice[i + 1].start));
    }
    notes = notes.map((n) => {
      const start = at(n.start, startsOn);
      const gap = (next.get(n) ?? Infinity) - (n.start + n.duration);
      const end = gap > 0 && gap <= 1.5 / hz ? next.get(n)! : n.start + n.duration;
      return { ...n, start, duration: Math.max(0, at(end, ends) - start) };
    });
    hits = hits.map((hit) => {
      const start = at(hit.start, startsOn);
      return { ...hit, start, duration: Math.max(0, at(hit.start + hit.duration, ends) - start) };
    });
    // A pass of the loop is a whole number of the driver's ticks, and the song ends where it does.
    if (loop) {
      const startTick = clock.ticksAt(loopAt, 'floor');
      // The ticks the driver counts in the pass: what its accumulator gains over the pass's frames
      // (a frame cut in two counted in part) — not the ticks its ends fall on, which a frame running
      // two of them (Totally Rad) puts one or two out.
      const gained = (frame: number) => {
        let sum = 0;
        for (let f = 0; f < Math.floor(frame); f++) sum += incrementAt(f);
        return sum + (frame - Math.floor(frame)) * incrementAt(Math.floor(frame));
      };
      const near = (gained((loopAt + loopSeconds) * hz) - gained(loopAt * hz)) / driverTempo.modulus;
      /*
       * The pass as its two ends fell on the clock, unless one of the whole numbers of ticks either
       * side of what the accumulator gains is whole bars (rules 7 and 18): floored apart, Tyoujinrousenki
       * Warwolf's 780 frames (767.8 ticks) came out 767, Last Action Hero's 6451.2 frames 3583, and
       * Dragon Warrior II's Underground 1025 for 1024; The Guardian Legend's Corridors 7 & 8, found in
       * the notes at 2092.5 frames, 1152.5 ticks, is 1152. Neither being whole bars, the ends are
       * kept: 1999's Whack-a-Mole runs a tick late in a section and is a tick over its bars, as played.
       */
      const ends = clock.ticksAt(loopAt + loopSeconds, 'floor') - startTick;
      const wholeBars = (n: number) => ((n * 16) / driverQuarter) % measureTicks === 0;
      const whole = [ends, Math.floor(near), Math.ceil(near)].filter((n) => n > 0 && wholeBars(n)).sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
      const ticks = whole[0] ?? ends;
      loopAt = clock.secondsOf(startTick);
      loopSeconds = clock.secondsOf(startTick + ticks) - loopAt;
      length = loopAt + loopSeconds;
    } else length = at(length, 'floor');
    for (const stretch of clock.stretches) clockStretches.push({ at: stretch.at, sixteenthFrames: (stretch.secondsPerTick * hz * driverQuarter) / 4 });
  }
  const grid = detectGrid(notes, hz);
  const givenSixteenth = opt('sixteenth') ? numberOf('sixteenth', opt('sixteenth')!) : clockStretches.length ? clockStretches[0].sixteenthFrames : undefined;
  if (givenSixteenth) {
    grid.sixteenthFrames = givenSixteenth;
    grid.bpm = (60 * hz) / (grid.sixteenthFrames * 4);
  }
  /*
   * A beat a metronome can beat: 40 to 208 a minute, Maelzel's scale — counted in the metre's
   * beat (`beatScale`). The step a found grid stands on is a sixteenth only at such a tempo —
   * Chip 'n Dale 2's Freezer moves in steps of 2.5 frames, which as sixteenths read "♩ = 360";
   * they are thirty-seconds at 180. A grid given (`--sixteenth`, the driver's clock) is kept: it
   * was halved to 6 and 8 frames from 3 and 4, and the notes a finer grid kept were lost again.
   * Its tempo is brought into the range in how it is written, after the grid is settled (below).
   */
  const scale = beatScale(reading.measureTicks, reading.beatValue);
  if (!opt('tempo') && givenSixteenth === undefined) {
    while (grid.bpm * scale > METRONOME.fastest) {
      grid.sixteenthFrames *= 2;
      grid.bpm /= 2;
    }
    while (grid.bpm * scale < METRONOME.slowest) {
      grid.sixteenthFrames /= 2;
      grid.bpm *= 2;
    }
  }
  /*
   * `--tempo F:S,F:S…`: a tempo map, given — from frame F after the song's first sound on, a
   * sixteenth lasts S frames. For a driver with no tempo of its own: Tim Follin's in Terminator 2
   * loads each note's length in frames, and Level 2/4 runs its first part swung on a 24-frame beat
   * (sixteenths of 6) and its second, after thirty-five seconds of silence, on sixteenths of 8.
   * On one grid its loop came out 3007 steps of four frames, which no bar divides; on the two it
   * is 44 bars and 61. The stretches are found by ear and by the notes (`probe` work), not here:
   * a window-by-window search could not tell a beat from its half.
   */
  const stretches = (opt('tempo') ?? '')
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [frame, sixteenth] = entry.split(':').map((part) => numberOf('tempo', part));
      return { at: frame / hz, sixteenthFrames: sixteenth };
    })
    .sort((a, b) => a.at - b.at);
  stretches.push(...clockStretches);
  if (stretches.length > 0) {
    grid.sixteenthFrames = stretches[0].sixteenthFrames;
    grid.bpm = (60 * hz) / (grid.sixteenthFrames * 4);
  }
  /*
   * The tempo marked — and whether it is counted in halves — is the one the song goes at, when one
   * stretch of the map holds more than half its ticks, not the first: Gradius II's Take Care
   * (`0:3,3:6`) was marked ♩300 and 2/2 for a three-frame run-up, Parodius Da!'s Crisis ♩75 for
   * ♩180. A map with no such stretch — a rubato, Yie Ar Kung-Fu's Game Over phrase by phrase — keeps
   * its first, of those that hold a tick: a stretch of no ticks at all set the tempo of Adventures in
   * the Magic Kingdom's songs (Big Thunder Mountain ♩187.5, a frame of INIT's clock, for ♩143.9).
   * Ticks are counted inside the song: a recording's later passes run on past it.
   * The stretch marked must be one a metronome beats (`markedStretch`).
   */
  if (stretches.length > 1) {
    const halvable = ((reading.measureTicks ?? 64) === 64 && (reading.beatValue ?? 4) === 4) || (reading.measureTicks === 96 && reading.beatValue === 8);
    const marked = markedStretch(stretches, length, hz, scale, halvable ? 2 : 1, METRONOME);
    grid.bpm = (60 * hz) / (stretches[marked].sixteenthFrames * 4);
  }
  /*
   * `--swing F:P:eighths|sixteenths`: a shuffle, written as people write one — 4/4, straight
   * eighths (or sixteenths) and "Swing" over the score — and played as it sounds. Every F frames
   * from frame P after the first sound is a pair, a long note of two thirds and a short of one:
   * Darkwing Duck's Theme, noise on 0 and 10 of every 15 frames from frame 1. Each pair is written
   * as two straight halves, and the tempo map runs its first half twice as long as its second, so
   * every note sounds when it did. A pair with a note on its third is a triplet, not a swing: it
   * is counted evenly, three to the pair. Starts and ends within a frame and a half of a place the
   * pair has (0, ⅔ — or the thirds) are put on it: the driver strikes a frame either side.
   */
  const swing = opt('swing');
  if (swing) {
    // `:L-S` after the level: a long and a short of L to S (`12-8`, 3:2) — 2-1 unless given.
    const [pairFrames, phaseFrames, level, ratio = '2-1'] = swing.split(':');
    const F = Number(pairFrames);
    const phase = Number(phaseFrames ?? 0);
    const [longPart, shortPart] = ratio.split('-').map((part) => numberOf('swing', part));
    /** The long note's share of the pair. */
    const r = longPart / (longPart + shortPart);
    const Q = level === 'eighths' ? 16 : 8; // ticks a pair is written in
    const pairs = Math.ceil((length * hz - phase) / F) + 1;
    /** The pair's start in frames — pair -1 holds what sounds before the phase. */
    const pairAt = (k: number) => phase + k * F;
    const pairOf = (frame: number) => Math.floor((frame - phase) / F);
    const NEAR = 1.5;
    const triplet = new Set<number>();
    for (const n of notes) {
      const frame = n.start * hz;
      const k = pairOf(frame);
      const x = (frame - pairAt(k)) / F;
      if (Math.abs(x - 1 / 3) * F <= NEAR) triplet.add(k);
    }
    const snapFrame = (frame: number) => {
      const k = pairOf(frame + NEAR);
      const places = triplet.has(k) ? [0, 1 / 3, 2 / 3, 1] : [0, r, 1];
      for (const place of places) {
        const at = pairAt(k) + place * F;
        if (Math.abs(frame - at) <= NEAR) return Math.max(0, at);
      }
      return frame;
    };
    notes = notes.map((n) => {
      const start = snapFrame(n.start * hz);
      const end = snapFrame((n.start + n.duration) * hz);
      return { ...n, start: start / hz, duration: Math.max(1, end - start) / hz };
    });
    // A tick of the long half lasts rF over Q/2 ticks (2F/3 in a 2-1 swing); written as a sixteenth's frames, ×4.
    for (let k = -1; k < pairs; k++) {
      const at = Math.max(0, pairAt(k));
      if (triplet.has(k)) stretches.push({ at: at / hz, sixteenthFrames: (4 * F) / Q });
      else {
        stretches.push({ at: at / hz, sixteenthFrames: (8 * r * F) / Q });
        const half = pairAt(k) + r * F;
        if (half > 0) stretches.push({ at: half / hz, sixteenthFrames: (8 * (1 - r) * F) / Q });
      }
    }
    stretches.sort((a, b) => a.at - b.at);
    for (let i = stretches.length - 1; i > 0; i--) if (stretches[i].at === stretches[i - 1].at) stretches.splice(i - 1, 1);
    // The tempo marked is the pairs', as if straight: a pair is Q ticks of F frames.
    grid.sixteenthFrames = (4 * F) / Q;
    grid.bpm = (60 * hz) / (grid.sixteenthFrames * 4);
  }
  /** The stretch a moment falls in, and the length of a tick there. */
  const stretchAt = (t: number) => {
    let at = stretches[0];
    for (const stretch of stretches) if (stretch.at <= t + 1e-9) at = stretch;
    return at;
  };

  /*
   * Fine enough that no two notes of one voice land on one tick — the collection keeps one note a
   * tick a voice, and the other is gone without a word. RoboCop 3's title runs a passage of notes
   * three and four frames long on a grid of 3.5 frames a tick, half a tick off it: they stood at
   * .43 and .57 of a tick and rounded in pairs onto the same one, so every other note went, the
   * line was left with the wrong intervals, and the echo on pulse 2 kept the notes pulse 1 lost.
   * First the grid's phase is taken out — where the notes sit in a tick, on average — and if notes
   * still meet, the grid is made twice as fine (the durations double and the tempo with them, as
   * Alien 3's title was read by ear). A splinter shorter than three quarters of a tick — a step of
   * an arpeggio — is not counted here: those are one note on paper. Every note that does go, a
   * splinter or not, on any grid, is counted where the collection drops it (`writeCollection`'s
   * `lost`) and reported.
   */
  let tickShift = 0;
  if (!opt('quantize') && stretches.length === 0) {
    // A note is one that lasts three quarters of a tick of the grid as found — the same notes
    // whatever the grid is made into; on a finer one an arpeggio's steps would start to count.
    const least = (0.75 * grid.sixteenthFrames) / 4 / hz;
    const collisions = (spt: number, shift: number) => {
      const seen = new Set<string>();
      let count = 0;
      for (const n of notes) {
        if (n.duration < least) continue;
        const key = `${n.track}:${Math.round((n.start - shift) / spt)}`;
        if (seen.has(key)) count++;
        seen.add(key);
      }
      return count;
    };
    // On the notes that count, as the collisions are: an arpeggio's splinters pull the phase off.
    const phaseOf = (spt: number) => {
      let c = 0;
      let s = 0;
      for (const n of notes) {
        if (n.duration < least) continue;
        const angle = (2 * Math.PI * n.start) / spt;
        c += Math.cos(angle);
        s += Math.sin(angle);
      }
      return (Math.atan2(s, c) / (2 * Math.PI)) * spt;
    };
    // Once at most: a grid four times finer writes every note in values a reader cannot take in,
    // for the sake of a handful — Terminator 2's title went to 360 a minute over seven notes in 3500.
    for (let halvings = 0; halvings < 2; halvings++) {
      const spt = grid.sixteenthFrames / 4 / hz;
      if (collisions(spt, 0) === 0) break;
      const shift = phaseOf(spt);
      if (collisions(spt, shift) === 0) {
        tickShift = shift;
        break;
      }
      // `--keep-grid`: the step as given, its collisions counted — a song re-collected on the grid
      // it was read on, where a few new notes are not worth every value of the piece halved. A grid
      // given with `--sixteenth` is kept the same way, as the flag says: Cowboy Kid's Storehouse,
      // `--sixteenth 5`, went to 2.5 frames and ♩360 in 2/2 for a few attack splinters.
      if (halvings === 1 || args.includes('--keep-grid') || givenSixteenth !== undefined) break;
      grid.sixteenthFrames /= 2;
      grid.bpm *= 2;
      tickShift = phaseOf(grid.sixteenthFrames / 4 / hz);
    }
    if (tickShift !== 0) {
      const move = (t: number) => Math.max(0, t - tickShift);
      notes = notes.map((n) => ({ ...n, start: move(n.start) }));
      hits = hits.map((hit) => ({ ...hit, start: move(hit.start) }));
    }
  }
  /*
   * `--quantize N`: every start and end put on the nearest N ticks of the grid, after the grid's
   * own phase — where the notes sit in a step, on average — is taken out.
   *
   * For a driver whose tempo is not a whole number of frames. Capcom's keeps a fractional counter
   * and strikes each row on the frame it falls in, so on a grid of the true step the notes of
   * Darkwing Duck's Quackerjack's Bridge stood 0.1 to 0.2 of an eighth late, give or take 0.15 —
   * a tick or two either way, which the score wrote as rests of a sixty-fourth between every
   * other pair of notes. Off unless asked for: on a driver that keeps whole frames the grid is
   * already exact, and the tick a note really starts on is worth keeping.
   */
  const quantum = opt('quantize') ? (Number(opt('quantize')) * grid.sixteenthFrames) / 4 / hz : 0;
  let snap = (t: number) => t;
  if (quantum > 0 && stretches.length > 0) {
    // On a tempo map each stretch is quantized on its own grid, from its own start.
    const ticks = Number(opt('quantize'));
    snap = (t: number) => {
      const stretch = stretchAt(t);
      const q = (ticks * stretch.sixteenthFrames) / 4 / hz;
      return stretch.at + Math.round((t - stretch.at) / q) * q;
    };
    const step = (t: number) => (ticks * stretchAt(t).sixteenthFrames) / 4 / hz;
    notes = notes.map((n) => {
      const start = snap(n.start);
      return { ...n, start, duration: Math.max(step(start), snap(n.start + n.duration) - start) };
    });
    hits = hits.map((hit) => {
      const start = snap(hit.start);
      return { ...hit, start, duration: Math.max(step(start), snap(hit.start + hit.duration) - start) };
    });
  } else if (quantum > 0) {
    let c = 0;
    let s = 0;
    for (const n of notes) {
      const angle = (2 * Math.PI * n.start) / quantum;
      c += Math.cos(angle);
      s += Math.sin(angle);
    }
    const phase = (Math.atan2(s, c) / (2 * Math.PI)) * quantum;
    snap = (t: number) => Math.max(0, Math.round((t - phase) / quantum) * quantum);
    notes = notes.map((n) => {
      const start = snap(n.start);
      return { ...n, start, duration: Math.max(quantum, snap(n.start + n.duration) - start) };
    });
    hits = hits.map((hit) => {
      const start = snap(hit.start);
      return { ...hit, start, duration: Math.max(quantum, snap(hit.start + hit.duration) - start) };
    });
  }
  // The bar line where most notes begin, not at the song's first sound — unless given by ear.
  const barred = opt('bar-offset') ? reading : { ...reading, ...barLineOf(notes, grid.sixteenthFrames / 4 / hz) };
  // A swing is marked over the score; the map that plays it is no change of tempo to print.
  const found = swing ? { ...barred, swing: true } : barred;
  /*
   * The tempo as written, after the grid is settled — a grid given, or made finer to keep its
   * notes, can leave the beat past a metronome: then the piece is counted in halves — 4/4 as 2/2,
   * 12/8 as 6/4 — the notes as they are, the beat one a player keeps. The beat is the metre's
   * (`beatScale`): 12/8 at ♩. = 200 stays 12/8. A tempo map given with `--tempo` is counted the
   * same way, by its first stretch: `--tempo 0:4` is ♩225, written 2/2.
   */
  const counted = (r: { measureTicks?: number; beatValue?: number }) => grid.bpm * beatScale(r.measureTicks, r.beatValue);
  const halves =
    (found.measureTicks ?? 64) === 64 && (found.beatValue ?? 4) === 4
      ? { ...found, measureTicks: 64, beatValue: 2 }
      : found.measureTicks === 96 && found.beatValue === 8
        ? { ...found, beatValue: 4 }
        : null;
  const own = counted(found) <= METRONOME.fastest || !halves ? found : halves;
  const unbeatable = counted(own) > METRONOME.fastest || counted(own) < METRONOME.slowest;
  const written = writeCollection(
    out,
    {
      id: idOf(song),
      slug: `${String(idOf(song)).padStart(2, '0')}_song`,
      name: `${info.title} — ${source.name(song) ?? `song ${song}`}`,
      reading: own,
      source: `${source.origin}, played song by song and decoded from the sound chip — local research`,
      ...(keepPulsePhase ? { keepPulsePhase } : {}),
    },
    notes,
    length,
    grid,
    hz,
    { hits, samples },
    loop ? { start: snap(Math.max(0, loopAt - tickShift)), seconds: loopSeconds } : null,
    stretches.length > 1
      ? stretches.map((stretch) => ({ at: stretch.at, secondsPerTick: stretch.sixteenthFrames / 4 / hz }))
      : undefined
  );
  console.log(
    `song ${String(song).padStart(2)}: ${length.toFixed(1).padStart(5)} s${loop ? ` (loop ${(loopFrom - from).toFixed(1)} s + ${loop.seconds.toFixed(1)} s, ${Math.round(loop.seconds * hz)}f${loop.exact || loop.passes || loop.restart ? '' : given ? ', given' : ', by notes'}${loopNote})` : quiet !== null ? ' (ends)' : ' (cut) '}  row ${grid.rowFrames}f, sixteenth ${Number(grid.sixteenthFrames.toFixed(3))}f → ♩ ${grid.bpm.toFixed(1).padStart(6)}${own !== found ? ` (counted in halves, ${own.beatValue === 2 ? '2/2' : '6/4'})` : ''}${unbeatable ? ' — past a metronome even so' : ''}  ${written.pitched} notes, ${written.drums} drums${hits.length ? `, ${hits.length} samples (${samples.map((s) => s.kind).join(' ')})` : ''}${own.barOffset ? `, bar line ${own.barOffset} ticks in` : ''}${lead ? `, the first sound a frame ${lead < 0 ? 'late' : 'early'}` : ''}${written.lost ? `, ${written.lost} notes lost on shared ticks` : ''}${written.merged ? `, ${written.merged} pieces of the same pitch merged on their tick` : ''}${written.unread ? `, ${written.unread} DMC hits lost (their sample unread)` : ''}${keepPulsePhase ? `, pulse phase kept${keepPhaseGiven ? ' (given)' : ` (${phaseKept.evidence} notes slide without a restart)`}` : ''}${from < firstNote - 0.5 / hz && origin === 'sound' ? `, opens on the DMC ${Math.round((firstNote - from) * hz)}f before the first note` : ''}${firstHit < from - 0.5 / hz ? `, DMC hits from ${Math.round((from - firstHit) * hz)}f before tick 0 left out (--origin sound keeps them)` : ''}${loop && opt('seconds') ? `, --seconds not used: the loop sets the length` : ''}${givenTwice.length ? `; ${givenTwice.join('; ')}` : ''}`
  );
}
if (info.expansion.length || expansionWritten.size) console.log(`expansion written: ${[...expansionWritten].join(' ') || 'none'}${info.expansion.length ? ` (the header says ${info.expansion.join(' ')})` : ''}`);
console.log(`→ ${out}`);
