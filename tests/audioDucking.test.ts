import { describe, expect, it } from 'vitest';
import {
  buildMixFilter,
  buildVolumeExpression,
  computeDuckingEnvelope,
  envelopeToCsv,
  sampleEnvelope,
} from '../src/services/audioEngine';
import { estimateWordTimings, mergeVoiceSegments } from '../src/lib/align';

const CONFIG = {
  duckGain: 0.15,
  baseGain: 0.55,
  attackMs: 120,
  releaseMs: 280,
  minGapMs: 180,
  maxGain: 0.55,
  minVoiceMs: 40,
};

describe('audio ducking envelope', () => {
  it('drops to 15% under the voice and returns to 55% in a long gap', () => {
    const envelope = computeDuckingEnvelope({
      segments: [
        { startSec: 1, endSec: 2 },
        { startSec: 2.5, endSec: 4 },
      ],
      durationSec: 5,
      config: CONFIG,
    });

    expect(sampleEnvelope(envelope, 0.5)).toBeCloseTo(0.55, 3);
    expect(sampleEnvelope(envelope, 1.06)).toBeCloseTo(0.35, 2); // mid-attack
    expect(sampleEnvelope(envelope, 1.5)).toBeCloseTo(0.15, 3);
    expect(sampleEnvelope(envelope, 2.0)).toBeCloseTo(0.15, 3);
    expect(sampleEnvelope(envelope, 2.28)).toBeCloseTo(0.55, 3);
  });

  it('never holds a gain above the configured music bed', () => {
    const envelope = computeDuckingEnvelope({
      segments: [{ startSec: 1, endSec: 3 }],
      durationSec: 4,
      config: CONFIG,
    });
    for (const frame of envelope.keyframes) {
      expect(frame.gain).toBeLessThanOrEqual(0.55 + 1e-9);
      expect(frame.gain).toBeGreaterThanOrEqual(0.15 - 1e-9);
    }
  });

  it('honours the attack and release ramp durations', () => {
    const envelope = computeDuckingEnvelope({
      segments: [{ startSec: 1, endSec: 2 }],
      durationSec: 4,
      config: CONFIG,
    });
    const times = envelope.keyframes.map((frame) => frame.tSec);
    expect(times).toContain(1.12); // attack end
    expect(times).toContain(2.28); // release end
  });

  it('does not release into a short gap (no pumping)', () => {
    const envelope = computeDuckingEnvelope({
      segments: [
        { startSec: 1, endSec: 2 },
        { startSec: 2.1, endSec: 3 },
      ],
      durationSec: 4,
      config: CONFIG,
    });
    expect(sampleEnvelope(envelope, 2.05)).toBeCloseTo(0.15, 3);
    expect(sampleEnvelope(envelope, 2.1)).toBeCloseTo(0.15, 3);
    expect(sampleEnvelope(envelope, 3.3)).toBeCloseTo(0.55, 3);
  });

  it('ignores blips shorter than the minimum voice length', () => {
    const envelope = computeDuckingEnvelope({
      segments: [{ startSec: 1, endSec: 1.02 }],
      durationSec: 3,
      config: CONFIG,
    });
    expect(envelope.mergedVoiceSegments).toBe(0);
    expect(sampleEnvelope(envelope, 1)).toBeCloseTo(0.55, 3);
  });

  it('merges overlapping or adjacent words into one duck', () => {
    const merged = mergeVoiceSegments(
      [
        { startSec: 0, endSec: 0.3 },
        { startSec: 0.35, endSec: 0.6 },
        { startSec: 2, endSec: 2.4 },
      ],
      { minGapSec: 0.12 },
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ startSec: 0, endSec: 0.6 });
  });

  it('reports the share of the track that is ducked', () => {
    const envelope = computeDuckingEnvelope({
      segments: [
        { startSec: 0, endSec: 2 },
        { startSec: 2.5, endSec: 4 },
      ],
      durationSec: 4,
      config: CONFIG,
    });
    expect(envelope.duckedRatio).toBeGreaterThan(0.5);
    expect(envelope.duckedRatio).toBeLessThanOrEqual(1);
  });

  it('keeps keyframes strictly ordered and inside the track', () => {
    const envelope = computeDuckingEnvelope({
      segments: [
        { startSec: 0.5, endSec: 1.2 },
        { startSec: 1.4, endSec: 1.9 },
        { startSec: 2.2, endSec: 2.4 },
      ],
      durationSec: 3,
      config: CONFIG,
    });
    let previous = -1;
    for (const frame of envelope.keyframes) {
      expect(frame.tSec).toBeGreaterThan(previous);
      expect(frame.tSec).toBeLessThanOrEqual(3);
      previous = frame.tSec;
    }
  });
});

describe('ffmpeg volume expression', () => {
  it('builds a piecewise expression whose endpoints match the envelope', () => {
    const envelope = computeDuckingEnvelope({
      segments: [{ startSec: 1, endSec: 2 }],
      durationSec: 4,
      config: CONFIG,
    });
    const expression = buildVolumeExpression(envelope);
    expect(expression.startsWith('if(lt(t,')).toBe(true);
    // Constant gain regions appear as literals.
    expect(expression).toContain('0.15');
    // Interpolation slopes for both ramps are present.
    expect(expression).toMatch(/\(t-1\.?1?2?\)/);
  });

  it('quotes the expression inside the mix filter so commas stay literal', () => {
    const envelope = computeDuckingEnvelope({
      segments: [{ startSec: 1, endSec: 2 }],
      durationSec: 4,
      config: CONFIG,
    });
    const filter = buildMixFilter({
      durationSec: 4,
      voiceInputLabel: '0:a',
      musicInputLabel: '1:a',
      envelope,
    });
    expect(filter).toContain("volume=eval=frame:volume='if(");
    expect(filter).toContain('[vpad][mduck]amix=inputs=2');
    expect(filter).toContain('loudnorm=I=-14');
  });

  it('exposes the envelope as CSV for review', () => {
    const envelope = computeDuckingEnvelope({
      segments: [{ startSec: 1, endSec: 2 }],
      durationSec: 3,
      config: CONFIG,
    });
    const csv = envelopeToCsv(envelope).split('\n');
    expect(csv[0]).toBe('time_sec,gain');
    expect(csv.length).toBe(envelope.keyframes.length + 1);
  });
});

describe('word alignment', () => {
  it('lands the last word exactly on the audio end', () => {
    const timings = estimateWordTimings('주방수납 하나만 바꾸면 됩니다', 2.4);
    expect(timings).toHaveLength(4);
    expect(timings[timings.length - 1]?.endSec).toBeCloseTo(2.4, 2);
  });

  it('keeps word spans monotonic and above the readability floor', () => {
    const timings = estimateWordTimings('가 나 다 라 마 바 사 아 자 차', 3);
    for (let i = 1; i < timings.length; i += 1) {
      const previous = timings[i - 1]!;
      const current = timings[i]!;
      expect(current.startSec).toBeGreaterThanOrEqual(previous.endSec - 0.001);
      expect(current.endSec - current.startSec).toBeGreaterThanOrEqual(0.059);
    }
  });

  it('gives longer words more time than short ones', () => {
    const timings = estimateWordTimings('짧게 아주아주길게', 4);
    const short = timings[0]!;
    const long = timings[1]!;
    expect(long.endSec - long.startSec).toBeGreaterThan(short.endSec - short.startSec);
  });

  it('returns nothing for empty input', () => {
    expect(estimateWordTimings('   ', 2)).toEqual([]);
  });
});
