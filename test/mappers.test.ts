import { describe, expect, it } from 'vitest';
import { createMapper } from '../src/mappers.ts';
import { Nes, parseRom } from '../src/nes.ts';
import { Ppu } from '../src/ppu.ts';

/** `n` 8 KB PRG banks, each filled with its number. */
const prgOf = (n: number) => new Uint8Array(n * 0x2000).map((_, i) => i >> 13);
const slots = (m: { read(a: number): number }) => [0x8000, 0xa000, 0xc000, 0xe000].map((a) => m.read(a));

/** An MMC1 register written the way a game does: five writes, low bit first. */
function mmc1(m: { write(a: number, v: number): void }, address: number, value: number) {
  for (let i = 0; i < 5; i++) m.write(address, (value >> i) & 1);
}

describe('mappers', () => {
  it('MMC1 switches CHR in 4 KB and 8 KB, and sets the mirroring', () => {
    const m = createMapper(1, prgOf(16), 128 * 1024);
    mmc1(m, 0x8000, 0x10 | 0x0c | 2); // 4 KB CHR, last PRG bank fixed, vertical
    mmc1(m, 0xa000, 5);
    mmc1(m, 0xc000, 9);
    expect(m.chrAt!(0x0123)).toBe(5 * 0x1000 + 0x123);
    expect(m.chrAt!(0x1123)).toBe(9 * 0x1000 + 0x123);
    expect(m.mirroring).toBe('vertical');
    mmc1(m, 0x8000, 0x0c | 3); // 8 KB CHR: the low bit of the bank ignored
    expect(m.chrAt!(0x1123)).toBe(4 * 0x1000 + 0x1123);
    expect(m.mirroring).toBe('horizontal');
    mmc1(m, 0xe000, 3);
    expect(slots(m)).toEqual([6, 7, 14, 15]);
  });

  it('MMC1 on 512 KB of PRG takes the 256 KB half from the CHR register', () => {
    const m = createMapper(1, prgOf(64));
    mmc1(m, 0xe000, 2);
    expect(slots(m)).toEqual([4, 5, 30, 31]);
    mmc1(m, 0xa000, 0x10);
    expect(slots(m)).toEqual([36, 37, 62, 63]);
  });

  it('CNROM picks an 8 KB CHR bank, through the bus conflict', () => {
    const prg = new Uint8Array(0x8000).fill(0xff);
    prg[0x10] = 0x01;
    const m = createMapper(3, prg);
    m.write(0x8000, 3);
    expect(m.chrAt!(0x0040)).toBe(3 * 0x2000 + 0x40);
    m.write(0x8010, 3); // the ROM holds $01 there
    expect(m.chrAt!(0x0040)).toBe(0x2000 + 0x40);
  });

  it('AxROM sets the single-screen page', () => {
    const m = createMapper(7, prgOf(32));
    expect(m.mirroring).toBe('single0');
    m.write(0x8000, 0x12);
    expect(m.mirroring).toBe('single1');
    expect(slots(m)).toEqual([8, 9, 10, 11]);
  });

  it('SS88006 (18) takes its registers a nibble at a time and counts CPU cycles to its IRQ', () => {
    const m = createMapper(18, prgOf(16), 128 * 1024);
    m.write(0x8000, 0x5);
    m.write(0x8001, 0x0);
    m.write(0x9001, 0x0);
    m.write(0x9000, 0xc);
    m.write(0xb002, 0x4);
    m.write(0xb003, 0x2); // CHR slot 3 = $24
    m.write(0xf002, 1);
    expect(slots(m)).toEqual([5, 0, 12, 15]);
    expect(m.chrAt!(0x0c10)).toBe(0x24 * 0x400 + 0x10);
    expect(m.mirroring).toBe('vertical');
    m.write(0xe000, 0x4); // reload 100 = $064
    m.write(0xe001, 0x6);
    m.write(0xf000, 0);
    m.write(0xf001, 1); // enabled, 16 bits
    m.clock!(100);
    expect(m.irq).toBe(false);
    m.clock!(1);
    expect(m.irq).toBe(true);
  });

  it('Namco 163 (19) banks PRG, CHR and nametables and counts its IRQ up to $7FFF', () => {
    const m = createMapper(19, prgOf(16), 128 * 1024);
    m.write(0xe000, 3);
    m.write(0xe800, 4);
    m.write(0xf000, 5);
    m.write(0x9800, 0x21); // CHR slot 3
    m.write(0xc800, 0xe1); // nametable 1 on CIRAM page 1
    expect(slots(m)).toEqual([3, 4, 5, 15]);
    expect(m.chrAt!(0x0c00)).toBe(0x21 * 0x400);
    expect([0, 1].map((n) => m.nametableAt!(n))).toEqual([0, 1]);
    m.write(0x5000, 0xfe);
    m.write(0x5800, 0xff); // $7FFE, enabled
    m.clock!(1);
    expect(m.irq).toBe(true);
    expect(m.read(0x5800)).toBe(0xff);
  });

  it('TC0690 (48) banks 2 KB and 1 KB of CHR and counts scanlines up to its IRQ', () => {
    const m = createMapper(48, prgOf(16), 256 * 1024);
    m.write(0x8000, 2);
    m.write(0x8003, 7);
    m.write(0xa002, 0x33);
    m.write(0xe000, 0x40);
    expect(slots(m)).toEqual([2, 1, 14, 15]);
    expect(m.chrAt!(0x0900)).toBe(7 * 0x800 + 0x100);
    expect(m.chrAt!(0x1800)).toBe(0x33 * 0x400);
    expect(m.mirroring).toBe('horizontal');
    m.write(0xc000, 0xfe);
    m.write(0xc001, 0);
    m.write(0xc002, 0);
    m.scanline!();
    expect(m.irq).toBe(false);
    m.scanline!();
    expect(m.irq).toBe(true);
  });

  it('X1-005 (80) and X1-017 (82) take their registers at $7EF0', () => {
    const a = createMapper(80, prgOf(16), 128 * 1024);
    a.write(0x7efa, 3);
    a.write(0x7efc, 4);
    a.write(0x7efe, 5);
    a.write(0x7ef1, 0x0b);
    a.write(0x7ef6, 1);
    expect(slots(a)).toEqual([3, 4, 5, 15]);
    expect(a.chrAt!(0x0c00)).toBe(0x0b * 0x400); // 2 KB at $0800: $0A, $0B
    expect(a.mirroring).toBe('vertical');
    const b = createMapper(82, prgOf(16), 128 * 1024);
    b.write(0x7efa, 3 << 2);
    b.write(0x7ef2, 0x30);
    b.write(0x7ef6, 2); // CHR halves swapped
    expect(slots(b)).toEqual([3, 1, 2, 15]);
    expect(b.chrAt!(0x0000)).toBe(0x30 * 0x400);
  });

  it('TxSROM (118) takes the nametables from bit 7 of the CHR registers', () => {
    const m = createMapper(118, prgOf(16), 128 * 1024);
    m.write(0x8000, 0);
    m.write(0x8001, 0x80); // R0
    m.write(0x8000, 1);
    m.write(0x8001, 0x02); // R1
    expect([0, 1, 2, 3].map((n) => m.nametableAt!(n))).toEqual([1, 1, 0, 0]);
    m.write(0x8000, 0x80 | 3);
    m.write(0x8001, 0x81); // R3: nametable 1 when the halves are swapped
    expect(m.nametableAt!(1)).toBe(1);
  });

  it('mapper 152 and 246 switch PRG and CHR', () => {
    const a = createMapper(152, prgOf(8).fill(0xff, 0x2000 * 6), 128 * 1024);
    a.write(0xc000, 0x80 | 0x20 | 5); // through the bus conflict: the fixed bank is all ones
    expect(slots(a)).toEqual([4, 5, 0xff, 0xff]);
    expect(a.chrAt!(0)).toBe(5 * 0x2000);
    expect(a.mirroring).toBe('single1');
    const b = createMapper(246, prgOf(64), 512 * 1024);
    b.write(0x6001, 9);
    b.write(0x6005, 0x11);
    expect(slots(b)).toEqual([0, 9, 2, 63]);
    expect(b.chrAt!(0x0900)).toBe(0x11 * 0x800 + 0x100);
  });
});

