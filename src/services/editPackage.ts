import type { Cue } from '../types/audio';
import type { Scene } from '../types/script';

/**
 * 편집 패키지 — 대본 하나에서 자막(.srt)과 컷 타임시트(.csv/.txt)를 만들어
 * 브라우저에서 zip 하나로 내려받는다.
 *
 * 왜 서버가 아니라 브라우저인가: 스튜디오가 이미 타임라인과 자막 큐를 계산해
 * 들고 있다. 같은 계산을 서버에 다시 시키면 두 결과가 어긋날 수 있고, 렌더 전
 * 편집 단계에서 파일이 필요할 뿐 업로드할 것은 없다.
 *
 * zip은 압축 없이(store) 직접 쓴다. 의존성을 더하지 않으려는 것도 있지만,
 * 텍스트 파일 두세 개는 deflate 이득이 거의 없고, CRC만 맞으면 어떤 편집기든
 * 연다. 파일 이름은 UTF-8 플래그(0x0800)를 세워 한글이 깨지지 않게 한다.
 */

export interface EditPackageFile {
  /** zip 안의 경로. 한글 파일명은 UTF-8 플래그로 기록한다. */
  name: string;
  content: string;
}

export interface EditPackageInput {
  /** 파일 이름에 쓰는 제목. 파일 시스템에서 못 쓰는 문자는 치환한다. */
  title: string;
  scenes: Scene[];
  cues: Cue[];
  /** 내보낼 때 기록할 시각(테스트에서 고정). */
  now?: Date;
}

export interface EditPackage {
  baseName: string;
  files: EditPackageFile[];
  zip: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 (ZIP 표준). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 00:00:02,170 — SRT가 요구하는 형식. */
export function srtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hour = Math.floor(totalSec / 3600);
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  return `${pad(hour)}:${pad(min)}:${pad(sec)},${pad(ms, 3)}`;
}

/** 00:02.17 — 사람이 읽는 타임시트용. */
export function sheetTime(seconds: number): string {
  // 0.345초는 이진 부동소수에서 34.4999…가 된다. 100분의 1초로 먼저 반올림해야
  // 타임시트와 SRT(밀리초)가 같은 시각을 가리킨다.
  const centis = Math.round(Math.max(0, seconds) * 100);
  const min = Math.floor(centis / 6000);
  const rest = centis - min * 6000;
  const sec = Math.floor(rest / 100);
  const cs = rest - sec * 100;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * 자막 파일. 큐는 이미 읽기 속도(22자/초)와 두 줄 상한으로 쪼개져 있으므로
 * 여기서 다시 줄을 나누지 않는다 — 미리보기에서 본 카드가 그대로 파일이 된다.
 */
export function buildSubtitleSrt(cues: readonly Cue[]): string {
  return cues
    .filter((cue) => cue.lines.some((line) => line.trim() !== ''))
    .map((cue, index) => {
      const text = cue.lines.join('\n');
      return `${index + 1}\n${srtTime(cue.startSec)} --> ${srtTime(cue.endSec)}\n${text}`;
    })
    .join('\n\n')
    .concat('\n');
}

function csvCell(value: string): string {
  const text = value.replace(/\r?\n/g, ' ').trim();
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 컷 타임시트(CSV). 편집 프로그램으로 다시 옮길 때 쓰는 표다.
 * 씬 단위 컷 + 같은 구간의 화면 자막·촬영 메모를 한 줄에 둔다.
 */
export function buildCutSheetCsv(scenes: readonly Scene[]): string {
  const header = ['#', '비트', '시작', '끝', '길이(초)', '발화(초)', '화면 자막', '나레이션', '촬영·컷 메모'];
  const rows = scenes.map((scene) => [
    String(scene.index + 1),
    scene.beat,
    sheetTime(scene.startSec),
    sheetTime(scene.startSec + scene.durationSec),
    scene.durationSec.toFixed(2),
    scene.estimatedSpeechSec.toFixed(2),
    scene.onScreenText ?? '',
    scene.narration,
    scene.visual ?? '',
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n').concat('\n');
}

/** 편집자에게 주는 사람용 타임시트. 같은 내용을 눈으로 훑기 좋게. */
export function buildCutSheetTxt(scenes: readonly Scene[], title: string): string {
  const lines: string[] = [
    `# ${title}`,
    `총 ${scenes.length}컷 · ${scenes.at(-1) ? sheetTime((scenes.at(-1)?.startSec ?? 0) + (scenes.at(-1)?.durationSec ?? 0)) : '00:00.00'}`,
    '',
  ];
  for (const scene of scenes) {
    lines.push(
      `[${scene.index + 1}] ${scene.beat.toUpperCase()} ${sheetTime(scene.startSec)}–${sheetTime(scene.startSec + scene.durationSec)} (${scene.durationSec.toFixed(2)}s)`,
    );
    lines.push(`  나레이션: ${scene.narration}`);
    if (scene.onScreenText) lines.push(`  화면 자막: ${scene.onScreenText}`);
    if (scene.visual) lines.push(`  컷: ${scene.visual}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function safeBaseName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned.length > 0 ? cleaned : 'shortform').slice(0, 60);
}

interface ZipEntryInput {
  name: string;
  bytes: Uint8Array;
}

function dosDateTime(now: Date): { time: number; date: number } {
  // ZIP은 1980년부터 센다. 초는 2초 단위.
  const year = Math.max(1980, now.getFullYear());
  const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  return { time, date };
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 압축 없이(store) ZIP을 만든다. 텍스트 몇 개에는 deflate 이득이 없다. */
export function buildZip(entries: readonly ZipEntryInput[], now: Date = new Date()): Uint8Array {
  const { time, date } = dosDateTime(now);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8(entry.name);
    const crc = crc32(entry.bytes);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 파일 이름
    localView.setUint16(8, 0, true); // store
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    locals.push(local, entry.bytes);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.bytes.length, true);
    centralView.setUint32(24, entry.bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true); // extra
    centralView.setUint16(32, 0, true); // comment
    centralView.setUint16(34, 0, true); // disk
    centralView.setUint16(36, 0, true); // internal attrs
    centralView.setUint32(38, 0, true); // external attrs
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + entry.bytes.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const total = offset + centralSize + end.length;
  const zip = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    zip.set(part, cursor);
    cursor += part.length;
  }
  return zip;
}

export function buildEditPackage(input: EditPackageInput): EditPackage {
  const baseName = safeBaseName(input.title);
  const files: EditPackageFile[] = [
    { name: `${baseName}.srt`, content: buildSubtitleSrt(input.cues) },
    { name: `${baseName}_컷타임시트.csv`, content: buildCutSheetCsv(input.scenes) },
    { name: `${baseName}_컷타임시트.txt`, content: buildCutSheetTxt(input.scenes, input.title) },
  ];
  const zip = buildZip(
    files.map((file) => ({ name: file.name, bytes: utf8(file.content) })),
    input.now ?? new Date(),
  );
  return { baseName, files, zip };
}

/** 다운로드 파일 이름. 스튜디오 제목 + 날짜. */
export function editPackageFileName(baseName: string, now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `${baseName}_편집패키지_${stamp}.zip`;
}
