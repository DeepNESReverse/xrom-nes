import { describe, expect, it } from 'vitest';
import { driverStarts, nearLoop, sourcesOf } from '../src/agent/listen.ts';
import type { ProbeSession, ProbeWrite } from '../src/probe/session.ts';
import type { DecodedNote } from '../src/decode.ts';
import { DumpPlayer, songTables, withRom } from '../src/agent/driver.ts';
import { agreement, type Experiment } from '../src/agent/cartridge.ts';
import { createMapper } from '../src/mappers.ts';

/** A session of `frames` frames with the writes given. */
const session = (frames: number, writes: ProbeWrite[]): ProbeSession => ({
  dir: '',
  meta: { cyclesPerFrame: 29780.5 },
  frames: Array.from({ length: frames }, (_, i) => ({ frame: i + 1, cycle: Math.round(i * 29780.5) })),
  writes,
  reads: [],
  sound: [],
  markers: [],
  agent: [],
  agentLines: [],
  ramFrames: 0,
  bad: [],
});
const w = (frame: number, address: number, value: number, pc: number): ProbeWrite => ({ frame, cycle: 100, address, value, pc });

describe('the agent listening', () => {
  it('takes a rare $4015 write for a song starting, and a frequent one for not', () => {
    const writes = [w(100, 0x4015, 0x0f, 0x803c), w(2000, 0x4015, 0x0f, 0x803c)];
    // A DMC driver writes $4015 every few frames to strike samples.
    for (let f = 1; f <= 3000; f += 4) writes.push(w(f, 0x4015, 0x1f, 0xc000));
    expect(driverStarts(session(3000, writes)).map((s) => s.frame)).toEqual([100, 2000]);
  });

  it('tells the music from an effect by who writes in the first frames after a song starts', () => {
    const writes: ProbeWrite[] = [w(100, 0x4015, 0x0f, 0x803c)];
    for (let f = 1; f <= 3000; f++) writes.push(w(f, 0x4000, 0x30, 0x8265)); // the frame routine
    for (let f = 101; f <= 3000; f += 8) writes.push(w(f, 0x4002, 0x40, 0x81dc)); // music, from the start
    for (const burst of [400, 1200, 2400]) for (let f = burst; f < burst + 40; f += 2) writes.push(w(f, 0x4002, 0x20, 0x8482));
    const { role } = sourcesOf(session(3000, writes));
    expect(role.get(0x8265)).toBe('every frame');
    expect(role.get(0x81dc)).toBe('music');
    expect(role.get(0x8482)).toBe('effect');
  });

  it('finds a near repeat and the passes that differ', () => {
    const notes: DecodedNote[] = [];
    const hz = 60;
    for (let pass = 0; pass < 20; pass++) {
      for (let k = 0; k < 8; k++) {
        // Pass 6 plays other notes, as the story music changes its chords.
        const midi = pass === 6 ? 50 + k : 60 + k;
        notes.push({ track: 'pulse1', midi, pitch: midi, start: (pass * 80 + k * 10) / hz, duration: 8 / hz, volume: 8, volumeEnd: 8, duty: 2, periodIndex: 0 });
      }
    }
    const near = nearLoop(notes, hz, 1600 / hz);
    expect(near?.frames).toBe(80);
    expect(near?.differing).toEqual([6, 7]);
  });

  it("counts the songs from the gap between the driver's parallel tables", () => {
    // $8006: LDA $9000,X / STA $00 / LDA $900B,X / STA $01 / RTS — two tables of eleven songs.
    const upper = new Uint8Array(0xa000);
    const code = [0xbd, 0x00, 0x90, 0x85, 0x00, 0xbd, 0x0b, 0x90, 0x85, 0x01, 0x60];
    upper.set(code, 0x8006 - 0x6000);
    const tables = songTables({ ram: new Uint8Array(0x800), upper }, 0x8006, 'x', 2);
    expect(tables.bases).toEqual([0x9000, 0x900b]);
    expect(tables.layout).toBe('parallel tables');
  });

  it('plays INIT then PLAY on the dump, and passes over a frame the game lagged', () => {
    // INIT $8010: STX $00 / RTS. PLAY $8000: LDA $00 / STA $4002 / INC $00 / RTS.
    const upper = new Uint8Array(0xa000);
    upper.set([0x86, 0x00, 0x60], 0x8010 - 0x6000);
    upper.set([0xa5, 0x00, 0x8d, 0x02, 0x40, 0xe6, 0x00, 0x60], 0x8000 - 0x6000);
    const player = new DumpPlayer({ ram: new Uint8Array(0x800), upper });
    const mine = [...player.call(0x8010, { x: 5 })];
    for (let f = 1; f < 6; f++) mine.push(...player.call(0x8000, {}));
    expect(mine.map((w) => w.value)).toEqual([5, 6, 7, 8, 9]);
    // FCEUX: the same writes, with frame 3 empty — the game busy, PLAY not called.
    const fceux: Experiment = {
      id: 't1',
      value: 5,
      hit: { frame: 100, a: 0, x: 5, y: 0 },
      writes: [1, 2, 4, 5, 6].map((frame, i) => ({ frame, cycle: 0, address: 0x4002, value: 5 + i, pc: 0x8005 })),
      frames: 7,
    };
    const a = agreement(fceux, mine);
    expect(a.firstDiffering).toBeNull();
    expect(a.lagged).toBe(1);
    expect(a.prefix).toBe(4); // frame 6 is past the dump player's five
  });

  it('sets a mapper to the banks a dump shows', () => {
    // MMC3, 8 banks of 8 KB, each filled with its number; the dump has 3, 5, 6 (second last), 7.
    const prg = new Uint8Array(8 * 0x2000).map((_, i) => i >> 13);
    const mmc3 = createMapper(4, prg);
    expect(mmc3.restore([3, 5, 6, 7])).toBe(true);
    expect([0x8000, 0xa000, 0xc000, 0xe000].map((a) => mmc3.read(a))).toEqual([3, 5, 6, 7]);
    expect(createMapper(4, prg).restore([6, 5, 3, 7])).toBe(true); // $C000 swapped in
    expect(createMapper(4, prg).restore([1, 5, 3, 7])).toBe(false); // no MMC3 maps this
    // The ROM file around it: header, mapper 4, 128 KB of PRG.
    const file = new Uint8Array(16 + prg.length);
    file.set([0x4e, 0x45, 0x53, 0x1a, 8, 0, 0x40, 0]);
    file.set(prg, 16);
    const upper = new Uint8Array(0xa000);
    [3, 5, 6, 7].forEach((bank, slot) => upper.fill(bank, 0x2000 + slot * 0x2000, 0x4000 + slot * 0x2000));
    const dump = withRom({ ram: new Uint8Array(0x800), upper }, file);
    expect(new DumpPlayer(dump).peek(0xa123)).toBe(5);
  });
});
