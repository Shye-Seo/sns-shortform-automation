import { describe, expect, it } from 'vitest';
import {
  buildCutSheetCsv,
  buildCutSheetTxt,
  buildEditPackage,
  buildSubtitleSrt,
  buildZip,
  crc32,
  editPackageFileName,
  safeBaseName,
  sheetTime,
  srtTime,
} from '../src/services/editPackage';
import { buildStudioModel, draftBeatScene } from '../web/model/studio';
import { editPackageFor } from '../web/model/editPackage';

/**
 * 편집 패키지는 "지금 화면에서 본 타임라인"을 그대로 파일로 옮긴 것이다.
 * 그래서 테스트도 모델을 거쳐 확인한다: 자막 큐 개수 = srt 블록 개수,
 * 컷 개수 = 타임시트 행 수, zip 안의 파일 = 3개.
 */

const TOPIC = '퇴사한 30대 개발자의 일상';

function model(): ReturnType<typeof buildStudioModel> {
  const drafts = draftBeatScene(TOPIC, 45, 0, 'auto');
  return buildStudioModel({ topic: TOPIC, durationSec: 45, speed: 1, language: 'ko', drafts, compress: true });
}

/** ZIP 중앙 디렉터리를 읽어 (이름, 내용) 목록을 돌려준다. */
function readZip(bytes: Uint8Array): Array<{ name: string; data: string; crc: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  // EOCD(0x06054b50)는 끝에서 22바이트(+주석 0).
  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  expect(eocd - centralOffset).toBe(centralSize);

  const entries: Array<{ name: string; data: string; crc: number }> = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const flags = view.getUint16(cursor + 8, true);
    expect(flags & 0x0800).toBe(0x0800); // UTF-8 이름
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const offset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    // 로컬 헤더의 이름 길이·데이터 위치
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(offset + 26, true);
    const dataStart = offset + 30 + localNameLength;
    const data = decoder.decode(bytes.subarray(dataStart, dataStart + size));
    entries.push({ name, data, crc });
    cursor += 46 + nameLength;
  }
  return entries;
}

describe('srt · 타임시트', () => {
  it('큐마다 SRT 블록을 만들고 시간이 올라간다', () => {
    const studio = model();
    const srt = buildSubtitleSrt(studio.cues);
    const blocks = srt.trim().split(/\n\n+/);

    expect(blocks).toHaveLength(studio.cues.length);
    expect(blocks[0]).toMatch(/^1\n00:00:00,\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/);
    let previousEnd = 0;
    for (const block of blocks) {
      const [, , start, end] = block.match(/^(\d+)\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/u) ?? [];
      expect(start, block).toBeTruthy();
      expect(end, block).toBeTruthy();
      const toSec = (value: string): number => {
        const [clock, ms] = value.split(',');
        const [h, m, s] = (clock ?? '').split(':').map(Number);
        return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0) + Number(ms) / 1000;
      };
      expect(toSec(start as string)).toBeGreaterThanOrEqual(previousEnd - 0.001);
      previousEnd = toSec(end as string);
    }
    expect(previousEnd).toBeLessThanOrEqual(studio.totalDurationSec + 0.05);
  });

  it('컷 타임시트는 씬마다 한 줄, 쉼표가 든 문장은 따옴표로 감싼다', () => {
    const studio = model();
    const csv = buildCutSheetCsv(studio.scenes);
    const rows = csv.trim().split('\n');
    expect(rows).toHaveLength(studio.scenes.length + 1);
    expect(rows[0]).toContain('비트,시작,끝');
    // 나레이션에 쉼표가 있으므로 그 줄은 인용부호로 시작하는 셀을 포함한다.
    expect(csv).toMatch(/"[^"]*,[^"]*"/);

    const txt = buildCutSheetTxt(studio.scenes, TOPIC);
    expect(txt).toContain(TOPIC);
    expect(txt).toContain('[1] HOOK');
    expect(txt).toContain('나레이션:');
  });

  it('시간 표기를 초 단위에서 정확히 만든다', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(62.345)).toBe('00:01:02,345');
    expect(srtTime(3661.5)).toBe('01:01:01,500');
    expect(sheetTime(62.345)).toBe('01:02.35');
  });
});

describe('zip 패키지', () => {
  it('세 파일을 담고 CRC가 내용과 맞는다', () => {
    const studio = model();
    const pkg = buildEditPackage({ title: TOPIC, scenes: studio.scenes, cues: studio.cues, now: new Date('2026-11-21T12:00:00+09:00') });

    expect(pkg.files).toHaveLength(3);
    const entries = readZip(pkg.zip);
    expect(entries.map((entry) => entry.name)).toEqual(pkg.files.map((file) => file.name));
    expect(entries.map((entry) => entry.data)).toEqual(pkg.files.map((file) => file.content));
    for (const entry of entries) {
      expect(entry.crc).toBe(crc32(new TextEncoder().encode(entry.data)));
    }
    expect(pkg.files[0]!.name.endsWith('.srt')).toBe(true);
    expect(pkg.files.some((file) => file.name.endsWith('.csv'))).toBe(true);
    expect(pkg.files.some((file) => file.name.endsWith('.txt'))).toBe(true);
  });

  it('파일 이름에 쓸 수 없는 문자를 지우고 날짜를 붙인다', () => {
    expect(safeBaseName('a/b:c*?"<>|d')).toBe('a b c d');
    expect(safeBaseName('   ')).toBe('shortform');
    expect(editPackageFileName('테스트', new Date('2026-11-21T12:00:00+09:00'))).toBe('테스트_편집패키지_20261121.zip');
  });

  it('빈 입력에서도 유효한 zip을 만든다', () => {
    const zip = buildZip([{ name: '빈.txt', bytes: new TextEncoder().encode('') }]);
    const entries = readZip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data).toBe('');
    expect(entries[0]!.crc).toBe(0);
  });

  it('스튜디오 모델에서 바로 패키지를 계산한다(다운로드 없이)', () => {
    const studio = model();
    const { pkg, summary } = editPackageFor(studio, new Date('2026-11-21T12:00:00+09:00'));

    expect(summary.cueCount).toBe(studio.cues.length);
    expect(summary.sceneCount).toBe(studio.scenes.length);
    expect(summary.files.every((file) => file.bytes > 0 && file.lines > 0)).toBe(true);
    expect(summary.fileName).toBe(`퇴사한 30대 개발자의 일상_편집패키지_20261121.zip`);
    expect(pkg.zip.length).toBe(summary.totalBytes);
  });
});
