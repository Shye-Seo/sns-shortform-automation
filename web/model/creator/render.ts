import { PLATFORM_UI_ZONES } from '../../../src/services/videoCompositor';
import type { Rect } from '../../../src/types/render';
import type { CreatorCut, DisclosureInfo } from './types';
import { kenBurnsAt } from './timeline';

/**
 * 9:16 프레임 한 장을 그리는 순수 함수.
 *
 * 왜 React가 아니라 Canvas 함수인가: 같은 함수가 (1) 미리보기, (2) MediaRecorder
 * 녹화, (3) 카드뉴스 미리보기에서 모두 호출된다. 화면과 결과 파일이 어긋날 수
 * 있는 지점을 한 곳으로 모으기 위해서다. CanvasRenderingContext2D의 부분집합만
 * 쓰므로 테스트에서는 호출을 기록하는 가짜 ctx로 검증할 수 있다.
 */

export const FRAME = { width: 1080, height: 1920 } as const;
export const CARD = { width: 1080, height: 1350 } as const;

const WHITE = '#ffffff';
const INK = '#11161c';
const BODY = '#414b57';
const MUTED = '#6d7683';
const FONT_STACK = '"Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif';

/** Canvas 2D에서 이 렌더러가 실제로 쓰는 부분만. */
export interface Paint2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
}

export interface FrameSpec {
  cut: CreatorCut;
  index: number;
  total: number;
  /** 컷 안에서의 진행률 0~1. */
  progress: number;
  /** 방금 넘어온 컷의 마지막 화면(전환용). */
  previous: CanvasImageSource | null;
  /** 전환 진행률 0~1. 1이면 전환 끝. */
  transition: number;
  /** 이 컷에 그릴 사진/영상 (없으면 그라데이션 자리). */
  media: CanvasImageSource | null;
  handle: string;
  badge: string;
  disclosure: DisclosureInfo;
  isLast: boolean;
  /** 미리보기에서만 켜는 안전영역 가이드. 녹화에는 절대 들어가지 않는다. */
  showGuides: boolean;
  /** 미리보기에서만 켜는 진행 바. */
  showProgress: boolean;
}

export interface CoverFit {
  scale: number;
  width: number;
  height: number;
  dx: number;
  dy: number;
}

/**
 * cover: 원본 비율을 유지한 채 대상 사각형을 꽉 채우는 배치.
 * 남는 쪽은 잘라낸다 — 9:16에 4:3 사진을 넣을 때 위아래가 아니라 좌우가 남는다.
 */
export function coverFit(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): CoverFit {
  const sw = sourceWidth > 0 ? sourceWidth : targetWidth;
  const sh = sourceHeight > 0 ? sourceHeight : targetHeight;
  const scale = Math.max(targetWidth / sw, targetHeight / sh);
  const width = sw * scale;
  const height = sh * scale;
  return { scale, width, height, dx: (targetWidth - width) / 2, dy: (targetHeight - height) / 2 };
}

/**
 * 켄 번스를 적용한 최종 사각형. 확대 배율만큼만 이동해 가장자리에 배경이 비지 않는다.
 */
