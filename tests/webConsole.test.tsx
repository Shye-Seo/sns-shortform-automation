// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../web/App';

/**
 * The demo console has to survive being clicked, not just compile. These tests
 * mount the real app in a DOM, move between the four panels and run one full
 * comment → DM → claim cycle plus one quota stop, so a broken panel or a dead
 * worker shows up here instead of on the GitHub Pages link.
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

const text = (): string => (container.textContent ?? '').replace(/\s+/g, ' ');

/** React 18 listens for the native input event, so set the value through the prototype. */
async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
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

describe('web console', () => {
  it('renders the 9:16 studio with the engine timeline, captions and ducking', () => {
    expect(text()).toContain('숏폼 스튜디오');
    expect(text()).toContain('4비트 대본');
    expect(text()).toContain('타임라인');
    expect(text()).toContain('오디오 더킹');
    expect(text()).toContain('안전영역 검증');
    // The phone shows a beat marker and the BGM gain the envelope produces.
    expect(text()).toMatch(/BGM \d+%/);
    expect(container.querySelector('.phone')).not.toBeNull();
    expect(container.querySelector('svg.envelope')).not.toBeNull();
    // Safe-area guides are drawn from the platform's reserved rectangles.
    expect(container.querySelectorAll('.phone .zone').length).toBe(3);
  });

  it('re-derives the script and captions when the topic changes, and on every regenerate', async () => {
    expect(text()).toContain('주방');
    const topicInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    const hookField = container.querySelector('textarea') as HTMLTextAreaElement;
    const before = hookField.value;

    await typeInto(topicInput, '겨울 제주 여행 2박3일 코스');

    const afterTopic = (container.querySelector('textarea') as HTMLTextAreaElement).value;
    expect(afterTopic).not.toBe(before);
    // The topic stays in the script even when the hook uses a shorter label.
    expect(text()).toContain('제주');
    expect(text()).not.toContain('주방');

    await click('대본 다시 생성');
    const afterRegenerate = (container.querySelector('textarea') as HTMLTextAreaElement).value;
    expect(afterRegenerate).not.toBe(afterTopic);

    // The on-screen badge follows the topic too — no fixed kitchen label.
    expect(text()).not.toContain('KITCHEN');
    expect(text()).toContain('크로스채널 기획');
  });

  it('plans the same topic for shortform, longform and a blog skeleton', async () => {
    await click('크로스채널 기획');
    expect(text()).toContain('크로스채널 기획 엔진');
    expect(text()).toContain('리퍼포징 맵');
    expect(text()).toContain('유튜브 롱폼 목차');
    expect(text()).toContain('블로그 뼈대');
    expect(text()).toContain('숏폼 대본');

    const topicInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    await typeInto(topicInput, '팔꿈치 마사지기 리뷰');
    expect(text()).toContain('팔꿈치 마사지기');
    expect(text()).toContain('제품·리뷰');
  });

  it('runs one comment → DM → claim cycle from the coupon panel', async () => {
    await click('댓글 → DM 쿠폰');
    expect(text()).toContain('BUSAN-BOM-1114');

    // The composer already holds '쿠폰 주세요!'; submit it as the webhook body.
    await click('댓글 등록');
    await settle(600);

    expect(text()).toContain('coupon.shye.kr/c/');

    await click('링크 열기');
    await settle(50);
    expect(text()).toContain('GRANTED');
    expect(text()).toContain('수령');
  });

  it('shows the quota gauges and stops the queue when a platform limit is reached', async () => {
    await click('발행 캘린더 · 쿼터');
    expect(text()).toContain('Meta Graph');
    expect(text()).toContain('YouTube');
    expect(text()).toContain('일일 쿼터');

    for (let index = 0; index < 12; index += 1) {
      await click('다음 슬롯 발행');
    }
    await settle(30);

    expect(text()).toMatch(/한도 소진|버킷 소진|중단/);
    expect(text()).toContain('DLQ');
  });

  it('converts the studio script into three publishing formats on the OSMU tab', async () => {
    await click('OSMU 변환');
    expect(text()).toContain('원소스 멀티유즈');
    expect(text()).toContain('인스타그램 릴스 캡션');
    expect(text()).toContain('유튜브 쇼츠 설명');
    expect(text()).toContain('블로그 · 스레드 요약 포스트');

    const preview = container.querySelector('[data-testid="osmu-text"]');
    expect(preview?.textContent ?? '').toContain('#');

    await click('유튜브 쇼츠 설명');
    expect((container.querySelector('[data-testid="osmu-text"]')?.textContent ?? '')).toContain('타임라인');

    await click('블로그 · 스레드 요약 포스트');
    await click('스레드');
    expect(text()).toContain('스레드 분할');
  });

  it('compares the four hook patterns before spending impressions', async () => {
    await click('훅 A/B');
    expect(text()).toContain('훅 유형별 예상 저장·공유 전환');
    expect(text()).toContain('질문형');
    expect(text()).toContain('숫자형');
    expect(text()).toContain('반전형');
    expect(text()).toContain('체크리스트형');
    expect(text()).toContain('실측 아님');
  });

  it('collects A/B samples and keeps the decision honest', async () => {
    await click('훅 A/B');
    expect(text()).toContain('훅 A/B');
    expect(text()).toContain('3초 유지율');
    expect(text()).toContain('완시율');
    expect(text()).toContain('쿠폰 전환율');

    await click('+2,000');
    await click('+2,000');
    expect(text()).toContain('실험 표본');
    expect(text()).toMatch(/A안|B안|결론 유보/);
  });
});
