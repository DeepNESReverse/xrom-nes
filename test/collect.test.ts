import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DecodedNote } from '../src/decode.js';
import { pulsePhaseKept, removeTrack, writeCollection } from '../src/collection.js';
import { driverClock, markedStretch } from '../src/grid.js';
import { loopWithoutVoice, musicLoop, notesRepeat } from '../src/loop.js';

const HZ = 60;
const note = (track: string, frame: number, frames: number, midi = 60): DecodedNote => ({
  track: track as DecodedNote['track'],
  midi,
  pitch: midi,
  start: frame / HZ,
  duration: frames / HZ,
  volume: 10,
  volumeEnd: 10,
  duty: 2,
  periodIndex: 3,
});

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'nes-collect-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const grid = { rowFrames: 4, sixteenthFrames: 4, bpm: 225 };
const info = { id: 1, slug: '01_song', name: 'test', source: 'test', reading: {} };

describe('writeCollection', () => {
  it('counts every note a shared tick drops, a splinter too — a piece of the same pitch apart', () => {
    // A tick is a frame: a frame-long splinter at 10 and its note at 10.3 meet on tick 10; the two
    // noise hits of one period on tick 0 are one hit, merged, not a hit lost.
    const notes = [note('pulse1', 0, 8), note('pulse1', 10, 1, 61), note('pulse1', 10.3, 8, 62), note('noise', 0, 2), note('noise', 0.2, 2), note('noise', 4, 2), { ...note('noise', 4.2, 2), periodIndex: 9 }];
    const written = writeCollection(scratch(), info, notes, 1, grid, HZ);
    expect(written.lost).toBe(2);
    expect(written.lostDrums).toBe(1);
    expect(written.merged).toBe(1);
    expect(written.pitched).toBe(2);
  });

  it('keeps the louder of two notes as long on one tick', () => {
    const dir = scratch();
    // A quiet echo of an old pitch and the bass's D#2 meet on tick 10, a tick each.
    const notes = [{ ...note('pulse1', 10, 1, 70), volume: 2 }, { ...note('pulse1', 10.3, 1, 39), volume: 12 }];
    writeCollection(dir, info, notes, 1, grid, HZ);
    const track = JSON.parse(readFileSync(join(dir, '01_song.json'), 'utf8'));
    expect(track.pitched.map((row: number[]) => row[0])).toEqual([39]);
  });

  it('writes a pass of the loop rounded once, and nothing on or past the end', () => {
    // Ticks of 1.5 frames: a pass of 1152 frames is 768 ticks; from 0.75 frames in, each end on its
    // own rounded the pass to 767 or 769.
    const g = { rowFrames: 6, sixteenthFrames: 6, bpm: 150 };
    const dir = scratch();
    writeCollection(dir, info, [note('pulse1', 0.75, 30)], 1152.75 / HZ, g, HZ, undefined, { start: 0.75 / HZ, seconds: 1152 / HZ });
    const track = JSON.parse(readFileSync(join(dir, '01_song.json'), 'utf8'));
    expect(track.loop.ticks).toBe(768);
    expect(track.totalTicks).toBe(track.loop.start + 768);
    // The next pass's first notes, a hair before the end, round onto it: not written.
    const end = scratch();
    const notes = [note('pulse1', 0, 30), note('pulse1', 1151.6, 6, 62), note('noise', 1151.6, 2), note('noise', 1140, 30)];
    writeCollection(end, info, notes, 1152 / HZ, g, HZ, undefined, { start: 0, seconds: 1152 / HZ });
    const cut = JSON.parse(readFileSync(join(end, '01_song.json'), 'utf8'));
    expect(cut.totalTicks).toBe(768);
    expect(cut.pitched.map((row: number[]) => row[1])).toEqual([0]);
    expect(cut.drums.map((row: number[]) => [row[1], row[2]])).toEqual([[760, 8]]);
  });

  it('writes a tempo map without its empty and its unchanged stretches', () => {
    const dir = scratch();
    const notes = [note('pulse1', 0, 8), note('pulse1', 200, 8)];
    const tempo = [
      { at: 0, secondsPerTick: 2 / HZ },
      { at: 0.5 / HZ, secondsPerTick: 1 / HZ },
      { at: 64 / HZ, secondsPerTick: 1 / HZ },
      { at: 128 / HZ, secondsPerTick: 1.5 / HZ },
    ];
    writeCollection(dir, info, notes, 300 / HZ, grid, HZ, undefined, null, tempo);
    const track = JSON.parse(readFileSync(join(dir, '01_song.json'), 'utf8'));
    expect(track.tempo.map((t: { tick: number }) => t.tick)).toEqual([0, 128]);
    expect(track.secondsPerTick).toBeCloseTo(1 / HZ);
  });

  it('writes no tempo stretch past the end of the track', () => {
    // The recording's later passes changed tempo on ticks 400 and 500 of a track of 300.
    const dir = scratch();
    const tempo = [
      { at: 0, secondsPerTick: 1 / HZ },
      { at: 100 / HZ, secondsPerTick: 2 / HZ },
      { at: 400 / HZ, secondsPerTick: 1 / HZ },
      { at: 600 / HZ, secondsPerTick: 2 / HZ },
    ];
    writeCollection(dir, info, [note('pulse1', 0, 8)], 300 / HZ, grid, HZ, undefined, null, tempo);
    const track = JSON.parse(readFileSync(join(dir, '01_song.json'), 'utf8'));
    expect(track.totalTicks).toBe(200);
    expect(track.tempo.map((t: { tick: number }) => t.tick)).toEqual([0, 100]);
  });

  it('keeps the last note of a song that ends on it', () => {
    // Ticks of 2 frames: a one-frame note on the song's last frame starts on the tick its end rounds to.
    const g = { rowFrames: 4, sixteenthFrames: 8, bpm: 112.5 };
    const dir = scratch();
    const notes = [note('pulse1', 0.5, 300, 72), note('pulse1', 308, 1, 80)];
    writeCollection(dir, info, notes, 308.5 / HZ, g, HZ);
    const track = JSON.parse(readFileSync(join(dir, '01_song.json'), 'utf8'));
    expect(track.pitched.map((row: number[]) => [row[0], row[1], row[2]])).toContainEqual([80, 154, 1]);
    expect(track.totalTicks).toBe(155);
  });

  it('takes a loop of a whole number and a half ticks as the whole number: the half is a restart frame', () => {
    // Ticks of 2 frames, a pass of 2881 frames: 1440 ticks of rows and the frame the driver restarts in.
    const g = { rowFrames: 2, sixteenthFrames: 8, bpm: 112.5 };
    const dir = scratch();
    writeCollection(dir, info, [note('pulse1', 0, 30)], (192 + 2881) / HZ, g, HZ, undefined, { start: 192 / HZ, seconds: 2881 / HZ });
    const track = JSON.parse(readFileSync(join(dir, '01_song.json'), 'utf8'));
    expect(track.loop).toEqual({ start: 96, ticks: 1440 });
    expect(track.totalTicks).toBe(1536);
    // A pass of half a frame over, on ticks of a frame, is a tempo counter's: it rounds as before.
    const counter = scratch();
    writeCollection(counter, info, [note('pulse1', 0, 30)], 2200 / HZ, { rowFrames: 1, sixteenthFrames: 4, bpm: 225 }, HZ, undefined, { start: 0, seconds: 2172.5 / HZ });
    expect(JSON.parse(readFileSync(join(counter, '01_song.json'), 'utf8')).loop.ticks).toBe(2173);
  });

  it('says the pulses keep their phase only when asked, takes the source of this run, and takes a track out', () => {
    const dir = scratch();
    writeCollection(dir, { ...info, source: 'old rip' }, [note('pulse1', 0, 8)], 1, grid, HZ);
    writeCollection(dir, { ...info, id: 2, slug: '02_song', source: 'new rip', keepPulsePhase: true }, [note('pulse1', 0, 8)], 1, grid, HZ);
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    expect(index.source).toBe('new rip');
    expect(JSON.parse(readFileSync(join(dir, '01_song.json'), 'utf8')).keepPulsePhase).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, '02_song.json'), 'utf8')).keepPulsePhase).toBe(true);
    expect(removeTrack(dir, 1, '01_song')).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).tracks.map((t: { id: number }) => t.id)).toEqual([2]);
    expect(removeTrack(dir, 1, '01_song')).toBe(false);
  });

  it('puts the VRC6 voices on channels 14, 15 and 16, a pulse with its duty', () => {
    const dir = scratch();
    const notes = [note('vrc6_1', 0, 8), { ...note('vrc6_2', 0, 8), duty: 8 }, note('vrc6_saw', 4, 8)].map((n) => ({ ...n, wave: [] }));
    writeCollection(dir, info, notes, 1, grid, HZ);
    const track = JSON.parse(readFileSync(join(dir, '01_song.json'), 'utf8'));
    expect(track.pitched.map((row: number[]) => [row[3], row[6], row[13]])).toEqual([
      [14, 2, -1],
      [15, 8, -1],
      [16, 0, -1],
    ]);
    expect(Math.round(track.pitched[0][5])).toBe(Math.round(440 * 2 ** ((60 - 69) / 12) * 100));
    expect(track.channels.slice(4).map((c: { name: string; channel: number }) => [c.name, c.channel])).toEqual([
      ['vrc6_1', 14],
      ['vrc6_2', 15],
      ['vrc6_saw', 16],
    ]);
    expect(track.waves).toBeUndefined();
  });
});

