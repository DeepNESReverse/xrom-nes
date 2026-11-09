/** A picture as PNG bytes — 8-bit RGB, no dependencies beyond zlib. */
import { deflateSync } from 'node:zlib';
const CRC = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++)
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes)
        c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}
/**
 * `pixels` is `0xRRGGBB` a pixel, or `-1` / any value with bit 24 set for transparent — in which
 * case the PNG has an alpha channel. `scale` repeats each pixel, for a crisp enlargement.
 */
export function encodePng(pixels, width, height, scale = 1) {
    const alpha = Array.from({ length: width * height }, (_, i) => pixels[i]).some((p) => p < 0 || p > 0xffffff);
    const channels = alpha ? 4 : 3;
    const w = width * scale;
    const h = height * scale;
    const raw = new Uint8Array(h * (1 + w * channels));
    for (let y = 0; y < h; y++) {
        const row = y * (1 + w * channels);
        for (let x = 0; x < w; x++) {
            const p = pixels[Math.floor(y / scale) * width + Math.floor(x / scale)];
            const clear = p < 0 || p > 0xffffff;
            const o = row + 1 + x * channels;
            raw[o] = (p >> 16) & 0xff;
            raw[o + 1] = (p >> 8) & 0xff;
            raw[o + 2] = p & 0xff;
            if (alpha)
                raw[o + 3] = clear ? 0 : 255;
        }
    }
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, w);
    view.setUint32(4, h);
    header[8] = 8;
    header[9] = alpha ? 6 : 2;
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const parts = [signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}