describe('the vblank race', () => {
  /**
   * NROM: NMI on, the main loop polls $2002 and counts what it sees in $10; the NMI handler reads
   * $2002 too (clearing the flag) and counts in $11. The NMI used to land between instructions on
   * the very cycle the flag went up, so the loop never saw it.
   */
  const program = [
    0x78, 0xa9, 0x80, 0x8d, 0x00, 0x20, // $C000 SEI; LDA #$80; STA $2000
    0xad, 0x02, 0x20, 0x10, 0xfb, //       $C006 LDA $2002; BPL $C006
    0xe6, 0x10, 0x4c, 0x06, 0xc0, //       $C00B INC $10; JMP $C006
    0x48, 0xad, 0x02, 0x20, 0xe6, 0x11, 0x68, 0x40, // $C010 PHA; LDA $2002; INC $11; PLA; RTI
  ];
  const rom = () => {
    const file = new Uint8Array(16 + 0x4000 + 0x2000);
    file.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]);
    file.set(program, 16);
    file.set([0x10, 0xc0, 0x00, 0xc0, 0x00, 0xc0], 16 + 0x3ffa); // NMI, RESET, IRQ
    return parseRom(file);
  };

  it('lets a loop polling $2002 see the flag on some frames, as on the console', () => {
    const nes = new Nes(rom());
    for (let f = 0; f < 120; f++) nes.runFrame();
    const ram = (nes as unknown as { ram: Uint8Array }).ram;
    expect(ram[0x10]).toBeGreaterThan(0); // the loop saw vblank
    expect(ram[0x11]).toBeGreaterThan(100); // and the NMI came nearly every frame
  });
});

