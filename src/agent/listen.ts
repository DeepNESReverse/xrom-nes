/**
 * The agent listening: a session the FCEUX probe recorded, made into pieces of music.
 *
 * Nothing here knows a game. What it goes by:
 *
 * - Where songs start. A driver starts a song by enabling the channels — a write of $4015
 *   from code that writes it rarely. Code that writes $4015 every few frames is striking
 *   DMC samples, not starting songs. Long silences (as FCEUX hears it) cut too.
 * - Who writes. Every write comes with the address of the code that made it. Within a
 *   piece, the music's code writes all along; a sound effect's code writes in bursts —
 *   Terminator 2's typing in the story screen, its gunshots in the level. A note whose
 *   writes all come from bursty code is an effect's.
 * - What FCEUX hears. After every frame the probe asks FCEUX which channels sound and at
 *   what pitch. A channel FCEUX hears with no note decoded under it is a note lost; a note
 *   decoded where FCEUX hears nothing is one made up. Both go in the journal. A tone above
 *   20 kHz is not heard by anyone — a triangle at period 0 is FCEUX "playing" at 56 kHz.
 */

import type { DecodedNote, TimedWrite } from '../decode.ts';
import { decode } from '../decode.ts';
import { detectGrid, type Grid } from '../grid.ts';
import { findLoop, findNoteLoop, type Loop } from '../loop.ts';
import { channelOf, CHANNEL_NAMES, type ProbeSession, type ProbeWrite } from '../probe/session.ts';

export const CPU_HZ = 1789772.7272727273;

/** A write on the session's clock: seconds from the first frame. */
export interface SessionWrite extends ProbeWrite {
  time: number;
}

export interface Clock {
  /** Seconds from the session's first frame to the start of `frame`. */
  at(frame: number): number;
  frameHz: number;
  writes: SessionWrite[];
}

export function clockOf(s: ProbeSession): Clock {
  const start = new Map(s.frames.map((f) => [f.frame, f.cycle]));
  const first = s.frames[0]?.cycle ?? 0;
  const cpf = Number(s.meta.cyclesPerFrame) || 29780.5;
  // A frame the log has no F line for (the last, cut short) is placed a frame after the one before.
  const at = (frame: number) => {
    const c = start.get(frame);
    return c !== undefined ? (c - first) / CPU_HZ : ((frame - (s.frames[0]?.frame ?? 1)) * cpf) / CPU_HZ;
  };
  const writes = s.writes.map((w) => ({ ...w, time: at(w.frame) + w.cycle / CPU_HZ }));
  return { at, frameHz: CPU_HZ / cpf, writes };
}

/** Is this a pitch anyone hears — FCEUX's view of one channel after a frame. */
export const audible = (v: { volume: number; frequency: number }) => v.volume > 0 && v.frequency >= 20 && v.frequency <= 20000;

export interface Segment {
  index: number;
  /** First and last frame, inclusive. */
  from: number;
  to: number;
  /** Why it begins here. */
  cause: 'recording starts' | 'driver starts a song' | 'after silence';
  /** The code that started the song, when a driver did. */
  startPc?: number;
}

/**
 * The frames a driver starts a song on: writes of $4015 that enable channels, from code that
 * writes $4015 no more than once a few seconds on average.
 */
export function driverStarts(s: ProbeSession): { frame: number; pc: number }[] {
  const enabling = s.writes.filter((w) => w.address === 0x4015 && (w.value & 0x0f) !== 0);
  const byPc = new Map<number, ProbeWrite[]>();
  for (const w of enabling) byPc.set(w.pc, [...(byPc.get(w.pc) ?? []), w]);
  const starts: { frame: number; pc: number }[] = [];
  for (const [pc, ws] of byPc) {
    if (ws.length > Math.max(1, s.frames.length / 180)) continue;
    for (const w of ws) if (!starts.some((x) => Math.abs(x.frame - w.frame) < 30)) starts.push({ frame: w.frame, pc });
  }
  return starts.sort((a, b) => a.frame - b.frame);
}