describe('pulsePhaseKept', () => {
  // A scale on pulse 1, a note every 8 frames, all under one high byte; `everyNote` writes $4003 on each.
  const scale = (everyNote: boolean) => {
    const notes = Array.from({ length: 12 }, (_, i) => note('pulse1', i * 8, 8, 60 + (i % 5)));
    const writes = [{ time: 0, address: 0x4003, value: 0x01 }];
    if (everyNote) for (let i = 1; i < 12; i++) writes.push({ time: (i * 8) / HZ, address: 0x4003, value: 0x01 });
    return { notes, writes };
  };
  it('reads a driver that writes the high byte only when it changes', () => {
    const { notes, writes } = scale(false);
    expect(pulsePhaseKept(writes, notes, 0, 2, HZ)).toMatchObject({ keep: true, repeats: 0, evidence: 11 });
  });
  it('not a driver that writes it on every note', () => {
    const { notes, writes } = scale(true);
    expect(pulsePhaseKept(writes, notes, 0, 2, HZ).keep).toBe(false);
  });
  it('not on a few notes', () => {
    const { notes, writes } = scale(false);
    expect(pulsePhaseKept(writes, notes.slice(0, 3), 0, 2, HZ).keep).toBe(false);
  });
  it('a rewrite after a rest says nothing', () => {
    const { notes, writes } = scale(false);
    const later = notes.map((n) => ({ ...n, start: n.start + 2 }));
    const all = [...notes, ...later];
    expect(pulsePhaseKept([...writes, { time: 2, address: 0x4003, value: 0x01 }], all, 0, 4, HZ).keep).toBe(true);
  });
});