describe('the boards added for the careful pass', () => {
  it('MMC2 (9) and MMC4 (10) switch PRG and pick CHR by the $FD/$FE latches', () => {
    const a = createMapper(9, prgOf(16), 128 * 1024);
    a.write(0xa000, 5);
    expect(slots(a)).toEqual([5, 13, 14, 15]);
    a.write(0xb000, 2); // $0000 at $FD
    a.write(0xc000, 3); // $0000 at $FE (the latch's power-on side)
    expect(a.chrAt!(0x0010)).toBe(3 * 0x1000 + 0x10);
    a.fetched!(0x0fd9); // the MMC2's left latch only at $0FD8 itself
    expect(a.chrAt!(0x0010)).toBe(3 * 0x1000 + 0x10);
    a.fetched!(0x0fd8);
    expect(a.chrAt!(0x0010)).toBe(2 * 0x1000 + 0x10);
    const b = createMapper(10, prgOf(16), 128 * 1024);
    b.write(0xa000, 3);
    expect(slots(b)).toEqual([6, 7, 14, 15]);
    b.write(0xd000, 7);
    b.fetched!(0x1fdd);
    expect(b.chrAt!(0x1004)).toBe(7 * 0x1000 + 4);
    b.write(0xf000, 1);
    expect(b.mirroring).toBe('horizontal');
  });

  it('VRC2a (22) and VRC4 (23, 25) take the register select from their own address lines', () => {
    const a = createMapper(22, prgOf(16), 128 * 1024);
    a.write(0x8000, 3);
    a.write(0xa000, 4);
    a.write(0xb000, 0x6); // CHR 0 low nibble
    a.write(0xb002, 0x1); // VRC2a: A1 is the low bit, so $B002 is the high nibble of CHR 0
    expect(slots(a)).toEqual([3, 4, 14, 15]);
    expect(a.chrAt!(0)).toBe((0x16 >> 1) * 0x400); // the VRC2a drops the low bit
    const b = createMapper(23, prgOf(16), 256 * 1024);
    b.write(0x8000, 2);
    b.write(0x9008, 2); // VRC4e: A3 → the swap register
    expect(slots(b)).toEqual([14, 1, 2, 15]);
    b.write(0xc008, 0x5); // VRC4e: A3 → CHR 3, low nibble
    expect(b.chrAt!(0x0c00)).toBe(5 * 0x400);
    const c = createMapper(25, prgOf(16), 256 * 1024);
    c.write(0xf000, 0x0e); // latch $FE: the low nibble at $F000…
    c.write(0xf002, 0x0f); // …the high at $F002 (A1 is the low select bit)
    c.write(0xf001, 0x06); // A0 → reg 2: cycle mode, enabled
    c.clock!(1);
    expect(c.irq).toBe(false);
    c.clock!(1);
    expect(c.irq).toBe(true);
  });

  it('FME-7 (69) maps $6000 to ROM or RAM and counts its IRQ down', () => {
    const m = createMapper(69, prgOf(16), 128 * 1024);
    const command = (c: number, v: number) => {
      m.write(0x8000, c);
      m.write(0xa000, v);
    };
    command(9, 4);
    command(0x0a, 5);
    command(0x0b, 6);
    command(8, 7);
    m.write(0x8000, 0x0b); // a command alone sets nothing
    expect(slots(m)).toEqual([4, 5, 6, 15]);
    expect(m.read(0x6000)).toBe(7);
    command(8, 0xc0);
    m.write(0x6000, 0x99);
    expect(m.read(0x6000)).toBe(0x99);
    command(0x0e, 2);
    command(0x0f, 0);
    command(0x0d, 0x81);
    m.clock!(2);
    expect(m.irq).toBe(false);
    m.clock!(1);
    expect(m.irq).toBe(true);
  });

  it('Camerica (71, 232), GxROM (66) and mapper 240 switch their PRG', () => {
    const a = createMapper(71, prgOf(16));
    a.write(0xc000, 3);
    expect(slots(a)).toEqual([6, 7, 14, 15]);
    expect(a.mirroring).toBeUndefined();
    a.write(0x9000, 0x10);
    expect(a.mirroring).toBe('single1');
    const b = createMapper(232, prgOf(32));
    b.write(0x8000, 0x10); // block 2
    b.write(0xc000, 1);
    expect(slots(b)).toEqual([18, 19, 22, 23]);
    const c = createMapper(66, prgOf(16).fill(0xff), 32 * 1024);
    c.write(0x8000, 0x13);
    expect(slots(c)).toEqual([4, 5, 6, 7].map(() => 0xff));
    expect(c.chrAt!(0)).toBe(3 * 0x2000);
    const d = createMapper(240, prgOf(16), 32 * 1024);
    d.write(0x4120, 0x12);
    expect(slots(d)).toEqual([4, 5, 6, 7]);
    expect(d.chrAt!(0x10)).toBe(2 * 0x2000 + 0x10);
  });

  it('Namco 108 (206), Namco 175/340 (210) and TQROM (119) bank like their relatives', () => {
    const a = createMapper(206, prgOf(16), 64 * 1024);
    a.write(0x8000, 0xc6); // the MMC3's mode bits are not there
    a.write(0x8001, 3);
    a.write(0xa000, 1); // nor its mirroring
    expect(slots(a)).toEqual([3, 1, 14, 15]);
    expect(a.mirroring).toBeUndefined();
    const b = createMapper(210, prgOf(16), 128 * 1024);
    b.write(0xe000, 2);
    b.write(0xe800, 3);
    b.write(0xf000, 4);
    b.write(0xb800, 9);
    expect(slots(b)).toEqual([2, 3, 4, 15]);
    expect(b.chrAt!(0x1c00)).toBe(9 * 0x400);
    const c = createMapper(119, prgOf(16), 64 * 1024);
    c.write(0x8000, 2);
    c.write(0x8001, 0x45); // R2, bit 6: CHR RAM bank 5
    expect(c.chrRamAt!(0x1000)).toBe(5 * 0x400);
    expect(c.chrRamAt!(0x0000)).toBe(-1);
  });

  it('TC0190 (33) takes the mirroring from $8000, Sunsoft-4 (68) from $E000', () => {
    const a = createMapper(33, prgOf(16), 128 * 1024);
    a.write(0x8000, 0x45);
    expect(slots(a)).toEqual([5, 1, 14, 15]);
    expect(a.mirroring).toBe('horizontal');
    const b = createMapper(68, prgOf(16), 128 * 1024);
    b.write(0xf000, 2);
    b.write(0xe000, 1);
    b.write(0x9000, 6);
    expect(slots(b)).toEqual([4, 5, 14, 15]);
    expect(b.mirroring).toBe('horizontal');
    expect(b.chrAt!(0x0900)).toBe(6 * 0x800 + 0x100);
  });

  it("Namco 163 (19) tells its sound ports apart from its banking", () => {
    const m = createMapper(19, prgOf(16), 128 * 1024);
    expect([0x4800, 0xf800, 0xe000, 0x5000].map((a) => m.isSound!(a))).toEqual([true, true, false, false]);
  });
});

