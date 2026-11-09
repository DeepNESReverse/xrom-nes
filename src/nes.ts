/**
 * A NES without a picture: the CPU, the cartridge's mapper, 2 KB of RAM, a
 * PPU that only keeps time (vblank, NMI, a sprite-0 hit, the 8-sprite overflow)
 * and a controller. Every write to the sound chip is logged with the CPU cycle it
 * happened on — the music, as the game played it. Of the sound chip's own state
 * only what a game can read back is kept: the length counters, the frame
 * counter's and the DMC's IRQs and the DMC's bytes left — `$4015`.
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

/** The length counter's loads, by the top five bits of `$4003`/`$4007`/`$400B`/`$400F`. */
const LENGTHS = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
/** CPU cycles a DMC output bit takes, by the low four bits of `$4010` (NTSC). */
const DMC_RATES = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
/**
 * The frame counter's steps, in CPU cycles after it is reset by a `$4017` write — 4-step mode
 * (the last also raises the IRQ) and 5-step; the lengths are clocked on the steps marked.
 */
const SEQUENCE = [
  { steps: [7457, 14913, 22371, 29829], half: [false, true, false, true], period: 29830 },
  { steps: [7457, 14913, 22371, 29829, 37281], half: [false, true, false, false, true], period: 37282 },
];

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
  /**
   * Called at line 241 before the NMI — where a frame of FCEUX's ends, the moment its RAM is
   * read (`replay-cli.ts` lays a take's RAM over this NES's there).
   */
  beforeVblank?: () => void;
  private readonly ram = new Uint8Array(0x800);
  private ppuCtrl = 0;
  private ppuMask = 0;
  private vblank = false;
  /** The CPU cycle this frame's vblank flag goes up, until it has; Infinity once it has. */
  private vblankAt = Infinity;
  /** The CPU cycle the NMI line went low, until the NMI is taken. */
  private nmiAt = Infinity;
  /**
   * The NMI line was pulled by a `$2000` write — on the instruction's last cycle, after the CPU
   * polled for interrupts — so one more instruction runs before it is taken (FCEUX's NMI2).
   * `cpu.cycles` is the instruction's first cycle while it writes, so `nmiAt` alone cannot say so.
   */
  private nmiLate = false;
  private sprite0 = false;
  /** Sprite memory as the CPU fills it, for the overflow flag — `ppu.ts` keeps its own to draw. */
  private readonly oam = new Uint8Array(256);
  private oamAddr = 0;
  private overflow = false;
  private pad = 0;
  private strobe = 0;
  /** The four length counters, their halt flags and the channels `$4015` enables. */
  private readonly lengths = [0, 0, 0, 0];
  private readonly halted = [false, false, false, false];
  private enabled = 0;
  /** The frame counter: its mode (0 = 4-step), IRQ inhibit, the CPU cycle it was reset on, the next step. */
  private sequenceMode = 0;
  private frameInhibit = false;
  private frameIrq = false;
  private sequenceStart = 0;
  private step = 0;
  /** The DMC: `$4010`, `$4013`, the bytes left to fetch, its one-byte buffer and the next output-bit boundary. */
  private dmcCtrl = 0;
  private dmcLength = 1;
  private dmcLeft = 0;
  private dmcBuffer = false;
  private dmcNext = 0;
  private dmcIrq = false;

  constructor(cart: Cartridge) {
    this.mapper = createMapper(cart.mapper, cart.prg, cart.chr.length);
    this.cpu = new Cpu6502({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.reset();
  }

  private read(a: number): number {
    if (a < 0x2000) return this.ram[a & 0x7ff];
    if (a < 0x4000) {
      if ((a & 7) === 2) {
        this.readStatus();
        const v = (this.vblank ? 0x80 : 0) | (this.sprite0 ? 0x40 : 0) | (this.overflow ? 0x20 : 0);
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
    if (a === 0x4015) return this.readSound();
    if (a >= 0x4020) {
      const v = this.mapper.read(a);
      const moved = this.mapper.soundRead?.(a);
      if (moved) this.writes.push({ cycle: this.cpu.cycles, ...moved });
      return v;
    }
    return 0;
  }

  private write(a: number, v: number): void {
    if (a < 0x2000) this.ram[a & 0x7ff] = v;
    else if (a < 0x4000) {
      const r = a & 7;
      if (r === 0) {
        // Turning the NMI on while the vblank flag is up pulls the line at once.
        if (v & 0x80 && !(this.ppuCtrl & 0x80) && this.vblank) {
          this.nmiAt = this.cpu.cycles;
          this.nmiLate = true;
        }
        this.ppuCtrl = v;
      } else if (r === 1) this.ppuMask = v;
      else if (r === 3) this.oamAddr = v;
      else if (r === 4) {
        this.oam[this.oamAddr] = v;
        this.oamAddr = (this.oamAddr + 1) & 0xff;
      }
      this.ppu?.write(r, v, this.line);
    } else if (a === 0x4014) {
      this.cpu.cycles += 513;
      if (v < 0x20) {
        const page = this.ram.subarray((v & 7) << 8, ((v & 7) << 8) + 256);
        for (let i = 0; i < 256; i++) this.oam[(this.oamAddr + i) & 0xff] = page[i];
        this.ppu?.dma(page);
      }
    }
    else if (a === 0x4016) {
      this.strobe = v & 1;
      if (this.strobe) this.pad = this.buttons;
    } else if (a <= 0x4017) {
      this.writeSound(a, v);
      this.writes.push({ cycle: this.cpu.cycles, address: a, value: v });
    } else if (a >= 0x4020) {
      if (this.mapper.isSound?.(a)) this.writes.push({ cycle: this.cpu.cycles, address: a, value: v });
      this.mapper.write(a, v);
    }
  }

  /**
   * `$4015`: bit 0-3 a length counter above zero, 4 the DMC with bytes left, 6 the frame IRQ (the
   * read clears it), 7 the DMC IRQ. Read, like `$2002`, on the instruction's last cycle.
   */
  private readSound(): number {
    this.soundTo(this.cpu.cycles + 3);
    let v = 0;
    for (let ch = 0; ch < 4; ch++) if (this.lengths[ch] > 0) v |= 1 << ch;
    if (this.dmcLeft > 0) v |= 0x10;
    if (this.frameIrq) v |= 0x40;
    if (this.dmcIrq) v |= 0x80;
    this.frameIrq = false;
    return v;
  }

  private writeSound(a: number, v: number) {
    const now = this.cpu.cycles + 3;
    this.soundTo(now);
    if (a < 0x4010) {
      const ch = (a - 0x4000) >> 2;
      if ((a & 3) === 0) this.halted[ch] = (v & (ch === 2 ? 0x80 : 0x20)) !== 0;
      else if ((a & 3) === 3 && this.enabled & (1 << ch)) this.lengths[ch] = LENGTHS[v >> 3];
    } else if (a === 0x4010) {
      this.dmcCtrl = v;
      if (!(v & 0x80)) this.dmcIrq = false;
    } else if (a === 0x4013) this.dmcLength = v * 16 + 1;
    else if (a === 0x4015) {
      this.enabled = v & 0x0f;
      for (let ch = 0; ch < 4; ch++) if (!(v & (1 << ch))) this.lengths[ch] = 0;
      this.dmcIrq = false;
      if (!(v & 0x10)) this.dmcLeft = 0;
      else if (this.dmcLeft === 0) {
        this.dmcLeft = this.dmcLength;
        if (!this.dmcBuffer) this.dmcFetch(); // an empty buffer takes the first byte at once
      }
    } else if (a === 0x4017) {
      this.sequenceMode = v >> 7;
      this.frameInhibit = (v & 0x40) !== 0;
      // FCEUX drops a raised frame IRQ on any write here (the console only with bit 6): Cobra Triangle
      // writes $00 then $80, never reads $4015, and its CLI must not meet the flag power-on raised.
      this.frameIrq = false;
      this.sequenceStart = now + 1;
      this.step = 0;
      if (this.sequenceMode) this.clockLengths(); // the 5-step mode clocks them at once
    }
  }

  private clockLengths() {
    for (let ch = 0; ch < 4; ch++) if (!this.halted[ch] && this.lengths[ch] > 0) this.lengths[ch]--;
  }

  private dmcFetch() {
    this.dmcBuffer = true;
    if (--this.dmcLeft > 0) return;
    if (this.dmcCtrl & 0x40) this.dmcLeft = this.dmcLength;
    else if (this.dmcCtrl & 0x80) this.dmcIrq = true;
  }

  /**
   * The sound chip's clocks up to CPU cycle `now`: the frame counter's steps, and the DMC's output
   * unit, which empties the buffer every eight bits — the reader then fetches the next byte, and
   * the last byte fetched raises the IRQ.
   */
  private soundTo(now: number) {
    const sequence = SEQUENCE[this.sequenceMode];
    for (;;) {
      const at = this.sequenceStart + sequence.steps[this.step];
      if (at > now) break;
      if (sequence.half[this.step]) this.clockLengths();
      if (this.step === 3 && !this.sequenceMode && !this.frameInhibit) this.frameIrq = true;
      if (++this.step === sequence.steps.length) {
        this.step = 0;
        this.sequenceStart += sequence.period;
      }
    }
    const bits = 8 * DMC_RATES[this.dmcCtrl & 0x0f];
    if (this.dmcNext <= now && !this.dmcBuffer && this.dmcLeft === 0) {
      this.dmcNext += Math.ceil((now - this.dmcNext) / bits) * bits; // nothing to play: skip ahead
    }
    while (this.dmcNext <= now) {
      this.dmcBuffer = false;
      if (this.dmcLeft > 0) this.dmcFetch();
      this.dmcNext += bits;
    }
  }

  /**
   * The vblank flag goes up on a cycle of its own, not between instructions — a game polling
   * $2002 can see it before the NMI the same edge pulls, as on the console. Taken here when the
   * CPU reaches it; an NMI is taken before an instruction only once the line has been low for a
   * cycle, so an instruction that ends right on the edge still has one more run first.
   */
  private vblankEdge(now: number) {
    if (now < this.vblankAt) return;
    this.vblank = true;
    if (this.ppuCtrl & 0x80) {
      this.nmiAt = this.vblankAt;
      this.nmiLate = false;
    }
    this.vblankAt = Infinity;
  }

  /**
   * A read of $2002 as the flag goes up (on the 4th cycle of the LDA/BIT that reads it): a PPU
   * clock early it reads clear and the flag and NMI of this frame never come; on the clock or
   * one after, it reads set and the NMI is suppressed — the race FCEUX and the console have.
   */
  private readStatus() {
    const at = this.cpu.cycles + 3;
    const early = this.vblankAt - at;
    if (early > 0 && early <= 1 / 3) {
      this.vblankAt = Infinity;
      return;
    }
    if (this.vblankAt <= at) {
      const late = at - this.vblankAt;
      this.vblankEdge(at);
      if (late < 2 / 3) this.nmiAt = Infinity;
    }
  }

  private runTo(target: number, onStep?: (from: number, to: number) => void) {
    const cpu = this.cpu;
    while (cpu.cycles < target && !cpu.jammed) {
      this.vblankEdge(cpu.cycles);
      if (cpu.cycles >= this.nmiAt + 1 && this.nmiLate) this.nmiLate = false;
      else if (cpu.cycles >= this.nmiAt + 1) {
        this.nmiAt = Infinity;
        cpu.nmi();
      } else if (!(cpu.p & 0x04) && (this.mapper.irq || this.soundIrq(cpu.cycles))) cpu.irq();
      const pc = cpu.pc;
      const before = cpu.cycles;
      cpu.step();
      this.mapper.clock?.(cpu.cycles - before);
      onStep?.(pc, cpu.pc);
    }
  }

  /** The sound chip's IRQ line at CPU cycle `now`: the frame counter's or the DMC's. */
  private soundIrq(now: number) {
    this.soundTo(now);
    return this.frameIrq || this.dmcIrq;
  }

  /**
   * The 8-sprite overflow: while rendering, evaluating line `line` finds more than eight sprites
   * on it (as FCEUX counts them, without the console's diagonal-scan bug).
   */
  private evaluate(line: number) {
    const h = this.ppuCtrl & 0x20 ? 16 : 8;
    let found = 0;
    for (let s = 0; s < 256 && found <= 8; s += 4) if (line - this.oam[s] >= 0 && line - this.oam[s] < h) found++;
    if (found > 8) this.overflow = true;
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
        this.beforeVblank?.();
        this.vblankAt = start + 241 * LINE_CYCLES + 1 / 3; // dot 1
        // FCEUX zeroes the sprite address as vblank begins (`PPU[3] = PPUSPL = 0`): a game that left
        // it past 0 with `$2004` writes still DMAs its sprites to the top of OAM in the NMI (Akira).
        this.oamAddr = 0;
      }
      if (line === 261) {
        this.vblank = false;
        this.vblankAt = Infinity;
        this.sprite0 = false;
        this.overflow = false;
      }
      if (line === hit && line < 240 && rendering()) this.sprite0 = true;
      if (line < 240 && rendering() && !this.overflow) this.evaluate(line);
      this.runTo(start + (line + 1) * LINE_CYCLES, onStep);
      if ((line < 240 || line === 261) && rendering()) this.mapper.scanline?.(line);
    }
    this.frame++;
  }
}
