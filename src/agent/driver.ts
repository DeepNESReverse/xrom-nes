/**
 * The driver, run away from the game: a dump the FCEUX probe took when a song started (the CPU's
 * RAM and $6000-$FFFF as the driver saw them) and this package's own 6502 calling into it.
 *
 * Calling the entry the agent found with one song number and the next, and comparing what the two
 * runs read, shows the driver's song tables: a read at base+X in one run is a read at base+X+1 in
 * the other. Drivers keep a song's parts in parallel tables, one table per field, laid one after
 * another — so the distance from one base to the next is how many songs the tables hold.
 * Terminator 2's driver reads eight tables at $944D, $9458, $9463… eleven bytes apart: eleven
 * songs. A number past the end reads the next table's bytes as pointers and plays garbage, and
 * every garbage is different — which is how 130 "new songs" were found before this.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Cpu6502, OPCODES, type Bus } from '@xromdev/cpu6502';
import { createMapper, type Mapper } from '../mappers.ts';
import { parseRom } from '../nes.ts';

export interface DriverDump {
  /** $0000-$07FF. */
  ram: Uint8Array;
  /** $6000-$FFFF as mapped when the dump was taken. */
  upper: Uint8Array;
  /**
   * The cartridge, when its ROM is at hand: a driver that switches banks — Terminator 2's plays
   * a sample from code it maps in at $C000 — reads the banks it asks for, not the dump's.
   * Builds a fresh mapper set to the banks the dump shows.
   */
  cartridge?: () => Mapper;
}

/**
 * The dump with its cartridge: the ROM's 8 KB banks found at $8000, $A000, $C000 and $E000 of the
 * dump, and the mapper set to map them. The ROM must be the one the session was recorded with —
 * FCEUX's MD5 is of the file without its 16-byte header.
 */
export function withRom(dump: DriverDump, file: Uint8Array, md5?: string): DriverDump {
  if (md5 && createHash('md5').update(file.subarray(16)).digest('hex') !== md5) throw new Error('not the ROM this session was recorded with');
  const cart = parseRom(file);
  const count = cart.prg.length / 0x2000;
  const banks: number[] = [];
  for (let slot = 0; slot < 4; slot++) {
    const seen = dump.upper.subarray(0x2000 + slot * 0x2000, 0x4000 + slot * 0x2000);
    const bank = Array.from({ length: count }, (_, b) => b).find((b) => cart.prg.subarray(b * 0x2000, (b + 1) * 0x2000).every((v, i) => v === seen[i]));
    if (bank === undefined) throw new Error(`the dump's $${(0x8000 + slot * 0x2000).toString(16)} is no bank of the ROM`);
    banks.push(bank);
  }
  const cartridge = () => {
    const mapper = createMapper(cart.mapper, cart.prg);
    if (!mapper.restore(banks)) throw new Error(`${mapper.name} cannot map banks ${banks.join(' ')} as the dump has them`);
    for (let a = 0x6000; a < 0x8000; a++) mapper.write(a, dump.upper[a - 0x6000]);
    return mapper;
  };
  cartridge();
  return { ...dump, cartridge };
}

export function readDump(file: string): DriverDump {
  const bytes = new Uint8Array(readFileSync(file));
  if (bytes.length !== 0x800 + 0xa000) throw new Error(`${file}: ${bytes.length} bytes, not a probe dump`);
  return { ram: bytes.slice(0, 0x800), upper: bytes.slice(0x800) };
}

/** Where a call returns to: an address no code is at, in the unmapped $5000s. */
const SENTINEL = 0x5ff5;
/** `call(NMI, …)`: the frame interrupt through the NMI vector, not a routine at an address. */
export const NMI = -1;

export interface Read {
  pc: number;
  address: number;
  value: number;
}

