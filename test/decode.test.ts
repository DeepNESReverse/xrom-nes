import { describe, expect, it } from 'vitest';
import { decode, driverPhase, wavePeriods } from '../src/decode.js';

describe('wavePeriods', () => {
  it('finds a wave that holds its shape twice, and stretches one period over the length', () => {
    const bass = [0, 0, 0, 0, 15, 15, 15, 15, 0, 0, 0, 0, 15, 15, 15, 15];
    expect(wavePeriods(bass)).toEqual({ times: 2, wave: [0, 0, 0, 0, 0, 0, 0, 0, 15, 15, 15, 15, 15, 15, 15, 15] });
  });

  it('leaves a flat wave alone', () => {
    expect(wavePeriods(new Array(64).fill(32)).times).toBe(1);
  });

  it('leaves a wave of one period alone', () => {
    const saw = Array.from({ length: 16 }, (_, i) => i);
    expect(wavePeriods(saw)).toEqual({ times: 1, wave: saw });
  });

  it('folds a wave whose periods differ by a sample', () => {
    // Four periods of a 16-sample sine, one sample of the third nudged: heard two octaves up.
    const wave = Array.from({ length: 64 }, (_, i) => Math.round(32 + 30 * Math.sin((2 * Math.PI * i) / 16)));
    wave[37] += 2;
    expect(wavePeriods(wave).times).toBe(4);
  });

  it('leaves a wave with a real fundamental under its overtones alone', () => {
    const wave = Array.from({ length: 64 }, (_, i) =>
      Math.round(32 + 20 * Math.sin((2 * Math.PI * i) / 32) + 8 * Math.sin((2 * Math.PI * i) / 64))
    );
    expect(wavePeriods(wave).times).toBe(1);
  });
});

describe('driverPhase', () => {
  it('counts the expansion chip in the update, not the 2A03 alone', () => {
    // 60 frames of 1000 samples: the N163's writes from 100 to 590, then two pulse writes at 600.
    // Read off the pulses alone, the window would start at 600 and every N163 write would fall
    // into the window before its own update.
    const writes: { time: number; address: number; value: number }[] = [];
    for (let f = 1; f < 60; f++) {
      for (let k = 0; k < 50; k++) writes.push({ time: (f * 1000 + 100 + k * 10) / 1000, address: 0x4800, value: 0 });
      writes.push({ time: (f * 1000 + 600) / 1000, address: 0x4000, value: 0 });
      writes.push({ time: (f * 1000 + 602) / 1000, address: 0x4002, value: 0 });
    }
    expect(driverPhase(writes, 1000, 1000)).toBe(100);
  });
});

describe('decode, FDS', () => {
  const fdsNote = (time: number) => [
    { time, address: 0x4080, value: 0x80 | 20 },
    { time, address: 0x4082, value: 0x00 },
    { time, address: 0x4083, value: 0x04 },
  ];
  const setup = [
    { time: 0, address: 0x4023, value: 0x83 },
    { time: 0, address: 0x4089, value: 0x80 },
    ...Array.from({ length: 64 }, (_, i) => ({ time: 0, address: 0x4040 + i, value: i < 32 ? 0 : 63 })),
    { time: 0, address: 0x4089, value: 0x00 },
  ];

  it('strikes again where the driver writes $4083, with the gain unchanged', () => {
    const notes = decode([...setup, ...fdsNote(0.1), ...fdsNote(0.6)], 1, 60).filter((n) => n.track === 'fds');
    expect(notes.map((n) => Math.round(n.start * 60))).toEqual([6, 36]);
  });

  it('keeps a note whose $4083 is written every frame as one', () => {
    const writes = [...setup];
    for (let f = 6; f < 50; f++) writes.push(...fdsNote(f / 60 + 0.001));
    expect(decode(writes, 1, 60).filter((n) => n.track === 'fds')).toHaveLength(1);
  });
});

