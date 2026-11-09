/**
 * Cartridge mappers — what the CPU sees: which PRG bank answers at each
 * address, PRG RAM, the scanline and CPU-cycle IRQs; and, for the picture
 * (`ppu.ts`), the CHR banks and the nametable mirroring a mapper switches.
 * Without them the PPU takes the first 8 KB of CHR and the mirroring wired on
 * the board.
 *
 * Together these cover most of the NES library: NROM (0), MMC1 (1), UxROM (2),
 * CNROM (3), MMC3 (4), AxROM (7), MMC2 (9) and MMC4 (10), Color Dreams (11), Tengen RAMBO-1 (64),
 * GxROM (66), Camerica (71, 232), NINA-03/06 (79), TQROM (119) — and the Japanese boards: Bandai
 * FCG (16) and Datach (157), Jaleco SS88006 (18),
 * Namco 163 (19, its sound chip's writes logged, not played), Konami VRC2/VRC4 (21, 22, 23,
 * 25), Taito TC0190 (33), TC0690 (48), X1-005 (80) and X1-017 (82), Sunsoft-3 (67), Sunsoft-4
 * (68), Sunsoft FME-7 (69, banking and IRQ — not the 5B's sound), Namco 108 (206), Namco
 * 175/340 (210), TxSROM (118), mapper 152, 240, 246 and 250.
 */

/** Which CIRAM page the four logical nametables use; `single0`/`single1` put all four on one. */
export type Mirroring = 'horizontal' | 'vertical' | 'single0' | 'single1';

export interface Mapper {
  readonly name: string;
  /** A CPU read at $4020-$FFFF. */
  read(address: number): number;
  /** A CPU write at $4020-$FFFF. */
  write(address: number, value: number): void;
  /** Index of the 8 KB PRG bank answering at `address` ($8000-$FFFF). */
  bankAt(address: number): number;
  /**
   * Called once per visible scanline and the pre-render line (261) while rendering is on — the
   * MMC3's IRQ clock.
   */
  scanline?(line?: number): void;
  /** Told the CPU cycles every instruction took — for an IRQ counter clocked by the CPU. */
  clock?(cycles: number): void;
  /** An IRQ the cartridge is asserting. */
  irq?: boolean;
  /** Where in CHR ROM the PPU's pattern address $0000-$1FFF is, for a mapper that switches CHR. */
  chrAt?(address: number): number;
  /** The nametable mirroring the mapper has set, when it sets it. */
  mirroring?: Mirroring;
  /** The CIRAM page (0 or 1) logical nametable 0–3 is on, for a mapper that picks them one by one. */
  nametableAt?(n: number): number;
  /**
   * Where in 8 KB of CHR RAM the pattern address is, or -1 when it is CHR ROM — for a board that
   * has both (TQROM).
   */
  chrRamAt?(address: number): number;
  /** The PPU fetched the pattern byte at `address` to draw it — what the MMC2/MMC4 latches watch. */
  fetched?(address: number): void;
  /** A CPU write the cartridge's own sound chip takes (N163) — logged with the 2A03's. */
  isSound?(address: number): boolean;
  /**
   * After a CPU read at `address`: the write that would have moved the sound chip the way the read
   * did, for the log — the N163's data port steps its address on a read too — or undefined.
   */
  soundRead?(address: number): { address: number; value: number } | undefined;
  /**
   * Set the registers so that these 8 KB banks answer at $8000, $A000, $C000, $E000 — the banks
   * a memory dump shows, found in the ROM. False if no setting of this mapper maps them.
   */
  restore(banks: readonly number[]): boolean;
}

/** `chrSize` is the CHR ROM's size in bytes — 0 for a board with CHR RAM. */
export function createMapper(id: number, prg: Uint8Array, chrSize = 0): Mapper {
  switch (id) {
    case 0:
      return new Nrom(prg);
    case 1:
      return new Mmc1(prg, chrSize);
    case 2:
      return new Uxrom(prg);
    case 3:
      return new Cnrom(prg);
    case 4:
      return new Mmc3(prg);
    case 7:
      return new Axrom(prg);
    case 9:
      return new Mmc2(prg, false);
    case 10:
      return new Mmc2(prg, true);
    case 11:
      return new ColorDreams(prg);
    case 16:
      return new BandaiFcg(prg);
    case 18:
      return new Ss88006(prg);
    case 19:
      return new Namco163(prg);
    case 21:
    case 22:
    case 23:
    case 25:
      return new Vrc4(prg, id);
    case 33:
      return new Tc0190(prg);
    case 48:
      return new Tc0690(prg);
    case 64:
      return new Rambo1(prg);
    case 66:
      return new Gxrom(prg);
    case 67:
      return new Sunsoft3(prg);
    case 68:
      return new Sunsoft4(prg);
    case 69:
      return new Fme7(prg);
    case 71:
      return new Camerica(prg);
    case 79:
      return new Nina0306(prg);
    case 80:
      return new X1005(prg);
    case 87:
      return new Mapper87(prg);
    case 82:
      return new X1017(prg);
    case 118:
      return new Txsrom(prg);
    case 119:
      return new Tqrom(prg);
    case 152:
      return new Mapper152(prg);
    case 157:
      return new Datach(prg);
    case 206:
      return new Namco108(prg);
    case 210:
      return new Namco175(prg);
    case 232:
      return new Quattro(prg);
    case 240:
      return new Mapper240(prg);
    case 246:
      return new Mapper246(prg);
    case 250:
      return new Mapper250(prg);
    default:
      throw new Error(`mapper ${id} is not supported yet`);
  }
}

/** Shared: PRG RAM and 8 KB bank addressing. */
abstract class Base implements Mapper {
  abstract readonly name: string;
  protected readonly ram = new Uint8Array(0x2000);
  protected readonly prg: Uint8Array;
  protected readonly count8: number;
  constructor(prg: Uint8Array) {
    this.prg = prg;
    this.count8 = prg.length / 0x2000;
  }
  abstract bankAt(address: number): number;
  read(address: number): number {
    if (address < 0x6000) return 0; // nothing on the cartridge answers at $4020-$5FFF
    if (address < 0x8000) return this.ram[address - 0x6000];
    return this.prg[(this.bankAt(address) % this.count8) * 0x2000 + (address & 0x1fff)];
  }
  write(address: number, value: number): void {
    if (address < 0x6000) return;
    if (address < 0x8000) this.ram[address - 0x6000] = value;
    else this.control(address, value);
  }
  protected control(_address: number, _value: number): void {}
  restore(banks: readonly number[]): boolean {
    this.set(banks);
    return this.maps(banks);
  }
  /** Registers from the banks seen; `restore` then checks they map what was seen. */
  protected set(_banks: readonly number[]): void {}
  protected maps(banks: readonly number[]): boolean {
    return banks.every((bank, slot) => this.bankAt(0x8000 + slot * 0x2000) % this.count8 === bank);
  }
}

class Nrom extends Base {
  readonly name: string;
  constructor(prg: Uint8Array, name = 'NROM') {
    super(prg);
    this.name = name;
  }
  bankAt(address: number) {
    // 16 KB carts mirror: $C000 is $8000 again.
    return ((address - 0x8000) >> 13) % this.count8;
  }
}

