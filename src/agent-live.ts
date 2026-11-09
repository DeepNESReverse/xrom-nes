/**
 * The agent, live: started by fceux/nes_music_probe.lua with the session's folder, it reads the
 * probe's events.log as it grows and drives the game through commands.log. Stage 3: it finds
 * how the driver starts a song and makes it play every song it has.
 *
 *   1. Wait for a song to start: $4015 written with channels enabled (a K line), with the chain
 *      of calls on the stack, and a save state kept from just before it (a P line).
 *   2. Learn: replay that start twice with every call in the chain hooked — the registers each
 *      entry is called with, and whether a replay is exact (it should be: same state, no input).
 *   3. Find the argument: for each entry, innermost first, and each of A, X, Y, replay with the
 *      register one higher. The music that changes says which entry takes which register.
 *   4. Go through the values: replay with every value 0-255 in that register for a few seconds,
 *      and sort what plays — a new song, one already heard, silence, or the hook never reached.
 *
 * Songs are told apart by what the driver writes to the chip ($4000-$4013) from the moment the
 * entry runs: replays from one state are exact, so the same song writes the same bytes.
 * Everything goes to <session>/tracks.json, and the panel shows where the agent is.
 */

import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { audible } from './agent/listen.ts';
import { dispatcher, readDump, songTables, type SongTables } from './agent/driver.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: agent-live.ts <session dir> (started by nes_music_probe.lua)');
  process.exit(1);
}
const EVENTS = join(dir, 'events.log');
const COMMANDS = join(dir, 'commands.log');

/** Frames each experiment runs: enough for a song's opening to tell it from the others. */
const TRY_FRAMES = 240;
/** Values in a row that bring nothing new before the search stops. */
const GIVE_UP_AFTER = 48;
/** Wall-clock seconds an experiment may take before the agent decides the emulator is stuck. */
const TRY_TIMEOUT = 180;

const log = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);
const send = (line: string) => appendFileSync(COMMANDS, line + '\n');
const status = (text: string) => {
  log(text);
  send(`status ${text}`);
};
const hex = (n: number, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

// ---------------------------------------------------------------- events, read as they come

type Event =
  | { t: 'W'; frame: number; address: number; value: number; pc: number }
  | { t: 'S'; frame: number; heard: number }
  | { t: 'K'; frame: number; pc: number; chain: { jsr: number; target: number }[] }
  | { t: 'P'; start: number; state: number }
  | { t: 'C'; frame: number; chain: { jsr: number; target: number }[] }
  | { t: 'X'; frame: number; entry: number; a: number; x: number; y: number; how: string }
  | { t: 'T'; frame: number; id: string; what: string; rest: string[] };

const events: Event[] = [];

/** `jsr>target,…` (innermost first), or `-`. */
const chainOf = (text: string | undefined) =>
  (text ?? '-') === '-'
    ? []
    : text!.split(',').map((c) => {
        const [jsr, target] = c.split('>').map((x) => parseInt(x, 16));
        return { jsr, target };
      });
let offset = 0;
let partial = '';

function readNew(): number {
  if (!existsSync(EVENTS)) return 0;
  const size = statSync(EVENTS).size;
  if (size <= offset) return 0;
  const fd = openSync(EVENTS, 'r');
  const buffer = Buffer.alloc(size - offset);
  readSync(fd, buffer, 0, buffer.length, offset);
  closeSync(fd);
  offset = size;
  const text = partial + buffer.toString('utf8');
  const lines = text.split('\n');
  partial = lines.pop() ?? '';
  let added = 0;
  for (const line of lines) {
    const f = line.split(' ');
    switch (f[0]) {
      case 'W':
        events.push({ t: 'W', frame: +f[1], address: parseInt(f[3], 16), value: parseInt(f[4], 16), pc: parseInt(f[5], 16) });
        break;
      case 'S': {
        // Channels FCEUX hears, as a count: pulses, triangle, noise, DMC.
        let heard = 0;
        for (const v of f.slice(2)) {
          const [volume, frequency] = v.split(':').map(Number);
          if (audible({ volume, frequency })) heard++;
        }
        events.push({ t: 'S', frame: +f[1], heard });
        break;
      }
      case 'K':
        events.push({
          t: 'K',
          frame: +f[1],
          pc: parseInt(f[2], 16),
          chain: chainOf(f[7]),
        });
        break;
      case 'P':
        events.push({ t: 'P', start: +f[1], state: +f[2] });
        break;
      case 'C':
        events.push({ t: 'C', frame: +f[1], chain: chainOf(f[3]) });
        break;
      case 'X':
        events.push({ t: 'X', frame: +f[1], entry: parseInt(f[2], 16), a: parseInt(f[3], 16), x: parseInt(f[4], 16), y: parseInt(f[5], 16), how: f[6] });
        break;
      case 'T':
        events.push({ t: 'T', frame: +f[1], id: f[2], what: f[3], rest: f.slice(4) });
        break;
      default:
        continue;
    }
    added++;
  }
  return added;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `test` finds something in the events, reading as they come. */
async function until<T>(test: () => T | undefined, seconds = Infinity): Promise<T | undefined> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    readNew();
    const found = test();
    if (found !== undefined) return found;
    if (Date.now() > deadline) return undefined;
    await sleep(150);
  }
}

