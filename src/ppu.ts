/**
 * The picture: a PPU that keeps the video memory the game builds and draws it a scanline at a
 * time — the background through its scroll, then the sprites over and under it.
 *
 * What it keeps is what a reader of the graphics wants to look at as well as the frame: the
 * nametables, the attribute bytes, the 32 palette entries, the 256 bytes of sprite memory and the
 * pattern tables (CHR ROM, or the CHR RAM the game fills). `snapshot()` hands them out together
 * with the picture.
 *
 * Scroll follows the PPU's own registers (`t`, `v`, fine x, the write toggle): the horizontal
 * part is copied from `t` at the start of every line, the vertical at the top of the frame or when
 * a second `$2006` write lands mid-frame — which is how a status bar is split off a scrolling
 * field. Timing is by whole scanlines; mid-line effects are out of scope. Not drawn: colour
 * emphasis, greyscale, the 8-sprite overflow flag.
 */

import type { Cartridge, PpuBus } from './nes.ts';
import { NES_RGB } from './palette.ts';

export const WIDTH = 256;
export const HEIGHT = 240;
/** A pixel of a layer with nothing on it: above the 24 bits of colour, as `png.ts` reads it. */
export const TRANSPARENT = 0x1000000;

export interface PpuSnapshot {
  /** 256 × 240, `0xRRGGBB` a pixel. */
  pixels: Uint32Array;
  /** The palette index (0–63) behind each pixel. */
  indices: Uint8Array;
  /** The two layers apart — `TRANSPARENT` where the layer has nothing: the art without the scene. */
  background: Uint32Array;
  sprites: Uint32Array;
  /** 32 bytes at $3F00: four background palettes, then four sprite palettes. */
  palette: Uint8Array;
  oam: Uint8Array;
  /** The four logical nametables at $2000, $2400, $2800, $2C00, 1 KB each, mirroring applied. */
  nametables: Uint8Array;
  /** 8 KB of pattern tables as the PPU saw them. */
  chr: Uint8Array;
  ctrl: number;
  mask: number;
}

export class Ppu implements PpuBus {
  ctrl = 0;
  mask = 0;
  private readonly chr: Uint8Array;
  private readonly chrRam: boolean;
  private readonly vram = new Uint8Array(0x1000);
  readonly palette = new Uint8Array(32);
  readonly oam = new Uint8Array(256);
  private oamAddr = 0;
  private readonly mirroring: Cartridge['mirroring'];
  // Loopy registers.
  private v = 0;
  private t = 0;
  private fineX = 0;
  private w = 0;
  private buffer = 0;
  /** Vertical scroll in use this frame: a row 0–479 over two nametables stacked. */
  private y = 0;
  private yReload = false;
  readonly pixels = new Uint32Array(WIDTH * HEIGHT);
  readonly indices = new Uint8Array(WIDTH * HEIGHT);
  readonly background = new Uint32Array(WIDTH * HEIGHT);
  readonly sprites = new Uint32Array(WIDTH * HEIGHT);
  /** Opaque background under each pixel of the line being drawn, for sprite priority. */
  private readonly bgOpaque = new Uint8Array(WIDTH);

  constructor(cart: Cartridge) {
    this.chrRam = cart.chr.length === 0;
    this.chr = this.chrRam ? new Uint8Array(0x2000) : cart.chr.slice(0, 0x2000);
    this.mirroring = cart.mirroring;
  }

  /** The 8 KB CHR window, for a mapper that switches CHR banks to hand the PPU new ones. */
  setChr(bytes: Uint8Array) {
    this.chr.set(bytes.subarray(0, 0x2000));
  }

  write(register: number, value: number, line: number): void {
    switch (register) {
      case 0:
        this.ctrl = value;
        this.t = (this.t & ~0x0c00) | ((value & 3) << 10);
        break;
      case 1:
        this.mask = value;
        break;
      case 3:
        this.oamAddr = value;
        break;
      case 4:
        this.oam[this.oamAddr] = value;
        this.oamAddr = (this.oamAddr + 1) & 0xff;
        break;
      case 5:
        if (this.w === 0) {
          this.t = (this.t & ~0x001f) | (value >> 3);
          this.fineX = value & 7;
        } else {
          this.t = (this.t & ~0x73e0) | ((value & 7) << 12) | ((value >> 3) << 5);
        }
        this.w ^= 1;
        break;
      case 6:
        if (this.w === 0) this.t = (this.t & 0x00ff) | ((value & 0x3f) << 8);
        else {
          this.t = (this.t & 0x7f00) | value;
          this.v = this.t;
          if (line < HEIGHT) this.yReload = true;
        }
        this.w ^= 1;
        break;
      case 7:
        this.poke(this.v & 0x3fff, value);
        this.v = (this.v + (this.ctrl & 4 ? 32 : 1)) & 0x7fff;
        break;
    }
  }

