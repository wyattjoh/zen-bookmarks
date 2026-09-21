/**
 * Read and write Mozilla's mozLz4 container format (magic "mozLz40\0" + uint32
 * LE decompressed size + a raw LZ4 block). Zen's `zen-sessions.jsonlz4` and
 * other Firefox `*.jsonlz4` files use this format.
 *
 * The container carries no checksum, and an LZ4 block built from literals only
 * (no back-references) is valid and decompresses byte-identically, so this
 * module can produce files Zen reads back without needing a real LZ4 encoder.
 */
import { readFileSync } from "node:fs";

const MAGIC = "mozLz40\0";

/**
 * Decompress a mozLz4 buffer into its raw bytes.
 *
 * @param buf - The full mozLz4 file contents
 * @returns The decompressed payload bytes
 */
export function decompressMozLz4Buffer(buf: Buffer): Uint8Array {
  const magic = buf.subarray(0, 8).toString("latin1");
  if (magic !== MAGIC) {
    throw new Error(`Not a mozLz4 buffer (bad magic): ${JSON.stringify(magic)}`);
  }
  const size = buf.readUInt32LE(8);
  const src = buf.subarray(12);
  const dst = new Uint8Array(size);
  let s = 0;
  let d = 0;
  while (s < src.length) {
    const token = src[s++];
    let litLen = token >> 4;
    if (litLen === 15) {
      let b: number;
      do {
        b = src[s++];
        litLen += b;
      } while (b === 255);
    }
    for (let i = 0; i < litLen; i++) dst[d++] = src[s++];
    if (s >= src.length) break;
    const offset = src[s++] | (src[s++] << 8);
    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let b: number;
      do {
        b = src[s++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4;
    let m = d - offset;
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[m++];
  }
  return dst.subarray(0, d);
}

/**
 * Read a mozLz4 file from disk and return its decompressed UTF-8 text.
 *
 * @param path - Absolute path to a `.jsonlz4` file
 * @returns The decompressed UTF-8 string
 */
export function readMozLz4Text(path: string): string {
  return Buffer.from(decompressMozLz4Buffer(readFileSync(path))).toString("utf8");
}

/**
 * Encode bytes as a valid LZ4 block using only literal runs (no matches). This
 * trades compression ratio for a trivially correct, dependency-free encoder.
 *
 * @param src - The raw bytes to encode
 * @returns The LZ4 block bytes
 */
function lz4StoreBlock(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  const litLen = src.length;
  out.push((litLen >= 15 ? 15 : litLen) << 4);
  if (litLen >= 15) {
    let rem = litLen - 15;
    while (true) {
      out.push(rem >= 255 ? 255 : rem);
      if (rem < 255) break;
      rem -= 255;
    }
  }
  const head = Uint8Array.from(out);
  const block = new Uint8Array(head.length + src.length);
  block.set(head, 0);
  block.set(src, head.length);
  return block;
}

/**
 * Encode UTF-8 text into a complete mozLz4 file buffer.
 *
 * @param text - The text payload to store
 * @returns A buffer containing the full mozLz4 file
 */
export function compressMozLz4Text(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const block = lz4StoreBlock(payload);
  const header = Buffer.alloc(12);
  header.write(MAGIC, 0, "latin1");
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, Buffer.from(block)]);
}