export function kenBurnsRect(fit: CoverFit, frame: { scale: number; panX: number; panY: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const width = fit.width * frame.scale;
  const height = fit.height * frame.scale;
  const slackX = Math.max(0, (width - fit.width) / 2);
  const slackY = Math.max(0, (height - fit.height) / 2);
  return {
    x: fit.dx - slackX * frame.panX,
    y: fit.dy - slackY * frame.panY,
    width,
    height,
  };
}

/**
 * 공백 기준 줄바꿈. 한 단어가 폭보다 길면 글자 단위로 쪼갠다.
 * 줄 수를 넘기면 마지막 줄에 말줄임표를 붙이고, 그때는 잘라낸 사실을 호출부가
 * 글자 수로 알 수 있다(레이아웃이 글자 크기를 줄일지 판단하는 근거).
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  measure: (line: string) => number,
  maxLines = 3,
): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '' || maxLines <= 0) return [];
  const tokens = clean.split(' ');
  const lines: string[] = [];
  let current = '';
  let truncated = false;

  const flush = (): void => {
    if (current !== '') {
      lines.push(current);
      current = '';
    }
  };

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex]!;
    const candidate = current === '' ? token : `${current} ${token}`;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    flush();
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }

    if (measure(token) <= maxWidth) {
      current = token;
      continue;
    }

    const pieces = breakByChar(token, maxWidth, measure);
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const piece = pieces[pieceIndex]!;
      if (pieceIndex === pieces.length - 1) {
        current = piece;
        break;
      }
      lines.push(piece);
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  flush();
  const clipped = lines.slice(0, maxLines);
  if (truncated || lines.length > maxLines) {
    const last = clipped[clipped.length - 1] ?? '';
    clipped[clipped.length - 1] = last.endsWith('…') ? last : `${last}…`;
  }
  return clipped;
}

function breakByChar(token: string, maxWidth: number, measure: (line: string) => number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const char of token) {
    const candidate = current + char;
    if (current !== '' && measure(candidate) > maxWidth) {
      pieces.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current !== '') pieces.push(current);
  return pieces.length > 0 ? pieces : [token];
}

export interface CaptionLayout {
  fontSize: number;
  lines: string[];
  lineHeight: number;
  blockWidth: number;
  blockHeight: number;
}

export const CAPTION_SIZES = [74, 68, 62, 56, 50, 44, 38] as const;

/**
 * 컷 자막의 글자 크기·줄. 폭에 맞춰 크기를 줄이고, 그래도 3줄을 넘으면 말줄임.
 * 9:16에서 자막이 4줄을 넘으면 플랫폼 UI에 가려진다.
 */
export function layoutCaption(
  measure: (text: string, fontSize: number) => number,
  text: string,
  maxWidth: number,
  maxLines = 3,
): CaptionLayout {
  const clean = text.replace(/\s+/g, ' ').trim();
  const originalChars = clean.replace(/\s/g, '').length;

  for (const fontSize of CAPTION_SIZES) {
    const lines = wrapLines(clean, maxWidth, (line) => measure(line, fontSize), maxLines);
    const keptChars = lines.join('').replace(/\s/g, '').replace(/…$/, '').length;
    // 말줄임 없이 전문이 들어가는 가장큰 글자 크기를 고른다.
    if (lines.length > 0 && keptChars >= originalChars) {
      return {
        fontSize,
        lines,
        lineHeight: Math.round(fontSize * 1.24),
        blockWidth: Math.max(0, ...lines.map((line) => measure(line, fontSize))),
        blockHeight: lines.length * Math.round(fontSize * 1.24),
      };
    }
  }

  const fontSize = CAPTION_SIZES[CAPTION_SIZES.length - 1]!;
  const lines = wrapLines(clean, maxWidth, (line) => measure(line, fontSize), maxLines);
  return {
    fontSize,
    lines,
    lineHeight: Math.round(fontSize * 1.24),
    blockWidth: Math.max(0, ...lines.map((line) => measure(line, fontSize))),
    blockHeight: lines.length * Math.round(fontSize * 1.24),
  };
}

/** 자막 블록이 놓이는 y. 플랫폼 UI(상단 150px·하단 캡션 시트 1500px)를 피한다. */
export function captionTopFor(position: CreatorCut['captionPosition'], blockHeight: number): number {
  if (position === 'top') return 300;
  if (position === 'middle') return Math.round((FRAME.height - blockHeight) / 2);
  return 1420 - blockHeight;
}

export function captionMaxWidth(position: CreatorCut['captionPosition']): number {
  // 아래쪽은 오른쪽 액션 레일(x 880~)을 피해야 버튼이 글자를 덮지 않는다.
  return position === 'bottom' ? 800 : 940;
}

function fontOf(size: number, weight = 700): string {
  return `${weight} ${size}px ${FONT_STACK}`;
}

function roundRectPath(ctx: Paint2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, (Math.PI * 3) / 2);
  ctx.closePath();
}

