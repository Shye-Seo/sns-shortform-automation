import { countSyllables, tokenizeWords } from './text';
import type { Language } from '../types/script';
import type { WordTiming } from '../types/audio';

/**
 * A word is never allowed to flash for less than this. Anything shorter reads
 * as flicker rather than as a highlight.
 */
export const MIN_WORD_SEC = 0.06;

export interface AlignOptions {
  language?: Language;
  /** Minimum on-screen time per word. */
  minWordSec?: number;
}

/**
 * Distribute a known audio duration across the words of a line.
 *
 * TTS providers that return real alignment use `alignCharactersToWords`
 * instead; this is for providers that only return audio (OpenAI TTS) and for
 * the synthetic voice used in CI. Weights combine syllable count with the
 * punctuation pause that follows each token, so a comma still breathes even
 * when the total duration is fixed.
 */
export function estimateWordTimings(
  text: string,
  durationSec: number,
  options: AlignOptions = {},
): WordTiming[] {
  const tokens = tokenizeWords(text);
  if (tokens.length === 0 || durationSec <= 0) return [];
  const minWordSec = options.minWordSec ?? MIN_WORD_SEC;

  const speechWeights = tokens.map((token) => Math.max(0.6, countSyllables(token.text)));
  const pauseWeights = tokens.map((token, index) =>
    index === tokens.length - 1 ? 0 : token.pauseSec,
  );
  const totalWeight =
    speechWeights.reduce((sum, weight) => sum + weight, 0) +
    pauseWeights.reduce((sum, weight) => sum + weight, 0);
  const scale = durationSec / totalWeight;

  let spans = speechWeights.map((weight) => weight * scale);
  let gaps = pauseWeights.map((weight) => weight * scale);

  // Borrow time for words that fell under the readability floor, taking it
  // proportionally from words that are comfortably above it.
  for (let pass = 0; pass < 4; pass += 1) {
    const shortfall = spans.reduce(
      (sum, span) => sum + Math.max(0, minWordSec - span),
      0,
    );
    if (shortfall <= 1e-6) break;
    const donorTotal = spans.reduce((sum, span) => sum + Math.max(0, span - minWordSec), 0);
    if (donorTotal <= 1e-6) break;
    spans = spans.map((span) => {
      if (span < minWordSec) return minWordSec;
      const donation = (Math.max(0, span - minWordSec) / donorTotal) * shortfall;
      return span - donation;
    });
    gaps = gaps.map((gap) => gap * (1 - shortfall / durationSec));
  }

  const total = spans.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  // Re-normalise so the last word lands exactly on the audio end.
  const fix = total > 0 ? durationSec / total : 1;
  spans = spans.map((span) => span * fix);
  gaps = gaps.map((gap) => gap * fix);

  const timings: WordTiming[] = [];
  let cursor = 0;
  tokens.forEach((token, index) => {
    const span = spans[index] as number;
    const startSec = cursor;
    const endSec = startSec + span;
    timings.push({
      index,
      text: token.text + token.punctuation,
      startSec: Math.round(startSec * 1000) / 1000,
      endSec: Math.round(endSec * 1000) / 1000,
      emphasis: false,
    });
    cursor = endSec + (gaps[index] as number);
  });

  return timings;
}

export interface CharacterAlignment {
  characters: string[];
  startTimes: number[];
  endTimes: number[];
}

/**
 * Convert ElevenLabs' character alignment into word spans. Providers give the
 * start/end of every character (including spaces), which is the only way to
 * get true word-level sync instead of an estimated division.
 */
export function alignCharactersToWords(
  text: string,
  alignment: CharacterAlignment,
): WordTiming[] {
  const timings: WordTiming[] = [];
  const chars = alignment.characters;
  let index = 0;
  let wordIndex = 0;
  let wordStart: number | null = null;
  let wordEnd = 0;
  const pushWord = (endIndex: number): void => {
    if (wordStart === null) return;
    timings.push({
      index: wordIndex,
      text: text.slice(wordStart, endIndex).trim(),
      startSec: round3(alignment.startTimes[wordStart] ?? 0),
      endSec: round3(wordEnd),
      emphasis: false,
    });
    wordIndex += 1;
    wordStart = null;
  };

  for (; index < chars.length; index += 1) {
    const char = chars[index] as string;
    const isSpace = /\s/u.test(char);
    if (isSpace) {
      pushWord(index);
      continue;
    }
    if (wordStart === null) wordStart = index;
    wordEnd = alignment.endTimes[index] ?? wordEnd;
  }
  pushWord(chars.length);
  return timings.filter((timing) => timing.text.length > 0);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Merge word timings into continuous speech segments. A 40ms gap between two
 * words is not a pause in the music sense — ducking on it makes the bed pump.
 */
export function mergeVoiceSegments(
  words: Array<{ startSec: number; endSec: number }>,
  options: { minGapSec?: number; minSegmentSec?: number } = {},
): Array<{ startSec: number; endSec: number }> {
  const minGapSec = options.minGapSec ?? 0.12;
  const minSegmentSec = options.minSegmentSec ?? 0;
  const sorted = [...words]
    .filter((word) => word.endSec > word.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  const merged: Array<{ startSec: number; endSec: number }> = [];
  for (const word of sorted) {
    const last = merged[merged.length - 1];
    if (last && word.startSec - last.endSec <= minGapSec) {
      last.endSec = Math.max(last.endSec, word.endSec);
    } else {
      merged.push({ startSec: word.startSec, endSec: word.endSec });
    }
  }
  return merged.filter((segment) => segment.endSec - segment.startSec >= minSegmentSec);
}
