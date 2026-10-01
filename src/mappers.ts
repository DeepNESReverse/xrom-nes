/**
 * Cartridge mappers — only what the CPU sees: which PRG bank answers at each
 * address, PRG RAM, and the MMC3's scanline IRQ. CHR and mirroring do not
 * matter here: nothing is drawn.
 *
 * Together these cover most of the NES library: NROM (0), MMC1 (1), UxROM (2),
 * CNROM (3), MMC3 (4), AxROM (7).
 */

export interface Mapper {
  readonly name: string;
  /** A CPU read at $6000-$FFFF. */
  read(address: number): number;
  /** A CPU write at $6000-$FFFF. */
  write(address: number, value: number): void;
  /** Index of the 8 KB PRG bank answering at `address` ($8000-$FFFF). */
  bankAt(address: number): number;
  /** Called once per visible scanline while rendering is on (the MMC3's IRQ clock). */
  scanline?(): void;
  /** An IRQ the cartridge is asserting. */
  irq?: boolean;
}

export function createMapper(id: number, prg: Uint8Array): Mapper {
  switch (id) {
    case 0:
      return new Nrom(prg);
    case 1:
      return new Mmc1(prg);
    case 2:
      return new Uxrom(prg);
    case 3:
      return new Nrom(prg, 'CNROM'); // CHR switching only
    case 4:
      return new Mmc3(prg);
    case 7:
      return new Axrom(prg);
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
    if (address < 0x8000) return this.ram[address - 0x6000];
    return this.prg[(this.bankAt(address) % this.count8) * 0x2000 + (address & 0x1fff)];
  }
  write(address: number, value: number): void {
    if (address < 0x8000) this.ram[address - 0x6000] = value;
    else this.control(address, value);
  }
  protected control(_address: number, _value: number): void {}
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
}

class Axrom extends Base {
  readonly name = 'AxROM';
  private bank = 0;
  bankAt(address: number) {
    return this.bank * 4 + ((address - 0x8000) >> 13);
  }
  protected control(_address: number, value: number) {
    this.bank = value & 0x07;
  }
}

class Mmc1 extends Base {
  readonly name = 'MMC1';
  private shift = 0;
  private bits = 0;
  private ctrl = 0x0c;
  private prgBank = 0;
  bankAt(address: number) {
    const mode = (this.ctrl >> 2) & 3;
    const bank = this.prgBank & 0x0f;
    const last16 = this.count8 / 2 - 1;
    const upper = address >= 0xc000;
    let bank16: number;
    if (mode < 2) bank16 = (bank & ~1) + (upper ? 1 : 0); // 32 KB
    else if (mode === 2) bank16 = upper ? bank : 0; // first fixed at $8000
    else bank16 = upper ? last16 : bank; // last fixed at $C000
    return bank16 * 2 + ((address >> 13) & 1);
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
    else if (reg === 3) this.prgBank = data;
    // 1 and 2 are CHR banks
  }
}

class Mmc3 extends Base {
  readonly name = 'MMC3';
  private select = 0;
  private readonly regs = [0, 2, 4, 5, 6, 7, 0, 1];
  private latch = 0;
  private counter = 0;
  private reload = false;
  private enabled = false;
  irq = false;
  bankAt(address: number) {
    const slot = (address >> 13) & 3;
    const last = this.count8 - 1;
    const swapped = (this.select >> 6) & 1;
    if (slot === 1) return this.regs[7];
    if (slot === 3) return last;
    if (slot === 0) return swapped ? last - 1 : this.regs[6];
    return swapped ? this.regs[6] : last - 1;
  }
  protected control(address: number, value: number) {
    const even = (address & 1) === 0;
    switch (address & 0xe000) {
      case 0x8000:
        if (even) this.select = value;
        else this.regs[this.select & 7] = value;
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
