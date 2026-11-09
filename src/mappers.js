/**
 * Cartridge mappers — what the CPU sees: which PRG bank answers at each
 * address, PRG RAM, the scanline and CPU-cycle IRQs; and, for the picture
 * (`ppu.ts`), the CHR banks and the nametable mirroring a mapper switches.
 * Without them the PPU takes the first 8 KB of CHR and the mirroring wired on
 * the board.
 *
 * Together these cover most of the NES library: NROM (0), MMC1 (1), UxROM (2),
 * CNROM (3), MMC3 (4), AxROM (7) — and some Japanese boards: Jaleco SS88006
 * (18), Namco 163 (19, banking only — not its sound), Taito TC0690 (48), Taito
 * X1-005 (80) and X1-017 (82), TxSROM (118), mapper 152 and 246.
 */
/** `chrSize` is the CHR ROM's size in bytes — 0 for a board with CHR RAM. */
export function createMapper(id, prg, chrSize = 0) {
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
        case 18:
            return new Ss88006(prg);
        case 19:
            return new Namco163(prg);
        case 48:
            return new Tc0690(prg);
        case 80:
            return new X1005(prg);
        case 82:
            return new X1017(prg);
        case 118:
            return new Txsrom(prg);
        case 152:
            return new Mapper152(prg);
        case 246:
            return new Mapper246(prg);
        default:
            throw new Error(`mapper ${id} is not supported yet`);
    }
}
/** Shared: PRG RAM and 8 KB bank addressing. */
class Base {
    constructor(prg) {
        this.ram = new Uint8Array(0x2000);
        this.prg = prg;
        this.count8 = prg.length / 0x2000;
    }
    read(address) {
        if (address < 0x6000)
            return 0; // nothing on the cartridge answers at $4020-$5FFF
        if (address < 0x8000)
            return this.ram[address - 0x6000];
        return this.prg[(this.bankAt(address) % this.count8) * 0x2000 + (address & 0x1fff)];
    }
    write(address, value) {
        if (address < 0x6000)
            return;
        if (address < 0x8000)
            this.ram[address - 0x6000] = value;
        else
            this.control(address, value);
    }
    control(_address, _value) { }
    restore(banks) {
        this.set(banks);
        return this.maps(banks);
    }
    /** Registers from the banks seen; `restore` then checks they map what was seen. */
    set(_banks) { }
    maps(banks) {
        return banks.every((bank, slot) => this.bankAt(0x8000 + slot * 0x2000) % this.count8 === bank);
    }
}
class Nrom extends Base {
    constructor(prg, name = 'NROM') {
        super(prg);
        this.name = name;
    }
    bankAt(address) {
        // 16 KB carts mirror: $C000 is $8000 again.
        return ((address - 0x8000) >> 13) % this.count8;
    }
}
/** NROM's PRG, and one 8 KB CHR bank picked by a write anywhere in $8000-$FFFF. */
class Cnrom extends Nrom {
    constructor(prg) {
        super(prg, 'CNROM');
        this.chr = 0;
    }
    chrAt(address) {
        return this.chr * 0x2000 + address;
    }
    control(address, value) {
        // Bus conflict: the ROM drives the same lines, so the bits it holds low stay low.
        this.chr = value & this.read(address);
    }
}
class Uxrom extends Base {
    constructor() {
        super(...arguments);
        this.name = 'UxROM';
        this.bank = 0;
    }
    bankAt(address) {
        const last16 = this.count8 / 2 - 1;
        const bank16 = address < 0xc000 ? this.bank : last16;
        return bank16 * 2 + ((address >> 13) & 1);
    }
    control(_address, value) {
        this.bank = value & 0x0f;
    }
    set(banks) {
        this.bank = banks[0] >> 1;
    }
}
class Axrom extends Base {
    constructor() {
        super(...arguments);
        this.name = 'AxROM';
        this.bank = 0;
        this.mirroring = 'single0';
    }
    bankAt(address) {
        return this.bank * 4 + ((address - 0x8000) >> 13);
    }
    control(_address, value) {
        this.bank = value & 0x07;
        this.mirroring = value & 0x10 ? 'single1' : 'single0';
    }
    set(banks) {
        this.bank = banks[0] >> 2;
    }
}
/**
 * MMC1: PRG in 32 KB or 16 KB with one half fixed, CHR in one 8 KB or two 4 KB banks, mirroring.
 * A 512 KB board (SUROM) takes PRG A18 from bit 4 of the CHR register, as its CHR is RAM.
 */
