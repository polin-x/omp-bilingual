import { readFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";

export type GifFrame = {
  pngBase64: string;
  delayMs: number;
};

const MAX_FRAMES = 24;
const MAX_EDGE = 64;

export async function loadGifFrames(path: string): Promise<GifFrame[]> {
  const bytes = new Uint8Array(await readFile(path));
  return decodeGif(bytes);
}

export function decodeGif(bytes: Uint8Array): GifFrame[] {
  if (bytes.length < 13) throw new Error("gif too small");
  const header = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!);
  if (header !== "GIF87a" && header !== "GIF89a") throw new Error("not a gif");

  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  const packed = bytes[10]!;
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = 2 << (packed & 7);
  let offset = 13;
  const gct = gctFlag ? readTable(bytes, offset, gctSize) : undefined;
  if (gctFlag) offset += gctSize * 3;

  const canvas = new Uint8ClampedArray(width * height * 4);
  const backup = new Uint8ClampedArray(width * height * 4);
  const frames: GifFrame[] = [];
  let delayMs = 100;
  let disposal = 0;
  let transIndex: number | undefined;

  while (offset < bytes.length) {
    const tag = bytes[offset]!;
    if (tag === 0x3b) break;
    if (tag === 0x21) {
      const label = bytes[offset + 1]!;
      offset += 2;
      if (label === 0xf9 && bytes[offset]! >= 4) {
        const packedGce = bytes[offset + 1]!;
        disposal = (packedGce >> 2) & 7;
        delayMs = Math.max(20, (bytes[offset + 2]! | (bytes[offset + 3]! << 8)) * 10);
        transIndex = packedGce & 1 ? bytes[offset + 4]! : undefined;
      }
      while (offset < bytes.length && bytes[offset] !== 0) offset += 1 + bytes[offset]!;
      offset += 1;
      continue;
    }
    if (tag !== 0x2c) {
      offset += 1;
      continue;
    }
    const left = bytes[offset + 1]! | (bytes[offset + 2]! << 8);
    const top = bytes[offset + 3]! | (bytes[offset + 4]! << 8);
    const fw = bytes[offset + 5]! | (bytes[offset + 6]! << 8);
    const fh = bytes[offset + 7]! | (bytes[offset + 8]! << 8);
    const ipacked = bytes[offset + 9]!;
    offset += 10;
    const lctFlag = (ipacked & 0x80) !== 0;
    const interlace = (ipacked & 0x40) !== 0;
    const lctSize = 2 << (ipacked & 7);
    const table = lctFlag ? readTable(bytes, offset, lctSize) : gct;
    if (lctFlag) offset += lctSize * 3;
    if (!table) throw new Error("gif missing color table");
    const minCode = bytes[offset]!;
    offset += 1;
    const lzw: number[] = [];
    while (offset < bytes.length && bytes[offset] !== 0) {
      const n = bytes[offset]!;
      for (let i = 0; i < n; i++) lzw.push(bytes[offset + 1 + i]!);
      offset += 1 + n;
    }
    offset += 1;

    if (disposal === 3) backup.set(canvas);
    if (disposal === 2) clearRect(canvas, width, left, top, fw, fh);

    const indices = decodeLzw(lzw, minCode, fw * fh);
    blit(canvas, width, height, indices, table, left, top, fw, fh, interlace, transIndex);
    frames.push({ pngBase64: rgbaToPngBase64(fitRgba(canvas, width, height)), delayMs });
    if (frames.length >= MAX_FRAMES) break;

    if (disposal === 3) canvas.set(backup);
  }

  if (frames.length === 0) throw new Error("gif has no frames");
  return frames;
}

function readTable(bytes: Uint8Array, offset: number, size: number): Uint8Array {
  return bytes.subarray(offset, offset + size * 3);
}

