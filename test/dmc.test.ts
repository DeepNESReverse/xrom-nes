import { describe, expect, it } from 'vitest';
import { dmcHits } from '../src/dmc.js';

const start = (time: number, length: number, address = 0x00) => [
  { time, address: 0x4015, value: 0x0f },
  { time, address: 0x4010, value: 0x0f },
  { time, address: 0x4012, value: address },
  { time, address: 0x4013, value: length },
  { time, address: 0x4015, value: 0x1f },
];

describe('dmcHits', () => {
  it('starts no hit for a sample of one byte, and still starts the next', () => {
    const writes = [...start(0, 0), ...start(0.5, 0), ...start(1, 5)];
    expect(dmcHits(writes, 2).map((h) => h.start)).toEqual([1]);
  });

  it('takes a sample started twice within an update as one hit', () => {
    const writes = [...start(1, 5, 0x3f), ...start(1.0002, 5, 0x3f), ...start(1.5, 5, 0x3f)];
    expect(dmcHits(writes, 2).map((h) => h.start)).toEqual([1.0002, 1.5]);
  });

  it('keeps a restart a frame later as a hit of its own', () => {
    const writes = [...start(1, 5), ...start(1 + 1 / 60, 5)];
    expect(dmcHits(writes, 2)).toHaveLength(2);
  });
});