describe('decode, strikes on the 2A03', () => {
  const on = [{ time: 0, address: 0x4015, value: 0x0f }];
  const at = (f: number) => f / 60 + 0.001;
  const pulse = (f: number, volume: number, period: number, restart: boolean) => [
    { time: at(f), address: 0x4000, value: 0xb0 | volume },
    { time: at(f), address: 0x4002, value: period & 0xff },
    ...(restart ? [{ time: at(f), address: 0x4003, value: 0x08 | (period >> 8) }] : []),
  ];
  const starts = (writes: { time: number; address: number; value: number }[], track: string) =>
    decode([...on, ...writes].sort((a, b) => a.time - b.time), 1.2, 60)
      .filter((n) => n.track === track)
      .map((n) => Math.round(n.start * 60));

  it('keeps a tremolo between two keyed strikes in one note', () => {
    const writes: { time: number; address: number; value: number }[] = [];
    for (let f = 0; f < 60; f++) writes.push(...pulse(f, f % 4 < 2 ? 12 : 9, 0x1a0, f % 15 === 0));
    expect(starts(writes, 'pulse1')).toEqual([0, 15, 30, 45]);
  });

  it('keeps a vibrato crossing period $100 in one note when the driver writes $4003 on a change', () => {
    const writes: { time: number; address: number; value: number }[] = [];
    let hi = -1;
    for (let f = 0; f < 60; f++) {
      const period = f % 4 < 2 ? 0x0fe : 0x101;
      writes.push(...pulse(f, 10, period, period >> 8 !== hi));
      hi = period >> 8;
    }
    expect(starts(writes, 'pulse1')).toEqual([0]);
  });

  it('starts a note at its write when the envelope starts silent', () => {
    const writes = [...pulse(0, 8, 0x1a0, true), ...pulse(5, 0, 0x1a0, false), ...pulse(8, 0, 0x150, true)];
    for (let f = 10; f < 30; f++) writes.push(...pulse(f, 8, 0x150, false));
    writes.push(...pulse(12, 8, 0x150, true));
    expect(starts(writes, 'pulse1')).toEqual([0, 8, 12]);
  });

  it('keeps an attack climbing a frame a step in its note', () => {
    // Tombs & Treasure: 3, 7, 11, 12 on each new pitch, `$4003` written only when its high bits change.
    const writes: { time: number; address: number; value: number }[] = [];
    const notes = [0x1ae, 0x142, 0x155, 0x1ae];
    notes.forEach((period, n) => {
      for (let k = 0; k < 12; k++) writes.push(...pulse(n * 12 + k, [3, 7, 11][k] ?? 12, period, n === 0 && k === 0));
    });
    expect(starts(writes, 'pulse1')).toEqual([0, 12, 24, 36]);
  });

  it('starts a note at its strike when the frame before was the tail of the last one, at its pitch', () => {
    // Contra Force: the note before ends a frame at the next one's pitch, level 1; the strike is 6, falling.
    const writes = [...pulse(0, 8, 0x200, true)];
    for (let f = 1; f < 9; f++) writes.push(...pulse(f, 8 - f / 2, 0x200, false));
    writes.push(...pulse(9, 1, 0x17d, false), ...pulse(10, 6, 0x17d, false), ...pulse(11, 5, 0x17d, false), ...pulse(12, 4, 0x17d, false));
    expect(starts(writes, 'pulse1')).toEqual([0, 9, 10]);
  });

  it('keeps an instrument that re-attacks at one distance after every strike in its notes', () => {
    // Yoshi's Cookie: 15 15 10 8, then 15 again four frames after every `$4003` write.
    const shape = [15, 15, 10, 8, 15, 15, 10, 8, 7, 6, 5, 4];
    const writes: { time: number; address: number; value: number }[] = [];
    for (let n = 0; n < 5; n++) shape.forEach((v, k) => writes.push(...pulse(n * 12 + k, v, 0x1a0, k === 0)));
    expect(starts(writes, 'pulse1')).toEqual([0, 12, 24, 36, 48]);
  });

  it('keeps a note through a short silence at its pitch with no strike', () => {
    // Ikari Warriors III: 10 10 10 10 10 0 0 0 5 5, struck once by the driver.
    const shape = [10, 10, 10, 10, 10, 0, 0, 0, 5, 5];
    const writes: { time: number; address: number; value: number }[] = [];
    for (let n = 0; n < 4; n++) shape.forEach((v, k) => writes.push(...pulse(n * 10 + k, v, 0x1a0, k === 0)));
    expect(starts(writes, 'pulse1')).toEqual([0, 10, 20, 30]);
  });

  it('starts a note at its write at level 0 while it slides on as it sounds', () => {
    // Alien 3: `$4003` written at level 0, the period moving a little each frame after.
    const writes = [...pulse(0, 4, 0x200, true)];
    for (let f = 1; f < 10; f++) writes.push(...pulse(f, 4, 0x200, false));
    writes.push(...pulse(10, 0, 0x1c3, true), ...pulse(11, 4, 0x1b7, false), ...pulse(12, 3, 0x1ab, false), ...pulse(13, 2, 0x1ab, false));
    writes.push(...pulse(20, 4, 0x1ab, true));
    expect(starts(writes, 'pulse1')).toEqual([0, 10, 20]);
  });

  it('starts a note where its period was set at level 0', () => {
    // Family Block: each note's period written with `$4002` alone, a frame before it sounds.
    const writes = [...pulse(0, 6, 0x0be, true)];
    for (let f = 1; f < 6; f++) writes.push(...pulse(f, 6, 0x0be, false));
    writes.push(...pulse(6, 0, 0x098, false));
    for (let f = 7; f < 12; f++) writes.push(...pulse(f, 6, 0x098, false));
    expect(starts(writes, 'pulse1')).toEqual([0, 6]);
  });

  it('keeps a triangle vibrato that rewrites $400B on every step in one note', () => {
    // Fire Emblem Gaiden: `$400A`/`$400B` together on each step; `$4008` only when it strikes.
    const writes: { time: number; address: number; value: number }[] = [];
    for (const n of [0, 30]) {
      writes.push({ time: at(n), address: 0x4008, value: 0xff });
      for (let k = 0; k < 30; k += 2) {
        const period = 0x0e1 + [0, 1, 0, -1][(k / 2) % 4];
        writes.push({ time: at(n + k), address: 0x400a, value: period & 0xff }, { time: at(n + k), address: 0x400b, value: period >> 8 });
      }
    }
    expect(starts(writes, 'triangle')).toEqual([0, 30]);
  });

  it('takes the noise rewritten on the way down as one hit', () => {
    // Maniac Mansion: `$400F` every second frame, two rates in turn, as the level falls.
    const writes: { time: number; address: number; value: number }[] = [];
    for (const n of [0, 20]) {
      for (let k = 0; k < 12; k++) {
        writes.push({ time: at(n + k), address: 0x400c, value: 0x30 | (11 - k) });
        if (k % 2 === 0) writes.push({ time: at(n + k), address: 0x400e, value: k % 4 ? 2 : 15 }, { time: at(n + k), address: 0x400f, value: 0xff });
      }
    }
    expect(starts(writes, 'noise')).toEqual([0, 20]);
  });

  it('strikes a leap the driver writes under a sweep that goes the same way', () => {
    // Route 16 Turbo: `$4005` = $FF (up, shift 7) all the while; octaves struck through `$4007`.
    const writes = [{ time: at(0), address: 0x4001, value: 0xff }];
    for (let f = 0; f < 24; f++) writes.push(...pulse(f, 15, f < 6 || (f >= 12 && f < 18) ? 0x2fa : 0x17d, f % 6 === 0));
    expect(starts(writes, 'pulse1')).toEqual([0, 6, 12, 18]);
  });

  it('keeps a note on a looping hardware envelope whole', () => {
    // Wizards & Warriors: `$4000` = $E1, the chip's own saw climbing back to 15 every 8 frames.
    const writes = [
      { time: at(0), address: 0x4000, value: 0xe1 },
      { time: at(0), address: 0x4002, value: 0xa0 },
      { time: at(0), address: 0x4003, value: 0x09 },
      { time: at(30), address: 0x4003, value: 0x09 },
      { time: at(60), address: 0x4003, value: 0x09 },
    ];
    expect(starts(writes, 'pulse1')).toEqual([0, 30, 60]);
  });

  /** A pulse note frame by frame: its levels, with `$4003` written on the first frame only when `written`. */
  const shape = (from: number, levels: number[], period: number, written: boolean, duty = 2) =>
    levels.flatMap((v, k) => [
      { time: at(from + k), address: 0x4000, value: (duty << 6) | 0x30 | v },
      { time: at(from + k), address: 0x4002, value: period & 0xff },
      ...(written && k === 0 ? [{ time: at(from + k), address: 0x4003, value: 0x08 | (period >> 8) }] : []),
    ]);
  /** Other notes written the same way, so that the channel's driver reads as one that keys its notes. */
  const keyed = (from: number) => [0, 1, 2].flatMap((n) => shape(from + n * 8, [9, 8, 7, 6, 5, 4, 3, 2], 0x0e0 + n, true));

  it('strikes a pitch again where the envelope comes back to the level it was struck at', () => {
    // Dokuganryu Masamune: 14 15 15 13 8 3 0, then 14 15 … again with no write, after 1-7 silent frames.
    const env = [14, 15, 15, 13, 8, 3];
    const writes = [...shape(0, [...env, 0], 0x0f2, true), ...shape(7, [...env, 0, 0, 0, 0, 0, 0, 0], 0x0f2, false), ...shape(20, env, 0x0f2, false)];
    writes.push(...keyed(40));
    expect(starts(writes, 'pulse1').filter((f) => f < 40)).toEqual([0, 7, 20]);
  });

  it('keeps an envelope that swells back by itself after a dip in its note', () => {
    // Final Fantasy: 8 7 5 4 2 0, then 8 8 8 8 and held — one note in its driver's reads.
    const writes = [...shape(0, [8, 7, 5, 4, 2, 0, 8, 8, 8, 8, 8, 8], 0x0be, true), ...keyed(20)];
    expect(starts(writes, 'pulse1').filter((f) => f < 20)).toEqual([0]);
  });

  it('strikes a pitch again after the note faded out, lower than it was struck', () => {
    // Super Mario Bros. 3, Music Box: 7 … 1 1 0, then the same C4 at 5.
    const writes = [...shape(0, [7, 6, 5, 4, 3, 2, 1, 1, 0, 5, 4, 3, 2, 1], 0x1ab, true), ...keyed(20)];
    expect(starts(writes, 'pulse1').filter((f) => f < 20)).toEqual([0, 9]);
  });

  it('strikes a pitch again after a dip when its duty changes', () => {
    // Bee 52: duty 3 at 8 … 4, silence, then duty 2 at 3 … 1, no write.
    const writes = [...shape(0, [8, 7, 6, 5, 4, 0, 0], 0x1ab, true, 3), ...shape(7, [3, 2, 1], 0x1ab, false, 2), ...keyed(20)];
    expect(starts(writes, 'pulse1').filter((f) => f < 20)).toEqual([0, 7]);
  });

  it('strikes the repeats a driver plays by the level alone, one note length after its write', () => {
    // Puzznic: most notes run their eighth out; a repeated pitch is struck again at 15 by the level.
    const env = [15, 14, 13, 12, 11, 10, 9, 8];
    const writes: { time: number; address: number; value: number }[] = [...on];
    for (let n = 0; n < 10; n++) writes.push(...shape(n * 16, [...env, ...(n % 2 === 0 ? env : env.map((v) => v - 6))], 0x0c0 + n, true));
    const notes = decode(writes, 3, 60).filter((n) => n.track === 'pulse1');
    expect(notes.map((n) => Math.round(n.start * 60))).toEqual([0, 8, 16, 32, 40, 48, 64, 72, 80, 96, 104, 112, 128, 136, 144]);
  });

  it('starts a note at its own frame when the frame before is the echo of an earlier note at its pitch', () => {
    // Gun Sight: 5 6 7 6 6, then one frame of 1 at an earlier note's pitch; the next note at that
    // pitch writes its `$4002` and level the frame after.
    const writes = [
      ...shape(0, [5, 6, 7, 6, 6, 1], 0x280, true),
      ...shape(6, [5, 6, 7, 6, 6], 0x2cf, false),
      ...shape(11, [1], 0x280, false),
      ...shape(12, [5, 6, 7, 6, 6], 0x280, false),
    ];
    expect(starts(writes, 'pulse1')).toEqual([0, 6, 11, 12]);
  });

  it('keeps a note written at level 0 struck at its write through a detune in the silence', () => {
    // Dr. Mario: `$4003` at level 0, `$4002` two periods off the frame after, still silent; sound after.
    const writes = [...shape(0, [8, 7, 6, 5], 0x0c0, true), ...shape(10, [0], 0x0a8, true), ...shape(11, [0], 0x0a6, false), ...shape(12, [6, 6, 5, 5], 0x0a6, false)];
    expect(starts(writes, 'pulse1')).toEqual([0, 10]);
  });

  it('starts a note at its sound when a vibrato only stepped through the rest before it', () => {
    // Twinbee: the vibrato goes on stepping `$4006` as the note before fades out; the next note is struck eight frames later.
    const writes = [...shape(0, [7, 7, 6, 5, 4, 3, 2, 1, 0], 0x0a0, true)];
    writes.push(...shape(8, [0], 0x09f, false), ...shape(16, [7, 7, 7, 7], 0x09f, false));
    expect(starts(writes, 'pulse1')).toEqual([0, 16]);
  });

  it('takes each stroke of a roll stepping down as a hit', () => {
    // Abarenboh Tengu: strokes of two frames, held flat, two rates in turn, stepping down 15 13 11 9.
    const writes: { time: number; address: number; value: number }[] = [];
    [15, 13, 13, 11, 11, 9].forEach((v, n) => {
      for (const k of [0, 1]) writes.push({ time: at(n * 2 + k), address: 0x400c, value: 0x30 | v });
      writes.push({ time: at(n * 2), address: 0x400e, value: n % 2 ? 4 : 1 }, { time: at(n * 2), address: 0x400f, value: 0x08 });
    });
    expect(starts(writes, 'noise')).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('strikes the noise again at a new rate the frame after a click', () => {
    // Ys III: a click of 1 at rate 5, then the hit at 10 at rate 7, each written.
    const writes: { time: number; address: number; value: number }[] = [];
    for (const n of [0, 10, 20]) {
      writes.push({ time: at(n), address: 0x400c, value: 0x31 }, { time: at(n), address: 0x400e, value: 5 }, { time: at(n), address: 0x400f, value: 5 });
      writes.push({ time: at(n + 1), address: 0x400c, value: 0x3a }, { time: at(n + 1), address: 0x400e, value: 7 }, { time: at(n + 1), address: 0x400f, value: 7 });
      writes.push({ time: at(n + 2), address: 0x400c, value: 0x30 });
    }
    expect(starts(writes, 'noise')).toEqual([0, 1, 10, 11, 20, 21]);
  });

  it('names a note that scoops into its body after the body', () => {
    // Radia Senki: a frame at 3 some 0.55 of a semitone under the note, then the note at 12.
    const writes = [...shape(0, [3], 0x0fe, true), ...shape(1, [12, 12, 11, 11, 10, 10, 9, 9], 0x0f6, false)];
    const notes = decode([...on, ...writes], 1, 60).filter((n) => n.track === 'pulse1');
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(Math.round(69 + 12 * Math.log2(1789772.7 / (16 * 0xf7) / 440)));
    expect(notes[0].bend?.[0][1]).toBeLessThan(-0.4);
  });

  it('keeps a run carried up by a fast sweep on a channel written every frame as a note a step', () => {
    // Time Diver Eon Man: `$4001` = $89 and `$4002`/`$4003` written every frame, a semitone up each.
    const writes = [{ time: at(0), address: 0x4001, value: 0x89 }];
    const periods = [0x3f9, 0x3c0, 0x38a];
    for (let f = 0; f < 24; f++) {
      const period = periods[(f % 4 === 3 ? 2 : f % 4 === 2 ? 1 : 0)] - 0x30 * Math.floor(f / 4);
      writes.push(...shape(f, [15], period, false), { time: at(f), address: 0x4003, value: 0x08 | (period >> 8) });
    }
    expect(starts(writes, 'pulse1')).toEqual([0, 4, 8, 12, 16, 20]);
  });

  it('leaves a triangle trill of three frames a note as notes', () => {
    const writes = [{ time: at(0), address: 0x4008, value: 0xff }];
    for (let f = 0; f < 36; f++) {
      const period = Math.floor(f / 3) % 2 ? 0x0bd : 0x0e1;
      writes.push({ time: at(f), address: 0x400a, value: period & 0xff });
      if (f === 0) writes.push({ time: at(f), address: 0x400b, value: period >> 8 });
    }
    expect(starts(writes, 'triangle')).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33]);
  });
});

