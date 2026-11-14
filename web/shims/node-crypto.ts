/**
 * Browser stub for `node:crypto`.
 *
 * Only one function is reachable from the demo path — `randomUUID`, used by the
 * job queue for job ids — and the Web Crypto API provides exactly it, so the id
 * shape is identical to the Node run. `createHash` is wired to the pure
 * implementation in `src/lib/hash.ts` so anything that hashes text on the demo
 * path (stable ids) returns the same digest as the CLI.
 */
import { createHash as createPureHash, type HashLike } from '../../src/lib/hash';

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export function createHash(algorithm: string): HashLike {
  return createPureHash(algorithm);
}

export default { randomUUID, createHash };