/** Pieces of the recording: cut where a driver starts a song, and at two seconds of silence. */
export function segmentsOf(s: ProbeSession, silence = 2): Segment[] {
  const first = s.frames[0]?.frame ?? 1;
  const last = s.frames[s.frames.length - 1]?.frame ?? first;
  const cuts: Omit<Segment, 'index' | 'to'>[] = [{ from: first, cause: 'recording starts' }];
  for (const st of driverStarts(s)) if (st.frame > first) cuts.push({ from: st.frame, cause: 'driver starts a song', startPc: st.pc });
  // Silence: frames FCEUX hears no channel on. A run of them long enough ends a piece; the
  // next sound begins one, unless a driver start is already close.
  const frameHz = CPU_HZ / (Number(s.meta.cyclesPerFrame) || 29780.5);
  let quietFrom = -1;
  for (const f of s.sound) {
    const heard = f.voices.slice(0, 5).some(audible);
    if (!heard) {
      if (quietFrom < 0) quietFrom = f.frame;
    } else {
      if (quietFrom >= 0 && f.frame - quietFrom >= silence * frameHz && !cuts.some((c) => Math.abs(c.from - f.frame) < 30)) {
        cuts.push({ from: f.frame, cause: 'after silence' });
      }
      quietFrom = -1;
    }
  }
  cuts.sort((a, b) => a.from - b.from);
  return cuts.map((c, i) => ({ ...c, index: i + 1, to: (cuts[i + 1]?.from ?? last + 1) - 1 }));
}

export type Source = 'music' | 'effect';

/** What a code address is, for the whole session. */
export type Role = 'music' | 'effect' | 'every frame' | 'song start';

export interface Sources {
  role: Map<number, Role>;
  /** The groups found — code addresses that act in the same half-seconds — and their role. */
  groups: { role: Role; pcs: number[]; windows: number }[];
}

/**
 * Who writes, for the whole session.
 *
 * Code that writes in (nearly) every frame is the driver's frame routine — it refreshes a
 * channel whatever plays on it — and decides nothing. The rest is grouped: addresses that act
 * in the same half-seconds belong to one source (Jaccard ≥ 0.5 over half-second windows).
 * A group writing in the first frames after a driver starts a song is the music; a group that
 * acts only at those starts is the start itself (clearing the chip); every other group is an
 * effect — Terminator 2's thirteen addresses of typing, shots and steps, found as one group.
 * With no song start in the recording, the group active longest is taken for the music.
 */
/**
 * Frames after a song's start within which its music writes. Terminator 2's music code writes
 * 0-1 frames after $803C enables the channels; its effects' first writes come 51 frames after
 * at the soonest — a window of a second took the effects for music.
 */
const SONG_FIRST_WRITES = 4;

export function sourcesOf(s: ProbeSession, windowFrames = 30): Sources {
  const frames = Math.max(1, s.frames.length);
  const windows = new Map<number, Set<number>>();
  const perFrame = new Map<number, Set<number>>();
  for (const w of s.writes) {
    if (channelOf(w.address) < 0) continue;
    if (!windows.has(w.pc)) windows.set(w.pc, new Set());
    if (!perFrame.has(w.pc)) perFrame.set(w.pc, new Set());
    windows.get(w.pc)!.add(Math.floor(w.frame / windowFrames));
    perFrame.get(w.pc)!.add(w.frame);
  }
  const role = new Map<number, Role>();
  for (const [pc, f] of perFrame) if (f.size > 0.9 * frames) role.set(pc, 'every frame');

  const pcs = [...windows.keys()].filter((pc) => !role.has(pc));
  const parent = new Map(pcs.map((pc) => [pc, pc]));
  const find = (x: number): number => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (let i = 0; i < pcs.length; i++) {
    for (let j = i + 1; j < pcs.length; j++) {
      const a = windows.get(pcs[i])!;
      const b = windows.get(pcs[j])!;
      let both = 0;
      for (const x of a) if (b.has(x)) both++;
      if (both / (a.size + b.size - both) >= 0.5) parent.set(find(pcs[i]), find(pcs[j]));
    }
  }
  const byRoot = new Map<number, number[]>();
  for (const pc of pcs) byRoot.set(find(pc), [...(byRoot.get(find(pc)) ?? []), pc]);

  const starts = driverStarts(s).map((st) => st.frame);
  const startWindows = new Set(starts.map((f) => Math.floor(f / windowFrames)));
  const groups: Sources['groups'] = [];
  for (const members of byRoot.values()) {
    const wins = new Set<number>();
    for (const pc of members) windows.get(pc)!.forEach((x) => wins.add(x));
    const onlyAtStarts = starts.length > 0 && [...wins].every((x) => startWindows.has(x) || startWindows.has(x - 1));
    const seeded = members.some((pc) => {
      const f = perFrame.get(pc)!;
      return starts.some((st) => {
        for (let k = st; k < st + SONG_FIRST_WRITES; k++) if (f.has(k)) return true;
        return false;
      });
    });
    groups.push({ role: onlyAtStarts ? 'song start' : seeded ? 'music' : 'effect', pcs: members.sort((a, b) => a - b), windows: wins.size });
  }
  if (starts.length === 0 && groups.length > 0) {
    const longest = groups.reduce((a, b) => (b.windows > a.windows ? b : a));
    longest.role = 'music';
  }
  groups.sort((a, b) => b.windows - a.windows);
  for (const g of groups) for (const pc of g.pcs) role.set(pc, g.role);
  return { role, groups };
}