class DumpMachine implements Bus {
  readonly ram: Uint8Array;
  readonly upper: Uint8Array;
  readonly mapper: Mapper | null;
  readonly reads: Read[] = [];
  readonly writes: { address: number; value: number; pc: number; cycle: number }[] = [];
  /** Writes to $8000+ — a mapper switching banks, which a dump cannot follow. */
  mapperWrites = 0;
  /** Off for a long run: only the song tables need the reads. */
  keepReads = true;
  pc = 0;
  /** The CPU's cycle count, for the writes' times; set by whoever runs the CPU. */
  cycles = () => 0;
  constructor(dump: DriverDump) {
    this.ram = dump.ram.slice();
    this.upper = dump.upper.slice();
    this.mapper = dump.cartridge?.() ?? null;
  }
  read(address: number): number {
    let value = 0;
    if (address < 0x2000) value = this.ram[address & 0x7ff];
    else if (address >= 0x6000) value = this.mapper ? this.mapper.read(address) : this.upper[address - 0x6000];
    // The PPU's status: in vertical blank. A frame handler run here that waits for it (Alien 3's
    // NMI) would otherwise wait for ever.
    else if ((address & 0xe007) === 0x2002) value = 0x80;
    // PPU, APU, controllers: nothing a sound driver needs to read back but the frame counter's
    // status, which reads as quiet.
    if (this.keepReads && (address >= 0x6000 || address < 0x2000)) this.reads.push({ pc: this.pc, address, value });
    return value;
  }
  write(address: number, value: number): void {
    if (address < 0x2000) this.ram[address & 0x7ff] = value;
    else if (address >= 0x6000 && this.mapper) {
      this.mapper.write(address, value);
      if (address >= 0x8000) this.mapperWrites++;
    } else if (address >= 0x6000 && address < 0x8000) this.upper[address - 0x6000] = value; // WRAM
    else if (address >= 0x4000 && address <= 0x4017) this.writes.push({ address, value, pc: this.pc, cycle: this.cycles() });
    // Without the ROM, writes to $8000+ (mapper registers) leave the dump's banks as they were.
    else if (address >= 0x8000) this.mapperWrites++;
  }
}

export interface CallResult {
  reads: Read[];
  writes: { address: number; value: number; pc: number; cycle: number }[];
  returned: boolean;
  steps: number;
  ram: Uint8Array;
}

/**
 * Where a call into the driver has a register changed (see `DumpPlayer.call`): the song number in
 * `reg`, and `fixed` the other registers a dispatcher needs — Jungle Book's $9000 starts the song
 * in A only with Y = 2.
 */
export interface SetAt {
  at: number;
  reg: 'a' | 'x' | 'y';
  value: number;
  nth?: number;
  fixed?: Partial<Record<'a' | 'x' | 'y', number>>;
}

/**
 * An entry that is a jump table — `LDA lo,R / STA z / LDA hi,R / STA z+1 / JMP (z)` — with R
 * choosing the routine, not the song: Jungle Book's $9000 updates the sound for Y = 0, stops it
 * for 1, starts the song in A for 2, an effect for 3. Tried as a song number, R gave "other
 * music" for each routine. The routine count is the gap between the tables when they sit side by
 * side, else 8.
 */
export function dispatcher(dump: DriverDump, entry: number): { reg: 'x' | 'y'; routines: number } | null {
  const at = (address: number) => (address >= 0x6000 && address <= 0xffff ? dump.upper[address - 0x6000] : -1);
  const op = at(entry);
  const reg = op === 0xb9 ? 'y' : op === 0xbd ? 'x' : null;
  if (!reg) return null;
  const word = (address: number) => at(address) | (at(address + 1) << 8);
  const lo = word(entry + 1);
  // STA zp (85) or STA abs (8D), then the high byte the same way, then JMP (ind).
  const store = (address: number) => (at(address) === 0x85 ? { cell: at(address + 1), size: 2 } : at(address) === 0x8d ? { cell: word(address + 1), size: 3 } : null);
  const first = store(entry + 3);
  if (!first || at(entry + 3 + first.size) !== op) return null;
  const hi = word(entry + 4 + first.size);
  const second = store(entry + 6 + first.size);
  if (!second || second.cell !== first.cell + 1) return null;
  const jump = entry + 6 + first.size + second.size;
  if (at(jump) !== 0x6c || word(jump + 1) !== first.cell) return null;
  const gap = hi - lo;
  return { reg, routines: gap > 0 && gap <= 16 ? gap : 8 };
}