/** NROM's PRG, and one 8 KB CHR bank picked by a write anywhere in $8000-$FFFF. */
class Cnrom extends Nrom {
  private chr = 0;
  constructor(prg: Uint8Array) {
    super(prg, 'CNROM');
  }
  chrAt(address: number) {
    return this.chr * 0x2000 + address;
  }
  protected control(address: number, value: number) {
    // Bus conflict: the ROM drives the same lines, so the bits it holds low stay low.
    this.chr = value & this.read(address);
  }
}

/**
 * Mapper 87 (Jaleco/Konami/Taito J87): NROM's PRG, and one 8 KB CHR bank picked by a write in
 * $6000-$7FFF — its two low bits swapped, bit 0 the bank's high bit. No PRG RAM there. The Goonies.
 */
class Mapper87 extends Nrom {
  private chr = 0;
  constructor(prg: Uint8Array) {
    super(prg, 'J87');
  }
  chrAt(address: number) {
    return this.chr * 0x2000 + address;
  }
  write(address: number, value: number) {
    if (address >= 0x6000 && address < 0x8000) this.chr = ((value & 1) << 1) | ((value >> 1) & 1);
  }
}

class Uxrom extends Base {
  readonly name = 'UxROM';
  private bank = 0;
  bankAt(address: number) {
    const last16 = this.count8 / 2 - 1;
    const bank16 = address < 0xc000 ? this.bank : last16;
    return bank16 * 2 + ((address >> 13) & 1);
  }
  protected control(_address: number, value: number) {
    this.bank = value & 0x0f;
  }
  protected set(banks: readonly number[]) {
    this.bank = banks[0] >> 1;
  }
}

class Axrom extends Base {
  readonly name = 'AxROM';
  private bank = 0;
  mirroring: Mirroring = 'single0';
  bankAt(address: number) {
    return this.bank * 4 + ((address - 0x8000) >> 13);
  }
  protected control(_address: number, value: number) {
    this.bank = value & 0x07;
    this.mirroring = value & 0x10 ? 'single1' : 'single0';
  }
  protected set(banks: readonly number[]) {
    this.bank = banks[0] >> 2;
  }
}

/**
 * MMC1: PRG in 32 KB or 16 KB with one half fixed, CHR in one 8 KB or two 4 KB banks, mirroring.
 * A 512 KB board (SUROM) takes PRG A18 from bit 4 of the CHR register, as its CHR is RAM.
 */
class Mmc1 extends Base {
  readonly name = 'MMC1';
  private shift = 0;
  private bits = 0;
  private ctrl = 0x0c;
  private prgBank = 0;
  private chr0 = 0;
  private chr1 = 0;
  private readonly chrSize: number;
  constructor(prg: Uint8Array, chrSize: number) {
    super(prg);
    this.chrSize = chrSize;
  }
  get mirroring(): Mirroring {
    return (['single0', 'single1', 'vertical', 'horizontal'] as const)[this.ctrl & 3];
  }
  /** The 256 KB half of a 512 KB board, in 16 KB banks. */
  private get outer() {
    return this.count8 > 32 && this.chrSize === 0 ? this.chr0 & 0x10 : 0;
  }
  bankAt(address: number) {
    const mode = (this.ctrl >> 2) & 3;
    const bank = this.prgBank & 0x0f;
    const last16 = Math.min(this.count8 / 2, 16) - 1;
    const upper = address >= 0xc000;
    let bank16: number;
    if (mode < 2) bank16 = (bank & ~1) + (upper ? 1 : 0); // 32 KB
    else if (mode === 2) bank16 = upper ? bank : 0; // first fixed at $8000
    else bank16 = upper ? last16 : bank; // last fixed at $C000
    return (this.outer + bank16) * 2 + ((address >> 13) & 1);
  }
  chrAt(address: number) {
    if (this.ctrl & 0x10) return (address < 0x1000 ? this.chr0 : this.chr1) * 0x1000 + (address & 0xfff);
    return (this.chr0 & 0x1e) * 0x1000 + address;
  }
  protected control(address: number, value: number) {
    if (value & 0x80) {
      this.shift = 0;
      this.bits = 0;
      this.ctrl |= 0x0c;
      return;
    }
    this.shift |= (value & 1) << this.bits;
    if (++this.bits < 5) return;
    const data = this.shift;
    this.shift = 0;
    this.bits = 0;
    const reg = (address >> 13) & 3;
    if (reg === 0) this.ctrl = data;
    else if (reg === 1) this.chr0 = data;
    else if (reg === 2) this.chr1 = data;
    else this.prgBank = data;
  }
  protected set(banks: readonly number[]) {
    this.shift = 0;
    this.bits = 0;
    const last16 = Math.min(this.count8 / 2, 16) - 1;
    if (this.count8 > 32) this.chr0 = banks[0] >= 32 ? 0x10 : 0;
    const low = (banks[0] >> 1) & 0x0f;
    const high = (banks[2] >> 1) & 0x0f;
    // The last bank fixed at $C000, the first at $8000, or 32 KB in one.
    if (high === last16) [this.ctrl, this.prgBank] = [0x0c, low];
    else if (low === 0) [this.ctrl, this.prgBank] = [0x08, high];
    else [this.ctrl, this.prgBank] = [0x00, low];
  }
}

class Mmc3 extends Base {
  readonly name: string = 'MMC3';
  protected select = 0;
  protected readonly regs = [0, 2, 4, 5, 6, 7, 0, 1];
  private latch = 0;
  private counter = 0;
  private reload = false;
  private enabled = false;
  irq = false;
  mirroring?: Mirroring;
  bankAt(address: number) {
    const slot = (address >> 13) & 3;
    const last = this.count8 - 1;
    const swapped = (this.select >> 6) & 1;
    if (slot === 1) return this.regs[7];
    if (slot === 3) return last;
    if (slot === 0) return swapped ? last - 1 : this.regs[6];
    return swapped ? this.regs[6] : last - 1;
  }
  /**
   * R0 and R1 are 2 KB at $0000 and $0800, R2-R5 1 KB from $1000 — the halves swapped when bit 7
   * of the bank select is set. A 2 KB register's low bit is ignored.
   */
  chrAt(address: number) {
    return this.chrBank(address) * 0x400 + (address & 0x3ff);
  }
  /** The 1 KB CHR bank register value answering at the pattern address. */
  protected chrBank(address: number) {
    const a = this.select & 0x80 ? address ^ 0x1000 : address;
    return a < 0x1000 ? (this.regs[a >> 11] & 0xfe) + ((a >> 10) & 1) : this.regs[2 + ((a - 0x1000) >> 10)];
  }
  protected set(banks: readonly number[]) {
    // $C000 fixed to the second last bank, or swapped with $8000.
    const swapped = banks[2] !== this.count8 - 2;
    this.select = swapped ? 0x40 : 0;
    this.regs[6] = swapped ? banks[2] : banks[0];
    this.regs[7] = banks[1];
  }
  protected control(address: number, value: number) {
    const even = (address & 1) === 0;
    switch (address & 0xe000) {
      case 0x8000:
        if (even) this.select = value;
        else this.regs[this.select & 7] = value;
        return;
      case 0xa000:
        if (even) this.mirroring = value & 1 ? 'horizontal' : 'vertical';
        return;
      case 0xc000:
        if (even) this.latch = value;
        else {
          this.counter = 0;
          this.reload = true;
        }
        return;
      case 0xe000:
        if (even) {
          this.enabled = false;
          this.irq = false;
        } else this.enabled = true;
        return;
    }
  }
  scanline() {
    if (this.counter === 0 || this.reload) {
      this.counter = this.latch;
      this.reload = false;
    } else this.counter--;
    if (this.counter === 0 && this.enabled) this.irq = true;
  }
}

