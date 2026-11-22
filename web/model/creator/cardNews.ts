import { buildZip, safeBaseName } from '../../../src/services/editPackage';
import type { CreatorCut, DisclosureInfo } from './types';
import { CARD, coverFit, fontOf, kenBurnsRect, layoutCaption, wrapLines, type Paint2D } from './render';

/**
 * 인스타 카드뉴스(4:5, 1080×1350) 렌더러.
 *
 * 영상과 같은 컷 배열을 읽지만 결과물은 정지 이미지다. 사진 위에 얹는 한 줄과
 * 아래 흰 패널의 설명을 분리해, 피드에서 잘리지 않는 첫 화면(사진+제목)과
 * 저장해서 다시 보는 본문을 한 장에 담는다.
 */

export { CARD };

export const CARD_MARGIN = 72;
const PANEL_TOP = 760;
const PHOTO_BOTTOM = 760;

export interface CardSpec {
  cut: CreatorCut;
  index: number;
  total: number;
  media: CanvasImageSource | null;
  handle: string;
  badge: string;
  disclosure: DisclosureInfo;
}

export interface CardLayout {
  photoHeight: number;
  panelTop: number;
  headlineTop: number;
  headlineFontSize: number;
  headlineLines: string[];
  headlineLineHeight: number;
  bodyTop: number;
  bodyLines: string[];
  bodyLineHeight: number;
  footerTop: number;
  disclosureLines: string[];
}

export function cardHeadline(cut: CreatorCut): string {
  return cut.caption.trim() !== '' ? cut.caption.trim() : cut.note.trim();
}

export function planCardLayout(
  measure: (text: string, fontSize: number, weight: number) => number,
  cut: CreatorCut,
  disclosure: DisclosureInfo,
): CardLayout {
  const panelTop = PANEL_TOP;
  const width = CARD.width - CARD_MARGIN * 2;
  // 제목은 두 줄까지. 세 줄이 되면 아래 본문과 바닥글이 겹친다.
  const headline = layoutCaption(
    (text, fontSize) => measure(text, fontSize, 700),
    cardHeadline(cut),
    width,
    2,
  );
  const headlineTop = panelTop + 80;
  const headlineLineHeight = headline.lineHeight;
  const headlineHeight = headline.lines.length * headlineLineHeight;
  const bodyTop = headlineTop + headlineHeight + 26;
  const bodyText = cut.note.trim();
  const bodyLines = bodyText
    ? wrapLines(bodyText, width, (line) => measure(line, 34, 500), 3)
    : [];
  const bodyLineHeight = Math.round(34 * 1.6);
  const footerTop = CARD.height - 84;
  const disclosureLines = disclosure.sentence
    ? wrapLines(disclosure.sentence, 520, (line) => measure(line, 26, 500), 2)
    : [];

  return {
    photoHeight: PHOTO_BOTTOM,
    panelTop,
    headlineTop,
    headlineFontSize: headline.fontSize,
    headlineLines: headline.lines,
    headlineLineHeight,
    bodyTop,
    bodyLines,
    bodyLineHeight,
    footerTop,
    disclosureLines,
  };
}

function drawCardPlaceholder(ctx: Paint2D, cut: CreatorCut, index: number): void {
  const gradient = ctx.createLinearGradient(0, 0, CARD.width, PHOTO_BOTTOM);
  gradient.addColorStop(0, cut.accent);
  gradient.addColorStop(1, '#101826');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CARD.width, PHOTO_BOTTOM);

  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 5; i += 1) {
    ctx.beginPath();
    ctx.arc(180 + i * 180, 620 - i * 96, 150, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#ffffff';
  ctx.font = fontOf(30, 600);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`컷 ${index + 1}`, CARD.width / 2, PHOTO_BOTTOM / 2);
  ctx.restore();
}