describe('an NMI switched on during vblank', () => {
  /**
   * NROM: a few lines into vblank, with the NMI off: LDA #$80; STA $2000; STA $10. The handler copies
   * $10 to $11. The write pulls the NMI line on its last cycle, after the CPU polled, so STA $10
   * runs first (FCEUX's NMI2) — Lolo 2, Hanjuku Hero and Pugsley's Scavenger Hunt keep the $2000
   * value in RAM right there, and hung when the handler came in between.
   */
  it('lets one more instruction run before it is taken', () => {
    const file = new Uint8Array(16 + 0x4000 + 0x2000);
    file.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]);
    // $C000 JMP *; $C003 LDA #$80; STA $2000; STA $10; JMP *
    file.set([0x4c, 0x00, 0xc0, 0xa9, 0x80, 0x8d, 0x00, 0x20, 0x85, 0x10, 0x4c, 0x0a, 0xc0], 16);
    // $C020 LDA $10; STA $11; LDA #$00; STA $2000; RTI
    file.set([0xa5, 0x10, 0x85, 0x11, 0xa9, 0x00, 0x8d, 0x00, 0x20, 0x40], 16 + 0x20);
    file.set([0x20, 0xc0, 0x00, 0xc0, 0x00, 0xc0], 16 + 0x3ffa);
    const nes = new Nes(parseRom(file));
    nes.runFrame();
    // Into the switch-on a few lines into vblank, the flag up and unread.
    let jumped = false;
    nes.runFrame(() => {
      if (!jumped && nes.line === 245) {
        nes.cpu.pc = 0xc003;
        jumped = true;
      }
    });
    expect((nes as unknown as { ram: Uint8Array }).ram[0x11]).toBe(0x80);
  });
});