/**
 * TxSROM (118): an MMC3 whose CHR registers' bit 7 also picks the CIRAM page of each nametable —
 * R0/R1 for the two halves, or R2-R5 one each when the CHR halves are swapped. $A000 does nothing.
 */
class Txsrom extends Mmc3 {
  readonly name = 'TxSROM';
  nametableAt(n: number) {
    return this.select & 0x80 ? this.regs[2 + n] >> 7 : this.regs[n >> 1] >> 7;
  }
  protected control(address: number, value: number) {
    if ((address & 0xe001) === 0xa000) return;
    super.control(address, value);
  }
}

/**
 * Jaleco SS88006 (18): three 8 KB PRG banks and eight 1 KB CHR banks, each register written a
 * nibble at a time; an IRQ counter that counts CPU cycles down, 4, 8, 12 or 16 bits wide.
 */
class Ss88006 extends Base {
  readonly name = 'SS88006';
  private readonly prgRegs = [0, 0, 0];
  private readonly chrRegs = new Array<number>(8).fill(0);
  private reloadValue = 0;
  private counter = 0;
  private irqCtrl = 0;
  irq = false;
  mirroring: Mirroring = 'horizontal';
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    return slot === 3 ? this.count8 - 1 : this.prgRegs[slot];
  }
  chrAt(address: number) {
    return this.chrRegs[address >> 10] * 0x400 + (address & 0x3ff);
  }
  protected control(address: number, value: number) {
    const reg = address & 0xf003;
    const nibble = value & 0x0f;
    const put = (old: number, high: boolean) => (high ? (old & 0x0f) | (nibble << 4) : (old & 0xf0) | nibble);
    if (reg < 0x9002) {
      const i = ((reg >> 12) - 8) * 2 + ((reg >> 1) & 1); // $8000/1, $8002/3, $9000/1
      this.prgRegs[i] = put(this.prgRegs[i], (reg & 1) === 1);
    } else if (reg >= 0xa000 && reg < 0xe000) {
      const i = ((reg >> 12) - 0xa) * 2 + ((reg >> 1) & 1);
      this.chrRegs[i] = put(this.chrRegs[i], (reg & 1) === 1);
    } else if (reg >= 0xe000 && reg < 0xf000) {
      const shift = (reg & 3) * 4;
      this.reloadValue = (this.reloadValue & ~(0x0f << shift)) | (nibble << shift);
    } else if (reg === 0xf000) {
      this.counter = this.reloadValue;
      this.irq = false;
    } else if (reg === 0xf001) {
      this.irqCtrl = value;
      this.irq = false;
    } else if (reg === 0xf002) {
      this.mirroring = (['horizontal', 'vertical', 'single0', 'single1'] as const)[value & 3];
    }
  }
  clock(cycles: number) {
    if (!(this.irqCtrl & 1)) return;
    const mask = this.irqCtrl & 8 ? 0xf : this.irqCtrl & 4 ? 0xff : this.irqCtrl & 2 ? 0xfff : 0xffff;
    const left = (this.counter & mask) - cycles;
    if (left < 0) this.irq = true;
    this.counter = (this.counter & ~mask) | (left & mask);
  }
}

/**
 * Namco 163 (19), its banking: three 8 KB PRG banks, eight 1 KB CHR banks, the four nametables
 * one by one, and a 15-bit IRQ counter that counts CPU cycles up to $7FFF. Of its sound the 128
 * bytes of RAM behind $4800 are kept, as a game may keep data there, and the writes to its two
 * ports ($4800 data, $F800 address) are the sound chip's, for the log. A CHR register pointing
 * at CIRAM ($E0-$FF) for the pattern tables, and a nametable from CHR ROM, are not drawn.
 */
class Namco163 extends Base {
  readonly name = 'Namco 163';
  private readonly prgRegs = [0, 0, 0];
  private readonly chrRegs = new Array<number>(8).fill(0);
  private readonly ntRegs = [0xe0, 0xe0, 0xe1, 0xe1];
  private counter = 0;
  private readonly soundRam = new Uint8Array(0x80);
  private soundAddress = 0;
  irq = false;
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    return slot === 3 ? this.count8 - 1 : this.prgRegs[slot] & 0x3f;
  }
  chrAt(address: number) {
    return this.chrRegs[address >> 10] * 0x400 + (address & 0x3ff);
  }
  nametableAt(n: number) {
    return this.ntRegs[n] & 1;
  }
  isSound(address: number) {
    return (address >= 0x4800 && address < 0x5000) || address >= 0xf800;
  }
  /** A read of $4800 with auto-increment on steps the address; Mappy Kids' driver reads to skip registers. */
  soundRead(address: number) {
    if (address < 0x4800 || address >= 0x5000 || !(this.soundAddress & 0x80)) return undefined;
    return { address: 0xf800, value: this.soundAddress };
  }
  read(address: number) {
    if (address >= 0x6000) return super.read(address);
    switch (address & 0xf800) {
      case 0x4800: {
        const value = this.soundRam[this.soundAddress & 0x7f];
        if (this.soundAddress & 0x80) this.soundAddress = 0x80 | ((this.soundAddress + 1) & 0x7f);
        return value;
      }
      case 0x5000:
        return this.counter & 0xff;
      case 0x5800:
        return (this.counter >> 8) & 0xff;
    }
    return 0;
  }
  write(address: number, value: number) {
    if (address >= 0x6000) return super.write(address, value);
    switch (address & 0xf800) {
      case 0x4800:
        this.soundRam[this.soundAddress & 0x7f] = value;
        if (this.soundAddress & 0x80) this.soundAddress = 0x80 | ((this.soundAddress + 1) & 0x7f);
        return;
      case 0x5000:
        this.counter = (this.counter & 0xff00) | value;
        this.irq = false;
        return;
      case 0x5800:
        this.counter = (this.counter & 0x00ff) | (value << 8);
        this.irq = false;
        return;
    }
  }
  protected control(address: number, value: number) {
    if (address < 0xc000) this.chrRegs[(address - 0x8000) >> 11] = value;
    else if (address < 0xe000) this.ntRegs[(address - 0xc000) >> 11] = value;
    else if (address < 0xf800) this.prgRegs[(address - 0xe000) >> 11] = value;
    else this.soundAddress = value;
  }
  clock(cycles: number) {
    if (!(this.counter & 0x8000)) return; // bit 15 of the counter is the enable
    const count = Math.min((this.counter & 0x7fff) + cycles, 0x7fff);
    if (count === 0x7fff) this.irq = true;
    this.counter = 0x8000 | count;
  }
}