function drawScrim(ctx: Paint2D): void {
  const top = ctx.createLinearGradient(0, 0, 0, 420);
  top.addColorStop(0, 'rgba(6,10,18,0.62)');
  top.addColorStop(1, 'rgba(6,10,18,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, FRAME.width, 420);

  const bottom = ctx.createLinearGradient(0, 980, 0, FRAME.height);
  bottom.addColorStop(0, 'rgba(6,10,18,0)');
  bottom.addColorStop(0.55, 'rgba(6,10,18,0.55)');
  bottom.addColorStop(1, 'rgba(6,10,18,0.9)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, 980, FRAME.width, FRAME.height - 980);
}

function drawPlaceholder(ctx: Paint2D, cut: CreatorCut, index: number): void {
  const gradient = ctx.createLinearGradient(0, 0, FRAME.width, FRAME.height);
  gradient.addColorStop(0, cut.accent);
  gradient.addColorStop(1, '#0b1220');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, FRAME.width, FRAME.height);

  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = WHITE;
  for (let i = 0; i < 7; i += 1) {
    ctx.beginPath();
    ctx.arc(140 + i * 150, 1560 - i * 190, 210, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = WHITE;
  ctx.font = fontOf(30, 600);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`컷 ${index + 1} · 사진이나 영상을 올려 주세요`, FRAME.width / 2, FRAME.height / 2 - 30);
  ctx.restore();
}

function drawMedia(ctx: Paint2D, spec: FrameSpec): void {
  const { cut, media, progress } = spec;
  const kb = kenBurnsAt(cut.kind === 'video' ? 'none' : cut.kenBurns, progress);
  const sourceWidth = media ? naturalWidth(media) : cut.width;
  const sourceHeight = media ? naturalHeight(media) : cut.height;
  const fit = coverFit(sourceWidth, sourceHeight, FRAME.width, FRAME.height);
  const rect = kenBurnsRect(fit, kb);
  if (media) {
    ctx.drawImage(media, rect.x, rect.y, rect.width, rect.height);
  } else {
    drawPlaceholder(ctx, cut, spec.index);
  }
}

function naturalWidth(media: CanvasImageSource): number {
  const candidate = media as { naturalWidth?: number; videoWidth?: number; width?: number };
  return candidate.naturalWidth ?? candidate.videoWidth ?? candidate.width ?? FRAME.width;
}

function naturalHeight(media: CanvasImageSource): number {
  const candidate = media as { naturalHeight?: number; videoHeight?: number; height?: number };
  return candidate.naturalHeight ?? candidate.videoHeight ?? candidate.height ?? FRAME.height;
}

/**
 * 이전 컷 화면을 먼저 깔고, 그 위에 현재 컷을 전환만큼 덮는다.
 * fade는 겹쳐 나타나고, slide는 이전 컷이 왼쪽으로 빠지며 새 컷이 오른쪽에서 들어온다.
 */
export function drawFrame(ctx: Paint2D, spec: FrameSpec): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, FRAME.width, FRAME.height);

  const p = Math.max(0, Math.min(1, spec.transition));
  const hasPrevious = spec.previous !== null && p < 1 && spec.index > 0;

  if (hasPrevious && spec.previous) {
    if (spec.cut.transition === 'fade') {
      ctx.drawImage(spec.previous, 0, 0, FRAME.width, FRAME.height);
      ctx.globalAlpha = p;
      drawMedia(ctx, spec);
      ctx.globalAlpha = 1;
    } else if (spec.cut.transition === 'slide') {
      ctx.drawImage(spec.previous, -p * FRAME.width, 0, FRAME.width, FRAME.height);
      drawMediaWithOffset(ctx, spec, (1 - p) * FRAME.width);
    } else {
      drawMedia(ctx, spec);
    }
  } else {
    drawMedia(ctx, spec);
  }

  drawScrim(ctx);
  drawTopLine(ctx, spec);
  drawCaption(ctx, spec);
  drawDisclosureChip(ctx, spec);
  if (spec.showProgress) drawProgress(ctx, spec);
  if (spec.showGuides) drawGuides(ctx);
  ctx.restore();
}