class Mmc1 extends Base {
    constructor(prg, chrSize) {
        super(prg);
        this.name = 'MMC1';
        this.shift = 0;
        this.bits = 0;
        this.ctrl = 0x0c;
        this.prgBank = 0;
        this.chr0 = 0;
        this.chr1 = 0;
        this.chrSize = chrSize;
    }
    get mirroring() {
        return ['single0', 'single1', 'vertical', 'horizontal'][this.ctrl & 3];
    }
    /** The 256 KB half of a 512 KB board, in 16 KB banks. */
    get outer() {
        return this.count8 > 32 && this.chrSize === 0 ? this.chr0 & 0x10 : 0;
    }
    bankAt(address) {
        const mode = (this.ctrl >> 2) & 3;
        const bank = this.prgBank & 0x0f;
        const last16 = Math.min(this.count8 / 2, 16) - 1;
        const upper = address >= 0xc000;
        let bank16;
        if (mode < 2)
            bank16 = (bank & ~1) + (upper ? 1 : 0); // 32 KB
        else if (mode === 2)
            bank16 = upper ? bank : 0; // first fixed at $8000
        else
            bank16 = upper ? last16 : bank; // last fixed at $C000
        return (this.outer + bank16) * 2 + ((address >> 13) & 1);
    }
    chrAt(address) {
        if (this.ctrl & 0x10)
            return (address < 0x1000 ? this.chr0 : this.chr1) * 0x1000 + (address & 0xfff);
        return (this.chr0 & 0x1e) * 0x1000 + address;
    }
    control(address, value) {
        if (value & 0x80) {
            this.shift = 0;
            this.bits = 0;
            this.ctrl |= 0x0c;
            return;
        }
        this.shift |= (value & 1) << this.bits;
        if (++this.bits < 5)
            return;
        const data = this.shift;
        this.shift = 0;
        this.bits = 0;
        const reg = (address >> 13) & 3;
        if (reg === 0)
            this.ctrl = data;
        else if (reg === 1)
            this.chr0 = data;
        else if (reg === 2)
            this.chr1 = data;
        else
            this.prgBank = data;
    }
    set(banks) {
        this.shift = 0;
        this.bits = 0;
        const last16 = Math.min(this.count8 / 2, 16) - 1;
        if (this.count8 > 32)
            this.chr0 = banks[0] >= 32 ? 0x10 : 0;
        const low = (banks[0] >> 1) & 0x0f;
        const high = (banks[2] >> 1) & 0x0f;
        // The last bank fixed at $C000, the first at $8000, or 32 KB in one.
        if (high === last16)
            [this.ctrl, this.prgBank] = [0x0c, low];
        else if (low === 0)
            [this.ctrl, this.prgBank] = [0x08, high];
        else
            [this.ctrl, this.prgBank] = [0x00, low];
    }
}
class Mmc3 extends Base {
    constructor() {
        super(...arguments);
        this.name = 'MMC3';
        this.select = 0;
        this.regs = [0, 2, 4, 5, 6, 7, 0, 1];
        this.latch = 0;
        this.counter = 0;
        this.reload = false;
        this.enabled = false;
        this.irq = false;
    }
    bankAt(address) {
        const slot = (address >> 13) & 3;
        const last = this.count8 - 1;
        const swapped = (this.select >> 6) & 1;
        if (slot === 1)
            return this.regs[7];
        if (slot === 3)
            return last;
        if (slot === 0)
            return swapped ? last - 1 : this.regs[6];
        return swapped ? this.regs[6] : last - 1;
    }
    /**
     * R0 and R1 are 2 KB at $0000 and $0800, R2-R5 1 KB from $1000 — the halves swapped when bit 7
     * of the bank select is set. A 2 KB register's low bit is ignored.
     */
    chrAt(address) {
        const a = this.select & 0x80 ? address ^ 0x1000 : address;
        const bank = a < 0x1000 ? (this.regs[a >> 11] & 0xfe) + ((a >> 10) & 1) : this.regs[2 + ((a - 0x1000) >> 10)];
        return bank * 0x400 + (a & 0x3ff);
    }
    set(banks) {
        // $C000 fixed to the second last bank, or swapped with $8000.
        const swapped = banks[2] !== this.count8 - 2;
        this.select = swapped ? 0x40 : 0;
        this.regs[6] = swapped ? banks[2] : banks[0];
        this.regs[7] = banks[1];
    }
    control(address, value) {
        const even = (address & 1) === 0;
        switch (address & 0xe000) {
            case 0x8000:
                if (even)
                    this.select = value;
                else
                    this.regs[this.select & 7] = value;
                return;
            case 0xa000:
                if (even)
                    this.mirroring = value & 1 ? 'horizontal' : 'vertical';
                return;
            case 0xc000:
                if (even)
                    this.latch = value;
                else {
                    this.counter = 0;
                    this.reload = true;
                }
                return;
            case 0xe000:
                if (even) {
                    this.enabled = false;
                    this.irq = false;
                }
                else
                    this.enabled = true;
                return;
        }
    }
    scanline() {
        if (this.counter === 0 || this.reload) {
            this.counter = this.latch;
            this.reload = false;
        }
        else
            this.counter--;
        if (this.counter === 0 && this.enabled)
            this.irq = true;
    }
}
/**
 * TxSROM (118): an MMC3 whose CHR registers' bit 7 also picks the CIRAM page of each nametable —
 * R0/R1 for the two halves, or R2-R5 one each when the CHR halves are swapped. $A000 does nothing.
 */