/** Calls `entry` with the registers given, until it returns (or `limit` instructions). */
export function callDriver(dump: DriverDump, entry: number, regs: { a?: number; x?: number; y?: number }, limit = 200_000): CallResult {
  const machine = new DumpMachine(dump);
  const cpu = new Cpu6502(machine);
  cpu.a = regs.a ?? 0;
  cpu.x = regs.x ?? 0;
  cpu.y = regs.y ?? 0;
  cpu.p = 0x24;
  cpu.s = 0xfd;
  const back = SENTINEL - 1;
  machine.write(0x100 | cpu.s, back >> 8);
  cpu.s = (cpu.s - 1) & 0xff;
  machine.write(0x100 | cpu.s, back & 0xff);
  cpu.s = (cpu.s - 1) & 0xff;
  cpu.pc = entry;
  let steps = 0;
  while (cpu.pc !== SENTINEL && !cpu.jammed && steps < limit) {
    machine.pc = cpu.pc;
    cpu.step();
    steps++;
  }
  return { reads: machine.reads, writes: machine.writes, returned: cpu.pc === SENTINEL, steps, ram: machine.ram };
}

export interface SongTables {
  /** Bases of the tables read at base + song number, in address order. */
  bases: number[];
  /** Songs the tables hold — the distance between bases, when the bases agree on one. */
  songs: number | null;
  /** How the song number was used: indexing parallel tables, or doubled into a pointer table. */
  layout: 'parallel tables' | 'pointer table' | 'unknown';
}

/** Opcodes that read absolute,X or absolute,Y — how a table is looked up by number. */
const INDEXED = new Set(OPCODES.filter((op) => op && (op.mode === 'abx' || op.mode === 'aby')).map((op) => op.code));

/**
 * The song tables, from two calls whose song numbers differ by one: reads by the same instruction
 * (pc) whose addresses differ by 1 are table lookups (base = address − number), by 2 a lookup in a
 * table of pointers. Reads in RAM are left out — the driver's own variables, not its tables.
 */
export function songTables(dump: DriverDump, entry: number, reg: 'a' | 'x' | 'y', value: number): SongTables {
  const one = callDriver(dump, entry, { [reg]: value });
  const two = callDriver(dump, entry, { [reg]: (value + 1) & 0xff });
  const byPc = (r: CallResult) => {
    const map = new Map<number, number[]>();
    for (const read of r.reads) {
      // The instruction's own bytes are fetched too; only what it reads as data counts.
      if (read.address < 0x6000 || (read.address >= read.pc && read.address < read.pc + 3)) continue;
      if (read.pc < 0x6000 || !INDEXED.has(dump.upper[read.pc - 0x6000])) continue;
      map.set(read.pc, [...(map.get(read.pc) ?? []), read.address]);
    }
    return map;
  };
  const a = byPc(one);
  const b = byPc(two);
  const bases = new Set<number>();
  let pointers = 0;
  for (const [pc, list] of a) {
    const other = b.get(pc);
    if (!other) continue;
    // The first read each instruction makes: the lookup at the song's start.
    const d = other[0] - list[0];
    if (d === 1) bases.add(list[0] - value);
    else if (d === 2) pointers++;
  }
  const sorted = [...bases].sort((x, y) => x - y);
  const gaps = sorted.slice(1).map((base, i) => base - sorted[i]);
  // The gap most of them share; tables of different fields need not be in order, so the most
  // common gap is the table length.
  const count = new Map<number, number>();
  for (const g of gaps) if (g > 1 && g <= 256) count.set(g, (count.get(g) ?? 0) + 1);
  const best = [...count].sort((x, y) => y[1] - x[1])[0];
  const songs = best && best[1] >= 2 ? best[0] : null;
  return { bases: sorted, songs, layout: sorted.length > 0 ? 'parallel tables' : pointers > 0 ? 'pointer table' : 'unknown' };
}

/** A chip write the dump player made: the frame since the song started and the cycle in it. */
export interface PlayedWrite {
  frame: number;
  cycle: number;
  address: number;
  value: number;
  pc: number;
}

/**
 * The driver as an NSF player would run it, but on the game's own memory: INIT once with the
 * registers the game called it with (one of them the song), then PLAY once a frame. Frame 0 is
 * INIT's; PLAY's frames follow. The machine's RAM carries on from call to call, as it does in
 * the cartridge, and nothing but the driver runs — no game, no sound effects, no other code.
 */
export class DumpPlayer {
  private readonly machine: DumpMachine;
  private readonly cpu: Cpu6502;
  private frame = 0;
  private frameStart = 0;
  /** Calls that did not return within the limit: a PLAY that is not one. */
  stuck = 0;
  /** Times a series has reached the set's address so far (see `callSeries`). */
  private reached = 0;