describe('driverClock', () => {
  it("puts tick k on frame ceil((256k − phase) / T), as Double Dragon's converter has it", () => {
    const T = 0x9b;
    const clock = driverClock({ increment: T, phase: 119, modulus: 256, changes: [] }, HZ, 2000);
    for (let k = 1; k < 200; k++) expect(clock.tickFrames[k]).toBe(Math.ceil((256 * k - 119) / T));
    for (let f = 0; f < 1000; f++) expect(clock.ticksAt(f / HZ, 'floor')).toBe(Math.floor((119 + T * f) / 256));
    // An even clock: tick k at k ticks of 256/T frames.
    expect(clock.secondsOf(10)).toBeCloseTo((10 * 256) / T / HZ, 9);
  });

  it("reads River City Ransom's carries from 254, and an end between two ticks' frames", () => {
    const T = 0x78;
    const clock = driverClock({ increment: T, phase: 254, modulus: 256, changes: [] }, HZ, 500);
    for (let f = 0; f < 400; f++) expect(clock.ticksAt(f / HZ, 'floor')).toBe(Math.floor((254 + T * f) / 256));
    const [a, b] = [clock.tickFrames[5], clock.tickFrames[6]];
    expect(clock.ticksAt((a + (b - a) / 2) / HZ, 'between')).toBeCloseTo(5.5, 9);
  });

  it('carries the accumulator over a change of tempo and starts a stretch on the next tick', () => {
    const clock = driverClock({ increment: 0x96, phase: 254, modulus: 256, changes: [{ frame: 327, increment: 0x6e }] }, HZ, 900);
    let acc = 254;
    const ticks: number[] = [];
    for (let f = 0, count = -1; f < 800; f++) {
      if (f > 0) acc += f - 1 < 327 ? 0x96 : 0x6e;
      while (count < Math.floor(acc / 256) - 0) {
        count++;
        if (count > 0) ticks.push(f);
      }
    }
    expect(clock.tickFrames.slice(1, ticks.length + 1)).toEqual(ticks);
    expect(clock.stretches).toHaveLength(2);
    expect(clock.tickFrames[clock.stretches[1].tick]).toBeGreaterThanOrEqual(327);
    expect(clock.stretches[1].secondsPerTick).toBeCloseTo(256 / 0x6e / HZ, 9);
  });

  it('starts the count again where a change gives a phase', () => {
    // A tick every 2.5 frames; from frame 51 every 2, the count started afresh there half a tick in.
    const clock = driverClock({ increment: 256, phase: 0, modulus: 640, changes: [{ frame: 51, increment: 320, phase: 320 }] }, HZ, 100);
    expect(clock.tickFrames.filter((f) => f >= 50).slice(0, 5)).toEqual([50, 51, 52, 54, 56]);
    // Carried over, the accumulator's 0.4 of a tick put them on 53, 55, 57.
    const carried = driverClock({ increment: 256, phase: 0, modulus: 640, changes: [{ frame: 51, increment: 320 }] }, HZ, 100);
    expect(carried.tickFrames.filter((f) => f >= 50).slice(0, 4)).toEqual([50, 53, 55, 57]);
    expect(() => driverClock({ increment: 0, phase: 0, modulus: 256, changes: [] }, HZ, 10)).toThrow();
  });

  it('puts a start on the first or the last of the ticks a frame runs', () => {
    // A tempo of 1.5 ticks a frame: frame 2 runs ticks 2 and 3.
    const clock = driverClock({ increment: 384, phase: 0, modulus: 256, changes: [] }, HZ, 20);
    expect(clock.ticksAt(2 / HZ, 'floor')).toBe(3);
    expect(clock.ticksAt(2 / HZ, 'first')).toBe(2);
    expect(clock.ticksAt(3 / HZ, 'first')).toBe(4);
  });

  it('takes a modulus of 150, as Dragon Warrior counts', () => {
    const clock = driverClock({ increment: 125, phase: 0, modulus: 150, changes: [] }, HZ, 600);
    for (let k = 1; k < 100; k++) expect(clock.tickFrames[k]).toBe(Math.ceil((150 * k) / 125));
  });
});