function clearRect(
  canvas: Uint8ClampedArray,
  width: number,
  left: number,
  top: number,
  fw: number,
  fh: number,
): void {
  for (let y = top; y < top + fh; y++) {
    for (let x = left; x < left + fw; x++) {
      const i = (y * width + x) * 4;
      canvas[i] = 0;
      canvas[i + 1] = 0;
      canvas[i + 2] = 0;
      canvas[i + 3] = 0;
    }
  }
}

function blit(
  canvas: Uint8ClampedArray,
  width: number,
  height: number,
  indices: number[],
  table: Uint8Array,
  left: number,
  top: number,
  fw: number,
  fh: number,
  interlace: boolean,
  transIndex: number | undefined,
): void {
  const rows = interlaceRows(fh, interlace);
  let n = 0;
  for (const row of rows) {
    const y = top + row;
    if (y < 0 || y >= height) {
      n += fw;
      continue;
    }
    for (let x = 0; x < fw; x++) {
      const idx = indices[n++] ?? 0;
      if (idx === transIndex) continue;
      const dx = left + x;
      if (dx < 0 || dx >= width) continue;
      const o = (y * width + dx) * 4;
      const p = idx * 3;
      canvas[o] = table[p] ?? 0;
      canvas[o + 1] = table[p + 1] ?? 0;
      canvas[o + 2] = table[p + 2] ?? 0;
      canvas[o + 3] = 255;
    }
  }
}

function interlaceRows(height: number, interlace: boolean): number[] {
  if (!interlace) return Array.from({ length: height }, (_, i) => i);
  const rows: number[] = [];
  for (let y = 0; y < height; y += 8) rows.push(y);
  for (let y = 4; y < height; y += 8) rows.push(y);
  for (let y = 2; y < height; y += 4) rows.push(y);
  for (let y = 1; y < height; y += 2) rows.push(y);
  return rows;
}

function decodeLzw(data: number[], minCode: number, expected: number): number[] {
  const clear = 1 << minCode;
  const end = clear + 1;
  let codeSize = minCode + 1;
  let next = end + 1;
  const dict: number[][] = [];
  for (let i = 0; i < clear; i++) dict[i] = [i];
  dict[clear] = [];
  dict[end] = [];

  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  let i = 0;
  let prev: number[] | undefined;

  const read = (): number | undefined => {
    while (bits < codeSize && i < data.length) {
      buf |= data[i]! << bits;
      bits += 8;
      i += 1;
    }
    if (bits < codeSize) return undefined;
    const code = buf & ((1 << codeSize) - 1);
    buf >>= codeSize;
    bits -= codeSize;
    return code;
  };

  for (;;) {
    const code = read();
    if (code === undefined || code === end) break;
    if (code === clear) {
      dict.length = 0;
      for (let k = 0; k < clear; k++) dict[k] = [k];
      dict[clear] = [];
      dict[end] = [];
      codeSize = minCode + 1;
      next = end + 1;
      prev = undefined;
      continue;
    }
    let entry = dict[code];
    if (!entry) {
      if (!prev || code !== next) break;
      entry = [...prev, prev[0]!];
    }
    out.push(...entry);
    if (prev) {
      dict[next] = [...prev, entry[0]!];
      next += 1;
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = entry;
    if (out.length >= expected) break;
  }
  return out.slice(0, expected);
}

function fitRgba(src: Uint8ClampedArray, width: number, height: number): {
  rgba: Uint8Array;
  width: number;
  height: number;
} {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height, 1));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (w === width && h === height) return { rgba: Uint8Array.from(src), width, height };
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / w));
      const si = (sy * width + sx) * 4;
      const di = (y * w + x) * 4;
      rgba[di] = src[si] ?? 0;
      rgba[di + 1] = src[si + 1] ?? 0;
      rgba[di + 2] = src[si + 2] ?? 0;
      rgba[di + 3] = src[si + 3] ?? 0;
    }
  }
  return { rgba, width: w, height: h };
}

function rgbaToPngBase64(img: { rgba: Uint8Array; width: number; height: number }): string {
  const { rgba, width, height } = img;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks = [pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]).toString("base64");
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
