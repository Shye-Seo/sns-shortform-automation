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