class Txsrom extends Mmc3 {
    constructor() {
        super(...arguments);
        this.name = 'TxSROM';
    }
    nametableAt(n) {
        return this.select & 0x80 ? this.regs[2 + n] >> 7 : this.regs[n >> 1] >> 7;
    }
    control(address, value) {
        if ((address & 0xe001) === 0xa000)
            return;
        super.control(address, value);
    }
}
/**
 * Jaleco SS88006 (18): three 8 KB PRG banks and eight 1 KB CHR banks, each register written a
 * nibble at a time; an IRQ counter that counts CPU cycles down, 4, 8, 12 or 16 bits wide.
 */
class Ss88006 extends Base {
    constructor() {
        super(...arguments);
        this.name = 'SS88006';
        this.prgRegs = [0, 0, 0];
        this.chrRegs = new Array(8).fill(0);
        this.reloadValue = 0;
        this.counter = 0;
        this.irqCtrl = 0;
        this.irq = false;
        this.mirroring = 'horizontal';
    }
    bankAt(address) {
        const slot = (address - 0x8000) >> 13;
        return slot === 3 ? this.count8 - 1 : this.prgRegs[slot];
    }
    chrAt(address) {
        return this.chrRegs[address >> 10] * 0x400 + (address & 0x3ff);
    }
    control(address, value) {
        const reg = address & 0xf003;
        const nibble = value & 0x0f;
        const put = (old, high) => (high ? (old & 0x0f) | (nibble << 4) : (old & 0xf0) | nibble);
        if (reg < 0x9002) {
            const i = ((reg >> 12) - 8) * 2 + ((reg >> 1) & 1); // $8000/1, $8002/3, $9000/1
            this.prgRegs[i] = put(this.prgRegs[i], (reg & 1) === 1);
        }
        else if (reg >= 0xa000 && reg < 0xe000) {
            const i = ((reg >> 12) - 0xa) * 2 + ((reg >> 1) & 1);
            this.chrRegs[i] = put(this.chrRegs[i], (reg & 1) === 1);
        }
        else if (reg >= 0xe000 && reg < 0xf000) {
            const shift = (reg & 3) * 4;
            this.reloadValue = (this.reloadValue & ~(0x0f << shift)) | (nibble << shift);
        }
        else if (reg === 0xf000) {
            this.counter = this.reloadValue;
            this.irq = false;
        }
        else if (reg === 0xf001) {
            this.irqCtrl = value;
            this.irq = false;
        }
        else if (reg === 0xf002) {
            this.mirroring = ['horizontal', 'vertical', 'single0', 'single1'][value & 3];
        }
    }
    clock(cycles) {
        if (!(this.irqCtrl & 1))
            return;
        const mask = this.irqCtrl & 8 ? 0xf : this.irqCtrl & 4 ? 0xff : this.irqCtrl & 2 ? 0xfff : 0xffff;
        const left = (this.counter & mask) - cycles;
        if (left < 0)
            this.irq = true;
        this.counter = (this.counter & ~mask) | (left & mask);
    }
}
/**
 * Namco 163 (19), its banking: three 8 KB PRG banks, eight 1 KB CHR banks, the four nametables
 * one by one, and a 15-bit IRQ counter that counts CPU cycles up to $7FFF. Of its sound only the
 * 128 bytes of RAM behind $4800 are kept, as a game may keep data there. A CHR register pointing
 * at CIRAM ($E0-$FF) for the pattern tables, and a nametable from CHR ROM, are not drawn.
 */
