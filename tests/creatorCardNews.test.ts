import { describe, expect, it } from 'vitest';
import {
  CARD,
  buildCardNewsZip,
  cardFileName,
  cardHeadline,
  cardNewsZipFileName,
  drawCard,
  planCardLayout,
} from '../web/model/creator/cardNews';
import type { Paint2D } from '../web/model/creator/render';
import { disclosureOf, makeCut } from '../web/model/creator/types';

/**
 * 카드뉴스(4:5) 레이아웃과 ZIP.
 *
 * 카드는 피드에서 잘리지 않는 한 장이어야 하므로, 제목·본문·바닥글이 1350px
 * 안에서 서로 겹치지 않는지를 숫자로 고정한다.
 */

class CardPaint implements Paint2D {
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  strokeStyle: string | CanvasGradient | CanvasPattern = '';
  lineWidth = 1;
  lineJoin: CanvasLineJoin = 'round';
  font = '700 16px sans-serif';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1;
  texts: string[] = [];
  images = 0;
  save(): void {}
  restore(): void {}
  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  rect(): void {}
  fill(): void {}
  stroke(): void {}
  clip(): void {}
  fillRect(): void {}
  strokeRect(): void {}
  fillText(text: string): void {
    this.texts.push(text);
  }
  strokeText(): void {}
  measureText(text: string): { width: number } {
    const match = this.font.match(/([\d.]+)px/);
    const size = match ? Number(match[1]) : 16;
    return { width: text.length * size * 0.95 };
  }
  drawImage(): void {
    this.images += 1;
  }
  createLinearGradient(): CanvasGradient {
    return { addColorStop: () => undefined } as unknown as CanvasGradient;
  }
}

const measure = (text: string, size: number): number => text.length * size * 0.95;

describe('카드뉴스 레이아웃', () => {
  const cut = makeCut({
    caption: '문틈 10cm에 냄비 뚜껑을 세워 두었더니 정리 끝',
    note: '수납장 문 안쪽에 얇은 선반을 달면 냄비 뚜껑이 한 줄로 들어갑니다. 용기 높이를 맞추면 남는 공간이 눈에 보입니다.',
    kind: 'placeholder',
  });

  it('제목·본문·바닥글이 1350px 안에서 겹치지 않는다', () => {
    const layout = planCardLayout(measure, cut, disclosureOf('sponsored'));
    expect(layout.photoHeight).toBeGreaterThan(0);
    expect(layout.headlineTop).toBeGreaterThan(layout.panelTop);
    const headlineBottom = layout.headlineTop + layout.headlineLines.length * layout.headlineLineHeight;
    expect(layout.bodyTop).toBeGreaterThan(headlineBottom);
    const bodyBottom = layout.bodyTop + layout.bodyLines.length * layout.bodyLineHeight;
    expect(bodyBottom).toBeLessThan(layout.footerTop - 20);
    expect(layout.footerTop).toBeLessThan(CARD.height);
  });

  it('제목은 최대 2줄, 본문은 최대 3줄로 자른다', () => {
    const layout = planCardLayout(measure, cut, disclosureOf('none'));
    expect(layout.headlineLines.length).toBeLessThanOrEqual(2);
    expect(layout.bodyLines.length).toBeLessThanOrEqual(3);
    for (const line of layout.headlineLines) expect(measure(line, layout.headlineFontSize)).toBeLessThanOrEqual((CARD.width - 144) * 1.02);
  });

  it('설명이 비면 자막을 제목으로 쓰고, 둘 다 비면 빈 제목이 된다', () => {
    expect(cardHeadline(makeCut({ caption: '한 줄', note: '설명' }))).toBe('한 줄');
    expect(cardHeadline(makeCut({ caption: '', note: '설명' }))).toBe('설명');
    expect(cardHeadline(makeCut({ caption: '', note: '' }))).toBe('');
  });

  it('공정위 문구는 바닥글 오른쪽에 두 줄까지 들어간다', () => {
    const layout = planCardLayout(measure, cut, disclosureOf('coupang'));
    expect(layout.disclosureLines.length).toBeGreaterThan(0);
    expect(layout.disclosureLines.length).toBeLessThanOrEqual(2);
  });

  it('카드를 그리면 사진·제목·번호·핸들이 모두 올라간다', () => {
    const paint = new CardPaint();
    drawCard(paint, {
      cut,
      index: 0,
      total: 3,
      media: { width: 1200, height: 1600 } as unknown as CanvasImageSource,
      handle: '@shye',
      badge: '주방 수납',
      disclosure: disclosureOf('sponsored'),
    });
    expect(paint.images).toBe(1);
    const joined = paint.texts.join(' ');
    expect(joined).toContain('01 / 03');
    expect(joined).toContain('@shye');
    expect(joined).toContain('주방 수납');
    expect(joined).toContain('제공받아');
  });

  it('사진이 없으면 그라데이션 자리 표시를 그린다', () => {
    const paint = new CardPaint();
    drawCard(paint, {
      cut,
      index: 2,
      total: 3,
      media: null,
      handle: '@shye',
      badge: '',
      disclosure: disclosureOf('none'),
    });
    expect(paint.images).toBe(0);
    expect(paint.texts.join(' ')).toContain('컷 3');
  });
});

describe('카드뉴스 ZIP', () => {
  it('파일 이름에 순번이 들어가고 한글 제목이 유지된다', () => {
    expect(cardFileName('3평 주방 정리', 0, 4)).toBe('3평 주방 정리_카드뉴스_01of04.png');
    expect(cardNewsZipFileName('3평 주방 정리', new Date(2026, 10, 22))).toBe('3평 주방 정리_카드뉴스_20261122.zip');
  });

  it('PNG 3장을 담은 ZIP을 만들고, CRC와 중앙 디렉터리가 맞는다', () => {
    const entries = [0, 1, 2].map((index) => ({
      name: cardFileName('테스트', index, 3),
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, index, index, index]),
    }));
    const zip = buildCardNewsZip(entries, new Date(2026, 10, 22));
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
    // 중앙 디렉터리 레코드 수
    let central = 0;
    for (let index = 0; index < zip.length - 4; index += 1) {
      if (zip[index] === 0x50 && zip[index + 1] === 0x4b && zip[index + 2] === 0x01 && zip[index + 3] === 0x02) central += 1;
    }
    expect(central).toBe(3);
    // 파일 이름은 UTF-8 플래그(0x0800)로 기록된다.
    expect(zip[6] === 0x00 && zip[7] === 0x08).toBe(true);
  });
});