/**
 * Taito TC0690 (48): two 8 KB PRG banks, CHR in two 2 KB and four 1 KB banks, mirroring at $E000,
 * and a scanline IRQ counting up from the latch, firing as it wraps past $FF (as FCEUX has it).
 */
class Tc0690 extends Base {
  readonly name: string = 'TC0690';
  protected readonly prgRegs = [0, 1];
  protected readonly chrRegs = [0, 1, 4, 5, 6, 7];
  private latch = 0;
  private counter = 0;
  private enabled = false;
  irq = false;
  mirroring: Mirroring = 'vertical';
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    return slot < 2 ? this.prgRegs[slot] : this.count8 - 4 + slot;
  }
  protected set(banks: readonly number[]) {
    [this.prgRegs[0], this.prgRegs[1]] = [banks[0], banks[1]];
  }
  chrAt(address: number) {
    if (address < 0x1000) return this.chrRegs[address >> 11] * 0x800 + (address & 0x7ff);
    return this.chrRegs[2 + ((address - 0x1000) >> 10)] * 0x400 + (address & 0x3ff);
  }
  protected control(address: number, value: number) {
    const reg = address & 0xe003;
    if (reg === 0x8000 || reg === 0x8001) this.prgRegs[reg & 1] = value & 0x3f;
    else if (reg === 0x8002 || reg === 0x8003) this.chrRegs[reg & 1] = value;
    else if (reg >= 0xa000 && reg <= 0xa003) this.chrRegs[2 + (reg & 3)] = value;
    else if (reg === 0xc000) this.latch = value;
    else if (reg === 0xc001) this.counter = this.latch;
    else if (reg === 0xc002) this.enabled = true;
    else if (reg === 0xc003) {
      this.enabled = false;
      this.irq = false;
    } else if (reg === 0xe000) this.mirroring = value & 0x40 ? 'horizontal' : 'vertical';
  }
  scanline() {
    if (!this.enabled) return;
    this.counter = (this.counter + 1) & 0xff;
    if (this.counter === 0) {
      this.irq = true;
      this.enabled = false;
    }
  }
}

/**
 * Taito X1-005 (80): registers at $7EF0-$7EFF — CHR in two 2 KB and four 1 KB banks, mirroring,
 * three 8 KB PRG banks; the last 8 KB fixed. Its 128 bytes of RAM are at $7F00.
 */
class X1005 extends Base {
  readonly name: string = 'X1-005';
  protected readonly prgRegs = [0, 1, 2];
  protected readonly chrRegs = [0, 2, 4, 5, 6, 7];
  mirroring: Mirroring = 'horizontal';
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    return slot === 3 ? this.count8 - 1 : this.prgRegs[slot];
  }
  chrAt(address: number) {
    if (address < 0x1000) return ((this.chrRegs[address >> 11] & 0xfe) + ((address >> 10) & 1)) * 0x400 + (address & 0x3ff);
    return this.chrRegs[2 + ((address - 0x1000) >> 10)] * 0x400 + (address & 0x3ff);
  }
  write(address: number, value: number) {
    if (address >= 0x7ef0 && address <= 0x7eff) this.register(address & 0x0f, value);
    else super.write(address, value);
  }
  protected register(r: number, value: number) {
    if (r <= 5) this.chrRegs[r] = value;
    else if (r <= 7) this.mirroring = value & 1 ? 'vertical' : 'horizontal';
    else if (r >= 0x0a) this.prgRegs[(r - 0x0a) >> 1] = value;
  }
}

/**
 * Taito X1-017 (82): the X1-005's registers, with the CHR halves swappable ($7EF6 bit 1) and the
 * PRG bank numbers written shifted left by two.
 */
class X1017 extends X1005 {
  readonly name = 'X1-017';
  private invert = false;
  chrAt(address: number) {
    return super.chrAt(this.invert ? address ^ 0x1000 : address);
  }
  protected register(r: number, value: number) {
    if (r <= 5) this.chrRegs[r] = value;
    else if (r === 6) {
      this.mirroring = value & 1 ? 'vertical' : 'horizontal';
      this.invert = (value & 2) !== 0;
    } else if (r >= 0x0a && r <= 0x0c) this.prgRegs[r - 0x0a] = value >> 2;
  }
}

/** Mapper 152: one register — 16 KB PRG at $8000, 8 KB CHR, single-screen page; last 16 KB fixed. */
class Mapper152 extends Base {
  readonly name = 'mapper 152';
  private reg = 0;
  get mirroring(): Mirroring {
    return this.reg & 0x80 ? 'single1' : 'single0';
  }
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    return slot < 2 ? ((this.reg >> 4) & 7) * 2 + slot : this.count8 - 4 + slot;
  }
  chrAt(address: number) {
    return (this.reg & 0x0f) * 0x2000 + address;
  }
  protected control(address: number, value: number) {
    this.reg = value & this.read(address); // bus conflict
  }
}

/** Mapper 246 (G0151-1, Fengshenbang): four 8 KB PRG banks and four 2 KB CHR banks at $6000-$6007. */
class Mapper246 extends Base {
  readonly name = 'mapper 246';
  private readonly prgRegs = [0, 1, 2, 0xff];
  private readonly chrRegs = [0, 1, 2, 3];
  bankAt(address: number) {
    return this.prgRegs[(address - 0x8000) >> 13] % this.count8;
  }
  chrAt(address: number) {
    return this.chrRegs[address >> 11] * 0x800 + (address & 0x7ff);
  }
  write(address: number, value: number) {
    if (address >= 0x6000 && address <= 0x6003) this.prgRegs[address - 0x6000] = value;
    else if (address >= 0x6004 && address <= 0x6007) this.chrRegs[address - 0x6004] = value;
    else super.write(address, value);
  }
}

/**
 * MMC2 (9) and MMC4 (10): CHR in two 4 KB halves, each with two banks, picked by a latch the PPU
 * flips as it fetches tile $FD or $FE — on the MMC2 the left half only at $0FD8/$0FE8 exactly.
 * The MMC2 switches 8 KB of PRG at $8000 (the last 24 KB fixed), the MMC4 16 KB (the last fixed).
 */
class Mmc2 extends Base {
  readonly name: string;
  private readonly mmc4: boolean;
  private bank = 0;
  /** $0000 at $FD, $0000 at $FE, $1000 at $FD, $1000 at $FE. */
  private readonly chrRegs = [0, 0, 0, 0];
  private readonly latch = [1, 1];
  mirroring?: Mirroring;
  constructor(prg: Uint8Array, mmc4: boolean) {
    super(prg);
    this.mmc4 = mmc4;
    this.name = mmc4 ? 'MMC4' : 'MMC2';
  }
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    if (this.mmc4) return address < 0xc000 ? this.bank * 2 + slot : this.count8 - 4 + slot;
    return slot === 0 ? this.bank : this.count8 - 4 + slot;
  }
  chrAt(address: number) {
    const half = address >> 12;
    return this.chrRegs[half * 2 + this.latch[half]] * 0x1000 + (address & 0xfff);
  }
  fetched(address: number) {
    const tile = address & 0x0ff8;
    const exact = !this.mmc4 && address < 0x1000;
    if (exact ? address === 0x0fd8 : tile === 0x0fd8) this.latch[address >> 12] = 0;
    else if (exact ? address === 0x0fe8 : tile === 0x0fe8) this.latch[address >> 12] = 1;
  }
  protected control(address: number, value: number) {
    const reg = address & 0xf000;
    if (reg === 0xa000) this.bank = value & 0x0f;
    else if (reg >= 0xb000 && reg <= 0xe000) this.chrRegs[(reg - 0xb000) >> 12] = value & 0x1f;
    else if (reg === 0xf000) this.mirroring = value & 1 ? 'horizontal' : 'vertical';
  }
  protected set(banks: readonly number[]) {
    this.bank = this.mmc4 ? banks[0] >> 1 : banks[0];
  }
}

