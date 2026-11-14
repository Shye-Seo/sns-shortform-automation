/**
 * Hash primitives without a runtime dependency.
 *
 * Why this file exists
 * --------------------
 * Two callers need identical digests in two different runtimes:
 *
 * - the CLI/worker (Node) hashes claim tokens, approval manifests and ids;
 * - the web console runs the same claim-token and experiment code in a browser,
 *   where `node:crypto` does not exist and WebCrypto is async-only.
 *
 * A wrong-but-plausible digest is the worst failure mode here: an HMAC that
 * almost matches `hash_hmac('sha256', …)` on the PHP side looks right in a log
 * and rejects every real request. So the implementations below are checked
 * against the FIPS 180-4 test vectors **and** against `node:crypto` in
 * `tests/hash.test.ts`. That test is the contract: if the two ever diverge, the
 * suite fails before anything ships.
 *
 * Everything here works on bytes, never on binary strings: a binary string
 * round-tripping through UTF-8 expands every byte above 0x7F into two bytes.
 */

/* ─────────────────────────────────────────────────────────────
 * 1. Bytes
 * ───────────────────────────────────────────────────────── */

/** UTF-8 encode without TextEncoder, so the module also runs where it is absent. */
export function utf8Bytes(input: string): Uint8Array {
  const encoded = encodeURIComponent(input);
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const char = encoded[i];
    if (char === '%') {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }
  return Uint8Array.from(bytes);
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

/** Pad a message the way both SHA-1 and SHA-256 require: 0x80, zeros, 64-bit length. */
function padMessage(message: Uint8Array): DataView {
  const bitLength = message.length * 8;
  // ceil((len + 1 + 8) / 64) * 64. A message whose length is exactly 55 bytes
  // must stay in one block (55 + 0x80 + 8 bytes of length = 64), which the
  // `(len + 9 >> 6) + 1` form gets wrong for len ≡ 55 (mod 64).
  const paddedLength = ((message.length + 9 + 63) >> 6) * 64;
  const withPadding = new Uint8Array(paddedLength);
  withPadding.set(message);
  withPadding[message.length] = 0x80;

  const view = new DataView(withPadding.buffer);
  view.setUint32(withPadding.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(withPadding.length - 4, bitLength >>> 0);
  return view;
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/* ─────────────────────────────────────────────────────────────
 * 2. SHA-256 (FIPS 180-4)
 * ───────────────────────────────────────────────────────── */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Digest(message: Uint8Array): Uint8Array {
  const view = padMessage(message);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((value, index) => outView.setUint32(index * 4, value));
  return out;
}

/** SHA-256 over raw bytes, hex encoded. */
export function sha256Bytes(message: Uint8Array): string {
  return bytesToHex(sha256Digest(message));
}

export function sha256Hex(input: string): string {
  return sha256Bytes(utf8Bytes(input));
}

/* ─────────────────────────────────────────────────────────────
 * 3. SHA-1 (FIPS 180-4) — ids only, never signatures
 * ───────────────────────────────────────────────────────── */

/**
 * SHA-1 is used for short, human-legible ids (`stableHash`, slug suffixes).
 * It is not a security primitive and must not be used for tokens or links.
 */
function sha1Digest(message: Uint8Array): Uint8Array {
  const view = padMessage(message);
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const w = new Uint32Array(80);

  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  h.forEach((value, index) => outView.setUint32(index * 4, value));
  return out;
}

export function sha1Bytes(message: Uint8Array): string {
  return bytesToHex(sha1Digest(message));
}

export function sha1Hex(input: string): string {
  return sha1Bytes(utf8Bytes(input));
}

/* ─────────────────────────────────────────────────────────────
 * 4. HMAC-SHA256 (RFC 2104)
 * ───────────────────────────────────────────────────────── */

/**
 * HMAC-SHA256 (RFC 2104) over raw bytes.
 *
 * The pad bytes are concatenated as **bytes**, not as a string: a binary string
 * round-tripping through UTF-8 would expand every byte above 0x7F into two
 * bytes and produce a digest that looks plausible but never matches
 * `hash_hmac` on the server.
 */
export function hmacSha256Hex(key: string, message: string): string {
  return hmacSha256HexBytes(utf8Bytes(key), utf8Bytes(message));
}

export function hmacSha256HexBytes(keyBytes: Uint8Array, messageBytes: Uint8Array): string {
  const blockSize = 64;
  const key = keyBytes.length > blockSize ? hexToBytes(sha256Bytes(keyBytes)) : keyBytes;
  const padded = new Uint8Array(blockSize);
  padded.set(key);

  const inner = new Uint8Array(blockSize + messageBytes.length);
  const outer = new Uint8Array(blockSize + 32);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = padded[i]! ^ 0x36;
    outer[i] = padded[i]! ^ 0x5c;
  }
  inner.set(messageBytes, blockSize);
  outer.set(hexToBytes(sha256Bytes(inner)), blockSize);

  return sha256Bytes(outer);
}

/* ─────────────────────────────────────────────────────────────
 * 5. `crypto.createHash` compatible surface
 * ───────────────────────────────────────────────────────────── */

/**
 * The bytes `digest()` returns, with the one method the callers use.
 * `bucketOf()` reads the first four bytes as a big-endian integer, which in
 * Node is `Buffer.readUInt32BE`, so the shape is kept rather than rewritten.
 */
export class DigestBytes extends Uint8Array {
  readUInt32BE(offset = 0): number {
    return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint32(offset);
  }
}

export interface HashLike {
  update(chunk: string | Uint8Array): HashLike;
  digest(encoding: 'hex'): string;
  digest(): DigestBytes;
}

/**
 * Minimal `createHash` for the two algorithms this repository uses, so code
 * written against `node:crypto` runs unchanged in the browser bundle.
 */
export function createHash(algorithm: string): HashLike {
  const normalised = algorithm.toLowerCase().replace('-', '');
  if (normalised !== 'sha1' && normalised !== 'sha256') {
    throw new Error(`unsupported hash algorithm: ${algorithm}`);
  }
  let buffer = new Uint8Array(0);

  const append = (chunk: string | Uint8Array): void => {
    const bytes = typeof chunk === 'string' ? utf8Bytes(chunk) : chunk;
    const next = new Uint8Array(buffer.length + bytes.length);
    next.set(buffer);
    next.set(bytes, buffer.length);
    buffer = next;
  };

  const digestOf = (): Uint8Array => (normalised === 'sha1' ? sha1Digest(buffer) : sha256Digest(buffer));

  function digest(encoding: 'hex'): string;
  function digest(): DigestBytes;
  function digest(encoding?: 'hex'): string | DigestBytes {
    const bytes = digestOf();
    if (encoding === 'hex') return bytesToHex(bytes);
    return new DigestBytes(bytes);
  }

  const api: HashLike = {
    update(chunk: string | Uint8Array): HashLike {
      append(chunk);
      return api;
    },
    digest,
  };
  return api;
}