  read(register: number): number {
    if (register === 2) {
      this.w = 0;
      return 0;
    }
    if (register === 7) {
      const address = this.v & 0x3fff;
      let value = this.buffer;
      this.buffer = this.peek(address);
      if (address >= 0x3f00) value = this.buffer;
      this.v = (this.v + (this.ctrl & 4 ? 32 : 1)) & 0x7fff;
      return value;
    }
    return 0;
  }

  dma(page: Uint8Array): void {
    for (let i = 0; i < 256; i++) this.oam[(this.oamAddr + i) & 0xff] = page[i];
  }

  /** The line sprite 0's first opaque pixel lands on — the game waits for it to split the screen. */
  sprite0Line(): number {
    const tall = (this.ctrl & 0x20) !== 0;
    const top = this.oam[0] + 1;
    const h = tall ? 16 : 8;
    for (let row = 0; row < h; row++) {
      const flipY = this.oam[2] & 0x80;
      const r = flipY ? h - 1 - row : row;
      const [lo, hi] = this.spriteRow(this.oam[1], r, tall);
      if (lo | hi) return top + row;
    }
    return -1;
  }

  /** Called at the start of every scanline, before the CPU runs it: draws visible lines. */
  scanline(line: number): void {
    if (line === 0) {
      // Only a rendering PPU copies `t` into `v`: with the screen off, `v` is the address the
      // game is uploading through, and a game filling the screen over several frames depends on it.
      if (this.mask & 0x18) this.v = (this.v & ~0x7be0) | (this.t & 0x7be0);
      this.y = this.rowOf(this.t);
      this.yReload = false;
    } else if (line < HEIGHT) {
      if (this.yReload) {
        this.y = this.rowOf(this.v);
        this.yReload = false;
      } else this.y = (this.y + 1) % 480;
    }
    if (line < HEIGHT) this.drawLine(line);
  }

  snapshot(): PpuSnapshot {
    const nametables = new Uint8Array(0x1000);
    for (let n = 0; n < 4; n++) nametables.set(this.vram.subarray(this.bank(n), this.bank(n) + 0x400), n * 0x400);
    return {
      pixels: this.pixels.slice(),
      indices: this.indices.slice(),
      background: this.background.slice(),
      sprites: this.sprites.slice(),
      // $3F10/$3F14/$3F18/$3F1C are $3F00/$3F04/… — given as what a read of them returns.
      palette: this.palette.map((value, i) => ((i & 0x13) === 0x10 ? this.palette[i & 0x0f] : value)),
      oam: this.oam.slice(),
      nametables,
      chr: this.chr.slice(),
      ctrl: this.ctrl,
      mask: this.mask,
    };
  }

  /** Row 0–479 of the two nametables stacked, from a loopy address. */
  private rowOf(address: number): number {
    const coarseY = (address >> 5) & 31;
    const fineY = (address >> 12) & 7;
    return ((address >> 11) & 1) * 240 + Math.min(coarseY, 29) * 8 + fineY;
  }

  /** Where logical nametable 0–3 lives in the 4 KB of VRAM kept. */
  private bank(n: number): number {
    if (this.mirroring === 'vertical') return (n & 1) * 0x400;
    if (this.mirroring === 'horizontal') return (n >> 1) * 0x400;
    return n * 0x400;
  }

  private paletteIndex(address: number): number {
    let i = address & 0x1f;
    if ((i & 0x13) === 0x10) i &= 0x0f;
    return i;
  }

  private poke(address: number, value: number) {
    if (address < 0x2000) {
      if (this.chrRam) this.chr[address] = value;
    } else if (address < 0x3f00) {
      const n = (address >> 10) & 3;
      this.vram[this.bank(n) + (address & 0x3ff)] = value;
    } else this.palette[this.paletteIndex(address)] = value & 0x3f;
  }

