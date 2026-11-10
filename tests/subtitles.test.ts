import { describe, expect, it } from 'vitest';
import {
  buildCues,
  buildSubtitleBundle,
  buildAss,
  buildSrt,
  buildVtt,
  wrapCueWords,
} from '../src/services/audioEngine';
import { formatAssTime, formatSrtTime, formatVttTime, toCentiseconds } from '../src/lib/timecode';
import { measureTextPx, wrapText } from '../src/lib/text';
import type { WordTiming } from '../src/types/audio';

function words(spec: Array<[string, number, number]>): WordTiming[] {
  return spec.map(([text, startSec, endSec], index) => ({
    index,
    text,
    startSec,
    endSec,
    emphasis: false,
    sceneId: 's1',
  }));
}

describe('timecode formatting', () => {
  it('formats SRT with a comma before milliseconds', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(61.5)).toBe('00:01:01,500');
    expect(formatSrtTime(3723.045)).toBe('01:02:03,045');
  });

  it('formats WebVTT with a dot', () => {
    expect(formatVttTime(2.25)).toBe('00:00:02.250');
  });

  it('formats ASS with centiseconds', () => {
    expect(formatAssTime(2.259)).toBe('0:00:02.25');
    expect(formatAssTime(75)).toBe('0:01:15.00');
  });

  it('never emits a zero karaoke duration', () => {
    expect(toCentiseconds(0)).toBe(1);
    expect(toCentiseconds(0.5)).toBe(50);
  });
});

describe('line breaking', () => {
  it('fits Korean text into two balanced lines', () => {
    const lines = wrapText('주방수납 하나만 바꾸면 됩니다', {
      maxWidthPx: 760,
      fontSizePx: 96,
      maxLines: 2,
    });
    expect(lines).toEqual(['주방수납 하나만', '바꾸면 됩니다']);
  });

  it('keeps every multi-word line inside the pixel box', () => {
    const lines = wrapText('작은 주방은 수납장을 늘리는 게 답이 아닙니다', {
      maxWidthPx: 760,
      fontSizePx: 96,
      maxLines: 2,
    });
    for (const line of lines) {
      expect(measureTextPx(line, 96)).toBeLessThanOrEqual(760);
    }
    // The text needs three lines at this width; reporting that lets the cue
    // builder split the card instead of squeezing the words.
    expect(lines.length).toBe(3);
  });

  it('prefers the fewest lines that fit', () => {
    const lines = wrapText('짧은 문장입니다', { maxWidthPx: 760, fontSizePx: 96, maxLines: 2 });
    expect(lines).toHaveLength(1);
  });

  it('hard-splits a single word that is wider than the box', () => {
    const lines = wrapText('수퍼칼리프래질리스틱엑스피알리도우셔스', {
      maxWidthPx: 300,
      fontSizePx: 96,
      maxLines: 3,
    });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('수퍼칼리프래질리스틱엑스피알리도우셔스');
  });

  it('counts Korean glyphs as one em and latin as narrower', () => {
    expect(measureTextPx('가나다', 100)).toBeCloseTo(300, 5);
    expect(measureTextPx('iii', 100)).toBeLessThan(300);
  });
});

