/**
 * Stage 3b: whole songs from the cartridge. The game cannot be left to play a song to its end —
 * it moves on to the next scene — so each song the agent found is played away from the game, on
 * the dump the probe took when a song started (driver.ts): INIT with the song's number, then PLAY
 * once a frame, as an NSF player calls a driver. It is trusted only as far as it agrees with
 * FCEUX: the first seconds of every song were recorded there, in the agent's experiments, and
 * the dump player has to write what the cartridge wrote, write for write.
 *
 * PLAY is not given either. The probe logs the chain of calls behind the first write of a frame
 * (C lines); the routines at the inside end of those chains are the candidates, and the one whose
 * frames agree with FCEUX's is PLAY.
 */

import type { ProbeSession, ProbeWrite } from '../probe/session.ts';
import { DumpPlayer, type DriverDump, type PlayedWrite } from './driver.ts';

/** The writes that are the sound chip's: not $4014 (sprite DMA) nor $4016 (the controllers). */
export const isSound = (address: number) => (address >= 0x4000 && address <= 0x4013) || address === 0x4015 || address === 0x4017;

export interface Experiment {
  id: string;
  value: number;
  /** The value the experiment put in (a register's or a mailbox's), when it set one. */
  asked?: number;
  /** The frame the hooked entry ran on in FCEUX, and the registers it ran with. */
  hit: { frame: number; a: number; x: number; y: number };
  /** FCEUX's chip writes from the hit to the end of the experiment, frame 0 = the hit's. */
  writes: PlayedWrite[];
  frames: number;
  /** The game called the driver again on its own this many frames in: the window ends there. */
  cut?: number;
}

/** The agent's experiments as FCEUX ran them: every one that reached the entry. */
export function experiments(s: ProbeSession, entry: number, start?: number, routine?: { reg: 'a' | 'x' | 'y'; value: number }): Experiment[] {
  // A dispatcher's entry is called every frame for its other routines (Jungle Book's $9000 Y=0
  // updates the sound): only a call of the song's routine is the game asking for something else.
  const sameRoutine = (f: string[]) => !routine || parseInt(f[{ a: 3, x: 4, y: 5 }[routine.reg]], 16) === routine.value;
  const out: Experiment[] = [];
  let current: {
    id: string;
    hit?: Experiment['hit'];
    writes: PlayedWrite[];
    last: number;
    cut?: number;
    /** Writes since the entry's first call in the current frame — a start made of several calls
     *  (Alien 3) is measured from its first, as the dump player plays it. */
    pre?: { frame: number; writes: ProbeWrite[] };
    asked?: number;
  } | null = null;
  // The agent lines and the writes are one file, in the order things happened; put back in it —
  // inside the hit's frame, what the game's frame routine wrote before the entry was called is the
  // old sound, not the song (RoboCop: two writes of the title's before its $8003).
  const lines = [
    ...s.agent.map((f, i) => ({ frame: Number(f[1]), order: s.agentLines[i] ?? 0, kind: 'agent' as const, f })),
    ...s.writes.map((w) => ({ frame: w.frame, order: w.line ?? 0, kind: 'write' as const, w })),
  ];
  lines.sort((p, q) => p.order - q.order || p.frame - q.frame);
  for (const line of lines) {
    if (line.kind === 'agent') {
      const f = line.f;
      // Only the experiments replaying `start`: an entry can be called from more than one start
      // (Darkwing Duck's $8106 from a fade on frame 313 and the song on 1344), each from its own state.
      if (f[0] === 'T' && f[3] === 'begin')
        current = start === undefined || Number(f[4]) === start ? { id: f[2], writes: [], last: line.frame, asked: f[7] && f[7] !== 'keep' ? parseInt(f[7], 16) : undefined } : null;
      else if (f[0] === 'X' && current && !current.hit && parseInt(f[2], 16) === entry && f[6] === 'seen') {
        if (current.pre?.frame !== line.frame) current.pre = { frame: line.frame, writes: [] };
      } else if (f[0] === 'X' && current && !current.hit && parseInt(f[2], 16) === entry && f[6] !== 'seen') {
        current.hit = { frame: line.frame, a: parseInt(f[3], 16), x: parseInt(f[4], 16), y: parseInt(f[5], 16) };
        const hit = current.hit;
        if (current.pre?.frame === line.frame) for (const w of current.pre.writes) current.writes.push({ ...w, frame: w.frame - hit.frame });
        current.pre = undefined;
      } else if (f[0] === 'X' && f[6] === 'seen' && current?.hit && current.cut === undefined && parseInt(f[2], 16) === entry && line.frame > current.hit.frame + 2 && sameRoutine(f)) {
        // The game calling the entry again on its own, frames later, with its own number: RoboCop
        // asks for its title music again a few frames after the agent's value, and what plays after
        // is that. (Calls in the start's own frames are the start's: Alien 3 makes several.)
        current.cut = line.frame - current.hit.frame;
      } else if (f[0] === 'K' && current?.hit && current.cut === undefined && line.frame > current.hit.frame + 2) {
        // The game starting a sound of its own: what follows is not this value's song (RoboCop's
        // game calls $8003 again within a few frames, and every effect number looked like silence).
        current.cut = line.frame - current.hit.frame;
      } else if (f[0] === 'T' && (f[3] === 'end' || f[3] === 'error') && current) {
        if (current.hit && f[3] === 'end') {
          const hit = current.hit;
          out.push({ id: current.id, value: -1, asked: current.asked, hit, writes: current.writes, frames: current.cut !== undefined ? current.cut + 1 : line.frame - hit.frame, cut: current.cut });
        }
        current = null;
      }
    } else if (current && !current.hit && current.pre && isSound(line.w.address)) {
      current.pre.writes.push(line.w);
    } else if (current?.hit && current.cut === undefined && isSound(line.w.address)) {
      current.writes.push({ ...line.w, frame: line.w.frame - current.hit.frame });
    }
  }
  return out;
}