/**
 * Bandai FCG (16): eight 1 KB CHR banks, 16 KB of PRG at $8000 (the last fixed), mirroring, and
 * an IRQ counter of CPU cycles counting down — its registers at $6000 on the FCG-1/2, at $8000 on
 * the LZ93D50, the low four address bits picking one; both are taken. The LZ93D50 loads the
 * counter from a latch when the IRQ is switched, the FCG writes the counter itself: the value is
 * put in both. The serial EEPROM of some boards is not there.
 */
class BandaiFcg extends Base {
  readonly name: string = 'Bandai FCG';
  private readonly chrRegs = new Array<number>(8).fill(0);
  private bank = 0;
  protected latch = 0;
  private counter = 0;
  private enabled = false;
  irq = false;
  mirroring?: Mirroring;
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    return slot < 2 ? this.bank * 2 + slot : this.count8 - 4 + slot;
  }
  chrAt(address: number) {
    return this.chrRegs[address >> 10] * 0x400 + (address & 0x3ff);
  }
  write(address: number, value: number) {
    if (address >= 0x6000) this.register(address & 0x0f, value);
  }
  protected register(r: number, value: number) {
    if (r < 8) this.chrRegs[r] = value;
    else if (r === 8) this.bank = value & 0x0f;
    else if (r === 9) this.mirroring = (['vertical', 'horizontal', 'single0', 'single1'] as const)[value & 3];
    else if (r === 0x0a) {
      this.enabled = (value & 1) !== 0;
      this.counter = this.latch;
      this.irq = false;
    } else if (r === 0x0b) this.counter = this.latch = (this.latch & 0xff00) | value;
    else if (r === 0x0c) this.counter = this.latch = (this.latch & 0x00ff) | (value << 8);
  }
  clock(cycles: number) {
    if (!this.enabled) return;
    this.counter -= cycles;
    if (this.counter <= 0) {
      this.irq = true;
      this.enabled = false;
      this.counter = 0xffff;
    }
  }
  protected set(banks: readonly number[]) {
    this.bank = banks[0] >> 1;
  }
}

/**
 * Bandai Datach (157): the FCG's PRG banking, mirroring and IRQ, its registers at $8000-$FFFF
 * only; 8 KB of CHR RAM, so the CHR registers switch nothing. `$800D` drives the base unit's 24C02
 * EEPROM (bit 5 the clock, bit 6 the data) and a read of $6000-$7FFF gives its data line in bit 4,
 * as FCEUX has it. Not here: the barcode reader (bit 3 reads 0, no card swiped) and the 24C01 of
 * the Battle Rush mini-cart, clocked by bit 3 of register 0.
 */
class Datach extends BandaiFcg {
  readonly name = 'Bandai Datach';
  readonly eeprom = new Eeprom24c02();
  read(address: number) {
    // The bits nothing drives keep what the bus held: the high byte of the address just read.
    if (address >= 0x6000 && address < 0x8000) return ((address >> 8) & 0xe7) | (this.eeprom.out << 4);
    return super.read(address);
  }
  write(address: number, value: number) {
    if (address >= 0x8000) this.register(address & 0x0f, value);
  }
  protected register(r: number, value: number) {
    if (r === 0x0d) this.eeprom.write((value >> 5) & 1, (value >> 6) & 1);
    // The latch alone: the counter takes it when `$800A` switches the IRQ (FCEUX's BarcodeWrite).
    else if (r === 0x0b) this.latch = (this.latch & 0xff00) | value;
    else if (r === 0x0c) this.latch = (this.latch & 0x00ff) | (value << 8);
    else if (r >= 8) super.register(r, value);
  }
}

/**
 * A 24C02: 256 bytes of serial EEPROM on two wires. The game is the bus master — it sets the clock
 * (SCL) and the data line (SDA) and reads the line back; the chip watches for START (SDA falling
 * while SCL is high) and STOP (SDA rising), takes a byte on eight rising clock edges and
 * acknowledges it by pulling SDA low through the ninth: its device address (1010xxx and the
 * read/write bit), then a word address, then the bytes written; on a read it drives the bytes out
 * from the word address on, as long as the master acknowledges them. Blank, it reads 0 (FCEUX's
 * empty save).
 */
export class Eeprom24c02 {
  readonly data = new Uint8Array(256);
  /** What the chip drives on SDA: 0 for an acknowledge or a 0 bit, 1 (pulled up) otherwise. */
  out = 1;
  private scl = 0;
  private sda = 1;
  private state: 'idle' | 'device' | 'word' | 'write' | 'read' = 'idle';
  private bits = 0;
  private shift = 0;
  private word = 0;
  private reading = false;
  private nack = false;
  write(scl: number, sda: number) {
    if (this.scl && scl && sda !== this.sda) {
      if (!sda) [this.state, this.bits, this.shift] = ['device', 0, 0]; // START, or a repeated START
      else this.state = 'idle'; // STOP
      this.out = 1;
    } else if (!this.scl && scl) this.rise(sda);
    else if (this.scl && !scl) this.fall();
    this.scl = scl;
    this.sda = sda;
  }
  /** A rising clock edge: the master's bit is sampled — or, on the ninth, its acknowledge of a byte read. */
  private rise(sda: number) {
    if (this.state === 'idle') return;
    if (this.bits < 8) {
      if (this.state !== 'read') this.shift = ((this.shift << 1) | sda) & 0xff;
    } else if (this.state === 'read') this.nack = sda === 1;
    this.bits++;
  }
  /** A falling clock edge: the chip sets SDA for the next clock. */
  private fall() {
    if (this.state === 'idle') return;
    if (this.bits === 8) {
      // A byte in: acknowledge it. A byte out: let go of the line for the master's acknowledge.
      if (this.state === 'device') {
        if ((this.shift & 0xf0) !== 0xa0) {
          this.state = 'idle';
          return;
        }
        this.reading = (this.shift & 1) === 1;
      } else if (this.state === 'word') this.word = this.shift;
      else if (this.state === 'write') {
        this.data[this.word] = this.shift;
        this.word = (this.word + 1) & 0xff;
      }
      this.out = this.state === 'read' ? 1 : 0;
    } else if (this.bits === 9) {
      this.bits = 0;
      this.out = 1;
      if (this.state === 'device') this.state = this.reading ? 'read' : 'word';
      else if (this.state === 'word') this.state = 'write';
      else if (this.state === 'read' && this.nack) this.state = 'idle'; // the last byte wanted
      if (this.state === 'read') {
        this.shift = this.data[this.word];
        this.word = (this.word + 1) & 0xff;
        this.out = this.shift >> 7;
      }
    } else if (this.state === 'read') this.out = (this.shift >> (7 - this.bits)) & 1;
  }
}

