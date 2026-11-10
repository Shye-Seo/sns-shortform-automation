import { stableHash } from './ids';
import { countSyllables } from './text';
import { estimateWordTimings } from './align';
import type { Language } from '../types/script';

export const WAV_HEADER_BYTES = 44;

/**
 * Encode mono float samples as 16-bit PCM WAV. The synthetic voice exists so
 * the whole pipeline (alignment, ducking, subtitle sync, render plan) can be
 * exercised in CI without an ffmpeg binary or a TTS subscription.
 */
export function encodeWavPcm16(
  samples: Float32Array,
  sampleRate: number,
  channels = 1,
): Buffer {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    buffer.writeInt16LE(Math.round(clamped * 32767), WAV_HEADER_BYTES + i * bytesPerSample);
  }
  return buffer;
}

export interface SynthVoiceOptions {
  sampleRate?: number;
  language?: Language;
  /** Voice pitch centre in Hz. */
  pitchHz?: number;
  amplitude?: number;
}

/**
 * Build a deterministic "voice" track: one pitched burst per syllable, with an
 * attack/decay envelope and a small pitch drift per word. It is not a human
 * voice — it is a fixture that occupies exactly the time the script budgets.
 */
export function synthesizeVoiceWav(
  text: string,
  durationSec: number,
  options: SynthVoiceOptions = {},
): { buffer: Buffer; words: ReturnType<typeof estimateWordTimings> } {
  const sampleRate = options.sampleRate ?? 48_000;
  const language = options.language ?? 'ko';
  const pitch = options.pitchHz ?? 165;
  const amplitude = options.amplitude ?? 0.22;
  const totalSamples = Math.max(1, Math.ceil(durationSec * sampleRate));
  const samples = new Float32Array(totalSamples);
  const words = estimateWordTimings(text, durationSec, { language });

  words.forEach((word, wordIndex) => {
    const syllables = Math.max(1, countSyllables(word.text));
    const wordStart = Math.round(word.startSec * sampleRate);
    const wordEnd = Math.min(totalSamples, Math.round(word.endSec * sampleRate));
    const wordSamples = Math.max(1, wordEnd - wordStart);
    const syllableSamples = Math.max(1, Math.floor(wordSamples / syllables));
    const drift = (parseInt(stableHash(word.text, String(wordIndex)), 16) % 40) - 20;

    for (let s = 0; s < syllables; s += 1) {
      const start = wordStart + s * syllableSamples;
      const length = Math.min(syllableSamples, totalSamples - start);
      const f0 = pitch + drift + s * 3;
      for (let i = 0; i < length; i += 1) {
        const t = i / sampleRate;
        const progress = i / Math.max(1, length);
        // Fast attack, exponential decay: a plucked, speech-like envelope.
        const env = Math.min(1, progress * 18) * Math.exp(-progress * 3.1);
        const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t);
        const wave =
          Math.sin(2 * Math.PI * f0 * t * vibrato) * 0.7 +
          Math.sin(2 * Math.PI * f0 * 2 * t * vibrato) * 0.2 +
          Math.sin(2 * Math.PI * f0 * 3 * t * vibrato) * 0.1;
        const index = start + i;
        if (index < totalSamples) {
          samples[index] = (samples[index] as number) + wave * env * amplitude;
        }
      }
    }
  });

  return { buffer: encodeWavPcm16(samples, sampleRate), words };
}

/** Concatenate mono float arrays with silence padding at given offsets. */
export function mixAtOffsets(
  parts: Array<{ samples: Float32Array; offsetSec: number }>,
  totalDurationSec: number,
  sampleRate: number,
): Float32Array {
  const total = Math.max(1, Math.ceil(totalDurationSec * sampleRate));
  const out = new Float32Array(total);
  for (const part of parts) {
    const offset = Math.round(part.offsetSec * sampleRate);
    for (let i = 0; i < part.samples.length; i += 1) {
      const index = offset + i;
      if (index >= 0 && index < total) {
        out[index] = (out[index] as number) + (part.samples[i] as number);
      }
    }
  }
  return out;
}
