/**
 * A session recorded by fceux/nes_music_probe.lua, read back: the frames, every write to
 * the sound chip with the code that made it, the reads of $4015, FCEUX's own view of the
 * channels after each frame, and the markers. Format: the header of the Lua script.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ProbeFrame {
  frame: number;
  /** The CPU cycle the frame began on, as FCEUX's debugger counts. */
  cycle: number;
}

export interface ProbeWrite {
  frame: number;
  /** Cycles into the frame. */
  cycle: number;
  address: number;
  value: number;
  /** The program counter when the write was seen — the code that made it. */
  pc: number;
  /** Its line in events.log: the order of what happened inside one frame. */
  line?: number;
}

export interface ProbeRead {
  frame: number;
  cycle: number;
  pc: number;
}

/** One channel as FCEUX's `sound.get()` reports it after a frame. */
export interface ProbeVoice {
  volume: number;
  frequency: number;
  midikey: number;
}

export interface ProbeSound {
  frame: number;
  /** square1, square2, triangle, noise, dpcm. */
  voices: ProbeVoice[];
}

export interface ProbeMarker {
  frame: number;
  text: string;
}

export interface ProbeSession {
  dir: string;
  meta: Record<string, unknown>;
  frames: ProbeFrame[];
  writes: ProbeWrite[];
  reads: ProbeRead[];
  sound: ProbeSound[];
  markers: ProbeMarker[];
  /** The agent's lines (stage 3): song starts with their call chains (K), PLAY's chain (C), states
   *  kept (P), hooked entries run (X), experiments (T) — kept as text, split into fields. */
  agent: string[][];
  /** events.log line of each `agent` entry, the same order. */
  agentLines: number[];
  /** Frames with a RAM snapshot in ram.bin (2048 bytes each), 0 if there is none. */
  ramFrames: number;
  /** Lines that did not parse — a session cut mid-line ends with one. */
  bad: string[];
}

export function readSession(dir: string): ProbeSession {
  const meta = existsSync(join(dir, 'session.json')) ? JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) : {};
  const session: ProbeSession = { dir, meta, frames: [], writes: [], reads: [], sound: [], markers: [], agent: [], agentLines: [], ramFrames: 0, bad: [] };
  const ram = join(dir, 'ram.bin');
  if (existsSync(ram)) session.ramFrames = Math.floor(statSync(ram).size / 0x800);
  let lineNo = 0;
  for (const line of readFileSync(join(dir, 'events.log'), 'utf8').split('\n')) {
    lineNo++;
    if (line === '' || line.startsWith('#')) continue;
    const f = line.split(' ');
    switch (f[0]) {
      case 'F':
        if (f.length >= 3) session.frames.push({ frame: Number(f[1]), cycle: Number(f[2]) });
        else session.bad.push(line);
        break;
      case 'W':
        if (f.length === 6) {
          session.writes.push({ frame: Number(f[1]), cycle: Number(f[2]), address: parseInt(f[3], 16), value: parseInt(f[4], 16), pc: parseInt(f[5], 16), line: lineNo });
        } else session.bad.push(line);
        break;
      case 'Q':
        if (f.length === 4) session.reads.push({ frame: Number(f[1]), cycle: Number(f[2]), pc: parseInt(f[3], 16) });
        else session.bad.push(line);
        break;
      case 'S':
        if (f.length === 7) {
          session.sound.push({
            frame: Number(f[1]),
            voices: f.slice(2).map((v) => {
              const [volume, frequency, midikey] = v.split(':').map(Number);
              return { volume, frequency, midikey };
            }),
          });
        } else session.bad.push(line);
        break;
      case 'M':
        session.markers.push({ frame: Number(f[1]), text: f.slice(2).join(' ') });
        break;
      case 'K':
      case 'C':
      case 'P':
      case 'X':
      case 'T':
        session.agent.push(f);
        session.agentLines.push(lineNo);
        break;
      default:
        session.bad.push(line);
    }
  }
  return session;
}

/** $4000-$4017 → 0..4 (pulse 1, pulse 2, triangle, noise, DMC), or -1 for $4014-$4017. */
export const channelOf = (address: number) => (address >= 0x4000 && address <= 0x4013 ? (address - 0x4000) >> 2 : -1);

export const CHANNEL_NAMES = ['pulse 1', 'pulse 2', 'triangle', 'noise', 'DMC'] as const;