export function drawCard(ctx: Paint2D, spec: CardSpec): void {
  const { cut, media, index, total, handle, badge, disclosure } = spec;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD.width, CARD.height);

  // 세로 사진을 cover로 넣으면 사진이 아래 패널까지 넘친다. 사진 영역에서 자른다.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, CARD.width, PHOTO_BOTTOM);
  ctx.clip();
  if (media) {
    const fit = coverFit(natural(media, 'width'), natural(media, 'height'), CARD.width, PHOTO_BOTTOM);
    const rect = kenBurnsRect(fit, { scale: 1, panX: 0, panY: 0 });
    ctx.drawImage(media, rect.x, rect.y, rect.width, rect.height);
  } else {
    drawCardPlaceholder(ctx, cut, index);
  }
  ctx.restore();

  // 사진 위 칩이 사진 밝기에 상관없이 읽히도록 아래쪽을 살짝 어둡게.
  const shade = ctx.createLinearGradient(0, PHOTO_BOTTOM - 260, 0, PHOTO_BOTTOM);
  shade.addColorStop(0, 'rgba(8,12,20,0)');
  shade.addColorStop(1, 'rgba(8,12,20,0.42)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, PHOTO_BOTTOM - 260, CARD.width, 260);

  // 사진 위 좌상단: 편 번호 / 우상단: 주제 배지
  ctx.font = fontOf(28, 700);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const chipText = `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  const chipWidth = ctx.measureText(chipText).width + 44;
  ctx.fillStyle = 'rgba(12,18,28,0.55)';
  ctx.fillRect(CARD_MARGIN, 84, chipWidth, 52);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(chipText, CARD_MARGIN + 22, 84 + 27);

  if (badge !== '') {
    ctx.textAlign = 'right';
    ctx.font = fontOf(26, 600);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(badge, CARD.width - CARD_MARGIN, 84 + 27);
    ctx.textAlign = 'left';
  }

  const measure = (text: string, fontSize: number, weight: number): number => {
    const previous = ctx.font;
    ctx.font = fontOf(fontSize, weight);
    const width = ctx.measureText(text).width;
    ctx.font = previous;
    return width;
  };
  const layout = planCardLayout(measure, cut, disclosure);

  // 강조 막대
  ctx.fillStyle = cut.accent;
  ctx.fillRect(CARD_MARGIN, PANEL_TOP + 48, 64, 6);

  ctx.fillStyle = '#11161c';
  ctx.font = fontOf(layout.headlineFontSize, 700);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  layout.headlineLines.forEach((line, lineIndex) => {
    ctx.fillText(line, CARD_MARGIN, layout.headlineTop + layout.headlineLineHeight * lineIndex);
  });

  if (layout.bodyLines.length > 0) {
    ctx.fillStyle = '#414b57';
    ctx.font = fontOf(34, 500);
    layout.bodyLines.forEach((line, lineIndex) => {
      ctx.fillText(line, CARD_MARGIN, layout.bodyTop + layout.bodyLineHeight * lineIndex);
    });
  }

  ctx.strokeStyle = '#e6e9ee';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(CARD_MARGIN, layout.footerTop - 46);
  ctx.lineTo(CARD.width - CARD_MARGIN, layout.footerTop - 46);
  ctx.stroke();

  ctx.fillStyle = '#11161c';
  ctx.font = fontOf(30, 700);
  ctx.textBaseline = 'middle';
  ctx.fillText(handle, CARD_MARGIN, layout.footerTop);

  if (layout.disclosureLines.length > 0) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#6d7683';
    ctx.font = fontOf(26, 500);
    layout.disclosureLines.forEach((line, lineIndex) => {
      ctx.fillText(line, CARD.width - CARD_MARGIN, layout.footerTop - 10 + lineIndex * 34);
    });
    ctx.textAlign = 'left';
  }

  ctx.restore();
}

function natural(media: CanvasImageSource, kind: 'width' | 'height'): number {
  const candidate = media as { naturalWidth?: number; videoWidth?: number; width?: number; naturalHeight?: number; videoHeight?: number; height?: number };
  if (kind === 'width') return candidate.naturalWidth ?? candidate.videoWidth ?? candidate.width ?? CARD.width;
  return candidate.naturalHeight ?? candidate.videoHeight ?? candidate.height ?? PHOTO_BOTTOM;
}

/** 카드 파일 이름. 한글 제목이 들어가도 zip 안에서 깨지지 않는다(UTF-8 플래그). */
export function cardFileName(baseName: string, index: number, total: number): string {
  return `${safeBaseName(baseName)}_카드뉴스_${String(index + 1).padStart(2, '0')}of${String(total).padStart(2, '0')}.png`;
}

/** 카드뉴스 ZIP. PNG는 이미 압축돼 있어 store로 바로 담는다. */
export function buildCardNewsZip(
  entries: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
  now: Date = new Date(),
): Uint8Array {
  return buildZip(entries, now);
}

export function cardNewsZipFileName(baseName: string, now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `${safeBaseName(baseName)}_카드뉴스_${stamp}.zip`;
}