describe('decode, a channel switched off', () => {
  it('ends a note where $4015 switches its channel off early in the update', () => {
    // Ikki's Miss: the driver writes its last D every frame and stops it with `$4015` = 0 a few
    // samples into frame 8 — read from the window's first sample, it sounded a frame longer.
    const at = (f: number) => f / 60 + 0.001;
    const writes: { time: number; address: number; value: number }[] = [{ time: 0, address: 0x4015, value: 0x0f }];
    for (let f = 0; f < 8; f++) {
      writes.push({ time: at(f), address: 0x4015, value: 0x01 }, { time: at(f), address: 0x4000, value: 0xb0 | (15 - f) });
      writes.push({ time: at(f), address: 0x4002, value: 0x5f }, ...(f === 0 ? [{ time: at(f), address: 0x4003, value: 0x08 }] : []));
    }
    writes.push({ time: at(8) + 0.00002, address: 0x4015, value: 0x00 });
    const notes = decode(writes, 1, 60).filter((n) => n.track === 'pulse1');
    expect(notes.map((n) => [Math.round(n.start * 60), Math.round(n.duration * 60)])).toEqual([[0, 8]]);
  });
});

describe('decode, pieces of one note (2026-11-07)', () => {
  const on = [{ time: 0, address: 0x4015, value: 0x0f }];
  const at = (f: number) => f / 60 + 0.001;
  type W = { time: number; address: number; value: number };
  const run = (writes: W[], track: string) => decode([...on, ...writes].sort((a, b) => a.time - b.time), 5, 60).filter((n) => n.track === track);
  const starts = (writes: W[], track: string) => run(writes, track).map((n) => Math.round(n.start * 60));
  const midiOf = (period: number, tri = false) => Math.round(69 + 12 * Math.log2(1789772.7 / ((tri ? 32 : 16) * (period + 1)) / 440));
  /** A frame of pulse `ch`: level (constant volume), period, the restart register written or not. */
  const frame = (f: number, ch: number, level: number | null, period: number, restart: boolean): W[] => [
    ...(level === null ? [] : [{ time: at(f), address: 0x4000 + 4 * ch, value: 0xb0 | level }]),
    { time: at(f), address: 0x4002 + 4 * ch, value: period & 0xff },
    ...(restart ? [{ time: at(f), address: 0x4003 + 4 * ch, value: 0x08 | (period >> 8) }] : []),
  ];

  it('keeps a fast slide of the period in the note it falls from', () => {
    // Dance Aerobics: struck at B5, +8 to the period a frame, `$4003` rewritten every frame with the same byte.
    const writes: W[] = [];
    for (const from of [0, 20, 40]) for (let k = 0; k < 20; k++) writes.push(...frame(from + k, 0, k === 0 ? 3 : null, 0x71 + 8 * k, true));
    writes.push({ time: at(60), address: 0x4000, value: 0x30 });
    const notes = run(writes, 'pulse1');
    expect(notes.map((n) => Math.round(n.start * 60))).toEqual([0, 20, 40]);
    expect(notes.every((n) => n.midi === midiOf(0x71))).toBe(true);
    expect(notes[0].bend![notes[0].bend!.length - 1][1]).toBeLessThan(-8);
  });

  it('leaves a slide that lands on a held note to be read with it (rule 24)', () => {
    // A semitone a frame from C5 up to E5, which then holds: E5 is a note of its own.
    const writes: W[] = [...frame(0, 0, 8, 0x1ab, true)];
    for (let f = 1; f < 10; f++) writes.push(...frame(f, 0, 8, 0x1ab, false));
    [0x193, 0x17c, 0x167].forEach((p, k) => writes.push(...frame(10 + k, 0, 8, p, false)));
    for (let f = 13; f < 30; f++) writes.push(...frame(f, 0, 8, 0x152, false));
    expect(starts(writes, 'pulse1')).toContain(13);
  });

  it('leaves a frame arpeggio whose two steps up are alike as notes', () => {
    // Jungle Book: G#3 B3 D#4 a frame each, over and over (periods 539 452 358).
    const writes: W[] = [];
    for (let f = 0; f < 30; f++) writes.push(...frame(f, 0, 10, [0x21b, 0x1c4, 0x166][f % 3], f === 0));
    expect(run(writes, 'pulse1').length).toBeGreaterThanOrEqual(28);
  });

  it('keeps a vibrato at the top of the range in its note', () => {
    // Akuma-kun: G8 at period 17 struck by `$4007`, its vibrato through `$4006` alone, a step a period.
    const writes: W[] = [];
    for (const from of [0, 20, 40]) {
      [17, 17, 16, 16, 17, 17, 18, 18, 17, 17, 16, 16, 17, 17].forEach((p, k) => writes.push(...frame(from + k, 1, 12 - (k >> 1), p, k === 0)));
      writes.push({ time: at(from + 14), address: 0x4004, value: 0x30 });
    }
    const notes = run(writes, 'pulse2');
    expect(notes.map((n) => Math.round(n.start * 60))).toEqual([0, 20, 40]);
    expect(notes.every((n) => n.midi === midiOf(17))).toBe(true);
  });

  it('leaves a run at the top of the range that moves on as notes', () => {
    const writes: W[] = [];
    [17, 17, 17, 15, 15, 15, 13, 13, 13, 13].forEach((p, k) => writes.push(...frame(k, 1, 12, p, k === 0)));
    expect(starts(writes, 'pulse2')).toEqual([0, 3, 6]);
  });

  it('keeps a note whose restart is rewritten on frames that end it in one piece', () => {
    // Jajamaru Ninpou Chou, Town with Sakura: each arpeggio note struck, `$4007` written again on its next two
    // frames, then level 0.
    const writes: W[] = [];
    [0x71, 0x5f, 0x55, 0x47].forEach((p, n) => {
      writes.push(...frame(n * 4, 1, 10, p, true), ...frame(n * 4 + 1, 1, null, p, true), ...frame(n * 4 + 2, 1, null, p, true));
      writes.push({ time: at(n * 4 + 3), address: 0x4004, value: 0x30 });
    });
    const notes = run(writes, 'pulse2');
    expect(notes.map((n) => Math.round(n.start * 60))).toEqual([0, 4, 8, 12]);
    expect(notes.map((n) => Math.round(n.duration * 60))).toEqual([3, 3, 3, 3]);
  });

  it('still strikes a pitch repeated by its restart when the repeat goes on sounding', () => {
    const writes: W[] = [];
    for (const n of [0, 1, 2]) {
      writes.push(...frame(n * 8, 0, 10, 0x150, true));
      for (let k = 1; k < 8; k++) writes.push(...frame(n * 8 + k, 0, null, 0x150, false));
    }
    expect(starts(writes, 'pulse1')).toEqual([0, 8, 16]);
  });

  it('names a note that slides onto its pitch from less than a semitone above after the pitch it holds', () => {
    // Jajamaru Ninpou Chou: D5 started 0.56 of a semitone sharp, onto D5 in four frames.
    const writes: W[] = [];
    [0x0e9, 0x0e9, 0x0ed, 0x0ed].forEach((p, k) => writes.push(...frame(k, 0, 12, p, k === 0)));
    for (let k = 4; k < 16; k++) writes.push(...frame(k, 0, 12, 0x0f1, false));
    const notes = run(writes, 'pulse1');
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(midiOf(0x0f1));
  });

  it('names a note written at level 0 after the period written, past a scoop onto it', () => {
    // Star Tropics 2: F4 written at level 0, then D#4 at 3, nearly F4 at 6, F4 at 6 5 4.
    const writes: W[] = [];
    for (const from of [0, 12]) {
      writes.push(...frame(from, 1, 0, 0x140, true), ...frame(from + 1, 1, 3, 0x168, false), ...frame(from + 2, 1, 6, 0x148, false));
      [6, 5, 4, 4].forEach((v, k) => writes.push(...frame(from + 3 + k, 1, v, 0x140, false)));
      writes.push({ time: at(from + 7), address: 0x4004, value: 0x30 });
    }
    const notes = run(writes, 'pulse2');
    expect(notes.map((n) => Math.round(n.start * 60))).toEqual([0, 12]);
    expect(notes.every((n) => n.midi === midiOf(0x140))).toBe(true);
  });

  it('names a note that falls several semitones before it settles after its first frame', () => {
    // Astyanax: written at D4, the sound falls a semitone a frame or two and settles on B3.
    const writes: W[] = [];
    [0x17c, 0x193, 0x193, 0x1ab, 0x1c4, 0x1c4, 0x1c4].forEach((p, k) => writes.push(...frame(k, 0, 11, p, k === 0)));
    const notes = run(writes, 'pulse1');
    expect(notes[0].midi).toBe(midiOf(0x17c));
  });

  it('names a triangle note after the pitch it holds past one frame of another', () => {
    // Bad News Baseball, Boston: the linear counter reloaded a frame early sounds E2, then the note is B2.
    const writes: W[] = [{ time: at(0), address: 0x4008, value: 0xff }, { time: at(0), address: 0x400a, value: 0xa6 }, { time: at(0), address: 0x400b, value: 0x1a }];
    writes.push({ time: at(1), address: 0x400a, value: 0xc4 }, { time: at(1), address: 0x400b, value: 0x19 });
    const notes = run(writes, 'triangle');
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(midiOf(0x1c4, true));
  });

  it('keeps the name a triangle tom is struck at as it falls under a semitone', () => {
    // Jajamaru Ninpou Chou, Town with Sakura: G#3 struck, 0.7 and then 0.9 of a semitone down two frames each.
    const writes: W[] = [{ time: at(0), address: 0x4008, value: 0x18 }, { time: at(0), address: 0x400a, value: 0x0e }, { time: at(0), address: 0x400b, value: 0x09 }];
    writes.push({ time: at(2), address: 0x400a, value: 0x19 }, { time: at(4), address: 0x400a, value: 0x1d });
    const notes = run(writes, 'triangle');
    expect(notes[0].midi).toBe(midiOf(0x10e, true));
  });

  /** Tecmo's notes: 4 then 9, a silent frame, the echo at 4 — 24 frames, `$4003` written only for the first. */
  const tecmo = (from: number, period: number, first: boolean): W[] =>
    [4, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4].flatMap((v, k) => frame(from + k, 0, v, period, first && k === 0));

  it("starts a repeat at its opening's first frame when the channel's notes open below their second", () => {
    const periods = [0x1ab, 0x17c, 0x1ab, 0x1ab, 0x152, 0x17c, 0x17c, 0x1ab, 0x152, 0x152];
    const writes = periods.flatMap((p, n) => tecmo(n * 24, p, n === 0));
    const struck = starts(writes, 'pulse1').filter((s) => s % 24 !== 12);
    expect(struck).toEqual(periods.map((_, n) => n * 24));
  });

  it('starts a note out of silence on its sound when the write before had no period of it', () => {
    // Bill Elliott's NASCAR Challenge: `$4003` written with the low byte 0 at level 0, the note's period with its sound.
    const writes: W[] = [];
    for (const from of [0, 12]) {
      writes.push(...frame(from, 0, 0, 0x200, true));
      for (let k = 1; k < 10; k++) writes.push(...frame(from + k, 0, 12 - k, 0x25e, false));
      writes.push({ time: at(from + 10), address: 0x4000, value: 0x30 });
    }
    expect(starts(writes, 'pulse1')).toEqual([1, 13]);
  });

  it('takes a frame of another pitch that opens a note out of silence as its attack', () => {
    // Bill Elliott's NASCAR Challenge, Pit Stop: a frame of F3 at 3, then C4 at 7 and down.
    const writes: W[] = [];
    for (const from of [0, 10]) {
      writes.push(...frame(from, 1, 3, 0x281, true));
      [7, 6, 5, 5, 5].forEach((v, k) => writes.push(...frame(from + 1 + k, 1, v, 0x1ac, k === 0)));
      writes.push({ time: at(from + 6), address: 0x4004, value: 0x30 });
    }
    const notes = run(writes, 'pulse2');
    expect(notes.map((n) => Math.round(n.start * 60))).toEqual([0, 10]);
    expect(notes.every((n) => n.midi === midiOf(0x1ac))).toBe(true);
  });
});