/** A tune of `bar` frames, a note every `step` frames, the keys walking — played `passes` times, each pass `extra` frames longer. */
const tune = (bar: number, step: number, passes: number, extra = 0, track = 'pulse1') => {
  const notes: DecodedNote[] = [];
  for (let p = 0; p < passes; p++)
    for (let f = 0; f < bar; f += step) notes.push(note(track, p * (bar + extra) + f, step, 60 + ((f / step) % 7)));
  return notes;
};

describe('musicLoop', () => {
  it('leaves out the frame a driver takes to start the song over', () => {
    const notes = tune(768, 6, 30, 1);
    const loop = musicLoop({ start: 1 / HZ, seconds: 769 / HZ, exact: true }, notes, HZ, 6);
    expect(Math.round(loop.seconds * HZ)).toBe(768);
    expect(loop.restart).toBe(true);
    // The start slid back onto the first note: the writes of frame 0 differ, the notes do not.
    expect(loop.start).toBe(0);
  });

  it('takes the smallest period the notes repeat at, not the writes', () => {
    const notes = tune(300, 10, 40);
    const loop = musicLoop({ start: 0, seconds: 1200 / HZ, exact: true }, notes, HZ, 10);
    expect(Math.round(loop.seconds * HZ)).toBe(300);
    expect(loop.passes).toBe(4);
  });

  it('keeps a period whose passes differ in a note', () => {
    const notes = tune(300, 10, 40).map((n, i) => (i % 120 === 7 ? { ...n, midi: 50 } : n));
    expect(notesRepeat(notes, HZ, 0, 300 / HZ)).toBe(false);
    const loop = musicLoop({ start: 0, seconds: 1200 / HZ, exact: true }, notes, HZ, 10);
    expect(Math.round(loop.seconds * HZ)).toBe(1200);
  });

  it('slides the start back while the bars before it repeat', () => {
    // An intro of 100 frames, then the tune: found starting 65 frames into it.
    const intro = [note('pulse1', 0, 100, 40)];
    const notes = [...intro, ...tune(320, 8, 20).map((n) => ({ ...n, start: n.start + 100 / HZ }))];
    const loop = musicLoop({ start: (100 + 65) / HZ, seconds: 320 / HZ, exact: true }, notes, HZ, 8);
    expect(Math.round(loop.start * HZ)).toBe(100);
  });

  it('slides back over a note the decoder joined to the one before it in a later pass', () => {
    // The writes repeat from frame 17, the notes from 0 — but the first pass strikes a note twice
    // (a re-strike at frame 16 of the same key) and the second holds it as one note, and the second
    // pass's noise sweep starts 2 frames early, joined with the hit on its bar line.
    const P = 320;
    const notes = tune(P, 8, 20).filter((n) => !(Math.round(n.start * HZ) % P === 8 || Math.round(n.start * HZ) % P === 16));
    for (let p = 0; p < 20; p++) {
      // Split, the first pass's two notes sound the same levels (8, falling to 2; 8 again).
      if (p === 0) notes.push({ ...note('pulse1', 8, 8, 61), volume: 8, volumeEnd: 2, levels: [[0, 8], [7 / HZ, 2]] }, { ...note('pulse1', 16, 8, 61), volume: 8, volumeEnd: 8 });
      // Joined, the re-strike is still in its levels: 2 → 8 eight frames in.
      else notes.push({ ...note('pulse1', p * P + 8, 16, 61), levels: [[0, 8], [7 / HZ, 2], [8 / HZ, 8]] });
      if (p === 0) notes.push(note('noise', 0, 20));
      else notes.push({ ...note('noise', p * P - 2, 22), periodIndex: 5 });
    }
    const loop = musicLoop({ start: 17 / HZ, seconds: P / HZ, exact: true }, notes, HZ, 8);
    expect(Math.round(loop.start * HZ)).toBe(0);
    // A longer note where the pickup has two is another rhythm: the slide stops there.
    const passes = Array.from({ length: 20 }, (_, p) => [
      ...Array.from({ length: P / 16 - 1 }, (_, k) => note('pulse1', 16 + p * P + k * 16, 16, 64 + (k % 5))),
      note('pulse1', 16 + p * P + P - 16, 16, 62),
    ]).flat();
    const held = [note('pulse1', 0, 8, 50), note('pulse1', 8, 8, 62), ...passes];
    expect(Math.round(musicLoop({ start: 17 / HZ, seconds: P / HZ, exact: true }, held, HZ, 16).start * HZ)).toBe(16);
  });

  it('does not slide into a drum roll under a decay held on in the passes', () => {
    // A roll of one drum before the tune; each pass holds another drum's decay over those places.
    const roll = [70, 76, 82, 88, 94].map((frame) => ({ ...note('noise', frame, 5), periodIndex: 0 }));
    const decays = Array.from({ length: 20 }, (_, p) => ({ ...note('noise', 100 + p * 320 + 230, 90), periodIndex: 2 }));
    const notes = [...roll, ...decays, ...tune(320, 8, 20).map((n) => ({ ...n, start: n.start + 100 / HZ }))];
    const loop = musicLoop({ start: (100 + 65) / HZ, seconds: 320 / HZ, exact: true }, notes, HZ, 8);
    expect(Math.round(loop.start * HZ)).toBe(100);
  });

  it('does not slide into an intro that is the tune without its drums', () => {
    const melody = tune(320, 8, 21);
    const drums = tune(320, 8, 20, 0, 'noise').map((n) => ({ ...n, start: n.start + 320 / HZ }));
    const loop = musicLoop({ start: 320 / HZ, seconds: 320 / HZ, exact: true }, [...melody, ...drums], HZ, 8);
    expect(Math.round(loop.start * HZ)).toBe(320);
  });
});