describe('what a game reads back from the PPU and the sound chip', () => {
  /** NROM with `program` at $C000 and `irq` at $C080; NMI off, so only the IRQ interrupts. */
  const rom = (program: number[], irq: number[] = [0x40], mapper = 0) => {
    const file = new Uint8Array(16 + 0x4000 + 0x2000);
    file.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, (mapper & 0x0f) << 4, mapper & 0xf0]);
    file.set(program, 16);
    file.set(irq, 16 + 0x80);
    file.set([0x00, 0xc0, 0x00, 0xc0, 0x80, 0xc0], 16 + 0x3ffa); // NMI, RESET, IRQ
    return parseRom(file);
  };
  const io = (nes: Nes) => nes as unknown as { write(a: number, v: number): void; read(a: number): number; ram: Uint8Array };
  const frames = (nes: Nes, n: number) => {
    for (let f = 0; f < n; f++) nes.runFrame();
  };

  /** Rendering on; count in $10 the reads of $2002 that show bit 5. */
  const overflowLoop = [0xa9, 0x18, 0x8d, 0x01, 0x20, 0xad, 0x02, 0x20, 0x29, 0x20, 0xf0, 0xf9, 0xe6, 0x10, 0x4c, 0x05, 0xc0];
  const withSprites = (count: number) => {
    const nes = new Nes(rom(overflowLoop));
    for (let i = 0; i < 256; i++) io(nes).write(0x0200 + i, 0xf0);
    io(nes).write(0x4014, 0x02); // all sprites off the screen
    for (let s = 0; s < count; s++) {
      io(nes).write(0x2003, s * 4);
      io(nes).write(0x2004, 50);
    }
    frames(nes, 3);
    return io(nes).ram[0x10];
  };

  it('raises the sprite overflow flag when a line has more than eight sprites', () => {
    expect(withSprites(9)).toBeGreaterThan(0);
    expect(withSprites(8)).toBe(0);
  });

  it('raises the frame IRQ in the 4-step mode, about once a frame', () => {
    // LDA #$00; STA $4017; CLI; JMP *  —  IRQ: INC $11; LDA $4015 (acknowledges); RTI
    const irq = [0xe6, 0x11, 0xad, 0x15, 0x40, 0x40];
    const on = new Nes(rom([0xa9, 0x00, 0x8d, 0x17, 0x40, 0x58, 0x4c, 0x06, 0xc0], irq));
    frames(on, 120);
    expect(io(on).ram[0x11]).toBeGreaterThanOrEqual(118);
    expect(io(on).ram[0x11]).toBeLessThanOrEqual(120);
    const off = new Nes(rom([0xa9, 0x40, 0x8d, 0x17, 0x40, 0x58, 0x4c, 0x06, 0xc0], irq));
    frames(off, 120);
    expect(io(off).ram[0x11]).toBe(0);
  });

  it('drops the frame IRQ power-on raised on any $4017 write, as FCEUX does', () => {
    // Two frames idle (the flag goes up 29829 cycles in), then STA $4017 = $80 (5-step); CLI.
    const program = [0xad, 0x02, 0x20, 0x10, 0xfb, 0xad, 0x02, 0x20, 0x10, 0xfb, 0xa9, 0x80, 0x8d, 0x17, 0x40, 0x58, 0x4c, 0x10, 0xc0];
    const nes = new Nes(rom(program, [0xe6, 0x11, 0x40]));
    frames(nes, 30);
    expect(io(nes).ram[0x11]).toBe(0);
  });

  it("raises the DMC IRQ as the sample's last byte is fetched", () => {
    // $4017 = $40 (no frame IRQ), $4010 = $8F (IRQ, the fastest rate: 432 cycles a byte), $4013 = 1
    // (17 bytes), $4015 = $10; CLI. IRQ: INC $12; LDA #$10; STA $4015 (clears the flag, starts again); RTI.
    const program = [0xa9, 0x40, 0x8d, 0x17, 0x40, 0xa9, 0x8f, 0x8d, 0x10, 0x40, 0xa9, 0x01, 0x8d, 0x13, 0x40, 0xa9, 0x10, 0x8d, 0x15, 0x40, 0x58, 0x4c, 0x15, 0xc0];
    const nes = new Nes(rom(program, [0xe6, 0x12, 0xa9, 0x10, 0x8d, 0x15, 0x40, 0x40]));
    frames(nes, 50);
    // 17 bytes × 432 cycles = 7344 a round: 4.06 a frame.
    expect(io(nes).ram[0x12]).toBeGreaterThanOrEqual(200);
    expect(io(nes).ram[0x12]).toBeLessThanOrEqual(205);
  });

  it('reads the length counters in $4015, a halted one staying up', () => {
    const nes = new Nes(rom([0x4c, 0x00, 0xc0]));
    io(nes).write(0x4015, 0x03);
    io(nes).write(0x4000, 0x10); // pulse 1 counts down
    io(nes).write(0x4003, 0x08); // 254 half frames
    io(nes).write(0x4004, 0x30); // pulse 2 halted
    io(nes).write(0x4007, 0x08);
    frames(nes, 2);
    expect(io(nes).read(0x4015) & 3).toBe(3);
    frames(nes, 130);
    expect(io(nes).read(0x4015) & 3).toBe(2);
    io(nes).write(0x4015, 0);
    expect(io(nes).read(0x4015) & 3).toBe(0);
  });

  it("logs the writes to a cartridge's own sound chip with the 2A03's", () => {
    const nes = new Nes(rom([0x4c, 0x00, 0xc0], [0x40], 19));
    io(nes).write(0xf800, 0x80);
    io(nes).write(0x4800, 0x12);
    io(nes).write(0xe000, 0x01); // a PRG bank — not sound
    expect(nes.writes.map((w) => w.address)).toEqual([0xf800, 0x4800]);
    // A read of the data port steps the address as a write does (Mappy Kids reads to skip a
    // register): logged as the address port's new value, so a replay of the log keeps step.
    io(nes).read(0x4800);
    expect(nes.writes.slice(2).map((w) => [w.address, w.value])).toEqual([[0xf800, 0x82]]);
  });
});

