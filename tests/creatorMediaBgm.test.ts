import { describe, expect, it } from 'vitest';
import { BGM_LOOPS, bgmLabel, midiToFreq, notesForLoop } from '../web/model/creator/bgm';
import { buildPostCaption, suggestHashtags, DEFAULT_HASHTAGS } from '../web/model/creator/caption';
import { disclosureOf, makeCut } from '../web/model/creator/types';
import { RECORDER_CANDIDATES, fileKind, formatBytes, pickRecorderMime, videoFrameTime } from '../web/model/creator/media';
import { codecNotice, videoFileName } from '../web/model/creator/videoExport';

describe('내장 BGM', () => {
  it('세 가지 루프 모두 영상 길이 안에서 음을 만든다', () => {
    for (const loop of BGM_LOOPS) {
      const notes = notesForLoop(loop.id, 12);
      expect(notes.length).toBeGreaterThan(loop.bpm > 100 ? 30 : 10);
      for (const note of notes) {
        expect(note.timeSec).toBeGreaterThanOrEqual(0);
        expect(note.timeSec).toBeLessThan(12);
        expect(note.timeSec + note.durationSec).toBeLessThanOrEqual(12.001);
        expect(note.freq).toBeGreaterThan(20);
        expect(note.freq).toBeLessThan(2000);
        expect(note.gain).toBeGreaterThan(0);
      }
      // 시간순으로 정렬돼 있어야 스케줄러가 한 번에 예약할 수 있다.
      const times = notes.map((note) => note.timeSec);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it('길이가 늘면 음도 늘고, 0초면 아무것도 만들지 않는다', () => {
    const short = notesForLoop('calm', 4).length;
    const long = notesForLoop('calm', 16).length;
    expect(long).toBeGreaterThan(short);
    expect(notesForLoop('calm', 0)).toEqual([]);
    expect(notesForLoop('none', 10)).toEqual([]);
    expect(notesForLoop('file', 10)).toEqual([]);
  });

  it('음이름·라벨', () => {
    expect(midiToFreq(69)).toBe(440);
    expect(midiToFreq(60)).toBeCloseTo(261.63, 1);
    expect(bgmLabel('upbeat')).toBe('경쾌');
    expect(bgmLabel('file')).toBe('내 오디오');
  });
});

describe('게시물 캡션', () => {
  const cuts = [
    makeCut({ caption: '3평 주방, 이렇게 바꿨어요', note: '부산 신혼집 3평 주방입니다.' }),
    makeCut({ caption: '문 안쪽 10cm', note: '문 안쪽에 얇은 선반을 달았습니다.' }),
    makeCut({ caption: '저장해두세요', note: '오늘은 한 칸만 비워도 충분합니다.' }),
  ];

  it('첫 문장·설명·공정위 문구·해시태그·핸들이 순서대로 들어간다', () => {
    const caption = buildPostCaption({
      cuts,
      disclosure: disclosureOf('sponsored'),
      handle: '@shye',
      hashtags: ['#주방수납', '#신혼집'],
    });
    expect(caption).toContain('3평 주방, 이렇게 바꿨어요');
    expect(caption).toContain('· 문 안쪽에 얇은 선반을 달았습니다.');
    expect(caption).toContain('업체로부터 제품을 제공받아');
    expect(caption).toContain('#주방수납 #신혼집');
    expect(caption.trim().endsWith('@shye')).toBe(true);
  });

  it('표기 없음이면 공정위 문장을 넣지 않는다', () => {
    const caption = buildPostCaption({ cuts, disclosure: disclosureOf('none'), handle: '@shye', hashtags: [] });
    expect(caption).not.toContain('제공받아');
    expect(caption).not.toContain('#');
  });

  it('2,200자를 넘지 않는다', () => {
    const long = Array.from({ length: 12 }, (_, index) => makeCut({ caption: `컷 ${index}`, note: '가'.repeat(600) }));
    const caption = buildPostCaption({ cuts: long, disclosure: disclosureOf('none'), handle: '@shye' });
    expect(caption.length).toBeLessThanOrEqual(2200);
    expect(caption.endsWith('…')).toBe(true);
  });

  it('주제에서 해시태그를 제안한다', () => {
    const tags = suggestHashtags('부산 신혼집 주방 수납');
    expect(tags).toContain('#부산');
    expect(tags).toContain('#주방');
    for (const tag of DEFAULT_HASHTAGS) expect(tags).toContain(tag);
    expect(tags.length).toBeLessThanOrEqual(30);
  });
});

describe('녹화 형식·파일', () => {
  it('브라우저가 지원하는 첫 코덱을 고르고, 아무것도 없으면 기본값으로 둔다', () => {
    const all = pickRecorderMime(() => true);
    expect(all.mimeType).toBe(RECORDER_CANDIDATES[0]!.mimeType);
    expect(all.container).toBe('mp4');

    const webmOnly = pickRecorderMime((type) => type.startsWith('video/webm'));
    expect(webmOnly.container).toBe('webm');
    expect(webmOnly.mimeType).toContain('vp9');

    const none = pickRecorderMime(() => false);
    expect(none.mimeType).toBe('');
    expect(none.label).toBe('브라우저 기본');
  });

  it('코덱 안내는 저장 형식을 그대로 말한다', () => {
    expect(codecNotice(() => true)).toContain('MP4');
    expect(codecNotice((type) => type.startsWith('video/webm'))).toContain('WebM');
  });

  it('파일 종류는 MIME이 없어도 확장자로 판단한다', () => {
    expect(fileKind({ type: 'image/png', name: 'a.png' })).toBe('image');
    expect(fileKind({ type: '', name: 'b.MP4' })).toBe('video');
    expect(fileKind({ type: 'application/pdf', name: 'c.pdf' })).toBe('other');
  });

  it('결과 파일 이름은 컨테이너 확장자를 따르고 한글 제목을 지킨다', () => {
    expect(videoFileName('3평 주방', 'mp4', new Date(2026, 10, 22))).toBe('3평 주방_20261122.mp4');
    expect(videoFileName('3평/주방:', 'webm', new Date(2026, 10, 22))).toBe('3평 주방_20261122.webm');
  });

  it('영상 컷 프레임 시각은 영상 길이를 넘지 않고 반복된다', () => {
    expect(videoFrameTime(0, 1.2, 3)).toBeCloseTo(1.2, 3);
    expect(videoFrameTime(1, 2.5, 3)).toBeCloseTo(0.5, 3);
    expect(videoFrameTime(0, 9, 3)).toBeCloseTo(0, 3);
  });

  it('바이트 표기', () => {
    expect(formatBytes(0)).toBe('0KB');
    expect(formatBytes(2048)).toBe('2KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0MB');
  });
});