describe('loopWithoutVoice', () => {
  it('finds the tune without a voice that goes round on its own', () => {
    const notes = [...tune(1000, 50, 29), ...Array.from({ length: 298 }, (_, i) => note('n163_1', i * 97, 5, 70))];
    const loop = loopWithoutVoice([], notes, HZ, 480);
    expect(loop?.without).toBe('n163_1');
    // Found in the notes, to within a frame and a half.
    expect(Math.abs(loop!.seconds * HZ - 1000)).toBeLessThanOrEqual(1.5);
  });
});

describe('markedStretch', () => {
  it('marks the stretch that holds most of the song, else the first that holds a tick', () => {
    // Take Care: a three-frame run-up at 3 frames a sixteenth, then sixteenths of 6.
    expect(markedStretch([{ at: 0, sixteenthFrames: 3 }, { at: 3 / HZ, sixteenthFrames: 6 }], 600 / HZ, HZ)).toBe(1);
    // Big Thunder Mountain: INIT's frame, a stretch of no tick, then a tempo raised every pass.
    const speeding = [0, 0.4, 1002, 1772, 2479, 3117, 3700, 4249].map((frame, i) => ({ at: frame / HZ, sixteenthFrames: [4.4, 5.6, 5.4, 4.9, 4.5, 4.05, 3.8, 3.6][i] }));
    expect(markedStretch(speeding, 4761 / HZ, HZ)).toBe(1);
  });

  it('counts the ticks inside the song only', () => {
    // A recording's later passes slow down past the end: the song is all at 6.
    expect(markedStretch([{ at: 0, sixteenthFrames: 6 }, { at: 600 / HZ, sixteenthFrames: 12 }], 500 / HZ, HZ)).toBe(0);
    // Half is not more: Alm 2, 1024 ticks at ♩150 and 1024 at ♩140.6 (a hair over in seconds).
    const halves = [{ at: 0, sixteenthFrames: 6 }, { at: 1536 / HZ, sixteenthFrames: 6.4 }];
    expect(markedStretch(halves, (1536 + 1638.4 + 0.01) / HZ, HZ)).toBe(0);
  });

  it('marks a stretch a metronome beats', () => {
    // The Answer: 120 frames at ♩150, then a loop at ♩34.7 — the ♩150 is marked.
    const answer = [{ at: 0, sixteenthFrames: 6 }, { at: 120 / HZ, sixteenthFrames: 26 }];
    expect(markedStretch(answer, 951 / HZ, HZ)).toBe(0);
    // ♩300 in 4/4 is 𝅗𝅥150 counted in halves; without halves to count in it is past the metronome.
    const fast = [{ at: 0, sixteenthFrames: 6 }, { at: 30 / HZ, sixteenthFrames: 3 }];
    expect(markedStretch(fast, 600 / HZ, HZ, 1, 2)).toBe(1);
    expect(markedStretch(fast, 600 / HZ, HZ, 1, 1)).toBe(0);
  });
});