/**
 * Konami VRC2 and VRC4: two 8 KB PRG banks (on the VRC4 the first may swap with the fixed second
 * last), eight 1 KB CHR banks written a nibble at a time, mirroring; the VRC4 an IRQ counter
 * clocked by scanline (every 341 PPU dots) or by CPU cycle. The iNES numbers differ in which
 * address lines reach the register select — 21: A1/A2 or A6/A7, 22 (VRC2a): A1/A0, 23: A0/A1 or
 * A2/A3, 25: A1/A0 or A3/A2 — and the VRC2a drops the low bit of a CHR bank.
 */
class Vrc4 extends Base {
  readonly name: string;
  private readonly line: (address: number) => number;
  private readonly vrc2: boolean;
  private readonly prgRegs = [0, 1];
  private swapped = false;
  private readonly chrRegs = new Array<number>(8).fill(0);
  private latch = 0;
  private counter = 0;
  private irqCtrl = 0;
  private prescaler = 341;
  irq = false;
  mirroring?: Mirroring;
  constructor(prg: Uint8Array, id: number) {
    super(prg);
    const bit = (address: number, a: number, b: number) => ((address >> a) | (address >> b)) & 1;
    this.line = {
      21: (a: number) => bit(a, 1, 6) | (bit(a, 2, 7) << 1),
      22: (a: number) => ((a >> 1) & 1) | ((a & 1) << 1),
      23: (a: number) => bit(a, 0, 2) | (bit(a, 1, 3) << 1),
      25: (a: number) => bit(a, 1, 3) | (bit(a, 0, 2) << 1),
    }[id]!;
    this.vrc2 = id === 22;
    this.name = this.vrc2 ? 'VRC2a' : 'VRC4';
  }
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    if (slot === 1) return this.prgRegs[1];
    if (slot === 3) return this.count8 - 1;
    return (slot === 0) !== this.swapped ? this.prgRegs[0] : this.count8 - 2;
  }
  chrAt(address: number) {
    const bank = this.chrRegs[address >> 10];
    return (this.vrc2 ? bank >> 1 : bank) * 0x400 + (address & 0x3ff);
  }
  protected control(address: number, value: number) {
    const page = address & 0xf000;
    const r = this.line(address);
    if (page === 0x8000) this.prgRegs[0] = value & 0x1f;
    else if (page === 0xa000) this.prgRegs[1] = value & 0x1f;
    else if (page === 0x9000) {
      if (this.vrc2) this.mirroring = value & 1 ? 'horizontal' : 'vertical';
      else if (r < 2) this.mirroring = (['vertical', 'horizontal', 'single0', 'single1'] as const)[value & 3];
      else this.swapped = (value & 2) !== 0;
    } else if (page >= 0xb000 && page <= 0xe000) {
      const i = ((page - 0xb000) >> 11) | (r >> 1);
      const old = this.chrRegs[i];
      this.chrRegs[i] = r & 1 ? (old & 0x0f) | ((value & 0x1f) << 4) : (old & 0x1f0) | (value & 0x0f);
    } else if (page === 0xf000 && !this.vrc2) {
      if (r === 0) this.latch = (this.latch & 0xf0) | (value & 0x0f);
      else if (r === 1) this.latch = (this.latch & 0x0f) | ((value & 0x0f) << 4);
      else if (r === 2) {
        this.irqCtrl = value & 7;
        this.irq = false;
        if (value & 2) {
          this.counter = this.latch;
          this.prescaler = 341;
        }
      } else {
        this.irq = false;
        this.irqCtrl = (this.irqCtrl & ~2) | ((this.irqCtrl & 1) << 1); // enabled again as bit 0 asked
      }
    }
  }
  clock(cycles: number) {
    if (!(this.irqCtrl & 2)) return;
    for (let i = 0; i < cycles; i++) {
      if (!(this.irqCtrl & 4)) {
        this.prescaler -= 3;
        if (this.prescaler > 0) continue;
        this.prescaler += 341;
      }
      if (this.counter === 0xff) {
        this.counter = this.latch;
        this.irq = true;
      } else this.counter++;
    }
  }
  protected set(banks: readonly number[]) {
    this.swapped = banks[0] === this.count8 - 2 && banks[2] !== this.count8 - 2;
    this.prgRegs[0] = this.swapped ? banks[2] : banks[0];
    this.prgRegs[1] = banks[1];
  }
}

/** Taito TC0190 (33): the TC0690's banks without its IRQ, the mirroring in bit 6 of $8000. */
class Tc0190 extends Tc0690 {
  readonly name = 'TC0190';
  protected control(address: number, value: number) {
    if (address >= 0xc000) return;
    super.control(address, value);
    if ((address & 0xe003) === 0x8000) this.mirroring = value & 0x40 ? 'horizontal' : 'vertical';
  }
}

/** GxROM (66): one register, through a bus conflict — 32 KB of PRG in bits 4-5, 8 KB of CHR in bits 0-1. */
class Gxrom extends Base {
  readonly name = 'GxROM';
  private reg = 0;
  bankAt(address: number) {
    return ((this.reg >> 4) & 3) * 4 + ((address - 0x8000) >> 13);
  }
  chrAt(address: number) {
    return (this.reg & 3) * 0x2000 + address;
  }
  protected control(address: number, value: number) {
    this.reg = value & this.read(address);
  }
  protected set(banks: readonly number[]) {
    this.reg = (banks[0] >> 2) << 4;
  }
}

/**
 * Tengen RAMBO-1 (64): an MMC3's bank select and data — three 8 KB PRG registers (R6, R7 and RF
 * at $8000/$A000/$C000; bit 6 of the select puts RF first, R6 and R7 after it), the last 8 KB
 * fixed; CHR in two 2 KB and four 1 KB banks, or with bit 5 the 2 KB ones split into 1 KB (R0/R8,
 * R1/R9), bit 7 swapping the halves; mirroring at $A000. Its IRQ counter counts scanlines or,
 * with bit 0 of the `$C001` write, CPU cycles in fours, and fires as it passes below zero. The
 * counter as FCEUX keeps it: `$C001` loads it from the latch, and so do `$C000`/`$E000`/`$E001`
 * until a scanline has gone by or again once the IRQ has fired; it skips the pre-render line.
 * The registers answer only at $8000/$8001, $A000, $C000/$C001, $E000/$E001 (FCEUX's A & $F001).
 */
