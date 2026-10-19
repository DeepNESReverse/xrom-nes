/**
 * A NES without a picture: the CPU, the cartridge's mapper, 2 KB of RAM, a
 * PPU that only keeps time (vblank, NMI, a sprite-0 hit) and a controller.
 * Every write to the sound chip is logged with the CPU cycle it happened on —
 * the music, as the game played it.
 *
 * A picture, when one is wanted, is `ppu.ts`: hand a `PpuBus` to `nes.ppu` and it is told every
 * PPU register access and sprite DMA, and keeps the video memory they build.
 */

import { Cpu6502 } from '@xromdev/cpu6502';
import { createMapper, type Mapper } from './mappers.ts';

/** What sees the PPU's side of the bus — `ppu.ts`'s `Ppu`. */
export interface PpuBus {
  write(register: number, value: number, line: number): void;
  read(register: number): number;
  dma(page: Uint8Array): void;
  /** The start of a scanline, before the CPU runs it. */
  scanline?(line: number): void;
  /** The line sprite 0 hits on, or -1 for none — instead of the fixed guess below. */
  sprite0Line?(): number;
}

export const CPU_HZ = 1789772.7272727273;
export const FRAME_CYCLES = 29780.5;
const LINE_CYCLES = 341 / 3;

export interface Cartridge {
  mapper: number;
  prg: Uint8Array;
  /** CHR ROM; empty when the board has CHR RAM. */
  chr: Uint8Array;
  /** Nametable mirroring wired on the board. */
  mirroring: 'horizontal' | 'vertical' | 'four';
}

/** Read an iNES / NES 2.0 file's header and PRG. */
export function parseRom(file: Uint8Array): Cartridge {
  if (file[0] !== 0x4e || file[1] !== 0x45 || file[2] !== 0x53 || file[3] !== 0x1a) throw new Error('not an iNES file');
  const trainer = file[6] & 4 ? 512 : 0;
  const prgSize = file[4] * 0x4000;
  const prgStart = 16 + trainer;
  return {
    mapper: (file[6] >> 4) | (file[7] & 0xf0),
    prg: file.subarray(prgStart, prgStart + prgSize),
    chr: file.subarray(prgStart + prgSize, prgStart + prgSize + file[5] * 0x2000),
    mirroring: file[6] & 8 ? 'four' : file[6] & 1 ? 'vertical' : 'horizontal',
  };
}

export interface ApuWrite {
  /** CPU cycle since power-on. */
  cycle: number;
  address: number;
  value: number;
}

/** Controller buttons, as the bits the game reads in order. */
export const BUTTON = { A: 1, B: 2, select: 4, start: 8, up: 16, down: 32, left: 64, right: 128 } as const;

export class Nes {
  readonly cpu: Cpu6502;
  readonly mapper: Mapper;
  readonly writes: ApuWrite[] = [];
  frame = 0;
  /** Buttons held down — set before a frame runs. */
  buttons = 0;
  /** The picture's side, when one is kept — see `ppu.ts`. */
  ppu: PpuBus | null = null;
  /** The scanline being run, 0–261. */
  line = 0;
  private readonly ram = new Uint8Array(0x800);
  private ppuCtrl = 0;
  private ppuMask = 0;
  private vblank = false;
  private sprite0 = false;
  private pad = 0;
  private strobe = 0;

  constructor(cart: Cartridge) {
    this.mapper = createMapper(cart.mapper, cart.prg);
    this.cpu = new Cpu6502({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.reset();
  }

  private read(a: number): number {
    if (a < 0x2000) return this.ram[a & 0x7ff];
    if (a < 0x4000) {
      if ((a & 7) === 2) {
        const v = (this.vblank ? 0x80 : 0) | (this.sprite0 ? 0x40 : 0);
        this.vblank = false;
        this.ppu?.read(2);
        return v;
      }
      return this.ppu?.read(a & 7) ?? 0;
    }
    if (a === 0x4016) {
      const bit = this.strobe ? this.buttons & 1 : this.pad & 1;
      if (!this.strobe) this.pad = (this.pad >> 1) | 0x80;
      return 0x40 | bit;
    }
    if (a === 0x4017) return 0x40;
    if (a >= 0x6000) return this.mapper.read(a);
    return 0;
  }

  private write(a: number, v: number): void {
    if (a < 0x2000) this.ram[a & 0x7ff] = v;
    else if (a < 0x4000) {
      const r = a & 7;
      if (r === 0) this.ppuCtrl = v;
      else if (r === 1) this.ppuMask = v;
      this.ppu?.write(r, v, this.line);
    } else if (a === 0x4014) {
      this.cpu.cycles += 513;
      if (this.ppu && v < 0x20) this.ppu.dma(this.ram.subarray((v & 7) << 8, ((v & 7) << 8) + 256));
    }
    else if (a === 0x4016) {
      this.strobe = v & 1;
      if (this.strobe) this.pad = this.buttons;
    } else if (a <= 0x4017) this.writes.push({ cycle: this.cpu.cycles, address: a, value: v });
    else if (a >= 0x6000) this.mapper.write(a, v);
  }

  private runTo(target: number, onStep?: (from: number, to: number) => void) {
    const cpu = this.cpu;
    while (cpu.cycles < target && !cpu.jammed) {
      if (this.mapper.irq && !(cpu.p & 0x04)) cpu.irq();
      const pc = cpu.pc;
      cpu.step();
      onStep?.(pc, cpu.pc);
    }
  }

  /** One frame: 262 scanlines, vblank and NMI at 241. */
  runFrame(onStep?: (from: number, to: number) => void) {
    const start = this.frame * FRAME_CYCLES;
    const rendering = () => (this.ppuMask & 0x18) !== 0;
    const hit = this.ppu?.sprite0Line?.() ?? 30;
    for (let line = 0; line < 262; line++) {
      this.line = line;
      this.ppu?.scanline?.(line);
      if (line === 241) {
        this.vblank = true;
        if (this.ppuCtrl & 0x80) this.cpu.nmi();
      }
      if (line === 261) {
        this.vblank = false;
        this.sprite0 = false;
      }
      if (line === hit && rendering()) this.sprite0 = true;
      this.runTo(start + (line + 1) * LINE_CYCLES, onStep);
      if ((line < 240 || line === 261) && rendering()) this.mapper.scanline?.();
    }
    this.frame++;
  }
}