describe('musicLoop, by what sounds', () => {
  /** A pulse 1 line of `step`-frame notes, the same every `bar` frames, for `passes` passes. */
  const line = (bar: number, step: number, passes: number) => tune(bar, step, passes);

  it('does not slide back onto a note held from the intro that a pass later is another', () => {
    // RoadBlasters' Course Select: the intro's triangle A3 sounds frames 0-144; every later pass has
    // an A4 from 36 frames into it to 178. The writes repeat from 182; the onsets alone took it to 48.
    const P = 384;
    const notes = [...line(P, 12, 12), note('triangle', 0, 144, 57)];
    for (let p = 1; p < 12; p++) notes.push(note('triangle', p * P + 36, 142, 69));
    const loop = musicLoop({ start: 182 / HZ, seconds: P / HZ, exact: true }, notes, HZ, 12);
    expect(Math.round(loop.start * HZ)).toBe(180);
  });

  it('does not slide back through a note of another length', () => {
    // Flipull's Ending Credit: the first pass's triangle C at 100 lasts 6 frames, every later one 3.
    const P = 144;
    const notes = line(P, 9, 12);
    for (let p = 0; p < 12; p++) notes.push(note('triangle', p * P + 100, p === 0 ? 6 : 3, 48));
    const loop = musicLoop({ start: 110 / HZ, seconds: P / HZ, exact: true }, notes, HZ, 9);
    expect(Math.round(loop.start * HZ)).toBe(108);
  });

  it('does not slide back over notes of another length, but over another level', () => {
    // Metal Fighter's Main BGM: the first pass holds pulse 2 for 10 frames where every later pass
    // holds it 30 — and at a flat 4 where they rise to 6, which alone is no other note.
    const P = 320;
    const notes = line(P, 10, 12);
    for (let p = 0; p < 12; p++)
      for (let f = 0; f < P; f += 40) notes.push({ ...note('pulse2', p * P + f, p === 0 ? 10 : 30, 67), volume: 4, volumeEnd: p === 0 ? 4 : 6 });
    // The onsets alone slid it to 0; the first pass's last short pulse 2 note sounds 280 to 290 where a
    // pass later it goes on to 310.
    expect(Math.round(musicLoop({ start: 313 / HZ, seconds: P / HZ, exact: true }, notes, HZ, 10).start * HZ)).toBe(310);
    const levels = line(P, 10, 12);
    for (let p = 0; p < 12; p++)
      for (let f = 0; f < P; f += 40) levels.push({ ...note('pulse2', p * P + f, 10, 67), volume: 4, volumeEnd: p === 0 ? 4 : 6 });
    expect(Math.round(musicLoop({ start: 313 / HZ, seconds: P / HZ, exact: true }, levels, HZ, 10).start * HZ)).toBe(0);
  });

  it('slides back to a start in silence that later passes fill with the last note held on', () => {
    // Ghost Lion's Danger: every pass but the first opens under an echo of the last note, 12 frames.
    const P = 320;
    const notes = line(P, 10, 12);
    for (let p = 0; p < 12; p++) notes.push(note('pulse2', p * P + P - 20, 32, 67));
    expect(Math.round(musicLoop({ start: 12 / HZ, seconds: P / HZ, exact: true }, notes, HZ, 10).start * HZ)).toBe(0);
  });

  it('moves the start past a note held across it that a pass later is another', () => {
    // Spelunker II's Boss: the writes repeat from 873, where a C#3 struck at 872 sounds to 880 and a
    // pass later an E3 does.
    const P = 512;
    const notes = line(P, 8, 6).map((n) => ({ ...n, start: n.start + 880 / HZ }));
    notes.push(note('triangle', 872, 8, 49));
    for (let p = 1; p < 6; p++) notes.push(note('triangle', 872 + p * P, 8, 52));
    const loop = musicLoop({ start: 873 / HZ, seconds: P / HZ, exact: true }, notes, HZ, 8);
    expect(Math.round(loop.start * HZ)).toBe(880);
  });
});

describe('markedStretch, a frame either way', () => {
  it('marks the first of two stretches of one length, the last a frame long', () => {
    // Kid Niki's Chirin Dojo (12/8): 216 frames at 4.5 a sixteenth, then 145 at 3 — 192 ticks and 193.3.
    const chirin = [{ at: 0, sixteenthFrames: 4.5 }, { at: 216 / HZ, sixteenthFrames: 3 }];
    expect(markedStretch(chirin, 361 / HZ, HZ, 2 / 3, 2)).toBe(0);
    // Four ticks over is more than a frame: the second.
    expect(markedStretch(chirin, 363 / HZ, HZ, 2 / 3, 2)).toBe(1);
  });
});