const TRACK_CHANNEL = { pulse1: 0, pulse2: 1, triangle: 2, noise: 3 } as const;

export interface SegmentNote extends DecodedNote {
  source: Source;
  /** The code addresses whose writes struck it. */
  pcs: number[];
}

export interface JournalEntry {
  segment: number;
  channel: string;
  /** Seconds from the segment's start, and frames. */
  start: number;
  frames: number;
  kind: 'heard, no note' | 'note, not heard';
  /** FCEUX's frequency and MIDI key at the start, for 'heard, no note'; the note's, for the other. */
  frequency: number;
  midi: number;
  /** The channel's registers as last written before it, $4000-style order. */
  registers: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

/** A repeat that holds for most of a piece but not all of it. */
export interface NearLoop {
  /** Seconds one pass takes. */
  seconds: number;
  frames: number;
  /** The share of notes (after the first pass) with the same note one period earlier. */
  match: number;
  /** Passes, counted from 0 at the piece's start, where at least a few notes differ. */
  differing: number[];
}

/**
 * The shortest period the notes repeat at, nearly: for every note after the first pass, a note of
 * the same pitch on the same channel one period earlier (±1.5 frames). Terminator 2's story music
 * repeats every 160 frames for 92% of its notes in the cartridge — and changes its arpeggios on the
 * 8th, 11th, 16th and 17th passes, which the NSF rip, looping its first five seconds, never plays.
 */
export function nearLoop(notes: readonly DecodedNote[], frameHz: number, seconds: number, least = 0.85): NearLoop | null {
  const byTrack = new Map<string, { frame: number; midi: number }[]>();
  for (const n of notes) {
    const list = byTrack.get(n.track) ?? [];
    list.push({ frame: n.start * frameHz, midi: n.midi });
    byTrack.set(n.track, list);
  }
  for (const list of byTrack.values()) list.sort((a, b) => a.frame - b.frame);
  /** How far from `frame` the nearest note of `midi` is, within 1.5 frames — or -1. */
  const near = (list: { frame: number; midi: number }[], frame: number, midi: number) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].frame < frame - 1.5) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    for (let i = lo; i < list.length && list[i].frame <= frame + 1.5; i++) {
      const d = Math.abs(list[i].frame - frame);
      if (list[i].midi === midi && (best < 0 || d < best)) best = d;
    }
    return best;
  };
  const total = Math.floor(seconds * frameHz);
  const score = (p: number) => {
    let ok = 0;
    let all = 0;
    let off = 0;
    const misses = new Map<number, number>();
    for (const list of byTrack.values()) {
      for (const e of list) {
        if (e.frame < p) continue;
        all++;
        const d = near(list, e.frame - p, e.midi);
        if (d >= 0) {
          ok++;
          off += d;
        } else misses.set(Math.floor(e.frame / p), (misses.get(Math.floor(e.frame / p)) ?? 0) + 1);
      }
    }
    return { p, all, match: all ? ok / all : 0, offset: ok ? off / ok : Infinity, misses };
  };
  for (let p = Math.round(frameHz); p * 2 <= total; p++) {
    const first = score(p);
    if (first.all < 16 || first.match < least) continue;
    // The tolerance lets a period a frame or two short pass first: of it and the next few, the one
    // the most notes repeat at — and of those, the one they repeat at most exactly.
    let best = first;
    for (let q = p + 1; q <= p + 3 && q * 2 <= total; q++) {
      const next = score(q);
      if (next.match > best.match + 1e-9 || (Math.abs(next.match - best.match) <= 1e-9 && next.offset < best.offset)) best = next;
    }
    return {
      seconds: best.p / frameHz,
      frames: best.p,
      match: best.match,
      differing: [...best.misses].filter(([, n]) => n >= 3).map(([pass]) => pass).sort((a, b) => a - b),
    };
  }
  return null;
}