class Rambo1 extends Base {
  readonly name = 'RAMBO-1';
  private select = 0;
  /** R0-R9 and RF (15); power-on all $FF, as FCEUX sets them. */
  private readonly regs = new Array<number>(16).fill(0xff);
  private latch = 0;
  private counter = 0;
  private cpuMode = false;
  /** FCEUX's `rmode`: a register write reloads the counter. */
  private reloading = false;
  private enabled = false;
  private prescaler = 0;
  irq = false;
  mirroring?: Mirroring;
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    if (slot === 3) return this.count8 - 1;
    const order = this.select & 0x40 ? [15, 6, 7] : [6, 7, 15];
    return this.regs[order[slot]];
  }
  chrAt(address: number) {
    const a = this.select & 0x80 ? address ^ 0x1000 : address;
    let bank: number;
    if (a >= 0x1000) bank = this.regs[2 + ((a - 0x1000) >> 10)];
    else if (this.select & 0x20) bank = this.regs[[0, 8, 1, 9][a >> 10]];
    else bank = (this.regs[a >> 11] & 0xfe) | ((a >> 10) & 1);
    return bank * 0x400 + (a & 0x3ff);
  }
  protected control(address: number, value: number) {
    switch (address & 0xf001) {
      case 0x8000:
        this.select = value;
        return;
      case 0x8001: {
        const r = this.select & 0x0f;
        if (r < 10 || r === 15) this.regs[r] = value;
        return;
      }
      case 0xa000:
        this.mirroring = value & 1 ? 'horizontal' : 'vertical';
        return;
      case 0xc000:
        this.latch = value;
        break;
      case 0xc001:
        this.reloading = true;
        this.cpuMode = (value & 1) !== 0;
        break;
      case 0xe000:
        this.enabled = false;
        this.irq = false;
        break;
      case 0xe001:
        this.enabled = true;
        break;
      default:
        return;
    }
    if (this.reloading) this.counter = this.latch;
  }
  protected set(banks: readonly number[]) {
    this.select = 0;
    [this.regs[6], this.regs[7], this.regs[15]] = [banks[0], banks[1], banks[2]];
  }
  /** One count down; passing below zero raises the IRQ, if it is on. */
  private count() {
    this.counter = (this.counter - 1) & 0xff;
    if (this.counter !== 0xff || !this.enabled) return false;
    this.irq = true;
    return true;
  }
  scanline(line = 0) {
    if (this.cpuMode || line >= 240) return;
    this.reloading = false;
    if (this.count()) this.reloading = true;
  }
  clock(cycles: number) {
    if (!this.cpuMode) return;
    for (this.prescaler += cycles; this.prescaler >= 4; this.prescaler -= 4) this.count();
  }
}

/** Color Dreams (11): one register — 32 KB of PRG in bits 0-3, 8 KB of CHR in bits 4-7; FCEUX takes no bus conflict. */
class ColorDreams extends Base {
  readonly name = 'Color Dreams';
  private reg = 0;
  bankAt(address: number) {
    return (this.reg & 0x0f) * 4 + ((address - 0x8000) >> 13);
  }
  chrAt(address: number) {
    return (this.reg >> 4) * 0x2000 + address;
  }
  protected control(_address: number, value: number) {
    this.reg = value;
  }
  protected set(banks: readonly number[]) {
    this.reg = banks[0] >> 2;
  }
}

/**
 * NINA-03/06 (79, AVE and the Sachen 72-pin boards): one register at $4100-$5FFF, wherever A8 is
 * set — 32 KB of PRG in bit 3, 8 KB of CHR in bits 0-2.
 */
class Nina0306 extends Base {
  readonly name = 'NINA-03/06';
  private reg = 0;
  bankAt(address: number) {
    return ((this.reg >> 3) & 1) * 4 + ((address - 0x8000) >> 13);
  }
  chrAt(address: number) {
    return (this.reg & 7) * 0x2000 + address;
  }
  write(address: number, value: number) {
    if (address < 0x6000) {
      if (address & 0x100) this.reg = value;
    } else super.write(address, value);
  }
  protected set(banks: readonly number[]) {
    this.reg = (banks[0] >> 2) << 3;
  }
}

/**
 * Sunsoft-3 (67): four 2 KB CHR banks, 16 KB of PRG at $8000 (the last fixed), mirroring, and a
 * 16-bit IRQ counter of CPU cycles, written high byte then low, firing as it passes zero.
 */
class Sunsoft3 extends Base {
  readonly name = 'Sunsoft-3';
  private readonly chrRegs = [0, 0, 0, 0];
  private bank = 0;
  private counter = 0;
  private high = true;
  private enabled = false;
  irq = false;
  mirroring?: Mirroring;
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    return slot < 2 ? this.bank * 2 + slot : this.count8 - 4 + slot;
  }
  chrAt(address: number) {
    return this.chrRegs[address >> 11] * 0x800 + (address & 0x7ff);
  }
  protected control(address: number, value: number) {
    const reg = address & 0xf800;
    if (reg === 0x8800 || reg === 0x9800 || reg === 0xa800 || reg === 0xb800) this.chrRegs[(reg - 0x8800) >> 12] = value;
    else if (reg === 0xc800) {
      this.counter = this.high ? (this.counter & 0x00ff) | (value << 8) : (this.counter & 0xff00) | value;
      this.high = !this.high;
    } else if (reg === 0xd800) {
      this.enabled = (value & 0x10) !== 0;
      this.high = true;
      this.irq = false;
    } else if (reg === 0xe800) this.mirroring = (['vertical', 'horizontal', 'single0', 'single1'] as const)[value & 3];
    else if (reg === 0xf800) this.bank = value & 0x0f;
  }
  clock(cycles: number) {
    if (!this.enabled) return;
    this.counter -= cycles;
    if (this.counter < 0) {
      this.counter &= 0xffff;
      this.irq = true;
      this.enabled = false;
    }
  }
  protected set(banks: readonly number[]) {
    this.bank = banks[0] >> 1;
  }
}

/**
 * Sunsoft-4 (68): four 2 KB CHR banks, 16 KB of PRG at $8000 (the last fixed), mirroring. Its
 * nametables taken from CHR ROM ($E000 bit 4, the $C000/$D000 banks) are not drawn.
 */
class Sunsoft4 extends Base {
  readonly name = 'Sunsoft-4';
  private readonly chrRegs = [0, 0, 0, 0];
  private bank = 0;
  private ctrl = -1;
  get mirroring(): Mirroring | undefined {
    return this.ctrl < 0 ? undefined : (['vertical', 'horizontal', 'single0', 'single1'] as const)[this.ctrl & 3];
  }
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    return slot < 2 ? this.bank * 2 + slot : this.count8 - 4 + slot;
  }
  chrAt(address: number) {
    return this.chrRegs[address >> 11] * 0x800 + (address & 0x7ff);
  }
  protected control(address: number, value: number) {
    const reg = address & 0xf000;
    if (reg <= 0xb000) this.chrRegs[(reg - 0x8000) >> 12] = value;
    else if (reg === 0xe000) this.ctrl = value;
    else if (reg === 0xf000) this.bank = value & 0x0f;
  }
  protected set(banks: readonly number[]) {
    this.bank = banks[0] >> 1;
  }
}

/**
 * Sunsoft FME-7 (69): a command register at $8000 and its parameter at $A000 — eight 1 KB CHR
 * banks, an 8 KB bank at $6000 (ROM, or the RAM when bits 6-7 say so), three 8 KB PRG banks (the
 * last fixed), mirroring, and a 16-bit IRQ counter of CPU cycles that fires as it wraps past zero.
 * The 5B's sound ports ($C000/$E000) are not kept.
 */