  private peek(address: number): number {
    if (address < 0x2000) return this.chr[address];
    if (address < 0x3f00) return this.vram[this.bank((address >> 10) & 3) + (address & 0x3ff)];
    return this.palette[this.paletteIndex(address)];
  }

  private spriteRow(tile: number, row: number, tall: boolean): [number, number] {
    let base: number;
    if (tall) {
      base = (tile & 1) * 0x1000 + (tile & 0xfe) * 16;
      if (row >= 8) {
        base += 16;
        row -= 8;
      }
    } else base = (this.ctrl & 8 ? 0x1000 : 0) + tile * 16;
    return [this.chr[base + row], this.chr[base + row + 8]];
  }

  private put(line: number, x: number, index: number) {
    const i = line * WIDTH + x;
    this.indices[i] = index;
    this.pixels[i] = NES_RGB[index & 0x3f];
  }

  private drawLine(line: number) {
    const backdrop = this.palette[0];
    const showBg = (this.mask & 0x08) !== 0;
    const showSprites = (this.mask & 0x10) !== 0;
    this.bgOpaque.fill(0);
    const at = line * WIDTH;
    this.background.fill(TRANSPARENT, at, at + WIDTH);
    this.sprites.fill(TRANSPARENT, at, at + WIDTH);
    // The horizontal scroll is `t`'s, copied every line.
    const scrollX = ((this.t >> 10) & 1) * 256 + (this.t & 31) * 8 + this.fineX;
    const patterns = this.ctrl & 0x10 ? 0x1000 : 0;
    for (let x = 0; x < WIDTH; x++) {
      if (!showBg || (x < 8 && !(this.mask & 0x02))) {
        this.put(line, x, backdrop);
        continue;
      }
      const wx = (scrollX + x) % 512;
      const wy = this.y;
      const n = (wx >> 8) | ((wy >= 240 ? 1 : 0) << 1);
      const tx = (wx & 255) >> 3;
      const ty = (wy % 240) >> 3;
      const nt = this.bank(n);
      const tile = this.vram[nt + ty * 32 + tx];
      const attr = this.vram[nt + 0x3c0 + (ty >> 2) * 8 + (tx >> 2)];
      const group = (attr >> (((ty & 2) << 1) | (tx & 2))) & 3;
      const fy = wy % 240 & 7;
      const lo = this.chr[patterns + tile * 16 + fy];
      const hi = this.chr[patterns + tile * 16 + fy + 8];
      const bit = 7 - (wx & 7);
      const colour = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
      if (colour) {
        this.bgOpaque[x] = 1;
        this.put(line, x, this.palette[group * 4 + colour]);
        this.background[at + x] = this.pixels[at + x];
      } else this.put(line, x, backdrop);
    }
    if (!showSprites) return;
    const tall = (this.ctrl & 0x20) !== 0;
    const h = tall ? 16 : 8;
    // Up to eight sprites a line; the first in OAM wins where they overlap.
    const found: number[] = [];
    for (let s = 0; s < 64 && found.length < 8; s++) {
      const row = line - (this.oam[s * 4] + 1);
      if (row >= 0 && row < h) found.push(s);
    }
    const drawn = new Uint8Array(WIDTH);
    for (const s of found) {
      const [y, tile, attr, sx] = this.oam.subarray(s * 4, s * 4 + 4);
      let row = line - (y + 1);
      if (attr & 0x80) row = h - 1 - row;
      const [lo, hi] = this.spriteRow(tile, row, tall);
      for (let col = 0; col < 8; col++) {
        const x = sx + col;
        if (x >= WIDTH || drawn[x] || (x < 8 && !(this.mask & 0x04))) continue;
        const bit = attr & 0x40 ? col : 7 - col;
        const colour = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        if (!colour) continue;
        drawn[x] = 1;
        this.sprites[at + x] = NES_RGB[this.palette[0x10 + (attr & 3) * 4 + colour] & 0x3f];
        if (attr & 0x20 && this.bgOpaque[x]) continue;
        this.put(line, x, this.palette[0x10 + (attr & 3) * 4 + colour]);
      }
    }
  }
}
