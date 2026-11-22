// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../web/App';

/**
 * 선택형 AI 연결 UI.
 *
 * 이 데모에는 서버가 없으므로, 키를 넣었을 때 브라우저에서 제공자 API로 바로
 * 호출되고 결과가 같은 9:16 스튜디오(타임라인·자막·편집 패키지)로 들어오는지를
 * 실제 DOM에서 확인한다. 네트워크는 가짜 fetch로 대체한다.
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

const AI_RESPONSE = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          title: '전세사기 점검',
          scenes: [
            { beat: 'hook', narration: '전세사기, 서류 세 장이면 갈립니다' },
            { beat: 'problem', narration: 'AI가 쓴 문제: 등기부등본을 한 번만 떼면 근저당을 놓칩니다.' },
            { beat: 'solution', narration: 'AI가 쓴 해결: 잔금 당일 전입신고와 확정일자를 함께 처리합니다.' },
            { beat: 'solution', narration: 'AI가 쓴 해결: HUG 가입 여부를 특약에 넣습니다.' },
            { beat: 'solution', narration: 'AI가 쓴 해결: 보증금은 임대인 본인 계좌로 보냅니다.' },
            { beat: 'cta', narration: '계약 전에 다시 보려면 저장해두세요.' },
          ],
        }),
      },
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  window.localStorage.clear();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => AI_RESPONSE }));
  vi.stubGlobal('fetch', fetchMock);
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
  vi.unstubAllGlobals();
});

describe('AI 모델 직접 연결 패널', () => {
  it('키가 없으면 내장 엔진을 쓰고 그 사실을 화면에 적는다', () => {
    expect(text()).toContain('AI 모델 직접 연결');
    expect(text()).toContain('내장 도메인 엔진');
    expect(text()).toContain('키 없음 · 내장 엔진 사용');
    expect(text()).toContain('localStorage');
    // 키 입력은 password 타입이고, 첫 번째 text 입력은 여전히 주제 필드다.
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    const firstTextInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(firstTextInput.value).toContain('주방 수납');
  });

  it('주제를 넣으면 지식 팩 대본이 먼저 나온다(키 없이)', async () => {
    const topicInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    await typeInto(topicInput, '전세사기 주의할점');

    expect(text()).toContain('등기부등본');
    expect(text()).toContain('집·부동산');
    expect(text()).toContain('전세사기 예방');
    expect(text()).not.toContain('하루의 순서');
  });

  it('키를 넣고 생성하면 실제 LLM 응답이 같은 스튜디오에 들어온다', async () => {
    const topicInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    await typeInto(topicInput, '전세사기 주의할점');

    const keyInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    await typeInto(keyInput, 'sk-test-1234');

    await click('AI로 대본 생성');
    await settle(10);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toContain('api.openai.com');
    expect(init.headers.authorization).toBe('Bearer sk-test-1234');
    expect(init.body).toContain('등기부등본');

    expect(text()).toContain('AI가 쓴 해결');
    expect(text()).toContain('OpenAI gpt-4o-mini로 생성');
    // 키는 브라우저에만 남는다.
    const stored = JSON.parse(window.localStorage.getItem('shortform.ai.v1') as string) as { apiKey: string };
    expect(stored.apiKey).toBe('sk-test-1234');
    // 대본이 바뀌면 9:16 타임라인과 자막도 다시 계산된다.
    expect(text()).toContain('타임라인 합계');
  });

  it('키 삭제를 누르면 저장된 키를 지우고 내장 엔진으로 돌아온다', async () => {
    const keyInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    await typeInto(keyInput, 'sk-test-1234');
    await click('키 삭제');
    await settle(5);

    expect(window.localStorage.getItem('shortform.ai.v1')).toBeNull();
    expect(text()).toContain('키 없음 · 내장 엔진 사용');
    expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  });
});
