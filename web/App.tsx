import { useState } from 'react';
import type { SceneDraft } from '../src/services/scriptEngine';
import { Pill } from './ui';
import { StudioPanel } from './panels/StudioPanel';
import { CouponPanel } from './panels/CouponPanel';
import { PublishingPanel } from './panels/PublishingPanel';
import { HookPanel } from './panels/HookPanel';
import { draftBeatScene } from './model/studio';

type TabId = 'studio' | 'coupon' | 'calendar' | 'hooks';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'studio', label: '9:16 스튜디오' },
  { id: 'coupon', label: '댓글 → DM 쿠폰' },
  { id: 'calendar', label: '발행 캘린더 · 쿼터' },
  { id: 'hooks', label: '훅 A/B' },
];

const DEFAULT_TOPIC = '부산 신혼집 3평 주방 수납 정리법';

export function App() {
  const [tab, setTab] = useState<TabId>('studio');
  const [topic, setTopic] = useState(DEFAULT_TOPIC);
  const [durationSec, setDurationSec] = useState(45);
  const [speed, setSpeed] = useState(1);
  const [compress, setCompress] = useState(true);
  const [drafts, setDrafts] = useState<SceneDraft[]>(() => draftBeatScene(DEFAULT_TOPIC, 45));

  const regenerate = (nextTopic: string): void => {
    setDrafts(draftBeatScene(nextTopic, durationSec));
  };

  const adoptHook = (text: string): void => {
    setDrafts(drafts.map((draft, index) => (index === 0 ? { ...draft, narration: text } : draft)));
    setTab('studio');
  };

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <p className="eyebrow">sns-shortform-automation</p>
          <h1>숏폼 스튜디오 &amp; 댓글 쿠폰 콘솔</h1>
          <p>
            대본 타임라인·오디오 더킹·키네틱 자막·안전영역, 인스타 댓글 → 5초 DM 쿠폰, 예약 발행과 API 쿼터,
            훅 A/B 판정까지 한 화면에서 확인합니다. 화면의 숫자는 모두 저장소의 엔진 코드가 계산한 값입니다.
          </p>
        </div>
        <div className="meta">
          <Pill tone="ok">브라우저에서 엔진 실행</Pill>
          <Pill tone="ghost">외부 API 호출 없음</Pill>
          <Pill tone="ghost">Vitest 439 · PHPUnit 125</Pill>
        </div>
      </header>

      <nav className="tabs" role="tablist" aria-label="콘솔 영역">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === 'studio' ? (
        <StudioPanel
          topic={topic}
          onTopic={(value) => {
            setTopic(value);
          }}
          durationSec={durationSec}
          onDuration={(value) => {
            setDurationSec(value);
            regenerate(topic);
          }}
          speed={speed}
          onSpeed={setSpeed}
          drafts={drafts}
          onDrafts={setDrafts}
          compress={compress}
          onCompress={setCompress}
          language="ko"
        />
      ) : null}

      {tab === 'coupon' ? <CouponPanel /> : null}
      {tab === 'calendar' ? <PublishingPanel /> : null}
      {tab === 'hooks' ? <HookPanel topic={topic} onAdopt={adoptHook} /> : null}

      <footer className="foot">
        <span>
          Meta Graph · YouTube Data API · Redis · SENS 는 자격 증명이 없어 실호출하지 않습니다. 화면의 실패·한도·DLQ는
          엔진이 실제로 판정한 결과입니다.
        </span>
        <span className="mono">
          <a href="https://github.com/Shye-Seo/sns-shortform-automation" rel="noreferrer noopener">
            github.com/Shye-Seo/sns-shortform-automation
          </a>
        </span>
      </footer>
    </div>
  );
}
