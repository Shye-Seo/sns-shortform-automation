import { describe, expect, it } from 'vitest';
import { alignCharactersToWords } from '../src/lib/align';
import { formatFromContainer, parseFfprobeJson, parseFrameRate } from '../src/lib/media';
import { TokenBucket, computeBackoffDelay, withRetry } from '../src/lib/retry';
import { ShortformError } from '../src/lib/errors';

describe('character alignment', () => {
  it('turns character timings into word timings', () => {
    const text = '주방 수납';
    const characters = Array.from(text);
    // 주(0-0.2) 방(0.2-0.4) space(0.4-0.5) 수(0.5-0.7) 납(0.7-0.9)
    const startTimes = [0, 0.2, 0.4, 0.5, 0.7];
    const endTimes = [0.2, 0.4, 0.5, 0.7, 0.9];

    const words = alignCharactersToWords(text, { characters, startTimes, endTimes });
    expect(words).toHaveLength(2);
    expect(words[0]?.text).toBe('주방');
    expect(words[0]?.startSec).toBeCloseTo(0, 3);
    expect(words[0]?.endSec).toBeCloseTo(0.4, 3);
    expect(words[1]?.text).toBe('수납');
    expect(words[1]?.startSec).toBeCloseTo(0.5, 3);
  });

  it('ignores trailing whitespace', () => {
    const text = '가 나 ';
    const characters = Array.from(text);
    const words = alignCharactersToWords(text, {
      characters,
      startTimes: [0, 0.2, 0.4, 0.5],
      endTimes: [0.2, 0.4, 0.5, 0.6],
    });
    expect(words.map((word) => word.text)).toEqual(['가', '나']);
  });
});

describe('ffprobe parsing', () => {
  const raw = JSON.stringify({
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '38.430000',
      size: '41234567',
      bit_rate: '8580000',
    },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        profile: 'High',
        width: 1080,
        height: 1920,
        pix_fmt: 'yuv420p',
        avg_frame_rate: '30/1',
        bit_rate: '8400000',
      },
      {
        codec_type: 'audio',
        codec_name: 'aac',
        sample_rate: '48000',
        channels: 2,
        bit_rate: '192000',
      },
    ],
  });

  it('reads a vertical H.264 render', () => {
    const probe = parseFfprobeJson(raw);
    expect(probe.container).toBe('mp4');
    expect(probe.video.width).toBe(1080);
    expect(probe.video.height).toBe(1920);
    expect(probe.video.fps).toBe(30);
    expect(probe.audio?.codec).toBe('aac');
  });

  it('handles a fractional frame rate', () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('25')).toBe(25);
    expect(parseFrameRate(undefined)).toBe(0);
    expect(parseFrameRate('0/0')).toBe(0);
  });

  it('maps container names', () => {
    expect(formatFromContainer('mov,mp4,m4a')).toBe('mp4');
    expect(formatFromContainer('matroska,webm')).toBe('mkv');
    expect(formatFromContainer('wav')).toBe('wav');
  });

  it('rejects a file with no video stream', () => {
    expect(() => parseFfprobeJson(JSON.stringify({ format: {}, streams: [] }))).toThrow(/no video stream/);
  });

  it('rejects non-JSON output', () => {
    expect(() => parseFfprobeJson('not json')).toThrow(/non-JSON/);
  });
});

describe('retry queue', () => {
  it('backs off exponentially with full jitter', () => {
    const ceiling = (attempt: number): number =>
      computeBackoffDelay(attempt, { baseDelayMs: 100, maxDelayMs: 1000, jitter: false });
    expect(ceiling(0)).toBe(100);
    expect(ceiling(1)).toBe(200);
    expect(ceiling(2)).toBe(400);
    expect(ceiling(5)).toBe(1000);
    const jittered = computeBackoffDelay(3, { baseDelayMs: 100, maxDelayMs: 1000, jitter: true }, () => 0.5);
    expect(jittered).toBe(400);
  });

  it('retries a retryable failure and succeeds', async () => {
    let attempts = 0;
    const value = await withRetry(
      'flaky',
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new ShortformError('boom', { code: 'NETWORK', retryable: true });
        }
        return 'ok';
      },
      { attempts: 4, sleep: async () => undefined, baseDelayMs: 1 },
    );
    expect(value).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry a non-retryable failure', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        'auth',
        async () => {
          attempts += 1;
          throw new ShortformError('expired token', { code: 'PLATFORM', retryable: false });
        },
        { attempts: 4, sleep: async () => undefined },
      ),
    ).rejects.toThrow(/expired token/);
    expect(attempts).toBe(1);
  });
});

describe('token bucket', () => {
  it('meters publishes against the daily quota', () => {
    let now = 0;
    const bucket = new TokenBucket(2, 1 / 1000, () => now);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
    expect(bucket.msUntil()).toBe(1000);
    now = 1000;
    expect(bucket.tryConsume()).toBe(true);
  });
});