// ---------------------------------------------------------------- experiments

interface TryResult {
  id: string;
  /** The entry's registers as it ran (after the override). */
  hit?: { frame: number; a: number; x: number; y: number };
  /** Hash of the chip writes from the hit to the end, and how many. */
  fingerprint: string;
  writes: number;
  /** Frames FCEUX heard a channel on, of those after the hit. */
  heardFrames: number;
  frames: number;
  /** Another song start inside the window — the game moving on by itself. */
  interruptedAt?: number;
  /** Every chip write up to that, as frame-after-the-hit:address:value — for `likeness`. */
  keys: string[];
  unhit: boolean;
  error?: string;
  /** Every call of a hooked entry in the replay's first frames, in order — how the start is made. */
  calls?: { entry: number; frame: number; a: number; x: number; y: number }[];
}

let tryCounter = 0;

/** A song asked for through RAM: the cell, its value when empty, and which request is the song. */
interface Mailbox {
  addr: number;
  empty: number;
  nth: number;
}

type Fixed = Partial<Record<'a' | 'x' | 'y', number>>;

async function runTry(start: number, entry: number, reg: 'a' | 'x' | 'y', value: number | 'keep', nth = 1, box?: Mailbox, fixed?: Fixed): Promise<TryResult> {
  const id = `t${++tryCounter}`;
  const from = events.length;
  const v = value === 'keep' ? 'keep' : hex(value);
  if (box) send(`try ${id} ${start} ${hex(entry, 4)} ram:${hex(box.addr, 3)}:${hex(box.empty)}:${box.nth} ${v} ${TRY_FRAMES}`);
  else {
    const more = Object.entries(fixed ?? {}).map(([r, n]) => `+${r}=${hex(n as number)}`).join('');
    send(`try ${id} ${start} ${hex(entry, 4)} ${reg}${more} ${v} ${TRY_FRAMES} ${nth}`);
  }
  const end = await until(() => events.slice(from).find((e) => e.t === 'T' && e.id === id && (e.what === 'end' || e.what === 'error')), TRY_TIMEOUT);
  const none = { fingerprint: '', writes: 0, heardFrames: 0, frames: 0, keys: [] as string[] };
  if (!end || end.t !== 'T') return { id, ...none, unhit: true, error: 'no answer from the emulator' };
  if (end.what === 'error') return { id, ...none, unhit: true, error: end.rest.join(' ') };
  const span = events.slice(from, events.indexOf(end) + 1);
  const hitEvent = span.find((e) => e.t === 'X' && e.entry === entry && e.how !== 'seen');
  const hit = hitEvent && hitEvent.t === 'X' ? { frame: hitEvent.frame, a: hitEvent.a, x: hitEvent.x, y: hitEvent.y } : undefined;
  if (!hit) return { id, ...none, unhit: true };
  // The entry's calls around the start, the overridden one among them.
  const calls = span
    .filter((e): e is Extract<Event, { t: 'X' }> => e.t === 'X' && e.frame >= hit.frame && e.frame <= hit.frame + 1)
    .map((e) => ({ entry: e.entry, frame: e.frame, a: e.a, x: e.x, y: e.y }));
  // From the entry's first call on — the same anchor whichever call is overridden: what the
  // driver wrote, and what FCEUX heard.
  const anchor = span.find((e) => e.t === 'X' && e.entry === entry && e.frame === hit.frame) ?? hitEvent!;
  let h = 0x811c9dc5;
  let writes = 0;
  let heardFrames = 0;
  let frames = 0;
  let interruptedAt: number | undefined;
  const keys: string[] = [];
  const hitIndex = span.indexOf(anchor);
  for (const e of span.slice(hitIndex)) {
    // What the game plays after starting another song by itself is not this value's song.
    if (interruptedAt !== undefined) break;
    if (e.t === 'W' && e.address <= 0x4013) {
      keys.push(`${e.frame - hit.frame}:${e.address}:${e.value}`);
      for (const byte of [e.address & 0xff, e.value]) {
        h ^= byte;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      writes++;
    } else if (e.t === 'S') {
      frames++;
      if (e.heard > 0) heardFrames++;
    } else if (e.t === 'K' && e.frame > hit.frame + 2 && interruptedAt === undefined) {
      interruptedAt = e.frame - hit.frame;
    }
  }
  return { id, hit, fingerprint: h.toString(16).padStart(8, '0'), writes, heardFrames, frames, interruptedAt, keys, calls, unhit: end.rest.includes('unhit') };
}

// ---------------------------------------------------------------- the plan

/**
 * How alike two experiments' chip writes are, 0..1: the share of writes (frame after the hit,
 * register, value) both made. One song replayed is 1. A register that only tunes the song —
 * Darkwing Duck's X at $80D8 added a write per step, 198, 199, 200 — stays near 1; another song
 * is far lower. A bare "the fingerprint differs" took that tuning for 132 songs.
 */
function likeness(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const count = new Map<string, number>();
  for (const k of a) count.set(k, (count.get(k) ?? 0) + 1);
  let both = 0;
  for (const k of b) {
    const n = count.get(k) ?? 0;
    if (n > 0) {
      both++;
      count.set(k, n - 1);
    }
  }
  return both / Math.max(a.length, b.length);
}

/** Below this, a value's music is another song's. */
const OTHER_MUSIC = 0.6;
/** Above this, it is the same song, tuned. */
const SAME_SONG = 0.85;

/** The values tried for an argument besides the one the game passed: near it, and spread out. */
const probeValues = (original: number) =>
  [...new Set([original + 1, original - 1, original + 2, 1, 2, 3, 4, 8, 0x10, 0x20, 0x40, 0x80].map((v) => v & 0xff))].filter((v) => v !== original);

interface Argument {
  entry: number;
  reg: 'a' | 'x' | 'y';
  original: number;
  /**
   * The driver entry the game called on the way, when it is not `entry` itself, with the registers
   * it was called with — what the dump player starts a song from (see `StartCall`).
   */
  via?: { entry: number; a: number; x: number; y: number };
  /** Which call of `entry` in the start's frame takes the song, 1 first (Alien 3: the fifth). */
  nth?: number;
  /** All the calls of the entry the game called (via, else entry) that make the start, in order. */
  calls?: { a: number; x: number; y: number }[];
  /** The song asked for through a RAM cell the entry reads, not a register (`reg` then unused). */
  mailbox?: Mailbox;
  /** Registers set beside `reg`: the routine of a dispatcher entry (see `dispatcher`). */
  fixed?: Fixed;
}

/**
 * RAM cells that act as a mailbox for the driver: one value nearly always (empty), something else
 * for a frame now and then, and a call of the driver's entry the frame after — Alien 3's $A7, $FF
 * but for the song number the game leaves there for its sound routine to pick up. Read off the
 * probe's RAM snapshots (row r is the RAM after frame r + 1).
 */
function mailboxes(entry: number): (Mailbox & { share: number })[] {
  const file = join(dir, 'ram.bin');
  if (!existsSync(file)) return [];
  const ram = readFileSync(file);
  const frames = Math.floor(ram.length / 0x800);
  const called = new Set<number>();
  for (const e of events) if (e.t === 'X' && e.entry === entry) called.add(e.frame);
  // Only the frames since the entry was hooked: before that, its calls were not reported.
  const since = Math.max(0, Math.min(...called) - 1);
  const out: (Mailbox & { share: number })[] = [];
  for (let addr = 0; addr < 0x800; addr++) {
    if (addr >= 0x100 && addr < 0x200) continue; // the stack
    const count = new Map<number, number>();
    for (let r = since; r < frames; r++) count.set(ram[r * 0x800 + addr], (count.get(ram[r * 0x800 + addr]) ?? 0) + 1);
    const [empty, emptyFrames] = [...count].sort((p, q) => q[1] - p[1])[0];
    const full = frames - since - emptyFrames;
    if (full < 2 || full > (frames - since) * 0.05) continue;
    let before = 0;
    for (let r = since; r < frames; r++) if (ram[r * 0x800 + addr] !== empty && called.has(r + 2)) before++;
    const share = before / full;
    if (share >= 0.5) out.push({ addr, empty, nth: 1, share });
  }
  return out.sort((p, q) => q.share - p.share).slice(0, 3);
}

/** What a mailbox held, in order, over a replay's frames: the requests the game made in it. */
function requestsIn(box: { addr: number; empty: number }, from: number, to: number): number[] {
  const file = join(dir, 'ram.bin');
  if (!existsSync(file)) return [];
  const ram = readFileSync(file);
  const out: number[] = [];
  for (let frame = from; frame <= to; frame++) {
    const v = ram[(frame - 1) * 0x800 + box.addr];
    if (v !== undefined && v !== box.empty) out.push(v);
  }
  return out;
}

/**
 * Up the chain from `entry` while the caller is in the same half of the address space — the
 * driver's own code — to the entry the game itself called: Capcom's $8106 is called from $8100,
 * reached from the game's JSR $8003 at $C0F0.
 */
function outerEntry(chain: { jsr: number; target: number }[], entry: number): number {
  let at = chain.findIndex((c) => c.target === entry);
  if (at < 0) return entry;
  const half = (address: number) => address >= 0xc000;
  while (at + 1 < chain.length && half(chain[at].jsr) === half(entry) && chain[at].jsr >= 0x6000) at++;
  return chain[at].target;
}

type Start = Extract<Event, { t: 'K' }>;

/**
 * One song start: replay it, then for each call on the stack and each register, replay it with
 * other values until the music is another song. Null when no register of any call does that —
 * the start was a sound effect, a jingle's tail, a reset.
 */
async function examine(k: Start): Promise<{ argument: Argument; base: TryResult; exact: boolean; candidates: number[] } | null> {
  const candidates = [...new Map(k.chain.map((c) => [c.target, c])).values()].map((c) => c.target);
  log(`song start on frame ${k.frame} at $${hex(k.pc, 4)}; calls on the stack: ${k.chain.map((c) => `$${hex(c.jsr, 4)}→$${hex(c.target, 4)}`).join(', ')}`);
  send('speed maximum');
  for (const c of candidates) send(`hook ${hex(c, 4)}`);
  status(`learning the start on frame ${k.frame}`);
  const base = await runTry(k.frame, candidates[0], 'a', 'keep');
  const again = await runTry(k.frame, candidates[0], 'a', 'keep');
  if (!base.hit) {
    log(`  the entry $${hex(candidates[0], 4)} was not reached on replay (${base.error ?? 'unhit'})`);
    return null;
  }
  const exact = base.fingerprint === again.fingerprint;
  log(`  replay ${exact ? 'is exact' : 'is NOT exact — results below are weaker'} (${base.writes} writes)`);
  if (base.writes < 20) {
    log('  next to nothing written after it: not a song');
    return null;
  }
  const entered = new Map<number, { a: number; x: number; y: number }>();
  for (const e of events) if (e.t === 'X' && e.frame >= k.frame - 1 && candidates.includes(e.entry) && !entered.has(e.entry)) entered.set(e.entry, { a: e.a, x: e.x, y: e.y });
  // Each entry's calls in the start's frames, from the learning replay — most starts are one call,
  // Alien 3's is five calls of $8003.
  const callsOf = (entry: number) => (base.calls ?? []).filter((c) => c.entry === entry).slice(0, 8);
  // No register names the song: perhaps a RAM cell does — a request the game leaves for its sound
  // routine, which is called every frame and looks in it (Alien 3).
  const byMailbox = async (): Promise<Awaited<ReturnType<typeof examine>>> => {
  const window = events.filter((e): e is Extract<Event, { t: 'T' }> => e.t === 'T' && (e.id === base.id));
    const [tBegin, tEnd] = [window.find((e) => e.what === 'begin')?.frame ?? 0, window.find((e) => e.what !== 'begin')?.frame ?? 0];
    for (const box of mailboxes(candidates[0])) {
      const asked = requestsIn(box, tBegin, tEnd);
      log(`  RAM $${hex(box.addr, 3)}: empty at $${hex(box.empty)}, full the frame before ${Math.round(box.share * 100)}% of the driver's calls; this start asked ${asked.map((v) => hex(v)).join(' ') || 'nothing'}`);
      // The entries that look in it: the outer ones, called every frame — outermost first.
      for (const entry of [...candidates].reverse()) {
        for (let nth = 1; nth <= Math.min(4, Math.max(1, asked.length)); nth++) {
          const original = asked[nth - 1] ?? box.empty;
          const keep = await runTry(k.frame, entry, 'a', 'keep', 1, { ...box, nth });
          if (!keep.hit) break;
          const others: string[][] = [];
          for (const value of probeValues(original).filter((v) => v !== box.empty)) {
            const changed = await runTry(k.frame, entry, 'a', value, 1, { ...box, nth });
            if (!changed.hit) continue;
            const like = likeness(keep.keys, changed.keys);
            if (like < OTHER_MUSIC && changed.writes >= 20 && changed.heardFrames > 0) {
              // Two other musics, different from each other: a song selector (see the registers).
              if (others.some((o) => likeness(o, changed.keys) >= SAME_SONG)) continue;
              others.push(changed.keys);
              if (others.length < 2) continue;
              log(`  $${hex(entry, 4)} with RAM $${hex(box.addr, 3)} (request ${nth}) ${hex(original)}→${hex(value)}: other music (${Math.round(like * 100)}% alike)`);
              return { argument: { entry, reg: 'a', original, mailbox: { addr: box.addr, empty: box.empty, nth } }, base: keep, exact, candidates };
            }
          }
          log(`  $${hex(entry, 4)} with RAM $${hex(box.addr, 3)} (request ${nth}): the same`);
        }
      }
    }
    return null;
  };
  // A start made of several calls of the driver is the game's sound routine at work: with a clear
  // mailbox in RAM, what it was told comes first (Alien 3's five calls of $8003 change the sound,
  // but the song is the number left in $A7 — 73% of its requests followed by a call, against 50%
  // for the next cell).
  const boxes = mailboxes(candidates[0]);
  const startCallCount = (base.calls ?? []).filter((c) => c.entry === candidates[0]).length;
  log(`  ${startCallCount} call${startCallCount === 1 ? '' : 's'} of $${hex(candidates[0], 4)} make the start; RAM mailboxes: ${boxes.map((b) => `$${hex(b.addr, 3)} (${Math.round(b.share * 100)}%)`).join(' ') || 'none'}`);
  // A clear one: most of its requests followed by a call, well ahead of the next cell.
  const clear = (boxes[0]?.share ?? 0) >= 0.6 && boxes[0].share >= 1.3 * (boxes[1]?.share ?? 0);
  if (startCallCount > 1 && clear) {
    const found = await byMailbox();
    if (found) return found;
  }
  status(`finding the argument (start on frame ${k.frame})`);
  const startDump = join(dir, 'dumps', `${k.frame}.bin`);
  const tables = existsSync(startDump) ? readDump(startDump) : null;
  for (const entry of candidates) {
    const calls = callsOf(entry);
    if (calls.length === 0) continue;
    // A jump table: its register picks the routine. Each routine is tried with the song in the
    // other registers — Jungle Book's $9000 starts the song in A with Y = 2; its Y alone gave
    // "other music" for stop, update and effect alike.
    const table = tables && dispatcher(tables, entry);
    if (table) {
      log(`  $${hex(entry, 4)} is a jump table on ${table.reg.toUpperCase()} (${table.routines} routines)`);
      // The call the start was made by: the first — the ones after are the frame's updates.
      const r = calls[0];
      const nth = 1;
      for (let routine = 0; routine < table.routines; routine++) {
        const fixed = { [table.reg]: routine } as Fixed;
        const base = await runTry(k.frame, entry, 'a', 'keep', nth, undefined, fixed);
        if (!base.hit) continue;
        for (const reg of (['a', 'x', 'y'] as const).filter((q) => q !== table.reg)) {
          const others: { value: number; keys: string[] }[] = [];
          for (const value of probeValues(r[reg])) {
            const changed = await runTry(k.frame, entry, reg, value, nth, undefined, fixed);
            if (!changed.hit) continue;
            if (likeness(base.keys, changed.keys) < OTHER_MUSIC && changed.writes >= 20 && changed.heardFrames > 0) {
              if (others.some((o) => likeness(o.keys, changed.keys) >= SAME_SONG)) continue;
              others.push({ value, keys: changed.keys });
              if (others.length < 2) continue;
              log(`  $${hex(entry, 4)} ${table.reg.toUpperCase()}=${hex(routine)}, ${reg.toUpperCase()}→${hex(others[0].value)}, →${hex(value)}: other music each`);
              return { argument: { entry, reg, original: r[reg], fixed, ...(nth > 1 ? { nth } : {}) }, base, exact, candidates };
            }
          }
          log(`  $${hex(entry, 4)} ${table.reg.toUpperCase()}=${hex(routine)} ${reg.toUpperCase()}: the same`);
        }
      }
      continue;
    }
    // The last call first: the one naming the song tends to come after the ones clearing up.
    for (let nth = calls.length; nth >= 1; nth--) {
      const r = calls[nth - 1];
      log(`  $${hex(entry, 4)}${calls.length > 1 ? ` call ${nth} of ${calls.length}` : ''} entered with A=${hex(r.a)} X=${hex(r.x)} Y=${hex(r.y)}`);
      for (const reg of ['x', 'a', 'y'] as const) {
        const original = r[reg];
        let verdict = 'the same';
        // A song selector gives other music for two values, and other music from each other —
        // a register that tunes a sound effect (Darkwing Duck's X inside its frame routine) gives
        // one change and repeats it.
        const others: { value: number; keys: string[] }[] = [];
        for (const value of probeValues(original)) {
          const changed = await runTry(k.frame, entry, reg, value, nth);
          if (!changed.hit) continue;
          const like = likeness(base.keys, changed.keys);
          if (like < OTHER_MUSIC && changed.writes >= 20 && changed.heardFrames > 0) {
            if (others.some((o) => likeness(o.keys, changed.keys) >= SAME_SONG)) continue;
            others.push({ value, keys: changed.keys });
            if (others.length < 2) continue;
            log(`  $${hex(entry, 4)} ${reg.toUpperCase()}=${hex(original)}→${hex(others[0].value)}, →${hex(value)}: other music each (${Math.round(like * 100)}% alike)`);
            const outer = outerEntry(k.chain, entry);
            const via = outer !== entry && entered.get(outer) ? { entry: outer, ...entered.get(outer)! } : undefined;
            if (via) log(`  the game calls the driver at $${hex(outer, 4)} (A=${hex(via.a)} X=${hex(via.x)} Y=${hex(via.y)})`);
            const series = callsOf(outer).map(({ a, x, y }) => ({ a, x, y }));
            return {
              argument: { entry, reg, original, ...(via ? { via } : {}), ...(nth > 1 ? { nth } : {}), ...(series.length > 1 ? { calls: series } : {}) },
              base,
              exact,
              candidates,
            };
          }
          if (like < SAME_SONG) verdict = `changes the sound only (${Math.round(like * 100)}% alike)`;
        }
        log(`  $${hex(entry, 4)} ${reg.toUpperCase()}: ${verdict}`);
      }
    }
  }
  return await byMailbox();
}

/**
 * The driver's entries, for a game that starts its songs with a call and never writes $4015 again
 * (RoboCop: $8000 resets — its one $4015 write, at power-on — $8003 plays the sound in A, $8006 is
 * the frame routine). A routine seen called that is one of a row of JMPs three bytes apart is in
 * the driver's entry table; every entry of the row is hooked as a song start — the probe passes
 * over one called every frame.
 */
function entryTable(): number[] {
  // Every routine seen called on the way to a chip write or a song start.
  const seeds = new Set<number>();
  for (const e of events) if ((e.t === 'C' || e.t === 'K') && e.chain.length > 0) for (const c of e.chain) seeds.add(c.target);
  const dumpDir = join(dir, 'dumps');
  const dumpFile = existsSync(dumpDir) ? readdirSync(dumpDir).find((f) => f.endsWith('.bin')) : undefined;
  if (!dumpFile) return [];
  const dump = readDump(join(dumpDir, dumpFile));
  const at = (address: number) => (address >= 0x6000 && address <= 0xffff ? dump.upper[address - 0x6000] : -1);
  const entries = new Set<number>();
  for (const seed of seeds) {
    if (at(seed) !== 0x4c) continue;
    // A row of JMPs three bytes apart around a JMP that was called: the driver's entry table.
    const row = [seed];
    for (const step of [-3, 3]) for (let address = seed + step; at(address) === 0x4c && Math.abs(address - seed) <= 8 * 3; address += step) row.push(address);
    if (row.length >= 2) for (const address of row) entries.add(address);
  }
  const list = [...entries].sort((a, b) => a - b);
  log(`entry tables beside the calls seen: ${list.map((e) => `$${hex(e, 4)}`).join(' ') || 'none'}`);
  return list;
}

/** The values FCEUX died on in the sessions before this one (`NES_AGENT_RESUME`), for this argument. */
function crashedValues(argument: Argument): Set<number> {
  const from = process.env.NES_AGENT_RESUME;
  if (!from || !existsSync(join(from, 'progress.json'))) return new Set();
  const p = JSON.parse(readFileSync(join(from, 'progress.json'), 'utf8'));
  if (p.argument?.entry !== argument.entry || p.argument?.reg !== argument.reg) {
    log(`the last session's argument was another (${JSON.stringify(p.argument)}): nothing passed over`);
    return new Set();
  }
  return new Set<number>([...(p.crashed ?? []), p.next]);
}

async function main() {
  const examined = new Set<number>();
  let hooked = false;
  const deadline = Date.now() + 12 * 60_000;
  let found: Awaited<ReturnType<typeof examine>> = null;
  let k: Start | null = null;
  const startHooked = new Set<number>();
  while (!found) {
    // Starts the probe kept no state for — made inside a routine the game calls every frame:
    // Jungle Book's frame routine ($9000) takes the song from a RAM queue after a fade and calls
    // $9776 with it. The innermost call of such a start, seen twice, is hooked as a start itself.
    const unkept = new Map<number, number>();
    // Routines on the chain of a kept start are tried with it already (the stop at $97B8).
    const kept = new Set<number>();
    const pinned = new Set(events.flatMap((p) => (p.t === 'P' ? [p.start] : [])));
    for (const e of events) {
      if (e.t !== 'K' || e.chain.length === 0) continue;
      if (pinned.has(e.frame)) for (const c of e.chain) kept.add(c.target);
      else unkept.set(e.chain[0].target, (unkept.get(e.chain[0].target) ?? 0) + 1);
    }
    for (const [target, count] of unkept) {
      if (count < 2 || startHooked.has(target) || kept.has(target)) continue;
      startHooked.add(target);
      log(`$${hex(target, 4)} started the sound ${count} times from inside the frame routine: hooked as a start`);
      send(`starthook ${hex(target, 4)}`);
    }
    status('waiting for a song to start');
    const next = await until(() => {
      for (const e of events) {
        if (e.t !== 'K' || e.chain.length === 0 || examined.has(e.frame)) continue;
        if (events.some((p) => p.t === 'P' && p.start === e.frame)) return e;
      }
      return undefined;
    }, 20);
    if (next) {
      examined.add(next.frame);
      k = next;
      found = await examine(next);
      send('speed normal');
      continue;
    }
    if (!hooked) {
      hooked = true;
      for (const entry of entryTable()) send(`starthook ${hex(entry, 4)}`);
    }
    if (AUTO) send('press start 4'); // an unattended game moves on to another scene, another song
    if (Date.now() > deadline) {
      status('stopped: no song start gave an argument');
      finish({ examined: [...examined], error: 'no argument found' });
      return;
    }
  }
  const { argument, base, exact, candidates } = found;
  log(
    argument.mailbox
      ? `the game asks for a song in RAM $${hex(argument.mailbox.addr, 3)} (request ${argument.mailbox.nth}), picked up at $${hex(argument.entry, 4)} (this start: ${hex(argument.original)})`
      : `the driver starts song ${argument.reg.toUpperCase()} at $${hex(argument.entry, 4)}${Object.entries(argument.fixed ?? {}).map(([r, n]) => ` with ${r.toUpperCase()}=${hex(n as number)}`).join('')} (this start: ${hex(argument.original)})`
  );
  const start = k!.frame;

  // How many songs: the driver's own tables, read off the dump the probe took at this start.
  let tables: SongTables | null = null;
  const atEntry = join(dir, 'dumps', `${start}-${hex(argument.entry, 4)}.bin`);
  const dumpFile = existsSync(atEntry) ? atEntry : join(dir, 'dumps', `${start}.bin`);
  if (existsSync(dumpFile) && !argument.mailbox && !argument.fixed) {
    try {
      tables = songTables(readDump(dumpFile), argument.entry, argument.reg, argument.original);
      log(`song tables: ${tables.layout}${tables.songs ? `, ${tables.songs} songs` : ', length unknown'} (bases ${tables.bases.map((b) => `$${hex(b, 4)}`).join(' ') || '—'})`);
    } catch (error) {
      log(`song tables: could not run the driver on the dump (${error instanceof Error ? error.message : error})`);
    }
  }
  const last = tables?.songs ? tables.songs - 1 : 255;

  send('speed maximum');
  const tries: (Omit<TryResult, 'keys'> & { value: number; kind: string; same?: number })[] = [];
  const songs: { value: number; fingerprint: string; keys: string[] }[] = [];
  let sinceNew = 0;
  // Again after FCEUX died mid-way (`npm run fceux-agent` starts it once more): every value
  // anew — the experiments must all come from this session's start — but the ones it died on.
  // RoboCop 3 took FCEUX down on A=$37.
  const crashes = crashedValues(argument);
  if (crashes.size) log(`passing over ${[...crashes].map((v) => hex(v)).join(' ')}: FCEUX died on them before`);
  for (let value = 0; value <= last && (tables?.songs || sinceNew < GIVE_UP_AFTER); value++) {
    if (crashes.has(value)) {
      tries.push({ id: '-', fingerprint: '', writes: 0, heardFrames: 0, frames: 0, unhit: true, value, kind: 'crashed the emulator' });
      continue;
    }
    writeFileSync(join(dir, 'progress.json'), JSON.stringify({ argument, next: value, crashed: [...crashes] }));
    status(`songs: ${songs.length} — trying ${argument.reg.toUpperCase()}=${hex(value)}${tables?.songs ? ` of ${tables.songs}` : ''}`);
    if (argument.mailbox && value === argument.mailbox.empty) continue;
    const r = await runTry(start, argument.entry, argument.reg, value, argument.nth ?? 1, argument.mailbox, argument.fixed);
    let kind: string;
    let same: number | undefined;
    // Silence is a driver that writes next to nothing. A song may open quietly — Terminator 2's
    // Level 2/4 writes 765 times in its first four seconds and FCEUX hears 7 frames of it.
    const twin = songs.find((song) => song.fingerprint === r.fingerprint || likeness(song.keys, r.keys) >= SAME_SONG);
    if (r.error) kind = 'error';
    else if (r.unhit) kind = 'entry not reached';
    else if (r.writes < 20) kind = 'silence';
    else if (twin) {
      kind = 'same song';
      same = twin.value;
    } else {
      kind = r.heardFrames < r.frames * 0.1 ? 'new song, quiet start' : 'new song';
      songs.push({ value, fingerprint: r.fingerprint, keys: r.keys });
    }
    sinceNew = kind.startsWith('new song') ? 0 : sinceNew + 1;
    const { keys: _keys, ...kept } = r;
    tries.push({ ...kept, value, kind, same });
    log(`  ${hex(value)}: ${kind}${same !== undefined ? ` as ${hex(same)}` : ''}  (${r.writes} writes, heard ${r.heardFrames}/${r.frames}${r.interruptedAt !== undefined ? `, the game started another sound ${r.interruptedAt} frames in` : ''})`);
    if (kind === 'error') break;
  }

  send('speed normal');
  status(`done: ${songs.length} songs at $${hex(argument.entry, 4)} ${argument.reg.toUpperCase()} — see tracks.json`);
  const { keys: _baseKeys, ...baseKept } = base;
  finish({ start, candidates, base: baseKept, exact, argument, tables, tries, examined: [...examined] });
}

/** Started by `npm run fceux-agent`: no one to read the panel — the session ends when we do. */
const AUTO = process.env.NES_AGENT_AUTO === '1';

function finish(result: Record<string, unknown>) {
  writeFileSync(
    join(dir, 'tracks.json'),
    JSON.stringify(
      result,
      (key, value) => (typeof value === 'number' && ['entry', 'original', 'value', 'same'].includes(key) ? `$${hex(value, key === 'entry' ? 4 : 2)}` : value),
      1
    )
  );
  log(`→ ${join(dir, 'tracks.json')}`);
  if (AUTO) send('stop agent done');
}

// The probe holds our stdin open for the session; when it closes, so do we.
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
main().catch((error) => {
  log(`agent failed: ${error instanceof Error ? error.stack : String(error)}`);
  try {
    send(`status agent failed: ${error instanceof Error ? error.message : String(error)}`);
    if (AUTO) send('stop agent failed');
  } catch {}
});
