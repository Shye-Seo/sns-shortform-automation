import { useState } from 'react';
import type { SceneDraft } from '../src/services/scriptEngine';
import type { AngleChoice } from '../src/types/plan';
import { Pill } from './ui';
import { StudioPanel } from './panels/StudioPanel';
import { CouponPanel } from './panels/CouponPanel';
import { PublishingPanel } from './panels/PublishingPanel';
import { HookPanel } from './panels/HookPanel';
import { CrossChannelPanel } from './panels/CrossChannelPanel';
import { OsmuPanel } from './panels/OsmuPanel';
import { draftBeatScene } from './model/studio';

type TabId = 'studio' | 'plan' | 'osmu' | 'coupon' | 'calendar' | 'hooks';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'studio', label: '9:16 스튜디오' },
  { id: 'plan', label: '크로스채널 기획' },
  { id: 'osmu', label: 'OSMU 변환' },
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
  const [angle, setAngle] = useState<AngleChoice>('auto');
  const [variation, setVariation] = useState(0);
  const [drafts, setDrafts] = useState<SceneDraft[]>(() => draftBeatScene(DEFAULT_TOPIC, 45, 0, 'auto'));

  /**
   * The topic is the input the script is derived from, so changing it has to
   * re-derive the script. Previously the topic field only updated its own state
   * and the old drafts stayed in place — the captions kept saying "주방수납"
   * no matter what was typed.
   */
  const changeTopic = (value: string): void => {
    setTopic(value);
    setDrafts(draftBeatScene(value, durationSec, variation, angle));
  };

  const regenerate = (): void => {
    const next = variation + 1;
    setVariation(next);
    setDrafts(draftBeatScene(topic, durationSec, next, angle));
  };

  const changeAngle = (value: AngleChoice): void => {
    setAngle(value);
    setDrafts(draftBeatScene(topic, durationSec, variation, value));
  };

  const changeDuration = (value: number): void => {
    setDurationSec(value);
    setDrafts(draftBeatScene(topic, value, variation, angle));
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
          <h1>숏폼 스튜디오 &amp; 크로스채널 기획 콘솔</h1>
          <p>
            주제 하나로 4비트 대본·타임라인·키네틱 자막을 다시 계산하고, 릴스·쇼츠·롱폼·블로그 패턴까지 엮어
            기획합니다. 같은 대본을 릴스 캡션·쇼츠 설명·블로그/스레드 요약으로 한 번에 바꾸고, 인스타 댓글 →
            5초 DM 쿠폰, 예약 발행 쿼터와 훅 패턴 비교도 같은 화면에서 확인합니다.
          </p>
        </div>
        <div className="meta">
          <Pill tone="ok">브라우저에서 엔진 실행</Pill>
          <Pill tone="ghost">외부 API 호출 없음</Pill>
          <Pill tone="ghost">주제 변경 → 대본·자막 재계산</Pill>
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
          onTopic={changeTopic}
          durationSec={durationSec}
          onDuration={changeDuration}
          speed={speed}
          onSpeed={setSpeed}
          drafts={drafts}
          onDrafts={setDrafts}
          compress={compress}
          onCompress={setCompress}
          language="ko"
          angle={angle}
          onAngle={changeAngle}
          variation={variation}
          onRegenerate={regenerate}
          onOpenPlan={() => setTab('plan')}
        />
      ) : null}

      {tab === 'plan' ? (
        <CrossChannelPanel topic={topic} onTopic={changeTopic} onBackToStudio={() => setTab('studio')} />
      ) : null}

      {tab === 'osmu' ? (
        <OsmuPanel
          topic={topic}
          drafts={drafts}
          durationSec={durationSec}
          onBackToStudio={() => setTab('studio')}
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