/** slide 전환: 새 컷을 오른쪽에서 밀어 넣는다. */
function drawMediaWithOffset(ctx: Paint2D, spec: FrameSpec, offset: number): void {
  const { cut, media, progress } = spec;
  const kb = kenBurnsAt(cut.kind === 'video' ? 'none' : cut.kenBurns, progress);
  const sourceWidth = media ? naturalWidth(media) : cut.width;
  const sourceHeight = media ? naturalHeight(media) : cut.height;
  const fit = coverFit(sourceWidth, sourceHeight, FRAME.width, FRAME.height);
  const rect = kenBurnsRect(fit, kb);
  if (media) {
    ctx.drawImage(media, rect.x + offset, rect.y, rect.width, rect.height);
  } else {
    drawPlaceholderAt(ctx, cut, spec.index, offset);
  }
}

function drawPlaceholderAt(ctx: Paint2D, cut: CreatorCut, index: number, offset: number): void {
  ctx.save();
  ctx.fillStyle = cut.accent;
  ctx.fillRect(offset, 0, FRAME.width, FRAME.height);
  ctx.restore();
  void index;
}

function drawTopLine(ctx: Paint2D, spec: FrameSpec): void {
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = fontOf(30, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  if (spec.badge !== '') {
    ctx.fillText(spec.badge, 60, 210);
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(spec.handle, FRAME.width - 60, 210);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = fontOf(28, 600);
  ctx.fillText(`${spec.index + 1} / ${spec.total}`, 60, 262);
  ctx.restore();
}

function drawCaption(ctx: Paint2D, spec: FrameSpec): void {
  const { cut, disclosure, isLast } = spec;
  const maxWidth = captionMaxWidth(cut.captionPosition);
  const measure = (text: string, fontSize: number): number => {
    const previous = ctx.font;
    ctx.font = fontOf(fontSize);
    const width = ctx.measureText(text).width;
    ctx.font = previous;
    return width;
  };

  const layout = layoutCaption(measure, cut.caption, maxWidth);
  const disclosureLine = isLast && disclosure.sentence !== '' ? disclosure.sentence : '';
  const disclosureFont = 32;
  const disclosureLines = disclosureLine
    ? wrapLines(disclosureLine, maxWidth, (line) => {
        const previous = ctx.font;
        ctx.font = fontOf(disclosureFont, 500);
        const width = ctx.measureText(line).width;
        ctx.font = previous;
        return width;
      }, 2)
    : [];
  const disclosureHeight = disclosureLines.length * Math.round(disclosureFont * 1.4);
  const gap = disclosureLines.length > 0 ? 22 : 0;
  const totalHeight = layout.blockHeight + gap + disclosureHeight;
  const top = captionTopFor(cut.captionPosition, totalHeight);
  const centerY = top + layout.blockHeight / 2;

  if (layout.lines.length === 0) {
    if (disclosureLines.length === 0) return;
  }

  const padX = 30;
  const padY = 20;
  const boxWidth = Math.min(maxWidth + padX * 2, FRAME.width - 60);
  const boxX = (FRAME.width - boxWidth) / 2;
  const boxY = top - padY;
  const boxHeight = layout.blockHeight + padY * 2;

  ctx.save();
  if (layout.lines.length > 0) {
    if (cut.captionBackground === 'solid') {
      ctx.fillStyle = 'rgba(9,14,24,0.66)';
      roundRectPath(ctx, boxX, boxY, boxWidth, boxHeight, 22);
      ctx.fill();
    } else if (cut.captionBackground === 'band') {
      ctx.fillStyle = 'rgba(9,14,24,0.62)';
      ctx.fillRect(0, boxY, FRAME.width, boxHeight);
    }
  } else if (disclosureLines.length > 0) {
    // 자막 없이 공정위 문구만 있는 컷: 문장 뒤에 판을 깔아 읽히게 한다.
    ctx.fillStyle = 'rgba(9,14,24,0.66)';
    roundRectPath(ctx, boxX, top - padY, boxWidth, disclosureHeight + padY * 2, 22);
    ctx.fill();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = fontOf(layout.fontSize);
  layout.lines.forEach((line, index) => {
    const y = centerY - layout.blockHeight / 2 + layout.lineHeight * (index + 0.5);
    if (cut.captionBackground === 'outline') {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(4, layout.fontSize * 0.16);
      ctx.strokeStyle = 'rgba(6,10,18,0.9)';
      ctx.strokeText(line, FRAME.width / 2, y);
      ctx.fillStyle = WHITE;
      ctx.fillText(line, FRAME.width / 2, y);
    } else {
      ctx.fillStyle = WHITE;
      ctx.fillText(line, FRAME.width / 2, y);
    }
  });

  if (disclosureLines.length > 0) {
    ctx.font = fontOf(disclosureFont, 500);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    const startY = top + layout.blockHeight + gap;
    disclosureLines.forEach((line, index) => {
      ctx.fillText(line, FRAME.width / 2, startY + Math.round(disclosureFont * 1.4) * (index + 0.5));
    });
  }
  ctx.restore();
}

function drawDisclosureChip(ctx: Paint2D, spec: FrameSpec): void {
  const badge = spec.disclosure.badge;
  if (badge === '') return;
  ctx.save();
  ctx.font = fontOf(28, 600);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const width = ctx.measureText(badge).width + 40;
  const x = 60;
  const y = FRAME.height - 220;
  ctx.fillStyle = 'rgba(9,14,24,0.55)';
  roundRectPath(ctx, x, y, width, 52, 26);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.fillText(badge, x + 20, y + 27);
  ctx.restore();
}

function drawProgress(ctx: Paint2D, spec: FrameSpec): void {
  const ratio = Math.max(0, Math.min(1, (spec.index + spec.progress) / Math.max(1, spec.total)));
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(0, 0, FRAME.width, 8);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, FRAME.width * ratio, 8);
  ctx.restore();
}

const ZONE_LABEL: Record<string, string> = {
  'top-bar': '상단 바',
  'caption-sheet': '캡션·버튼 영역',
  'action-rail': '좋아요·댓글 버튼',
};

/** 9:16 세이프존 가이드 — 미리보기에만, 결과 파일에는 들어가지 않는다. */
export function drawGuides(ctx: Paint2D): void {
  const zones = PLATFORM_UI_ZONES['instagram-reels'];
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,92,92,0.9)';
  ctx.fillStyle = 'rgba(255,92,92,0.12)';
  ctx.font = fontOf(26, 600);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  zones.forEach((zone: { name: string; rect: Rect }) => {
    ctx.fillRect(zone.rect.x, zone.rect.y, zone.rect.w, zone.rect.h);
    ctx.strokeRect(zone.rect.x, zone.rect.y, zone.rect.w, zone.rect.h);
    const labelY = zone.rect.y === 0 ? zone.rect.y + 16 : zone.rect.y + 14;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(ZONE_LABEL[zone.name] ?? '안전 여백', zone.rect.x + 18, labelY);
    ctx.fillStyle = 'rgba(255,92,92,0.12)';
  });

  ctx.strokeStyle = 'rgba(94,234,160,0.9)';
  ctx.lineWidth = 3;
  ctx.strokeRect(60, 186, 760, 1440);
  ctx.fillStyle = 'rgba(94,234,160,0.95)';
  ctx.font = fontOf(24, 600);
  ctx.fillText('안전 영역', 72, 190);
  ctx.restore();
}

export { INK, BODY, MUTED, WHITE, FONT_STACK, fontOf };
