import { useState } from 'react';
import type { SceneDraft } from '../src/services/scriptEngine';
import type { AngleChoice } from '../src/types/plan';
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
  { id: 'osmu', label: '한 편을 세 곳으로' },
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
  /** 대본을 만든 주체. AI 키로 생성하면 그 모델 이름이 들어간다. */
  const [aiSource, setAiSource] = useState<string | null>(null);

  /**
   * The topic is the input the script is derived from, so changing it has to
   * re-derive the script. Previously the topic field only updated its own state
   * and the old drafts stayed in place — the captions kept saying "주방수납"
   * no matter what was typed.
   */
  const changeTopic = (value: string): void => {
    setTopic(value);
    setDrafts(draftBeatScene(value, durationSec, variation, angle));
    setAiSource(null);
  };

  const regenerate = (): void => {
    const next = variation + 1;
    setVariation(next);
    setDrafts(draftBeatScene(topic, durationSec, next, angle));
    setAiSource(null);
  };

  const changeAngle = (value: AngleChoice): void => {
    setAngle(value);
    setDrafts(draftBeatScene(topic, durationSec, variation, value));
    setAiSource(null);
  };

  const changeDuration = (value: number): void => {
    setDurationSec(value);
    setDrafts(draftBeatScene(topic, value, variation, angle));
    setAiSource(null);
  };

  /**
   * 연결한 AI 모델이 만든 대본을 그대로 받는다. 내장 엔진과 같은 타임라인·
   * 자막 계산을 통과하므로, 미리보기와 편집 패키지도 같은 값으로 나온다.
   */
  const adoptAiDrafts = (next: SceneDraft[], source: string): void => {
    setDrafts(next);
    setAiSource(source);
  };

  const adoptHook = (text: string): void => {
    setDrafts(drafts.map((draft, index) => (index === 0 ? { ...draft, narration: text } : draft)));
    setTab('studio');
  };

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-main">
          <p className="eyebrow">숏폼 운영 콘솔</p>
          <h1>숏폼 스튜디오</h1>
          <p className="lede">
            주제 하나로 대본·자막·9:16 미리보기까지 만들고, 올린 뒤에는 댓글 쿠폰과 예약 발행 한도,
            어떤 첫 문장이 잘 먹혔는지까지 이 화면에서 확인합니다.
          </p>
        </div>
        <div className="masthead-side">
          <span className="status">
            <span className="dot" aria-hidden="true" />
            주제를 바꾸면 대본과 자막이 다시 계산됩니다
          </span>
          <span className="status-sub">9:16 · 4장면 기준</span>
        </div>
      </header>

      <div className="flow">
        <span className="flow-step">
          <span className="flow-no">1</span>주제 입력
        </span>
        <span className="flow-arrow" aria-hidden="true">
          →
        </span>
        <span className="flow-step">
          <span className="flow-no">2</span>대본 · 9:16 미리보기
        </span>
        <span className="flow-arrow" aria-hidden="true">
          →
        </span>
        <span className="flow-step">
          <span className="flow-no">3</span>발행 · 규칙 확인
        </span>
        <span className="flow-note">탭을 바꿔도 같은 주제로 이어집니다</span>
      </div>

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
          aiSource={aiSource}
          onAiDrafts={adoptAiDrafts}
          onAiReset={() => {
            setAiSource(null);
            setDrafts(draftBeatScene(topic, durationSec, variation, angle));
          }}
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
      {tab === 'calendar' ? <PublishingPanel topic={topic} drafts={drafts} durationSec={durationSec} /> : null}
      {tab === 'hooks' ? <HookPanel topic={topic} onAdopt={adoptHook} /> : null}

      <footer className="foot">
        <span>
          화면의 판정(한도·실패·재시도)은 엔진이 실제로 계산한 결과입니다. 외부 플랫폼 연결 전에는 예시 데이터로
          같은 계산을 보여 줍니다.
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