class Fme7 extends Base {
  readonly name = 'FME-7';
  private command = 0;
  private readonly chrRegs = new Array<number>(8).fill(0);
  /** $6000, $8000, $A000, $C000. */
  private readonly prgRegs = [0, 0, 1, 2];
  private irqCtrl = 0;
  private counter = 0;
  irq = false;
  mirroring?: Mirroring;
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    return slot === 3 ? this.count8 - 1 : this.prgRegs[slot + 1] & 0x3f;
  }
  chrAt(address: number) {
    return this.chrRegs[address >> 10] * 0x400 + (address & 0x3ff);
  }
  read(address: number) {
    if (address < 0x6000 || address >= 0x8000) return super.read(address);
    const r = this.prgRegs[0];
    if (!(r & 0x40)) return this.prg[((r & 0x3f) % this.count8) * 0x2000 + (address & 0x1fff)];
    return r & 0x80 ? this.ram[address - 0x6000] : 0;
  }
  write(address: number, value: number) {
    if (address >= 0x6000 && address < 0x8000) {
      if ((this.prgRegs[0] & 0xc0) === 0xc0) this.ram[address - 0x6000] = value;
    } else super.write(address, value);
  }
  protected control(address: number, value: number) {
    const reg = address & 0xe000;
    if (reg === 0x8000) {
      this.command = value & 0x0f;
      return;
    }
    if (reg !== 0xa000) return;
    const c = this.command;
    if (c < 8) this.chrRegs[c] = value;
    else if (c < 0x0c) this.prgRegs[c - 8] = value;
    else if (c === 0x0c) this.mirroring = (['vertical', 'horizontal', 'single0', 'single1'] as const)[value & 3];
    else if (c === 0x0d) {
      this.irqCtrl = value;
      this.irq = false;
    } else if (c === 0x0e) this.counter = (this.counter & 0xff00) | value;
    else this.counter = (this.counter & 0x00ff) | (value << 8);
  }
  clock(cycles: number) {
    if (!(this.irqCtrl & 0x80)) return;
    const left = this.counter - cycles;
    if (left < 0 && this.irqCtrl & 1) this.irq = true;
    this.counter = left & 0xffff;
  }
  protected set(banks: readonly number[]) {
    [this.prgRegs[1], this.prgRegs[2], this.prgRegs[3]] = [banks[0], banks[1], banks[2]];
  }
}

/**
 * Camerica BF9093/BF9097 (71): 16 KB of PRG at $8000 written at $C000-$FFFF, the last fixed; Fire
 * Hawk's board takes a single-screen page from bit 4 of a write at $9000-$9FFF.
 */
class Camerica extends Base {
  readonly name = 'Camerica';
  private bank = 0;
  mirroring?: Mirroring;
  bankAt(address: number) {
    return (address < 0xc000 ? this.bank * 2 : this.count8 - 2) + ((address >> 13) & 1);
  }
  protected control(address: number, value: number) {
    if (address >= 0xc000) this.bank = value & 0x0f;
    else if ((address & 0xf000) === 0x9000) this.mirroring = value & 0x10 ? 'single1' : 'single0';
  }
  protected set(banks: readonly number[]) {
    this.bank = banks[0] >> 1;
  }
}

/**
 * TQROM (119): an MMC3 with 8 KB of CHR RAM beside its CHR ROM — a CHR register with bit 6 set
 * picks a 1 KB bank of the RAM.
 */
class Tqrom extends Mmc3 {
  readonly name = 'TQROM';
  chrAt(address: number) {
    return (this.chrBank(address) & 0x3f) * 0x400 + (address & 0x3ff);
  }
  chrRamAt(address: number) {
    const bank = this.chrBank(address);
    return bank & 0x40 ? (bank & 7) * 0x400 + (address & 0x3ff) : -1;
  }
}

/**
 * Namco 108 (206), the MMC3's ancestor: only its bank select and data — two 2 KB and four 1 KB CHR
 * banks, two 8 KB PRG banks at $8000/$A000 (the last 16 KB fixed); no modes, mirroring wired on
 * the board, no IRQ.
 */
class Namco108 extends Mmc3 {
  readonly name = 'Namco 108';
  protected control(address: number, value: number) {
    if (address >= 0xa000) return;
    if ((address & 1) === 0) this.select = value & 7;
    else this.regs[this.select] = value & 0x3f;
  }
}

/**
 * Namco 175 and 340 (210): the Namco 163's banking without its sound, IRQ and nametable
 * registers — eight 1 KB CHR banks at $8000-$BFFF, three 8 KB PRG banks at $E000/$E800/$F000 (the
 * last fixed). The 340's mirroring (bits 6-7 at $E000) is not taken: an iNES header does not say
 * which of the two boards it is, and the 175 wires it.
 */
class Namco175 extends Base {
  readonly name = 'Namco 175/340';
  private readonly prgRegs = [0, 1, 2];
  private readonly chrRegs = new Array<number>(8).fill(0);
  bankAt(address: number) {
    const slot = (address - 0x8000) >> 13;
    return slot === 3 ? this.count8 - 1 : this.prgRegs[slot] & 0x3f;
  }
  chrAt(address: number) {
    return this.chrRegs[address >> 10] * 0x400 + (address & 0x3ff);
  }
  protected control(address: number, value: number) {
    if (address < 0xc000) this.chrRegs[(address - 0x8000) >> 11] = value;
    else if (address >= 0xe000 && address < 0xf800) this.prgRegs[(address - 0xe000) >> 11] = value;
  }
  protected set(banks: readonly number[]) {
    [this.prgRegs[0], this.prgRegs[1], this.prgRegs[2]] = [banks[0], banks[1], banks[2]];
  }
}

/**
 * Camerica BF9096 (232, the Quattro multicarts): a 64 KB block written at $8000-$BFFF (bits 3-4),
 * the 16 KB page at $8000 within it at $C000-$FFFF (bits 0-1); $C000 is the block's last page.
 */
class Quattro extends Base {
  readonly name = 'Camerica Quattro';
  private block = 0;
  private page = 0;
  bankAt(address: number) {
    const page = address < 0xc000 ? this.page : 3;
    return (this.block * 4 + page) * 2 + ((address >> 13) & 1);
  }
  protected control(address: number, value: number) {
    if (address < 0xc000) this.block = (value >> 3) & 3;
    else this.page = value & 3;
  }
  protected set(banks: readonly number[]) {
    this.block = banks[0] >> 3;
    this.page = (banks[0] >> 1) & 3;
  }
}

/** Mapper 240: one register at $4020-$5FFF — 32 KB of PRG in bits 4-7, 8 KB of CHR in bits 0-3. */
class Mapper240 extends Base {
  readonly name = 'mapper 240';
  private reg = 0;
  bankAt(address: number) {
    return (this.reg >> 4) * 4 + ((address - 0x8000) >> 13);
  }
  chrAt(address: number) {
    return (this.reg & 0x0f) * 0x2000 + address;
  }
  write(address: number, value: number) {
    if (address < 0x6000) this.reg = value;
    else super.write(address, value);
  }
  protected set(banks: readonly number[]) {
    this.reg = (banks[0] >> 2) << 4;
  }
}

/**
 * Mapper 250 (Nitra): an MMC3 whose registers are written through the address — A10 is the
 * register's A0, and the value is the address's low byte.
 */
class Mapper250 extends Mmc3 {
  readonly name = 'mapper 250';
  protected control(address: number, _value: number) {
    super.control((address & 0xe000) | ((address >> 10) & 1), address & 0xff);
  }
}