  constructor(dump: DriverDump) {
    this.machine = new DumpMachine(dump);
    this.cpu = new Cpu6502(this.machine);
    this.machine.cycles = () => this.cpu.cycles - this.frameStart;
    this.machine.keepReads = false;
    this.cpu.s = 0xfd;
  }

  /** Writes to $8000+ so far: a driver that switches banks plays wrong from a dump without its ROM. */
  get mapperWrites(): number {
    return this.machine.mapperWrites;
  }

  /** Writes a byte as the game would — a song request left in RAM for the sound routine. */
  poke(address: number, value: number): void {
    this.machine.write(address & 0xffff, value & 0xff);
  }

  /** A byte of memory as the driver sees it. */
  peek(address: number): number {
    const a = address & 0xffff;
    return a < 0x2000 || a >= 0x6000 ? this.machine.read(a) : 0;
  }

  /**
   * Calls `entry` with these registers and returns the writes it made, as one frame. `set`: when
   * the CPU first reaches `set.at`, one register is changed there — the game's call into the
   * driver, with the song number changed where the driver takes it, as the probe's experiments do.
   */
  call(
    entry: number,
    regs: { a?: number; x?: number; y?: number },
    limit = 200_000,
    set?: SetAt
  ): PlayedWrite[] {
    const { cpu, machine } = this;
    machine.writes.length = 0;
    machine.reads.length = 0;
    this.frameStart = cpu.cycles;
    cpu.a = regs.a ?? 0;
    cpu.x = regs.x ?? 0;
    cpu.y = regs.y ?? 0;
    cpu.p = 0x24;
    cpu.s = 0xfd;
    if (entry === NMI) {
      // The frame interrupt, as the console takes it: PC and P pushed, RTI returns to the
      // sentinel. For a game whose frame routine is reached only through its NMI handler — a
      // trampoline into the driver's bank (Ocean's RoboCop 3 and Alien 3).
      machine.write(0x100 | cpu.s, SENTINEL >> 8);
      cpu.s = (cpu.s - 1) & 0xff;
      machine.write(0x100 | cpu.s, SENTINEL & 0xff);
      cpu.s = (cpu.s - 1) & 0xff;
      machine.write(0x100 | cpu.s, 0x24);
      cpu.s = (cpu.s - 1) & 0xff;
      cpu.p = 0x24 | 0x04;
      cpu.pc = machine.read(0xfffa) | (machine.read(0xfffb) << 8);
    } else {
      const back = SENTINEL - 1;
      machine.write(0x100 | cpu.s, back >> 8);
      cpu.s = (cpu.s - 1) & 0xff;
      machine.write(0x100 | cpu.s, back & 0xff);
      cpu.s = (cpu.s - 1) & 0xff;
      cpu.pc = entry;
    }
    let steps = 0;
    let pending = set;
    while (cpu.pc !== SENTINEL && !cpu.jammed && steps < limit) {
      // `nth`: the time the CPU reaches `at` that takes the value, counted over a whole series
      // (Alien 3 reaches its entry five times; the fifth names the song).
      if (pending && cpu.pc === pending.at && ++this.reached >= (pending.nth ?? 1)) {
        cpu[pending.reg] = pending.value;
        for (const [reg, value] of Object.entries(pending.fixed ?? {}) as ['a' | 'x' | 'y', number][]) cpu[reg] = value;
        pending = undefined;
        this.reached = -1e9;
      }
      machine.pc = cpu.pc;
      cpu.step();
      steps++;
    }
    if (cpu.pc !== SENTINEL) this.stuck++;
    const frame = this.frame++;
    return machine.writes.map((w) => ({ frame, ...w }));
  }

  /**
   * Several calls of `entry` as one frame, the way some games start a song: Alien 3 calls $8003
   * five times in a frame — a channel cleared by each of the first four, the song named by the
   * fifth. `set.nth` counts the times `set.at` is reached over the whole series.
   */
  callSeries(
    entry: number,
    series: readonly { a: number; x: number; y: number }[],
    set?: SetAt
  ): PlayedWrite[] {
    const frame = this.frame;
    const out: PlayedWrite[] = [];
    this.reached = 0;
    for (const regs of series) for (const w of this.call(entry, regs, 200_000, set)) out.push({ ...w, frame });
    this.frame = frame + 1;
    return out;
  }

}