/**
 * The routines seen on the way to each frame's first chip write, most often first — every call of
 * the chain, not only the innermost: Capcom's frame routine is $8000, and the chain's inside end is
 * a subroutine of it ($80EC, a voice), which played on its own wrote nothing like FCEUX.
 */
export function playCandidates(s: ProbeSession, init: number): number[] {
  const count = new Map<number, number>();
  for (const f of s.agent) {
    if (f[0] !== 'C' || !f[3] || f[3] === '-') continue;
    for (const call of f[3].split(',')) {
      const target = parseInt(call.split('>')[1], 16);
      if (target !== init && target >= 0x6000) count.set(target, (count.get(target) ?? 0) + 1);
    }
  }
  return [...count].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/**
 * How a song is started: the driver entry the game calls (`entry`, with the registers it called it
 * with) and where the song number is taken (`at`, register `reg`). Capcom's game calls $8003, the
 * number is A at $8106 inside it; $8003 is also what clears its "busy" flag, so a start run from
 * $8106 alone left the frame routine doing nothing.
 */
export interface StartCall {
  entry: number;
  regs: { a: number; x: number; y: number };
  at: number;
  reg: 'a' | 'x' | 'y';
  /** A start made of several calls of `entry` in one frame, and which one takes the song. */
  series?: { a: number; x: number; y: number }[];
  nth?: number;
  /** The song asked for through RAM: written to this cell, then `entry` called (no register set). */
  mailbox?: number;
  /** Registers set beside `reg` — a dispatcher's routine (see `dispatcher`). */
  fixed?: Partial<Record<'a' | 'x' | 'y', number>>;
}

/** INIT as the game makes it: one call, or the series; the song number put in where it is taken. */
export function startSong(player: DumpPlayer, start: StartCall, value: number): PlayedWrite[] {
  if (start.mailbox !== undefined) {
    player.poke(start.mailbox, value);
    return player.callSeries(start.entry, [start.regs]);
  }
  const set = { at: start.at, reg: start.reg, value, nth: start.nth ?? 1, fixed: start.fixed };
  return player.callSeries(start.entry, start.series && start.series.length > 0 ? start.series : [start.regs], set);
}

/**
 * The ways the start could be replayed: from the driver entry itself out along the chain of calls
 * the probe read off the stack at the start — each with the calls the game made of it in the
 * start's first frames (the learning replay's X lines). Which one is right is for FCEUX to say:
 * T2 starts at $8006 itself, Capcom from $8003 around $8106, Alien 3 from the trampoline $ED94
 * that maps the driver's bank in before each of its five calls.
 */
export function startCalls(s: ProbeSession, start: number, entry: number, reg: 'a' | 'x' | 'y', nth: number): StartCall[] {
  const k = s.agent.find((f) => f[0] === 'K' && Number(f[1]) === start);
  const chain = (k?.[7] ?? '-') === '-' ? [] : k![7].split(',').map((c) => parseInt(c.split('>')[1], 16));
  const from = Math.max(0, chain.indexOf(entry));
  const outers = chain.length ? chain.slice(from, from + 4) : [entry];
  if (!outers.includes(entry)) outers.unshift(entry);
  // The learning replay: the first experiment from this start that kept the registers.
  const begin = s.agent.findIndex((f) => f[0] === 'T' && f[3] === 'begin' && Number(f[4]) === start && f[7] === 'keep');
  const end = begin < 0 ? -1 : s.agent.findIndex((f, i) => i > begin && f[0] === 'T' && f[2] === s.agent[begin][2] && f[3] !== 'begin');
  const xs = begin < 0 ? [] : s.agent.slice(begin, end < 0 ? undefined : end).filter((f) => f[0] === 'X');
  // The start's frame in the replay: where the entry's call was kept.
  const kept = xs.find((f) => parseInt(f[2], 16) === entry && f[6] !== 'seen');
  const startFrame = kept ? Number(kept[1]) : undefined;
  const out: StartCall[] = [];
  for (const outer of outers) {
    // Its calls in the start's frame — an outer routine run every frame (Alien 3's $ED94) is
    // called in the frames before too, with nothing to start yet.
    const calls = xs.filter((f) => parseInt(f[2], 16) === outer && (startFrame === undefined || Number(f[1]) === startFrame));
    if (calls.length === 0) continue;
    const series = calls.slice(0, 8).map((f) => ({ a: parseInt(f[3], 16), x: parseInt(f[4], 16), y: parseInt(f[5], 16) }));
    out.push({ entry: outer, regs: series[0], at: entry, reg, series, nth });
  }
  return out;
}

/** Plays `frames` frames: INIT on frame 0 (the song number `value`), PLAY after. */
export function play(dump: DriverDump, start: StartCall, value: number, playAt: number, frames: number) {
  const player = new DumpPlayer(dump);
  const writes: PlayedWrite[] = [...startSong(player, start, value)];
  for (let f = 1; f < frames; f++) writes.push(...player.call(playAt, {}));
  return { writes: writes.filter((w) => isSound(w.address)), player };
}

export interface Agreement {
  /** FCEUX's frames compared, and how many of them the dump player wrote exactly. */
  frames: number;
  same: number;
  /** FCEUX's frames with no write where the dump player had some: the game lagging a frame. */
  lagged: number;
  /** The first of FCEUX's frames that differs, or null. */
  firstDiffering: number | null;
  /** Writes compared (FCEUX's), and how many came in the same order before the first difference. */
  writes: number;
  prefix: number;
  /**
   * The share of the dump player's writes found in FCEUX's, in the same order, extra writes of
   * FCEUX's passed over — the game's own sounds over the song: RoboCop fired effects on pulse 1
   * while the agent pressed Start, and every write of the song was there between them.
   */
  confirmed: number;
}

/**
 * Frame by frame: each of FCEUX's frames against the dump player's next one. A frame FCEUX has no
 * write on while the player has some is a lag frame — the game busy, PLAY not called (Terminator
 * 2 lags on its 18th) — and is passed over: the song is the same, a frame later. Only the frames
 * the experiment covers in full; its last is cut by its end. The code addresses are not compared:
 * FCEUX reports the instruction after the write.
 */
export function agreement(fceux: Experiment, mine: PlayedWrite[]): Agreement {
  // The game may run its first PLAY in the frame it started the song in, or a frame later than
  // the dump player does (Darkwing Duck: every write in order, every frame one off): the best of
  // the player's PLAY frames as they are and moved a frame either way.
  let best: Agreement | null = null;
  for (const shift of [0, -1, 1]) {
    const moved = shift === 0 ? mine : mine.map((w) => (w.frame === 0 ? w : { ...w, frame: Math.max(0, w.frame + shift) }));
    const a = agreementAt(fceux, moved);
    // Full agreement first, then the most frames alike.
    const score = (x: Agreement) => (x.firstDiffering === null ? 1e9 : 0) + x.same;
    if (!best || score(a) > score(best)) best = a;
  }
  return best!;
}

function agreementAt(fceux: Experiment, mine: PlayedWrite[]): Agreement {
  const byFrame = (list: PlayedWrite[]) => {
    const m = new Map<number, string>();
    for (const w of list) m.set(w.frame, (m.get(w.frame) ?? '') + `${w.address.toString(16)}=${w.value.toString(16)} `);
    return m;
  };
  const theirs = byFrame(fceux.writes);
  const ours = byFrame(mine);
  const frames = fceux.frames - 1;
  let same = 0;
  let lagged = 0;
  let firstDiffering: number | null = null;
  const order: string[] = [];
  for (let f = 0, g = 0; f < frames; f++) {
    const t = theirs.get(f) ?? '';
    const o = ours.get(g) ?? '';
    if (t === o) same++;
    else if (t === '' && f > 0) {
      lagged++;
      continue;
    } else if (firstDiffering === null) firstDiffering = f;
    order.push(o);
    g++;
  }
  const flatTheirs = fceux.writes.filter((w) => w.frame < frames).map((w) => `${w.address.toString(16)}=${w.value.toString(16)}`);
  const flatOurs = order.join('').split(' ').filter(Boolean);
  let prefix = 0;
  while (prefix < flatTheirs.length && flatTheirs[prefix] === flatOurs[prefix]) prefix++;
  // Ours in order through theirs, skipping what only FCEUX wrote (a look-ahead of 64 writes).
  const flatMine = mine.filter((w) => w.frame < frames).map((w) => `${w.address.toString(16)}=${w.value.toString(16)}`);
  let found = 0;
  for (let i = 0, j = 0; i < flatMine.length && j < flatTheirs.length; i++) {
    const k = flatTheirs.indexOf(flatMine[i], j);
    if (k >= 0 && k - j <= 64) {
      found++;
      j = k + 1;
    }
  }
  const confirmed = flatMine.length ? found / flatMine.length : flatTheirs.length ? 0 : 1;
  return { frames, same, lagged, firstDiffering, writes: flatTheirs.length, prefix, confirmed };
}

/**
 * Whether the dump player plays what the cartridge played: frame for frame (lag frames passed
 * over), or every write of its in FCEUX's order with the game's own sounds between them.
 */
export const agrees = (a: Agreement, mineWrites: number) =>
  a.firstDiffering === null || (a.confirmed >= 0.95 && mineWrites >= 20 && a.writes > 0 && a.confirmed * mineWrites >= 0.5 * a.writes);