export interface Listened {
  segment: Segment;
  seconds: number;
  notes: SegmentNote[];
  loop: Loop | null;
  /** When there is no exact loop: the period the notes nearly repeat at, and where they do not. */
  near: NearLoop | null;
  grid: Grid | null;
  journal: JournalEntry[];
  /** Frames FCEUX "heard" a tone no one hears (above 20 kHz), per channel. */
  ultrasonic: number[];
}

/** The decoder's own range, which a note must fall in to be kept (decode.ts). */
const DECODER_MIDI = { low: 21, high: 127 };

export function listen(s: ProbeSession, clock: Clock, seg: Segment, sources: Sources = sourcesOf(s)): Listened {
  const t0 = clock.at(seg.from);
  const seconds = clock.at(seg.to + 1) - t0;
  // Every write before the piece sets the chip up for it: replayed at its first instant.
  const writes: TimedWrite[] = [];
  for (const w of clock.writes) {
    if (w.frame > seg.to) break;
    writes.push({ time: Math.max(0, w.time - t0), address: w.address, value: w.value });
  }
  const decoded = decode(writes, seconds, clock.frameHz);

  // Each note's writes: those to its channel within a frame and a half of its start.
  const segWrites = clock.writes.filter((w) => w.frame >= seg.from - 1 && w.frame <= seg.to);
  const window = 1.5 / clock.frameHz;
  const notes: SegmentNote[] = decoded.map((n) => {
    const ch = TRACK_CHANNEL[n.track as keyof typeof TRACK_CHANNEL] ?? -1;
    const at = t0 + n.start;
    const pcs = [...new Set(segWrites.filter((w) => channelOf(w.address) === ch && Math.abs(w.time - at) <= window).map((w) => w.pc))];
    // The frame routine and the song's start decide nothing; of the rest, a note is an
    // effect's when every one of its writers is.
    const deciding = pcs.map((pc) => sources.role.get(pc)).filter((r) => r === 'music' || r === 'effect');
    const source: Source = deciding.length > 0 && deciding.every((r) => r === 'effect') ? 'effect' : 'music';
    return { ...n, source, pcs };
  });
  const music = notes.filter((n) => n.source === 'music');

  // The loop: the writes repeating exactly, or failing that the notes.
  // Only the music's code: an effect (typing, a shot) breaks the exact repeat of the frames.
  const pieceWrites = clock.writes
    .filter((w) => w.frame >= seg.from && w.frame <= seg.to && sources.role.get(w.pc) !== 'effect')
    .map((w) => ({ time: w.time - t0, address: w.address, value: w.value }));
  const sounds = (a: number, b: number) => music.some((n) => n.start >= a && n.start < b);
  // By notes, on the channels no effect took in this piece: where an effect takes a channel the
  // music's notes there are gone for a while, and every pass would differ (the story's typing).
  const taken = new Set(notes.filter((n) => n.source === 'effect').map((n) => n.track));
  const clean = music.filter((n) => !taken.has(n.track));
  const loop =
    seconds >= 3
      ? (findLoop(pieceWrites, clock.frameHz, seconds, sounds) ?? findNoteLoop(clean.length >= 8 ? clean : music, clock.frameHz, seconds))
      : null;
  const near = loop ? null : nearLoop(clean.length >= 8 ? clean : music, clock.frameHz, seconds);
  const grid = music.length >= 8 ? detectGrid(music, clock.frameHz) : null;

  // The journal: what FCEUX hears against what was decoded, frame by frame, channel by channel.
  const journal: JournalEntry[] = [];
  const ultrasonic = [0, 0, 0, 0, 0];
  const lastRegs = (ch: number, frame: number) => {
    const regs = [-1, -1, -1, -1];
    for (const w of segWrites) {
      if (w.frame > frame) break;
      if (channelOf(w.address) === ch) regs[w.address & 3] = w.value;
    }
    for (const w of clock.writes) {
      if (w.frame >= seg.from - 1) break;
      if (channelOf(w.address) === ch && regs[w.address & 3] < 0) regs[w.address & 3] = w.value;
    }
    return regs.map((r) => (r < 0 ? '--' : r.toString(16).toUpperCase().padStart(2, '0'))).join(' ');
  };
  const sound = s.sound.filter((f) => f.frame >= seg.from && f.frame <= seg.to);
  // A recording that starts inside a song never saw the registers the song set before it.
  const midSong = seg.cause === 'recording starts' && Number(s.meta.fceuxFrameAtStart) > 0;
  for (let ch = 0; ch < 4; ch++) {
    const track = (['pulse1', 'pulse2', 'triangle', 'noise'] as const)[ch];
    const chNotes = notes.filter((n) => n.track === track);
    const covered = (time: number) => chNotes.some((n) => time >= n.start - 1 / clock.frameHz && time < n.start + n.duration + 1 / clock.frameHz);
    let run: { from: number; frames: number; frequency: number; midi: number } | null = null;
    const close = () => {
      if (!run) return;
      const frame = run.from;
      const outside = run.midi > DECODER_MIDI.high || run.midi < DECODER_MIDI.low;
      journal.push({
        segment: seg.index,
        channel: CHANNEL_NAMES[ch],
        start: clock.at(frame) - t0,
        frames: run.frames,
        kind: 'heard, no note',
        frequency: run.frequency,
        midi: run.midi,
        registers: lastRegs(ch, frame),
        reason: outside
          ? `pitch outside the decoder's range (MIDI ${DECODER_MIDI.low}-${DECODER_MIDI.high})`
          : midSong && lastRegs(ch, frame).includes('--')
            ? 'recording began mid-song: this channel\'s registers from before it were never seen'
            : 'the decoder found no note here',
        confidence: run.frames >= 3 ? 'high' : run.frames >= 2 ? 'medium' : 'low',
      });
      run = null;
    };
    for (const f of sound) {
      const v = f.voices[ch];
      if (v.volume > 0 && v.frequency > 20000) ultrasonic[ch]++;
      // Noise has no pitch FCEUX can name the same way; its frames are compared as heard or not.
      const heard = audible(v) || (ch === 3 && v.volume > 0);
      const time = clock.at(f.frame) - t0;
      if (heard && !covered(time)) {
        if (run && f.frame === run.from + run.frames) run.frames++;
        else {
          close();
          run = { from: f.frame, frames: 1, frequency: v.frequency, midi: Math.round(v.midikey) };
        }
      } else close();
    }
    close();
    // Notes FCEUX does not hear at all.
    for (const n of chNotes) {
      const frames = sound.filter((f) => {
        const time = clock.at(f.frame) - t0;
        return time >= n.start && time < n.start + n.duration;
      });
      if (frames.length < 2) continue;
      const heard = frames.filter((f) => audible(f.voices[ch]) || (ch === 3 && f.voices[ch].volume > 0)).length;
      if (heard === 0) {
        const frame = seg.from + Math.round(n.start * clock.frameHz);
        journal.push({
          segment: seg.index,
          channel: CHANNEL_NAMES[ch],
          start: n.start,
          frames: frames.length,
          kind: 'note, not heard',
          frequency: 440 * 2 ** ((n.pitch - 69) / 12),
          midi: n.midi,
          registers: lastRegs(ch, frame),
          reason: n.source === 'effect' ? "an effect's note FCEUX does not hear" : 'decoded where FCEUX hears this channel silent',
          confidence: frames.length >= 4 ? 'high' : 'medium',
        });
      }
    }
  }
  journal.sort((a, b) => a.start - b.start);
  return { segment: seg, seconds, notes, loop, near, grid, journal, ultrasonic };
}
