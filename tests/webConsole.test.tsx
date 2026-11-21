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

/** 스위치(체크박스)는 버튼이 아니라 label>input이라 따로 누른다. */
async function toggle(label: string): Promise<void> {
  const target = [...container.querySelectorAll('label.toggle')].find((candidate) =>
    (candidate.textContent ?? '').replace(/\s+/g, ' ').includes(label),
  );
  const input = target?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  if (!input) throw new Error(`toggle not found: ${label}`);
  await act(async () => {
    input.click();
  });
}

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
    expect(text()).toMatch(/배경음악 \d+%/);
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
    expect(text()).toContain('DROP-1120');

    // The composer already holds '쿠폰 주세요!'; submit it as the webhook body.
    await click('댓글 넣기');
    await settle(600);

    expect(text()).toContain('1회용 링크를 보냈습니다');

    await click('받은 사람처럼 링크 열기');
    await settle(50);
    expect(text()).toContain('쿠폰 사용');
  });

  it('binds the rule to the selected post and only answers that post', async () => {
    await click('댓글 → DM 쿠폰');
    expect(text()).toContain('어느 게시물에 걸까요');

    // Pick the second post and apply the rule; the campaign code follows the post.
    await click('퇴사 후 첫 달');
    await click('이 게시물에 규칙 적용');
    expect(text()).toContain('DROP-1118');

    await click('댓글 넣기');
    await settle(600);
    expect(text()).toContain('받은 사람처럼 링크 열기');
  });

  it('shows the topic domain and offers the one-click edit package', async () => {
    // 4비트 대본 머리의 도메인 표시(왜 이런 문장이 나왔는지)와 편집 패키지 버튼.
    const topicInput = container.querySelector('input[type="text"]') as HTMLInputElement | null;
    expect(topicInput).not.toBeNull();
    await typeInto(topicInput!, '퇴사한 30대 개발자의 일상');

    expect(text()).toContain('일상·브이로그');
    expect(text()).toContain('편집 패키지');
    expect(text()).toContain('.srt');
    expect(text()).toContain('_컷타임시트.csv');
  });

  it('scans the script before publishing and gates the publish button', async () => {
    await click('발행 캘린더 · 쿼터');
    expect(text()).toContain('발행 전 자동 점검');
    expect(text()).toMatch(/이 대본은 그대로 올릴 수 있습니다|올리기 전에 고칠 것이 있습니다/);
    expect(text()).toContain('법률 검토가 아닙니다');
    // 정상 대본이므로 발행 버튼이 눌린다.
    const publishButton = findButton('다음 예약 발행') as HTMLButtonElement;
    expect(publishButton.disabled).toBe(false);
  });

  it('applies the follower-only rule with a send interval from the coupon panel', async () => {
    await click('댓글 → DM 쿠폰');
    await toggle('팔로워만');
    await click('10초');
    await click('이 게시물에 규칙 적용');

    expect(text()).toContain('팔로워로 확인된 사람만');
    expect(text()).toContain('10초');

    // 기본 데모 댓글은 '팔로워'로 표시되어 있으므로 발송된다.
    await click('댓글 넣기');
    await settle(600);
    expect(text()).toContain('1회용 링크');

    // 팔로워가 아닌 사람의 댓글은 건너뛴다.
    await click('팔로워 아님');
    await click('댓글 넣기');
    await settle(50);
    expect(text()).toContain('팔로워가 확인되지 않아 보내지 않았습니다');
  });

  it('shows the quota gauges and stops the queue when a platform limit is reached', async () => {
    await click('발행 캘린더 · 쿼터');
    expect(text()).toContain('인스타그램');
    expect(text()).toContain('유튜브');
    expect(text()).toContain('플랫폼별 한도');

    for (let index = 0; index < 12; index += 1) {
      await click('다음 예약 발행');
    }
    await settle(30);

    expect(text()).toMatch(/멈춤|한도로 멈춤/);
    expect(text()).toContain('확인이 필요한 작업');
  });

  it('converts the studio script into three publishing formats on the OSMU tab', async () => {
    await click('한 편을 세 곳으로');
    expect(text()).toContain('대본 하나로 세 곳에 올릴 글');
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
    expect(text()).toContain('훅 유형별 예상 저장·공유');
    expect(text()).toContain('질문형');
    expect(text()).toContain('숫자형');
    expect(text()).toContain('반전형');
    expect(text()).toContain('체크리스트형');
    expect(text()).toContain('실측이 아닙니다');
  });

  it('switches the collection period instead of asking a human to add samples', async () => {
    await click('훅 A/B');
    expect(text()).toContain('A/B 비교');
    expect(text()).toContain('3초 유지');
    expect(text()).toContain('끝까지 본 비율');
    expect(text()).toContain('쿠폰 사용');
    // 표본을 손으로 올리는 버튼은 없다.
    expect(text()).not.toContain('+2,000');
    expect(text()).not.toContain('+500');
    expect(text()).toContain('올린 지 3시간');

    await click('7일 누적');
    expect(text()).toMatch(/A안 우세|B안 우세/);
    expect(text()).toContain('믿을 수 있는 정도');
  });
});
