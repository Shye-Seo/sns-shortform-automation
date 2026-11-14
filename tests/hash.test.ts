import { createHash as nodeHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createHash,
  DigestBytes,
  hmacSha256Hex,
  sha1Hex,
  sha256Bytes,
  sha256Hex,
  utf8Bytes,
} from '../src/lib/hash';
import { sha256 as idSha256, stableHash, slugify } from '../src/lib/ids';

/**
 * The hash module is the one place where a plausible-looking result is a bug:
 * a token signed with a slightly different SHA-256 rejects every real request.
 * These tests pin it to (a) the published vectors and (b) `node:crypto` over the
 * same inputs, including Korean text and multi-block messages.
 */

describe('hash primitives', () => {
  it('matches the FIPS 180-4 SHA-256 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches the FIPS 180-4 SHA-1 vectors', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    );
  });

  it('agrees with node:crypto on Korean text and block-boundary lengths', () => {
    const samples = [
      '',
      'a',
      '할인',
      '쿠폰 받고 싶어요 🎁',
      'x'.repeat(55),
      'x'.repeat(56),
      'x'.repeat(63),
      'x'.repeat(64),
      '부산 신혼집 3평 주방 수납 정리법',
      'y'.repeat(1_000),
    ];

    for (const sample of samples) {
      expect(sha256Hex(sample)).toBe(nodeHash('sha256').update(sample).digest('hex'));
      expect(sha1Hex(sample)).toBe(nodeHash('sha1').update(sample).digest('hex'));
      expect(sha256Bytes(utf8Bytes(sample))).toBe(nodeHash('sha256').update(sample).digest('hex'));
    }
  });

  it('agrees with node:crypto HMAC, including keys longer than the block', () => {
    const cases: Array<[string, string]> = [
      ['key', 'The quick brown fox jumps over the lazy dog'],
      ['', ''],
      ['할인', '쿠폰'],
      ['k'.repeat(64), 'exactly one block'],
      ['k'.repeat(65), 'longer than one block'],
    ];

    for (const [key, message] of cases) {
      expect(hmacSha256Hex(key, message)).toBe(createHmac('sha256', key).update(message).digest('hex'));
    }
  });

  it('keeps the stable id shape the CLI produces', () => {
    expect(stableHash('topic', 'ko')).toMatch(/^[0-9a-f]{8}$/);
    const expected = nodeHash('sha1').update('topic\u0000ko').digest('hex').slice(0, 8);
    expect(stableHash('topic', 'ko')).toBe(expected);
    expect(slugify('!!!')).toBe(`episode-${nodeHash('sha1').update('!!!').digest('hex').slice(0, 6)}`);
  });

  it('hashes bytes passed as a typed array, the way Buffer inputs arrive', () => {
    const bytes = Buffer.from('할인');
    expect(idSha256(bytes)).toBe(nodeHash('sha256').update(bytes).digest('hex'));
    expect(idSha256('할인')).toBe(nodeHash('sha256').update('할인').digest('hex'));
  });

  it('exposes a createHash surface that bucketOf() can read as big-endian', () => {
    const digest = createHash('sha256').update('experiment\u0000unit-42').digest();
    expect(digest).toBeInstanceOf(DigestBytes);
    expect(digest.length).toBe(32);
    expect(digest.readUInt32BE(0)).toBe(
      nodeHash('sha256').update('experiment\u0000unit-42').digest().readUInt32BE(0),
    );
    expect(createHash('sha-256').update('abc').digest('hex')).toBe(sha256Hex('abc'));
    expect(createHash('sha1').update('abc').digest('hex')).toBe(sha1Hex('abc'));
  });

  it('accumulates chunks across update() calls', () => {
    const incremental = createHash('sha256').update('할').update('인').digest('hex');
    expect(incremental).toBe(nodeHash('sha256').update('할').update('인').digest('hex'));
  });

  it('rejects algorithms it does not implement instead of guessing', () => {
    expect(() => createHash('md5')).toThrow(/unsupported hash algorithm/);
  });
});