describe('sprite memory', () => {
  /** NROM looping at $C000, CHR all ones (every sprite pixel opaque), the NMI off. */
  const cart = () => {
    const file = new Uint8Array(16 + 0x4000 + 0x2000);
    file.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]);
    file.set([0x4c, 0x00, 0xc0], 16);
    file.set([0x00, 0xc0, 0x00, 0xc0, 0x00, 0xc0], 16 + 0x3ffa);
    file.fill(0xff, 16 + 0x4000);
    return parseRom(file);
  };
  const io = (nes: Nes) => nes as unknown as { write(a: number, v: number): void; read(a: number): number; oam: Uint8Array };
  const machine = () => {
    const c = cart();
    const nes = new Nes(c);
    const ppu = new Ppu(c, nes.mapper);
    nes.ppu = ppu;
    return { nes, ppu };
  };

  it('starts a sprite DMA at OAM 0 once vblank has zeroed the address, as FCEUX does', () => {
    // Akira writes sprite 0 through $2004 — the address left at 4 — and DMAs page 2 in its next NMI.
    const { nes, ppu } = machine();
    io(nes).write(0x2003, 0);
    for (const v of [0x7f, 0x81, 0x21, 0xf0]) io(nes).write(0x2004, v);
    for (let i = 0; i < 256; i++) io(nes).write(0x0200 + i, i);
    nes.runFrame();
    io(nes).write(0x4014, 0x02);
    expect([...ppu.oam.subarray(0, 8)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...io(nes).oam.subarray(0, 8)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('hits sprite 0 only on a visible line', () => {
    const hitSeen = (y: number, line: number) => {
      const { nes } = machine();
      io(nes).write(0x2001, 0x18);
      io(nes).write(0x2003, 0);
      for (const v of [y, 0, 0, 0x80]) io(nes).write(0x2004, v);
      let seen = 0;
      for (let f = 0; f < 3; f++) nes.runFrame(() => nes.line === line && (seen |= io(nes).read(0x2002) & 0x40));
      return seen !== 0;
    };
    expect(hitSeen(0x7f, 200)).toBe(true);
    expect(hitSeen(0xff, 258)).toBe(false); // Y = $FF would be line 256: in vblank, never drawn
  });
});

describe('the boards added on 2026-11-07', () => {
  it('RAMBO-1 (64) banks like an MMC3 with three PRG registers, 1 KB CHR and swapped halves', () => {
    const m = createMapper(64, prgOf(8), 128 * 1024);
    const reg = (r: number, v: number) => {
      m.write(0x8000, r);
      m.write(0x8001, v);
    };
    expect(slots(m)).toEqual([7, 7, 7, 7]); // every register $FF at power-on
    reg(6, 1);
    reg(7, 2);
    reg(15, 3);
    expect(slots(m)).toEqual([1, 2, 3, 7]);
    m.write(0x8000, 0x40); // RF first
    expect(slots(m)).toEqual([3, 1, 2, 7]);
    reg(0, 0x11);
    reg(1, 0x21);
    reg(8, 0x30);
    reg(9, 0x40);
    reg(2, 0x50);
    expect([0x0000, 0x0400, 0x0800, 0x0c00].map((a) => m.chrAt!(a) / 0x400)).toEqual([0x10, 0x11, 0x20, 0x21]);
    m.write(0x8000, 0x20); // 1 KB mode: R8 at $0400, R9 at $0C00
    expect([0x0000, 0x0400, 0x0800, 0x0c00].map((a) => m.chrAt!(a) / 0x400)).toEqual([0x11, 0x30, 0x21, 0x40]);
    m.write(0x8000, 0xa0); // and the halves swapped
    expect(m.chrAt!(0x0010)).toBe(0x50 * 0x400 + 0x10);
    expect(m.chrAt!(0x1400)).toBe(0x30 * 0x400);
    m.write(0x9001, 0x77); // FCEUX decodes A & $F001: $9001 is no register
    expect(m.chrAt!(0x1000)).toBe(0x11 * 0x400);
    m.write(0xa000, 1);
    expect(m.mirroring).toBe('horizontal');
  });

  it('RAMBO-1 (64) counts scanlines, skipping the pre-render line, or CPU cycles in fours', () => {
    const m = createMapper(64, prgOf(8), 128 * 1024);
    m.write(0xc000, 2);
    m.write(0xc001, 0); // scanline mode: the counter loaded from the latch
    m.write(0xe001, 0);
    for (const line of [0, 1, 261]) {
      m.scanline!(line);
      expect(m.irq).toBe(false);
    }
    m.scanline!(2); // past zero
    expect(m.irq).toBe(true);
    m.write(0xe000, 0); // acknowledged; the IRQ having fired, the write reloads the counter
    m.write(0xe001, 0);
    m.scanline!(3);
    m.scanline!(4);
    expect(m.irq).toBe(false);
    m.scanline!(5);
    expect(m.irq).toBe(true);
    const c = createMapper(64, prgOf(8), 128 * 1024);
    c.write(0xc000, 1);
    c.write(0xc001, 1); // cycle mode
    c.write(0xe001, 0);
    c.clock!(7);
    expect(c.irq).toBe(false);
    c.clock!(1);
    expect(c.irq).toBe(true);
    c.scanline!(10); // the scanlines do not count in cycle mode
  });

  it('Color Dreams (11) and NINA-03/06 (79) switch 32 KB of PRG and 8 KB of CHR', () => {
    const a = createMapper(11, prgOf(16), 128 * 1024);
    a.write(0x8000, 0x31);
    expect(slots(a)).toEqual([4, 5, 6, 7]);
    expect(a.chrAt!(0x10)).toBe(3 * 0x2000 + 0x10);
    const b = createMapper(79, prgOf(8), 64 * 1024);
    b.write(0x5100, 0x0d); // A8 set: PRG 1, CHR 5
    expect(slots(b)).toEqual([4, 5, 6, 7]);
    expect(b.chrAt!(0x10)).toBe(5 * 0x2000 + 0x10);
    b.write(0x4200, 0x00); // A8 clear: not the register
    b.write(0x8000, 0x00);
    expect(b.chrAt!(0x10)).toBe(5 * 0x2000 + 0x10);
  });

  it('Datach (157) banks PRG at $8000 only and keeps CHR in RAM', () => {
    const m = createMapper(157, prgOf(32));
    m.write(0x6008, 3); // the FCG's $6000 registers are not on the Datach
    expect(slots(m)).toEqual([0, 1, 30, 31]);
    m.write(0x8008, 3);
    m.write(0x8009, 1);
    expect(slots(m)).toEqual([6, 7, 30, 31]);
    expect(m.mirroring).toBe('horizontal');
    const file = new Uint8Array(16 + 0x40000);
    file.set([0x4e, 0x45, 0x53, 0x1a, 16, 0, 0xd0, 0x90]);
    const cart = parseRom(file);
    const ppu = new Ppu(cart, m);
    for (const [r, v] of [[6, 0x14], [6, 0x00], [7, 0xab]]) ppu.write(r, v, 241);
    m.write(0x8005, 7); // a CHR register: nothing to switch
    expect(ppu.snapshot().chr[0x1400]).toBe(0xab);
  });

  it("Datach (157) keeps a 24C02: written through $800D, read back in bit 4 of $6000", () => {
    const m = createMapper(157, prgOf(32));
    const line = (scl: number, sda: number) => m.write(0x800d, (scl << 5) | (sda << 6));
    const bit = () => (m.read(0x6000) >> 4) & 1;
    const start = () => [line(0, 1), line(1, 1), line(1, 0), line(0, 0)];
    const stop = () => [line(0, 0), line(1, 0), line(1, 1)];
    /** Eight bits out, MSB first; the chip's acknowledge (0) read on the ninth clock. */
    const send = (byte: number) => {
      for (let i = 7; i >= 0; i--) {
        const b = (byte >> i) & 1;
        line(0, b);
        line(1, b);
        line(0, b);
      }
      line(0, 1);
      line(1, 1);
      const ack = bit();
      line(0, 1);
      return ack;
    };
    const receive = (last: boolean) => {
      let v = 0;
      for (let i = 0; i < 8; i++) {
        line(0, 1);
        line(1, 1);
        v = (v << 1) | bit();
      }
      const ack = last ? 1 : 0;
      line(0, ack);
      line(1, ack);
      line(0, ack);
      return v;
    };
    start();
    expect([0xa0, 0x10, 0x5a, 0xc3].map(send)).toEqual([0, 0, 0, 0]); // two bytes from word $10
    stop();
    start();
    expect([0xa0, 0x10].map(send)).toEqual([0, 0]);
    start(); // a repeated START: now read from word $10
    expect(send(0xa1)).toBe(0);
    expect([receive(false), receive(true)]).toEqual([0x5a, 0xc3]);
    stop();
    start();
    expect(send(0x70)).toBe(1); // not its device address: no acknowledge
    stop();
  });
});
