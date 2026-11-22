// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../web/App';

/**
 * 실사용 스튜디오 DOM 테스트.
 *
 * jsdom에는 캔버스가 없으므로 그림 자체는 여기서 확인하지 않는다(그건 렌더러
 * 단위 테스트와 Playwright E2E가 맡는다). 여기서는 브라우저에서 실제로 만질 수
 * 있는 것 — 탭 이동, 컷 추가·삭제, 붙여넣기로 컷 만들기, 공정위 문구 선택,
 * 캡션 미리보기 — 이 화면에 붙어 있는지를 확인한다.
 */

declare global {
  // React 18 reads this to decide whether act() is in charge.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const settle = async (ms = 0): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const text = (): string => (container.textContent ?? '').replace(/\s+/g, ' ');

function findButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent ?? '').replace(/\s+/g, ' ').includes(label),
  );
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    findButton(label).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  // jsdom의 캔버스 getContext는 "not implemented"를 던진다 — 패널은 그 경우
  // 안내 문구로 물러서므로, 테스트에서는 null을 돌려 조용히 같은 경로를 탄다.
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(App));
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('실사용 스튜디오', () => {
  it('9:16 스튜디오에서 실제 미디어 스튜디오로 이어지는 입구를 보여 준다', async () => {
    expect(text()).toContain('실사용 스튜디오');
    expect(text()).toContain('실사용 스튜디오 열기');
    await click('실사용 스튜디오 열기');
    expect(text()).toContain('실제 미디어로 9:16 렌더');
  });

  it('네 단계(소스·컷 편집·문구·내보내기)가 한 화면에 있다', async () => {
    await click('실사용 스튜디오');
    expect(container.querySelector('[data-testid="creator-studio"]')).not.toBeNull();
    expect(text()).toContain('소스 가져오기');
    expect(text()).toContain('컷 편집');
    expect(text()).toContain('문구 · 브랜드');
    expect(text()).toContain('내보내기');
    expect(text()).toContain('숏폼 영상 (9:16)');
    expect(text()).toContain('인스타 카드뉴스 (4:5)');
    expect(text()).toContain('영상 렌더링');
    expect(text()).toContain('카드뉴스 만들기');
    // jsdom에는 캔버스가 없다 — 빈 화면 대신 이유를 적는다.
    expect(text()).toContain('캔버스 미리보기를 그릴 수 없습니다');
  });

  it('샘플 컷에서 시작해 빈 컷을 더하고 지울 수 있다', async () => {
    await click('실사용 스튜디오');
    expect(container.querySelectorAll('[data-testid^="creator-cut-"]')).toHaveLength(4);
    await click('빈 컷 추가');
    expect(container.querySelectorAll('[data-testid^="creator-cut-"]')).toHaveLength(5);

    const removeButtons = [...container.querySelectorAll('.cut-actions button.danger')];
    await act(async () => {
      removeButtons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-testid^="creator-cut-"]')).toHaveLength(4);
  });

  it('컷 자막을 고치면 컷 목록에 반영된다', async () => {
    await click('실사용 스튜디오');
    const input = container.querySelector('[data-testid="creator-cut-0"] input.cut-caption') as HTMLInputElement;
    await typeInto(input, '문틈 10cm에 냄비 뚜껑을 세워 두었습니다');
    const after = container.querySelector('[data-testid="creator-cut-0"] input.cut-caption') as HTMLInputElement;
    expect(after.value).toContain('냄비 뚜껑');
  });

  it('본문을 붙여넣으면 문장마다 컷이 생긴다', async () => {
    await click('실사용 스튜디오');
    await click('본문 붙여넣기');
    const title = container.querySelector('[data-testid="creator-paste-title"]') as HTMLInputElement;
    await typeInto(title, '3평 주방 수납 정리');
    const body = container.querySelector('[data-testid="creator-paste-body"]') as HTMLTextAreaElement;
    await typeInto(
      body,
      '3평 주방은 수납장 문 안쪽 10cm를 먼저 봅니다. 냄비 뚜껑은 문 안쪽 선반에 세워 두면 한 줄로 정리됩니다. 용기 높이를 맞추면 남는 공간이 눈에 보입니다.',
    );
    await click('컷으로 만들기');
    await settle(30);
    const rows = container.querySelectorAll('[data-testid^="creator-cut-"]');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const first = container.querySelector('[data-testid="creator-cut-0"] input.cut-caption') as HTMLInputElement;
    expect(first.value).toContain('3평 주방');
    expect(text()).toContain('붙여넣은 글에서 컷을 만들었습니다');
  });

  it('공정위 문구를 고르면 영상·캡션에 같은 문장이 들어간다', async () => {
    await click('실사용 스튜디오');
    const select = container.querySelector('[data-testid="creator-disclosure"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'coupang';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(text()).toContain('쿠팡파트너스 활동의 일환으로 수수료를 받을 수 있습니다');
    const caption = container.querySelector('[data-testid="creator-caption"]') as HTMLTextAreaElement;
    expect(caption.value).toContain('쿠팡파트너스');
    expect(caption.value).toContain('#');
  });

  it('카드뉴스와 영상 버튼은 캔버스가 없으면 눌러도 오류를 던지지 않는다', async () => {
    await click('실사용 스튜디오');
    await click('카드뉴스 만들기');
    await settle(20);
    expect(text()).toContain('캔버스를 만들 수 없습니다');
  });
});
