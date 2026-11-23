// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../web/App';
import { resetStoreResolution } from '../web/model/sonder/repo';

/**
 * 기획 루프 4개 탭이 서버 없이(로컬 모드) 끝까지 도는지 실제 DOM에서 확인한다.
 * 정적 페이지와 같은 조건을 만들려고 fetch를 404로 두고, /api/health는 없는
 * 것으로 둔다.
 */

declare global {
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
  await settle();
}

async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function byPlaceholder(placeholder: string): HTMLInputElement | HTMLTextAreaElement {
  const field = [...container.querySelectorAll('input, textarea')].find(
    (element) => element.getAttribute('placeholder') === placeholder,
  );
  if (!field) throw new Error(`field not found: ${placeholder}`);
  return field as HTMLInputElement;
}

const TRANSCRIPT = `3평 주방에서 매번 냄비를 꺼내다 부딪혔습니다.
수납장 문 안쪽 10cm를 그냥 버리고 있었거든요.
문 안쪽에 얇은 선반을 달고, 냄비 뚜껑은 같은 크기끼리 묶었습니다.
그다음 용기 높이를 맞춰서 세로로 세웠어요.
한 달 써보니 꺼내는 시간이 3초에서 1초로 줄었습니다.
오늘은 한 칸만 비워보세요. 저장해두고 천천히 해보세요.`;

beforeEach(async () => {
  resetStoreResolution();
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => 'text/html' } })) as unknown as typeof fetch,
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(App));
  });
  await settle(20);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('기획 루프 (로컬 모드)', () => {
  it('서버가 없으면 로컬 모드로 열리고 기획 탭 4개가 있다', async () => {
    expect(text()).toContain('로컬 모드');
    for (const label of ['채널 정체성', '트렌드 보관함', '합체 기획안', '성과 로그']) {
      expect([...container.querySelectorAll('button')].some((button) => button.textContent === label)).toBe(true);
    }
  });

  it('채널 정체성을 고치면 목록과 voice.md에 반영된다', async () => {
    await click('채널 정체성');
    expect(text()).toContain('일상·리빙');
    const doc = container.querySelector('[data-testid="voice-doc"]');
    expect(doc?.textContent).toContain('# 일상·리빙 (@shye__s)');

    await typeInto(byPlaceholder('일상·리빙'), '일상·리빙 새벽');
    await click('저장');
    await settle(10);
    expect(text()).toContain('일상·리빙 새벽');
    expect(container.querySelector('[data-testid="voice-doc"]')?.textContent).toContain('# 일상·리빙 새벽');
  });

  it('참고 영상을 넣으면 배수를 계산하고 보관함에 남는다', async () => {
    await click('트렌드 보관함');
    await typeInto(byPlaceholder('https://www.youtube.com/shorts/…'), 'https://www.youtube.com/shorts/abc123XYZ');
    await typeInto(byPlaceholder('3평 주방 수납, 문 안쪽 10cm'), '3평 주방 수납, 문 안쪽 10cm');
    await typeInto(container.querySelector('textarea') as HTMLTextAreaElement, TRANSCRIPT);
    await typeInto(byPlaceholder('82000'), '82000');
    await typeInto(byPlaceholder('19000'), '19000');
    await typeInto(byPlaceholder('32'), '32');
    await settle();

    const multiplier = container.querySelector('[data-testid="multiplier"]');
    expect(multiplier?.textContent).toContain('4.32배');
    expect(text()).toContain('바이럴 신호');

    await click('구조만 읽어보기');
    await settle(10);
    expect(text()).toContain('첫 문장');
    expect(text()).toContain('전환 시점');

    await click('보관함에 저장');
    await settle(10);
    expect(text()).toContain('보관함에 저장했습니다');
    expect(findButton('기획안으로')).toBeTruthy();
  });

  it('보관함 → 기획안 → 9:16 스튜디오까지 이어진다', async () => {
    await click('트렌드 보관함');
    await typeInto(byPlaceholder('https://www.youtube.com/shorts/…'), 'https://www.youtube.com/shorts/abc123XYZ');
    await typeInto(byPlaceholder('3평 주방 수납, 문 안쪽 10cm'), '3평 주방 수납, 문 안쪽 10cm');
    await typeInto(container.querySelector('textarea') as HTMLTextAreaElement, TRANSCRIPT);
    await typeInto(byPlaceholder('82000'), '82000');
    await typeInto(byPlaceholder('19000'), '19000');
    await typeInto(byPlaceholder('32'), '32');
    await click('보관함에 저장');
    await settle(10);
    await click('기획안으로');
    await settle(10);

    expect(text()).toContain('무엇을 합칠까요');
    await click('기획안 만들기');
    await settle(20);

    expect(text()).toContain('후킹 3안');
    expect(container.querySelectorAll('.hook-option')).toHaveLength(3);
    expect(text()).toContain('컷별 자막');
    expect(text()).toContain('박자표');
    const caption = container.querySelector('[data-testid="plan-caption"]')?.textContent ?? '';
    expect(caption).toContain('오늘도 하나만 남기고 갑니다');

    await click('실사용 스튜디오에서 열기');
    await settle(40);
    expect(text()).toContain('합체 기획안');
    expect(container.querySelector('[data-testid="creator-seed"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="creator-studio"]')).toBeTruthy();
  });

  it('성과 로그에 숫자를 넣으면 저장률과 평균 배수를 계산한다', async () => {
    await click('성과 로그');
    expect(text()).toContain('아직 기록이 없습니다');
    await typeInto(byPlaceholder('3평 주방 수납 정리법'), '주방 수납 정리법');
    await typeInto(byPlaceholder('82000'), '46000');
    await typeInto(byPlaceholder('2100'), '1200');
    await typeInto(byPlaceholder('320'), '90');
    await typeInto(byPlaceholder('45'), '12');
    await typeInto(byPlaceholder('19000'), '11500');
    await click('기록하기');
    await settle(10);

    expect(text()).toContain('기록했습니다');
    expect(text()).toContain('4.00배');
    expect(text()).toContain('2.6%');
  });
});