class Namco163 extends Base {
    constructor() {
        super(...arguments);
        this.name = 'Namco 163';
        this.prgRegs = [0, 0, 0];
        this.chrRegs = new Array(8).fill(0);
        this.ntRegs = [0xe0, 0xe0, 0xe1, 0xe1];
        this.counter = 0;
        this.soundRam = new Uint8Array(0x80);
        this.soundAddress = 0;
        this.irq = false;
    }
    bankAt(address) {
        const slot = (address - 0x8000) >> 13;
        return slot === 3 ? this.count8 - 1 : this.prgRegs[slot] & 0x3f;
    }
    chrAt(address) {
        return this.chrRegs[address >> 10] * 0x400 + (address & 0x3ff);
    }
    nametableAt(n) {
        return this.ntRegs[n] & 1;
    }
    read(address) {
        if (address >= 0x6000)
            return super.read(address);
        switch (address & 0xf800) {
            case 0x4800: {
                const value = this.soundRam[this.soundAddress & 0x7f];
                if (this.soundAddress & 0x80)
                    this.soundAddress = 0x80 | ((this.soundAddress + 1) & 0x7f);
                return value;
            }
            case 0x5000:
                return this.counter & 0xff;
            case 0x5800:
                return (this.counter >> 8) & 0xff;
        }
        return 0;
    }
    write(address, value) {
        if (address >= 0x6000)
            return super.write(address, value);
        switch (address & 0xf800) {
            case 0x4800:
                this.soundRam[this.soundAddress & 0x7f] = value;
                if (this.soundAddress & 0x80)
                    this.soundAddress = 0x80 | ((this.soundAddress + 1) & 0x7f);
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
    control(address, value) {
        if (address < 0xc000)
            this.chrRegs[(address - 0x8000) >> 11] = value;
        else if (address < 0xe000)
            this.ntRegs[(address - 0xc000) >> 11] = value;
        else if (address < 0xf800)
            this.prgRegs[(address - 0xe000) >> 11] = value;
        else
            this.soundAddress = value;
    }
    clock(cycles) {
        if (!(this.counter & 0x8000))
            return; // bit 15 of the counter is the enable
        const count = Math.min((this.counter & 0x7fff) + cycles, 0x7fff);
        if (count === 0x7fff)
            this.irq = true;
        this.counter = 0x8000 | count;
    }
}
/**
 * Taito TC0690 (48): two 8 KB PRG banks, CHR in two 2 KB and four 1 KB banks, mirroring at $E000,
 * and a scanline IRQ counting up from the latch, firing as it wraps past $FF (as FCEUX has it).
 */
class Tc0690 extends Base {
    constructor() {
        super(...arguments);
        this.name = 'TC0690';
        this.prgRegs = [0, 1];
        this.chrRegs = [0, 1, 4, 5, 6, 7];
        this.latch = 0;
        this.counter = 0;
        this.enabled = false;
        this.irq = false;
        this.mirroring = 'vertical';
    }
    bankAt(address) {
        const slot = (address - 0x8000) >> 13;
        return slot < 2 ? this.prgRegs[slot] : this.count8 - 4 + slot;
    }
    chrAt(address) {
        if (address < 0x1000)
            return this.chrRegs[address >> 11] * 0x800 + (address & 0x7ff);
        return this.chrRegs[2 + ((address - 0x1000) >> 10)] * 0x400 + (address & 0x3ff);
    }
    control(address, value) {
        const reg = address & 0xe003;
        if (reg === 0x8000 || reg === 0x8001)
            this.prgRegs[reg & 1] = value & 0x3f;
        else if (reg === 0x8002 || reg === 0x8003)
            this.chrRegs[reg & 1] = value;
        else if (reg >= 0xa000 && reg <= 0xa003)
            this.chrRegs[2 + (reg & 3)] = value;
        else if (reg === 0xc000)
            this.latch = value;
        else if (reg === 0xc001)
            this.counter = this.latch;
        else if (reg === 0xc002)
            this.enabled = true;
        else if (reg === 0xc003) {
            this.enabled = false;
            this.irq = false;
        }
        else if (reg === 0xe000)
            this.mirroring = value & 0x40 ? 'horizontal' : 'vertical';
    }
    scanline() {
        if (!this.enabled)
            return;
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
    constructor() {
        super(...arguments);
        this.name = 'X1-005';
        this.prgRegs = [0, 1, 2];
        this.chrRegs = [0, 2, 4, 5, 6, 7];
        this.mirroring = 'horizontal';
    }
    bankAt(address) {
        const slot = (address - 0x8000) >> 13;
        return slot === 3 ? this.count8 - 1 : this.prgRegs[slot];
    }
    chrAt(address) {
        if (address < 0x1000)
            return ((this.chrRegs[address >> 11] & 0xfe) + ((address >> 10) & 1)) * 0x400 + (address & 0x3ff);
        return this.chrRegs[2 + ((address - 0x1000) >> 10)] * 0x400 + (address & 0x3ff);
    }
    write(address, value) {
        if (address >= 0x7ef0 && address <= 0x7eff)
            this.register(address & 0x0f, value);
        else
            super.write(address, value);
    }
    register(r, value) {
        if (r <= 5)
            this.chrRegs[r] = value;
        else if (r <= 7)
            this.mirroring = value & 1 ? 'vertical' : 'horizontal';
        else if (r >= 0x0a)
            this.prgRegs[(r - 0x0a) >> 1] = value;
    }
}
/**
 * Taito X1-017 (82): the X1-005's registers, with the CHR halves swappable ($7EF6 bit 1) and the
 * PRG bank numbers written shifted left by two.
 */
class X1017 extends X1005 {
    constructor() {
        super(...arguments);
        this.name = 'X1-017';
        this.invert = false;
    }
    chrAt(address) {
        return super.chrAt(this.invert ? address ^ 0x1000 : address);
    }
    register(r, value) {
        if (r <= 5)
            this.chrRegs[r] = value;
        else if (r === 6) {
            this.mirroring = value & 1 ? 'vertical' : 'horizontal';
            this.invert = (value & 2) !== 0;
        }
        else if (r >= 0x0a && r <= 0x0c)
            this.prgRegs[r - 0x0a] = value >> 2;
    }
}
/** Mapper 152: one register — 16 KB PRG at $8000, 8 KB CHR, single-screen page; last 16 KB fixed. */
class Mapper152 extends Base {
    constructor() {
        super(...arguments);
        this.name = 'mapper 152';
        this.reg = 0;
    }
    get mirroring() {
        return this.reg & 0x80 ? 'single1' : 'single0';
    }
    bankAt(address) {
        const slot = (address - 0x8000) >> 13;
        return slot < 2 ? ((this.reg >> 4) & 7) * 2 + slot : this.count8 - 4 + slot;
    }
    chrAt(address) {
        return (this.reg & 0x0f) * 0x2000 + address;
    }
    control(address, value) {
        this.reg = value & this.read(address); // bus conflict
    }
}
/** Mapper 246 (G0151-1, Fengshenbang): four 8 KB PRG banks and four 2 KB CHR banks at $6000-$6007. */
class Mapper246 extends Base {
    constructor() {
        super(...arguments);
        this.name = 'mapper 246';
        this.prgRegs = [0, 1, 2, 0xff];
        this.chrRegs = [0, 1, 2, 3];
    }
    bankAt(address) {
        return this.prgRegs[(address - 0x8000) >> 13] % this.count8;
    }
    chrAt(address) {
        return this.chrRegs[address >> 11] * 0x800 + (address & 0x7ff);
    }
    write(address, value) {
        if (address >= 0x6000 && address <= 0x6003)
            this.prgRegs[address - 0x6000] = value;
        else if (address >= 0x6004 && address <= 0x6007)
            this.chrRegs[address - 0x6004] = value;
        else
            super.write(address, value);
    }
}