describe('cue grouping', () => {
  it('keeps a short hook on one card', () => {
    const cues = buildCues(words([['주방수납', 0, 0.74], ['하나만', 0.74, 1.3], ['바꾸면', 1.3, 1.85], ['됩니다', 1.85, 2.41]]), {
      maxWidthPx: 760,
    });
    expect(cues).toHaveLength(1);
    expect(cues[0]?.lines).toEqual(['주방수납 하나만', '바꾸면 됩니다']);
  });

  it('respects the maximum cue duration', () => {
    const long = words([
      ['하나', 0, 1],
      ['둘', 1, 2],
      ['셋', 2, 3.4],
      ['넷', 3.4, 4.6],
    ]);
    const cues = buildCues(long, { config: { maxCueSec: 2 } });
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.endSec - cue.startSec).toBeLessThanOrEqual(2.05);
    }
  });

  it('breaks a cue at a sentence boundary', () => {
    const sentence = words([
      ['첫째,', 0, 0.6],
      ['기준을', 0.6, 1.2],
      ['줄입니다.', 1.2, 1.9],
      ['둘째,', 1.9, 2.5],
      ['예외는', 2.5, 3.1],
      ['없습니다.', 3.1, 3.8],
    ]);
    const cues = buildCues(sentence, { config: { maxCueSec: 5 } });
    expect(cues.length).toBe(2);
    expect(cues[0]?.lines.join(' ')).toContain('줄입니다');
    expect(cues[0]?.sentenceEnd).toBe(true);
  });

  it('does not orphan a single trailing word', () => {
    const long = words([
      ['먼저', 0, 0.4],
      ['일주일', 0.4, 0.9],
      ['동안', 0.9, 1.3],
      ['한', 1.3, 1.5],
      ['번도', 1.5, 1.9],
      ['꺼내지', 1.9, 2.4],
      ['않은', 2.4, 2.8],
      ['물건을', 2.8, 3.3],
      ['바구니에', 3.3, 3.9],
      ['담아보세요.', 3.9, 4.6],
    ]);
    const cues = buildCues(long, { maxWidthPx: 760 });
    for (const cue of cues) {
      expect(cue.words.length).toBeGreaterThan(1);
    }
  });

  it('maps words onto the lines they are drawn on', () => {
    const wrapped = wrapCueWords(
      words([['주방수납', 0, 0.7], ['하나만', 0.7, 1.2], ['바꾸면', 1.2, 1.7], ['됩니다', 1.7, 2.2]]),
      760,
      96,
      2,
    );
    expect(wrapped.lines).toHaveLength(2);
    expect(wrapped.wordLine).toEqual([0, 0, 1, 1]);
  });
});

describe('subtitle serialisation', () => {
  const cues = buildCues(
    words([
      ['주방수납', 0, 1],
      ['하나만', 1, 2],
      ['바꾸면', 2, 3],
      ['됩니다', 3, 4],
    ]),
    { maxWidthPx: 760 },
  );

  it('writes sequential SRT blocks', () => {
    const srt = buildSrt(cues);
    expect(srt).toMatch(/^1\n00:00:00,000 --> 00:00:0\d,\d{3}\n/);
    expect(srt.trim().split('\n\n')).toHaveLength(cues.length);
  });

  it('writes a WebVTT header', () => {
    expect(buildVtt(cues).startsWith('WEBVTT\n\n')).toBe(true);
  });

  it('uses karaoke fill tags in sweep mode', () => {
    const ass = buildAss(cues, { mode: 'sweep' }, { centerX: 540, baselineY: 1300, maxWidthPx: 760 });
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('\\kf');
    expect(ass).toContain('PlayResX: 1080');
  });

  it('emits one highlighted event per word in pulse mode', () => {
    const ass = buildAss(cues, { mode: 'pulse' }, { centerX: 470, baselineY: 1396, maxWidthPx: 760 });
    const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(cues.reduce((sum, cue) => sum + cue.words.length, 0));
    expect(ass).toContain('\\c&H0000D4FF'); // highlight colour in BGR
    expect(ass).toContain('\\pos(470,1396)');
  });

  it('never lets a brace from the script break an override block', () => {
    const cue = buildCues(words([['{테스트}', 0, 1]]), { maxWidthPx: 760 });
    const ass = buildAss(cue);
    expect(ass).toContain('(테스트)');
  });

  it('reports readable statistics', () => {
    const bundle = buildSubtitleBundle(cues);
    expect(bundle.stats.cueCount).toBe(cues.length);
    expect(bundle.stats.wordCount).toBe(4);
    expect(bundle.stats.maxCps).toBeGreaterThan(0);
  });
});
