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
import { createMapper } from './mappers.ts';
export const CPU_HZ = 1789772.7272727273;
export const FRAME_CYCLES = 29780.5;
const LINE_CYCLES = 341 / 3;
/** Read an iNES / NES 2.0 file's header and PRG. */
export function parseRom(file) {
    if (file[0] !== 0x4e || file[1] !== 0x45 || file[2] !== 0x53 || file[3] !== 0x1a)
        throw new Error('not an iNES file');
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
/** Controller buttons, as the bits the game reads in order. */
export const BUTTON = { A: 1, B: 2, select: 4, start: 8, up: 16, down: 32, left: 64, right: 128 };
export class Nes {
    constructor(cart) {
        this.writes = [];
        this.frame = 0;
        /** Buttons held down — set before a frame runs. */
        this.buttons = 0;
        /** The picture's side, when one is kept — see `ppu.ts`. */
        this.ppu = null;
        /** The scanline being run, 0–261. */
        this.line = 0;
        this.ram = new Uint8Array(0x800);
        this.ppuCtrl = 0;
        this.ppuMask = 0;
        this.vblank = false;
        /** The CPU cycle this frame's vblank flag goes up, until it has; Infinity once it has. */
        this.vblankAt = Infinity;
        /** The CPU cycle the NMI line went low, until the NMI is taken. */
        this.nmiAt = Infinity;
        this.sprite0 = false;
        this.pad = 0;
        this.strobe = 0;
        this.mapper = createMapper(cart.mapper, cart.prg, cart.chr.length);
        this.cpu = new Cpu6502({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
        this.cpu.reset();
    }
    read(a) {
        if (a < 0x2000)
            return this.ram[a & 0x7ff];
        if (a < 0x4000) {
            if ((a & 7) === 2) {
                this.readStatus();
                const v = (this.vblank ? 0x80 : 0) | (this.sprite0 ? 0x40 : 0);
                this.vblank = false;
                this.ppu?.read(2);
                return v;
            }
            return this.ppu?.read(a & 7) ?? 0;
        }
        if (a === 0x4016) {
            const bit = this.strobe ? this.buttons & 1 : this.pad & 1;
            if (!this.strobe)
                this.pad = (this.pad >> 1) | 0x80;
            return 0x40 | bit;
        }
        if (a === 0x4017)
            return 0x40;
        if (a >= 0x4020)
            return this.mapper.read(a);
        return 0;
    }
    write(a, v) {
        if (a < 0x2000)
            this.ram[a & 0x7ff] = v;
        else if (a < 0x4000) {
            const r = a & 7;
            if (r === 0) {
                // Turning the NMI on while the vblank flag is up pulls the line at once.
                if (v & 0x80 && !(this.ppuCtrl & 0x80) && this.vblank)
                    this.nmiAt = this.cpu.cycles;
                this.ppuCtrl = v;
            }
            else if (r === 1)
                this.ppuMask = v;
            this.ppu?.write(r, v, this.line);
        }
        else if (a === 0x4014) {
            this.cpu.cycles += 513;
            if (this.ppu && v < 0x20)
                this.ppu.dma(this.ram.subarray((v & 7) << 8, ((v & 7) << 8) + 256));
        }
        else if (a === 0x4016) {
            this.strobe = v & 1;
            if (this.strobe)
                this.pad = this.buttons;
        }
        else if (a <= 0x4017)
            this.writes.push({ cycle: this.cpu.cycles, address: a, value: v });
        else if (a >= 0x4020)
            this.mapper.write(a, v);
    }
    /**
     * The vblank flag goes up on a cycle of its own, not between instructions — a game polling
     * $2002 can see it before the NMI the same edge pulls, as on the console. Taken here when the
     * CPU reaches it; an NMI is taken before an instruction only once the line has been low for a
     * cycle, so an instruction that ends right on the edge still has one more run first.
     */
    vblankEdge(now) {
        if (now < this.vblankAt)
            return;
        this.vblank = true;
        if (this.ppuCtrl & 0x80)
            this.nmiAt = this.vblankAt;
        this.vblankAt = Infinity;
    }
    /**
     * A read of $2002 as the flag goes up (on the 4th cycle of the LDA/BIT that reads it): a PPU
     * clock early it reads clear and the flag and NMI of this frame never come; on the clock or
     * one after, it reads set and the NMI is suppressed — the race FCEUX and the console have.
     */
    readStatus() {
        const at = this.cpu.cycles + 3;
        const early = this.vblankAt - at;
        if (early > 0 && early <= 1 / 3) {
            this.vblankAt = Infinity;
            return;
        }
        if (this.vblankAt <= at) {
            const late = at - this.vblankAt;
            this.vblankEdge(at);
            if (late < 2 / 3)
                this.nmiAt = Infinity;
        }
    }
    runTo(target, onStep) {
        const cpu = this.cpu;
        while (cpu.cycles < target && !cpu.jammed) {
            this.vblankEdge(cpu.cycles);
            if (cpu.cycles >= this.nmiAt + 1) {
                this.nmiAt = Infinity;
                cpu.nmi();
            }
            else if (this.mapper.irq && !(cpu.p & 0x04))
                cpu.irq();
            const pc = cpu.pc;
            const before = cpu.cycles;
            cpu.step();
            this.mapper.clock?.(cpu.cycles - before);
            onStep?.(pc, cpu.pc);
        }
    }
    /** One frame: 262 scanlines, vblank and NMI at 241. */
    runFrame(onStep) {
        const start = this.frame * FRAME_CYCLES;
        const rendering = () => (this.ppuMask & 0x18) !== 0;
        const hit = this.ppu?.sprite0Line?.() ?? 30;
        for (let line = 0; line < 262; line++) {
            this.line = line;
            this.ppu?.scanline?.(line);
            if (line === 241) {
                this.beforeVblank?.();
                this.vblankAt = start + 241 * LINE_CYCLES + 1 / 3; // dot 1
            }
            if (line === 261) {
                this.vblank = false;
                this.vblankAt = Infinity;
                this.sprite0 = false;
            }
            if (line === hit && rendering())
                this.sprite0 = true;
            this.runTo(start + (line + 1) * LINE_CYCLES, onStep);
            if ((line < 240 || line === 261) && rendering())
                this.mapper.scanline?.();
        }
        this.frame++;
    }
}
